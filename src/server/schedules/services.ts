import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import type { UnitOfWork } from '@socio/data/uow';

import type { RuntimeIdentityShape, RuntimeOwnershipShape } from '../runtime/contract.js';

import type { ScheduleRepositories } from './domain/repositories.js';
import { sqliteScheduleRepositories } from './infra/sqlite/index.js';

/** The Scheduling context's data on the workspace's connection (CB-110). */
export interface ScheduleData {
    db: DatabaseSync;
    runtime: RuntimeIdentityShape;
    ownership: RuntimeOwnershipShape;
    uow: UnitOfWork;
    repos: ScheduleRepositories;
}

/**
 * Jobs, goals and long runs on a migrated connection: the repositories and
 * the connection's unit of work, owned by `runtime` (the process's runtime
 * identity, which the runner made).
 */
export function sqliteSchedules(db: DatabaseSync, runtime: RuntimeIdentityShape): ScheduleData {
    const data = sqliteData(db);
    return {
        db,
        runtime,
        ownership: runtime.attach(db),
        uow: data.uow,
        repos: sqliteScheduleRepositories(data),
    };
}
