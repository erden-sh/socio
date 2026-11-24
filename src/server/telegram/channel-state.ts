import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { StateStore } from '@copilotkit/channels-core';

import type { SchemaSet } from '@socio/data/migrate';
import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';

const DEFAULT_LOCK_TTL_MS = 30_000;
type Row = { value: string; expiresAt: number | null };
const live = (row: { expiresAt: number | null } | undefined, now: number) =>
    !!row && (row.expiresAt === null || now <= row.expiresAt);

/** Channel state: dedup, locks, durable actions and queues. */
export const channelsSchema: SchemaSet = {
    id: 'channels',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: `CREATE TABLE IF NOT EXISTS channel_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER);
      CREATE TABLE IF NOT EXISTS channel_lists(key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER);
      CREATE TABLE IF NOT EXISTS channel_locks(key TEXT PRIMARY KEY, token TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_queue_key ON channel_queue(key, seq);`,
        },
    ],
};

/**
 * The channels `StateStore` on node:sqlite, so dedup, locks, durable actions
 * and queues survive a restart. Semantics follow the reference MemoryStore
 * and pass its conformance suite. node:sqlite is synchronous, so each method
 * is atomic within this process. Expired rows are purged as writes happen.
 */
export class SqliteStateStore implements StateStore {
    private db: DatabaseSync;
    private writes = 0;
    constructor(
        database: string | DatabaseSync,
        private now: () => number = Date.now,
    ) {
        if (typeof database === 'string') {
            this.db = new DatabaseSync(database);
            applyConnectionPragmas(this.db);
        } else {
            this.db = database;
        }
    }
    close() {
        if (this.db.isOpen) {
            this.db.close();
        }
    }
    private purge() {
        if (++this.writes % 200) {
            return;
        }
        const now = this.now();
        for (const table of ['channel_kv', 'channel_lists', 'channel_locks']) {
            this.db.prepare(`DELETE FROM ${table} WHERE expiresAt IS NOT NULL AND expiresAt < ?`).run(now);
        }
    }
    private getRow(table: 'channel_kv' | 'channel_lists', key: string) {
        const row = this.db.prepare(`SELECT value, expiresAt FROM ${table} WHERE key=?`).get(key) as Row | undefined;
        if (row && !live(row, this.now())) {
            this.db.prepare(`DELETE FROM ${table} WHERE key=?`).run(key);
            return undefined;
        }
        return row;
    }
    private putRow(table: 'channel_kv' | 'channel_lists', key: string, value: unknown, expiresAt: number | null) {
        this.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?, ?, ?)`).run(key, JSON.stringify(value), expiresAt);
        this.purge();
    }

    kv = {
        /** Private bootstrap capability: create an immutable primary/dependent pair together. */
        initializePair: async (
            primaryKey: string,
            primaryInitial: unknown,
            dependentKey: string,
            dependentInitial: unknown,
            validate: (primary: unknown, dependent: unknown) => boolean,
        ): Promise<readonly [unknown, unknown]> => {
            if (primaryKey === dependentKey) {
                throw new Error('Invalid channel state pair.');
            }
            this.db.exec('BEGIN IMMEDIATE');
            try {
                const primary = this.getRow('channel_kv', primaryKey);
                const dependent = this.getRow('channel_kv', dependentKey);
                if (!primary && dependent) {
                    throw new Error('Incomplete channel state pair.');
                }
                const value = primary ? (JSON.parse(primary.value) as unknown) : primaryInitial;
                const epoch = dependent ? (JSON.parse(dependent.value) as unknown) : dependentInitial;
                if (!validate(value, epoch)) {
                    throw new Error('Invalid channel state pair.');
                }
                if (!primary) {
                    this.putRow('channel_kv', primaryKey, value, null);
                }
                if (!dependent) {
                    this.putRow('channel_kv', dependentKey, epoch, null);
                }
                this.db.exec('COMMIT');
                return [value, epoch];
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        },
        get: async <T>(key: string): Promise<T | undefined> => {
            const row = this.getRow('channel_kv', key);
            return row ? (JSON.parse(row.value) as T) : undefined;
        },
        set: async <T>(key: string, value: T, ttlMs?: number) => {
            this.putRow('channel_kv', key, value, ttlMs ? this.now() + ttlMs : null);
        },
        delete: async (key: string) => {
            this.db.prepare('DELETE FROM channel_kv WHERE key=?').run(key);
        },
        consume: async <T>(key: string): Promise<T | undefined> => {
            const row = this.getRow('channel_kv', key);
            if (!row) {
                return undefined;
            }
            this.db.prepare('DELETE FROM channel_kv WHERE key=?').run(key);
            return JSON.parse(row.value) as T;
        },
    };

    list = {
        append: async <T>(key: string, value: T, opts?: { maxLen?: number; ttlMs?: number }) => {
            const row = this.getRow('channel_lists', key);
            const items = row ? (JSON.parse(row.value) as T[]) : [];
            items.push(value);
            if (opts?.maxLen && items.length > opts.maxLen) {
                items.splice(0, items.length - opts.maxLen);
            }
            this.putRow('channel_lists', key, items, opts?.ttlMs ? this.now() + opts.ttlMs : (row?.expiresAt ?? null));
            return items.length;
        },
        range: async <T>(key: string, start = 0, stop?: number): Promise<T[]> => {
            const row = this.getRow('channel_lists', key);
            if (!row) {
                return [];
            }
            return (JSON.parse(row.value) as T[]).slice(start, stop === undefined ? undefined : stop + 1);
        },
        trim: async (key: string, maxLen: number) => {
            const row = this.getRow('channel_lists', key);
            if (!row) {
                return;
            }
            const items = JSON.parse(row.value) as unknown[];
            if (items.length <= maxLen) {
                return;
            }
            items.splice(0, items.length - maxLen);
            this.putRow('channel_lists', key, items, row.expiresAt);
        },
        delete: async (key: string) => {
            this.db.prepare('DELETE FROM channel_lists WHERE key=?').run(key);
        },
    };

    lock = {
        acquire: async (key: string, opts?: { ttlMs?: number }) => {
            const now = this.now();
            const token = randomUUID();
            const acquired = this.db
                .prepare(
                    `INSERT INTO channel_locks(key, token, expiresAt) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET token=excluded.token, expiresAt=excluded.expiresAt
        WHERE channel_locks.expiresAt < ? RETURNING token`,
                )
                .get(key, token, now + (opts?.ttlMs ?? DEFAULT_LOCK_TTL_MS), now);
            if (!acquired) {
                return null;
            }
            this.purge();
            return { token };
        },
        release: async (key: string, token: string) => {
            this.db.prepare('DELETE FROM channel_locks WHERE key=? AND token=?').run(key, token);
        },
    };

    dedup = {
        seen: async (key: string, ttlMs: number) => {
            const k = `dedup:${key}`;
            if (this.getRow('channel_kv', k)) {
                return true;
            }
            this.putRow('channel_kv', k, 1, this.now() + ttlMs);
            return false;
        },
    };

    queue = {
        enqueue: async <T>(
            key: string,
            value: T,
            opts?: { maxSize?: number; onFull?: 'drop-oldest' | 'drop-newest' },
        ) => {
            const depth = () =>
                Number(
                    (this.db.prepare('SELECT COUNT(*) AS n FROM channel_queue WHERE key=?').get(key) as { n: number })
                        .n,
                );
            if (opts?.maxSize && depth() >= opts.maxSize) {
                if ((opts.onFull ?? 'drop-oldest') === 'drop-newest') {
                    return depth();
                }
                this.db
                    .prepare('DELETE FROM channel_queue WHERE seq=(SELECT MIN(seq) FROM channel_queue WHERE key=?)')
                    .run(key);
            }
            this.db.prepare('INSERT INTO channel_queue (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
            return depth();
        },
        dequeue: async <T>(key: string): Promise<T | undefined> => {
            const row = this.db
                .prepare('SELECT seq, value FROM channel_queue WHERE key=? ORDER BY seq LIMIT 1')
                .get(key) as { seq: number; value: string } | undefined;
            if (!row) {
                return undefined;
            }
            this.db.prepare('DELETE FROM channel_queue WHERE seq=?').run(row.seq);
            return JSON.parse(row.value) as T;
        },
        depth: async (key: string) =>
            Number(
                (this.db.prepare('SELECT COUNT(*) AS n FROM channel_queue WHERE key=?').get(key) as { n: number }).n,
            ),
    };
}
