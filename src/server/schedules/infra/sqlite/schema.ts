import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { id, int, ms, str } from '@socio/data/columns.sqlite';
import type { JobEntry, JobRunStatus, JobRunTrigger, LongRunStatus } from '@socio/shared/schedule-types';
import type { Status } from '@socio/shared/types';

/**
 * The Scheduling and jobs context's tables (CB-110), as the migrations make
 * them: the typed mirror the repositories query. The migrations stay the
 * source of truth: `tasks`, `runs` and `events` were made by `core` 1 to 3
 * and `task_threads` by `workspace` 1, frozen there, then adopted by this
 * context's `schedule-tasks` baseline; the jobs' tables by
 * `schedules`. tests/schedule-repositories.test.ts holds these to them.
 * Their CHECKs are the migrations'; most columns predate `enumText`.
 */

/** A research task, or a schedule: a task with a cadence. */
export const tasks = sqliteTable('tasks', {
    id: id().primaryKey(),
    prompt: str().notNull(),
    status: str().$type<Status>().notNull(),
    intervalSeconds: int(),
    nextRunAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    error: str(),
    lease: str(),
    leaseUntil: ms(),
    /** Null only for a task from before user accounts (`assignUnowned`). */
    userId: str(),
    title: str(),
    cadence: str(),
    timezone: str(),
    dotId: str(),
    kind: str().$type<'turn' | 'job'>(),
    jobId: str(),
    origin: str().$type<'dot'>(),
    lastRunAt: ms(),
    deletedAt: ms(),
    deletedBy: str(),
    deletedWith: str(),
});

/** A task's run: its id is the lease that claimed the task. */
export const runs = sqliteTable('runs', {
    id: id().primaryKey(),
    taskId: id().notNull(),
    status: str().notNull(),
    startedAt: ms().notNull(),
    finishedAt: ms(),
    /** The run's `Result`, as JSON text. */
    result: str(),
    error: str(),
    /** When it came due (CB-185, schedule-tasks 2); null for runs from before. */
    dueAt: ms(),
});

/** A task's history lines, in `id` order. */
export const events = sqliteTable('events', {
    id: int().primaryKey({ autoIncrement: true }),
    taskId: id().notNull(),
    runId: str(),
    text: str().notNull(),
    createdAt: ms().notNull(),
});

/** The conversation a scheduled task's turns run in. */
export const taskThreads = sqliteTable('task_threads', {
    taskId: id().primaryKey(),
    threadId: id().notNull(),
});

export const jobs = sqliteTable('jobs', {
    id: id().primaryKey(),
    userId: str().notNull(),
    dotId: str().notNull(),
    name: str().notNull(),
    version: int().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
});

export const jobVersions = sqliteTable(
    'job_versions',
    {
        jobId: id().notNull(),
        version: int().notNull(),
        entry: str().$type<JobEntry>().notNull(),
        /** `JobFileView[]` as JSON text. */
        files: str().notNull(),
        digest: str().notNull(),
        timeoutSeconds: int().notNull(),
        /** Dataset ids as JSON text. */
        datasets: str().notNull(),
        approvalId: str(),
        createdAt: ms().notNull(),
        untilDone: int().notNull(),
    },
    (table) => [primaryKey({ columns: [table.jobId, table.version] })],
);

export const jobRuns = sqliteTable('job_runs', {
    id: id().primaryKey(),
    jobId: id().notNull(),
    version: int().notNull(),
    userId: str().notNull(),
    dotId: str().notNull(),
    trigger: str().$type<JobRunTrigger>().notNull(),
    scheduleId: str(),
    status: str().$type<JobRunStatus>().notNull(),
    queuedAt: ms().notNull(),
    startedAt: ms(),
    wakeMs: int(),
    finishedAt: ms(),
    exitCode: int(),
    stdout: str(),
    stderr: str(),
    error: str(),
    outputTrimmedAt: ms(),
    longRunId: str(),
});

/** Runs by status, kept by triggers on `job_runs` (schedules migration 4). */
export const jobRunCounts = sqliteTable('job_run_counts', {
    status: str().primaryKey(),
    n: int().notNull(),
});

export const goals = sqliteTable('goals', {
    id: id().primaryKey(),
    userId: str().notNull(),
    dotId: str().notNull(),
    title: str().notNull(),
    detail: str().notNull(),
    scheduleId: id().notNull(),
    status: str().$type<'active' | 'done' | 'cancelled'>().notNull(),
    progress: str(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    closedAt: ms(),
});

export const goalComments = sqliteTable('goal_comments', {
    id: id().primaryKey(),
    goalId: id().notNull(),
    authorKind: str().$type<'person' | 'dot'>().notNull(),
    authorId: str().notNull(),
    body: str().notNull(),
    createdAt: ms().notNull(),
});

export const jobLongRuns = sqliteTable('job_long_runs', {
    id: id().primaryKey(),
    jobId: id().notNull(),
    userId: str().notNull(),
    dotId: str().notNull(),
    trigger: str().$type<JobRunTrigger>().notNull(),
    scheduleId: str(),
    threadId: str(),
    status: str().$type<LongRunStatus>().notNull(),
    batches: int().notNull(),
    retries: int().notNull(),
    sealed: int().notNull(),
    completed: int().notNull(),
    checkpoint: str(),
    checkpointAt: ms(),
    currentRunId: str(),
    nextAt: ms(),
    waitReason: str(),
    mark: str(),
    lastError: str(),
    jobSummary: str(),
    outcome: str(),
    reportedAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    finishedAt: ms(),
});

export const jobItems = sqliteTable('job_items', {
    /** The claim order. */
    id: int().primaryKey(),
    longRunId: id().notNull(),
    key: str().notNull(),
    status: str().$type<'pending' | 'claimed' | 'done' | 'dead'>().notNull(),
    attempts: int().notNull(),
    claimedBy: str(),
    nextAt: ms(),
    error: str(),
    updatedAt: ms().notNull(),
    doneAt: ms(),
});

/** The tables on the core store's connection (one in production). */
export const taskTables = [tasks, runs, events] as const;

/** Every table the Scheduling and jobs context owns. */
export const scheduleTables = [
    ...taskTables,
    taskThreads,
    jobs,
    jobVersions,
    jobRuns,
    jobRunCounts,
    goals,
    goalComments,
    jobLongRuns,
    jobItems,
] as const;
