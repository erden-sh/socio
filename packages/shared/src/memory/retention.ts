/*
 * How long memory out of use is kept, by default: moved here from
 * `server/memory/contract.ts` so the settings' limits read them without
 * importing memory. The memory contract re-exports them.
 */

/**
 * How long an episode is kept after it last came up (CB-180), unless an
 * admin or `EPISODE_RETENTION_DAYS` says otherwise.
 */
export const DEFAULT_EPISODE_RETENTION_DAYS = 180;

/**
 * How long Space memory out of use (superseded, rejected, withdrawn,
 * retired) is kept (CB-181), unless an admin or
 * `SPACE_MEMORY_RETENTION_DAYS` says otherwise.
 */
export const DEFAULT_SPACE_MEMORY_RETENTION_DAYS = 365;
