import { Archive, ArrowLeftRight, Hourglass, MessageSquareMore, NotebookPen, RotateCw, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { REACTIONS, REACTION_EMOJI, REACTION_LABELS } from '@socio/shared/chat/reactions';
import { lowerText } from '@socio/shared/locale';
import type { LoopEndReason } from '@socio/shared/loop-end';
import {
    cachedPercent,
    loopRound,
    type RunTrace,
    type RunTraceSummary,
    type RunTraceView,
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

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { ToolImageThumb } from '../chat/trace/ToolImage';

import { formatDuration } from './format';

import { cn } from '@/lib/utils';

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
const tokens = formatTokens;

interface TokenCounts {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
}

/**
 * The summary's words (`runs.summary`, which the Runs page inlines): why
 * a loop ended, and "1.2k in · 80% cached · 56 out" for what the model
 * reported.
 */
function useSummaryWords() {
    const { t } = useTranslation(['runs.summary']);
    return {
        t,
        end: (reason: LoopEndReason) => t(`runs.summary:end.${reason}`),
        tokens: (counts: TokenCounts) => {
            const cached = cachedPercent(counts);
            return [
                counts.inputTokens !== undefined && t('runs.summary:tokens.in', { tokens: tokens(counts.inputTokens) }),
                cached !== undefined && t('runs.summary:tokens.cached', { share: cached / 100 }),
                counts.outputTokens !== undefined &&
                    t('runs.summary:tokens.out', { tokens: tokens(counts.outputTokens) }),
                counts.reasoningTokens !== undefined &&
                    t('runs.summary:tokens.reasoning', { tokens: tokens(counts.reasoningTokens) }),
            ]
                .filter(Boolean)
                .join(' · ');
        },
    };
}

/** The Runs row's line: "Completed · 3 rounds · 12.4k in · 80% cached · 820 out". */
export function TraceSummaryLine({ summary }: { summary: RunTraceSummary }) {
    const words = useSummaryWords();
    return (
        <p data-slot="trace-summary" data-reason={summary.reason} className="mt-1 text-muted-foreground tabular-nums">
            <span className={cn(TROUBLE.has(summary.reason) && 'font-medium text-destructive')}>
                {words.end(summary.reason)}
            </span>
            {' · '}
            {words.t('runs.summary:rounds', { count: summary.rounds })}
            {(summary.inputTokens !== undefined || summary.outputTokens !== undefined) && ` · ${words.tokens(summary)}`}
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
 * Opened by a click (in Runs, and in Operations' Reliability): its words
 * (`runs.trace`, and `runs.summary` where the page doesn't inline them)
 * load on demand.
 */
function RunTimelineView({
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
    const { t } = useTranslation(['runs.trace', 'runs.summary']);
    const words = useSummaryWords();
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
        return <p className="text-muted-foreground">{t('runs.trace:loading')}</p>;
    }
    const { trace } = view;
    if (!trace) {
        return <p className="text-muted-foreground">{t('runs.trace:none')}</p>;
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
            aria-label={t('runs.trace:label')}
            // In the runs table's own scroll: the width of what shows of it, at
            // its left edge, so a phone reads it without scrolling sideways.
            className="sticky left-0 grid w-[min(100%,calc(100vw-4rem))] gap-2 rounded-lg bg-muted/50 p-3 text-xs"
        >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tabular-nums">
                {trace.end ? (
                    <span
                        data-slot="trace-end"
                        data-reason={trace.end.reason}
                        title={trace.end.inferred ? t('runs.trace:inferred') : undefined}
                        className={cn('font-medium', TROUBLE.has(trace.end.reason) && 'text-destructive')}
                    >
                        {words.end(trace.end.reason)}
                    </span>
                ) : (
                    <span className="font-medium">{t('runs.trace:running')}</span>
                )}
                <span className="text-muted-foreground">
                    {trace.turn
                        ? t('runs.trace:rounds-of', { count: rounds, cap: trace.turn.cap })
                        : t('runs.summary:rounds', { count: rounds })}
                    {totals && words.tokens(totals) ? ` · ${words.tokens(totals)}` : ''}
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
                <p className="text-muted-foreground">{t('runs.trace:no-rounds')}</p>
            )}
            {!!trace.dropped && (
                <p className="text-muted-foreground">{t('runs.trace:dropped', { count: trace.dropped })}</p>
            )}
        </section>
    );
}

export const RunTimeline = onDemand(['runs.trace', 'runs.summary'], RunTimelineView);

function RoundLine({ round, start, span }: { round: TraceRound; start: number; span: number }) {
    const { t } = useTranslation(['runs.trace']);
    const words = useSummaryWords();
    const failed = round.stop === 'error';
    const meta = [
        words.tokens(round),
        round.firstOutputMs !== undefined &&
            t('runs.trace:round.first-output', { duration: formatDuration(round.firstOutputMs) }),
    ].filter(Boolean);
    return (
        <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 tabular-nums">
                <span>
                    <span className="font-medium">
                        {round.summary
                            ? t('runs.trace:round.notes', { round: round.round })
                            : round.cause === 'fallback'
                              ? t('runs.trace:round.fallback', { round: round.round })
                              : round.retry
                                ? t('runs.trace:round.retry', {
                                      round: round.round,
                                      retry: round.retry,
                                      context: round.cause,
                                  })
                                : t('runs.trace:round.plain', { round: round.round })}
                    </span>{' '}
                    <span
                        data-slot="trace-stop"
                        className={cn(
                            failed || round.stop === 'length' || round.stop === 'content_filter'
                                ? 'text-destructive'
                                : 'text-muted-foreground',
                        )}
                    >
                        {t(`runs.trace:stop.${round.stop}`)}
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
    const { t } = useTranslation(['runs.trace']);
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
                        {t(`runs.trace:outcome.${tool.outcome}`)}
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
                            name:
                                tool.name === 'computer_screenshot'
                                    ? t('runs.trace:image.screenshot')
                                    : t('runs.trace:image.image'),
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
    const { t } = useTranslation(['runs.trace']);
    const parts = [
        t('runs.trace:compaction.tokens', {
            before: tokens(compaction.beforeTokens),
            after: tokens(compaction.afterTokens),
            window: tokens(compaction.window),
        }),
        compaction.stubbed > 0 && t('runs.trace:compaction.cut', { count: compaction.stubbed }),
        compaction.summarised > 0 && t('runs.trace:compaction.notes', { count: compaction.summarised }),
        compaction.retried > 0 && t('runs.trace:compaction.retry', { count: compaction.retried }),
        compaction.pinnedShown !== undefined &&
            compaction.pinnedStored !== undefined &&
            t('runs.trace:compaction.facts', {
                shown: compaction.pinnedShown,
                stored: compaction.pinnedStored,
                context: compaction.selection,
            }),
    ].filter(Boolean);
    return (
        <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground tabular-nums">
            <Archive className="size-3.5" aria-hidden="true" />
            {t('runs.trace:compaction.title')}
            <span>· {parts.join(' · ')}</span>
        </p>
    );
}

/**
 * An update of the chat's notes (CB-137): "Notes by the shared model
 * (qwen38-flash) · 6 turns · 12.1k in · 640 out · 14.2s", or the plain
 * summary kept and why (in red when the model failed).
 */
function NotesLine({ notes }: { notes: TraceNotes }) {
    const { t } = useTranslation(['runs.trace']);
    const words = useSummaryWords();
    const parts = [
        t('runs.trace:notes.turns', { count: notes.turns }),
        words.tokens(notes),
        notes.fallback && t(`runs.trace:notes.fallback.${notes.fallback}`),
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
            {notes.by === 'shared'
                ? notes.model
                    ? t('runs.trace:notes.by-shared-model', { model: notes.model })
                    : t('runs.trace:notes.by-shared')
                : notes.model
                  ? t('runs.trace:notes.by-chat-model', { model: notes.model })
                  : t('runs.trace:notes.by-chat')}
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
    const { t } = useTranslation(['runs.trace']);
    return (
        <p data-slot="trace-retry" className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground tabular-nums">
            <RotateCw className="size-3.5" aria-hidden="true" />
            {retry.reason === 'rate_limited' ? t('runs.trace:retry.rate_limited') : t('runs.trace:retry.unavailable')}
            <span>
                {retry.error ? `· ${retry.error} ` : ''}·{' '}
                {t('runs.trace:retry.sent', {
                    duration: formatDuration(retry.waitMs),
                    context: retry.cutShort ? 'cut' : undefined,
                })}
            </span>
        </p>
    );
}

/** The rest of the turn on the shared model (CB-140). */
function FallbackLine({ fallback }: { fallback: TraceFallback }) {
    const { t } = useTranslation(['runs.trace']);
    return (
        <p
            data-slot="trace-fallback"
            className="flex flex-wrap items-center gap-x-1.5 text-amber-700 tabular-nums dark:text-amber-300"
        >
            <ArrowLeftRight className="size-3.5" aria-hidden="true" />
            {t('runs.trace:fallback.title')}
            <span>· {t(`runs.trace:fallback.${fallback.reason}`, { from: fallback.from, to: fallback.to })}</span>
        </p>
    );
}

/** The reactions the Dot was told of as the turn began (CB-133). */
function ReactionsLine({ reactions }: { reactions: TraceReactions }) {
    const { t } = useTranslation(['runs.trace']);
    return (
        <p className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
            <MessageSquareMore className="size-3.5" aria-hidden="true" />
            {t('runs.trace:reactions')}
            <span>
                ·{' '}
                {REACTIONS.filter((kind) => reactions.counts[kind])
                    .map((kind) =>
                        t('runs.trace:reaction', {
                            emoji: REACTION_EMOJI[kind],
                            reaction: lowerText(REACTION_LABELS[kind]),
                            count: reactions.counts[kind] ?? 0,
                        }),
                    )
                    .join(' · ')}
            </span>
        </p>
    );
}

function WaitLine({ wait }: { wait: TraceWait }) {
    const { t } = useTranslation(['runs.trace']);
    const Icon = wait.for === 'approval' ? Hourglass : UserRound;
    return (
        <p className="flex items-center gap-1.5 text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
            {wait.for === 'approval' ? t('runs.trace:wait.approval') : t('runs.trace:wait.person')}
            <span className="font-mono">· {wait.name}</span>
        </p>
    );
}
