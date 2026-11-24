/**
 * The issues feature's settings in force, over the server's environment
 * defaults: the Dots' capability-request limits and automatic triage
 * (CB-30). Moved from `issues/requests.ts` and `issues/auto-triage.ts`,
 * which re-export them.
 */
import type { AutoTriageSettings, Settings } from '@socio/shared/types';

// --- Dot request limits -----------------------------------------------------

export interface DotRequestLimits {
    /** Requests one Dot may make in the window, for all its users. */
    perDot: number;
    /** Requests made for one user in the window, by all their Dots. */
    perUser: number;
    windowMs: number;
}
export const DEFAULT_DOT_REQUEST_LIMITS: DotRequestLimits = {
    perDot: 50,
    perUser: 50,
    windowMs: 24 * 60 * 60 * 1000,
};

/**
 * The limits in force: an admin's from Settings (`dotDailyLimits`) over the
 * server's, which come from the environment.
 */
export function dotRequestLimits(
    settings: Settings,
    server: DotRequestLimits = DEFAULT_DOT_REQUEST_LIMITS,
): DotRequestLimits {
    return { ...server, ...settings.dotDailyLimits };
}

/** `DOT_REQUESTS_PER_DOT_DAILY` and `DOT_REQUESTS_PER_USER_DAILY`. */
export function dotRequestLimitsFromEnv(env: Record<string, string | undefined>): DotRequestLimits {
    const read = (name: string, fallback: number) => {
        const raw = env[name]?.trim();
        if (!raw) {
            return fallback;
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`${name} must be a whole number, 0 or more.`);
        }
        return value;
    };
    return {
        ...DEFAULT_DOT_REQUEST_LIMITS,
        perDot: read('DOT_REQUESTS_PER_DOT_DAILY', DEFAULT_DOT_REQUEST_LIMITS.perDot),
        perUser: read('DOT_REQUESTS_PER_USER_DAILY', DEFAULT_DOT_REQUEST_LIMITS.perUser),
    };
}

// --- Automatic triage -------------------------------------------------------

export const DEFAULT_AUTO_TRIAGE: AutoTriageSettings = {
    enabled: false,
    perDay: 100,
};

/**
 * The switch and cap in force: an admin's from Settings (`autoTriage`) over
 * the server's, which come from the environment. Off unless turned on.
 */
export function autoTriageSettings(
    settings: Settings,
    server: AutoTriageSettings = DEFAULT_AUTO_TRIAGE,
): AutoTriageSettings {
    return { ...server, ...settings.autoTriage };
}

/** `AUTO_TRIAGE` (`true` or `false`) and `AUTO_TRIAGE_DAILY`. */
export function autoTriageFromEnv(env: Record<string, string | undefined>): AutoTriageSettings {
    const switchRaw = env.AUTO_TRIAGE?.trim().toLowerCase();
    if (switchRaw && switchRaw !== 'true' && switchRaw !== 'false') {
        throw new Error('AUTO_TRIAGE must be true or false.');
    }
    const capRaw = env.AUTO_TRIAGE_DAILY?.trim();
    const perDay = capRaw ? Number(capRaw) : DEFAULT_AUTO_TRIAGE.perDay;
    if (!Number.isInteger(perDay) || perDay < 0) {
        throw new Error('AUTO_TRIAGE_DAILY must be a whole number, 0 or more.');
    }
    return { enabled: switchRaw === 'true', perDay };
}
