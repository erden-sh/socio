/**
 * What other features may know of schedules, jobs, goals and long runs: the
 * tags for what they ask of this folder, as slices of the methods they call,
 * its error, and its plain types and constants. It imports only `effect` and
 * `@socio/*`, and holds no logic.
 *
 * What moved here is imported from here; the old paths' re-exports are
 * gone. The services implement their shapes, and the schedules layer
 * (`layer.ts`) provides the tags. The limits' defaults live in
 * `@socio/shared/schedules/settings`, re-exported here, so the settings
 * read them without importing this folder. Its ports (`JobData`,
 * `ScheduleBoard`, at the end) are what it asks of folders above it.
 *
 * Not here, on purpose:
 * - `jobCheckpointRoutes` (`checkpoint-routes.ts`) mounts routes: it moves
 *   into the composition's HTTP files, not behind a tag.
 * - `sqliteTaskRepositories` and `sqliteTaskThreads` build the
 *   repositories the core store (`composition/core-store.ts`) and
 *   `WorkspaceStore` hold: construction. `TaskService`
 *   is reached through the `Tasks` and `TaskClaims` tags.
 * - `scheduleSettingsFromEnv` and `jobSettingsFromEnv` are read by
 *   `index.ts` only, which is entry code.
 */
import { Context } from 'effect';

import type { DataTokenScope } from '@socio/foundation/http/app-env';
import type { OwnedList, TransferParties, TransferTally } from '@socio/shared/auth';
import type { IssueTitle } from '@socio/shared/issues/issue-types';
import type {
    GoalView,
    JobRunStatus,
    JobRunView,
    JobRunTrigger,
    JobView,
    LongRunStatus,
    LongRunView,
    ScheduleDetail,
    ScheduleRunBoardItem,
    ScheduleRunsPage,
    SchedulesState,
    ScheduleView,
} from '@socio/shared/schedule-types';
import type { JobSettings, ScheduleSettings } from '@socio/shared/schedules/settings';
import type { Action, Detail, Result, Run, Task, User } from '@socio/shared/types';

// ── Settings ─────────────────────────────────────────────────────────────

export {
    DEFAULT_JOB_SETTINGS,
    DEFAULT_SCHEDULE_SETTINGS,
    type JobSettings,
    type ScheduleSettings,
} from '@socio/shared/schedules/settings';

// ── Plain types and constants ─────────────────────────────────────────────

/** A task as stored, with its soft-delete stamp (CB-64). */
export type StoredTask = Task & {
    deletedAt: number | null;
    deletedBy: string | null;
    deletedWith: string | null;
};
/** A claimed task; `dueAt` is when its run came due (CB-185). */
export type Claim = Task & { lease: string; dueAt?: number | null };
/** A schedule that failed this many runs in a row pauses itself. */
export const SCHEDULE_PAUSE_AFTER_FAILURES = 5;
/** What `createSchedule` stores: a cadence-based task. */
export interface ScheduleInput {
    userId: string;
    title: string;
    /** The turn's prompt; for jobs, a line saying what runs. */
    prompt: string;
    cadence: string;
    timezone: string;
    dotId: string;
    kind: 'turn' | 'job';
    jobId?: string | null;
    origin?: 'dot' | null;
}

/** A run's error when its owner is deactivated. */
export const DEACTIVATED_JOB_RUN = 'Stopped: its owner was deactivated.';

/** The conversation each scheduled task runs its turns in. */
export interface TaskThreadRepository {
    bind(taskId: string, threadId: string): Promise<void>;
    threadOf(taskId: string): Promise<string | undefined>;
    /** The tasks bound to these conversations. */
    tasksOf(threadIds: readonly string[]): Promise<string[]>;
}

/** A job run as stored. */
export interface JobRun {
    id: string;
    jobId: string;
    version: number;
    userId: string;
    dotId: string;
    trigger: JobRunTrigger;
    scheduleId: string | null;
    status: JobRunStatus;
    queuedAt: number;
    startedAt: number | null;
    wakeMs: number | null;
    finishedAt: number | null;
    exitCode: number | null;
    stdout: string | null;
    stderr: string | null;
    error: string | null;
    outputTrimmedAt: number | null;
    longRunId: string | null;
}

/** A long run as stored (`job_long_runs`, schedules migration 8). */
export interface LongRunRow {
    id: string;
    jobId: string;
    userId: string;
    dotId: string;
    trigger: JobRunTrigger;
    scheduleId: string | null;
    threadId: string | null;
    status: LongRunStatus;
    batches: number;
    retries: number;
    /** The job declared its whole list of items (1) or not (0). */
    sealed: number;
    /** The job said it is complete (1). */
    completed: number;
    checkpoint: string | null;
    checkpointAt: number | null;
    currentRunId: string | null;
    nextAt: number | null;
    waitReason: string | null;
    /** What the current batch started from (`BatchMark`, JSON). */
    mark: string | null;
    lastError: string | null;
    jobSummary: string | null;
    outcome: string | null;
    reportedAt: number | null;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A schedule request that can't be served, with the HTTP status it answers
 * with. Caught with `instanceof` (`web/services.ts` turns a 404 into "not
 * found"); kept a plain `Error` so its name and message stay what they are
 * today.
 */
export class ScheduleError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 429 = 400,
    ) {
        super(message);
    }
}

// ── Tasks ────────────────────────────────────────────────────────────────

/**
 * Scheduled tasks (a person's research tasks and schedules), as other
 * features reach them through the core store's `TaskService`: `auth/`
 * (`pauseOwnedBy`, deactivation), `live/` (`list`, `activeScheduleCount`),
 * and the composition, `app.ts` and `index.ts` (the task routes, a Dot's
 * archive and delete, the first admin's `assignUnowned`). The names are
 * `TaskService`'s, which implements it.
 */
export interface TasksShape {
    /** The user's tasks, newest first. */
    list(userId: string): Promise<Task[]>;
    /** The task when it exists and is the user's (`Store.ownedTask`). */
    owned(id: string, userId: string): Promise<Task | undefined>;
    /** A live task; a deleted one is missing (`Store.task`). */
    get(id: string): Promise<Task | undefined>;
    /** A task, deleted or not, with its stamp (`Store.withDeletedTask`). */
    withDeleted(id: string): Promise<StoredTask | undefined>;
    /** A research task (`Store.createTask`). */
    create(prompt: string, intervalSeconds: number | null, userId: string): Promise<Task>;
    detail(id: string): Promise<Detail | undefined>;
    action(id: string, action: Action): Promise<Task | undefined>;
    /** Sets or clears a task's interval; undefined when it is gone. */
    schedule(id: string, intervalSeconds: number | null): Promise<Task | undefined>;
    /** Pauses these tasks with `reason`; how many. */
    pauseTasks(ids: readonly string[], reason: string): Promise<number>;
    /** Pauses a person's schedules (they were deactivated); how many. */
    pauseOwnedBy(userId: string, reason: string): Promise<number>;
    /** How many tasks `pauseOwnedBy` would pause now (CB-360's deactivation preview). */
    pausableCountOf(userId: string): Promise<number>;
    /** The ids of tasks proposed by a Dot (schedules and goals). */
    dotScheduleIds(dotId: string): Promise<string[]>;
    /** Schedules not canceled (the per-user cap counts them). */
    activeScheduleCount(userId: string): Promise<number>;
    /**
     * A page of a task's runs with their results, newest first, older than
     * `before` when given; undefined for a `before` that isn't the task's.
     */
    taskRuns(taskId: string, limit: number, before?: string): Promise<{ runs: Run[]; more: boolean } | undefined>;
    /** The shortest gap between a schedule's runs, in ms (Settings → General). */
    readonly scheduleMinGapMs: () => number;
    /** Deletes one of the user's tasks, unless running; whether it did. */
    deleteTask(id: string, userId: string, withParent?: string | null, now?: number): Promise<boolean>;
    /** Gives tasks from before user accounts to a user; how many. */
    assignUnowned(userId: string): Promise<number>;
}

export class Tasks extends Context.Service<Tasks, TasksShape>()('socio/schedules/Tasks') {}

/**
 * The task worker's side (`turns/runner.ts`): claim a due task under a
 * lease, check the lease, record the run's events and its end. `TaskService` implements
 * it, and the core store hands it in (`taskRunnerStoreOf`).
 */
export interface TaskClaimsShape {
    /** How long a claimed task is held before another claim may take it over. */
    leaseMs: number;
    /** The next due task, claimed; null when none is due or `admitted` says no. */
    claim(now?: number, admitted?: () => boolean): Promise<Claim | null>;
    /** Whether this claim still holds its task's lease. */
    owns(claim: Claim): Promise<boolean>;
    /** Records the run's result; whether the claim still held. */
    finish(claim: Claim, result: Result, now?: number): Promise<boolean>;
    /** Records the run's failure. */
    fail(claim: Claim, error: string): Promise<void>;
    /** Ends the claimed run as interrupted, with `reason`, while the claim still holds. */
    interrupt(claim: Claim, reason: string): Promise<void>;
    /** Adds a line to a task's events (a run's progress). */
    event(taskId: string, runId: string | null, text: string): Promise<void>;
}

export class TaskClaims extends Context.Service<TaskClaims, TaskClaimsShape>()('socio/schedules/TaskClaims') {}

// ── Schedules ────────────────────────────────────────────────────────────

/**
 * A person's schedules, as `ask/`, `live/` and the operators' counts read
 * them. `ScheduleService` (`service.ts`) implements it.
 */
export interface SchedulesShape {
    /** The limits in force: an admin's (Settings), over the environment's. */
    readonly settings: ScheduleSettings;
    /** The user's schedules and repeating tasks; with `dotId`, that Dot's. */
    list(userId: string, dotId?: string): Promise<ScheduleView[]>;
    /** Any of the user's tasks, as a schedule (its details page); undefined when not theirs. */
    find(userId: string, id: string): Promise<ScheduleView | undefined>;
    /** Everyone's schedules by status (operators: counts only). */
    counts(): Promise<Record<string, number>>;
}

export class Schedules extends Context.Service<Schedules, SchedulesShape>()('socio/schedules/Schedules') {}

/**
 * A schedule's details page and its older runs (CB-88), as `live/` and
 * `web/` serve them: today `scheduleDetailView` and `scheduleRunsView`
 * (`detail.ts`), which `ScheduleDetailViews` wraps. Both reject with a
 * `ScheduleError` (404) for a schedule that isn't the person's, and `runs`
 * for a `before` that isn't one of its runs.
 */
export interface ScheduleDetailsShape {
    detail(userId: string, id: string): Promise<ScheduleDetail>;
    runs(userId: string, id: string, before: string, limit?: number): Promise<ScheduleRunsPage>;
}

export class ScheduleDetails extends Context.Service<ScheduleDetails, ScheduleDetailsShape>()(
    'socio/schedules/ScheduleDetails',
) {}

/**
 * The schedule views the pages read (once `live/views/schedules.ts`, which
 * re-exported `detail.ts`): the Schedules page's state and its long runs,
 * and one schedule's details and older runs. `ScheduleDetailViews`
 * (`detail.ts`) implements it; the schedules layer provides it: views live
 * behind their feature's tag, and the pages read them through it.
 */
export interface SchedulesViewsShape extends ScheduleDetailsShape {
    /** `GET /api/schedules`: the person's schedules, goals and jobs, limits and usage; operators' counts too. */
    schedules(user: User): Promise<SchedulesState>;
    /** That state with each job that runs until done showing its open or latest long run (CB-122). */
    withLongRuns(state: SchedulesState): Promise<SchedulesState>;
}

export class SchedulesViews extends Context.Service<SchedulesViews, SchedulesViewsShape>()(
    'socio/schedules/SchedulesViews',
) {}

// ── Jobs ─────────────────────────────────────────────────────────────────

/**
 * Jobs and their runs, as `auth/` (deactivation), `dots/` (the admins'
 * Dots page), `live/` (the Schedules page), `runtime/` (force stop),
 * `telegram/` (`/jobs`) and `LeaderWork` (drain, the shutdown wait, the pump
 * after listening) call them. `JobService` (`jobs.ts`) implements it.
 */
export interface JobsShape {
    /** The limits in force: an admin's, over the environment's, over the defaults. */
    readonly settings: JobSettings;
    /** Job runs in progress or waiting for a slot. */
    readonly running: number;
    /** The runs a deploy's drain waits for: not a long run's batches. */
    readonly holdingDrain: number;
    /** The user's jobs; with `dotId`, that Dot's. */
    list(userId: string, dotId?: string): Promise<JobView[]>;
    /** One of the user's jobs; rejects with a `JobError` when it isn't theirs. */
    job(userId: string, jobId: string, dotId?: string): Promise<JobView>;
    /** A Dot's runs queued by `before`, newest first (its admin activity). */
    dotRuns(dotId: string, before: number, limit: number): Promise<JobRun[]>;
    /** When a Dot's newest run was queued (its admin row). */
    lastDotRunAt(dotId: string): Promise<number | null>;
    /** A page of a job schedule's runs, newest first; undefined for a `before` not of its runs. */
    scheduleRuns(
        userId: string,
        scheduleId: string,
        limit: number,
        before?: string,
    ): Promise<{ runs: JobRunView[]; more: boolean } | undefined>;
    /** Everyone's runs by status, and saved jobs (the operators' counts). */
    counts(): Promise<{ jobs: number; jobRuns: Record<string, number>; runningJobs: number }>;
    /** Stops a person's runs, queued or running, with `reason` as each run's error; how many. */
    stopOwnedBy(userId: string, reason: string): number;
    /** How many runs `stopOwnedBy` would stop now (CB-360's deactivation preview). */
    runningCountOf(userId: string): number;
    /** Stops every run (a force stop, the shutdown deadline); how many. */
    forceStop(reason: string): number;
    /** Shutdown (SIGTERM): new runs are refused; the ones running finish. */
    drain(): void;
    /** Starts queued runs while there is a free slot. */
    pump(): void;
}

export class Jobs extends Context.Service<Jobs, JobsShape>()('socio/schedules/Jobs') {}

// ── Long runs ────────────────────────────────────────────────────────────

/**
 * Jobs that run until done (CB-122), as `live/` (each job's latest long
 * run) and `telegram/` (progress messages) read them. Each `on*` returns
 * its unsubscribe. `LongRunService` (`long-runs.ts`) implements it.
 */
export interface LongRunsShape {
    /** Each job's open or latest long run, by job id. */
    latestFor(jobIds: string[]): Promise<Map<string, LongRunView>>;
    /** After each batch of a long run that goes on (running or waiting). */
    onProgress(listener: (row: LongRunRow, view: LongRunView) => void): () => boolean;
    /** Once a long run has ended: done, failed or canceled. */
    onFinished(listener: (row: LongRunRow, view: LongRunView) => void): () => boolean;
}

export class LongRuns extends Context.Service<LongRuns, LongRunsShape>()('socio/schedules/LongRuns') {}

/**
 * The reports of long runs' ends (`LegacyLongRunReports`): a Dot's turn
 * in the conversation that started one, or a notification. Built today with
 * the composition's sources; `start` and `stop` in `module.ts` call these.
 * `LongRunReports` (`long-run-reports.ts`) implements it.
 */
export interface LongRunReportingShape {
    /** Reports the ends the last process didn't get to. */
    resume(): Promise<void>;
    /** Stops reporting and aborts the report turns under way. */
    stop(): void;
}

export class LongRunReporting extends Context.Service<LongRunReporting, LongRunReportingShape>()(
    'socio/schedules/LongRunReporting',
) {}

// ── Goals ────────────────────────────────────────────────────────────────

/** The goal a scheduled task serves (a turn's cause). */
export interface GoalOfTask {
    readonly id: string;
    readonly userId: string;
    readonly dotId: string;
}

/**
 * Goals, as `dots/` (the admins' Dots page), `issues/` and
 * `notifications/` (a turn's goal), `live/` (the Schedules page) and
 * `LeaderWork` (the startup reconcile) call them. `GoalService` (`goals.ts`)
 * implements it.
 */
export interface GoalsShape {
    /** The user's goals; with `dotId`, those given to that Dot. */
    list(userId: string, dotId?: string): Promise<GoalView[]>;
    /** A Dot's goals, everyone's, newest first. */
    forDot(dotId: string): Promise<GoalView[]>;
    /** When a Dot's newest goal was set. */
    lastDotGoalAt(dotId: string): Promise<number | null>;
    /** The goal whose schedule a task is, if any. */
    byTask(taskId: string): Promise<GoalOfTask | undefined>;
    /** One of the person's goals; with `dotId`, only that Dot's. */
    get(userId: string, id: string, dotId?: string): Promise<GoalView | undefined>;
    /** Cancels goal schedules left without their goal; how many. */
    reconcile(): Promise<number>;
}

export class Goals extends Context.Service<Goals, GoalsShape>()('socio/schedules/Goals') {}

// ── Ownership (CB-360) ───────────────────────────────────────────────────

/**
 * A person's schedules (scheduled tasks, saved jobs and goals), and
 * handing them to another person (CB-360's transfer).
 * `infra/sqlite/ownership.ts` implements it.
 */
export interface ScheduleOwnershipShape {
    owned(userId: string): OwnedList;
    /** The conversations their tasks and goals run in: they move with them. */
    threadsOf(userId: string): string[];
    /**
     * Every task, job and goal of `from`, deleted ones too, inside the
     * caller's transaction. A paused schedule stays paused; one paused
     * with `paused.reason` gets `paused.becomes` as its reason instead.
     */
    transfer(parties: TransferParties, paused?: { reason: string; becomes: string }): TransferTally;
}

// ── SchedulesConfig ──────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `schedules/` reads itself: the environment's
 * limits under the admin's overrides. `PlatformConfig` has each of them
 * with this type, so the composition root can provide the tag from it.
 *
 * Not here: `notificationLimits` (a long run's report), which
 * `notifications/`'s config tag carries.
 */
export interface SchedulesConfigShape {
    /** `SCHEDULE_MIN_INTERVAL_MINUTES`, `SCHEDULES_PER_USER`. */
    readonly schedules?: Partial<ScheduleSettings>;
    /** `JOB_*`, `JOBS_PER_USER`. */
    readonly jobs?: Partial<JobSettings>;
    /**
     * `DATA_API_URL` (`PlatformConfig.data`, which the data space's
     * `DataConfig` carries too): without it, a job's run gets no data token.
     */
    readonly data?: { readonly apiUrl?: string | undefined };
}

export class SchedulesConfig extends Context.Service<SchedulesConfig, SchedulesConfigShape>()(
    'socio/schedules/SchedulesConfig',
) {}

// ── Ports: what this folder asks of features above it ────────────────────

/**
 * The data space as a job's save, run and delete use it: the slice of
 * `dataspace/`'s `Data` they call, typed here because `dataspace/` sits
 * above this folder in the folder order (scripts/feature-ranks.json). The
 * composition provides it from `Data`, the same instance.
 */
export interface JobDataShape {
    /** The datasets a Dot sees: a job names them by id or name. */
    visible(
        actor: { kind: 'dot'; userId: string; dotId: string },
        createScratch?: boolean,
    ): readonly { readonly row: { readonly id: string; readonly name: string }; readonly scratch: boolean }[];
    /** Saves one of a job version's files. */
    putFile(
        actor: { kind: 'dot'; userId: string; dotId: string },
        rawPath: string,
        data: Uint8Array,
        mediaType?: string,
    ): Promise<unknown>;
    listFiles(actor: { kind: 'user'; userId: string }, prefix?: string): readonly { readonly path: string }[];
    getFile(actor: { kind: 'user'; userId: string }, rawPath: string): Promise<{ readonly data: Uint8Array }>;
    deleteFile(userId: string, rawPath: string, stamp?: { by?: string; with?: string }): Promise<void>;
    /** A run's data token, and its end with the run. */
    readonly tokens: {
        issue(scope: Omit<DataTokenScope, 'expiresAt'>, ttlMs?: number): string;
        revokeSession(session: string): void;
    };
}

export class JobData extends Context.Service<JobData, JobDataShape>()('socio/schedules/JobData') {}

/**
 * The Improvements board as a schedule's details read it: what its runs
 * did there, by cause, and the live issues' titles. The slice of
 * `issues/`'s `Board` they call, typed here because `issues/` sits above
 * this folder; the composition provides it from `Board`.
 */
export interface ScheduleBoardShape {
    readonly filings: {
        byCause(
            userId: string,
            causeIds: readonly string[],
            from: number,
            to: number,
        ): Promise<{ issueId: string; action: ScheduleRunBoardItem['action']; createdAt: number }[]>;
    };
    readonly issues: {
        titlesById(ids: readonly string[]): Promise<Map<string, IssueTitle>>;
    };
}

export class ScheduleBoard extends Context.Service<ScheduleBoard, ScheduleBoardShape>()(
    'socio/schedules/ScheduleBoard',
) {}
