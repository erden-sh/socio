import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { formatNumber } from '@socio/shared/locale';
import { opsSearch } from '@socio/shared/operations/operations';
import {
    GOAL_STATES,
    HEALTH_METRIC_LABELS,
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
import { megabytes } from '../settings/setup-lines';

import { bucketLabel, formatWhen, statusLine } from './format';
import {
    COVERAGE_LABELS,
    formatAgo,
    formatMs,
    formatShare,
    GOAL_STATE_LABELS,
    REASONING_LABELS,
    SCHEDULE_STATE_LABELS,
    SOURCE_LABELS,
} from './health-format';
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

/** "p50 420 ms · p95 3.1 s · 120 rounds". */
const spreadHint = (spread: Spread | undefined, unit: string) =>
    spread && spread.n ? `p50 ${formatMs(spread.p50)} · ${formatNumber(spread.n)} ${unit}` : 'None in this range';

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

type TokenView = 'model' | 'socio' | 'person' | 'reasoning';
const TOKEN_VIEWS: { id: TokenView; label: string }[] = [
    { id: 'model', label: 'By model' },
    { id: 'socio', label: 'By socio' },
    { id: 'person', label: 'By person' },
    { id: 'reasoning', label: 'By reasoning kind' },
];

function Tokens({ facts }: { facts: HealthFacts }) {
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
                <SelectTrigger size="sm" aria-label="Tokens" className="w-52">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {TOKEN_VIEWS.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                            {item.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {view === 'reasoning' ? (
                reasoning.length ? (
                    <>
                        <ul aria-label="Tokens by reasoning kind" className="m-0 grid list-none divide-y p-0">
                            {reasoning.map((row) => (
                                <BarRow
                                    key={row.kind}
                                    label={REASONING_LABELS[row.kind]}
                                    value={row.output}
                                    max={maxReasoning}
                                    detail={
                                        <>
                                            {formatNumber(row.turns)} turns · {formatNumber(row.output)} output ·{' '}
                                            {row.reasoning === null
                                                ? 'reasoning not reported'
                                                : `${formatNumber(row.reasoning)} reasoning in ${formatNumber(row.reportedTurns)} turns`}
                                        </>
                                    }
                                />
                            ))}
                        </ul>
                        <p className="m-0 text-xs text-muted-foreground">
                            Each kind is counted on its own: a summary’s tokens and raw reasoning aren’t comparable.
                            Reasoning tokens count only turns whose model reported them apart from its output.
                        </p>
                    </>
                ) : (
                    <Empty>No turns in this range.</Empty>
                )
            ) : rows.length ? (
                <ul
                    aria-label={`Tokens ${TOKEN_VIEWS.find((item) => item.id === view)!.label.toLowerCase()}`}
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
                                    'Not recorded'
                                ) : (
                                    (row.name ?? row.key)
                                )
                            }
                            value={row.input + row.output}
                            max={max}
                            detail={`${formatNumber(row.input)} in · ${formatNumber(row.output)} out · ${formatNumber(row.turns)} turns`}
                        />
                    ))}
                </ul>
            ) : (
                <Empty>No turns in this range.</Empty>
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
    if (!rows.length) {
        return <Empty>{empty}</Empty>;
    }
    const max = Math.max(0, ...rows.map((row) => row.p95 ?? 0));
    return (
        <ul aria-label={label} className="m-0 grid list-none divide-y p-0">
            {rows.map((row) => (
                <BarRow
                    key={row.key}
                    label={row.key === 'unknown' ? 'Not recorded' : row.key}
                    value={row.p95 ?? 0}
                    max={max}
                    detail={
                        <>
                            p50 {formatMs(row.p50)} · p95 {formatMs(row.p95)} · {formatNumber(row.n)}
                            {errors && row.errors ? (
                                <span className={ALERT}> · {formatNumber(row.errors)} failed</span>
                            ) : null}
                        </>
                    }
                />
            ))}
        </ul>
    );
}

function Latency({ facts }: { facts: HealthFacts | null }) {
    const { search } = useOpsQuery();
    const [metric, setMetric] = useState<HealthMetric>('first_output');
    const series = useOpsAnswer<OpsHealthSeries>(`/operations/health/series/${metric}${search}`);
    const points = series.data?.points ?? [];
    const label = HEALTH_METRIC_LABELS[metric];
    const q = facts?.queues;
    const l = facts?.latency;
    return (
        <Section
            slot="ops-health-latency"
            title="Latency and queues"
            description="How long people wait: for a model’s first output, for tools, and for queued turns, jobs and schedules. p95 is the slow end: 1 in 20 waited longer."
        >
            <Stats label="Latency">
                <Stat
                    id="first-output"
                    label="First output, p95"
                    value={formatMs(l?.firstOutput.p95)}
                    hint={spreadHint(l?.firstOutput, 'rounds')}
                />
                <Stat
                    id="tools"
                    label="Tool calls, p95"
                    value={formatMs(l?.tools.p95)}
                    hint={spreadHint(l?.tools, 'calls')}
                />
                <Stat
                    id="turn-queue"
                    label="Turn queue, p95"
                    value={formatMs(q?.turns.p95)}
                    hint={spreadHint(q?.turns, 'turns')}
                />
                <Stat
                    id="job-wait"
                    label="Job queue wait, p95"
                    value={formatMs(q?.jobWait.p95)}
                    hint={spreadHint(q?.jobWait, 'runs')}
                />
                <Stat
                    id="job-wake"
                    label="Computer wake, p95"
                    value={formatMs(q?.jobWake.p95)}
                    hint={spreadHint(q?.jobWake, 'runs')}
                />
                <Stat
                    id="schedule-late"
                    label="Schedule lateness, p95"
                    value={formatMs(q?.scheduleLate.p95)}
                    hint={spreadHint(q?.scheduleLate, 'runs')}
                />
            </Stats>
            <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="m-0 text-sm font-medium">{label}, p95</h3>
                    <Select value={metric} onValueChange={(value) => setMetric(value as HealthMetric)}>
                        <SelectTrigger size="sm" aria-label="Chart" className="w-56">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {HEALTH_METRICS.map((item) => (
                                <SelectItem key={item} value={item}>
                                    {HEALTH_METRIC_LABELS[item]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {series.data && points.some((point) => point.n > 0) ? (
                    <div data-slot="ops-health-chart" className={cn(series.stale && 'opacity-60')}>
                        <SeriesChart
                            kind={series.data.window.bucket === 'hour' ? 'line' : 'bar'}
                            label={`${label}, p95`}
                            xName={series.data.window.bucket}
                            yName="milliseconds"
                            points={points.map((point) => ({
                                label: bucketLabel(point.at, series.data!.window.bucket, series.data!.window.timeZone),
                                value: point.p95,
                            }))}
                        />
                    </div>
                ) : series.data ? (
                    <Empty>Nothing timed in this range.</Empty>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">First output by model</h3>
                    {l ? (
                        <LatencyList
                            rows={l.firstOutputByModel}
                            label="First output by model"
                            empty="No timed model rounds in this range."
                        />
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )}
                </div>
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">Tools</h3>
                    {l ? (
                        <LatencyList
                            rows={l.byTool}
                            label="Tool call times"
                            empty="No tool calls in this range."
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
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const schedules = useCursorList<HealthScheduleRow>(`/operations/health/schedules${search}`);
    const runs = useCursorList<HealthRunRow>(`/operations/health/runs${search}`);
    const s = facts?.schedules;
    const g = facts?.goals;
    return (
        <Section
            slot="ops-health-schedules"
            title="Schedules and goals"
            description="Schedules as they are now, and their runs in this range. A run is late when it starts over 5 minutes after it came due."
        >
            <Stats label="Schedules">
                <Stat
                    id="failing"
                    label="Failing"
                    value={count(s?.failing)}
                    tone={s?.failing ? 'alert' : undefined}
                    hint="Their last run failed"
                />
                <Stat
                    id="overdue"
                    label="Overdue"
                    value={count(s?.overdue)}
                    tone={s?.overdue ? 'alert' : undefined}
                    hint="Due, but not started"
                />
                <Stat
                    id="paused"
                    label="Paused"
                    value={count(s?.paused)}
                    hint={s ? `${formatNumber(s.ok)} on time` : undefined}
                />
                <Stat
                    id="runs"
                    label="Runs in range"
                    value={count(s?.runs)}
                    tone={s?.failedRuns ? 'alert' : undefined}
                    hint={s ? `${formatNumber(s.failedRuns)} failed · ${formatNumber(s.lateRuns)} late` : undefined}
                />
            </Stats>
            <Stats label="Goals">
                {GOAL_STATES.map((state) => (
                    <Stat
                        key={state}
                        id={`goal-${state}`}
                        label={`Goals ${GOAL_STATE_LABELS[state].toLowerCase()}`}
                        value={count(g?.[state])}
                        tone={state === 'stalled' && g?.stalled ? 'alert' : undefined}
                        hint={
                            state === 'stalled'
                                ? 'Schedule failing or paused, or no change in 14 days'
                                : state === 'done' && g
                                  ? `${formatNumber(g.doneInRange)} in this range`
                                  : state === 'cancelled' && g
                                    ? `${formatNumber(g.cancelledInRange)} in this range`
                                    : undefined
                        }
                    />
                ))}
            </Stats>
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">Need a look</h3>
                    <InfiniteList
                        list={schedules}
                        label="Schedules that need a look"
                        itemKey={(row) => row.id}
                        empty="Every schedule is on time."
                        renderItem={(row) => (
                            <div
                                data-slot="ops-health-schedule"
                                className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm"
                            >
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span className="min-w-0 truncate font-medium">
                                        {row.title ?? 'Untitled schedule'}
                                    </span>
                                    <Badge variant={SCHEDULE_TONE[row.state] ?? 'outline'}>
                                        {SCHEDULE_STATE_LABELS[row.state]}
                                    </Badge>
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {row.socioName ?? row.socioId ?? ''}
                                    </span>
                                </div>
                                <span className="text-xs text-muted-foreground">
                                    {row.state === 'overdue' && row.nextRunAt !== null
                                        ? `Was due ${formatWhen(row.nextRunAt, timeZone)}`
                                        : (row.error ?? `Changed ${formatWhen(row.updatedAt, timeZone)}`)}
                                </span>
                            </div>
                        )}
                    />
                </div>
                <div className="grid content-start gap-1">
                    <h3 className="m-0 text-sm font-medium">Late or failed runs</h3>
                    <InfiniteList
                        list={runs}
                        label="Late or failed scheduled runs"
                        itemKey={(row) => row.id}
                        empty="No late or failed runs in this range."
                        renderItem={(row) => (
                            <div
                                data-slot="ops-health-run"
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium">
                                    {row.title ?? 'A removed schedule'}
                                </span>
                                {row.status === 'failed' || row.status === 'interrupted' ? (
                                    <Badge variant="destructive">
                                        {row.status === 'failed' ? 'Failed' : 'Interrupted'}
                                    </Badge>
                                ) : (
                                    <Badge variant="secondary">Late</Badge>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                    {row.lateMs !== null && row.lateMs > 0 ? `${formatMs(row.lateMs)} late · ` : ''}
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

const LONG_STATUS: Record<string, string> = {
    running: 'Running',
    waiting: 'Waiting',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Canceled',
};

function LongRuns({ facts }: { facts: HealthFacts | null }) {
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const list = useCursorList<HealthLongRunRow>(`/operations/health/long-runs${search}`);
    const l = facts?.longRuns;
    const j = facts?.jobRuns;
    return (
        <Section
            slot="ops-health-long-runs"
            title="Jobs and long runs"
            description="Jobs that run until done, worked through in batches. Dead items are ones set aside after their last try."
        >
            <Stats label="Jobs">
                <Stat
                    id="long-open"
                    label="Long runs open"
                    value={l ? formatNumber(l.running + l.waiting) : '–'}
                    hint={l ? `${formatNumber(l.waiting)} waiting` : undefined}
                />
                <Stat
                    id="dead"
                    label="Dead items"
                    value={count(l?.deadItems)}
                    tone={l?.deadItems ? 'alert' : undefined}
                    hint="In open long runs"
                />
                <Stat
                    id="long-finished"
                    label="Finished in range"
                    value={count(l?.done)}
                    hint={l ? `${formatNumber(l.failed)} failed · ${formatNumber(l.cancelled)} canceled` : undefined}
                    tone={l?.failed ? 'alert' : undefined}
                />
                <Stat
                    id="job-runs"
                    label="Job runs in range"
                    value={count(j?.total)}
                    hint={j ? `${formatNumber(j.failed)} failed` : undefined}
                    tone={j?.failed ? 'alert' : undefined}
                />
            </Stats>
            <InfiniteList
                list={list}
                label="Long runs"
                itemKey={(row) => row.id}
                empty="No long runs open or changed in this range."
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
                                {LONG_STATUS[row.status] ?? row.status}
                            </Badge>
                            <span className="ml-auto text-xs text-muted-foreground">
                                {row.socioName ?? row.socioId ?? ''}
                            </span>
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">
                            {formatNumber(row.itemsDone)} done · {formatNumber(row.itemsPending)} to go
                            {row.itemsDead ? (
                                <span className={ALERT}> · {formatNumber(row.itemsDead)} dead</span>
                            ) : null}{' '}
                            · {formatNumber(row.batches)} batches
                            {row.retries ? ` · ${formatNumber(row.retries)} retries` : ''} · changed{' '}
                            {formatWhen(row.updatedAt, timeZone)}
                        </span>
                        {(row.lastError || row.waitReason) && (
                            <span className={cn('text-xs', row.lastError ? ALERT : 'text-muted-foreground')}>
                                {row.lastError ?? `Waiting: ${row.waitReason}`}
                            </span>
                        )}
                    </div>
                )}
            />
        </Section>
    );
}

function Coverage({ facts }: { facts: HealthFacts | null }) {
    return (
        <Section
            slot="ops-health-coverage"
            title="Collection coverage"
            description="How much of this range records each signal. Where coverage is short, the numbers above count only what was recorded."
        >
            {facts ? (
                <ul aria-label="Collection coverage" className="m-0 grid list-none divide-y p-0">
                    {facts.coverage.map((row) => {
                        const { label, gap } = COVERAGE_LABELS[row.id];
                        const short = row.total > 0 && row.covered < row.total;
                        return (
                            <li
                                key={row.id}
                                data-slot="ops-health-coverage-row"
                                data-coverage={row.id}
                                className="grid min-w-0 grid-cols-1 gap-1 py-2 text-sm"
                            >
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                    <span className="font-medium">{label}</span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {row.total
                                            ? `${formatShare(row.covered, row.total)} · ${formatNumber(row.covered)} of ${formatNumber(row.total)}`
                                            : 'None in this range'}
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
                                {short && <span className="text-xs text-muted-foreground">{gap}</span>}
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

function backupLine(live: HealthLive, timeZone: string, now: number) {
    const backup = live.backup;
    if (!backup) {
        return { text: 'Backups aren’t set up on this server.', alert: false };
    }
    if (backup.lastError && (!backup.lastSuccessAt || (backup.lastErrorAt ?? 0) > backup.lastSuccessAt)) {
        return { text: `The last backup failed: ${backup.lastError}`, alert: true };
    }
    if (!backup.lastSuccessAt) {
        return {
            text: backup.intervalHours ? 'No backup has run yet.' : 'Scheduled backups are off; none has run.',
            alert: true,
        };
    }
    const late = backup.intervalHours > 0 && now - backup.lastSuccessAt > 2 * backup.intervalHours * 3_600_000;
    return {
        text: `Last backup ${formatWhen(backup.lastSuccessAt, timeZone)} (${formatAgo(backup.lastSuccessAt, now)})${backup.intervalHours ? `, every ${backup.intervalHours} h` : ', scheduled backups off'}${backup.offsite ? `; off-site ${backup.offsiteSuccessAt ? formatAgo(backup.offsiteSuccessAt, now) : 'not yet'}` : ''}.`,
        alert: late || !!backup.offsiteError,
    };
}

const APP_HEALTH_LABELS = { healthy: 'Healthy', recovering: 'Recovering', degraded: 'Degraded', failed: 'Failed' };

/**
 * Mini apps' self-healing (CB-291): the check of promoted apps, how many
 * apps are watched and recovered by themselves, and each one that isn't
 * healthy with what is being done and its last error.
 */
function AppsHealthRows({ apps, now }: { apps: NonNullable<HealthLive['apps']>; now: number }) {
    const failing = !!apps.check.failingSince;
    return (
        <>
            <Row label="Mini apps" slot="ops-health-apps">
                <Badge
                    variant={
                        failing || apps.unhealthy.some((app) => app.state === 'failed') ? 'destructive' : 'secondary'
                    }
                >
                    {failing
                        ? 'Check failing'
                        : apps.unhealthy.length
                          ? `${apps.unhealthy.length} not healthy`
                          : 'Healthy'}
                </Badge>
                <span className={cn('text-xs', failing ? ALERT : 'text-muted-foreground')}>
                    {failing
                        ? `The check of workspace apps fails since ${formatAgo(apps.check.failingSince!, now)}: ${apps.check.lastError}`
                        : `${apps.watched} watched · ${apps.recoveredLastDay} recovered by themselves today${apps.check.lastOkAt ? ` · checked ${formatAgo(apps.check.lastOkAt, now)}` : ''}`}
                </span>
            </Row>
            {apps.unhealthy.map((app) => (
                <Row key={app.appId} label={app.name} slot="ops-health-app">
                    <Badge variant={app.state === 'recovering' ? 'secondary' : 'destructive'}>
                        {APP_HEALTH_LABELS[app.state]}
                    </Badge>
                    <span className={cn('text-xs', app.state === 'recovering' ? 'text-muted-foreground' : ALERT)}>
                        {[
                            app.reason,
                            app.attempts ? `attempt ${app.attempts} of ${app.maxAttempts}` : null,
                            app.lastError ? `last error: ${app.lastError}` : null,
                            app.escalatedAt ? `admins told ${formatAgo(app.escalatedAt, now)}` : null,
                            app.lastRecoveryAt ? `last recovered ${formatAgo(app.lastRecoveryAt, now)}` : null,
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
            title="Backups and data freshness"
            description="Read live from this server, so it shows even while analytics is down."
        >
            {live ? (
                <ul aria-label="Backups and freshness" className="m-0 grid list-none divide-y p-0 text-sm">
                    <Row label="Analytics">
                        {analytics ? (
                            <>
                                <Badge variant={analytics.state === 'ready' ? 'secondary' : 'destructive'}>
                                    {analytics.state === 'ready'
                                        ? 'Ready'
                                        : analytics.state === 'starting'
                                          ? 'Starting'
                                          : analytics.state === 'rebuilding'
                                            ? `Rebuilding${analytics.progress === undefined ? '' : ` ${Math.round(analytics.progress)}%`}`
                                            : 'Down'}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                    {analytics.mode === 'service' ? 'Its own service' : 'A process of this server'}
                                    {analytics.asOf ? ` · caught up ${formatAgo(analytics.asOf, now)}` : ''}
                                </span>
                            </>
                        ) : (
                            <span className="text-xs text-muted-foreground">
                                Not running on this server (OPS_ANALYTICS_MODE=off).
                            </span>
                        )}
                    </Row>
                    <Row label="Deployment metrics" slot="ops-health-deployment">
                        <DeploymentLine deployment={live.deployment} now={now} />
                    </Row>
                    {live.apps && <AppsHealthRows apps={live.apps} now={now} />}
                    <Row label="Backups">
                        <span className={cn('text-xs', backup?.alert ? ALERT : 'text-muted-foreground')}>
                            {backup?.text}
                        </span>
                    </Row>
                    {copy && (
                        <Row label="Continuous copy" slot="ops-health-continuous-copy">
                            <Badge
                                variant={
                                    copy.behind || copy.offsite?.behind || copy.level === 'critical'
                                        ? 'destructive'
                                        : copy.level === 'warning'
                                          ? 'outline'
                                          : 'secondary'
                                }
                            >
                                {copy.level === 'critical'
                                    ? 'Critical'
                                    : copy.level === 'warning'
                                      ? 'Warning'
                                      : copy.behind || copy.offsite?.behind
                                        ? 'Behind'
                                        : 'Current'}
                            </Badge>
                            <span
                                className={cn(
                                    'text-xs',
                                    copy.level && copy.level !== 'ok' ? ALERT : 'text-muted-foreground',
                                )}
                            >
                                {copy.lastCopiedAt
                                    ? `Last copied ${formatAgo(copy.lastCopiedAt, now)}`
                                    : 'Nothing copied yet'}
                                {copy.lagMs ? ` · ${formatMs(copy.lagMs)} behind the newest write` : ''}
                                {copy.walBytes !== undefined ? ` · write-ahead log ${megabytes(copy.walBytes)}` : ''}
                                {copy.offsite
                                    ? ` · off-site ${copy.offsite.lastSentAt ? formatAgo(copy.offsite.lastSentAt, now) : 'not yet'}`
                                    : ''}
                            </span>
                        </Row>
                    )}
                    {drill && (
                        <Row label="Restore drill">
                            {drill.last ? (
                                <>
                                    <Badge variant={drill.last.ok ? 'secondary' : 'destructive'}>
                                        {drill.last.ok ? 'Passed' : 'Failed'}
                                    </Badge>
                                    <span className={cn('text-xs', drill.last.ok ? 'text-muted-foreground' : ALERT)}>
                                        {formatWhen(drill.last.startedAt, timeZone)}
                                        {drill.last.error ? ` · ${drill.last.error}` : ''}
                                        {drill.intervalDays
                                            ? ` · every ${drill.intervalDays} days`
                                            : ' · only when run by hand'}
                                    </span>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    Not run yet
                                    {drill.intervalDays ? `; every ${drill.intervalDays} days` : ''}.
                                </span>
                            )}
                        </Row>
                    )}
                    {sources.map((source) => {
                        const stale = now - source.at > live.staleAfterMs;
                        return (
                            <Row
                                key={source.source}
                                label={SOURCE_LABELS[source.source] ?? source.source}
                                slot="ops-health-source"
                                stale={stale}
                            >
                                {stale && <Badge variant="destructive">Stale</Badge>}
                                <span className={cn('text-xs', stale ? ALERT : 'text-muted-foreground')}>
                                    Copied {formatAgo(source.at, now)}
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
    if (!deployment || deployment.state === 'off') {
        return (
            <span className="text-xs text-muted-foreground">
                Unavailable: they need the read-only disk usage proxy (COMPUTER_DISK_USAGE_URL).
            </span>
        );
    }
    const unlimited = deployment.unlimitedServices ?? 0;
    return (
        <>
            <Badge variant={deployment.state === 'ok' ? 'secondary' : 'destructive'}>
                {deployment.state === 'ok' ? 'Current' : deployment.state === 'pending' ? 'Not yet' : 'Unavailable'}
            </Badge>
            <span className={cn('text-xs', deployment.state === 'unavailable' ? ALERT : 'text-muted-foreground')}>
                {deployment.measuredAt ? `Measured ${formatAgo(deployment.measuredAt, now)}` : 'Not measured yet'}
                {deployment.services !== null ? ` · ${formatNumber(deployment.services)} services` : ''}
            </span>
            {unlimited > 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                    {formatNumber(unlimited)} without a memory limit
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
                    {status.state === 'ready' &&
                        ' The source filter narrows model, tool and turn numbers; jobs and schedules follow the socio, Space and person.'}
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
                        <p className="m-0 text-muted-foreground">
                            Latency, tokens, schedules and long runs show here once analytics has copied this server’s
                            data. Backups above are read live.
                        </p>
                    </Card>
                ) : (
                    <HealthNumbers facts={facts} />
                )}
            </div>
        </>
    );
}

/** Everything that comes from the analytics store. */
function HealthNumbers({ facts }: { facts: HealthFacts | null }) {
    return (
        <>
            <Latency facts={facts} />
            <Section slot="ops-health-tokens" title="Tokens" description="The largest users of tokens in this range.">
                {facts ? <Tokens facts={facts} /> : <Skeleton className="h-40 w-full" />}
            </Section>
            <Schedules facts={facts} />
            <LongRuns facts={facts} />
            <Coverage facts={facts} />
        </>
    );
}
