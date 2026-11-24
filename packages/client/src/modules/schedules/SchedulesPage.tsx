import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { jobEntryCommand } from '@socio/shared/job-entry';
import { compareText } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import type {
    GoalView,
    JobDetail,
    JobRunsPage,
    JobRunView,
    JobView,
    ScheduleView,
    SchedulesState,
} from '@socio/shared/schedule-types';
import type { Action, Status } from '@socio/shared/types';

import { DataGrid, GridFilter, GridSearch, GridToolbar, RowActionsMenu } from '../../components/data-grid/DataGrid';
import { api, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useIsAdmin } from '../../shell/current-user';
import { WorkspacePage } from '../../views/WorkspacePage';

import { CancelScheduleDialog } from './CancelScheduleDialog';
import { GoalComments } from './GoalComments';
import { LongRunLine, LongRunProgress } from './LongRunProgress';
import {
    byStatusThenTitle,
    dotOptions,
    matches,
    STATUS_LABELS,
    STATUS_TONE,
    type ScheduleFilter,
} from './schedules-format';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
export const dateTime = (t: number) =>
    new Date(t).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
/** A time in the reader's words once the page has hydrated; else a dash. */
export function When({ value }: { value: number | null | undefined }) {
    return value ? <LocalTime value={value} format={dateTime} /> : '—';
}
/** A repeat interval of a task made in a conversation, in words. */
export const every = (seconds: number) =>
    seconds === 604_800
        ? 'every week'
        : seconds === 86_400
          ? 'every day'
          : seconds === 3600
            ? 'every hour'
            : seconds % 3600 === 0
              ? `every ${seconds / 3600} hours`
              : `every ${Math.round(seconds / 60)} min`;
export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);

const RUN_TONE: Record<string, 'default' | 'secondary' | 'destructive'> = {
    succeeded: 'default',
    completed: 'default',
    done: 'default',
    cancelled: 'secondary',
    failed: 'destructive',
    timed_out: 'destructive',
    interrupted: 'secondary',
};
export function RunBadge({ status }: { status: string }) {
    return (
        <Badge variant={RUN_TONE[status] ?? 'outline'} data-status={status}>
            {status.replace('_', ' ')}
        </Badge>
    );
}

/**
 * `/schedules`: the signed-in user's schedules (proposed by their Dots and
 * approved, or made in a conversation) and their Dots' jobs. Pause, resume,
 * cancel, run now; a job's versions, runs and logs. Each user sees only
 * their own; admins also see the workspace's counts.
 */
export function SchedulesPage({
    initial,
}: {
    /** The page's loader data: shown at once; the poll goes on from it. */
    initial?: SchedulesState;
} = {}) {
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
                .catch((e) => failed(e, 'Could not load schedules.')),
        [tags],
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
            title="Schedules & jobs"
            description="Recurring work your socios do for you. A schedule runs a socio turn (in its own conversation, on your model) or a job: code a socio saved, run in its computer without the model. New ones need your approval; you can pause or cancel any of them here."
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
                <TabsList aria-label="Schedules and jobs">
                    <TabsTrigger value="schedules">Schedules</TabsTrigger>
                    <TabsTrigger value="jobs">Jobs</TabsTrigger>
                    {admin && <TabsTrigger value="workspace">Workspace</TabsTrigger>}
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

/**
 * The person's goals: what each Dot is working toward, its latest progress
 * note and status. Pausing and canceling are on the goal's schedule.
 */
function Goals({ state, reload }: { state: SchedulesState; reload: () => void }) {
    const dotName = (id: string) => state.schedules.find((schedule) => schedule.dotId === id)?.dotName ?? 'A socio';
    return (
        <Card className="mb-4" data-slot="goal-list">
            <CardHeader>
                <CardTitle>Goals</CardTitle>
                <CardDescription>
                    What your socios keep working toward for you. Pause or cancel a goal by its schedule below; a socio
                    marks it done when it is met.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {state.goals.map((goal) => (
                    <div key={goal.id} data-goal={goal.id} className="grid gap-0.5">
                        <span className="font-medium">
                            {goal.threadId ? <Link to={`/chats/${goal.threadId}`}>{goal.title}</Link> : goal.title}{' '}
                            <Badge variant="outline" data-slot="goal-status">
                                {goal.status}
                            </Badge>
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {dotName(goal.dotId)} · {goal.cadence ?? 'no schedule'}
                            {goal.progress ? ` · ${goal.progress}` : ' · no progress yet'}
                        </span>
                        <details data-slot="goal-comments-toggle" className="text-sm">
                            <summary className="w-fit cursor-pointer text-xs text-muted-foreground">
                                {goal.comments.length === 1 ? '1 comment' : `${goal.comments.length} comments`}
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
    const [busy, setBusy] = useState<string>();
    const [filter, setFilter] = useState<ScheduleFilter>({ query: '', status: '', dot: '' });
    const [cancelling, setCancelling] = useState<ScheduleView>();
    const act = async (schedule: ScheduleView, action: Action) => {
        setBusy(schedule.id);
        try {
            await api(`/schedules/${schedule.id}/actions`, 'POST', { action });
            reload();
        } catch (e) {
            failed(e, 'Could not change the schedule.');
        } finally {
            setBusy(undefined);
        }
    };
    const goalOf = (schedule: ScheduleView) => state.goals.find((goal) => goal.scheduleId === schedule.id);
    const sorted = [...state.schedules].sort(byStatusThenTitle);
    const shown = sorted.filter((schedule) => matches(schedule, filter));
    const socios = dotOptions(state.schedules);
    return (
        <Card data-tour="schedules-card">
            <CardHeader>
                <CardTitle>Schedules</CardTitle>
                <CardDescription>
                    {state.usage.activeSchedules} of {state.limits.maxActiveSchedules} active schedules. Runs are at
                    least {state.limits.minIntervalMinutes} minutes apart.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {!state.schedules.length ? (
                    <p className="text-sm text-muted-foreground">
                        No schedules yet. Ask a socio to do something regularly, or use the clock button in a
                        conversation.
                    </p>
                ) : (
                    <>
                        <GridToolbar label="Find schedules">
                            <GridSearch
                                label="Search title, socio or job"
                                value={filter.query}
                                onChange={(query) => setFilter({ ...filter, query })}
                            />
                            <GridFilter
                                label="Status filter"
                                any="Status: any"
                                value={filter.status}
                                options={(Object.keys(STATUS_LABELS) as Status[]).map((status) => ({
                                    value: status,
                                    label: STATUS_LABELS[status],
                                }))}
                                onChange={(status) => setFilter({ ...filter, status })}
                            />
                            <GridFilter
                                label="Socio filter"
                                any="Socio: any"
                                value={filter.dot}
                                options={socios}
                                onChange={(dot) => setFilter({ ...filter, dot })}
                            />
                        </GridToolbar>
                        {!shown.length ? (
                            <p className="text-sm text-muted-foreground" data-slot="schedules-empty">
                                No schedules match.
                            </p>
                        ) : (
                            <DataGrid
                                label="Schedules"
                                tableSlot="schedule-list"
                                cardsSlot="schedule-cards"
                                rows={shown}
                                rowKey={(schedule) => schedule.id}
                                rowProps={(schedule) => ({ 'data-schedule': schedule.id })}
                                dimmed={(schedule) => schedule.status === 'cancelled'}
                                columns={[
                                    {
                                        id: 'title',
                                        header: 'Schedule',
                                        className: 'min-w-48 max-w-72 whitespace-normal',
                                        cell: scheduleTitle,
                                        compare: (a, b) => compareText(a.title, b.title),
                                    },
                                    {
                                        id: 'status',
                                        header: 'Status',
                                        cell: (schedule) => <StatusBadge schedule={schedule} />,
                                        compare: byStatusThenTitle,
                                    },
                                    {
                                        id: 'cadence',
                                        header: 'Runs',
                                        className: 'min-w-40 whitespace-normal text-sm',
                                        cell: cadenceText,
                                    },
                                    {
                                        id: 'next',
                                        header: 'Next run',
                                        className: 'whitespace-nowrap text-sm',
                                        cell: (schedule) => <When value={schedule.nextRunAt} />,
                                        compare: byTime((schedule) => schedule.nextRunAt),
                                    },
                                    {
                                        id: 'last',
                                        header: 'Last run',
                                        className: 'text-sm',
                                        cell: lastRun,
                                        compare: byTime((schedule) => schedule.lastRun?.startedAt),
                                    },
                                    {
                                        id: 'goal',
                                        header: 'Goal',
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
                                        head: scheduleTitle(schedule),
                                        body: (
                                            <>
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                                    <StatusBadge schedule={schedule} />
                                                    <span className="whitespace-normal">{cadenceText(schedule)}</span>
                                                </div>
                                                <div className="grid gap-0.5 text-sm">
                                                    <div>
                                                        <span className="text-muted-foreground">Next: </span>
                                                        <When value={schedule.nextRunAt} />
                                                    </div>
                                                    <div>
                                                        <span className="text-muted-foreground">Last: </span>
                                                        {lastRun(schedule)}
                                                    </div>
                                                    {goal && (
                                                        <div className="whitespace-normal">
                                                            <span className="text-muted-foreground">Goal: </span>
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
function scheduleTitle(schedule: ScheduleView) {
    return (
        <div className="grid gap-0.5">
            <span className="font-medium">
                <Link to={`/schedules/${schedule.id}`}>{schedule.title}</Link>
            </span>
            <span className="text-xs text-muted-foreground">
                {schedule.dotName ?? 'A deleted socio'} ·{' '}
                {schedule.kind === 'job' ? `job ${schedule.jobName ?? '(deleted)'}` : 'Socio turn'}
                {schedule.origin === 'user' ? ' · made by you' : ''}
            </span>
        </div>
    );
}

function cadenceText(schedule: ScheduleView) {
    return schedule.cadence
        ? `${schedule.cadence} (${schedule.timezone ?? 'UTC'})`
        : schedule.intervalSeconds
          ? `${every(schedule.intervalSeconds)}, after each successful run`
          : '—';
}

function lastRun(schedule: ScheduleView) {
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
        'Not yet'
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
    const off = schedule.status === 'cancelled';
    return (
        <RowActionsMenu name={schedule.title} slot="schedule-actions" title={schedule.title}>
            <DropdownMenuItem asChild>
                <Link to={`/schedules/${schedule.id}`}>Open</Link>
            </DropdownMenuItem>
            {off ? (
                <DropdownMenuItem disabled>Canceled</DropdownMenuItem>
            ) : (
                <>
                    {schedule.status !== 'running' && (
                        <DropdownMenuItem disabled={busy === schedule.id} onSelect={() => void onAct(schedule, 'run')}>
                            Run now
                        </DropdownMenuItem>
                    )}
                    {schedule.status === 'paused' ? (
                        <DropdownMenuItem
                            disabled={busy === schedule.id}
                            onSelect={() => void onAct(schedule, 'resume')}
                        >
                            Resume
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            disabled={busy === schedule.id}
                            onSelect={() => void onAct(schedule, 'pause')}
                        >
                            Pause
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onCancel}>
                        Cancel…
                    </DropdownMenuItem>
                </>
            )}
        </RowActionsMenu>
    );
}

function StatusBadge({ schedule }: { schedule: ScheduleView }) {
    return (
        <Badge variant={STATUS_TONE[schedule.status]} data-slot="schedule-status">
            {STATUS_LABELS[schedule.status]}
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
    const [open, setOpen] = useState<string>();
    const run = async (job: JobView) => {
        try {
            await api(`/schedules/jobs/${job.id}/run`, 'POST', {});
            toast.success(job.untilDone ? `Started “${job.name}”; it runs until done.` : `Started “${job.name}”.`);
            reload();
        } catch (e) {
            failed(e, 'Could not start the job.');
        }
    };
    const going = (job: JobView) => job.longRun?.status === 'running' || job.longRun?.status === 'waiting';
    return (
        <div className="grid gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>Jobs</CardTitle>
                    <CardDescription>
                        Code your socios saved, run in their computer with a timeout (at most{' '}
                        {state.limits.maxJobTimeoutSeconds} s, including starting the computer). A run reaches your data
                        only through a token for that run. {state.usage.jobs} of {state.limits.maxJobs} jobs.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {!state.jobs.length ? (
                        <p className="text-sm text-muted-foreground">
                            No jobs yet. A socio saves one with your approval when it needs to collect something
                            regularly.
                        </p>
                    ) : (
                        <Table data-slot="job-list">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Job</TableHead>
                                    <TableHead>Version</TableHead>
                                    <TableHead>Timeout</TableHead>
                                    <TableHead>Last run</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {state.jobs.map((job) => (
                                    <TableRow key={job.id} data-job={job.id}>
                                        <TableCell>
                                            <div className="grid gap-0.5">
                                                <span className="font-medium">{job.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {job.dotName ?? 'A deleted socio'} · {job.entry} ·{' '}
                                                    {job.files.length} file(s)
                                                    {job.untilDone ? ' · runs until done' : ''}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell>v{job.version}</TableCell>
                                        <TableCell>{job.timeoutSeconds} s</TableCell>
                                        <TableCell className="text-sm">
                                            {job.longRun ? (
                                                <LongRunLine run={job.longRun} />
                                            ) : job.lastRun ? (
                                                <span className="whitespace-nowrap">
                                                    <RunBadge status={job.lastRun.status} />{' '}
                                                    <When value={job.lastRun.startedAt ?? job.lastRun.queuedAt} />
                                                </span>
                                            ) : (
                                                'Never'
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
                                                    {going(job) ? 'Running' : 'Run now'}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    aria-expanded={open === job.id}
                                                    onClick={() => setOpen(open === job.id ? undefined : job.id)}
                                                >
                                                    {open === job.id ? 'Hide' : 'Details'}
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

function JobPanel({
    jobId,
    refresh,
    onChanged,
    onDeleted,
}: {
    jobId: string;
    /** Reloads with the page's poll. */
    refresh: unknown;
    onChanged: () => void;
    onDeleted: () => void;
}) {
    const [detail, setDetail] = useState<JobDetail>();
    const [run, setRun] = useState<JobRunView>();
    const [code, setCode] = useState<{
        version: number;
        files: Record<string, string>;
    }>();
    const [confirming, setConfirming] = useState(false);
    // Runs past the detail's latest, read with "Load more" (every run is kept).
    const [older, setOlder] = useState<JobRunsPage>({ runs: [], more: false });
    const loaded = useRef(0);
    useEffect(() => {
        loaded.current = 0;
        setOlder({ runs: [], more: false });
    }, [jobId]);
    useEffect(() => {
        let current = true;
        void (async () => {
            const next = await api<JobDetail>(`/schedules/jobs/${jobId}`);
            // A reload reads the older runs shown again, after the new latest.
            const last = next.runs.at(-1);
            const again =
                loaded.current && last && next.moreRuns
                    ? await api<JobRunsPage>(
                          `/schedules/jobs/${jobId}/runs?before=${encodeURIComponent(last.id)}&limit=${Math.min(loaded.current, 200)}`,
                      )
                    : undefined;
            if (!current) {
                return;
            }
            setDetail(next);
            if (loaded.current) {
                setOlder(again ?? { runs: [], more: false });
            }
        })().catch((e) => failed(e, 'Could not load the job.'));
        return () => {
            current = false;
        };
    }, [jobId, refresh]);
    const runs = detail ? [...detail.runs, ...older.runs] : [];
    const moreRuns = older.runs.length ? older.more : !!detail?.moreRuns;
    const loadMore = () => {
        const last = runs.at(-1);
        if (!last) {
            return;
        }
        void api<JobRunsPage>(`/schedules/jobs/${jobId}/runs?before=${encodeURIComponent(last.id)}`)
            .then((page) => {
                setOlder((shown) => {
                    const runs = [...shown.runs, ...page.runs];
                    loaded.current = runs.length;
                    return { runs, more: page.more };
                });
            })
            .catch((e) => failed(e, 'Could not load older runs.'));
    };
    const showRun = (id: string) =>
        void api<JobRunView>(`/schedules/runs/${id}`)
            .then(setRun)
            .catch((e) => failed(e, 'Could not load the run.'));
    const showCode = (version: number) =>
        void api<{ version: number; files: Record<string, string> }>(`/schedules/jobs/${jobId}/code?version=${version}`)
            .then(setCode)
            .catch((e) => failed(e, 'Could not load the code.'));
    const stop = async () => {
        try {
            await api(`/schedules/jobs/${jobId}/stop`, 'POST', {});
            toast.success(`Stopped ${detail?.job.name ?? 'the job'}.`);
            onChanged();
        } catch (e) {
            failed(e, 'Could not stop the job.');
        }
    };
    const retry = async () => {
        try {
            await api(`/schedules/jobs/${jobId}/retry`, 'POST', {});
            toast.success(`Restored the approved code of ${detail?.job.name ?? 'the job'} and started it.`);
            onChanged();
        } catch (e) {
            failed(e, 'Could not restore the job’s code.');
        }
    };
    const remove = async () => {
        try {
            await api(`/schedules/jobs/${jobId}`, 'DELETE', {});
            toast.success(`Deleted ${detail?.job.name ?? 'the job'}.`);
            setConfirming(false);
            onDeleted();
        } catch (e) {
            failed(e, 'Could not delete the job.');
        }
    };
    if (!detail) {
        return <Skeleton className="h-32" />;
    }
    return (
        <Card data-slot="job-detail">
            <CardHeader>
                <CardTitle>{detail.job.name}</CardTitle>
                <CardDescription>
                    {jobEntryCommand(detail.job.entry)} · datasets: scratch
                    {detail.job.datasets.filter((id) => id !== 'scratch').length
                        ? ` + ${detail.job.datasets.filter((id) => id !== 'scratch').length} granted`
                        : ''}{' '}
                    · code stored encrypted in your data space
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                {detail.code.state !== 'stored' && (
                    <div
                        className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2 text-sm"
                        data-slot="job-code-missing"
                    >
                        <span>
                            The code of v{detail.job.version} isn’t in storage
                            {detail.code.missing.length ? ` (${detail.code.missing.join(', ')})` : ''}, so it can’t run.
                            Restoring stores the code you approved again.
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void retry()}>
                            Restore code and run
                        </Button>
                    </div>
                )}
                {detail.longRun && <LongRunProgress run={detail.longRun} onStop={() => void stop()} />}
                <div className="grid gap-2">
                    <h3 className="text-sm font-medium">Versions</h3>
                    <ul className="grid gap-1 text-sm">
                        {detail.versions.map((version) => (
                            <li key={version.version} className="flex items-center gap-2">
                                <span>v{version.version}</span>
                                <span className="text-muted-foreground">
                                    <When value={version.createdAt} /> · {version.timeoutSeconds} s
                                    {version.untilDone ? ' per batch, until done' : ''} ·{' '}
                                    {version.files.map((file) => file.path).join(', ')}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => showCode(version.version)}>
                                    Code
                                </Button>
                            </li>
                        ))}
                    </ul>
                    {code && (
                        <div className="grid gap-2" data-slot="job-code">
                            {Object.entries(code.files).map(([path, contents]) => (
                                <div key={path}>
                                    <div className="text-xs text-muted-foreground">
                                        v{code.version} · {path}
                                    </div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {contents}
                                    </pre>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="grid gap-2">
                    <h3 className="text-sm font-medium">Runs</h3>
                    {!detail.runs.length ? (
                        <p className="text-sm text-muted-foreground">No runs yet.</p>
                    ) : (
                        <Table data-slot="job-runs">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Started</TableHead>
                                    <TableHead>Trigger</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Exit</TableHead>
                                    <TableHead>Took</TableHead>
                                    <TableHead />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {runs.map((item) => (
                                    <TableRow key={item.id}>
                                        <TableCell className="whitespace-nowrap">
                                            <When value={item.startedAt ?? item.queuedAt} />
                                        </TableCell>
                                        <TableCell>
                                            {item.trigger === 'dot' ? 'the socio' : item.trigger} · v{item.version}
                                            {item.longRunId ? ' · batch' : ''}
                                        </TableCell>
                                        <TableCell>
                                            <RunBadge status={item.status} />
                                        </TableCell>
                                        <TableCell>{item.exitCode ?? '—'}</TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            {item.finishedAt && item.startedAt
                                                ? seconds(item.finishedAt - item.startedAt)
                                                : '—'}
                                            {item.wakeMs ? ` (wake ${seconds(item.wakeMs)})` : ''}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button size="sm" variant="ghost" onClick={() => showRun(item.id)}>
                                                Logs
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    {moreRuns && (
                        <Button variant="outline" size="sm" className="justify-self-center" onClick={loadMore}>
                            Load more
                        </Button>
                    )}
                    {run && (
                        <div className="grid gap-2" data-slot="job-logs">
                            <div className="text-sm">
                                Run <When value={run.startedAt ?? run.queuedAt} />: <RunBadge status={run.status} />
                                {run.error ? ` ${run.error}` : ''}
                            </div>
                            {run.outputNotKept ? (
                                <p className="text-sm text-muted-foreground" data-slot="job-output-not-kept">
                                    {run.outputNotKept}
                                </p>
                            ) : (
                                <>
                                    <div className="text-xs text-muted-foreground">stdout</div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {run.stdout || '(empty)'}
                                    </pre>
                                    <div className="text-xs text-muted-foreground">stderr</div>
                                    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                                        {run.stderr || '(empty)'}
                                    </pre>
                                </>
                            )}
                        </div>
                    )}
                </div>
                <div>
                    <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
                        Delete job
                    </Button>
                </div>
                {confirming && (
                    <ConfirmDelete
                        title="Delete job?"
                        slot="job-confirm-delete"
                        onClose={() => setConfirming(false)}
                        onConfirm={remove}
                    >
                        This will delete {detail.job.name}. It leaves your jobs and its socio&apos;s, and schedules that
                        run it stop.
                    </ConfirmDelete>
                )}
            </CardContent>
        </Card>
    );
}

function Counts({ counts }: { counts: NonNullable<SchedulesState['counts']> }) {
    const rows = (record: Record<string, number>) =>
        Object.entries(record).length
            ? Object.entries(record)
                  .map(([status, n]) => `${n} ${status.replace('_', ' ')}`)
                  .join(' · ')
            : 'none';
    return (
        <Card data-slot="schedule-counts">
            <CardHeader>
                <CardTitle>Everyone’s</CardTitle>
                <CardDescription>Counts only: what each person’s schedules and jobs do is theirs.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
                <div>Schedules: {rows(counts.schedules)}</div>
                <div>Saved jobs: {counts.jobs}</div>
                <div>Job runs kept: {rows(counts.jobRuns)}</div>
                <div>Job runs in progress: {counts.runningJobs}</div>
            </CardContent>
        </Card>
    );
}
