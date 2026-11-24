import type { SqliteData } from '@socio/data/open';

import type { DataSpaceRepositories } from '../../domain/repositories.js';

import { SqliteDataApiTokens } from './api-tokens.js';
import { SqliteDataAudit } from './audit.js';
import { SqliteDatasets } from './datasets.js';
import { SqliteFieldSettings } from './field-settings.js';
import { SqliteFiles } from './files.js';
import { SqliteGrants } from './grants.js';
import { SqlitePluginBindings } from './plugin-bindings.js';
import { SqlitePluginBudgets } from './plugin-budgets.js';

/**
 * The data space's repositories on a migrated connection (CB-110): every
 * write `DataSpace` makes to its datasets, grants, files, audit, plugin
 * bindings, plugin budgets, field settings and data API tokens.
 */
export function sqliteDataSpaceRepositories(data: SqliteData): DataSpaceRepositories {
    return {
        datasets: new SqliteDatasets(data),
        grants: new SqliteGrants(data),
        files: new SqliteFiles(data),
        audit: new SqliteDataAudit(data),
        bindings: new SqlitePluginBindings(data),
        budgets: new SqlitePluginBudgets(data),
        fields: new SqliteFieldSettings(data),
        apiTokens: new SqliteDataApiTokens(data),
    };
}
