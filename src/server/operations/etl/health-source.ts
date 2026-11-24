/**
 * What Health's ETL reads from the system of record (CB-192), beside
 * `SourceReader`'s turns: job runs and scheduled runs a batch at a time,
 * and the schedules, goals and long runs whole (they are small). Each
 * method is one short read; nothing here writes. The Scheduling and jobs
 * context owns these tables; this is the ETL's read-only copy (CB-164).
 */

/** A job run (`job_runs`), without its output. */
export interface SourceJobRun {
    id: string;
    jobId: string;
    dotId: string;
    userId: string;
    trigger: string;
    scheduleId: string | null;
    longRunId: string | null;
    status: string;
    queuedAt: number;
    startedAt: number | null;
    wakeMs: number | null;
    finishedAt: number | null;
}

/** A schedule's run (`runs`). */
export interface SourceTaskRun {
    id: string;
    taskId: string;
    status: string;
    dueAt: number | null;
    startedAt: number;
    finishedAt: number | null;
}

/** A live schedule (`tasks` with a cadence or an interval). */
export interface SourceSchedule {
    id: string;
    title: string | null;
    dotId: string | null;
    userId: string | null;
    kind: string | null;
    status: string;
    cadence: string | null;
    nextRunAt: number | null;
    lastRunAt: number | null;
    updatedAt: number;
    error: string | null;
}

export interface SourceGoal {
    id: string;
    dotId: string;
    userId: string;
    scheduleId: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
}

/** A long run and its job's name; its items are counted apart. */
export interface SourceLongRun {
    id: string;
    jobId: string;
    jobName: string | null;
    dotId: string;
    userId: string;
    status: string;
    batches: number;
    retries: number;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
    waitReason: string | null;
    lastError: string | null;
}

/** Where a keyset read got to: its sort time and id. */
export interface KeysetMark {
    at: number;
    id: string;
}

export interface HealthSourceReader {
    /** Whether the app has made the jobs' tables, and the schedules'. */
    hasJobs(): boolean;
    hasTasks(): boolean;
    /** Job runs queued after `mark`, oldest first, at most `limit`. */
    jobRunsAfter(mark: KeysetMark, limit: number): SourceJobRun[];
    jobRunsById(ids: readonly string[]): SourceJobRun[];
    /** Schedules' runs started after `mark`, oldest first, at most `limit`. */
    taskRunsAfter(mark: KeysetMark, limit: number): SourceTaskRun[];
    taskRunsById(ids: readonly string[]): SourceTaskRun[];
    schedules(): SourceSchedule[];
    goals(): SourceGoal[];
    longRuns(): SourceLongRun[];
    /** These long runs' items by status (done, dead, pending or claimed). */
    itemCounts(longRunIds: readonly string[]): { longRunId: string; status: string; n: number }[];
}
