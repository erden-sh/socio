import type { SqliteData } from '@socio/data/open';

/**
 * What service accounts' SQLite repositories share: the connection's data
 * layer. Statements run on the open unit of work's handle, or as one
 * autocommit statement outside one. Drizzle's node:sqlite statements
 * execute at once (`.run()`, `.get()`), which the `…Now` methods and
 * `soon` rely on.
 */
export abstract class SqliteRepository {
    constructor(protected data: SqliteData) {}

    /** The handle to query with (`UnitOfWork.executor`). */
    protected get db() {
        return this.data.uow.executor();
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
