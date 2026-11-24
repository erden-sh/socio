import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import { sqliteCycleRepositories } from './infra/sqlite/index.js';
import { WorkCycles, type WorkCyclesOptions } from './service.js';

/**
 * Work cycles (CB-211) on a migrated connection: the service over
 * the SQLite repositories and the connection's unit of work.
 */
export function sqliteCycles(db: DatabaseSync, options: WorkCyclesOptions) {
    const data = sqliteData(db);
    return new WorkCycles(
        (label, work) => data.uow.transact(work, { label }),
        sqliteCycleRepositories(data, db),
        options,
    );
}
