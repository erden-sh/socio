import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { compareText } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import type { GoalView, JobView, ScheduleView, SchedulesState } from '@socio/shared/schedule-types';
import type { Action } from '@socio/shared/types';

import { DataGrid, GridFilter, GridSearch, GridToolbar, RowActionsMenu } from '../../components/data-grid/DataGrid';
import { api, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useLoaderSeed } from '../../lib/page-loader';
import { useIsAdmin } from '../../shell/current-user';
import { WorkspacePage } from '../../views/WorkspacePage';
import { formatSeconds } from '../runs/format';

import { CancelScheduleDialog } from './CancelScheduleDialog';
import { GoalComments } from './GoalComments';
import { JobPanel } from './JobPanel';
import { LongRunLine } from './LongRunProgress';
import { RunBadge, useScheduleWords, When } from './schedule-words';
import { byStatusThenTitle, dotOptions, matches, STATUSES, STATUS_TONE, type ScheduleFilter } from './schedules-format';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * `/schedules`: the signed-in user's schedules (proposed by their Dots and
 * approved, or made in a conversation) and their Dots' jobs. Pause, resume,
 * cancel, run now; a job's versions, runs and logs. Each user sees only
 * their own; admins also see the workspace's counts. Its words are the
 * route's (`schedules`, `schedules.list`); a job's panel and the cancel
 * dialog load theirs on demand.
 */
export function SchedulesPage({
    initial,
}: {
    /** The page's loader data: shown at once; the poll goes on from it. */
    initial?: SchedulesState;
} = {}) {
    const { t } = useTranslation(['schedules.list']);
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') ?? 'schedules';
    const admin = useIsAdmin();
    const [state, setState] = useState<SchedulesState | undefined>(initial);
    const seeded = useRef(!!initial);
    // The poll's tag: no change is a 304 (api.ts). New loader data
    // replaces the copy, so its tag goes too.
    const [tags] = useState(() => new PollTags());
    useLoaderSeed(initial, (next) => {
        tags.forget();
        setState(next);
    });
    const load = useCallback(
        () =>
            apiIfChanged<SchedulesState>('/schedules', tags.get('/schedules'))
                .then((answer) => {
                    if (answer === UNCHANGED) {
                        return;
                    }
                    setState(answer.data);
                    tags.set('/schedules', answer.tag);
                })
                .catch((e) => failed(e, t('schedules.list:load-failed'))),
        [tags, t],
    );
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
        } else {
            void load();
        }
        const timer = setInterval(() => void load(), 10_000);
        return () => clearInterval(timer);
    }, [load]);
    useLiveTopic('schedules', load);
    return (
        <WorkspacePage
            slot="schedules-page"
            module={MODULE_IDS.schedules}
            title={t('schedules.list:title')}
            description={t('schedules.list:description')}
        >
            <Tabs
                value={tab}
                onValueChange={(next) =>
                    setParams(next === 'schedules' ? {} : { tab: next }, {
                        replace: true,
                    })
                }
                className="gap-4"
            >
                <TabsList aria-label={t('schedules.list:tabs.label')}>
                    <TabsTrigger value="schedules">{t('schedules.list:tabs.schedules')}</TabsTrigger>
                    <TabsTrigger value="jobs">{t('schedules.list:tabs.jobs')}</TabsTrigger>
                    {admin && <TabsTrigger value="workspace">{t('schedules.list:tabs.workspace')}</TabsTrigger>}
                </TabsList>
                <TabsContent value="schedules">
                    {state ? (
                        <>
                            {!!state.goals?.length && <Goals state={state} reload={load} />}
                            <Schedules state={state} reload={load} />
                        </>
                    ) : (
                        <Skeleton className="h-32" />
                    )}
                </TabsContent>
                <TabsContent value="jobs">
                    {state ? <Jobs state={state} reload={load} /> : <Skeleton className="h-32" />}
                </TabsContent>
                {admin && (
                    <TabsContent value="workspace">
                        {state?.counts ? <Counts counts={state.counts} /> : <Skeleton className="h-32" />}
                    </TabsContent>
                )}
            </Tabs>
        </WorkspacePage>
    );
}

/** Which of a goal's lines fits: with or without a schedule, with or without progress. */
const goalContext = (goal: GoalView) =>
    goal.cadence ? (goal.progress ? undefined : 'no-progress') : goal.progress ? 'no-schedule' : 'none';

/**
 * The person's goals: what each Dot is working toward, its latest progress
 * note and status. Pausing and canceling are on the goal's schedule.
 */
function Goals({ state, reload }: { state: SchedulesState; reload: () => void }) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const words = useScheduleWords();
    const dotName = (id: string) =>
        state.schedules.find((schedule) => schedule.dotId === id)?.dotName ?? t('schedules.list:goals.some-socio');
    return (
        <Card className="mb-4" data-slot="goal-list">
            <CardHeader>
                <CardTitle>{t('schedules.list:goals.title')}</CardTitle>
                <CardDescription>{t('schedules.list:goals.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {state.goals.map((goal) => (
                    <div key={goal.id} data-goal={goal.id} className="grid gap-0.5">
                        <span className="font-medium">
                            {goal.threadId ? <Link to={`/chats/${goal.threadId}`}>{goal.title}</Link> : goal.title}{' '}
                            <Badge variant="outline" data-slot="goal-status">
                                {words.goalStatus(goal.status)}
                            </Badge>
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {t('schedules.list:goals.line', {
                                context: goalContext(goal),
                                socio: dotName(goal.dotId),
                                cadence: goal.cadence ?? '',
                                progress: goal.progress ?? '',
                            })}
                        </span>
                        <details data-slot="goal-comments-toggle" className="text-sm">
                            <summary className="w-fit cursor-pointer text-xs text-muted-foreground">
                                {t('schedules:comments.count', { count: goal.comments.length })}
                            </summary>
                            <div className="mt-2">
                                <GoalComments goal={goal} dotName={dotName(goal.dotId)} onPosted={reload} />
                            </div>
                        </details>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

function Schedules({ state, reload }: { state: SchedulesState; reload: () => void }) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const words = useScheduleWords();
    const [busy, setBusy] = useState<string>();
    const [filter, setFilter] = useState<ScheduleFilter>({ query: '', status: '', dot: '' });
    const [cancelling, setCancelling] = useState<ScheduleView>();
    const act = async (schedule: ScheduleView, action: Action) => {
        setBusy(schedule.id);
        try {
            await api(`/schedules/${schedule.id}/actions`, 'POST', { action });
            reload();
        } catch (e) {
            failed(e, t('schedules:actions.change-failed'));
        } finally {
            setBusy(undefined);
        }
    };
    const goalOf = (schedule: ScheduleView) => state.goals.find((goal) => goal.scheduleId === schedule.id);
    const sorted = [...state.schedules].sort(byStatusThenTitle);
    const shown = sorted.filter((schedule) => matches(schedule, filter));
    const socios = dotOptions(state.schedules, t('schedules:deleted-socio'));
    return (
        <Card data-tour="schedules-card">
            <CardHeader>
                <CardTitle>{t('schedules.list:schedules.title')}</CardTitle>
                <CardDescription>
                    {t('schedules.list:schedules.usage', {
                        active: state.usage.activeSchedules,
                        max: state.limits.maxActiveSchedules,
                        minutes: state.limits.minIntervalMinutes,
                    })}
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {!state.schedules.length ? (
                    <p className="text-sm text-muted-foreground">{t('schedules.list:schedules.empty')}</p>
                ) : (
                    <>
                        <GridToolbar label={t('schedules.list:schedules.find')}>
                            <GridSearch
                                label={t('schedules.list:schedules.search')}
                                value={filter.query}
                                onChange={(query) => setFilter({ ...filter, query })}
                            />
                            <GridFilter
                                label={t('schedules.list:schedules.status-filter')}
                                any={t('schedules.list:schedules.status-any')}
                                value={filter.status}
                                options={STATUSES.map((status) => ({
                                    value: status,
                                    label: words.status(status),
                                }))}
                                onChange={(status) => setFilter({ ...filter, status })}
                            />
                            <GridFilter
                                label={t('schedules.list:schedules.socio-filter')}
                                any={t('schedules.list:schedules.socio-any')}
                                value={filter.dot}
                                options={socios}
                                onChange={(dot) => setFilter({ ...filter, dot })}
                            />
                        </GridToolbar>
                        {!shown.length ? (
                            <p className="text-sm text-muted-foreground" data-slot="schedules-empty">
                                {t('schedules.list:schedules.no-match')}
                            </p>
                        ) : (
                            <DataGrid
                                label={t('schedules.list:schedules.grid')}
                                tableSlot="schedule-list"
                                cardsSlot="schedule-cards"
                                rows={shown}
                                rowKey={(schedule) => schedule.id}
                                rowProps={(schedule) => ({ 'data-schedule': schedule.id })}
                                dimmed={(schedule) => schedule.status === 'cancelled'}
                                columns={[
                                    {
                                        id: 'title',
                                        header: t('schedules.list:schedules.columns.title'),
                                        className: 'min-w-48 max-w-72 whitespace-normal',
                                        cell: (schedule) => <ScheduleTitle schedule={schedule} />,
                                        compare: (a, b) => compareText(a.title, b.title),
                                    },
                                    {
                                        id: 'status',
                                        header: t('schedules.list:schedules.columns.status'),
                                        cell: (schedule) => <StatusBadge schedule={schedule} />,
                                        compare: byStatusThenTitle,
                                    },
                                    {
                                        id: 'cadence',
                                        header: t('schedules.list:schedules.columns.cadence'),
                                        className: 'min-w-40 whitespace-normal text-sm',
                                        cell: (schedule) => <Cadence schedule={schedule} />,
                                    },
                                    {
                                        id: 'next',
                                        header: t('schedules.list:schedules.columns.next'),
                                        className: 'whitespace-nowrap text-sm',
                                        cell: (schedule) => <When value={schedule.nextRunAt} />,
                                        compare: byTime((schedule) => schedule.nextRunAt),
                                    },
                                    {
                                        id: 'last',
                                        header: t('schedules.list:schedules.columns.last'),
                                        className: 'text-sm',
                                        cell: (schedule) => <LastRun schedule={schedule} />,
                                        compare: byTime((schedule) => schedule.lastRun?.startedAt),
                                    },
                                    {
                                        id: 'goal',
                                        header: t('schedules.list:schedules.columns.goal'),
                                        className: 'max-w-56 whitespace-normal text-sm',
                                        cell: (schedule) => goalTitle(goalOf(schedule)),
                                    },
                                ]}
                                actions={(schedule) => (
                                    <ScheduleRowMenu
                                        schedule={schedule}
                                        busy={busy}
                                        onCancel={() => setCancelling(schedule)}
                                        onAct={act}
                                    />
                                )}
                                card={(schedule) => {
                                    const goal = goalOf(schedule);
                                    return {
                                        head: <ScheduleTitle schedule={schedule} />,
                                        body: (
                                            <>
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                                    <StatusBadge schedule={schedule} />
                                                    <span className="whitespace-normal">
                                                        <Cadence schedule={schedule} />
                                                    </span>
                                                </div>
                                                <div className="grid gap-0.5 text-sm">
                                                    <div>
                                                        <span className="text-muted-foreground">
                                                            {t('schedules.list:schedules.next')}{' '}
                                                        </span>
                                                        <When value={schedule.nextRunAt} />
                                                    </div>
                                                    <div>
                                                        <span className="text-muted-foreground">
                                                            {t('schedules.list:schedules.last')}{' '}
                                                        </span>
                                                        <LastRun schedule={schedule} />
                                                    </div>
                                                    {goal && (
                                                        <div className="whitespace-normal">
                                                            <span className="text-muted-foreground">
                                                                {t('schedules.list:schedules.goal')}{' '}
                                                            </span>
                                                            {goalTitle(goal)}
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        ),
                                    };
                                }}
                            />
                        )}
                    </>
                )}
                {cancelling && (
                    <CancelScheduleDialog
                        schedule={cancelling}
                        onClose={() => setCancelling(undefined)}
                        onConfirm={async () => {
                            const schedule = cancelling;
                            setCancelling(undefined);
                            await act(schedule, 'cancel');
                        }}
                    />
                )}
            </CardContent>
        </Card>
    );
}

/** A schedule's title and socio, as content (used by the table cell and the mobile card). */
function ScheduleTitle({ schedule }: { schedule: ScheduleView }) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const socio = schedule.dotName ?? t('schedules:deleted-socio');
    const context = schedule.origin === 'user' ? 'mine' : undefined;
    return (
        <div className="grid gap-0.5">
            <span className="font-medium">
                <Link to={`/schedules/${schedule.id}`}>{schedule.title}</Link>
            </span>
            <span className="text-xs text-muted-foreground">
                {schedule.kind !== 'job'
                    ? t('schedules.list:schedules.meta-turn', { socio, context })
                    : schedule.jobName
                      ? t('schedules.list:schedules.meta', { socio, job: schedule.jobName, context })
                      : t('schedules.list:schedules.meta-deleted-job', { socio, context })}
            </span>
        </div>
    );
}

function Cadence({ schedule }: { schedule: ScheduleView }) {
    const { t } = useTranslation(['schedules.list']);
    const words = useScheduleWords();
    return schedule.cadence
        ? t('schedules.list:schedules.cadence', { cadence: schedule.cadence, zone: schedule.timezone ?? 'UTC' })
        : schedule.intervalSeconds
          ? words.interval(schedule.intervalSeconds)
          : '—';
}

function LastRun({ schedule }: { schedule: ScheduleView }) {
    const { t } = useTranslation(['schedules.list']);
    return schedule.lastRun ? (
        <div className="grid gap-0.5">
            <span>
                <RunBadge status={schedule.lastRun.status} />{' '}
                <span className="whitespace-nowrap">
                    <When value={schedule.lastRun.startedAt} />
                </span>
            </span>
            {schedule.lastRun.error && (
                <span className="max-w-60 truncate text-xs text-muted-foreground">{schedule.lastRun.error}</span>
            )}
        </div>
    ) : (
        t('schedules.list:schedules.not-yet')
    );
}

function goalTitle(goal: GoalView | undefined) {
    if (!goal) {
        return null;
    }
    return goal.threadId ? <Link to={`/chats/${goal.threadId}`}>{goal.title}</Link> : goal.title;
}

/** A schedule row's actions, in a ⋯ menu (CB-392): each clearly targets its own row. */
function ScheduleRowMenu({
    schedule,
    busy,
    onAct,
    onCancel,
}: {
    schedule: ScheduleView;
    busy: string | undefined;
    onAct: (schedule: ScheduleView, action: Action) => Promise<void>;
    onCancel: () => void;
}) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const off = schedule.status === 'cancelled';
    return (
        <RowActionsMenu name={schedule.title} slot="schedule-actions" title={schedule.title}>
            <DropdownMenuItem asChild>
                <Link to={`/schedules/${schedule.id}`}>{t('schedules.list:schedules.open')}</Link>
            </DropdownMenuItem>
            {off ? (
                <DropdownMenuItem disabled>{t('schedules.list:schedules.canceled')}</DropdownMenuItem>
            ) : (
                <>
                    {schedule.status !== 'running' && (
                        <DropdownMenuItem disabled={busy === schedule.id} onSelect={() => void onAct(schedule, 'run')}>
                            {t('schedules:actions.run')}
                        </DropdownMenuItem>
                    )}
                    {schedule.status === 'paused' ? (
                        <DropdownMenuItem
                            disabled={busy === schedule.id}
                            onSelect={() => void onAct(schedule, 'resume')}
                        >
                            {t('schedules:actions.resume')}
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            disabled={busy === schedule.id}
                            onSelect={() => void onAct(schedule, 'pause')}
                        >
                            {t('schedules:actions.pause')}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onCancel}>
                        {t('schedules.list:schedules.cancel')}
                    </DropdownMenuItem>
                </>
            )}
        </RowActionsMenu>
    );
}

function StatusBadge({ schedule }: { schedule: ScheduleView }) {
    const words = useScheduleWords();
    return (
        <Badge variant={STATUS_TONE[schedule.status]} data-slot="schedule-status">
            {words.status(schedule.status)}
        </Badge>
    );
}

/** Sorts by a timestamp, the ones without it last. */
const byTime = (at: (schedule: ScheduleView) => number | null | undefined) => (a: ScheduleView, b: ScheduleView) => {
    const x = at(a) ?? Infinity;
    const y = at(b) ?? Infinity;
    return x === y ? 0 : x < y ? -1 : 1;
};

function Jobs({ state, reload }: { state: SchedulesState; reload: () => void }) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const [open, setOpen] = useState<string>();
    const run = async (job: JobView) => {
        try {
            await api(`/schedules/jobs/${job.id}/run`, 'POST', {});
            toast.success(
                t('schedules.list:jobs.started', { name: job.name, context: job.untilDone ? 'until-done' : undefined }),
            );
            reload();
        } catch (e) {
            failed(e, t('schedules.list:jobs.start-failed'));
        }
    };
    const going = (job: JobView) => job.longRun?.status === 'running' || job.longRun?.status === 'waiting';
    return (
        <div className="grid gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>{t('schedules.list:jobs.title')}</CardTitle>
                    <CardDescription>
                        {t('schedules.list:jobs.description', {
                            timeout: formatSeconds(state.limits.maxJobTimeoutSeconds),
                            jobs: state.usage.jobs,
                            max: state.limits.maxJobs,
                        })}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {!state.jobs.length ? (
                        <p className="text-sm text-muted-foreground">{t('schedules.list:jobs.empty')}</p>
                    ) : (
                        <Table data-slot="job-list">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('schedules.list:jobs.columns.job')}</TableHead>
                                    <TableHead>{t('schedules.list:jobs.columns.version')}</TableHead>
                                    <TableHead>{t('schedules.list:jobs.columns.timeout')}</TableHead>
                                    <TableHead>{t('schedules.list:jobs.columns.last')}</TableHead>
                                    <TableHead className="text-right">
                                        {t('schedules.list:jobs.columns.actions')}
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {state.jobs.map((job) => (
                                    <TableRow key={job.id} data-job={job.id}>
                                        <TableCell>
                                            <div className="grid gap-0.5">
                                                <span className="font-medium">{job.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {t('schedules.list:jobs.meta', {
                                                        socio: job.dotName ?? t('schedules:deleted-socio'),
                                                        entry: job.entry,
                                                        count: job.files.length,
                                                        context: job.untilDone ? 'until-done' : undefined,
                                                    })}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {t('schedules.list:jobs.version', { version: job.version })}
                                        </TableCell>
                                        <TableCell>{formatSeconds(job.timeoutSeconds)}</TableCell>
                                        <TableCell className="text-sm">
                                            {job.longRun ? (
                                                <LongRunLine run={job.longRun} />
                                            ) : job.lastRun ? (
                                                <span className="whitespace-nowrap">
                                                    <RunBadge status={job.lastRun.status} />{' '}
                                                    <When value={job.lastRun.startedAt ?? job.lastRun.queuedAt} />
                                                </span>
                                            ) : (
                                                t('schedules.list:jobs.never')
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-1">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={going(job)}
                                                    onClick={() => void run(job)}
                                                >
                                                    {going(job)
                                                        ? t('schedules.list:jobs.running')
                                                        : t('schedules:actions.run')}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    aria-expanded={open === job.id}
                                                    onClick={() => setOpen(open === job.id ? undefined : job.id)}
                                                >
                                                    {open === job.id
                                                        ? t('schedules.list:jobs.hide')
                                                        : t('schedules.list:jobs.details')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
            {open && (
                <JobPanel
                    key={open}
                    jobId={open}
                    refresh={state}
                    onChanged={reload}
                    onDeleted={() => {
                        setOpen(undefined);
                        reload();
                    }}
                />
            )}
        </div>
    );
}

function Counts({ counts }: { counts: NonNullable<SchedulesState['counts']> }) {
    const { t } = useTranslation(['schedules.list', 'schedules']);
    const words = useScheduleWords();
    const rows = (record: Record<string, number>) =>
        Object.entries(record).length
            ? Object.entries(record)
                  .map(([status, count]) =>
                      t('schedules.list:counts.status', { count, status: words.runStatus(status) }),
                  )
                  .join(' · ')
            : t('schedules.list:counts.none');
    return (
        <Card data-slot="schedule-counts">
            <CardHeader>
                <CardTitle>{t('schedules.list:counts.title')}</CardTitle>
                <CardDescription>{t('schedules.list:counts.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
                <div>{t('schedules.list:counts.schedules', { counts: rows(counts.schedules) })}</div>
                <div>{t('schedules.list:counts.jobs', { count: counts.jobs })}</div>
                <div>{t('schedules.list:counts.job-runs', { counts: rows(counts.jobRuns) })}</div>
                <div>{t('schedules.list:counts.running', { count: counts.runningJobs })}</div>
            </CardContent>
        </Card>
    );
}
