import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CACHE_SCHEMA,
    latestVersion,
    openCacheDb,
    openUserDb,
    type SqlStatements,
    USER_MIGRATIONS,
} from '../../src/data';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

// Both files' tables,
// written out here rather than read from src/data/schema.ts.

const CACHE_TABLES: Record<string, { columns: string[]; key: string[] }> = {
    rows: { columns: ['collection', 'scope', 'key', 'json', 'version', 'seenAt'], key: ['collection', 'scope', 'key'] },
    meta: {
        columns: ['collection', 'scope', 'cursor', 'etag', 'serverVersion', 'schemaVersion', 'syncedAt'],
        key: ['collection', 'scope'],
    },
    scopes: { columns: ['scope', 'lastUsed', 'bytes'], key: ['scope'] },
    kv: { columns: ['key', 'value'], key: ['key'] },
};

const USER_TABLES: Record<string, { columns: string[]; key: string[] }> = {
    outbox: {
        columns: [
            'id',
            'lane',
            'kind',
            'payload',
            'payloadVersion',
            'dependsOn',
            'idempotencyKey',
            'state',
            'attempts',
            'revision',
            'createdAt',
            'lastError',
        ],
        key: ['id'],
    },
    drafts: { columns: ['scope', 'text', 'payloadVersion', 'updatedAt', 'sending'], key: ['scope'] },
    unsent: { columns: ['id', 'kind', 'payload', 'payloadVersion', 'reason', 'createdAt'], key: ['id'] },
    ids: { columns: ['kind', 'localId', 'serverId'], key: ['kind', 'localId'] },
    files: {
        columns: [
            'id',
            'path',
            'mime',
            'bytes',
            'lane',
            // Migration 2: attachments.
            'name',
            'state',
            'serverId',
            'uploadedAt',
            'draftScope',
            'outboxId',
            'error',
            'createdAt',
        ],
        key: ['id'],
    },
    // Migration 3: the kept Spaces.
    prefs: { columns: ['key', 'value'], key: ['key'] },
};

/** A statement that only adds to user.db: a table, an index or a column. */
const ADDITIVE = /^\s*(?:CREATE\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN)\s/i;

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'socio-schema-'));
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

/** Each table's columns in order, primary key in order, and whether it is STRICT. */
async function tables(db: SqlStatements) {
    const list = await db.all<{ name: string; strict: number }>(
        "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const found: Record<string, { columns: string[]; key: string[]; strict: number }> = {};
    for (const { name, strict } of list) {
        const columns = await db.all<{ name: string; pk: number }>(
            'SELECT name, pk FROM pragma_table_info(?) ORDER BY cid',
            [name],
        );
        found[name] = {
            columns: columns.map((column) => column.name),
            key: columns
                .filter((column) => column.pk > 0)
                .sort((a, b) => a.pk - b.pk)
                .map((column) => column.name),
            strict,
        };
    }
    return found;
}

const strict = (spec: Record<string, { columns: string[]; key: string[] }>) =>
    Object.fromEntries(Object.entries(spec).map(([name, table]) => [name, { ...table, strict: 1 }]));

describe('the store’s tables', () => {
    it('cache.db holds rows, meta, scopes and kv, as written here, at its schema version', async () => {
        const { db } = await openCacheDb(createNodeSqliteDriver(), directory, '11'.repeat(32));
        expect(await tables(db)).toEqual(strict(CACHE_TABLES));
        expect(await db.get('PRAGMA user_version')).toEqual({ user_version: CACHE_SCHEMA.version });
        await db.close();
    });

    it('user.db holds outbox, drafts, unsent, ids, files and prefs, as written here, at the last migration', async () => {
        const { db } = await openUserDb(createNodeSqliteDriver(), directory, '22'.repeat(32));
        expect(await tables(db)).toEqual(strict(USER_TABLES));
        expect(await db.get('PRAGMA user_version')).toEqual({ user_version: latestVersion(USER_MIGRATIONS) });
        await db.close();
    });

    it('takes a value of the wrong type nowhere', async () => {
        const { db } = await openCacheDb(createNodeSqliteDriver(), directory, '11'.repeat(32));
        await expect(
            db.run('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?)', ['shell', '', 'state', '{}', null, 'yesterday']),
        ).rejects.toThrow(/cannot store TEXT value in INTEGER column rows\.seenAt/);
        await db.close();
    });

    it('user.db’s migrations after the first only add tables, indexes and columns', () => {
        const [first, ...later] = USER_MIGRATIONS;
        expect(first?.statements.every((statement) => /^\s*CREATE\s+TABLE\s/i.test(statement))).toBe(true);
        expect(later.flatMap((migration) => migration.statements).filter((sql) => !ADDITIVE.test(sql))).toEqual([]);
        // The check itself.
        expect(ADDITIVE.test('ALTER TABLE outbox ADD COLUMN heldBy TEXT')).toBe(true);
        expect(ADDITIVE.test('CREATE INDEX outbox_lane ON outbox (lane, createdAt)')).toBe(true);
        expect(ADDITIVE.test('ALTER TABLE outbox DROP COLUMN lastError')).toBe(false);
        expect(ADDITIVE.test('ALTER TABLE outbox RENAME TO queue')).toBe(false);
        expect(ADDITIVE.test('DROP TABLE drafts')).toBe(false);
        expect(ADDITIVE.test('DELETE FROM outbox')).toBe(false);
    });

    it('evicts with a real DELETE and gives the space back with incremental_vacuum', async () => {
        const { db } = await openCacheDb(createNodeSqliteDriver(), directory, '11'.repeat(32));
        const json = JSON.stringify({ text: 'x'.repeat(2_000) });
        await db.transaction(async (tx) => {
            for (let i = 0; i < 500; i += 1) {
                await tx.run('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?)', ['history', 'c1', `run-${i}`, json, i, 1]);
            }
        });
        const pages = async () => (await db.get<{ page_count: number }>('PRAGMA page_count'))?.page_count ?? 0;
        const full = await pages();
        await db.run('DELETE FROM rows WHERE collection = ? AND scope = ?', ['history', 'c1']);
        expect(await db.get('PRAGMA freelist_count')).not.toEqual({ freelist_count: 0 });
        await db.all('PRAGMA incremental_vacuum');
        expect(await db.get('PRAGMA freelist_count')).toEqual({ freelist_count: 0 });
        expect(await pages()).toBeLessThan(full / 10);
        await db.close();
    });
});
