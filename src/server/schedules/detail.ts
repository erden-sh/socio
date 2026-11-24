import { issueKey } from '@socio/shared/issues/issue-types';
import { pageExcerpt } from '@socio/shared/pages/page-library';
import { isAdmin } from '@socio/shared/roles';
import {
    SCHEDULE_RUNS_PAGE,
    type ScheduleDetail,
    type ScheduleRunsPage,
    type ScheduleRunView,
    type SchedulesState,
    type ScheduleView,
} from '@socio/shared/schedule-types';
import type { User } from '@socio/shared/types';

import type { ApprovalsShape } from '../approvals/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import { cadenceInWords, nextRun, parseCadence } from './cadence.js';
import {
    type GoalsShape,
    type JobsShape,
    type LongRunsShape,
    type ScheduleBoardShape,
    type ScheduleDetailsShape,
    ScheduleError,
    type SchedulesShape,
    type SchedulesViewsShape,
    type TasksShape,
} from './contract.js';

/**
 * What the schedule views read: this folder's services, and the approvals,
 * the runner's stored turns and the Board as their contracts type them.
 * The layer (`layer.ts`) hands them in from
 * their tags.
 */
export interface ScheduleViewSources {
    readonly schedules: Pick<SchedulesShape, 'find' | 'list' | 'settings' | 'counts'>;
    readonly goals: Pick<GoalsShape, 'byTask' | 'get' | 'list'>;
    readonly jobs: Pick<JobsShape, 'scheduleRuns' | 'list' | 'settings' | 'counts'>;
    readonly longRuns: Pick<LongRunsShape, 'latestFor'>;
    readonly store: Pick<TasksShape, 'scheduleMinGapMs' | 'taskRuns' | 'activeScheduleCount'>;
    readonly approvals: Pick<ApprovalsShape, 'capabilities' | 'policies'>;
    readonly runner: Pick<RunnerShape, 'turnsBetween'>;
    readonly board: ScheduleBoardShape;
}

/** The start of a turn's answer as plain text, marked when cut. */
function summaryOf(text: string) {
    const excerpt = pageExcerpt(text);
    if (!excerpt) {
        return null;
    }
    return excerpt.length < 150 ? excerpt : `${excerpt.trimEnd()}…`;
}

/** How many next runs the details show. */
const UPCOMING = 3;

/** The next runs of a schedule that will run again, soonest first. */
function upcoming(sources: ScheduleViewSources, schedule: ScheduleView): number[] {
    const first = schedule.nextRunAt;
    if (!first || ['paused', 'cancelled', 'failed'].includes(schedule.status)) {
        return [];
    }
    if (!schedule.cadence) {
        return [first];
    }
    const runs = [first];
    try {
        const cadence = parseCadence(schedule.cadence);
        const zone = schedule.timezone || 'UTC';
        while (runs.length < UPCOMING) {
            const next = nextRun(
                cadence,
                zone,
                runs.at(-1)! + sources.store.scheduleMinGapMs() - 1,
                schedule.createdAt,
            );
            if (next === null) {
                break;
            }
            runs.push(next);
        }
    } catch {
        // A cadence that no longer parses: its next run is all there is.
    }
    return runs;
}

/**
 * A page of a schedule's runs, newest first (CB-88): a job schedule's job
 * runs, else its task's runs, each with the start of its answer, the turn
 * in the schedule's chat, and what it did on the board. Undefined for a
 * `before` that isn't one of its runs.
 */
async function runsPage(
    sources: ScheduleViewSources,
    userId: string,
    schedule: ScheduleView,
    goalId: string | undefined,
    before?: string,
    limit = SCHEDULE_RUNS_PAGE,
): Promise<ScheduleRunsPage | undefined> {
    if (schedule.kind === 'job') {
        const page = await sources.jobs.scheduleRuns(userId, schedule.id, limit, before);
        return (
            page && {
                runs: page.runs.map((run) => ({
                    id: run.id,
                    status: run.status,
                    startedAt: run.startedAt ?? run.queuedAt,
                    finishedAt: run.finishedAt,
                    // A batch of a job that runs until done (CB-122): its outcome is
                    // under the job, and goes to the owner when it ends.
                    summary:
                        [
                            run.longRunId ? 'A batch of a run until done.' : '',
                            run.exitCode === null ? '' : `Exited with code ${run.exitCode}.`,
                        ]
                            .filter(Boolean)
                            .join(' ') || null,
                    error: run.error,
                    turnPath: null,
                    board: [],
                })),
                more: page.more,
            }
        );
    }
    const page = await sources.store.taskRuns(schedule.id, limit, before);
    if (!page) {
        return undefined;
    }
    const now = Date.now();
    const from = Math.min(...page.runs.map((run) => run.startedAt));
    const to = Math.max(...page.runs.map((run) => run.finishedAt ?? now));
    const turns = page.runs.length && schedule.threadId ? sources.runner.turnsBetween(schedule.threadId, from, to) : [];
    const actions = page.runs.length
        ? await sources.board.filings.byCause(userId, goalId ? [schedule.id, goalId] : [schedule.id], from, to)
        : [];
    // The live issues they acted on, from the Board's port (CB-110).
    const issues = await sources.board.issues.titlesById(actions.map((action) => action.issueId));
    const within = (at: number, run: { startedAt: number; finishedAt: number | null }) =>
        at >= run.startedAt && at <= (run.finishedAt ?? now);
    return {
        runs: page.runs.map((run): ScheduleRunView => {
            const turn = turns.find((item) => within(item.startedAt, run));
            const board = new Map<string, ScheduleRunView['board'][number]>();
            for (const action of actions) {
                if (!within(action.createdAt, run)) {
                    continue;
                }
                const issue = issues.get(action.issueId);
                if (issue) {
                    board.set(`${action.issueId}:${action.action}`, {
                        issue: issueKey(issue.number),
                        title: issue.title,
                        action: action.action,
                    });
                }
            }
            return {
                id: run.id,
                status: run.status,
                startedAt: run.startedAt,
                finishedAt: run.finishedAt,
                summary: run.result?.text ? summaryOf(run.result.text) : null,
                error: run.error,
                turnPath:
                    turn?.messageId && schedule.threadId
                        ? `/chats/${schedule.threadId}#message-${encodeURIComponent(turn.messageId)}`
                        : null,
                board: [...board.values()],
            };
        }),
        more: page.more,
    };
}

/**
 * `GET /api/schedules/:id`: one of the person's schedules (or tasks), what
 * it is for, what it does and has done, and its goal (CB-88). Only the
 * person's own; anyone else's is not found.
 */
export async function scheduleDetailView(
    sources: ScheduleViewSources,
    userId: string,
    id: string,
): Promise<ScheduleDetail> {
    const schedule = await sources.schedules.find(userId, id);
    if (!schedule) {
        throw new ScheduleError('Schedule not found.', 404);
    }
    const owned = await sources.goals.byTask(id);
    const goal = owned?.userId === userId ? ((await sources.goals.get(userId, owned.id)) ?? null) : null;
    const labels = new Map(sources.approvals.capabilities().map((capability) => [capability.id, capability.label]));
    const { runs, more } = (await runsPage(sources, userId, schedule, goal?.id))!;
    return {
        schedule,
        cadenceText: schedule.cadence ? cadenceInWords(schedule.cadence) : null,
        upcoming: upcoming(sources, schedule),
        approvals: schedule.dotId
            ? (await sources.approvals.policies(userId, schedule.dotId))
                  .filter((item) => item.policy !== 'manual')
                  .map((item) => ({
                      capability: item.capability,
                      label: labels.get(item.capability) ?? item.capability,
                      policy: item.policy,
                  }))
            : [],
        goal,
        runs,
        moreRuns: more,
    };
}

/** `GET /api/schedules/:id/runs?before=`: older runs, for "Load more". */
export async function scheduleRunsView(
    sources: ScheduleViewSources,
    userId: string,
    id: string,
    before: string,
    limit?: number,
): Promise<ScheduleRunsPage> {
    const schedule = await sources.schedules.find(userId, id);
    if (!schedule) {
        throw new ScheduleError('Schedule not found.', 404);
    }
    const goal = await sources.goals.byTask(id);
    const page = await runsPage(
        sources,
        userId,
        schedule,
        goal?.userId === userId ? goal.id : undefined,
        before,
        limit,
    );
    if (!page) {
        throw new ScheduleError('Run not found.', 404);
    }
    return page;
}

// The schedules list views, moved here from live/views/schedules.ts. The
// pages read them through `SchedulesViews`.

/**
 * `GET /api/schedules`: this user's own schedules and jobs, with their
 * limits and usage; admins also get everyone's counts, never titles,
 * prompts, code or logs.
 */
export async function schedulesView(
    sources: Pick<ScheduleViewSources, 'goals' | 'jobs' | 'schedules' | 'store'>,
    user: User,
): Promise<SchedulesState> {
    const { schedules, jobs } = sources;
    const mine = await jobs.list(user.id);
    return {
        schedules: await schedules.list(user.id),
        goals: await sources.goals.list(user.id),
        jobs: mine,
        limits: {
            minIntervalMinutes: Math.round(schedules.settings.minIntervalMs / 60_000),
            maxActiveSchedules: schedules.settings.maxActivePerUser,
            maxJobTimeoutSeconds: jobs.settings.maxTimeoutSeconds,
            jobConcurrency: jobs.settings.concurrency,
            maxJobs: jobs.settings.maxJobsPerUser,
        },
        usage: {
            activeSchedules: await sources.store.activeScheduleCount(user.id),
            jobs: mine.length,
        },
        ...(isAdmin(user)
            ? {
                  counts: {
                      schedules: await schedules.counts(),
                      ...(await jobs.counts()),
                  },
              }
            : {}),
    };
}

/**
 * The schedules view with each job that runs until done showing its open
 * or latest long run (CB-122); its items are counted in the repository,
 * which is async.
 */
export async function withLongRuns(
    sources: Pick<ScheduleViewSources, 'longRuns'>,
    state: SchedulesState,
): Promise<SchedulesState> {
    const ids = state.jobs.filter((job) => job.untilDone).map((job) => job.id);
    if (!ids.length) {
        return state;
    }
    const latest = await sources.longRuns.latestFor(ids);
    return {
        ...state,
        jobs: state.jobs.map((job) => (job.untilDone ? { ...job, longRun: latest.get(job.id) ?? null } : job)),
    };
}

/**
 * `scheduleDetailView` and `scheduleRunsView` behind the `ScheduleDetails`
 * tag, and with the list views behind `SchedulesViews` (contract.ts), over
 * the sources the layer hands in.
 */
export class ScheduleDetailViews implements ScheduleDetailsShape, SchedulesViewsShape {
    constructor(private sources: ScheduleViewSources) {}
    detail(userId: string, id: string) {
        return scheduleDetailView(this.sources, userId, id);
    }
    runs(userId: string, id: string, before: string, limit?: number) {
        return scheduleRunsView(this.sources, userId, id, before, limit);
    }
    schedules(user: User) {
        return schedulesView(this.sources, user);
    }
    withLongRuns(state: SchedulesState) {
        return withLongRuns(this.sources, state);
    }
}
