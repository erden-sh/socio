import type { AppsHealthSummary } from '../apps/app-types.js';
import type { DeploymentHealth } from '../deployment-resources.js';
/**
 * Operations → Health (CB-192): models, queues, schedules, goals, long
 * runs, backups and how fresh the dashboard's own numbers are. What the
 * server's health queries answer and the Health page shows.
 */
import type { BackupStatus } from '../types.js';

import type { AnalyticsHealth } from './operations-analytics.js';
import type { OpsAnswer } from './operations.js';

/** A run that starts this much after it came due is late. */
export const SCHEDULE_LATE_MS = 5 * 60_000;
/** A goal with no change for this long is stalled (CB-164). */
export const GOAL_STALL_MS = 14 * 86_400_000;
/** The most rows each breakdown lists; the rest are left out. */
export const HEALTH_TOP = 12;

/**
 * Reasoning kinds as the facts keep them (CB-185). `unknown`: the turn
 * didn't record one (turns from before). Reasoning tokens are only added
 * up within one kind, and only where the model reported them apart.
 */
export const HEALTH_REASONING_KINDS = ['summary', 'raw', 'hidden', 'none', 'mixed', 'unknown'] as const;
export type HealthReasoningKind = (typeof HEALTH_REASONING_KINDS)[number];

/**
 * A schedule's state now, worst first: `failing` (its last run failed),
 * `paused`, `overdue` (its next time passed over `SCHEDULE_LATE_MS` ago
 * without a run), `ok`; `stopped` ones (canceled, or a one-off that is
 * done) aren't health concerns.
 */
export const SCHEDULE_STATES = ['failing', 'paused', 'overdue', 'ok', 'stopped'] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/** A schedule's state from its row (`tasks`) at `now`. */
export function scheduleState(
    task: {
        status: string;
        nextRunAt: number | null;
        error: string | null;
    },
    now: number,
): ScheduleState {
    if (task.status === 'cancelled') {
        return 'stopped';
    }
    if (task.status === 'failed' || (task.error && task.status !== 'paused')) {
        return 'failing';
    }
    if (task.status === 'paused') {
        return 'paused';
    }
    if (task.nextRunAt !== null && task.nextRunAt < now - SCHEDULE_LATE_MS) {
        return 'overdue';
    }
    if (task.status === 'completed' && task.nextRunAt === null) {
        return 'stopped';
    }
    return 'ok';
}

/**
 * A goal's state now: `done`, `cancelled`, `stalled` (active, while its
 * schedule fails or is paused, or with no change for `GOAL_STALL_MS`), or
 * `active`.
 */
export const GOAL_STATES = ['stalled', 'active', 'done', 'cancelled'] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export function goalState(
    goal: { status: string; updatedAt: number },
    schedule: ScheduleState | undefined,
    now: number,
): GoalState {
    if (goal.status === 'done') {
        return 'done';
    }
    if (goal.status === 'cancelled') {
        return 'cancelled';
    }
    if (schedule === 'failing' || schedule === 'paused' || now - goal.updatedAt >= GOAL_STALL_MS) {
        return 'stalled';
    }
    return 'active';
}

/** The middle and the slow end of some durations (ms); null with none. */
export interface Spread {
    n: number;
    p50: number | null;
    p95: number | null;
}

/** One row of a breakdown: tokens by model, socio or person. */
export interface TokenRow {
    key: string;
    /** A socio's or person's name; null for a model, or one gone. */
    name: string | null;
    turns: number;
    input: number;
    output: number;
    cached: number;
}

/** Tokens by reasoning kind: reasoning tokens only where reported. */
export interface ReasoningRow {
    kind: HealthReasoningKind;
    turns: number;
    output: number;
    /** Turns whose model reported reasoning tokens apart. */
    reportedTurns: number;
    /** Their reasoning tokens; null when none reported. */
    reasoning: number | null;
}

/** Time to first output (model) or a tool's duration, by name. */
export interface LatencyRow extends Spread {
    key: string;
    /** Tool calls that failed or timed out (tools only). */
    errors: number;
}

/**
 * How much of the window's data records a signal (CB-185, CB-187):
 * turns from before a signal existed don't have it, so its numbers cover
 * only `covered` of `total`.
 */
export const HEALTH_COVERAGE = [
    'trace',
    'firstOutput',
    'reasoningKind',
    'reasoningTokens',
    'receivedAt',
    'trigger',
    'dueAt',
] as const;
export type HealthCoverageId = (typeof HEALTH_COVERAGE)[number];
export interface CoverageRow {
    id: HealthCoverageId;
    covered: number;
    total: number;
}

/** What the analytics store answers for Health (`OPS_QUERIES.health`). */
export interface HealthFacts {
    tokens: {
        byModel: TokenRow[];
        bySocio: TokenRow[];
        byPerson: TokenRow[];
        byReasoning: ReasoningRow[];
    };
    latency: {
        /** Each model round's time to its first output. */
        firstOutput: Spread;
        firstOutputByModel: LatencyRow[];
        tools: Spread;
        byTool: LatencyRow[];
    };
    queues: {
        /** A turn's start after its message came in (CB-185). */
        turns: Spread;
        /** A job run's start after it was queued. */
        jobWait: Spread;
        /** A job's computer waking for its run. */
        jobWake: Spread;
        /** A scheduled run's start after it came due. */
        scheduleLate: Spread;
    };
    /** Now, from the store's last copy; schedules in each state. */
    schedules: Record<ScheduleState, number> & {
        /** Scheduled runs in the window, failed and late ones. */
        runs: number;
        failedRuns: number;
        lateRuns: number;
    };
    goals: Record<GoalState, number> & {
        /** Done and canceled in the window. */
        doneInRange: number;
        cancelledInRange: number;
    };
    longRuns: {
        running: number;
        waiting: number;
        /** Items set aside after their last try, in open long runs. */
        deadItems: number;
        /** Finished in the window. */
        done: number;
        failed: number;
        cancelled: number;
    };
    jobRuns: { total: number; failed: number };
    coverage: CoverageRow[];
    /** Every ETL source and when it last ran (ms). */
    sources: { source: string; at: number }[];
}

/** What the app knows live, beside the store's numbers. */
export interface HealthLive {
    analytics: AnalyticsHealth | null;
    /** A source not run for this long is stale (ms). */
    staleAfterMs: number;
    /** Backups, the continuous copy and the restore drill; null when not set up. */
    backup: BackupStatus | null;
    /** The deployment's resource numbers (CB-321): whether they can be shown. */
    deployment?: DeploymentHealth;
    /** Mini apps' self-healing (CB-291); missing where mini apps are off. */
    apps?: AppsHealthSummary;
}

export interface OpsHealth extends OpsAnswer {
    /** Null values when the store has no data yet (never zeros). */
    facts: HealthFacts | null;
    live: HealthLive;
}

/** Health's charts: p95 per bucket. */
export const HEALTH_METRICS = ['first_output', 'tool_duration', 'turn_queue', 'job_wait', 'schedule_late'] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];
export const HEALTH_METRIC_LABELS: Record<HealthMetric, string> = {
    first_output: 'Model time to first output',
    tool_duration: 'Tool call time',
    turn_queue: 'Turn queue time',
    job_wait: 'Job queue wait',
    schedule_late: 'Schedule lateness',
};

/** One bucket of a health chart: the p95 of what started in it, if any. */
export interface HealthPoint {
    at: number;
    n: number;
    p95: number | null;
}
export interface OpsHealthSeries extends OpsAnswer {
    metric: HealthMetric;
    points: HealthPoint[];
}

/** A schedule that needs a look (not `ok` or `stopped`). */
export interface HealthScheduleRow {
    id: string;
    title: string | null;
    socioId: string | null;
    socioName: string | null;
    personId: string | null;
    state: ScheduleState;
    status: string;
    cadence: string | null;
    nextRunAt: number | null;
    lastRunAt: number | null;
    updatedAt: number;
    /** Its last error, short. */
    error: string | null;
}

/** A scheduled run in the window that failed or started late. */
export interface HealthRunRow {
    id: string;
    taskId: string;
    title: string | null;
    socioId: string | null;
    socioName: string | null;
    status: string;
    dueAt: number | null;
    startedAt: number;
    finishedAt: number | null;
    /** How late it started (ms), when its due time is known. */
    lateMs: number | null;
}

/** A long run (CB-122): a job that runs until done. */
export interface HealthLongRunRow {
    id: string;
    jobId: string;
    jobName: string | null;
    socioId: string | null;
    socioName: string | null;
    personId: string | null;
    status: string;
    batches: number;
    retries: number;
    itemsDone: number;
    itemsDead: number;
    itemsPending: number;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
    waitReason: string | null;
    lastError: string | null;
}
