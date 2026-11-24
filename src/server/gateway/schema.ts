import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

import {
    codingHarnessMigrations,
    codingHostMarkerMigration,
    codingSessionMigrations,
    codingThreadEventsMigration,
    gatewayExchangesMigration,
} from '../coding/contract.js';

import { gatewayG5Migrations } from './infra/g5-tables.js';
import { gatewayGitMigrations } from './infra/git-tables.js';
import { gatewayModelMigrations } from './infra/sqlite/tables.js';

/**
 * The coding gateway module's schema (`gateway`), one ordered list: the
 * model gateway tables are version 1, the Git proxy and extraction tables
 * version 2, coding sessions versions 3 and 4, personal plans and options
 * version 5 (with dispatch's credentials, unused since CB-325) (CB-239),
 * the session's harness version 6 (CB-326), the session host's thread
 * events version 7 (CB-326 step 3), the session host marker and idle
 * clock version 8 (CB-326 step 3), and the coding session gateway
 * exchange log version 9 (CB-326 step 6). The module carries it, so boot,
 * the auth CLI and the migration checks know it. Later tables come as the
 * next versions here.
 */
export const gatewaySchema: SchemaSet = {
    id: MODULE_IDS.gateway,
    migrations: [
        ...gatewayModelMigrations,
        ...gatewayGitMigrations,
        ...codingSessionMigrations,
        ...gatewayG5Migrations,
        ...codingHarnessMigrations,
        ...codingThreadEventsMigration,
        ...codingHostMarkerMigration,
        ...gatewayExchangesMigration,
    ],
};
