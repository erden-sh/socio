/**
 * How long a mini app's build and start attempts, with their logs, are kept
 * (CB-175): an admin's choice in Settings → Workspace → General → Mini app
 * logs, over `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS`. An attempt stays when
 * it is newer than `days` or one of the app's last `attempts`, whichever
 * keeps more; the attempt that is running now always stays.
 */
export interface AppLogRetention {
    days: number;
    attempts: number;
}

export const DEFAULT_APP_LOG_RETENTION: AppLogRetention = {
    days: 14,
    attempts: 50,
};

/** Bounds an admin or the environment may set. */
export const APP_LOG_DAYS_RANGE = { min: 1, max: 365 } as const;
// The least is what the runtime keeps in memory per app (`ATTEMPTS_KEPT`):
// below it, attempts the runtime still lists would be pruned and copied again.
export const APP_LOG_ATTEMPTS_RANGE = { min: 10, max: 500 } as const;
