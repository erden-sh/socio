import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import { MODULE_IDS } from '@socio/shared/modules';
import type { ScheduleDetail, ScheduleRunsPage, ScheduleView } from '@socio/shared/schedule-types';
import type { Action } from '@socio/shared/types';

import { api, ApiError } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useLoaderSeed } from '../../lib/page-loader';
import { useRouteParams } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { formatDuration } from '../runs/format';

import { CancelScheduleDialog } from './CancelScheduleDialog';
import { GoalComments } from './GoalComments';
import { Purpose } from './Purpose';
import { RunBadge, useScheduleWords, When } from './schedule-words';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const repeats = (schedule: ScheduleView) => !!schedule.cadence || !!schedule.intervalSeconds;
/** A link within text: underlined, as in Markdown (IssueMarkdown). */
const LINK = 'underline underline-offset-2 hover:text-primary';

/**
 * Where a schedule stands: its status word (`schedules:status`: active,
 * paused, canceled, stopped, completed) and the note beside it
 * (`schedules.detail:standing`), or the schedule's own error.
 */
function standing(schedule: ScheduleView): {
    status: 'scheduled' | 'paused' | 'cancelled' | 'failed' | 'completed';
    note: 'active' | 'paused' | 'cancelled' | 'failed' | 'completed' | 'running';
    error?: string;
} {
    switch (schedule.status) {
        case 'paused':
            return { status: 'paused', note: 'paused', error: schedule.error ?? undefined };
        case 'cancelled':
            return { status: 'cancelled', note: 'cancelled' };
        case 'failed':
            return { status: 'failed', note: 'failed', error: schedule.error ?? undefined };
        case 'completed':
            if (!repeats(schedule)) {
                return { status: 'completed', note: 'completed' };
            }
            break;
        case 'running':
            return { status: 'scheduled', note: 'running' };
    }
    return { status: 'scheduled', note: 'active' };
}

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
    const { t } = useTranslation(['schedules.detail', 'schedules']);
    const words = useScheduleWords();
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
                failed(e, t('schedules.detail:load-failed'));
            }
        }
    }, [scheduleId, t]);
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
            failed(e, t('schedules:actions.change-failed'));
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
            .catch((e) => failed(e, t('schedules:actions.older-failed')));
    };
    if (missing) {
        return (
            <WorkspacePage
                slot="schedule-page"
                module={MODULE_IDS.schedules}
                title={t('schedules.detail:missing.title')}
                description={
                    <Trans
                        t={t}
                        i18nKey="schedules.detail:missing.description"
                        components={{ all: <Link className={LINK} to="/schedules" /> }}
                    />
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
    const socio = schedule.dotName ?? t('schedules:deleted-socio');
    const mine = schedule.origin === 'user' ? 'mine' : undefined;
    const all = { all: <Link className={LINK} to="/schedules" /> };
    return (
        <WorkspacePage
            slot="schedule-page"
            module={MODULE_IDS.schedules}
            title={schedule.title}
            description={
                schedule.kind !== 'job' ? (
                    <Trans
                        t={t}
                        i18nKey="schedules.detail:meta-turn"
                        values={{ socio }}
                        context={mine}
                        components={all}
                    />
                ) : schedule.jobName ? (
                    <Trans
                        t={t}
                        i18nKey="schedules.detail:meta"
                        values={{ socio, job: schedule.jobName }}
                        context={mine}
                        components={all}
                    />
                ) : (
                    <Trans
                        t={t}
                        i18nKey="schedules.detail:meta-deleted-job"
                        values={{ socio }}
                        context={mine}
                        components={all}
                    />
                )
            }
        >
            <div className="grid max-w-4xl gap-4">
                <Card data-slot="schedule-purpose-card">
                    <CardHeader>
                        <CardTitle>{t('schedules.detail:purpose.title')}</CardTitle>
                        <CardDescription>
                            {goal
                                ? t('schedules.detail:purpose.goal')
                                : schedule.kind === 'job'
                                  ? t('schedules.detail:purpose.job')
                                  : t('schedules.detail:purpose.turn')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {schedule.kind === 'job' ? (
                            <p className="text-sm">
                                {schedule.jobName ? (
                                    <Trans
                                        t={t}
                                        i18nKey="schedules.detail:purpose.runs-job"
                                        values={{ job: schedule.jobName }}
                                        components={{ code: <Link className={LINK} to="/schedules?tab=jobs" /> }}
                                    />
                                ) : (
                                    <Trans
                                        t={t}
                                        i18nKey="schedules.detail:purpose.runs-deleted-job"
                                        components={{ code: <Link className={LINK} to="/schedules?tab=jobs" /> }}
                                    />
                                )}
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
                            <CardTitle>{t('schedules.detail:progress.title')}</CardTitle>
                            <CardDescription>{t('schedules.detail:progress.description')}</CardDescription>
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
                                    {words.goalStatus(goal.status)}
                                </Badge>
                            </div>
                            <p data-slot="goal-progress">
                                {goal.progress ? (
                                    <>
                                        <span className="text-muted-foreground">
                                            {t('schedules.detail:progress.latest')}{' '}
                                        </span>
                                        {goal.progress}{' '}
                                        <span className="text-xs text-muted-foreground">
                                            (<When value={goal.updatedAt} />)
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-muted-foreground">{t('schedules.detail:progress.none')}</span>
                                )}
                            </p>
                        </CardContent>
                    </Card>
                )}

                {goal && (
                    <Card data-slot="schedule-goal-comments">
                        <CardHeader>
                            <CardTitle>{t('schedules.detail:comments.title')}</CardTitle>
                            <CardDescription>{t('schedules.detail:comments.description')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <GoalComments
                                goal={goal}
                                dotName={schedule.dotName ?? t('schedules.detail:comments.the-socio')}
                                onPosted={() => void load()}
                            />
                        </CardContent>
                    </Card>
                )}

                <Card data-slot="schedule-facts">
                    <CardHeader>
                        <CardTitle>{t('schedules.detail:facts.title')}</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                        <dl className="grid gap-3 text-sm">
                            <Fact label={t('schedules.detail:facts.socio')}>{socio}</Fact>
                            <Fact label={t('schedules.detail:facts.runs')}>
                                {detail.cadenceText ??
                                    (schedule.intervalSeconds
                                        ? words.interval(schedule.intervalSeconds)
                                        : t('schedules.detail:facts.once'))}
                            </Fact>
                            <Fact label={t('schedules.detail:facts.next')}>
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
                                        {t('schedules.detail:facts.none', {
                                            context: schedule.status === 'paused' ? 'paused' : undefined,
                                        })}
                                    </span>
                                )}
                            </Fact>
                            {schedule.cadence && (
                                <Fact label={t('schedules.detail:facts.zone')}>
                                    {schedule.timezone ?? 'UTC'}{' '}
                                    <span className="text-muted-foreground">
                                        {t('schedules.detail:facts.zone-note')}
                                    </span>
                                </Fact>
                            )}
                            <Fact label={t('schedules.detail:facts.posts')}>
                                {schedule.threadId ? (
                                    <Link className={LINK} to={`/chats/${schedule.threadId}`}>
                                        {t('schedules.detail:facts.chat')}
                                    </Link>
                                ) : (
                                    <span className="text-muted-foreground">{t('schedules.detail:facts.no-chat')}</span>
                                )}
                            </Fact>
                            <Fact label={t('schedules.detail:facts.approvals')}>
                                <div data-slot="schedule-approvals">
                                    {detail.approvals.length
                                        ? t('schedules.detail:facts.approvals-some', {
                                              items: detail.approvals.map((item) =>
                                                  t('schedules.detail:facts.approval', {
                                                      label: item.label,
                                                      context: item.policy === 'auto' ? 'auto' : undefined,
                                                  }),
                                              ),
                                          })
                                        : t('schedules.detail:facts.approvals-none')}{' '}
                                    {schedule.dotId && (
                                        <Link className={LINK} to={`/approvals?dot=${schedule.dotId}`}>
                                            {t('schedules.detail:facts.policies')}
                                        </Link>
                                    )}
                                </div>
                            </Fact>
                            <Fact label={t('schedules.detail:facts.status')}>
                                <span data-slot="schedule-standing">
                                    <Badge variant="outline">{words.status(state.status)}</Badge>{' '}
                                    <span className="text-muted-foreground">
                                        {state.error ?? t(`schedules.detail:standing.${state.note}`)}
                                    </span>
                                </span>
                            </Fact>
                        </dl>
                        {schedule.status !== 'cancelled' && repeats(schedule) && (
                            <div className="flex flex-wrap gap-1">
                                {schedule.status !== 'running' && (
                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('run')}>
                                        {t('schedules:actions.run')}
                                    </Button>
                                )}
                                {schedule.status === 'paused' ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void act('resume')}
                                    >
                                        {t('schedules:actions.resume')}
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void act('pause')}
                                    >
                                        {t('schedules:actions.pause')}
                                    </Button>
                                )}
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(true)}>
                                    {t('schedules.detail:cancel')}
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
                        <CardTitle>{t('schedules.detail:runs.title')}</CardTitle>
                        <CardDescription>{t('schedules.detail:runs.description')}</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                        {!runs.length ? (
                            <p className="text-sm text-muted-foreground">{t('schedules:no-runs')}</p>
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
                                                    {t('schedules.detail:runs.took', {
                                                        duration: formatDuration(run.finishedAt - run.startedAt),
                                                    })}
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
                                                        {t('schedules.detail:runs.open')}
                                                    </Link>
                                                )}
                                                {run.board.map((item) => (
                                                    <Link
                                                        key={`${item.issue}:${item.action}`}
                                                        className={LINK}
                                                        to={`/issues/${item.issue}`}
                                                        title={item.title}
                                                    >
                                                        {t(`schedules.detail:runs.board.${item.action}`, {
                                                            issue: item.issue,
                                                        })}
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
                                {t('schedules:actions.load-more')}
                            </Button>
                        )}
                    </CardContent>
                </Card>
            </div>
        </WorkspacePage>
    );
}
