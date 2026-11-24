import type { SqliteData } from '@socio/data/open';

import type { ServiceAccountRepositories } from '../../domain/repositories.js';

import { SqliteServiceAccounts, SqliteServiceKeys } from './accounts.js';

/**
 * Service accounts' repositories on a migrated connection (CB-110): every
 * write `ServiceAccounts` makes to its accounts, their users and keys.
 */
export function sqliteServiceAccountRepositories(data: SqliteData): ServiceAccountRepositories {
    return {
        accounts: new SqliteServiceAccounts(data),
        keys: new SqliteServiceKeys(data),
    };
}
