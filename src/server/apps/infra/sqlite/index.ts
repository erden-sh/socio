import type { SqliteData } from '@socio/data/open';

import type { AppRepositories } from '../../domain/repositories.js';

import { SqliteApps } from './apps.js';
import { SqliteAppAttempts } from './attempts.js';
import { SqliteAppGrants } from './grants.js';
import { SqliteAppSessions } from './sessions.js';
import { SqliteAppVersions } from './versions.js';

/**
 * Mini apps' repositories on a migrated connection (CB-110). The
 * registry's synchronous reads and the launch codes (`../launch-codes.ts`)
 * are the other code on these tables.
 */
export function sqliteAppRepositories(data: SqliteData): AppRepositories {
    return {
        apps: new SqliteApps(data),
        sessions: new SqliteAppSessions(data),
        versions: new SqliteAppVersions(data),
        grants: new SqliteAppGrants(data),
        attempts: new SqliteAppAttempts(data),
    };
}
