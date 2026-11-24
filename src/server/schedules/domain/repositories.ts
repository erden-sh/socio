import type { JobEntry, JobFileView, LongRunItemFailure } from '@socio/shared/schedule-types';
import type { Result, Run, Status, Task, TaskEvent } from '@socio/shared/types';

import type { JobRun, LongRunRow, StoredTask, TaskThreadRepository } from '../contract.js';

/**
 * The Scheduling and jobs context's repositories (CB-110):
 * tasks and schedules with their runs, events and conversations; jobs with
 * their versions and runs; goals with their comments; long runs with their
 * items. Async, taking and returning plain domain types. Only
 * `schedules/infra` implements them; nothing else touches their tables.
 * Every write works inside or outside a unit of work: outside one it opens
 * its own, so there is a single writer path.
 */

// ---- tasks (schedules), their runs and events ------------------------------

/** What creating a task stores; the rest starts empty. */
export interface NewTask {
    id: string;
    prompt: string;
    status: Status;
    intervalSeconds: number | null;
    createdAt: number;
    userId: string;
    /** A schedule's. */
    title?: string;
    cadence?: string;
    timezone?: string;
    dotId?: string;
    kind?: 'turn' | 'job';
    jobId?: string | null;
    origin?: 'dot' | null;
}

/** The columns the scheduler changes on a task. */
export type TaskPatch = Partial<
    Pick<
        Task,
        | 'status'
        | 'intervalSeconds'
        | 'nextRunAt'
        | 'updatedAt'
        | 'error'
        | 'lease'
        | 'leaseUntil'
        | 'lastRunAt'
        | 'cadence'
    >
>;

/**
 * Tasks: a person's research tasks and schedules. Reads of a task
 * serve live ones only, but for `withDeleted`; deleting stamps it (CB-64).
 */
export interface TaskRepository {
    /** A live task. */
    get(id: string): Promise<Task | undefined>;
    /** A task, deleted or not, with its stamp. */
    withDeleted(id: string): Promise<StoredTask | undefined>;
    /** The person's live tasks, newest first. */
    list(userId: string): Promise<Task[]>;
    /** Every live task, newest first. */
    all(): Promise<Task[]>;
    /** The person's live schedules and repeating tasks, newest first. */
    schedules(userId: string): Promise<Task[]>;
    /** The person's live schedules not canceled or failed. */
    activeScheduleCount(userId: string): Promise<number>;
    /** Everyone's live schedules by status. */
    scheduleCounts(): Promise<Record<string, number>>;
    /** The live schedules that run a job, oldest first. */
    forJob(jobId: string): Promise<Task[]>;
    /** The ids of the tasks a Dot proposed, deleted or not. */
    idsOfDot(dotId: string): Promise<string[]>;
    /** Live Dot-made schedules not canceled whose prompt names a goal. */
    goalCandidates(): Promise<Array<{ id: string; prompt: string }>>;
    /** Live running tasks whose lease ended by `now`. */
    expired(now: number): Promise<Task[]>;
    /** The oldest live task due by `now`: queued, or its next time come. */
    due(now: number): Promise<Task | undefined>;
    insert(task: NewTask): Promise<void>;
    /**
     * Changes a task, live or not; only while it has `status` when given.
     * Says whether it changed.
     */
    update(id: string, patch: TaskPatch, status?: Status): Promise<boolean>;
    /** Stamps a live task deleted; says whether it was live. */
    remove(id: string, by: string, withParent: string | null, now: number): Promise<boolean>;
    /** Gives tasks from before user accounts to a user; says how many. */
    assignUnowned(userId: string): Promise<number>;
}

/** A task's run, the lease that claimed it. */
export interface TaskRunRepository {
    /** `dueAt`: when the run came due (CB-185), if known. */
    start(id: string, taskId: string, now: number, dueAt?: number | null): Promise<void>;
    /**
     * Ends a run: `completed` with its result, else with its error. With
     * `running`, only a run still running.
     */
    end(
        id: string,
        end: {
            status: string;
            finishedAt: number;
            result?: Result;
            error?: string;
        },
        running?: boolean,
    ): Promise<void>;
    /** A task's runs, newest first, with their results. */
    list(taskId: string): Promise<Run[]>;
    /** A task's latest runs, newest first, without their results. */
    recent(
        taskId: string,
        limit: number,
    ): Promise<
        Array<{
            id: string;
            status: string;
            startedAt: number;
            finishedAt: number | null;
            error: string | null;
        }>
    >;
    /**
     * A page of a task's runs, newest first, older than its run `before`
     * when given; undefined for a `before` that isn't the task's.
     */
    page(taskId: string, limit: number, before?: string): Promise<{ runs: Run[]; more: boolean } | undefined>;
}

/** A task's history lines. */
export interface TaskEventRepository {
    add(taskId: string, runId: string | null, text: string, now: number): Promise<void>;
    /** Oldest first. */
    list(taskId: string): Promise<TaskEvent[]>;
}

// ---- jobs, their versions and runs -----------------------------------------

/** A job: its current version is `version`. */
export interface Job {
    id: string;
    userId: string;
    dotId: string;
    name: string;
    version: number;
    createdAt: number;
    updatedAt: number;
}
export type StoredJob = Job & {
    deletedAt: number | null;
    deletedBy: string | null;
};

/** A saved version of a job's code: where its files are, and its limits. */
export interface JobVersion {
    jobId: string;
    version: number;
    entry: JobEntry;
    files: JobFileView[];
    digest: string;
    timeoutSeconds: number;
    datasets: string[];
    approvalId: string | null;
    createdAt: number;
    untilDone: boolean;
}

export interface JobRepository {
    /** A live job; a deleted one is missing (CB-64). */
    get(id: string): Promise<Job | undefined>;
    withDeleted(id: string): Promise<StoredJob | undefined>;
    /** The person's live job of that name for the Dot. */
    named(userId: string, dotId: string, name: string): Promise<Job | undefined>;
    /** The person's live jobs (with `dotId`, that Dot's), newest change first. */
    list(userId: string, dotId?: string): Promise<Job[]>;
    /** Everyone's live jobs. */
    count(): Promise<number>;
    /**
     * Saves a version: the job's first (it is made) or its next (`version`
     * moves on), with its version row, in one unit of work.
     */
    save(
        job: Pick<Job, 'id' | 'userId' | 'dotId' | 'name'>,
        version: JobVersion,
        isNew: boolean,
        now: number,
    ): Promise<void>;
    version(jobId: string, version: number): Promise<JobVersion | undefined>;
    /** Newest first. */
    versions(jobId: string): Promise<JobVersion[]>;
    /** Stamps a live job deleted. */
    remove(id: string, by: string, now: number): Promise<void>;
}

export type NewJobRun = Pick<
    JobRun,
    'id' | 'jobId' | 'version' | 'userId' | 'dotId' | 'trigger' | 'scheduleId' | 'queuedAt' | 'longRunId'
>;
export type JobRunPatch = Partial<
    Pick<JobRun, 'status' | 'startedAt' | 'wakeMs' | 'finishedAt' | 'exitCode' | 'stdout' | 'stderr' | 'error'>
>;

/** Job runs: every run is kept; past the newest, their output is trimmed. */
export interface JobRunRepository {
    get(id: string): Promise<JobRun | undefined>;
    /** The job's newest run. */
    latest(jobId: string): Promise<JobRun | undefined>;
    /** The newest run a schedule started. */
    latestOfSchedule(scheduleId: string): Promise<JobRun | undefined>;
    /** The job's newest run that is queued, starting or running. */
    open(jobId: string): Promise<JobRun | undefined>;
    /** A page of the job's runs, newest first, older than its run `before`. */
    page(jobId: string, limit: number, before?: string): Promise<{ runs: JobRun[]; more: boolean }>;
    /** A page of the person's runs a schedule started, as `page`. */
    ofSchedule(
        scheduleId: string,
        userId: string,
        limit: number,
        before?: string,
    ): Promise<{ runs: JobRun[]; more: boolean }>;
    /** A Dot's runs queued by `before`, newest first (its admin activity). */
    ofDot(dotId: string, before: number, limit: number): Promise<JobRun[]>;
    /** When a Dot's newest run was queued. */
    lastOfDot(dotId: string): Promise<number | null>;
    insert(run: NewJobRun): Promise<void>;
    update(id: string, patch: JobRunPatch): Promise<void>;
    /**
     * Empties the output of the job's finished runs past its newest `keep`,
     * stamping when.
     */
    trimOutput(jobId: string, keep: number, now: number): Promise<void>;
    /**
     * Offers each open run to owner-aware recovery, inside the writer unit.
     * `recover` calls `interrupt` only for an orphan, never for live work.
     */
    interruptOpen(now: number, error: string, recover: (id: string, interrupt: () => void) => void): Promise<void>;
    /** Everyone's runs by status (kept by triggers), none left out but empty ones. */
    counts(): Promise<Record<string, number>>;
}

// ---- goals and their comments ----------------------------------------------

/** A goal as stored: its status beyond active comes from its schedule. */
export interface Goal {
    id: string;
    userId: string;
    dotId: string;
    title: string;
    detail: string;
    scheduleId: string;
    status: 'active' | 'done' | 'cancelled';
    progress: string | null;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
}

export interface GoalCommentRecord {
    id: string;
    goalId: string;
    authorKind: 'person' | 'dot';
    authorId: string;
    body: string;
    createdAt: number;
}

export interface GoalRepository {
    get(id: string): Promise<Goal | undefined>;
    /** The person's goals (with `dotId`, that Dot's), newest first. */
    list(userId: string, dotId?: string): Promise<Goal[]>;
    /** A Dot's goals, everyone's, newest first. */
    forDot(dotId: string): Promise<Goal[]>;
    /** When a Dot's newest goal was set. */
    lastOfDot(dotId: string): Promise<number | null>;
    /** The goal a schedule works on. */
    bySchedule(scheduleId: string): Promise<Goal | undefined>;
    insert(goal: Omit<Goal, 'closedAt'>): Promise<void>;
    /** A progress note, the status, or both; a status closes it at `now`. */
    update(id: string, patch: { progress?: string; status?: 'done' | 'cancelled' }, now: number): Promise<void>;
    /** Oldest first. */
    comments(goalId: string): Promise<GoalCommentRecord[]>;
    comment(comment: GoalCommentRecord): Promise<void>;
}

// ---- long runs and their items (CB-122) ------------------------------------

export type NewLongRun = Pick<
    LongRunRow,
    'id' | 'jobId' | 'userId' | 'dotId' | 'trigger' | 'scheduleId' | 'threadId' | 'createdAt'
>;
export type LongRunPatch = Partial<Omit<LongRunRow, 'id' | 'jobId' | 'userId' | 'dotId' | 'createdAt'>>;

/** A long run's items by state. */
export interface ItemCounts {
    pending: number;
    claimed: number;
    done: number;
    dead: number;
    total: number;
    /** Tries counted on every item: a try charged or set aside moves it. */
    tries: number;
}

export type DoneResult = 'done' | 'already' | 'not_claimed' | 'unknown';
export type FailResult = 'retry' | 'dead' | 'refunded' | 'already' | 'not_claimed' | 'unknown';

/**
 * Long runs and their items (CB-122). An item is claimed by one batch at a
 * time and marked done or failed only by the batch that holds it, so it is
 * done exactly once; `release` hands back what a batch still held when it
 * ended.
 */
export interface LongRunRepository {
    /** Creates it, or returns the job's open long run if there is one. */
    create(row: NewLongRun): Promise<LongRunRow>;
    get(id: string): Promise<LongRunRow | undefined>;
    /** The job's long run that is running or waiting. */
    open(jobId: string): Promise<LongRunRow | undefined>;
    /** The job's newest long run, open or not. */
    latest(jobId: string): Promise<LongRunRow | undefined>;
    /** Every running or waiting long run, oldest first. */
    openRuns(): Promise<LongRunRow[]>;
    /** Ended long runs not reported yet, that ended after `since`. */
    unreported(since: number): Promise<LongRunRow[]>;
    update(id: string, patch: LongRunPatch, now: number): Promise<void>;
    /** Adds the keys not there yet; returns how many were new. */
    addItems(longRunId: string, keys: string[], now: number): Promise<number>;
    /** Claims up to `limit` pending items due by `now` for the batch, oldest first. */
    claim(longRunId: string, batchId: string, limit: number, now: number): Promise<string[]>;
    done(longRunId: string, batchId: string, key: string, now: number): Promise<DoneResult>;
    /**
     * A batch's item failed. `refund`: not the item's fault (a source's
     * refusal), so its try doesn't count; else it is set aside once it was
     * tried `maxAttempts` times or `retry` is false, and waits `waitMs(tries)`
     * otherwise.
     */
    fail(
        longRunId: string,
        batchId: string,
        key: string,
        options: {
            error: string;
            retry: boolean;
            refund: boolean;
            maxAttempts: number;
            waitMs: (attempts: number) => number;
        },
        now: number,
    ): Promise<FailResult>;
    /**
     * Hands back what a batch still held when it ended. With `refund` (it
     * was stopped from outside) none of its tries count; else the first
     * item it held (the one it was on) is charged, as a failed item is: set
     * aside with `error` once tried `maxAttempts` times, else it waits
     * `waitMs(tries)`.
     */
    release(
        longRunId: string,
        batchId: string,
        options: {
            refund: boolean;
            maxAttempts: number;
            error: string;
            waitMs: (attempts: number) => number;
        },
        now: number,
    ): Promise<{ released: number; dead: number }>;
    counts(longRunId: string): Promise<ItemCounts>;
    /** Items set aside, newest first (the dead letters). */
    dead(longRunId: string, limit: number): Promise<LongRunItemFailure[]>;
    /** When the soonest pending item is due; null when none is pending. */
    nextDue(longRunId: string): Promise<number | null>;
}

/** The repositories on the workspace's connection. */
export interface ScheduleRepositories {
    taskThreads: TaskThreadRepository;
    jobs: JobRepository;
    jobRuns: JobRunRepository;
    goals: GoalRepository;
    longRuns: LongRunRepository;
}

/** The repositories on the core store's connection (one in production). */
export interface TaskRepositories {
    tasks: TaskRepository;
    runs: TaskRunRepository;
    events: TaskEventRepository;
}
