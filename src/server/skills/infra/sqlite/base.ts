import type { SqliteData } from '@socio/data/open';

/**
 * What chat skills' SQLite repositories share: the connection's data
 * layer. Reads run on the open unit of work's handle, or as one autocommit
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
