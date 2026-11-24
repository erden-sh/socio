import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { SqliteData } from '@socio/data/open';

import { PRIORITY_RANKS } from '../../domain/rules.js';

/**
 * What the Board's SQLite repositories share: the connection's data layer.
 * Reads run on the open unit of work's handle, or as one autocommit
 * statement outside one; each write joins the open unit, or opens its own.
 */
export abstract class SqliteRepository {
    constructor(protected data: SqliteData) {}

    /** The handle to query with (`UnitOfWork.executor`). */
    protected get db() {
        return this.data.uow.executor();
    }

    protected write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }
}

/** The board's order: priority, critical first (`PRIORITY_RANKS`). */
export const priorityRank = (column: AnySQLiteColumn): SQL =>
    sql`CASE ${column} WHEN 'critical' THEN ${sql.raw(String(PRIORITY_RANKS.critical))} WHEN 'high' THEN ${sql.raw(String(PRIORITY_RANKS.high))} WHEN 'medium' THEN ${sql.raw(String(PRIORITY_RANKS.medium))} ELSE ${sql.raw(String(PRIORITY_RANKS.low))} END`;

/**
 * The SQLite row order, as a tie-break after `createdAt` (rows written in
 * the same millisecond). Only `issue_events` has a `seq` of its own;
 * the other tables keep this until they get one (see the CB-110 notes).
 */
export const insertionOrder = (table: SQLiteTable) => sql`${table}.rowid`;
