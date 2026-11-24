import type { DatabaseSync } from 'node:sqlite';

import type { SqliteData } from '@socio/data/open';

import type { CycleRepositories } from '../../domain/repositories.js';

import { SqliteSubmissions, SqliteWorkCycles } from './cycles.js';

/**
 * Work cycles' repositories on a migrated connection (CB-110): the only
 * code that reads or writes the cycle tables.
 */
export function sqliteCycleRepositories(data: SqliteData, db: DatabaseSync): CycleRepositories {
    return {
        cycles: new SqliteWorkCycles(data, db),
        submissions: new SqliteSubmissions(data),
    };
}
