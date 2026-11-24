/**
 * Schedules and jobs, as the app and the Dot tools show
 * them. A schedule runs a Dot turn or a job at a cadence; a job is code
 * (Bun or bash) stored in the user's data space and run in the Dot's
 * computer, without the model.
 */
import type { ApprovalPolicy } from './approvals.js';
import type { Status } from './types.js';

export const JOB_ENTRIES = ['main.ts', 'main.sh'] as const;
export type JobEntry = (typeof JOB_ENTRIES)[number];

export const JOB_RUN_STATUSES = [
    'queued',
    'starting',
    'running',
    'succeeded',
    'failed',
    'timed_out',
    'interrupted',
] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];
export type JobRunTrigger = 'manual' | 'dot' | 'schedule';

/**
 * A long run (CB-122): a job that runs until done, worked through in
 * batches (job runs) by the server until the job says it is complete.
 * `running`: a batch is queued or running; `waiting`: between batches
 * (chaining, a retry's wait, or a source's refusal); then `done`, `failed`
 * or `cancelled`.
 */
export const LONG_RUN_STATUSES = ['running', 'waiting', 'done', 'failed', 'cancelled'] as const;
export type LongRunStatus = (typeof LONG_RUN_STATUSES)[number];

/** An item set aside after its last try (the dead-letter list). */
export interface LongRunItemFailure {
    key: string;
    error: string | null;
    attempts: number;
    at: number;
}

/** A long run as the app and the `job_status` tool show it. */
export interface LongRunView {
    id: string;
    jobId: string;
    trigger: JobRunTrigger;
    scheduleId: string | null;
    status: LongRunStatus;
    /** The items the job declared, by state. `failed`: set aside. */
    items: {
        total: number;
        done: number;
        remaining: number;
        inProgress: number;
        failed: number;
    };
    /** Whether the job declared its whole list of items. */
    listComplete: boolean;
    batches: number;
    maxBatches: number;
    /** The batch in progress (a job run), if any. */
    currentRunId: string | null;
    /** The job's own checkpoint (its start, as text) and when it was saved. */
    checkpoint: string | null;
    checkpointAt: number | null;
    /** Batches in a row that failed, made no progress or were refused. */
    retries: number;
    maxRetries: number;
    /** When the next batch may start, while waiting. */
    nextAt: number | null;
    waitReason: string | null;
    lastError: string | null;
    /** Items set aside, newest first (at most `LONG_RUN_DEAD_SHOWN`). */
    deadLetters: LongRunItemFailure[];
    /** The final summary, once it ended. */
    outcome: string | null;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
}

/** Set-aside items a long run's view lists. */
export const LONG_RUN_DEAD_SHOWN = 20;

/** The latest run of a schedule (its turn, or the job run it started). */
export interface ScheduleLastRun {
    status: string;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
}

export interface ScheduleView {
    id: string;
    title: string;
    /** The turn's prompt; for jobs, what runs. */
    prompt: string;
    kind: 'turn' | 'job';
    /** Normalized (`every day at 09:00`), or a repeat interval for older tasks. */
    cadence: string | null;
    timezone: string | null;
    intervalSeconds: number | null;
    status: Status;
    /** `dot`: proposed by a Dot and approved; `user`: made in the app. */
    origin: 'dot' | 'user';
    dotId: string | null;
    dotName: string | null;
    jobId: string | null;
    jobName: string | null;
    /** The conversation its turns run in. */
    threadId: string | null;
    nextRunAt: number | null;
    lastRun: ScheduleLastRun | null;
    error: string | null;
    createdAt: number;
}

/** `paused` and an outside `cancelled` come from the goal's schedule. */
export type GoalStatus = 'active' | 'paused' | 'done' | 'cancelled';

/** A comment on a goal: context, progress or a changed requirement. */
export interface GoalComment {
    id: string;
    /** The person the goal is for, or the Dot it was given to. */
    author: 'person' | 'dot';
    body: string;
    createdAt: number;
}

/** The longest comment, and the most comments one goal keeps. */
export const GOAL_COMMENT_MAX = 1000;
export const GOAL_COMMENTS_MAX = 50;

/** A person's goal for a Dot, worked on by a schedule of its own. */
export interface GoalView {
    /** `G-` and 8 hex digits. */
    id: string;
    /** The person the goal is for. */
    userId: string;
    dotId: string;
    title: string;
    detail: string;
    status: GoalStatus;
    /** The Dot's latest progress note. */
    progress: string | null;
    /** The goal's comments, oldest first (all of them: at most GOAL_COMMENTS_MAX). */
    comments: GoalComment[];
    scheduleId: string;
    /** The conversation its turns run in, the person's. */
    threadId: string | null;
    cadence: string | null;
    nextRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
}

export interface JobFileView {
    path: string;
    size: number;
}

export interface JobRunView {
    id: string;
    jobId: string;
    version: number;
    trigger: JobRunTrigger;
    scheduleId: string | null;
    status: JobRunStatus;
    queuedAt: number;
    startedAt: number | null;
    /** How long waking the computer took (part of the timeout). */
    wakeMs: number | null;
    finishedAt: number | null;
    exitCode: number | null;
    error: string | null;
    /** The long run this run is a batch of (CB-122). */
    longRunId: string | null;
    /** The last part of each stream, secrets redacted (job_logs, the detail). */
    stdout?: string;
    stderr?: string;
    /**
     * Set instead of stdout and stderr on a run past the newest `keepRuns` of
     * its job: the run is kept, its output isn't (`JOB_OUTPUT_NOT_KEPT`).
     */
    outputNotKept?: string;
}

/** What a run past the newest `keepRuns` of its job shows for its output. */
export const JOB_OUTPUT_NOT_KEPT = 'Output not kept for older runs.';

export interface JobView {
    id: string;
    name: string;
    dotId: string;
    dotName: string | null;
    entry: JobEntry;
    version: number;
    timeoutSeconds: number;
    /** Dataset ids its runs' data token may use, besides the Dot's scratch. */
    datasets: string[];
    files: JobFileView[];
    /** Runs in batches until the job says it is complete (CB-122). */
    untilDone: boolean;
    createdAt: number;
    updatedAt: number;
    lastRun: JobRunView | null;
    /** Its open or latest long run, where the app lists jobs. */
    longRun?: LongRunView | null;
}

export interface JobVersionView {
    version: number;
    entry: JobEntry;
    files: JobFileView[];
    timeoutSeconds: number;
    datasets: string[];
    untilDone: boolean;
    createdAt: number;
}

/**
 * Whether a job version's saved code is in the data space (CB-336):
 * `stored`; `missing` (some files never got there, e.g. a storage outage
 * as it was saved); `unreadable` (listed, but storage didn't return it);
 * `changed` (its files no longer match what was approved).
 */
export type JobCodeState = 'stored' | 'missing' | 'unreadable' | 'changed';

export interface JobCodeView {
    state: JobCodeState;
    /** The version's files not in the data space. */
    missing: string[];
    /** Why it couldn't be read, when unreadable or changed. */
    error: string | null;
}

export interface JobDetail {
    job: JobView;
    /**
     * Whether the current version's files are in the data space, from their
     * records only (no read): `stored` or `missing` (CB-336).
     */
    code: JobCodeView;
    /** Its open or latest long run (a job that runs until done). */
    longRun?: LongRunView | null;
    versions: JobVersionView[];
    /** The latest runs (`JOB_RUNS_PAGE`), newest first. */
    runs: JobRunView[];
    /** Whether older runs are there (`GET /api/schedules/jobs/:id/runs`). */
    moreRuns: boolean;
}

/** A page of a job's runs, older than a given run. */
export interface JobRunsPage {
    runs: JobRunView[];
    more: boolean;
}

/** Runs per page of a job's detail. Every run is kept. */
export const JOB_RUNS_PAGE = 20;

export interface SchedulesLimits {
    minIntervalMinutes: number;
    maxActiveSchedules: number;
    maxJobTimeoutSeconds: number;
    jobConcurrency: number;
    maxJobs: number;
}

/** `GET /api/schedules`: the user's own; operators also get counts. */
export interface SchedulesState {
    schedules: ScheduleView[];
    /** The person's goals, newest first; each has a schedule above. */
    goals: GoalView[];
    jobs: JobView[];
    limits: SchedulesLimits;
    usage: { activeSchedules: number; jobs: number };
    /** Operators: everyone's, as counts only (no titles, prompts or code). */
    counts?: {
        schedules: Record<string, number>;
        jobs: number;
        jobRuns: Record<string, number>;
        runningJobs: number;
    };
}

/** Something a schedule's run did on the Improvements board. */
export interface ScheduleRunBoardItem {
    /** `CB-12`. */
    issue: string;
    title: string;
    action: 'create' | 'comment' | 'vote' | 'unvote' | 'update';
}

/**
 * One run of a schedule on its details page (CB-88): the task's run (a
 * Dot turn) or, for a job schedule, the job's run.
 */
export interface ScheduleRunView {
    id: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    /** The start of what it answered (a turn) or how it ended (a job), as plain text. */
    summary: string | null;
    error: string | null;
    /** The turn in the schedule's chat (`/chats/<id>#message-<id>`), if kept. */
    turnPath: string | null;
    /** What the turn filed, commented on or voted for on the board. */
    board: ScheduleRunBoardItem[];
}

/** A page of a schedule's runs, older than a given run. */
export interface ScheduleRunsPage {
    runs: ScheduleRunView[];
    more: boolean;
}

/** Runs per page of a schedule's details. */
export const SCHEDULE_RUNS_PAGE = 10;

/** `GET /api/schedules/:id`: one of the person's schedules, in full (CB-88). */
export interface ScheduleDetail {
    schedule: ScheduleView;
    /** The cadence in words (`Every weekday at 09:00`); null without one. */
    cadenceText: string | null;
    /** The next runs, soonest first (none while paused or done). */
    upcoming: number[];
    /**
     * The Dot's approval policies for this person that aren't Manual: what
     * its runs may do without asking. Everything else asks first.
     */
    approvals: Array<{
        capability: string;
        label: string;
        policy: ApprovalPolicy;
    }>;
    /** The goal this schedule works on, if it is a goal's. */
    goal: GoalView | null;
    /** The latest runs (`SCHEDULE_RUNS_PAGE`), newest first. */
    runs: ScheduleRunView[];
    /** Whether older runs are there (`GET /api/schedules/:id/runs`). */
    moreRuns: boolean;
}
