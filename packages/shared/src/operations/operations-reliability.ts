import type { FailureCategory } from '../failure-taxonomy.js';

import type { OpsStatus, OpsWindow } from './operations.js';

/**
 * Operations → Reliability (CB-164, CB-189): what fails and why, by
 * the failure taxonomy. A failure is a turn or tool call whose category
 * is anything but Stopped; a turn's rate is over every turn that started
 * in the window. Interrupted turns (the server stopped mid-turn) are
 * Runtime errors, also counted on their own.
 */

/** One category's count in the window: failed turns and failed tool calls. */
export interface OpsCategoryCount {
    category: FailureCategory;
    turns: number;
    tools: number;
}

/** The section's totals; every value null while the store has no data. */
export interface OpsReliabilitySummary {
    turns: number | null;
    failures: number | null;
    previousTurns: number | null;
    previousFailures: number | null;
    /** Stopped by a person or an operator: not failures. */
    stopped: number | null;
    /** Of the failures, turns the server stopped mid-turn. */
    interrupted: number | null;
    /** Requests sent again after the model turned them away (CB-140). */
    retries: number | null;
    retriedTurns: number | null;
    /** Turns that moved to the shared model. */
    fallbacks: number | null;
    toolCalls: number | null;
    toolFailures: number | null;
    /** Every category, in `FAILURE_CATEGORIES` order; empty with no data. */
    categories: OpsCategoryCount[];
}

/**
 * One bucket: its turns, their failures, and the failures per category
 * in `FAILURE_CATEGORIES` order (turns only).
 */
export interface OpsFailurePoint {
    at: number;
    turns: number;
    failures: number;
    counts: number[];
}

/** What a breakdown groups failures by. */
export const RELIABILITY_DIMENSIONS = ['tool', 'code', 'socio', 'model', 'source'] as const;
export type ReliabilityDimension = (typeof RELIABILITY_DIMENSIONS)[number];

/**
 * One row of a breakdown. For tools, `total` is calls and the latencies
 * are the calls'; for a code, `total` is the failed turns with it;
 * otherwise turns, with the finished turns' durations.
 */
export interface OpsBreakdownRow {
    /** The tool, code, socio id, model or source; '' when none was recorded. */
    key: string;
    /** A socio's name; null where the key is what to show. */
    label: string | null;
    total: number;
    failed: number;
    /** The failures' most frequent category and code. */
    category: FailureCategory | null;
    code: string | null;
    p50Ms: number | null;
    p95Ms: number | null;
}
/** The most rows a breakdown returns. */
export const BREAKDOWN_LIMIT = 15;

/**
 * A turn with a failure, newest first: the turn's own (`level: 'turn'`),
 * or else its first failed tool call's.
 */
export interface OpsFailureRow {
    runId: string;
    threadId: string;
    socioId: string;
    socioName: string | null;
    source: string;
    status: 'running' | 'finished' | 'stopped' | 'failed' | 'interrupted';
    startedAt: number;
    finishedAt: number | null;
    level: 'turn' | 'tool';
    category: FailureCategory;
    rule: string;
    code: string | null;
    endReason: string | null;
    model: string | null;
    /** The first tool call that failed, if one did. */
    tool: string | null;
    toolFailures: number;
}

/** What the failures list can narrow to, besides the range and filters. */
export interface OpsFailureFilter {
    category?: FailureCategory;
    tool?: string;
}

/**
 * Recurring friction (CB-164): the same category, code and tool
 * failing for 3 or more people, or 5 or more times for one person, in
 * the 7 days up to the window's end. Turn failures have no tool.
 */
export interface OpsFrictionRow {
    category: FailureCategory;
    code: string | null;
    tool: string | null;
    people: number;
    failures: number;
    /** The most times it failed for one person. */
    mostForOne: number;
    lastAt: number;
}
export const FRICTION_PEOPLE = 3;
export const FRICTION_TIMES = 5;
export const FRICTION_DAYS = 7;
export const FRICTION_LIMIT = 20;
/** Where recurring friction's 7 days start, in a window. */
export const frictionFrom = (window: Pick<OpsWindow, 'from' | 'to'>) =>
    Math.max(window.from ?? 0, window.to - FRICTION_DAYS * 86_400_000);

export interface OpsFriction {
    /** Where its 7 days start. */
    from: number;
    rows: OpsFrictionRow[];
}

/**
 * The Improvements board: items filed and closed in the window, how long
 * the closed ones took, and what was open at its end. The person filter
 * is who reported them; the board has no socio, Space or source.
 */
export interface OpsIssueVelocity {
    reported: number | null;
    resolved: number | null;
    previousReported: number | null;
    previousResolved: number | null;
    /** Of those reported, bugs. */
    bugsReported: number | null;
    /** Open at the window's end. */
    open: number | null;
    /** Filed to closed, for the items closed in the window. */
    medianResolveMs: number | null;
    p90ResolveMs: number | null;
    /**
     * Failed turns filed about from Runs in the window ("File issue", CB-194),
     * and the time from each failure to its report.
     */
    failuresReported: number | null;
    medianReportMs: number | null;
    p90ReportMs: number | null;
    points: { at: number; reported: number; resolved: number }[];
}

/** `GET /api/operations/reliability`. */
export interface OpsReliability {
    status: OpsStatus;
    window: OpsWindow;
    summary: OpsReliabilitySummary;
}
/** `GET /api/operations/reliability/series`. */
export interface OpsReliabilitySeries {
    status: OpsStatus;
    window: OpsWindow;
    points: OpsFailurePoint[];
}
/** `GET /api/operations/reliability/breakdown/:by`. */
export interface OpsReliabilityBreakdown {
    status: OpsStatus;
    window: OpsWindow;
    by: ReliabilityDimension;
    rows: OpsBreakdownRow[];
}
/** `GET /api/operations/reliability/friction`. */
export interface OpsReliabilityFriction extends OpsFriction {
    status: OpsStatus;
    window: OpsWindow;
}
/** `GET /api/operations/reliability/issues`. */
export interface OpsReliabilityIssues {
    status: OpsStatus;
    window: OpsWindow;
    issues: OpsIssueVelocity;
}

/** The totals while the store has no data: nulls, never zeros. */
export const noReliability = (): OpsReliabilitySummary => ({
    turns: null,
    failures: null,
    previousTurns: null,
    previousFailures: null,
    stopped: null,
    interrupted: null,
    retries: null,
    retriedTurns: null,
    fallbacks: null,
    toolCalls: null,
    toolFailures: null,
    categories: [],
});
export const noIssueVelocity = (): OpsIssueVelocity => ({
    reported: null,
    resolved: null,
    previousReported: null,
    previousResolved: null,
    bugsReported: null,
    open: null,
    medianResolveMs: null,
    p90ResolveMs: null,
    failuresReported: null,
    medianReportMs: null,
    p90ReportMs: null,
    points: [],
});

/**
 * The nearest-rank percentile of sorted values (DuckDB's
 * `quantile_disc`): the value at rank ceil(q × n); null when empty.
 */
export function percentile(sorted: readonly number[], q: number) {
    if (!sorted.length) {
        return null;
    }
    return sorted[Math.max(1, Math.ceil(sorted.length * q)) - 1]!;
}
