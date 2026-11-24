import { REACTIONS, REACTION_EMOJI, REACTION_LABELS } from '@socio/shared/chat/reactions';
import { dateTimeFormat, formatNumber } from '@socio/shared/locale';
import type { LoopEndReason } from '@socio/shared/loop-end';
import {
    cachedPercent,
    LOOP_END_LABELS,
    loopRound,
    type RunTrace,
    type RunTraceSummary,
    type RunTraceView,
    type TraceRound,
    type TraceTool,
} from '@socio/shared/runs/run-trace';
import { toolLabel } from '@socio/shared/runs/tool-labels';
import { formatTokens } from '@socio/shared/token-count';
import type { AgentRunStatus, AgentRunSummary } from '@socio/shared/types';

import { runSection, type RunSection, type TraceIcon } from '../chat/turn-trace';
import type { BoundedItemState } from '../sync/bounded-kind';

import { detailAge } from './schedules';

// Runs, the web's RunsView
// and RunTimeline on a phone, with no React Native: tests/shell runs them
// under Node.
// - The list is the `runs` kind (the server's latest 200: a member's own
//   turns, everyone's for an admin), newest first, with the
//   web's status filter applied to what the phone holds. It never asks for a
//   trace.
// - A run's page shows the row's facts and, once the person tapped it open,
//   its trace from the `run-traces` bounded kind: the turn's steps in the
//   chat trace's words (shared's tool labels), and with Advanced mode on the
//   web's rounds, raw codes and the trace sheet's run detail (`runSection`).
//   The steps are worked out once per trace answer (`runTimeline`'s memo),
//   since a poll or the Advanced switch re-renders the page with the same
//   answer.
// Never "Dot" in copy: the person's agents are socios.

export const RUNS_TITLE = 'Runs';
export const RUNS_INTRO_ADMIN =
    'Recent turns across the team, newest first. Failed turns show their error; open one to see its trace.';
export const RUNS_INTRO_MEMBER =
    'Your recent turns with socios, newest first. Open a turn to see each step it took, how long it took and why it ended.';
export const TRACE_MISSING = 'This turn’s trace isn’t available to you.';
export const TRACE_OLD = 'No trace: this turn ran before traces were recorded.';
export const TRACE_OFFLINE = 'The trace shows once you’re online.';
export const TRACE_NONE = 'This turn has no trace to show.';

export const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
    running: 'Running',
    finished: 'Finished',
    stopped: 'Stopped',
    failed: 'Failed',
    interrupted: 'Interrupted',
};

/** The dot's tone beside each status word (the word always shows). */
export type RunTone = 'running' | 'ok' | 'muted' | 'bad';
const STATUS_TONE: Record<AgentRunStatus, RunTone> = {
    running: 'running',
    finished: 'ok',
    stopped: 'muted',
    failed: 'bad',
    interrupted: 'bad',
};

const SOURCE_LABEL: Record<string, string> = {
    web: 'Web',
    telegram: 'Telegram',
    scheduled: 'Scheduled task',
    voice: 'Voice call',
};

/** The web's status filter, in its order; '' is all turns. */
export type RunFilter = AgentRunStatus | '';
export const RUN_FILTERS: readonly { readonly value: RunFilter; readonly label: string }[] = [
    { value: '', label: 'All turns' },
    { value: 'failed', label: 'Failed only' },
    { value: 'interrupted', label: 'Interrupted' },
    { value: 'stopped', label: 'Stopped' },
    { value: 'running', label: 'Running' },
    { value: 'finished', label: 'Finished' },
];

/** How many runs the server lists at most (run-routes.ts's RUN_LIMIT). */
export const RUN_LIMIT = 200;

/** A turn's or a step's duration, the web's Runs format: "820 ms", "1.5 s", "2m 05s". */
export function runDuration(ms: number): string {
    const value = Math.max(0, ms);
    if (value < 1000) {
        return `${value} ms`;
    }
    if (value < 60_000) {
        return `${(value / 1000).toFixed(1)} s`;
    }
    const seconds = Math.round(value / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const THIS_YEAR = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;
const OTHER_YEAR = { year: 'numeric', ...THIS_YEAR } as const;

/** When a run started, the web's `formatRunTime`: "Oct 31, 1:53 PM", the year only when it isn't this one. */
export function runTime(at: number, now: number, timeZone?: string): string {
    const zone = timeZone === undefined ? {} : { timeZone };
    const year = (ms: number) => dateTimeFormat({ year: 'numeric', ...zone }).format(ms);
    return dateTimeFormat({ ...(year(at) === year(now) ? THIS_YEAR : OTHER_YEAR), ...zone }).format(at);
}

const TROUBLE = new Set<LoopEndReason>([
    'round_cap',
    'time_limit',
    'cycle_limit',
    'output_limit',
    'error',
    'model_unavailable',
    'interrupted',
]);

/** "12.4k in · 80% cached · 820 out", for what the model reported. */
function tokenText(counts: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
}): string {
    const cached = cachedPercent(counts);
    return [
        counts.inputTokens !== undefined && `${formatTokens(counts.inputTokens)} in`,
        cached !== undefined && `${cached}% cached`,
        counts.outputTokens !== undefined && `${formatTokens(counts.outputTokens)} out`,
        counts.reasoningTokens !== undefined && `${formatTokens(counts.reasoningTokens)} reasoning`,
    ]
        .filter(Boolean)
        .join(' · ');
}

/** The row's trace line, the web's TraceSummaryLine: "Completed · 3 rounds · 12.4k in · 820 out". */
export function traceSummaryLine(summary: RunTraceSummary): { readonly text: string; readonly trouble: boolean } {
    const tokens = tokenText(summary);
    return {
        text: [
            LOOP_END_LABELS[summary.reason] ?? summary.reason,
            summary.rounds === 1 ? '1 round' : `${summary.rounds} rounds`,
            ...(tokens ? [tokens] : []),
        ].join(' · '),
        trouble: TROUBLE.has(summary.reason),
    };
}

/** A turn with a trace to open: one that runs, or ended since traces, that the person may open (the web's `traceable`). */
export const traceable = (run: Pick<AgentRunSummary, 'canTrace' | 'trace' | 'status'>): boolean =>
    run.canTrace !== false && (!!run.trace || run.status === 'running');

export interface RunRow {
    readonly id: string;
    readonly testID: string;
    readonly title: string;
    readonly status: string;
    readonly tone: RunTone;
    /** "Sebas · Ada · Web · Oct 31, 1:53 PM · 1.5 s": the socio, the owner (admins), the source, when and how long. */
    readonly meta: string;
    readonly error: string | null;
    readonly errorDetail: string | null;
    readonly trace: { readonly text: string; readonly trouble: boolean } | null;
    readonly traceable: boolean;
    /** A failed run offers "File issue" (the web's FileIssueFromRun), linked to it. */
    readonly fileIssue: boolean;
    readonly accessibilityLabel: string;
}

/** The run's facts as one row: the list's, and its page's head. */
export function runRow(run: AgentRunSummary, admin: boolean, now: number, timeZone?: string): RunRow {
    const title = run.title ?? (run.readable ? 'Untitled conversation' : 'Deleted conversation');
    const status = RUN_STATUS_LABEL[run.status] ?? run.status;
    const owner = admin ? `${run.ownerName ?? run.ownerId ?? 'unknown'}${run.room ? ' · room' : ''}` : null;
    const meta = [
        run.dotName,
        owner,
        SOURCE_LABEL[run.source] ?? run.source,
        runTime(run.startedAt, now, timeZone),
        run.finishedAt === null ? '…' : runDuration(run.finishedAt - run.startedAt),
    ]
        .filter((part): part is string => !!part)
        .join(' · ');
    return {
        id: run.runId,
        testID: `run-${run.runId}`,
        title,
        status,
        tone: STATUS_TONE[run.status] ?? 'muted',
        meta,
        error: run.error,
        errorDetail: run.errorDetail,
        trace: run.trace ? traceSummaryLine(run.trace) : null,
        traceable: traceable(run),
        fileIssue: run.status === 'failed',
        accessibilityLabel: `${title}, ${status}${run.error ? `, ${run.error}` : ''}`,
    };
}

/** The list: newest first, by the filter, as rows. */
export function runRows(
    runs: readonly AgentRunSummary[],
    filter: RunFilter,
    admin: boolean,
    now: number,
    timeZone?: string,
): RunRow[] {
    return runs
        .filter((run) => filter === '' || run.status === filter)
        .sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? -1 : 1))
        .map((run) => runRow(run, admin, now, timeZone));
}

/** What an empty list says: loading, none, or none of the filter's (the web's words). */
export const runsEmpty = (filter: RunFilter, loaded: boolean): string =>
    !loaded ? 'Loading…' : filter ? `No ${filter} turns.` : 'No turns yet.';

/**
 * "Showing the latest 200." once the server's list is full; with a status
 * filter, "Among the latest 200.": the filter looks only at what the phone
 * holds (the web asks the server with ?status=).
 */
export const runsLimitLine = (held: number, filter: RunFilter = ''): string | null =>
    held < RUN_LIMIT ? null : filter ? `Among the latest ${RUN_LIMIT}.` : `Showing the latest ${RUN_LIMIT}.`;

// ---- A run's trace ----------------------------------------------------------------

/** One step of the timeline. */
export interface TimelineStep {
    readonly id: string;
    readonly icon:
        | TraceIcon
        | 'hourglass'
        | 'user-round'
        | 'rotate-cw'
        | 'arrow-left-right'
        | 'archive'
        | 'notebook-pen'
        | 'message-square-more'
        | 'circle-dot';
    /** The step in words: "Searched the web", "Round 2", "Waiting for approval". */
    readonly verb: string;
    readonly detail?: string;
    /** How it ended when not plainly ("error · http_400", "refused"), else none. */
    readonly outcome?: string;
    readonly tone: 'default' | 'muted' | 'bad';
    readonly duration?: string;
    /** With Advanced mode on, a tool's own name and call id. */
    readonly tool?: string;
    readonly callId?: string;
}

export interface RunTimeline {
    /** "Completed", "Hit the round cap", "Running". */
    readonly end: string;
    readonly trouble: boolean;
    /** "3 rounds of 25 at most · 12.4k in · 820 out · 4.2 s · Claude · claude-x". */
    readonly meta: string;
    readonly steps: readonly TimelineStep[];
    /** "4 more steps were left out." */
    readonly dropped: string | null;
    /** With Advanced mode on: the trace sheet's run detail (ids, model, tokens, rounds). */
    readonly advanced: RunSection | null;
}

const OUTCOME_WORDS: Record<TraceTool['outcome'], string> = {
    ok: 'ok',
    error: 'error',
    refused: 'refused',
    timeout: 'timed out',
};
const STOP_WORDS: Record<TraceRound['stop'], string> = {
    stop: 'answered',
    tool_calls: 'called tools',
    length: 'output limit',
    content_filter: 'content filter',
    error: 'error',
    cancelled: 'cancelled',
};

const BUSY_WORDS: Record<NonNullable<RunTrace['fallback']>['reason'], string> = {
    rate_limited: 'was busy',
    unavailable: 'was out of reach',
    usage_limit: 'hit its usage limit',
};

interface Timed {
    readonly at: number;
    readonly order: number;
    readonly step: TimelineStep;
}

function toolStep(tool: TraceTool, index: number, advanced: boolean): TimelineStep {
    const label = toolLabel(tool.name, {}, {}, true);
    const failed = tool.outcome === 'error' || tool.outcome === 'timeout';
    const outcome =
        tool.outcome === 'ok'
            ? undefined
            : advanced
              ? [OUTCOME_WORDS[tool.outcome], tool.error].filter(Boolean).join(' · ')
              : OUTCOME_WORDS[tool.outcome];
    return {
        id: `tool:${tool.callId ?? index}:${tool.startedAt}`,
        icon: label.icon,
        verb: label.verb,
        ...(outcome === undefined ? {} : { outcome }),
        tone: failed ? 'bad' : tool.outcome === 'refused' ? 'muted' : 'default',
        duration: runDuration(tool.endedAt - tool.startedAt),
        ...(advanced ? { tool: tool.name, ...(tool.callId ? { callId: tool.callId } : {}) } : {}),
    };
}

function roundStep(round: TraceRound): TimelineStep {
    const verb = round.summary
        ? `Notes for round ${round.round}`
        : round.retry
          ? `Round ${round.round}, retry ${round.retry}`
          : `Round ${round.round}`;
    const meta = [
        STOP_WORDS[round.stop],
        round.error,
        tokenText(round) || undefined,
        round.firstOutputMs === undefined ? undefined : `first output ${runDuration(round.firstOutputMs)}`,
    ].filter(Boolean);
    const bad = round.stop === 'error' || round.stop === 'length' || round.stop === 'content_filter';
    return {
        id: `round:${round.round}:${round.startedAt}:${round.retry ?? (round.summary ? 'notes' : '')}`,
        icon: 'circle-dot',
        verb,
        outcome: meta.join(' · '),
        tone: bad ? 'bad' : 'muted',
        duration: runDuration(round.endedAt - round.startedAt),
    };
}

/** The trace's steps in the order they happened (the web's `steps`), the rounds and bookkeeping only with Advanced on. */
function timelineSteps(trace: RunTrace, advanced: boolean): TimelineStep[] {
    const timed: Timed[] = [];
    const add = (at: number, order: number, step: TimelineStep) => timed.push({ at, order, step });
    if (advanced && trace.reactions) {
        const counts = REACTIONS.filter((kind) => trace.reactions!.counts[kind])
            .map(
                (kind) =>
                    `${REACTION_EMOJI[kind]} ${REACTION_LABELS[kind].toLowerCase()} ${trace.reactions!.counts[kind]}`,
            )
            .join(' · ');
        add(trace.reactions.at, 0, {
            id: `reactions:${trace.reactions.at}`,
            icon: 'message-square-more',
            verb: 'Told of reactions',
            detail: counts,
            tone: 'muted',
        });
    }
    for (const retry of trace.retries ?? []) {
        add(retry.at, 1, {
            id: `retry:${retry.round}:${retry.at}`,
            icon: 'rotate-cw',
            verb: retry.reason === 'rate_limited' ? 'Rate limited' : 'Out of reach',
            detail: `waited ${runDuration(retry.waitMs)}, ${retry.cutShort ? 'cut short, nothing sent again' : 'then sent again'}`,
            ...(advanced && retry.error ? { outcome: retry.error } : {}),
            tone: 'muted',
        });
    }
    if (trace.fallback) {
        add(trace.fallback.at, 2, {
            id: `fallback:${trace.fallback.at}`,
            icon: 'arrow-left-right',
            verb: 'Switched to the shared model',
            detail: `${trace.fallback.from} ${BUSY_WORDS[trace.fallback.reason]}, so ${trace.fallback.to} carried on`,
            tone: 'muted',
        });
    }
    if (advanced) {
        for (const compaction of trace.compactions ?? []) {
            add(compaction.at, 3, {
                id: `compaction:${compaction.round}:${compaction.at}`,
                icon: 'archive',
                verb: 'Context fitted',
                detail: `${formatTokens(compaction.beforeTokens)} → ${formatTokens(compaction.afterTokens)} of ${formatTokens(compaction.window)} tokens`,
                tone: 'muted',
            });
        }
        for (const notes of trace.notes ?? []) {
            add(notes.startedAt, 4, {
                id: `notes:${notes.round}:${notes.startedAt}`,
                icon: 'notebook-pen',
                verb: `Notes by ${notes.by === 'shared' ? 'the shared model' : 'the chat’s model'}`,
                detail: notes.turns === 1 ? '1 turn' : `${formatNumber(notes.turns)} turns`,
                tone: notes.fallback === 'error' || notes.fallback === 'empty' ? 'bad' : 'muted',
                duration: runDuration(notes.endedAt - notes.startedAt),
            });
        }
        for (const round of trace.rounds) {
            add(round.startedAt, 5, roundStep(round));
        }
    }
    trace.tools.forEach((tool, index) => add(tool.startedAt, 6, toolStep(tool, index, advanced)));
    for (const wait of trace.waits) {
        add(wait.at, 7, {
            id: `wait:${wait.round}:${wait.at}:${wait.name}`,
            icon: wait.for === 'approval' ? 'hourglass' : 'user-round',
            verb: wait.for === 'approval' ? 'Waiting for approval' : 'Waiting for the person',
            ...(advanced ? { detail: wait.name } : {}),
            tone: 'muted',
        });
    }
    return timed.sort((a, b) => a.at - b.at || a.order - b.order).map(({ step }) => step);
}

function buildTimeline(view: RunTraceView, advanced: boolean): RunTimeline | null {
    const { trace } = view;
    if (trace === null) {
        return null;
    }
    const end = Math.max(
        view.finishedAt ?? 0,
        ...trace.rounds.map((round) => round.endedAt),
        ...trace.tools.map((tool) => tool.endedAt),
        view.startedAt + 1,
    );
    const rounds = trace.rounds.filter(loopRound).length;
    const tokens = trace.totals ? tokenText(trace.totals) : '';
    const model = trace.turn
        ? trace.turn.model && !trace.turn.label.includes(trace.turn.model)
            ? `${trace.turn.label} · ${trace.turn.model}`
            : trace.turn.label
        : null;
    return {
        end: trace.end ? (LOOP_END_LABELS[trace.end.reason] ?? trace.end.reason) : 'Running',
        trouble: trace.end !== undefined && TROUBLE.has(trace.end.reason),
        meta: [
            `${rounds === 1 ? '1 round' : `${rounds} rounds`}${trace.turn ? ` of ${trace.turn.cap} at most` : ''}`,
            ...(tokens ? [tokens] : []),
            runDuration(end - view.startedAt),
            ...(model ? [model] : []),
        ].join(' · '),
        steps: timelineSteps(trace, advanced),
        dropped: trace.dropped ? `${formatNumber(trace.dropped)} more steps were left out.` : null,
        advanced: advanced ? runSection(view.runId, { state: 'loaded', view }) : null,
    };
}

// One answer's timeline per Advanced setting, kept while the answer lives:
// re-renders (the list's poll, the age line) take the same object back.
const memo = new WeakMap<RunTraceView, { plain?: RunTimeline | null; advanced?: RunTimeline | null }>();

/** A trace answer's timeline, worked out once per answer and setting; null for a turn from before traces. */
export function runTimeline(view: RunTraceView, advanced: boolean): RunTimeline | null {
    let held = memo.get(view);
    if (held === undefined) {
        held = {};
        memo.set(view, held);
    }
    const key = advanced ? 'advanced' : 'plain';
    if (!(key in held)) {
        held[key] = buildTimeline(view, advanced);
    }
    return held[key] ?? null;
}

/** Where a run's trace stands on its page. */
export type TraceState =
    | { readonly kind: 'closed' }
    | { readonly kind: 'none' }
    | { readonly kind: 'loading' }
    /** No copy and the last read failed: Try again reads it once more (`refresh()`). */
    | { readonly kind: 'offline'; readonly retrying: boolean }
    | { readonly kind: 'missing' }
    | { readonly kind: 'old' }
    | { readonly kind: 'ready'; readonly timeline: RunTimeline; readonly age: string | null };

/**
 * The trace's state: `closed` until the person asks for it, `none` for a
 * turn with nothing to trace, else the bounded item's: loading, offline with
 * no copy, gone (404: someone else's, a deleted chat), from before traces, or
 * its timeline with "Saved …" when the last read failed.
 */
export function traceState(
    item: Pick<
        BoundedItemState<RunTraceView>,
        'value' | 'gone' | 'settled' | 'failed' | 'fetchedAt' | 'refreshing'
    > | null,
    canTrace: boolean,
    advanced: boolean,
    timeZone?: string,
): TraceState {
    if (!canTrace) {
        return { kind: 'none' };
    }
    if (item === null) {
        return { kind: 'closed' };
    }
    if (item.value === null) {
        return item.gone
            ? { kind: 'missing' }
            : item.settled
              ? { kind: 'offline', retrying: item.refreshing }
              : { kind: 'loading' };
    }
    const timeline = runTimeline(item.value, advanced);
    return timeline === null ? { kind: 'old' } : { kind: 'ready', timeline, age: detailAge(item, timeZone) };
}
