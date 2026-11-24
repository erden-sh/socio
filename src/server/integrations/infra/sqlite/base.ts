import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { SqliteData } from '@socio/data/open';

/**
 * What the Integrations repositories share: the connection's data layer.
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

    /**
     * An audit row nothing reads back at once, as `writeSoon` (packages/data/src/open.ts)
     * writes one: at once when no other chain's unit of work holds or waits
     * for the connection (or in this chain's own unit), else queued behind
     * it, in order, without making the caller wait; a queued one that fails
     * is logged. `work` runs its statement synchronously (`.run()`: the
     * node:sqlite driver executes at once).
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

/**
 * The SQLite row order, as a tie-break after a time (rows written in the
 * same millisecond), until these tables get a `seq` of their own.
 */
export const insertionOrder = (table: SQLiteTable) => sql`${table}.rowid`;
