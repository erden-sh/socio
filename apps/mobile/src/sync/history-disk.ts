import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { chained, HISTORY_FORMAT } from '@socio/shared/chat/history-chain';

import type { SqlConnection, SqlStatements } from '../data';

// Chat histories on disk:
// cache.db's `rows`, collection `history`, one scope per conversation
// (shared's `historyScope`, `chat:<format>:<id>`), keyed by run seq; the
// `scopes` table holds each one's last use and size for the bounds. The
// format is in the scope's name, so a release that changes it drops only
// the scopes of other formats (`dropOtherFormats`), and keeps the rest.
//
// The bounds: 100 chats and about 50 M characters, the least
// recently used going first, except the chats a screen shows and those
// queued writes pin (`protect`). A run over 4 MB is never kept: the chat
// shows it from memory, and the next open asks the server again.

export const HISTORY = 'history';
/** Chats kept on disk at most. */
export const HISTORY_DISK_CHATS = 100;
/** About how many characters of runs are kept on disk at most. */
export const HISTORY_DISK_CHARS = 50_000_000;
/** A run whose JSON is longer than this is never kept on disk. */
export const HISTORY_RUN_MAX_CHARS = 4 * 1024 * 1024;

/** Every history scope's name starts with this. */
const PREFIX = 'chat:';
const CURRENT = `${PREFIX}${HISTORY_FORMAT}:`;
const LIKE = `${PREFIX}%`;

/** The chained runs kept for `scope`, oldest first: what a chat may show. */
export async function readHistory(db: SqlStatements, scope: string): Promise<HistoryRun[]> {
    const rows = await db.all<{ json: string }>('SELECT json FROM rows WHERE collection = ? AND scope = ?', [
        HISTORY,
        scope,
    ]);
    return chained(rows.map((row) => JSON.parse(row.json) as HistoryRun));
}

/** The disk bounds: chats, and about how many characters. */
export interface HistoryBounds {
    readonly chats: number;
    readonly chars: number;
}

export const HISTORY_BOUNDS: HistoryBounds = { chats: HISTORY_DISK_CHATS, chars: HISTORY_DISK_CHARS };

/** What one write of a chat's runs does: replace them all, or add to them. */
export interface HistoryWrite {
    readonly scope: string;
    readonly replace: boolean;
    readonly runs: readonly HistoryRun[];
}

/**
 * Writes a chat's runs in one transaction, with its size and last use, then
 * evicts past the bounds. Runs over HISTORY_RUN_MAX_CHARS are left out.
 * Returns the scopes evicted.
 */
export async function writeHistory(
    db: SqlConnection,
    write: HistoryWrite,
    now: number,
    protect: ReadonlySet<string>,
    bounds: HistoryBounds = HISTORY_BOUNDS,
): Promise<string[]> {
    const { scope, replace, runs } = write;
    const evicted = await db.transaction(async (tx) => {
        if (replace) {
            await tx.run('DELETE FROM rows WHERE collection = ? AND scope = ?', [HISTORY, scope]);
        }
        for (const run of runs) {
            const json = JSON.stringify(run);
            if (json.length > HISTORY_RUN_MAX_CHARS) {
                continue;
            }
            await tx.run(
                `INSERT INTO rows (collection, scope, key, json, version, seenAt) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (collection, scope, key) DO UPDATE SET json = excluded.json, version = excluded.version, seenAt = excluded.seenAt`,
                [HISTORY, scope, String(run.seq), json, run.seq, now],
            );
        }
        await tx.run(
            `INSERT INTO scopes (scope, lastUsed, bytes)
             SELECT ?, ?, COALESCE(SUM(length(json)), 0) FROM rows WHERE collection = ? AND scope = ?
             ON CONFLICT (scope) DO UPDATE SET lastUsed = excluded.lastUsed, bytes = excluded.bytes`,
            [scope, now, HISTORY, scope],
        );
        return evict(tx, new Set([...protect, scope]), bounds);
    });
    if (evicted.length) {
        await db.exec('PRAGMA incremental_vacuum');
    }
    return evicted;
}

/** The least recently used chats past the bounds, deleted; never one of `protect`. */
async function evict(tx: SqlStatements, protect: ReadonlySet<string>, bounds: HistoryBounds): Promise<string[]> {
    const kept = await tx.all<{ scope: string; bytes: number }>(
        'SELECT scope, bytes FROM scopes WHERE scope LIKE ? ORDER BY lastUsed, scope',
        [LIKE],
    );
    let count = kept.length;
    let chars = kept.reduce((sum, row) => sum + Number(row.bytes), 0);
    const evicted: string[] = [];
    for (const { scope, bytes } of kept) {
        if (count <= bounds.chats && chars <= bounds.chars) {
            break;
        }
        if (protect.has(scope)) {
            continue;
        }
        await dropScope(tx, scope);
        evicted.push(scope);
        count -= 1;
        chars -= Number(bytes);
    }
    return evicted;
}

async function dropScope(tx: SqlStatements, scope: string) {
    await tx.run('DELETE FROM rows WHERE collection = ? AND scope = ?', [HISTORY, scope]);
    await tx.run('DELETE FROM meta WHERE collection = ? AND scope = ?', [HISTORY, scope]);
    await tx.run('DELETE FROM scopes WHERE scope = ?', [scope]);
}

/** Deletes one chat's runs (it is gone, or no longer the person's). */
export async function deleteHistory(db: SqlConnection, scope: string): Promise<void> {
    await db.transaction((tx) => dropScope(tx, scope));
}

/** Marks a chat used now, for the LRU, when it has runs kept. */
export async function touchHistory(db: SqlStatements, scope: string, now: number): Promise<void> {
    await db.run('UPDATE scopes SET lastUsed = ? WHERE scope = ?', [now, scope]);
}

/** Drops the runs kept in another format than this build's (HISTORY_FORMAT); the others stay. */
export async function dropOtherFormats(db: SqlConnection): Promise<void> {
    const old = await db.get<{ found: number }>(
        `SELECT 1 AS found FROM rows WHERE collection = ? AND substr(scope, 1, ?) <> ? LIMIT 1`,
        [HISTORY, CURRENT.length, CURRENT],
    );
    const oldScopes = await db.get<{ found: number }>(
        `SELECT 1 AS found FROM scopes WHERE scope LIKE ? AND substr(scope, 1, ?) <> ? LIMIT 1`,
        [LIKE, CURRENT.length, CURRENT],
    );
    if (old === null && oldScopes === null) {
        return;
    }
    await db.transaction(async (tx) => {
        await tx.run('DELETE FROM rows WHERE collection = ? AND substr(scope, 1, ?) <> ?', [
            HISTORY,
            CURRENT.length,
            CURRENT,
        ]);
        await tx.run('DELETE FROM meta WHERE collection = ? AND substr(scope, 1, ?) <> ?', [
            HISTORY,
            CURRENT.length,
            CURRENT,
        ]);
        await tx.run('DELETE FROM scopes WHERE scope LIKE ? AND substr(scope, 1, ?) <> ?', [
            LIKE,
            CURRENT.length,
            CURRENT,
        ]);
    });
    await db.exec('PRAGMA incremental_vacuum');
}
