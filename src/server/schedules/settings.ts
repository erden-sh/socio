import { DEFAULT_SCHEDULE_SETTINGS, type JobSettings, type ScheduleSettings } from './contract.js';

function whole(env: Record<string, string | undefined>, name: string, min: number, max: number): number | undefined {
    const raw = env[name]?.trim();
    if (!raw) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    }
    return value;
}

export function scheduleSettingsFromEnv(env: Record<string, string | undefined>): ScheduleSettings {
    const minutes = whole(env, 'SCHEDULE_MIN_INTERVAL_MINUTES', 1, 10_080);
    const perUser = whole(env, 'SCHEDULES_PER_USER', 1, 1000);
    return {
        minIntervalMs: minutes === undefined ? DEFAULT_SCHEDULE_SETTINGS.minIntervalMs : minutes * 60_000,
        maxActivePerUser: perUser ?? DEFAULT_SCHEDULE_SETTINGS.maxActivePerUser,
    };
}

export function jobSettingsFromEnv(env: Record<string, string | undefined>): Partial<JobSettings> {
    const settings: Partial<JobSettings> = {};
    const timeout = whole(env, 'JOB_MAX_TIMEOUT_SECONDS', 10, 6 * 3600);
    const concurrency = whole(env, 'JOB_CONCURRENCY', 1, 32);
    const wake = whole(env, 'JOB_WAKE_SECONDS', 5, 600);
    const jobs = whole(env, 'JOBS_PER_USER', 1, 1000);
    const attempts = whole(env, 'JOB_ITEM_ATTEMPTS', 1, 20);
    const retries = whole(env, 'JOB_BATCH_RETRIES', 0, 50);
    const batches = whole(env, 'JOB_MAX_BATCHES', 1, 10_000);
    if (timeout !== undefined) {
        settings.maxTimeoutSeconds = timeout;
    }
    if (concurrency !== undefined) {
        settings.concurrency = concurrency;
    }
    if (wake !== undefined) {
        settings.wakeTimeoutMs = wake * 1000;
    }
    if (jobs !== undefined) {
        settings.maxJobsPerUser = jobs;
    }
    if (attempts !== undefined) {
        settings.itemAttempts = attempts;
    }
    if (retries !== undefined) {
        settings.batchRetries = retries;
    }
    if (batches !== undefined) {
        settings.maxBatches = batches;
    }
    return settings;
}
