import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

import { applyConnectionPragmas } from './sqlite-pragmas.js';
import { SqliteUnitOfWork } from './uow.js';

/**
 * Opens the app's database (its folder is made if needed) with the
 * connection pragmas, from their one source (`applyConnectionPragmas`).
 * One connection serves the app's own tables: the core store, the
 * workspace and the repositories share it.
 */
export function openDatabase(path: string, env: Record<string, string | undefined> = process.env) {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    applyConnectionPragmas(db, env);
    return db;
}

/** What repositories query with: Drizzle on the shared connection. */
export type SqliteHandle = NodeSQLiteDatabase;

/** The data layer of one connection: its unit of work and Drizzle handle. */
export interface SqliteData {
    uow: SqliteUnitOfWork<SqliteHandle>;
}

const layers = new WeakMap<DatabaseSync, SqliteData>();

/**
 * The data layer of a connection, made once: everything on one connection
 * must share one unit of work, whose lock is the connection's writer lock.
 * Drizzle runs on the `DatabaseSync` itself (`drizzle-orm/node-sqlite`), so
 * its queries and legacy SQL see the same transactions.
 */
export function sqliteData(db: DatabaseSync): SqliteData {
    let layer = layers.get(db);
    if (!layer) {
        layer = { uow: new SqliteUnitOfWork(db, drizzle({ client: db })) };
        layers.set(db, layer);
    }
    return layer;
}

/**
 * Legacy SQL (raw statements on the shared connection) as one transaction:
 * at once when the connection is free, else queued behind the open unit of
 * work (`SqliteUnitOfWork.transact`). Await it.
 */
export function transaction<T>(db: DatabaseSync, label: string, work: () => T): Promise<T> {
    return sqliteData(db).uow.transact(work, { label });
}

/**
 * `transaction` for a caller that can't wait: it fails loudly while
 * another context's unit of work is open, instead of joining it.
 */
export function transactionSync<T>(db: DatabaseSync, label: string, work: () => T): T {
    return sqliteData(db).uow.transactSync(work, { label });
}

/**
 * A record nothing reads back at once (an audit row, a usage stamp): at
 * once when no other chain's unit of work holds or waits for the
 * connection, else queued behind it, in order (CB-110); a queued one that
 * fails is logged.
 */
export function writeSoon(db: DatabaseSync, label: string, work: () => void): void {
    const { uow } = sqliteData(db);
    if (uow.writable) {
        work();
        return;
    }
    uow.transact(work, { label }).catch((error: unknown) =>
        console.error(`A queued write failed (${label}): ${error instanceof Error ? error.name : 'unknown'}`),
    );
}
