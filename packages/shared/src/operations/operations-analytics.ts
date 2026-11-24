import { DEFAULT_TIME_ZONE, ianaTimeZone } from '../time-zone.js';

/**
 * The Operations analytics store (CB-186): a DuckDB file of derived data,
 * owned by one process (`socio-analytics`), rebuilt from SQLite when lost.
 * What the app, its Health view and the analytics process share.
 */
import type { OperationsSettings } from './operations.js';

/**
 * How the analytics process runs (`OPS_ANALYTICS_MODE`, env only: it is a
 * deployment choice). `child`: forked by the app, over IPC (development and
 * single-container installs). `service`: its own single-replica service in
 * the stack, over HTTP on the internal network.
 */
export type AnalyticsMode = 'child' | 'service';

/**
 * - `starting`: opening, or waiting for another process to let go of the
 *   file (shown as "Analytics starting");
 * - `ready`: answering;
 * - `rebuilding`: building a fresh file from SQLite; it still answers from
 *   the old file when that is of this version (an admin's rebuild), and
 *   answers "not ready" over one of another version (CB-187);
 * - `unavailable`: the process is down or can't be reached.
 */
export type AnalyticsState = 'starting' | 'ready' | 'rebuilding' | 'unavailable';

/** The analytics store's health, as Health and `setup()` show it. */
export interface AnalyticsHealth {
    mode: AnalyticsMode;
    state: AnalyticsState;
    /** While rebuilding: how far, 0 to 100. */
    progress?: number;
    /** When the store last caught up with SQLite (ms). */
    asOf?: number;
    /** A short operational reason (never paths, content or secrets). */
    detail?: string;
}

/** The DuckDB limits an admin tunes (Operations → Settings). */
export interface AnalyticsSettings {
    /** DuckDB's memory limit; without one it would take 80% of RAM. */
    memoryMb: number;
    threads: number;
    /** How often the ETL reads SQLite; also nudged after each turn. */
    etlEverySeconds: number;
    /**
     * How long the store keeps facts and their rollups, in days (CB-187);
     * 0, the default, keeps them as long as the database keeps the turns.
     */
    factDays: number;
    /** How long hourly rollups are kept; 0 keeps history. Daily ones go with facts. */
    hourlyDays: number;
}

export const ANALYTICS_DEFAULTS: AnalyticsSettings = {
    memoryMb: 512,
    threads: 2,
    etlEverySeconds: 60,
    factDays: 0,
    hourlyDays: 0,
};

/** What each setting may be; a value outside is ignored. */
export const ANALYTICS_BOUNDS: Record<keyof AnalyticsSettings, { min: number; max: number }> = {
    memoryMb: { min: 128, max: 65_536 },
    threads: { min: 1, max: 64 },
    etlEverySeconds: { min: 10, max: 3600 },
    factDays: { min: 0, max: 36_500 },
    hourlyDays: { min: 0, max: 36_500 },
};

const ENV: Record<keyof AnalyticsSettings, string> = {
    memoryMb: 'OPS_ANALYTICS_MEMORY_MB',
    threads: 'OPS_ANALYTICS_THREADS',
    etlEverySeconds: 'OPS_ETL_EVERY_SECONDS',
    factDays: 'OPS_FACT_DAYS',
    hourlyDays: 'OPS_HOURLY_DAYS',
};

function inBounds(key: keyof AnalyticsSettings, value: unknown) {
    const { min, max } = ANALYTICS_BOUNDS[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** The settings as the environment and built-in defaults set them. */
export function analyticsDefaults(env: Record<string, string | undefined>): AnalyticsSettings {
    const out = { ...ANALYTICS_DEFAULTS };
    for (const key of Object.keys(ENV) as (keyof AnalyticsSettings)[]) {
        const raw = env[ENV[key]]?.trim();
        if (!raw) {
            continue;
        }
        const value = inBounds(key, Number(raw));
        if (value === undefined) {
            const { min, max } = ANALYTICS_BOUNDS[key];
            throw new Error(`${ENV[key]} must be a whole number from ${min} to ${max}.`);
        }
        out[key] = value;
    }
    return out;
}

/** The settings in force: an admin's over the server's. */
export function analyticsInForce(
    saved: OperationsSettings | undefined,
    defaults: AnalyticsSettings,
): AnalyticsSettings {
    const analytics = saved?.analytics ?? {};
    const out = { ...defaults };
    for (const key of Object.keys(ENV) as (keyof AnalyticsSettings)[]) {
        out[key] = inBounds(key, analytics[key]) ?? defaults[key];
    }
    return out;
}

export function reportingTimeZone(
    saved: OperationsSettings | undefined,
    env: Record<string, string | undefined>,
): string {
    return ianaTimeZone(saved?.timeZone) ?? ianaTimeZone(env.OPS_TIME_ZONE) ?? DEFAULT_TIME_ZONE;
}
