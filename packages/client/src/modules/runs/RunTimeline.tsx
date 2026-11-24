import { Archive, ArrowLeftRight, Hourglass, MessageSquareMore, NotebookPen, RotateCw, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { REACTIONS, REACTION_EMOJI, REACTION_LABELS } from '@socio/shared/chat/reactions';
import { formatNumber } from '@socio/shared/locale';
import type { LoopEndReason } from '@socio/shared/loop-end';
import {
    LOOP_END_LABELS,
    cachedPercent,
    loopRound,
    type RoundStop,
    type RunTrace,
    type RunTraceSummary,
    type RunTraceView,
    type ToolOutcome,
    type RetryCause,
    type TraceCompaction,
    type TraceFallback,
    type TraceNotes,
    type TraceReactions,
    type TraceRetry,
    type TraceRound,
    type TraceTool,
    type TraceWait,
} from '@socio/shared/runs/run-trace';
import { formatTokens } from '@socio/shared/token-count';

import { api } from '../../lib/api';
import { ToolImageThumb } from '../chat/trace/ToolImage';

import { formatDuration } from './format';

import { cn } from '@/lib/utils';

const STOP_LABELS: Record<RoundStop, string> = {
    stop: 'answered',
    tool_calls: 'called tools',
    length: 'output limit',
    content_filter: 'content filter',
    error: 'error',
    cancelled: 'cancelled',
};
const OUTCOME_LABELS: Record<ToolOutcome, string> = {
    ok: 'ok',
    error: 'error',
    refused: 'refused',
    timeout: 'timed out',
};
/** Reasons that mean the turn did not finish its work. */
const TROUBLE = new Set<LoopEndReason>([
    'round_cap',
    'time_limit',
    'cycle_limit',
    'output_limit',
    'error',
    'model_unavailable',
    'interrupted',
]);
const CAUSE_LABELS: Record<RetryCause, string> = {
    rate_limited: 'rate limited',
    unavailable: 'out of reach',
    fallback: 'on the shared model',
};

const tokens = formatTokens;

/** "1.2k in · 80% cached · 56 out", for what the model reported. */
function tokenText(counts: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
}) {
    const cached = cachedPercent(counts);
    return [
        counts.inputTokens !== undefined && `${tokens(counts.inputTokens)} in`,
        cached !== undefined && `${cached}% cached`,
        counts.outputTokens !== undefined && `${tokens(counts.outputTokens)} out`,
        counts.reasoningTokens !== undefined && `${tokens(counts.reasoningTokens)} reasoning`,
    ]
        .filter(Boolean)
        .join(' · ');
}

/** The Runs row's line: "Completed · 3 rounds · 12.4k in · 80% cached · 820 out". */
export function TraceSummaryLine({ summary }: { summary: RunTraceSummary }) {
    return (
        <p data-slot="trace-summary" data-reason={summary.reason} className="mt-1 text-muted-foreground tabular-nums">
            <span className={cn(TROUBLE.has(summary.reason) && 'font-medium text-destructive')}>
                {LOOP_END_LABELS[summary.reason]}
            </span>
            {' · '}
            {summary.rounds === 1 ? '1 round' : `${summary.rounds} rounds`}
            {(summary.inputTokens !== undefined || summary.outputTokens !== undefined) && ` · ${tokenText(summary)}`}
        </p>
    );
}

type Step =
    | { kind: 'reactions'; at: number; entry: TraceReactions }
    | { kind: 'compaction'; at: number; entry: TraceCompaction }
    | { kind: 'notes'; at: number; entry: TraceNotes }
    | { kind: 'retry'; at: number; entry: TraceRetry }
    | { kind: 'fallback'; at: number; entry: TraceFallback }
    | { kind: 'round'; at: number; entry: TraceRound }
    | { kind: 'tool'; at: number; entry: TraceTool }
    | { kind: 'wait'; at: number; entry: TraceWait };

/**
 * The trace's reactions, compactions, notes, retries, the switch to the
 * shared model, rounds, tool calls and waits in the order they happened.
 */
function steps(trace: RunTrace): Step[] {
    return [
        ...(trace.reactions
            ? [
                  {
                      kind: 'reactions' as const,
                      at: trace.reactions.at,
                      entry: trace.reactions,
                  },
              ]
            : []),
        ...(trace.compactions ?? []).map((entry) => ({
            kind: 'compaction' as const,
            at: entry.at,
            entry,
        })),
        ...(trace.notes ?? []).map((entry) => ({
            kind: 'notes' as const,
            at: entry.startedAt,
            entry,
        })),
        ...(trace.retries ?? []).map((entry) => ({
            kind: 'retry' as const,
            at: entry.at,
            entry,
        })),
        ...(trace.fallback
            ? [
                  {
                      kind: 'fallback' as const,
                      at: trace.fallback.at,
                      entry: trace.fallback,
                  },
              ]
            : []),
        ...trace.rounds.map((entry) => ({
            kind: 'round' as const,
            at: entry.startedAt,
            entry,
        })),
        ...trace.tools.map((entry) => ({
            kind: 'tool' as const,
            at: entry.startedAt,
            entry,
        })),
        ...trace.waits.map((entry) => ({
            kind: 'wait' as const,
            at: entry.at,
            entry,
        })),
    ].sort((a, b) => a.at - b.at || order(a) - order(b));
}
// The reactions come first: the Dot read them before its first round. A
// compaction comes just before the request it fitted, and a notes'
// update just before its own request; a retry's wait and a switch to the
// shared model just before the request they lead to.
const order = (step: Step) =>
    ['reactions', 'retry', 'fallback', 'compaction', 'notes', 'round', 'tool', 'wait'].indexOf(step.kind);

/** A step's place on the turn's time line, as percentages of its length. */
function Bar({
    from,
    to,
    start,
    span,
    tone,
}: {
    from: number;
    to: number;
    start: number;
    span: number;
    tone: 'round' | 'tool' | 'failed';
}) {
    const left = Math.min(100, Math.max(0, ((from - start) / span) * 100));
    const width = Math.max(0.75, Math.min(100 - left, ((to - from) / span) * 100));
    return (
        <div aria-hidden="true" className="relative mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div
                className={cn(
                    'absolute inset-y-0 rounded-full',
                    tone === 'round' && 'bg-brand',
                    tone === 'tool' && 'bg-chart-2',
                    tone === 'failed' && 'bg-destructive',
                )}
                style={{ left: `${left}%`, width: `${width}%` }}
            />
        </div>
    );
}

/**
 * A turn's trace in Runs (CB-128): a header with why its loop ended, its
 * rounds against the cap, tokens and model, then each model round and tool
 * call on the turn's time line with its duration and how it ended, and the
 * waits for a person. Names, times and counts only: a trace has no content.
 */
export function RunTimeline({
    runId,
    version,
    via,
}: {
    runId: string;
    /** Loads again when it changes (the row's status and end). */
    version?: string;
    /**
     * The Operations section it is opened from, for the access log's entry
     * (CB-188) when the turn is another person's.
     */
    via?: string;
}) {
    const [view, setView] = useState<RunTraceView>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        void api<RunTraceView>(
            `/runs/${encodeURIComponent(runId)}/trace${via ? `?via=${encodeURIComponent(via)}` : ''}`,
            'GET',
            undefined,
            controller.signal,
        )
            .then((next) => {
                setView(next);
                setError('');
            })
            .catch((e) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : String(e));
                }
            });
        return () => controller.abort();
    }, [runId, version, via]);
    if (error) {
        return (
            <p role="alert" className="text-destructive">
                {error}
            </p>
        );
    }
    if (!view) {
        return <p className="text-muted-foreground">Loading trace…</p>;
    }
    const { trace } = view;
    if (!trace) {
        return <p className="text-muted-foreground">No trace: this turn ran before traces were recorded.</p>;
    }
    const start = view.startedAt;
    const end = Math.max(
        view.finishedAt ?? 0,
        ...trace.rounds.map((round) => round.endedAt),
        ...trace.tools.map((tool) => tool.endedAt),
        start + 1,
    );
    const span = end - start;
    const list = steps(trace);
    const totals = trace.totals;
    const rounds = trace.rounds.filter(loopRound).length;
    return (
        <section
            data-slot="run-timeline"
            aria-label="Turn trace"
            // In the runs table's own scroll: the width of what shows of it, at
            // its left edge, so a phone reads it without scrolling sideways.
            className="sticky left-0 grid w-[min(100%,calc(100vw-4rem))] gap-2 rounded-lg bg-muted/50 p-3 text-xs"
        >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
                {trace.end ? (
                    <span
                        data-slot="trace-end"
                        data-reason={trace.end.reason}
                        title={trace.end.inferred ? 'Worked out from how the turn ended' : undefined}
                        className={cn('font-medium', TROUBLE.has(trace.end.reason) && 'text-destructive')}
                    >
                        {LOOP_END_LABELS[trace.end.reason]}
                    </span>
                ) : (
                    <span className="font-medium">Running</span>
                )}
                <span className="text-muted-foreground">
                    {rounds === 1 ? '1 round' : `${rounds} rounds`}
                    {trace.turn ? ` of ${trace.turn.cap} at most` : ''}
                    {totals && tokenText(totals) ? ` · ${tokenText(totals)}` : ''}
                    {` · ${formatDuration(span)}`}
                    {trace.turn &&
                        ` · ${trace.turn.label}${
                            trace.turn.model && !trace.turn.label.includes(trace.turn.model)
                                ? ` · ${trace.turn.model}`
                                : ''
                        }`}
                </span>
            </div>
            {list.length ? (
                <ol data-slot="trace-timeline" className="grid gap-1.5">
                    {list.map((step) => (
                        <li
                            key={`${step.kind}:${step.at}:${'round' in step.entry ? step.entry.round : ''}:${'name' in step.entry ? step.entry.name : ''}:${'callId' in step.entry ? step.entry.callId : ''}:${step.kind === 'round' ? (step.entry.retry ?? (step.entry.summary ? 'notes' : '')) : ''}`}
                            data-slot="trace-entry"
                            data-kind={step.kind}
                            className={cn(step.kind !== 'round' && 'pl-4')}
                        >
                            {step.kind === 'reactions' ? (
                                <ReactionsLine reactions={step.entry} />
                            ) : step.kind === 'compaction' ? (
                                <CompactionLine compaction={step.entry} />
                            ) : step.kind === 'notes' ? (
                                <NotesLine notes={step.entry} />
                            ) : step.kind === 'retry' ? (
                                <RetryLine retry={step.entry} />
                            ) : step.kind === 'fallback' ? (
                                <FallbackLine fallback={step.entry} />
                            ) : step.kind === 'round' ? (
                                <RoundLine round={step.entry} start={start} span={span} />
                            ) : step.kind === 'tool' ? (
                                <ToolLine tool={step.entry} start={start} span={span} />
                            ) : (
                                <WaitLine wait={step.entry} />
                            )}
                        </li>
                    ))}
                </ol>
            ) : (
                <p className="text-muted-foreground">No model rounds recorded.</p>
            )}
            {!!trace.dropped && (
                <p className="text-muted-foreground">{formatNumber(trace.dropped)} more steps were left out.</p>
            )}
        </section>
    );
}

function RoundLine({ round, start, span }: { round: TraceRound; start: number; span: number }) {
    const failed = round.stop === 'error';
    const meta = [
        tokenText(round),
        round.firstOutputMs !== undefined && `first output ${formatDuration(round.firstOutputMs)}`,
    ].filter(Boolean);
    return (
        <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 tabular-nums">
                <span>
                    <span className="font-medium">
                        {round.summary
                            ? `Notes for round ${round.round}`
                            : round.cause === 'fallback'
                              ? `Round ${round.round}, ${CAUSE_LABELS.fallback}`
                              : round.retry
                                ? `Round ${round.round}, retry ${round.retry}${round.cause ? ` (${CAUSE_LABELS[round.cause]})` : ''}`
                                : `Round ${round.round}`}
                    </span>{' '}
                    <span
                        data-slot="trace-stop"
                        className={cn(
                            failed || round.stop === 'length' || round.stop === 'content_filter'
                                ? 'text-destructive'
                                : 'text-muted-foreground',
                        )}
                    >
                        {STOP_LABELS[round.stop]}
                        {round.error ? ` · ${round.error}` : ''}
                    </span>
                    {meta.length > 0 && <span className="text-muted-foreground"> · {meta.join(' · ')}</span>}
                </span>
                <span className="text-muted-foreground">{formatDuration(round.endedAt - round.startedAt)}</span>
            </div>
            <Bar
                from={round.startedAt}
                to={round.endedAt}
                start={start}
                span={span}
                tone={failed ? 'failed' : 'round'}
            />
        </>
    );
}

function ToolLine({ tool, start, span }: { tool: TraceTool; start: number; span: number }) {
    const failed = tool.outcome === 'error' || tool.outcome === 'timeout';
    return (
        <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 tabular-nums">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-mono">{tool.name}</span>{' '}
                    <span
                        data-slot="trace-outcome"
                        data-outcome={tool.outcome}
                        className={cn(
                            failed
                                ? 'text-destructive'
                                : tool.outcome === 'refused'
                                  ? 'text-amber-700 dark:text-amber-300'
                                  : 'text-muted-foreground',
                        )}
                    >
                        {OUTCOME_LABELS[tool.outcome]}
                        {tool.error ? ` · ${tool.error}` : ''}
                    </span>
                </span>
                <span className="text-muted-foreground">{formatDuration(tool.endedAt - tool.startedAt)}</span>
            </div>
            <Bar from={tool.startedAt} to={tool.endedAt} start={start} span={span} tone={failed ? 'failed' : 'tool'} />
            {tool.image && (
                <div className="mt-1">
                    <ToolImageThumb
                        image={{
                            id: tool.image,
                            name: tool.name === 'computer_screenshot' ? 'Screenshot' : 'Image',
                            mediaType: 'image',
                        }}
                        small
                    />
                </div>
            )}
        </>
    );
}

/**
 * A round's prompt fitted to the model's context (CB-129): "Context fitted
 * · 182k → 88k of 128k tokens · 12 results cut · 3 turns in notes".
 */
function CompactionLine({ compaction }: { compaction: TraceCompaction }) {
    const parts = [
        `${tokens(compaction.beforeTokens)} → ${tokens(compaction.afterTokens)} of ${tokens(compaction.window)} tokens`,
        compaction.stubbed > 0 &&
            (compaction.stubbed === 1 ? '1 result cut' : `${formatNumber(compaction.stubbed)} results cut`),
        compaction.summarised > 0 &&
            (compaction.summarised === 1 ? '1 turn in notes' : `${formatNumber(compaction.summarised)} turns in notes`),
        compaction.retried > 0 && `retry ${compaction.retried}`,
        compaction.pinnedShown !== undefined &&
            compaction.pinnedStored !== undefined &&
            `${formatNumber(compaction.pinnedShown)} of ${formatNumber(compaction.pinnedStored)} facts${compaction.selection ? ` by ${SELECTION_LABELS[compaction.selection]}` : ''}`,
    ].filter(Boolean);
    return (
        <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground tabular-nums">
            <Archive className="size-3.5" aria-hidden="true" />
            Context fitted
            <span>· {parts.join(' · ')}</span>
        </p>
    );
}

const SELECTION_LABELS: Record<NonNullable<TraceCompaction['selection']>, string> = {
    age: 'age',
    relevance: 'relevance',
    pointer: 'pointer',
};
const FALLBACK_LABELS: Record<NonNullable<TraceNotes['fallback']>, string> = {
    error: 'plain summary kept: the request failed',
    empty: 'plain summary kept: no summary came back',
    cap: 'plain summary: this turn’s summaries were used up',
};

/**
 * An update of the chat's notes (CB-137): "Notes by the shared model
 * (qwen38-flash) · 6 turns · 12.1k in · 640 out · 14.2s", or the plain
 * summary kept and why (in red when the model failed).
 */
function NotesLine({ notes }: { notes: TraceNotes }) {
    const parts = [
        notes.turns === 1 ? '1 turn' : `${formatNumber(notes.turns)} turns`,
        tokenText(notes),
        notes.fallback && FALLBACK_LABELS[notes.fallback],
    ].filter(Boolean);
    return (
        <p
            data-slot="trace-notes"
            className={cn(
                'flex flex-wrap items-center gap-x-1.5 tabular-nums',
                notes.fallback === 'error' || notes.fallback === 'empty' ? 'text-destructive' : 'text-muted-foreground',
            )}
        >
            <NotebookPen className="size-3.5" aria-hidden="true" />
            Notes by {notes.by === 'shared' ? 'the shared model' : 'the chat’s model'}
            {notes.model ? ` (${notes.model})` : ''}
            <span>· {parts.join(' · ')}</span>
            <span className="ml-auto">{formatDuration(notes.endedAt - notes.startedAt)}</span>
        </p>
    );
}

/**
 * A request the model turned away, sent again after a wait (CB-140):
 * "Rate limited · chatgpt_rate_limited · waited 2.1 s, then sent again",
 * or "…, cut short, nothing sent again" when Stop or the time limit ended it.
 */
function RetryLine({ retry }: { retry: TraceRetry }) {
    return (
        <p data-slot="trace-retry" className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground tabular-nums">
            <RotateCw className="size-3.5" aria-hidden="true" />
            {retry.reason === 'rate_limited' ? 'Rate limited' : 'Out of reach'}
            <span>
                {retry.error ? `· ${retry.error} ` : ''}· waited {formatDuration(retry.waitMs)},{' '}
                {retry.cutShort ? 'cut short, nothing sent again' : 'then sent again'}
            </span>
        </p>
    );
}

const BUSY_LABELS: Record<TraceFallback['reason'], string> = {
    rate_limited: 'was busy',
    unavailable: 'was out of reach',
    usage_limit: 'hit its usage limit',
};

/** The rest of the turn on the shared model (CB-140). */
function FallbackLine({ fallback }: { fallback: TraceFallback }) {
    return (
        <p
            data-slot="trace-fallback"
            className="flex flex-wrap items-center gap-x-1.5 text-amber-700 tabular-nums dark:text-amber-300"
        >
            <ArrowLeftRight className="size-3.5" aria-hidden="true" />
            Switched to the shared model
            <span>
                · {fallback.from} {BUSY_LABELS[fallback.reason]}, so {fallback.to} carried on
            </span>
        </p>
    );
}

/** The reactions the Dot was told of as the turn began (CB-133). */
function ReactionsLine({ reactions }: { reactions: TraceReactions }) {
    return (
        <p className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
            <MessageSquareMore className="size-3.5" aria-hidden="true" />
            Told of reactions
            <span>
                ·{' '}
                {REACTIONS.filter((kind) => reactions.counts[kind])
                    .map(
                        (kind) =>
                            `${REACTION_EMOJI[kind]} ${REACTION_LABELS[kind].toLowerCase()} ${reactions.counts[kind]}`,
                    )
                    .join(' · ')}
            </span>
        </p>
    );
}

function WaitLine({ wait }: { wait: TraceWait }) {
    const Icon = wait.for === 'approval' ? Hourglass : UserRound;
    return (
        <p className="flex items-center gap-1.5 text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
            {wait.for === 'approval' ? 'Waiting for approval' : 'Waiting for the person'}
            <span className="font-mono">· {wait.name}</span>
        </p>
    );
}
