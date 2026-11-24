import type { SqliteData } from '@socio/data/open';

import type { FlagRepositories } from '../../domain/repositories.js';

import { SqliteFlagRules } from './rules.js';
import { SqliteFlagTiers } from './tiers.js';

/**
 * Feature flags' repositories on a migrated connection (CB-110): every
 * write `FlagService` makes to its rules and plans.
 */
export function sqliteFlagRepositories(data: SqliteData): FlagRepositories {
    return {
        rules: new SqliteFlagRules(data),
        tiers: new SqliteFlagTiers(data),
    };
}
