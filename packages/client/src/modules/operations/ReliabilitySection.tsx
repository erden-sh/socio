import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { FAILURE_CATEGORIES, type FailureCategory } from '@socio/shared/failure-taxonomy';
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
import { onDemand } from '../../i18n/on-demand';
import { formatDuration } from '../runs/format';
import { RunTimeline } from '../runs/RunTimeline';

import { FailureLabelPanel, labeledBy } from './FailureLabelPanel';
import { formatWhen, useOpsFormat } from './format';
import { opsPath } from './sections';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const percent = numberFormat({ style: 'percent', maximumFractionDigits: 1 });
const points = numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const FAILURES = FAILURE_CATEGORIES.filter((c) => c !== 'stopped');
const TOOL = /^[\w.:@+-]{1,120}$/;

const rate = (part: number | null, whole: number | null) =>
    part === null || whole === null ? null : whole ? part / whole : 0;

/** A span of hours or days, in words: "3 h", "2.5 days". */
function useFormatSpan() {
    const { t } = useTranslation(['operations.reliability']);
    return (ms: number) => {
        const hours = ms / 3_600_000;
        if (hours < 1) {
            return t('operations.reliability:span.minutes', { n: Math.max(1, Math.round(ms / 60_000)) });
        }
        if (hours < 48) {
            return t('operations.reliability:span.hours', { n: Math.round(hours) });
        }
        return t('operations.reliability:span.days', { count: Math.round((hours / 24) * 10) / 10 });
    };
}

/** A failure category's name, with its rule beside it for whoever looks. */
function CategoryBadge({ category }: { category: FailureCategory }) {
    const { t } = useTranslation(['operations.reliability']);
    return (
        <Badge
            variant={category === 'unclassified' ? 'outline' : 'secondary'}
            data-category={category}
            title={t(`operations.reliability:hint.${category}`)}
        >
            {t(`operations.reliability:category.${category}`)}
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
    const { t } = useTranslation(['operations.reliability', 'operations', 'operations.dashboard']);
    const { bucketLabel, statusLine, tileChange } = useOpsFormat();
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
    const versus = (change: string) => t('operations.reliability:versus-before', { change });
    const tiles = s && (
        <>
            <Stat
                id="failure-rate"
                label={t('operations.reliability:tiles.failure-rate')}
                value={now === null ? '–' : percent.format(now)}
                note={
                    change === null
                        ? t('operations.reliability:tiles.of-turns', {
                              count: s.turns ?? 0,
                              failures: count(s.failures),
                              turns: count(s.turns),
                          })
                        : versus(
                              t('operations.reliability:tiles.points', {
                                  change: `${change > 0 ? '+' : change < 0 ? '−' : '±'}${points.format(Math.abs(change))}`,
                              }),
                          )
                }
                tone={change === null || change === 0 ? undefined : change > 0 ? 'bad' : 'good'}
            />
            <Stat
                id="failures"
                label={t('operations.reliability:tiles.failures')}
                value={count(s.failures)}
                note={moved && versus(moved.text)}
                tone={!moved || moved.direction === 'same' ? undefined : moved.direction === 'up' ? 'bad' : 'good'}
            />
            <Stat
                id="interrupted"
                label={t('operations.reliability:tiles.interrupted')}
                value={count(s.interrupted)}
                note={t('operations.reliability:tiles.interrupted-note')}
            />
            <Stat
                id="stopped"
                label={t('operations.reliability:tiles.stopped')}
                value={count(s.stopped)}
                note={t('operations.reliability:tiles.stopped-note')}
            />
            <Stat
                id="tool-failures"
                label={t('operations.reliability:tiles.tool-failures')}
                value={count(s.toolFailures)}
                note={
                    s.toolCalls === null
                        ? undefined
                        : t('operations.reliability:tiles.of-calls', { count: s.toolCalls })
                }
            />
            <Stat
                id="retries"
                label={t('operations.reliability:tiles.retries')}
                value={count(s.retries)}
                note={
                    s.retriedTurns === null
                        ? undefined
                        : t('operations.reliability:tiles.retries-note', {
                              count: s.retriedTurns,
                              fallbacks: count(s.fallbacks),
                          })
                }
            />
        </>
    );

    const window = series.data?.window;
    const index = charted === 'all' ? -1 : FAILURE_CATEGORIES.indexOf(charted);
    const chartLabel =
        charted === 'all'
            ? t('operations.reliability:tiles.failure-rate')
            : t('operations.reliability:chart.category-share', {
                  category: t(`operations.reliability:category.${charted}`),
              });
    const chartPoints = (series.data?.points ?? []).map((point) => ({
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
            <section
                aria-label={t('operations.dashboard:totals')}
                aria-busy={summary.loading}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
                {tiles ?? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-21 rounded-xl" />)}
            </section>

            <Card data-slot="ops-failure-chart" className="gap-4">
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-1">
                        <CardTitle>{chartLabel}</CardTitle>
                        <CardDescription>
                            {t('operations.reliability:chart.description', { context: window?.bucket })}
                        </CardDescription>
                    </div>
                    <Select value={charted} onValueChange={(value) => setCharted(value as typeof charted)}>
                        <SelectTrigger
                            size="sm"
                            aria-label={t('operations.reliability:chart.category')}
                            className="w-60"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t('operations.reliability:chart.every')}</SelectItem>
                            {FAILURES.map((c) => (
                                <SelectItem key={c} value={c}>
                                    {t(`operations.reliability:category.${c}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    <Alert text={series.error} />
                    {series.data && chartPoints.some((point) => point.value !== null) ? (
                        <SeriesChart
                            kind={window?.bucket === 'hour' ? 'line' : 'bar'}
                            label={chartLabel}
                            xName={window!.bucket}
                            yName={t('operations.reliability:chart.y')}
                            points={chartPoints}
                        />
                    ) : series.data ? (
                        <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                            {t('operations.reliability:chart.empty')}
                        </p>
                    ) : (
                        <Skeleton className="h-60 w-full" />
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-categories" className="gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.reliability:categories.title')}</CardTitle>
                    <CardDescription>{t('operations.reliability:categories.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    {!s ? (
                        <Skeleton className="h-40 w-full" />
                    ) : !categories.length ? (
                        <p className="m-0 text-sm text-muted-foreground">
                            {t('operations.reliability:categories.empty')}
                        </p>
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
                                            <span className="font-medium">
                                                {t(`operations.reliability:category.${id}`)}
                                            </span>
                                            <span className="text-xs text-muted-foreground tabular-nums">
                                                {[
                                                    t('operations.reliability:categories.turns', { count: c.turns }),
                                                    t('operations.reliability:categories.tool-calls', {
                                                        count: c.tools,
                                                    }),
                                                    ...(id === 'runtime_error' && s.interrupted
                                                        ? [
                                                              t('operations.reliability:categories.interrupted', {
                                                                  count: s.interrupted,
                                                              }),
                                                          ]
                                                        : []),
                                                ].join(' · ')}
                                            </span>
                                            {total > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="xs"
                                                    className="ml-auto"
                                                    onClick={() => drill({ category: id })}
                                                >
                                                    {t('operations.reliability:show')}
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
                                            {t(`operations.reliability:hint.${id}`)}
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
                        <CardTitle>{t('operations.reliability:breakdown.title')}</CardTitle>
                        <CardDescription>
                            {t('operations.reliability:breakdown.description', {
                                context: by === 'tool' || by === 'code' ? by : undefined,
                            })}
                        </CardDescription>
                    </div>
                    <Select value={by} onValueChange={(value) => setBy(value as ReliabilityDimension)}>
                        <SelectTrigger
                            size="sm"
                            aria-label={t('operations.reliability:breakdown.group-by')}
                            className="w-40"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {RELIABILITY_DIMENSIONS.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {t(`operations.reliability:breakdown.by.${item}`)}
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
                        <p className="m-0 text-sm text-muted-foreground">
                            {t('operations.reliability:breakdown.empty')}
                        </p>
                    ) : (
                        <ul
                            aria-label={t(`operations.reliability:breakdown.by.${breakdown.data.by}`)}
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
                    <CardTitle>{t('operations.reliability:friction.title')}</CardTitle>
                    <CardDescription>{t('operations.reliability:friction.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <Alert text={friction.error} />
                    {!friction.data ? (
                        <Skeleton className="h-24 w-full" />
                    ) : !friction.data.rows.length ? (
                        <p className="m-0 text-sm text-muted-foreground">
                            {t('operations.reliability:friction.empty', {
                                when: formatWhen(friction.data.from, timeZone),
                            })}
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
                                        {[row.tool, row.code].filter(Boolean).join(' · ') ||
                                            t('operations.reliability:no-code')}
                                    </span>
                                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                        {[
                                            t('operations.reliability:friction.people', { count: row.people }),
                                            t('operations.reliability:friction.times', {
                                                count: row.failures,
                                                most: row.mostForOne,
                                            }),
                                            t('operations.reliability:friction.last', {
                                                when: formatWhen(row.lastAt, timeZone),
                                            }),
                                        ].join(' · ')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <Card data-slot="ops-failures" className="scroll-mt-4 gap-4" ref={recent}>
                <CardHeader>
                    <CardTitle>{t('operations.reliability:failures.title')}</CardTitle>
                    <CardDescription>{t('operations.reliability:failures.description')}</CardDescription>
                    {(category || tool) && (
                        <div className="flex flex-wrap gap-2 pt-1">
                            {category && (
                                <Chip
                                    label={t(`operations.reliability:category.${category}`)}
                                    onClear={() => drill({ tool })}
                                />
                            )}
                            {tool && <Chip label={tool} onClear={() => drill({ category })} />}
                        </div>
                    )}
                </CardHeader>
                <CardContent>
                    <InfiniteList
                        list={failures}
                        label={t('operations.reliability:failures.title')}
                        itemKey={(row) => row.runId}
                        empty={t('operations.reliability:failures.empty')}
                        renderItem={(row) => <FailureItem row={row} timeZone={timeZone} />}
                    />
                </CardContent>
            </Card>

            <IssuesCard answer={issues} metric={issueMetric} setMetric={setIssueMetric} />
        </>
    );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
    const { t } = useTranslation(['operations.reliability']);
    return (
        <Badge variant="secondary" className="gap-1 pr-1">
            {label}
            <button
                type="button"
                aria-label={t('operations.reliability:failures.clear', { name: label })}
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
    const { t } = useTranslation(['operations.reliability']);
    const name =
        row.label ??
        (row.key ||
            (by === 'code' ? t('operations.reliability:no-code') : t('operations.reliability:breakdown.not-recorded')));
    const latency =
        row.p50Ms === null
            ? ''
            : ` · ${t('operations.reliability:breakdown.latency', {
                  p50: formatDuration(row.p50Ms),
                  p95: formatDuration(row.p95Ms!),
              })}`;
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
                    ? t('operations.reliability:breakdown.turns', { count: row.failed })
                    : t('operations.reliability:breakdown.failed', {
                          failed: row.failed,
                          total: row.total,
                          share: row.total ? row.failed / row.total : 0,
                      })}
                {latency}
            </span>
            {row.failed > 0 && (
                <Button variant="ghost" size="xs" onClick={onShow}>
                    {t('operations.reliability:show')}
                </Button>
            )}
        </li>
    );
}

function FailureItem({ row, timeZone }: { row: OpsFailureRow; timeZone: string }) {
    const { t } = useTranslation(['operations.reliability']);
    const [open, setOpen] = useState(false);
    const Icon = open ? ChevronDown : ChevronRight;
    const labeler = labeledBy(row.rule);
    // Labels apply where the rules say Unclassified (CB-198).
    const labelable = row.category === 'unclassified' || !!labeler;
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
                {labeler && (
                    <span className="text-xs text-muted-foreground">
                        {t('operations.reliability:label.by', { context: labeler === 'admin' ? 'admin' : undefined })}
                    </span>
                )}
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {[row.level === 'tool' ? row.tool : null, row.code].filter(Boolean).join(' · ') || row.rule}
                </span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {[
                        t(`operations.reliability:failures.status.${row.status}`),
                        row.source,
                        ...(row.toolFailures
                            ? [t('operations.reliability:failures.failed-tools', { count: row.toolFailures })]
                            : []),
                        formatWhen(row.startedAt, timeZone),
                    ].join(' · ')}
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

/** The board's card, last on the page: its words load once the page is in (operations.reliability-board). */
const IssuesCard = onDemand(['operations.reliability-board', 'operations.reliability'], BoardCard);

function BoardCard({
    answer,
    metric,
    setMetric,
}: {
    answer: ReturnType<typeof useOpsAnswer<OpsReliabilityIssues>>;
    metric: 'reported' | 'resolved';
    setMetric: (metric: 'reported' | 'resolved') => void;
}) {
    const { t } = useTranslation(['operations.reliability-board', 'operations.reliability']);
    const { bucketLabel, tileChange } = useOpsFormat();
    const formatSpan = useFormatSpan();
    const issues = answer.data?.issues;
    const window = answer.data?.window;
    const label = t(`operations.reliability-board:series.${metric}`);
    return (
        <Card data-slot="ops-issues" className="gap-4">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-1">
                    <CardTitle>{t('operations.reliability-board:title')}</CardTitle>
                    <CardDescription>{t('operations.reliability-board:description')}</CardDescription>
                </div>
                <Select value={metric} onValueChange={(value) => setMetric(value as typeof metric)}>
                    <SelectTrigger size="sm" aria-label={t('operations.reliability-board:chart')} className="w-40">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="reported">{t('operations.reliability-board:reported')}</SelectItem>
                        <SelectItem value="resolved">{t('operations.reliability-board:resolved')}</SelectItem>
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
                                label={t('operations.reliability-board:reported')}
                                value={count(issues.reported)}
                                note={
                                    issues.bugsReported === null
                                        ? undefined
                                        : t('operations.reliability-board:bugs', { count: issues.bugsReported })
                                }
                            />
                            <Stat
                                id="resolved"
                                label={t('operations.reliability-board:resolved')}
                                value={count(issues.resolved)}
                                note={(() => {
                                    const moved = tileChange(issues.resolved, issues.previousResolved);
                                    return moved && t('operations.reliability:versus-before', { change: moved.text });
                                })()}
                            />
                            <Stat
                                id="resolve-time"
                                label={t('operations.reliability-board:resolve-time')}
                                value={issues.medianResolveMs === null ? '–' : formatSpan(issues.medianResolveMs)}
                                note={[
                                    t('operations.reliability-board:median'),
                                    ...(issues.p90ResolveMs === null
                                        ? []
                                        : [
                                              t('operations.reliability-board:within', {
                                                  span: formatSpan(issues.p90ResolveMs),
                                              }),
                                          ]),
                                ].join(' · ')}
                            />
                            <Stat
                                id="open"
                                label={t('operations.reliability-board:open')}
                                value={count(issues.open)}
                                note={t('operations.reliability-board:open-note')}
                            />
                            <Stat
                                id="report-time"
                                label={t('operations.reliability-board:report-time')}
                                value={issues.medianReportMs === null ? '–' : formatSpan(issues.medianReportMs)}
                                note={
                                    issues.failuresReported === null
                                        ? t('operations.reliability-board:filed')
                                        : [
                                              t('operations.reliability-board:median'),
                                              t('operations.reliability-board:filed-count', {
                                                  count: issues.failuresReported,
                                              }),
                                              ...(issues.p90ReportMs === null
                                                  ? []
                                                  : [
                                                        t('operations.reliability-board:within', {
                                                            span: formatSpan(issues.p90ReportMs),
                                                        }),
                                                    ]),
                                          ].join(' · ')
                                }
                            />
                        </div>
                        {issues.points.length && window ? (
                            <SeriesChart
                                kind={window.bucket === 'hour' ? 'line' : 'bar'}
                                label={label}
                                xName={window.bucket}
                                yName={t(`operations.reliability-board:axis.${metric}`)}
                                points={issues.points.map((point) => ({
                                    label: bucketLabel(point.at, window.bucket, window.timeZone),
                                    value: point[metric],
                                }))}
                            />
                        ) : (
                            <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                                {t('operations.reliability-board:empty')}
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
