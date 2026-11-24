import {
    APP_LOG_ATTEMPTS_RANGE,
    APP_LOG_DAYS_RANGE,
    DEFAULT_APP_LOG_RETENTION,
    type AppLogRetention,
} from '@socio/shared/apps/app-log-retention';
import type { Settings } from '@socio/shared/types';

/**
 * Mini app log retention (CB-175): the environment's starting values under
 * what an admin saved in Settings, read each time the background prune runs.
 */
const whole = (env: Record<string, string | undefined>, name: string, range: { min: number; max: number }) => {
    const raw = env[name]?.trim();
    if (!raw) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new Error(`${name} must be a whole number from ${range.min} to ${range.max}.`);
    }
    return value;
};

/** `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS`; only those set. */
export function appLogRetentionFromEnv(env: Record<string, string | undefined>): Partial<AppLogRetention> {
    const days = whole(env, 'APPS_LOG_DAYS', APP_LOG_DAYS_RANGE);
    const attempts = whole(env, 'APPS_LOG_ATTEMPTS', APP_LOG_ATTEMPTS_RANGE);
    return {
        ...(days !== undefined ? { days } : {}),
        ...(attempts !== undefined ? { attempts } : {}),
    };
}

/** The retention in force: an admin's, over the environment's, over the built-in. */
export const appLogRetention = (
    settings: Pick<Settings, 'appLogs'>,
    env: Partial<AppLogRetention> = {},
): AppLogRetention => ({
    ...DEFAULT_APP_LOG_RETENTION,
    ...env,
    ...settings.appLogs,
});
