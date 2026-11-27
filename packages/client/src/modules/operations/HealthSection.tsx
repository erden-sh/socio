import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import { opsSearch } from '@socio/shared/operations/operations';
import {
    GOAL_STATES,
    HEALTH_METRICS,
    type HealthFacts,
    type HealthLive,
    type HealthLongRunRow,
    type HealthMetric,
    type HealthRunRow,
    type HealthScheduleRow,
    type LatencyRow,
    type OpsHealth,
    type OpsHealthSeries,
    type Spread,
} from '@socio/shared/operations/operations-health';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { onDemand } from '../../i18n/on-demand';
import { megabytes } from '../settings/setup-lines';

import { formatWhen, useOpsFormat } from './format';
import { formatAgo, formatMs, formatShare } from './health-format';
import { opsPath } from './sections';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const ALERT = 'text-destructive';
const GOOD = 'text-emerald-700 dark:text-emerald-400';

/** A number with its label, like Overview's tiles but without a change. */
function Stat({
    label,
    value,
    hint,
    tone,
    id,
}: {
    label: string;
    value: ReactNode;
    hint?: ReactNode;
    tone?: 'alert' | 'good';
    id: string;
}) {
    return (
        <Card data-slot="ops-health-stat" data-stat={id} className="gap-1 px-4 py-3 shadow-xs">
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong className={cn('text-2xl font-semibold tabular-nums', tone === 'alert' && ALERT)}>{value}</strong>
            <span className={cn('min-h-4 text-xs text-muted-foreground', tone === 'good' && GOOD)}>{hint}</span>
        </Card>
    );
}

const Stats = ({ children, label }: { children: ReactNode; label: string }) => (
    <div aria-label={label} role="group" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {children}
    </div>
);

const count = (value: number | undefined) => (value === undefined ? '–' : formatNumber(value));

/** The analytics store's sources, as people know them: every ETL step's (`operations.health:freshness.source.*`). */
const SOURCES = [
    'agent_runs',
    'dimensions',
    'job_runs',
    'runs',
    'schedules',
    'retention',
    // Reliability (CB-189).
    'taxonomy',
    // Failure labels (CB-198).
    'labels',
    'session_labels',
    'issues',
    // Activity and Value (CB-190).
    'approval_audit',
    'space_writes',
    'message_reactions',
    'memories',
    // Knowledge and Capabilities (CB-191).
    'pages',
    'page_revisions',
    'data_audit',
    'data_dataset_days',
    'storage',
    'dot_requests',
    // Grounding (CB-194).
    'run_refs',
    'issue_runs',
    // Cost (CB-195, CB-196).
    'cost',
    // Rooms (CB-218).
    'work_cycles',
] as const;
const isSource = (id: string): id is (typeof SOURCES)[number] => (SOURCES as readonly string[]).includes(id);

function Section({
    title,
    description,
    children,
    slot,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    slot: string;
}) {
    return (
        <Card data-slot={slot} className="gap-4">
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent className="grid gap-4">{children}</CardContent>
        </Card>
    );
}

/** A row of a breakdown, with a bar for its share of the largest. */
function BarRow({ label, value, max, detail }: { label: ReactNode; value: number; max: number; detail: ReactNode }) {
    return (
        <li className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 truncate font-medium">{label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>
            </div>
            <div aria-hidden className="h-1.5 rounded-full bg-muted">
                <div
                    className="h-full rounded-full bg-chart-1"
                    style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }}
                />
            </div>
        </li>
    );
}

const Empty = ({ children }: { children: ReactNode }) => (
    <p className="m-0 py-2 text-sm text-muted-foreground">{children}</p>
);

const TOKEN_VIEWS = ['model', 'socio', 'person', 'reasoning'] as const;
type TokenView = (typeof TOKEN_VIEWS)[number];

function Tokens({ facts }: { facts: HealthFacts }) {
    const { t } = useTranslation(['operations.health-numbers']);
    const { query } = useOpsQuery();
    const [view, setView] = useState<TokenView>('model');
    const rows =
        view === 'model' ? facts.tokens.byModel : view === 'socio' ? facts.tokens.bySocio : facts.tokens.byPerson;
    const max = Math.max(0, ...rows.map((row) => row.input + row.output));
    const reasoning = facts.tokens.byReasoning;
    const maxReasoning = Math.max(0, ...reasoning.map((row) => row.output));
    return (
        <>
            <Select value={view} onValueChange={(value) => setView(value as TokenView)}>
                <SelectTrigger size="sm" aria-label={t('operations.health-numbers:tokens.title')} className="w-52">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {TOKEN_VIEWS.map((item) => (
                        <SelectItem key={item} value={item}>
                            {t(`operations.health-numbers:tokens.view.${item}`)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {view === 'reasoning' ? (
                reasoning.length ? (
                    <>
                        <ul
                            aria-label={t('operations.health-numbers:tokens.list.reasoning')}
                            className="m-0 grid list-none divide-y p-0"
                        >
                            {reasoning.map((row) => (
                                <BarRow
                                    key={row.kind}
                                    label={t(`operations.health-numbers:tokens.reasoning.${row.kind}`)}
                                    value={row.output}
                                    max={maxReasoning}
                                    detail={[
                                        t('operations.health-numbers:tokens.turns', { count: row.turns }),
                                        t('operations.health-numbers:tokens.output', { n: row.output }),
                                        row.reasoning === null
                                            ? t('operations.health-numbers:tokens.not-reported')
                                            : t('operations.health-numbers:tokens.reasoning-in', {
                                                  reasoning: row.reasoning,
                                                  count: row.reportedTurns,
                                              }),
                                    ].join(' · ')}
                                />
                            ))}
                        </ul>
                        <p className="m-0 text-xs text-muted-foreground">
                            {t('operations.health-numbers:tokens.reasoning-note')}
                        </p>
                    </>
                ) : (
                    <Empty>{t('operations.health-numbers:no-turns')}</Empty>
                )
            ) : rows.length ? (
                <ul
                    aria-label={t(`operations.health-numbers:tokens.list.${view}`)}
                    className="m-0 grid list-none divide-y p-0"
                >
                    {rows.map((row) => (
                        <BarRow
                            key={row.key}
                            label={
                                view === 'socio' ? (
                                    <Link
                                        to={opsPath(
                                            'health',
                                            opsSearch({
                                                ...query,
                                                filters: { ...query.filters, socio: row.key },
                                            }),
                                        )}
                                        className="hover:underline"
                                    >
                                        {row.name ?? row.key}
                                    </Link>
                                ) : view === 'model' && row.key === 'unknown' ? (
                                    t('operations.health-numbers:not-recorded')
                                ) : (
                                    (row.name ?? row.key)
                                )
                            }
                            value={row.input + row.output}
                            max={max}
                            detail={`${t('operations.health-numbers:tokens.in-out', { input: row.input, output: row.output })} · ${t('operations.health-numbers:tokens.turns', { count: row.turns })}`}
                        />
                    ))}
                </ul>
            ) : (
                <Empty>{t('operations.health-numbers:no-turns')}</Empty>
            )}
        </>
    );
}

function LatencyList({
    rows,
    label,
    empty,
    errors,
}: {
    rows: LatencyRow[];
    label: string;
    empty: string;
    errors?: boolean;
}) {
    const { t } = useTranslation(['operations.health-numbers']);
    if (!rows.length) {
        return <Empty>{empty}</Empty>;
    }
    const max = Math.max(0, ...rows.map((row) => row.p95 ?? 0));
    return (
        <ul aria-label={label} className="m-0 grid list-none divide-y p-0">
            {rows.map((row) => (
                <BarRow
                    key={row.key}
                    label={row.key === 'unknown' ? t('operations.health-numbers:not-recorded') : row.key}
                    value={row.p95 ?? 0}
                    max={max}
                    detail={
                        <>
                            {t('operations.health-numbers:latency.row', {
                                p50: formatMs(row.p50),
                                p95: formatMs(row.p95),
                                n: row.n,
                            })}
                            {errors && row.errors ? (
                                <span className={ALERT}>
                                    {' '}
                                    · {t('operations.health-numbers:latency.row-failed', { n: row.errors })}
                                </span>
                            ) : null}
                        </>
                    }
                />
            ))}
        </ul>
    );
}

function Latency({ facts }: { facts: HealthFacts | null }) {
    const { t } = useTranslation(['operations.health-numbers']);
    const { bucketLabel } = useOpsFormat();
    const { search } = useOpsQuery();
    const [metric, setMetric] = useState<HealthMetric>('first_output');
    const series = useOpsAnswer<OpsHealthSeries>(`/operations/health/series/${metric}${search}`);
    const points = series.data?.points ?? [];
    const label = t(`operations.health-numbers:latency.metric.${metric}`);
    /** "p50 420 ms · 120 rounds". */
    const spreadHint = (spread: Spread | undefined, unit: 'rounds' | 'calls' | 'turns' | 'runs') =>
        spread && spread.n
            ? t(`operations.health-numbers:latency.spread.${unit}`, { p50: formatMs(spread.p50), count: spread.n })
            : t('operations.health-numbers:none-in-range');
    const q = facts?.queues;
    const l = facts?.latency;
    return (
        <Section
            slot="ops-health-latency"
            title={t('operations.health-numbers:latency.title')}
            description={t('operations.health-numbers:latency.description')}
        >
            <Stats label={t('operations.health-numbers:latency.stats')}>
                <Stat
                    id="first-output"
                    label={t('operations.health-numbers:latency.first-output')}
                    value={formatMs(l?.firstOutput.p95)}
                    hint={spreadHint(l?.firstOutput, 'rounds')}
                />
                <Stat
                    id="tools"
                    label={t('operations.health-numbers:latency.tools')}
                    value={formatMs(l?.tools.p95)}
                    hint={spreadHint(l?.tools, 'calls')}
                />
                <Stat
                    id="turn-queue"
                    label={t('operations.health-numbers:latency.turn-queue')}
                    value={formatMs(q?.turns.p95)}
                    hint={spreadHint(q?.turns, 'turns')}
                />
                <Stat
                    id="job-wait"
                    label={t('operations.health-numbers:latency.job-wait')}
                    value={formatMs(q?.jobWait.p95)}
                    hint={spreadHint(q?.jobWait, 'runs')}
                />
                <Stat
                    id="job-wake"
                    label={t('operations.health-numbers:latency.job-wake')}
                    value={formatMs(q?.jobWake.p95)}
                    hint={spreadHint(q?.jobWake, 'runs')}
                />
                <Stat
                    id="schedule-late"
                    label={t('operations.health-numbers:latency.schedule-late')}
                    value={formatMs(q?.scheduleLate.p95)}
                    hint={spreadHint(q?.scheduleLate, 'runs')}
                />
            </Stats>
            <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="m-0 text-sm font-medium">
                        {t('operations.health-numbers:latency.chart-title', { metric: label })}
                    </h3>
                    <Select value={metric} onValueChange={(value) => setMetric(value as HealthMetric)}>
                        <SelectTrigger
                            size="sm"
                            aria-label={t('operations.health-numbers:latency.chart')}
                            className="w-56"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {HEALTH_METRICS.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {t(`operations.health-numbers:latency.metric.${item}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {series.data && points.some((point) => point.n > 0) ? (
                    <div data-slot="ops-health-chart" className={cn(series.stale && 'opacity-60')}>
                        <SeriesChart
                            kind={series.data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={t('operations.health-numbers:latency.chart-title', { metric: label })}
                            xName={series.data.window.bucket}
                            yName={t('operations.health-numbers:latency.y')}
                            points={points.map((point) => ({
                                label: bucketLabel(point.at, series.data!.window.bucket, series.data!.window.timeZone),
                                value: point.p95,
                            }))}
                        />
                    </div>
                ) : series.data ? (
                    <Empty>{t('operations.health-numbers:latency.empty')}</Empty>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">{t('operations.health-numbers:latency.by-model')}</h3>
                    {l ? (
                        <LatencyList
                            rows={l.firstOutputByModel}
                            label={t('operations.health-numbers:latency.by-model')}
                            empty={t('operations.health-numbers:latency.by-model-empty')}
                        />
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </div>
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">{t('operations.health-numbers:latency.tools-title')}</h3>
                    {l ? (
                        <LatencyList
                            rows={l.byTool}
                            label={t('operations.health-numbers:latency.tools-label')}
                            empty={t('operations.health-numbers:latency.tools-empty')}
                            errors
                        />
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </div>
            </div>
        </Section>
    );
}

const SCHEDULE_TONE: Record<string, 'destructive' | 'secondary' | 'outline'> = {
    failing: 'destructive',
    overdue: 'destructive',
    paused: 'secondary',
};

function Schedules({ facts }: { facts: HealthFacts | null }) {
    const { t } = useTranslation(['operations.health-numbers']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const schedules = useCursorList<HealthScheduleRow>(`/operations/health/schedules${search}`);
    const runs = useCursorList<HealthRunRow>(`/operations/health/runs${search}`);
    const s = facts?.schedules;
    const g = facts?.goals;
    return (
        <Section
            slot="ops-health-schedules"
            title={t('operations.health-numbers:schedules.title')}
            description={t('operations.health-numbers:schedules.description')}
        >
            <Stats label={t('operations.health-numbers:schedules.stats')}>
                <Stat
                    id="failing"
                    label={t('operations.health-numbers:schedules.state.failing')}
                    value={count(s?.failing)}
                    tone={s?.failing ? 'alert' : undefined}
                    hint={t('operations.health-numbers:schedules.failing-note')}
                />
                <Stat
                    id="overdue"
                    label={t('operations.health-numbers:schedules.state.overdue')}
                    value={count(s?.overdue)}
                    tone={s?.overdue ? 'alert' : undefined}
                    hint={t('operations.health-numbers:schedules.overdue-note')}
                />
                <Stat
                    id="paused"
                    label={t('operations.health-numbers:schedules.state.paused')}
                    value={count(s?.paused)}
                    hint={s ? t('operations.health-numbers:schedules.on-time', { n: s.ok }) : undefined}
                />
                <Stat
                    id="runs"
                    label={t('operations.health-numbers:schedules.runs')}
                    value={count(s?.runs)}
                    tone={s?.failedRuns ? 'alert' : undefined}
                    hint={
                        s
                            ? t('operations.health-numbers:schedules.runs-note', {
                                  failed: s.failedRuns,
                                  late: s.lateRuns,
                              })
                            : undefined
                    }
                />
            </Stats>
            <Stats label={t('operations.health-numbers:schedules.goals')}>
                {GOAL_STATES.map((state) => (
                    <Stat
                        key={state}
                        id={`goal-${state}`}
                        label={t(`operations.health-numbers:schedules.goal.${state}`)}
                        value={count(g?.[state])}
                        tone={state === 'stalled' && g?.stalled ? 'alert' : undefined}
                        hint={
                            state === 'stalled'
                                ? t('operations.health-numbers:schedules.stalled-note')
                                : state === 'done' && g
                                  ? t('operations.health-numbers:in-range', { n: g.doneInRange })
                                  : state === 'cancelled' && g
                                    ? t('operations.health-numbers:in-range', { n: g.cancelledInRange })
                                    : undefined
                        }
                    />
                ))}
            </Stats>
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">{t('operations.health-numbers:schedules.need-look')}</h3>
                    <InfiniteList
                        list={schedules}
                        label={t('operations.health-numbers:schedules.need-look-label')}
                        itemKey={(row) => row.id}
                        empty={t('operations.health-numbers:schedules.all-on-time')}
                        renderItem={(row) => (
                            <div
                                data-slot="ops-health-schedule"
                                className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm"
                            >
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span className="min-w-0 truncate font-medium">
                                        {row.title ?? t('operations.health-numbers:schedules.untitled')}
                                    </span>
                                    <Badge variant={SCHEDULE_TONE[row.state] ?? 'outline'}>
                                        {t(`operations.health-numbers:schedules.state.${row.state}`)}
                                    </Badge>
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {row.socioName ?? row.socioId ?? ''}
                                    </span>
                                </div>
                                <span className="text-xs text-muted-foreground">
                                    {row.state === 'overdue' && row.nextRunAt !== null
                                        ? t('operations.health-numbers:schedules.was-due', {
                                              when: formatWhen(row.nextRunAt, timeZone),
                                          })
                                        : (row.error ??
                                          t('operations.health-numbers:schedules.changed', {
                                              when: formatWhen(row.updatedAt, timeZone),
                                          }))}
                                </span>
                            </div>
                        )}
                    />
                </div>
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">{t('operations.health-numbers:schedules.late-runs')}</h3>
                    <InfiniteList
                        list={runs}
                        label={t('operations.health-numbers:schedules.late-runs-label')}
                        itemKey={(row) => row.id}
                        empty={t('operations.health-numbers:schedules.late-runs-empty')}
                        renderItem={(row) => (
                            <div
                                data-slot="ops-health-run"
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium">
                                    {row.title ?? t('operations.health-numbers:schedules.removed')}
                                </span>
                                {row.status === 'failed' || row.status === 'interrupted' ? (
                                    <Badge variant="destructive">
                                        {row.status === 'failed'
                                            ? t('operations.health-numbers:failed')
                                            : t('operations.health-numbers:schedules.interrupted')}
                                    </Badge>
                                ) : (
                                    <Badge variant="secondary">{t('operations.health-numbers:schedules.late')}</Badge>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {row.lateMs !== null && row.lateMs > 0
                                        ? `${t('operations.health-numbers:schedules.late-by', { time: formatMs(row.lateMs) })} · `
                                        : ''}
                                    {formatWhen(row.startedAt, timeZone)}
                                </span>
                            </div>
                        )}
                    />
                </div>
            </div>
        </Section>
    );
}

const LONG_STATUS = ['running', 'waiting', 'done', 'failed', 'cancelled'] as const;
const isLongStatus = (status: string): status is (typeof LONG_STATUS)[number] =>
    (LONG_STATUS as readonly string[]).includes(status);

function LongRuns({ facts }: { facts: HealthFacts | null }) {
    const { t } = useTranslation(['operations.health-numbers']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<HealthLongRunRow>(`/operations/health/long-runs${search}`);
    const l = facts?.longRuns;
    const j = facts?.jobRuns;
    return (
        <Section
            slot="ops-health-long-runs"
            title={t('operations.health-numbers:long-runs.title')}
            description={t('operations.health-numbers:long-runs.description')}
        >
            <Stats label={t('operations.health-numbers:long-runs.stats')}>
                <Stat
                    id="long-open"
                    label={t('operations.health-numbers:long-runs.open')}
                    value={l ? formatNumber(l.running + l.waiting) : '–'}
                    hint={l ? t('operations.health-numbers:long-runs.waiting', { n: l.waiting }) : undefined}
                />
                <Stat
                    id="dead"
                    label={t('operations.health-numbers:long-runs.dead')}
                    value={count(l?.deadItems)}
                    tone={l?.deadItems ? 'alert' : undefined}
                    hint={t('operations.health-numbers:long-runs.dead-note')}
                />
                <Stat
                    id="long-finished"
                    label={t('operations.health-numbers:long-runs.finished')}
                    value={count(l?.done)}
                    hint={
                        l
                            ? t('operations.health-numbers:long-runs.finished-note', {
                                  failed: l.failed,
                                  canceled: l.cancelled,
                              })
                            : undefined
                    }
                    tone={l?.failed ? 'alert' : undefined}
                />
                <Stat
                    id="job-runs"
                    label={t('operations.health-numbers:long-runs.job-runs')}
                    value={count(j?.total)}
                    hint={j ? t('operations.health-numbers:long-runs.job-failed', { n: j.failed }) : undefined}
                    tone={j?.failed ? 'alert' : undefined}
                />
            </Stats>
            <InfiniteList
                list={list}
                label={t('operations.health-numbers:long-runs.list')}
                itemKey={(row) => row.id}
                empty={t('operations.health-numbers:long-runs.empty')}
                renderItem={(row) => (
                    <div data-slot="ops-health-long-run" className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="min-w-0 truncate font-medium">{row.jobName ?? row.jobId}</span>
                            <Badge
                                variant={
                                    row.status === 'failed'
                                        ? 'destructive'
                                        : row.status === 'running' || row.status === 'waiting'
                                          ? 'default'
                                          : 'secondary'
                                }
                            >
                                {isLongStatus(row.status)
                                    ? t(`operations.health-numbers:long-runs.status.${row.status}`)
                                    : row.status}
                            </Badge>
                            <span className="ml-auto text-xs text-muted-foreground">
                                {row.socioName ?? row.socioId ?? ''}
                            </span>
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {t('operations.health-numbers:long-runs.items', {
                                done: row.itemsDone,
                                pending: row.itemsPending,
                            })}
                            {row.itemsDead ? (
                                <span className={ALERT}>
                                    {' '}
                                    · {t('operations.health-numbers:long-runs.dead-items', { n: row.itemsDead })}
                                </span>
                            ) : null}
                            {` · ${[
                                t('operations.health-numbers:long-runs.batches', { count: row.batches }),
                                ...(row.retries
                                    ? [t('operations.health-numbers:long-runs.retries', { count: row.retries })]
                                    : []),
                                t('operations.health-numbers:long-runs.changed', {
                                    when: formatWhen(row.updatedAt, timeZone),
                                }),
                            ].join(' · ')}`}
                        </span>
                        {(row.lastError || row.waitReason) && (
                            <span className={cn('text-xs', row.lastError ? ALERT : 'text-muted-foreground')}>
                                {row.lastError ??
                                    t('operations.health-numbers:long-runs.waiting-for', {
                                        reason: row.waitReason ?? '',
                                    })}
                            </span>
                        )}
                    </div>
                )}
            />
        </Section>
    );
}

function Coverage({ facts }: { facts: HealthFacts | null }) {
    const { t } = useTranslation(['operations.health-numbers']);
    return (
        <Section
            slot="ops-health-coverage"
            title={t('operations.health-numbers:coverage.title')}
            description={t('operations.health-numbers:coverage.description')}
        >
            {facts ? (
                <ul
                    aria-label={t('operations.health-numbers:coverage.title')}
                    className="m-0 grid list-none divide-y p-0"
                >
                    {facts.coverage.map((row) => {
                        const short = row.total > 0 && row.covered < row.total;
                        return (
                            <li
                                key={row.id}
                                data-slot="ops-health-coverage-row"
                                data-coverage={row.id}
                                className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm"
                            >
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                    <span className="font-medium">
                                        {t(`operations.health-numbers:coverage.${row.id}`)}
                                    </span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {row.total
                                            ? t('operations.health-numbers:coverage.share', {
                                                  share: formatShare(row.covered, row.total),
                                                  covered: row.covered,
                                                  total: row.total,
                                              })
                                            : t('operations.health-numbers:none-in-range')}
                                    </span>
                                </div>
                                <div aria-hidden className="h-1.5 rounded-full bg-muted">
                                    <div
                                        className="h-full rounded-full bg-chart-1"
                                        style={{
                                            width: `${row.total ? (row.covered / row.total) * 100 : 0}%`,
                                        }}
                                    />
                                </div>
                                {short && (
                                    <span className="text-xs text-muted-foreground">
                                        {t(`operations.health-numbers:coverage.${row.id}-gap`)}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <Skeleton className="h-40 w-full" />
            )}
        </Section>
    );
}

/** The backups' line: whether they run, the last one, and its off-site copy. */
function useBackupLine() {
    const { t } = useTranslation(['operations.health']);
    return (live: HealthLive, timeZone: string, now: number) => {
        const backup = live.backup;
        if (!backup) {
            return { text: t('operations.health:freshness.backup-off'), alert: false };
        }
        if (backup.lastError && (!backup.lastSuccessAt || (backup.lastErrorAt ?? 0) > backup.lastSuccessAt)) {
            return { text: t('operations.health:freshness.backup-failed', { error: backup.lastError }), alert: true };
        }
        if (!backup.lastSuccessAt) {
            return {
                text: t('operations.health:freshness.backup-none', {
                    context: backup.intervalHours ? undefined : 'off',
                }),
                alert: true,
            };
        }
        const late = backup.intervalHours > 0 && now - backup.lastSuccessAt > 2 * backup.intervalHours * 3_600_000;
        const context = [backup.intervalHours ? null : 'off', backup.offsite ? 'offsite' : null]
            .filter(Boolean)
            .join('-');
        return {
            text: t('operations.health:freshness.backup-last', {
                context: (context || undefined) as 'off' | 'offsite' | 'off-offsite' | undefined,
                when: formatWhen(backup.lastSuccessAt, timeZone),
                ago: formatAgo(backup.lastSuccessAt, now),
                hours: backup.intervalHours,
                offsite: backup.offsiteSuccessAt
                    ? formatAgo(backup.offsiteSuccessAt, now)
                    : t('operations.health:not-yet'),
            }),
            alert: late || !!backup.offsiteError,
        };
    };
}

/**
 * Mini apps' self-healing (CB-291): the check of promoted apps, how many
 * apps are watched and recovered by themselves, and each one that isn't
 * healthy with what is being done and its last error.
 */
function AppsHealthRows({ apps, now }: { apps: NonNullable<HealthLive['apps']>; now: number }) {
    const { t } = useTranslation(['operations.health']);
    const failing = !!apps.check.failingSince;
    return (
        <>
            <Row label={t('operations.health:apps.title')} slot="ops-health-apps">
                <Badge
                    variant={
                        failing || apps.unhealthy.some((app) => app.state === 'failed') ? 'destructive' : 'secondary'
                    }
                >
                    {failing
                        ? t('operations.health:apps.check-failing')
                        : apps.unhealthy.length
                          ? t('operations.health:apps.not-healthy', { n: apps.unhealthy.length })
                          : t('operations.health:apps.state.healthy')}
                </Badge>
                <span className={cn('text-xs', failing ? ALERT : 'text-muted-foreground')}>
                    {failing
                        ? t('operations.health:apps.failing-since', {
                              ago: formatAgo(apps.check.failingSince!, now),
                              error: apps.check.lastError ?? '',
                          })
                        : [
                              t('operations.health:apps.watched', {
                                  watched: apps.watched,
                                  recovered: apps.recoveredLastDay,
                              }),
                              ...(apps.check.lastOkAt
                                  ? [t('operations.health:apps.checked', { ago: formatAgo(apps.check.lastOkAt, now) })]
                                  : []),
                          ].join(' · ')}
                </span>
            </Row>
            {apps.unhealthy.map((app) => (
                <Row key={app.appId} label={app.name} slot="ops-health-app">
                    <Badge variant={app.state === 'recovering' ? 'secondary' : 'destructive'}>
                        {t(`operations.health:apps.state.${app.state}`)}
                    </Badge>
                    <span className={cn('text-xs', app.state === 'recovering' ? 'text-muted-foreground' : ALERT)}>
                        {[
                            app.reason,
                            app.attempts
                                ? t('operations.health:apps.attempt', { n: app.attempts, max: app.maxAttempts })
                                : null,
                            app.lastError ? t('operations.health:apps.last-error', { error: app.lastError }) : null,
                            app.escalatedAt
                                ? t('operations.health:apps.admins-told', { ago: formatAgo(app.escalatedAt, now) })
                                : null,
                            app.lastRecoveryAt
                                ? t('operations.health:apps.last-recovered', {
                                      ago: formatAgo(app.lastRecoveryAt, now),
                                  })
                                : null,
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                </Row>
            ))}
        </>
    );
}

function Freshness({ health }: { health: OpsHealth | undefined }) {
    const { t } = useTranslation(['operations.health']);
    const backupLine = useBackupLine();
    const { timeZone } = useOpsSettings();
    const now = Date.now();
    const live = health?.live;
    const sources = health?.facts?.sources ?? [];
    const analytics = live?.analytics;
    const backup = live ? backupLine(live, timeZone, now) : undefined;
    const copy = live?.backup?.continuous;
    const drill = live?.backup?.restoreDrill;
    return (
        <Section
            slot="ops-health-freshness"
            title={t('operations.health:freshness.title')}
            description={t('operations.health:freshness.description')}
        >
            {live ? (
                <ul
                    aria-label={t('operations.health:freshness.label')}
                    className="m-0 grid list-none divide-y p-0 text-sm"
                >
                    <Row label={t('operations.health:freshness.analytics')}>
                        {analytics ? (
                            <>
                                <Badge variant={analytics.state === 'ready' ? 'secondary' : 'destructive'}>
                                    {analytics.state === 'rebuilding' && analytics.progress !== undefined
                                        ? t('operations.health:freshness.rebuilding-progress', {
                                              progress: Math.round(analytics.progress) / 100,
                                          })
                                        : t(
                                              `operations.health:freshness.state.${analytics.state === 'ready' || analytics.state === 'starting' || analytics.state === 'rebuilding' ? analytics.state : 'down'}`,
                                          )}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                    {analytics.mode === 'service'
                                        ? t('operations.health:freshness.mode-service')
                                        : t('operations.health:freshness.mode-process')}
                                    {analytics.asOf
                                        ? ` · ${t('operations.health:freshness.caught-up', { ago: formatAgo(analytics.asOf, now) })}`
                                        : ''}
                                </span>
                            </>
                        ) : (
                            <span className="text-xs text-muted-foreground">
                                {t('operations.health:freshness.analytics-off')}
                            </span>
                        )}
                    </Row>
                    <Row label={t('operations.health:freshness.deployment')} slot="ops-health-deployment">
                        <DeploymentLine deployment={live.deployment} now={now} />
                    </Row>
                    {live.apps && <AppsHealthRows apps={live.apps} now={now} />}
                    <Row label={t('operations.health:freshness.backups')}>
                        <span className={cn('text-xs', backup?.alert ? ALERT : 'text-muted-foreground')}>
                            {backup?.text}
                        </span>
                    </Row>
                    {copy && (
                        <Row label={t('operations.health:freshness.copy')} slot="ops-health-continuous-copy">
                            <Badge
                                variant={
                                    copy.behind || copy.offsite?.behind || copy.level === 'critical'
                                        ? 'destructive'
                                        : copy.level === 'warning'
                                          ? 'outline'
                                          : 'secondary'
                                }
                            >
                                {t(
                                    `operations.health:freshness.copy-state.${
                                        copy.level === 'critical' || copy.level === 'warning'
                                            ? copy.level
                                            : copy.behind || copy.offsite?.behind
                                              ? 'behind'
                                              : 'current'
                                    }`,
                                )}
                            </Badge>
                            <span
                                className={cn(
                                    'text-xs',
                                    copy.level && copy.level !== 'ok' ? ALERT : 'text-muted-foreground',
                                )}
                            >
                                {[
                                    copy.lastCopiedAt
                                        ? t('operations.health:freshness.last-copied', {
                                              ago: formatAgo(copy.lastCopiedAt, now),
                                          })
                                        : t('operations.health:freshness.nothing-copied'),
                                    ...(copy.lagMs
                                        ? [t('operations.health:freshness.lag', { time: formatMs(copy.lagMs) })]
                                        : []),
                                    ...(copy.walBytes !== undefined
                                        ? [t('operations.health:freshness.wal', { size: megabytes(copy.walBytes) })]
                                        : []),
                                    ...(copy.offsite
                                        ? [
                                              t('operations.health:freshness.offsite', {
                                                  ago: copy.offsite.lastSentAt
                                                      ? formatAgo(copy.offsite.lastSentAt, now)
                                                      : t('operations.health:not-yet'),
                                              }),
                                          ]
                                        : []),
                                ].join(' · ')}
                            </span>
                        </Row>
                    )}
                    {drill && (
                        <Row label={t('operations.health:freshness.drill')}>
                            {drill.last ? (
                                <>
                                    <Badge variant={drill.last.ok ? 'secondary' : 'destructive'}>
                                        {drill.last.ok
                                            ? t('operations.health:freshness.passed')
                                            : t('operations.health:failed')}
                                    </Badge>
                                    <span className={cn('text-xs', drill.last.ok ? 'text-muted-foreground' : ALERT)}>
                                        {[
                                            formatWhen(drill.last.startedAt, timeZone),
                                            ...(drill.last.error ? [drill.last.error] : []),
                                            drill.intervalDays
                                                ? t('operations.health:freshness.every-days', {
                                                      count: drill.intervalDays,
                                                  })
                                                : t('operations.health:freshness.by-hand'),
                                        ].join(' · ')}
                                    </span>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    {drill.intervalDays
                                        ? t('operations.health:freshness.not-run-every', { count: drill.intervalDays })
                                        : t('operations.health:freshness.not-run')}
                                </span>
                            )}
                        </Row>
                    )}
                    {sources.map((source) => {
                        const stale = now - source.at > live.staleAfterMs;
                        return (
                            <Row
                                key={source.source}
                                label={
                                    isSource(source.source)
                                        ? t(`operations.health:freshness.source.${source.source}`)
                                        : source.source
                                }
                                slot="ops-health-source"
                                stale={stale}
                            >
                                {stale && <Badge variant="destructive">{t('operations.health:freshness.stale')}</Badge>}
                                <span className={cn('text-xs', stale ? ALERT : 'text-muted-foreground')}>
                                    {t('operations.health:freshness.copied', { ago: formatAgo(source.at, now) })}
                                </span>
                            </Row>
                        );
                    })}
                </ul>
            ) : (
                <Skeleton className="h-40 w-full" />
            )}
        </Section>
    );
}

/** Whether the deployment's own numbers (CB-321) can be shown, read live. */
function DeploymentLine({ deployment, now }: { deployment: HealthLive['deployment']; now: number }) {
    const { t } = useTranslation(['operations.health']);
    if (!deployment || deployment.state === 'off') {
        return <span className="text-xs text-muted-foreground">{t('operations.health:freshness.deployment-off')}</span>;
    }
    const unlimited = deployment.unlimitedServices ?? 0;
    return (
        <>
            <Badge variant={deployment.state === 'ok' ? 'secondary' : 'destructive'}>
                {t(
                    `operations.health:freshness.deployment-state.${deployment.state === 'ok' || deployment.state === 'pending' ? deployment.state : 'unavailable'}`,
                )}
            </Badge>
            <span className={cn('text-xs', deployment.state === 'unavailable' ? ALERT : 'text-muted-foreground')}>
                {deployment.measuredAt
                    ? t('operations.health:freshness.measured', { ago: formatAgo(deployment.measuredAt, now) })
                    : t('operations.health:freshness.not-measured')}
                {deployment.services !== null
                    ? ` · ${t('operations.health:freshness.services', { count: deployment.services })}`
                    : ''}
            </span>
            {unlimited > 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                    {t('operations.health:freshness.unlimited', { n: unlimited })}
                </span>
            )}
        </>
    );
}

function Row({ label, children, slot, stale }: { label: string; children: ReactNode; slot?: string; stale?: boolean }) {
    return (
        <li
            data-slot={slot}
            data-stale={stale || undefined}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
        >
            <span className="w-full font-medium sm:w-56">{label}</span>
            {children}
        </li>
    );
}

/**
 * Health (CB-192): latency and queues, tokens by model, socio, person and
 * reasoning kind, schedules, goals, jobs and long runs, how much of the
 * range records each signal, and backups with the dashboard's own
 * freshness. Its numbers follow the range and filters; the live part
 * (backups, the analytics process) is read from the server as
 * it is now.
 */
export function HealthSection() {
    const { t } = useTranslation(['operations.health', 'operations']);
    const { statusLine } = useOpsFormat();
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const health = useOpsAnswer<OpsHealth>(`/operations/health${search}`);
    const status = health.data?.status;
    const facts = health.data?.facts ?? null;
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
                    {status.state === 'ready' && ` ${t('operations.health:status-note')}`}
                </p>
            )}
            {health.error && (
                <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {health.error}
                </p>
            )}
            <div aria-busy={health.loading} className={cn('grid gap-4', health.stale && 'opacity-60')}>
                <Freshness health={health.data} />
                {!health.data ? (
                    <Skeleton className="h-96 w-full rounded-xl" />
                ) : !facts ? (
                    <Card data-slot="ops-health-empty" className="px-6 text-sm">
                        <p className="m-0 text-muted-foreground">{t('operations.health:empty')}</p>
                    </Card>
                ) : (
                    <HealthNumbers facts={facts} />
                )}
            </div>
        </>
    );
}

/**
 * Everything that comes from the analytics store. It shows once the answer
 * is in, after the page hydrates, so its words load then
 * (operations.health-numbers) instead of being inlined in the page.
 */
const HealthNumbers = onDemand(['operations.health-numbers'], Numbers);

function Numbers({ facts }: { facts: HealthFacts | null }) {
    const { t } = useTranslation(['operations.health-numbers']);
    return (
        <>
            <Latency facts={facts} />
            <Section
                slot="ops-health-tokens"
                title={t('operations.health-numbers:tokens.title')}
                description={t('operations.health-numbers:tokens.description')}
            >
                {facts ? <Tokens facts={facts} /> : <Skeleton className="h-40 w-full" />}
            </Section>
            <Schedules facts={facts} />
            <LongRuns facts={facts} />
            <Coverage facts={facts} />
        </>
    );
}
