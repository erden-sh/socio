import type { Settings } from '@socio/shared/types';

import {
    DEFAULT_EPISODE_RETENTION_DAYS,
    DEFAULT_SPACE_MEMORY_RETENTION_DAYS,
    type MemoryConfigShape,
} from './contract.js';

/**
 * The retentions in force (CB-180, CB-181): an admin's (Settings → Limits)
 * over the server's own (`MemoryConfig`, from the environment), else the
 * defaults. For these two limits it is what Settings' `limitsInForce`
 * gives over `limitDefaults(config)`: the saved value, else the
 * environment's, else the built-in one. Read on every use, so a saved
 * value applies at once.
 */
export const retentionInForce = (settings: Pick<Settings, 'limits'>, config: MemoryConfigShape) => ({
    episodeRetentionDays:
        settings.limits?.episodeRetentionDays ?? config.episodeRetentionDays ?? DEFAULT_EPISODE_RETENTION_DAYS,
    spaceMemoryRetentionDays:
        settings.limits?.spaceMemoryRetentionDays ??
        config.spaceMemoryRetentionDays ??
        DEFAULT_SPACE_MEMORY_RETENTION_DAYS,
});
