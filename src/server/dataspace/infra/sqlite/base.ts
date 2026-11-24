import { sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { SqliteData } from '@socio/data/open';

/**
 * What the data space's SQLite repositories share: the connection's data
 * layer. Reads run on the open unit of work's handle, or as one autocommit
 * statement outside one; each async write joins the open unit, or opens its
 * own. Drizzle's node:sqlite statements execute at once (`.run()`, `.get()`,
 * `.all()`), which the `…Now` methods and `soon` rely on.
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

    /**
     * A record nothing reads back at once, as `writeSoon` (packages/data/src/open.ts)
     * writes one: at once when no other chain's unit of work holds or waits
     * for the connection (or in this chain's own unit), else queued behind
     * it, in order, without making the caller wait; a queued one that fails
     * is logged.
     */
    protected soon(label: string, work: () => void) {
        const { uow } = this.data;
        if (uow.writable) {
            work();
            return;
        }
        uow.transact(work, { label }).catch((error: unknown) =>
            console.error(`A queued write failed (${label}): ${error instanceof Error ? error.name : 'unknown'}`),
        );
    }
}

/** `column` is `prefix` or starts with it (a folder and what is under it). */
export const startsWith = (column: SQLiteColumn, prefix: string) =>
    sql`substr(${column}, 1, length(${prefix})) = ${prefix}`;
