/**
 * Schedules' and jobs' limits and their built-in defaults, moved here
 * from `server/schedules/contract.ts` so the settings' limits read them
 * without importing schedules. The schedules contract re-exports them.
 */
/** Schedules and jobs: limits, from the environment (index.ts). */
export interface ScheduleSettings {
    /** `SCHEDULE_MIN_INTERVAL_MINUTES` (15): the shortest gap between runs. */
    minIntervalMs: number;
    /** `SCHEDULES_PER_USER` (20): active Dot-proposed schedules per user. */
    maxActivePerUser: number;
}
export interface JobSettings {
    /** `JOB_MAX_TIMEOUT_SECONDS` (900): the longest timeout a job may ask for. */
    maxTimeoutSeconds: number;
    /** `JOB_CONCURRENCY` (2): job runs at once, across the workspace; more wait. */
    concurrency: number;
    /** `JOB_WAKE_SECONDS` (90): how long a run waits for a stopped computer. */
    wakeTimeoutMs: number;
    /** `JOBS_PER_USER` (50): saved jobs per user. */
    maxJobsPerUser: number;
    /** Files per job version, and their total size. */
    maxFiles: number;
    maxBytes: number;
    /** Kept per stream (stdout, stderr) of a run: the last part. */
    logMaxBytes: number;
    /** Up to this timeout, one exec call waits for the run; longer runs are polled. */
    syncMaxSeconds: number;
    /** How often a long run is checked on. */
    pollMs: number;
    /** How long past its timeout a run gets to report before it is killed. */
    graceMs: number;
    /**
     * Runs per job that keep their stdout and stderr, the newest. Older runs
     * are kept too, without their output.
     */
    keepRuns: number;
    /**
     * `JOB_ITEM_ATTEMPTS` (3): how many times an item of a job that runs
     * until done (CB-122) is tried before it is set aside (dead-lettered).
     */
    itemAttempts: number;
    /**
     * `JOB_BATCH_RETRIES` (5): batches in a row that fail, make no progress
     * or are refused (403, 429) before such a job stops as failed.
     */
    batchRetries: number;
    /** `JOB_MAX_BATCHES` (200): the most batches one run until done may take. */
    maxBatches: number;
    /** The first wait after a failed batch or item; it doubles each time. */
    retryBaseMs: number;
    /** The first wait after a source refused (403, 429) without saying how long. */
    refusalWaitMs: number;
    /** The longest wait between batches, whatever a source asks. */
    maxWaitMs: number;
    /**
     * After a restart (CB-161): how long a run waits for the app to answer
     * before the job starts, and how long after the app is ready a batch
     * that failed for a refused connection, with nothing done, costs nothing.
     */
    startupWindowMs: number;
    /** A short wait after the app is listening before long runs resume. */
    startupSettleMs: number;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
    minIntervalMs: 15 * 60_000,
    maxActivePerUser: 20,
};
export const DEFAULT_JOB_SETTINGS: JobSettings = {
    maxTimeoutSeconds: 900,
    concurrency: 2,
    wakeTimeoutMs: 90_000,
    maxJobsPerUser: 50,
    maxFiles: 20,
    maxBytes: 256 * 1024,
    logMaxBytes: 16 * 1024,
    syncMaxSeconds: 45,
    pollMs: 2_000,
    graceMs: 15_000,
    keepRuns: 50,
    itemAttempts: 3,
    batchRetries: 5,
    maxBatches: 200,
    retryBaseMs: 30_000,
    refusalWaitMs: 5 * 60_000,
    maxWaitMs: 6 * 3600_000,
    startupWindowMs: 45_000,
    startupSettleMs: 2_000,
};
