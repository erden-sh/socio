import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import {
    FAILURE_CATEGORIES,
    FAILURE_CATEGORY_HINTS,
    FAILURE_CATEGORY_LABELS,
    type FailureCategory,
} from '@socio/shared/failure-taxonomy';
import { formatNumber, numberFormat } from '@socio/shared/locale';
import { opsSearch } from '@socio/shared/operations/operations';
import {
    RELIABILITY_DIMENSIONS,
    type OpsBreakdownRow,
    type OpsFailureRow,
    type OpsReliability,
    type OpsReliabilityBreakdown,
    type OpsReliabilityFriction,
    type OpsReliabilityIssues,
    type OpsReliabilitySeries,
    type ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { formatDuration } from '../runs/format';
import { RunTimeline } from '../runs/RunTimeline';

import { FailureLabelPanel, labelledBy } from './FailureLabelPanel';
import { bucketLabel, formatWhen, statusLine, tileChange } from './format';
import { opsPath } from './sections';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const percent = numberFormat({ style: 'percent', maximumFractionDigits: 1 });
const FAILURES = FAILURE_CATEGORIES.filter((c) => c !== 'stopped');
const TOOL = /^[\w.:@+-]{1,120}$/;

const DIMENSION_LABELS: Record<ReliabilityDimension, string> = {
    tool: 'Tools',
    code: 'Error codes',
    socio: 'Socios',
    model: 'Models',
    source: 'Sources',
};

const STATUS_LABEL: Record<OpsFailureRow['status'], string> = {
    running: 'Running',
    finished: 'Finished',
    stopped: 'Stopped',
    failed: 'Failed',
    interrupted: 'Interrupted',
};

const rate = (part: number | null, whole: number | null) =>
    part === null || whole === null ? null : whole ? part / whole : 0;

/** A span of hours or days: "3 h", "2.5 days". */
export function formatSpan(ms: number) {
    const hours = ms / 3_600_000;
    if (hours < 1) {
        return `${Math.max(1, Math.round(ms / 60_000))} min`;
    }
    if (hours < 48) {
        return `${Math.round(hours)} h`;
    }
    return `${(hours / 24).toFixed(1)} days`;
}

/** A failure category's name, with its rule beside it for whoever looks. */
function CategoryBadge({ category }: { category: FailureCategory }) {
    return (
        <Badge
            variant={category === 'unclassified' ? 'outline' : 'secondary'}
            data-category={category}
            title={FAILURE_CATEGORY_HINTS[category]}
        >
            {FAILURE_CATEGORY_LABELS[category]}
        </Badge>
    );
}

function Stat({
    id,
    label,
    value,
    note,
    tone,
}: {
    id: string;
    label: string;
    value: string;
    note?: ReactNode;
    tone?: 'good' | 'bad';
}) {
    return (
        <Card data-slot="ops-tile" data-tile={id} className="gap-1 px-4 py-3 shadow-xs">
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className="text-2xl font-semibold tabular-nums">{value}</strong>
            <span
                className={cn(
                    'min-h-4 text-xs text-muted-foreground',
                    tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
                    tone === 'bad' && 'text-destructive',
                )}
            >
                {note}
            </span>
        </Card>
    );
}

const count = (value: number | null) => (value === null ? '–' : formatNumber(value));

function Alert({ text }: { text: string }) {
    return text ? (
        <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {text}
        </p>
    ) : null;
}

/**
 * Reliability (CB-189): what fails and why, by the failure taxonomy. The
 * totals, the failure rate over the range for every failure or one
 * category, each category's share, where failures happen (tools with
 * their latency, codes, socios, models, sources), recurring friction,
 * the recent failures (a turn's trace opens on demand), and the board's
 * reporting and resolution. A category or a tool narrows the recent
 * failures through the address, so the view can be shared.
 */
export function ReliabilitySection() {
    const { query, search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const [params, setParams] = useSearchParams();
    const wanted = params.get('category');
    const category = (FAILURE_CATEGORIES as readonly string[]).includes(wanted ?? '')
        ? (wanted as FailureCategory)
        : undefined;
    const tool = TOOL.test(params.get('tool') ?? '') ? params.get('tool')! : undefined;
    const [charted, setCharted] = useState<'all' | FailureCategory>('all');
    const [by, setBy] = useState<ReliabilityDimension>('tool');
    const [issueMetric, setIssueMetric] = useState<'reported' | 'resolved'>('reported');
    const recent = useRef<HTMLDivElement>(null);

    const summary = useOpsAnswer<OpsReliability>(`/operations/reliability${search}`);
    const series = useOpsAnswer<OpsReliabilitySeries>(`/operations/reliability/series${search}`);
    const breakdown = useOpsAnswer<OpsReliabilityBreakdown>(`/operations/reliability/breakdown/${by}${search}`);
    const friction = useOpsAnswer<OpsReliabilityFriction>(`/operations/reliability/friction${search}`);
    const issues = useOpsAnswer<OpsReliabilityIssues>(`/operations/reliability/issues${search}`);
    const narrow = new URLSearchParams(search.slice(1));
    if (category) {
        narrow.set('category', category);
    }
    if (tool) {
        narrow.set('tool', tool);
    }
    const failures = useCursorList<OpsFailureRow>(
        `/operations/reliability/failures${narrow.toString() ? `?${narrow}` : ''}`,
    );

    /** Narrows the recent failures, and brings them into view. */
    const drill = (next: { category?: FailureCategory; tool?: string }) => {
        setParams(
            (current) => {
                const out = new URLSearchParams(current);
                for (const name of ['category', 'tool'] as const) {
                    const value = next[name];
                    if (value) {
                        out.set(name, value);
                    } else {
                        out.delete(name);
                    }
                }
                return out;
            },
            { preventScrollReset: true },
        );
        recent.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    };

    const s = summary.data?.summary;
    const status = summary.data?.status;
    const now = rate(s?.failures ?? null, s?.turns ?? null);
    const before = rate(s?.previousFailures ?? null, s?.previousTurns ?? null);
    const change = now !== null && before !== null && s?.previousTurns ? (now - before) * 100 : null;
    // More failed turns than before is worse.
    const moved = s && tileChange(s.failures, s.previousFailures);
    const tiles = s && (
        <>
            <Stat
                id="failure-rate"
                label="Failure rate"
                value={now === null ? '–' : percent.format(now)}
                note={
                    change === null
                        ? `${count(s.failures)} of ${count(s.turns)} turns`
                        : `${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change).toFixed(1)} pts vs the period before`
                }
                tone={change === null || change === 0 ? undefined : change > 0 ? 'bad' : 'good'}
            />
            <Stat
                id="failures"
                label="Failed turns"
                value={count(s.failures)}
                note={moved && `${moved.text} vs the period before`}
                tone={!moved || moved.direction === 'same' ? undefined : moved.direction === 'up' ? 'bad' : 'good'}
            />
            <Stat
                id="interrupted"
                label="Interrupted"
                value={count(s.interrupted)}
                note="The server stopped mid-turn"
            />
            <Stat
                id="stopped"
                label="Stopped"
                value={count(s.stopped)}
                note="By a person or an operator: not failures"
            />
            <Stat
                id="tool-failures"
                label="Failed tool calls"
                value={count(s.toolFailures)}
                note={s.toolCalls === null ? undefined : `of ${count(s.toolCalls)} calls`}
            />
            <Stat
                id="retries"
                label="Retries and fallbacks"
                value={count(s.retries)}
                note={
                    s.retriedTurns === null
                        ? undefined
                        : `in ${count(s.retriedTurns)} turns · ${count(s.fallbacks)} moved to the shared model`
                }
            />
        </>
    );

    const window = series.data?.window;
    const index = charted === 'all' ? -1 : FAILURE_CATEGORIES.indexOf(charted);
    const chartLabel = charted === 'all' ? 'Failure rate' : `${FAILURE_CATEGORY_LABELS[charted]}: share of turns`;
    const points = (series.data?.points ?? []).map((point) => ({
        label: window ? bucketLabel(point.at, window.bucket, window.timeZone) : '',
        value: point.turns
            ? Math.round(((index < 0 ? point.failures : point.counts[index]!) / point.turns) * 1000) / 10
            : null,
    }));
    const categories = s?.categories ?? [];
    const widest = Math.max(1, ...categories.filter((c) => c.category !== 'stopped').map((c) => c.turns + c.tools));

    return (
        <>
            {status && (
                <p
                    data-slot="ops-status"
                    data-state={status.state}
                    className={cn(
                        'm-0 text-xs text-muted-foreground',
                        status.state !== 'ready' && 'rounded-lg border bg-card px-4 py-3 text-sm',
                    )}
                >
                    {statusLine(status, timeZone)}
                </p>
            )}
            <Alert text={summary.error} />
            <section aria-label="Totals" aria-busy={summary.loading} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {tiles ?? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-21 rounded-xl" />)}
            </section>

            <Card data-slot="ops-failure-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1">
                        <CardTitle>{chartLabel}</CardTitle>
                        <CardDescription>
                            Percent of the turns that started in each {window?.bucket ?? 'bucket'}.
                        </CardDescription>
                    </div>
                    <Select value={charted} onValueChange={(value) => setCharted(value as typeof charted)}>
                        <SelectTrigger size="sm" aria-label="Category" className="w-60">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Every failure</SelectItem>
                            {FAILURES.map((c) => (
                                <SelectItem key={c} value={c}>
                                    {FAILURE_CATEGORY_LABELS[c]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    <Alert text={series.error} />
                    {series.data && points.some((point) => point.value !== null) ? (
                        <SeriesChart
                            kind={window?.bucket === 'hour' ? 'line' : 'bar'}
                            label={chartLabel}
                            xName={window!.bucket}
                            yName="percent of turns"
                            points={points}
                        />
                    ) : series.data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">No turns in this range.</p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-categories" className="gap-4">
                <CardHeader>
                    <CardTitle>Failures by category</CardTitle>
                    <CardDescription>
                        Sorted by rules over the codes each turn and tool call recorded. What they can’t tell apart
                        stays Unclassified, until an admin or, once it passes an evaluation, the model labels it: open a
                        recent failure to label it.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {!s ? (
                        <Skeleton className="h-40 w-full" />
                    ) : !categories.length ? (
                        <p className="m-0 text-sm text-muted-foreground">No data yet.</p>
                    ) : (
                        <ul className="m-0 grid list-none gap-0 divide-y p-0">
                            {[...FAILURES, 'stopped' as const].map((id) => {
                                const c = categories.find((item) => item.category === id)!;
                                const total = c.turns + c.tools;
                                return (
                                    <li
                                        key={id}
                                        data-slot="ops-category"
                                        data-category={id}
                                        className="grid gap-1 py-2.5"
                                    >
                                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                            <span className="font-medium">{FAILURE_CATEGORY_LABELS[id]}</span>
                                            <span className="text-xs text-muted-foreground tabular-nums">
                                                {formatNumber(c.turns)} turns · {formatNumber(c.tools)} tool calls
                                                {id === 'runtime_error' && s.interrupted
                                                    ? ` · ${formatNumber(s.interrupted)} interrupted`
                                                    : ''}
                                            </span>
                                            {total > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="ml-auto"
                                                    onClick={() => drill({ category: id })}
                                                >
                                                    Show
                                                </Button>
                                            )}
                                        </div>
                                        {id !== 'stopped' && (
                                            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
                                                <div
                                                    className="h-full rounded-full bg-chart-1"
                                                    style={{ width: `${(total / widest) * 100}%` }}
                                                />
                                            </div>
                                        )}
                                        <span className="text-xs text-muted-foreground">
                                            {FAILURE_CATEGORY_HINTS[id]}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-breakdown" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1">
                        <CardTitle>Where failures happen</CardTitle>
                        <CardDescription>
                            {by === 'tool'
                                ? 'Tools that fail most, with how long their calls take.'
                                : by === 'code'
                                  ? 'The codes failed turns ended with.'
                                  : 'Failed turns, with how long finished turns took.'}
                        </CardDescription>
                    </div>
                    <Select value={by} onValueChange={(value) => setBy(value as ReliabilityDimension)}>
                        <SelectTrigger size="sm" aria-label="Group by" className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {RELIABILITY_DIMENSIONS.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {DIMENSION_LABELS[item]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    <Alert text={breakdown.error} />
                    {!breakdown.data ? (
                        <Skeleton className="h-40 w-full" />
                    ) : !breakdown.data.rows.length ? (
                        <p className="m-0 text-sm text-muted-foreground">Nothing in this range.</p>
                    ) : (
                        <ul
                            aria-label={DIMENSION_LABELS[breakdown.data.by]}
                            className="m-0 grid list-none gap-0 divide-y p-0"
                        >
                            {breakdown.data.rows.map((row) => (
                                <BreakdownItem
                                    key={row.key}
                                    row={row}
                                    by={breakdown.data!.by}
                                    socioLink={opsPath(
                                        'reliability',
                                        opsSearch({
                                            ...query,
                                            filters: { ...query.filters, socio: row.key },
                                        }),
                                    )}
                                    onShow={() =>
                                        drill(
                                            breakdown.data!.by === 'tool'
                                                ? { tool: row.key }
                                                : row.category
                                                  ? { category: row.category }
                                                  : {},
                                        )
                                    }
                                />
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-friction" className="gap-4">
                <CardHeader>
                    <CardTitle>Recurring friction</CardTitle>
                    <CardDescription>
                        The same failure for 3 or more people, or 5 or more times for one person, in the last 7 days of
                        the range.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Alert text={friction.error} />
                    {!friction.data ? (
                        <Skeleton className="h-24 w-full" />
                    ) : !friction.data.rows.length ? (
                        <p className="m-0 text-sm text-muted-foreground">
                            Nothing keeps failing for people since {formatWhen(friction.data.from, timeZone)}.
                        </p>
                    ) : (
                        <ul className="m-0 grid list-none gap-0 divide-y p-0">
                            {friction.data.rows.map((row) => (
                                <li
                                    key={`${row.category} ${row.code} ${row.tool}`}
                                    data-slot="ops-friction-row"
                                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                                >
                                    <CategoryBadge category={row.category} />
                                    <span className="min-w-0 truncate font-mono text-xs">
                                        {[row.tool, row.code].filter(Boolean).join(' · ') || 'No code'}
                                    </span>
                                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                        {formatNumber(row.people)} {row.people === 1 ? 'person' : 'people'} ·{' '}
                                        {formatNumber(row.failures)} times (most for one: {formatNumber(row.mostForOne)}
                                        ) · last {formatWhen(row.lastAt, timeZone)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-failures" className="scroll-mt-4 gap-4" ref={recent}>
                <CardHeader>
                    <CardTitle>Recent failures</CardTitle>
                    <CardDescription>
                        Turns that failed, or whose tool calls did, newest first. Open one to see its trace: names,
                        times and codes, never its content.
                    </CardDescription>
                    {(category || tool) && (
                        <div className="flex flex-wrap gap-2 pt-1">
                            {category && (
                                <Chip label={FAILURE_CATEGORY_LABELS[category]} onClear={() => drill({ tool })} />
                            )}
                            {tool && <Chip label={tool} onClear={() => drill({ category })} />}
                        </div>
                    )}
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={failures}
                        label="Recent failures"
                        itemKey={(row) => row.runId}
                        empty="No failures in this range."
                        renderItem={(row) => <FailureItem row={row} timeZone={timeZone} />}
                    />
                </CardContent>
            </Card>

            <IssuesCard answer={issues} metric={issueMetric} setMetric={setIssueMetric} />
        </>
    );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
    return (
        <Badge variant="secondary" className="gap-1 pr-1">
            {label}
            <button
                type="button"
                aria-label={`Show every failure, not only ${label}`}
                className="rounded-sm p-0.5 hover:bg-background/60"
                onClick={onClear}
            >
                <X className="size-3" />
            </button>
        </Badge>
    );
}

function BreakdownItem({
    row,
    by,
    socioLink,
    onShow,
}: {
    row: OpsBreakdownRow;
    by: ReliabilityDimension;
    socioLink: string;
    onShow: () => void;
}) {
    const name = row.label ?? (row.key || (by === 'code' ? 'No code' : 'Not recorded'));
    const latency = row.p50Ms === null ? '' : ` · p50 ${formatDuration(row.p50Ms)} · p95 ${formatDuration(row.p95Ms!)}`;
    return (
        <li data-slot="ops-breakdown-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            {by === 'socio' && row.key ? (
                <Link to={socioLink} className="min-w-0 truncate font-medium hover:underline">
                    {name}
                </Link>
            ) : (
                <span
                    className={cn(
                        'min-w-0 truncate font-medium',
                        (by === 'tool' || by === 'code') && 'font-mono text-xs',
                    )}
                >
                    {name}
                </span>
            )}
            {row.category && <CategoryBadge category={row.category} />}
            {row.code && by !== 'code' && <span className="font-mono text-xs text-muted-foreground">{row.code}</span>}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {by === 'code'
                    ? `${formatNumber(row.failed)} turns`
                    : `${formatNumber(row.failed)} of ${formatNumber(row.total)} failed (${percent.format(row.total ? row.failed / row.total : 0)})`}
                {latency}
            </span>
            {row.failed > 0 && (
                <Button variant="ghost" size="xs" onClick={onShow}>
                    Show
                </Button>
            )}
        </li>
    );
}

function FailureItem({ row, timeZone }: { row: OpsFailureRow; timeZone: string }) {
    const [open, setOpen] = useState(false);
    const Icon = open ? ChevronDown : ChevronRight;
    const labelled = labelledBy(row.rule);
    // Labels apply where the rules say Unclassified (CB-198).
    const labelable = row.category === 'unclassified' || !!labelled;
    return (
        <div data-slot="ops-failure" className="grid gap-2 py-2">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-left text-sm hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">{row.socioName ?? row.socioId}</span>
                <CategoryBadge category={row.category} />
                {labelled && <span className="text-xs text-muted-foreground">{labelled}</span>}
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {[row.level === 'tool' ? row.tool : null, row.code].filter(Boolean).join(' · ') || row.rule}
                </span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {STATUS_LABEL[row.status]} · {row.source}
                    {row.toolFailures ? ` · ${row.toolFailures} failed tools` : ''} ·{' '}
                    {formatWhen(row.startedAt, timeZone)}
                </span>
            </button>
            {open && (
                <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
                    {labelable && <FailureLabelPanel runId={row.runId} level={row.level} timeZone={timeZone} />}
                    <RunTimeline runId={row.runId} via="reliability" />
                </div>
            )}
        </div>
    );
}

function IssuesCard({
    answer,
    metric,
    setMetric,
}: {
    answer: ReturnType<typeof useOpsAnswer<OpsReliabilityIssues>>;
    metric: 'reported' | 'resolved';
    setMetric: (metric: 'reported' | 'resolved') => void;
}) {
    const issues = answer.data?.issues;
    const window = answer.data?.window;
    const label = metric === 'reported' ? 'Items reported' : 'Items resolved';
    return (
        <Card data-slot="ops-issues" className="gap-4">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-1">
                    <CardTitle>The board</CardTitle>
                    <CardDescription>
                        Items filed on the Improvements board, how fast they close, and how soon a failed turn is
                        reported with File issue in Runs. Only the person filter applies: who reported them.
                    </CardDescription>
                </div>
                <Select value={metric} onValueChange={(value) => setMetric(value as typeof metric)}>
                    <SelectTrigger size="sm" aria-label="Board chart" className="w-40">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="reported">Reported</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                    </SelectContent>
                </Select>
            </CardHeader>
            <CardContent className="grid gap-4">
                <Alert text={answer.error} />
                {!issues ? (
                    <Skeleton className="h-60 w-full" />
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                            <Stat
                                id="reported"
                                label="Reported"
                                value={count(issues.reported)}
                                note={issues.bugsReported === null ? undefined : `${count(issues.bugsReported)} bugs`}
                            />
                            <Stat
                                id="resolved"
                                label="Resolved"
                                value={count(issues.resolved)}
                                note={(() => {
                                    const moved = tileChange(issues.resolved, issues.previousResolved);
                                    return moved && `${moved.text} vs the period before`;
                                })()}
                            />
                            <Stat
                                id="resolve-time"
                                label="Time to resolve"
                                value={issues.medianResolveMs === null ? '–' : formatSpan(issues.medianResolveMs)}
                                note={
                                    issues.p90ResolveMs === null
                                        ? 'Median'
                                        : `Median · 90% within ${formatSpan(issues.p90ResolveMs)}`
                                }
                            />
                            <Stat id="open" label="Open" value={count(issues.open)} note="At the end of the range" />
                            <Stat
                                id="report-time"
                                label="Time to report"
                                value={issues.medianReportMs === null ? '–' : formatSpan(issues.medianReportMs)}
                                note={
                                    issues.failuresReported === null
                                        ? 'Failed turns filed from Runs'
                                        : `Median · ${count(issues.failuresReported)} failed ${issues.failuresReported === 1 ? 'turn' : 'turns'} filed from Runs${issues.p90ReportMs === null ? '' : ` · 90% within ${formatSpan(issues.p90ReportMs)}`}`
                                }
                            />
                        </div>
                        {issues.points.length && window ? (
                            <SeriesChart
                                kind={window.bucket === 'hour' ? 'line' : 'bar'}
                                label={label}
                                xName={window.bucket}
                                yName={label.toLowerCase()}
                                points={issues.points.map((point) => ({
                                    label: bucketLabel(point.at, window.bucket, window.timeZone),
                                    value: point[metric],
                                }))}
                            />
                        ) : (
                            <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                                No items on the board yet.
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
