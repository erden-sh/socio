import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { MODULE_IDS } from '@socio/shared/modules';
import type {
    ScheduleDetail,
    ScheduleRunBoardItem,
    ScheduleRunsPage,
    ScheduleView,
} from '@socio/shared/schedule-types';
import type { Action } from '@socio/shared/types';

import { api, ApiError } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useLoaderSeed } from '../../lib/page-loader';
import { useRouteParams } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { CancelScheduleDialog } from './CancelScheduleDialog';
import { GoalComments } from './GoalComments';
import { Purpose } from './Purpose';
import { every, RunBadge, seconds, When } from './SchedulesPage';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const repeats = (schedule: ScheduleView) => !!schedule.cadence || !!schedule.intervalSeconds;
/** A link within text: underlined, as in Markdown (IssueMarkdown). */
const LINK = 'underline underline-offset-2 hover:text-primary';
const took = (ms: number) => (ms < 60_000 ? seconds(ms) : `${Math.round(ms / 6_000) / 10} min`);

/** Where a schedule stands, in words: active, paused (and why), done. */
function standing(schedule: ScheduleView): { label: string; note: string } {
    switch (schedule.status) {
        case 'paused':
            return {
                label: 'Paused',
                note: schedule.error ?? 'It keeps its cadence and runs again once you resume it.',
            };
        case 'cancelled':
            return { label: 'Canceled', note: 'It won’t run again.' };
        case 'failed':
            return {
                label: 'Stopped',
                note: schedule.error ?? 'Its last run failed.',
            };
        case 'completed':
            if (!repeats(schedule)) {
                return { label: 'Completed', note: 'It ran and has nothing left.' };
            }
            break;
        case 'running':
            return { label: 'Active', note: 'Running now.' };
    }
    return { label: 'Active', note: 'It runs at its next time.' };
}

const BOARD_VERB: Record<ScheduleRunBoardItem['action'], string> = {
    create: 'Filed',
    comment: 'Commented on',
    vote: 'Voted for',
    unvote: 'Withdrew a vote on',
    update: 'Updated dependencies on',
};

/** One row of the "What it does" list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{children}</dd>
        </div>
    );
}

/**
 * `/schedules/:scheduleId`: one of the person's schedules (or tasks) in
 * full (CB-88). What it is for (its prompt or goal, as Markdown), what it
 * does (the Dot, cadence and next runs, time zone, chat, the approvals
 * that apply, its status and actions), what it has done (its runs,
 * newest first, paged, each linked to its turn and to what it did on the
 * board), and its goal's progress. Only the person's own.
 */
export function SchedulePage({
    initial,
}: {
    /** The page's loader data: shown at once; the poll goes on from it. */
    initial?: ScheduleDetail;
} = {}) {
    const { scheduleId = '' } = useRouteParams();
    const [detail, setDetail] = useState<ScheduleDetail | undefined>(
        initial?.schedule.id === scheduleId ? initial : undefined,
    );
    const [missing, setMissing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    // Runs past the detail's latest, read with "Load more".
    const [older, setOlder] = useState<ScheduleRunsPage>({
        runs: [],
        more: false,
    });
    const loaded = useRef(0);
    const seeded = useRef(!!detail);
    useLoaderSeed(initial, (next) => {
        if (next.schedule.id === scheduleId) {
            setDetail(next);
        }
    });
    const load = useCallback(async () => {
        try {
            const next = await api<ScheduleDetail>(`/schedules/${encodeURIComponent(scheduleId)}`);
            // A reload reads the older runs shown again, after the new latest.
            const last = next.runs.at(-1);
            const again =
                loaded.current && last && next.moreRuns
                    ? await api<ScheduleRunsPage>(
                          `/schedules/${encodeURIComponent(scheduleId)}/runs?before=${encodeURIComponent(last.id)}&limit=${Math.min(loaded.current, 200)}`,
                      )
                    : undefined;
            setDetail(next);
            setMissing(false);
            if (loaded.current) {
                setOlder(again ?? { runs: [], more: false });
            }
        } catch (e) {
            if (e instanceof ApiError && e.status === 404) {
                setMissing(true);
            } else {
                failed(e, 'Could not load the schedule.');
            }
        }
    }, [scheduleId]);
    useEffect(() => {
        loaded.current = 0;
        setOlder({ runs: [], more: false });
        if (seeded.current) {
            seeded.current = false;
        } else {
            void load();
        }
        const timer = setInterval(() => void load(), 10_000);
        return () => clearInterval(timer);
    }, [load]);
    useLiveTopic('schedules', load);
    const act = async (action: Action) => {
        setBusy(true);
        try {
            await api(`/schedules/${encodeURIComponent(scheduleId)}/actions`, 'POST', { action });
            await load();
        } catch (e) {
            failed(e, 'Could not change the schedule.');
        } finally {
            setBusy(false);
        }
    };
    const runs = detail ? [...detail.runs, ...older.runs] : [];
    const moreRuns = older.runs.length ? older.more : !!detail?.moreRuns;
    const loadMore = () => {
        const last = runs.at(-1);
        if (!last) {
            return;
        }
        void api<ScheduleRunsPage>(
            `/schedules/${encodeURIComponent(scheduleId)}/runs?before=${encodeURIComponent(last.id)}`,
        )
            .then((page) =>
                setOlder((shown) => {
                    const runs = [...shown.runs, ...page.runs];
                    loaded.current = runs.length;
                    return { runs, more: page.more };
                }),
            )
            .catch((e) => failed(e, 'Could not load older runs.'));
    };
    if (missing) {
        return (
            <WorkspacePage
                slot="schedule-page"
                module={MODULE_IDS.schedules}
                title="Schedule not found"
                description={
                    <>
                        It may have been deleted, or it isn’t yours.{' '}
                        <Link className={LINK} to="/schedules">
                            All schedules
                        </Link>
                    </>
                }
            />
        );
    }
    if (!detail) {
        return (
            <main className="w-full px-4 pt-(--page-top) md:px-6" data-slot="schedule-page">
                <Skeleton className="h-32" />
            </main>
        );
    }
    const { schedule, goal } = detail;
    const state = standing(schedule);
    return (
        <WorkspacePage
            slot="schedule-page"
            module={MODULE_IDS.schedules}
            title={schedule.title}
            description={
                <>
                    {schedule.dotName ?? 'A deleted socio'} ·{' '}
                    {schedule.kind === 'job' ? `runs the job ${schedule.jobName ?? '(deleted)'}` : 'a socio turn'}
                    {schedule.origin === 'user' ? ' · made by you' : ''} ·{' '}
                    <Link className={LINK} to="/schedules">
                        All schedules
                    </Link>
                </>
            }
        >
            <div className="grid max-w-4xl gap-4">
                <Card data-slot="schedule-purpose-card">
                    <CardHeader>
                        <CardTitle>Purpose</CardTitle>
                        <CardDescription>
                            {goal
                                ? 'The goal it works toward.'
                                : schedule.kind === 'job'
                                  ? 'What runs, without the model.'
                                  : 'What each run asks the socio to do.'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {schedule.kind === 'job' ? (
                            <p className="text-sm">
                                Runs the job {schedule.jobName ?? '(deleted)'} in the socio’s computer.{' '}
                                <Link className={LINK} to="/schedules?tab=jobs">
                                    Its code and logs
                                </Link>
                            </p>
                        ) : goal ? (
                            <div className="grid gap-1 text-sm">
                                <p className="font-medium">{goal.title}</p>
                                {goal.detail && <Purpose text={goal.detail} />}
                            </div>
                        ) : (
                            <Purpose text={schedule.prompt} />
                        )}
                    </CardContent>
                </Card>

                {goal && (
                    <Card data-slot="schedule-goal">
                        <CardHeader>
                            <CardTitle>Goal progress</CardTitle>
                            <CardDescription>
                                The socio notes its progress after each run, and marks the goal done when it is met.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-2 text-sm">
                            <div className="font-medium">
                                {goal.threadId ? (
                                    <Link className={LINK} to={`/chats/${goal.threadId}`}>
                                        {goal.title}
                                    </Link>
                                ) : (
                                    goal.title
                                )}{' '}
                                <Badge variant="outline" data-slot="goal-status">
                                    {goal.status}
                                </Badge>
                            </div>
                            <p data-slot="goal-progress">
                                {goal.progress ? (
                                    <>
                                        <span className="text-muted-foreground">Latest note: </span>
                                        {goal.progress}{' '}
                                        <span className="text-xs text-muted-foreground">
                                            (<When value={goal.updatedAt} />)
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-muted-foreground">No progress noted yet.</span>
                                )}
                            </p>
                        </CardContent>
                    </Card>
                )}

                {goal && (
                    <Card data-slot="schedule-goal-comments">
                        <CardHeader>
                            <CardTitle>Comments</CardTitle>
                            <CardDescription>
                                Add context or a changed requirement; the socio reads them in each run, and can add its
                                own.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <GoalComments
                                goal={goal}
                                dotName={schedule.dotName ?? 'The socio'}
                                onPosted={() => void load()}
                            />
                        </CardContent>
                    </Card>
                )}

                <Card data-slot="schedule-facts">
                    <CardHeader>
                        <CardTitle>What it does</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                        <dl className="grid gap-3 text-sm">
                            <Fact label="Socio">{schedule.dotName ?? 'A deleted socio'}</Fact>
                            <Fact label="Runs">
                                {detail.cadenceText ??
                                    (schedule.intervalSeconds
                                        ? `${every(schedule.intervalSeconds).replace(/^e/, 'E')}, after each successful run`
                                        : 'Once')}
                            </Fact>
                            <Fact label="Next runs">
                                {detail.upcoming.length ? (
                                    <ul className="grid gap-0.5" data-slot="schedule-upcoming">
                                        {detail.upcoming.map((at) => (
                                            <li key={at}>
                                                <When value={at} />
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <span className="text-muted-foreground">
                                        None {schedule.status === 'paused' ? 'while paused' : ''}
                                    </span>
                                )}
                            </Fact>
                            {schedule.cadence && (
                                <Fact label="Time zone">
                                    {schedule.timezone ?? 'UTC'}{' '}
                                    <span className="text-muted-foreground">
                                        (its times; the next runs show in yours)
                                    </span>
                                </Fact>
                            )}
                            <Fact label="Posts in">
                                {schedule.threadId ? (
                                    <Link className={LINK} to={`/chats/${schedule.threadId}`}>
                                        Its chat
                                    </Link>
                                ) : (
                                    <span className="text-muted-foreground">No chat</span>
                                )}
                            </Fact>
                            <Fact label="Approvals">
                                <div data-slot="schedule-approvals">
                                    {detail.approvals.length ? (
                                        <>
                                            Its runs act without asking for{' '}
                                            {detail.approvals
                                                .map(
                                                    (item) =>
                                                        `${item.label} (${item.policy === 'auto' ? 'auto review' : 'bypass'})`,
                                                )
                                                .join(', ')}
                                            ; anything else waits for you.
                                        </>
                                    ) : (
                                        'Anything that needs your approval waits for you.'
                                    )}{' '}
                                    {schedule.dotId && (
                                        <Link className={LINK} to={`/approvals?dot=${schedule.dotId}`}>
                                            Policies
                                        </Link>
                                    )}
                                </div>
                            </Fact>
                            <Fact label="Status">
                                <span data-slot="schedule-standing">
                                    <Badge variant="outline">{state.label}</Badge>{' '}
                                    <span className="text-muted-foreground">{state.note}</span>
                                </span>
                            </Fact>
                        </dl>
                        {schedule.status !== 'cancelled' && repeats(schedule) && (
                            <div className="flex flex-wrap gap-1">
                                {schedule.status !== 'running' && (
                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('run')}>
                                        Run now
                                    </Button>
                                )}
                                {schedule.status === 'paused' ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void act('resume')}
                                    >
                                        Resume
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void act('pause')}
                                    >
                                        Pause
                                    </Button>
                                )}
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(true)}>
                                    Cancel
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {cancelling && (
                    <CancelScheduleDialog
                        schedule={schedule}
                        onClose={() => setCancelling(false)}
                        onConfirm={async () => {
                            setCancelling(false);
                            await act('cancel');
                        }}
                    />
                )}

                <Card>
                    <CardHeader>
                        <CardTitle>What it has done</CardTitle>
                        <CardDescription>Its runs, newest first.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                        {!runs.length ? (
                            <p className="text-sm text-muted-foreground">No runs yet.</p>
                        ) : (
                            <ul className="grid text-sm" data-slot="schedule-runs">
                                {runs.map((run) => (
                                    <li
                                        key={run.id}
                                        data-run={run.id}
                                        className="grid gap-1 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
                                    >
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <RunBadge status={run.status} />
                                            <span className="whitespace-nowrap">
                                                <When value={run.startedAt} />
                                            </span>
                                            {run.finishedAt && (
                                                <span className="text-muted-foreground">
                                                    · took {took(run.finishedAt - run.startedAt)}
                                                </span>
                                            )}
                                        </span>
                                        {(run.summary || run.error) && (
                                            <span
                                                className={
                                                    run.summary
                                                        ? '[overflow-wrap:anywhere]'
                                                        : 'text-muted-foreground [overflow-wrap:anywhere]'
                                                }
                                            >
                                                {run.summary ?? run.error}
                                            </span>
                                        )}
                                        {(run.turnPath || !!run.board.length) && (
                                            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                                                {run.turnPath && (
                                                    <Link className={LINK} to={run.turnPath}>
                                                        Open in chat
                                                    </Link>
                                                )}
                                                {run.board.map((item) => (
                                                    <Link
                                                        key={`${item.issue}:${item.action}`}
                                                        className={LINK}
                                                        to={`/issues/${item.issue}`}
                                                        title={item.title}
                                                    >
                                                        {BOARD_VERB[item.action]} {item.issue}
                                                    </Link>
                                                ))}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {moreRuns && (
                            <Button variant="outline" size="sm" className="justify-self-center" onClick={loadMore}>
                                Load more
                            </Button>
                        )}
                    </CardContent>
                </Card>
            </div>
        </WorkspacePage>
    );
}
