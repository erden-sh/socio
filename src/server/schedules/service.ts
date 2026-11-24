import { randomUUID } from 'node:crypto';

import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import type { ScheduleView } from '@socio/shared/schedule-types';
import type { Action, Task } from '@socio/shared/types';

import type { ApprovalOutcome, ApprovalsShape } from '../approvals/contract.js';

import { CadenceError, nextRun, parseCadence, shortestGap, validTimeZone } from './cadence.js';
import { ScheduleError, type SchedulesShape, DEFAULT_SCHEDULE_SETTINGS, type ScheduleSettings } from './contract.js';
import { JobError, type JobService } from './jobs.js';
import type { SchedulesStore, SchedulesWorkspace } from './slices.js';

export type ScheduleAction = { kind: 'turn'; prompt: string } | { kind: 'job'; jobId: string };
export interface ScheduleProposal {
    title: string;
    cadence: string;
    timezone?: string;
    action: ScheduleAction;
}
interface SchedulePayload {
    title: string;
    /** Normalized. */
    cadence: string;
    timezone: string;
    action: ScheduleAction;
}

const TITLE = /^[^\p{Cc}]{1,80}$/u;
const at = (t: number, zone: string) =>
    `${new Date(t).toLocaleString('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' })} (${zone})`;

/**
 * Schedules (`LegacySchedules`). A schedule is a task with a
 * cadence (`tasks`), claimed by the same scheduler as the tasks people make
 * in a conversation, and run as its owner: a Dot turn on the owner's
 * inference (purpose `scheduled`) in the schedule's own conversation, or a
 * job run. A Dot proposes one with `schedule_create`; it is created when
 * the owner approves (`schedule.create`) or at once under bypass. Limits:
 * the minimum interval between runs and the active schedules per user,
 * for every Dot, bypass or not.
 */
export class ScheduleService implements SchedulesShape {
    /** The limits in force: an admin's (Settings, CB-108), over the environment's. */
    get settings(): ScheduleSettings {
        return {
            ...DEFAULT_SCHEDULE_SETTINGS,
            ...this.base,
            ...this.overrides(),
        };
    }
    constructor(
        private store: SchedulesStore,
        private workspace: SchedulesWorkspace,
        approvals: ApprovalsShape,
        private jobs: JobService,
        private base: Partial<ScheduleSettings> = {},
        private log: (line: string) => void = () => {},
        private overrides: () => Partial<ScheduleSettings> = () => ({}),
    ) {
        // A cadence never runs sooner than the minimum after its last run.
        store.scheduleMinGapMs = () => this.settings.minIntervalMs;
        this.approvals = approvals;
        approvals.register<SchedulePayload>({
            capability: APPROVAL_CAPABILITIES.scheduleCreate,
            label: 'Create a schedule',
            description:
                'A socio sets up recurring work for you: a socio turn in its own conversation, on your inference, or one of its jobs. You can pause or cancel it any time under Schedules & jobs.',
            execute: async (record) => {
                // One unit of work, queued behind an open one (CB-110).
                const task = await this.workspace.data.uow.run(
                    () => this.create(record.userId, record.dotId, record.payload),
                    { label: 'create schedule' },
                );
                return `Schedule “${task.title}” created; next run ${task.nextRunAt ? at(task.nextRunAt, task.timezone ?? 'UTC') : 'not set'}.`;
            },
            auto: {
                maxRiskForAuto: 'low',
                riskNotes: 'Recurring work runs unattended, as the user, on the user’s inference and plan limits.',
                rules: [
                    {
                        description: 'Schedules that run more often than hourly go to you.',
                        check: ({ payload }) => {
                            try {
                                const gap = shortestGap(parseCadence(payload.cadence), payload.timezone, Date.now());
                                return typeof gap === 'number' && gap < 3_600_000
                                    ? 'It would run more often than hourly.'
                                    : false;
                            } catch {
                                return 'Its cadence could not be checked.';
                            }
                        },
                    },
                ],
            },
        });
    }
    private approvals: ApprovalsShape;

    /** Checks a proposal against the cadence rules and limits; normalizes it. */
    async check(userId: string, dotId: string, input: ScheduleProposal) {
        const title = input.title.trim();
        if (!TITLE.test(title)) {
            throw new ScheduleError('Give the schedule a title (1–80 characters).');
        }
        const timezone = input.timezone?.trim() || 'UTC';
        if (!validTimeZone(timezone)) {
            throw new ScheduleError(
                `Unknown time zone "${timezone.slice(0, 60)}". Use an IANA name such as Europe/Paris, or omit it for UTC.`,
            );
        }
        let cadence;
        try {
            cadence = parseCadence(input.cadence);
        } catch (error) {
            if (error instanceof CadenceError) {
                throw new ScheduleError(error.message);
            }
            throw error;
        }
        const now = Date.now();
        const first = nextRun(cadence, timezone, now, now);
        if (first === null) {
            throw new ScheduleError('That cadence never runs. Check the dates.');
        }
        const gap = shortestGap(cadence, timezone, now);
        if (gap < this.settings.minIntervalMs) {
            throw new ScheduleError(
                `Schedules run at most every ${Math.round(this.settings.minIntervalMs / 60_000)} minutes. Choose a slower cadence.`,
            );
        }
        if (input.action.kind === 'turn') {
            const prompt = input.action.prompt.trim();
            if (prompt.length < 3 || prompt.length > 4000) {
                throw new ScheduleError('The prompt is 3 to 4,000 characters, and must make sense on its own.');
            }
        } else {
            try {
                await this.jobs.owned(userId, input.action.jobId, dotId);
            } catch (error) {
                if (error instanceof JobError) {
                    throw new ScheduleError(
                        'No such job for this socio. job_list shows yours; save one with job_save first.',
                        404,
                    );
                }
                throw error;
            }
        }
        if ((await this.store.activeScheduleCount(userId)) >= this.settings.maxActivePerUser) {
            throw new ScheduleError(
                `The user has ${this.settings.maxActivePerUser} active schedules, the most allowed. Cancel one first.`,
                429,
            );
        }
        const action: ScheduleAction =
            input.action.kind === 'turn'
                ? { kind: 'turn', prompt: input.action.prompt.trim() }
                : { kind: 'job', jobId: input.action.jobId };
        return {
            payload: { title, cadence: cadence.text, timezone, action },
            first,
        };
    }
    /** `schedule_create`: asks the owner (unless bypass), then creates it. */
    async propose(userId: string, dotId: string, input: ScheduleProposal, threadId?: string): Promise<ApprovalOutcome> {
        const { payload, first } = await this.check(userId, dotId, input);
        const job =
            payload.action.kind === 'job' ? await this.jobs.job(userId, payload.action.jobId, dotId) : undefined;
        return this.approvals.request({
            userId,
            dotId,
            capability: APPROVAL_CAPABILITIES.scheduleCreate,
            summary: `Schedule “${payload.title}”, ${payload.cadence}`,
            details: [
                `Cadence: ${payload.cadence} (${payload.timezone}); first run ${at(first, payload.timezone)}.`,
                payload.action.kind === 'turn'
                    ? `Runs a turn of this socio as you, on your inference, in its own conversation:\n${payload.action.prompt}`
                    : `Runs the job “${job?.name}” (version ${job?.version}, at most ${job?.timeoutSeconds} s) in this socio’s computer.`,
                'Pause or cancel it any time under Schedules & jobs.',
            ],
            payload,
            threadId,
        });
    }
    /**
     * Creates an approved schedule (approval handler): checks it again first.
     * Its writes join the caller's unit of work, which makes them one.
     */
    async create(userId: string, dotId: string, raw: SchedulePayload): Promise<Task> {
        if (!this.workspace.dot(dotId)) {
            throw new ScheduleError('The socio no longer exists.', 404);
        }
        if (this.workspace.dot(dotId)?.archivedAt) {
            throw new ScheduleError('This socio is archived.', 409);
        }
        const { payload } = await this.check(userId, dotId, raw);
        // Its turns run in a conversation of their own, the owner's.
        const thread =
            payload.action.kind === 'turn'
                ? this.workspace.bindThread(randomUUID(), dotId, `Scheduled: ${payload.title}`.slice(0, 120), userId)
                : undefined;
        const task = await this.store.createSchedule({
            userId,
            dotId,
            title: payload.title,
            prompt: payload.action.kind === 'turn' ? payload.action.prompt : `Run job ${payload.action.jobId}`,
            cadence: payload.cadence,
            timezone: payload.timezone,
            kind: payload.action.kind,
            jobId: payload.action.kind === 'job' ? payload.action.jobId : null,
            origin: 'dot',
        });
        if (thread) {
            await this.workspace.bindTask(task.id, thread.id);
        }
        this.log(`Schedules: created schedule=${task.id} kind=${payload.action.kind} dot=${dotId}`);
        return task;
    }
    private async view(task: Task): Promise<ScheduleView> {
        const threadId = (await this.workspace.taskThread(task.id)) ?? null;
        const dotId = task.dotId ?? (threadId ? this.workspace.thread(threadId)?.dotId : null);
        const job =
            task.kind === 'job' && task.jobId && task.userId
                ? await this.jobs.job(task.userId, task.jobId).catch(() => undefined)
                : undefined;
        let lastRun: ScheduleView['lastRun'] = null;
        if (task.kind === 'job') {
            const run = await this.jobs.lastScheduledRun(task.id);
            if (run) {
                lastRun = {
                    status: run.status,
                    startedAt: run.startedAt ?? run.queuedAt,
                    finishedAt: run.finishedAt,
                    error: run.error,
                };
            }
        } else {
            const run = (await this.store.recentRuns(task.id, 1))[0];
            if (run) {
                lastRun = run;
            }
        }
        return {
            id: task.id,
            title: task.title ?? task.prompt.slice(0, 80),
            prompt: task.prompt,
            kind: task.kind ?? 'turn',
            cadence: task.cadence ?? null,
            timezone: task.timezone ?? null,
            intervalSeconds: task.intervalSeconds,
            status: task.status,
            origin: task.origin === 'dot' ? 'dot' : 'user',
            dotId: dotId ?? null,
            dotName: dotId ? (this.workspace.dot(dotId)?.name ?? null) : null,
            jobId: task.jobId ?? null,
            jobName: job?.name ?? null,
            threadId,
            nextRunAt: task.nextRunAt,
            lastRun,
            error: task.error,
            createdAt: task.createdAt,
        };
    }
    /** The user's schedules and repeating tasks; with `dotId`, that Dot's. */
    async list(userId: string, dotId?: string): Promise<ScheduleView[]> {
        const views: ScheduleView[] = [];
        for (const task of await this.store.schedules(userId)) {
            const view = await this.view(task);
            if (!dotId || view.dotId === dotId) {
                views.push(view);
            }
        }
        return views;
    }
    /**
     * Any of the user's tasks, as a schedule (its details page): also one
     * that ran once, or a goal's whose repeats ended when it was met.
     */
    async find(userId: string, id: string): Promise<ScheduleView | undefined> {
        const task = await this.store.ownedTask(id, userId);
        return task && this.view(task);
    }
    async get(userId: string, id: string, dotId?: string): Promise<ScheduleView> {
        const task = await this.store.ownedTask(id, userId);
        const view = task && (await this.view(task));
        if (!view || (!task.cadence && !task.intervalSeconds) || (dotId && view.dotId !== dotId)) {
            throw new ScheduleError('Schedule not found.', 404);
        }
        return view;
    }
    /** Pause, resume, cancel or run now: the user's, or (with `dotId`) that Dot's. */
    async act(userId: string, id: string, action: Action, dotId?: string): Promise<ScheduleView> {
        const before = await this.get(userId, id, dotId);
        if (before.status === 'cancelled' && action !== 'cancel') {
            throw new ScheduleError('This schedule was canceled.', 409);
        }
        // An archived Dot's schedules wait, paused, until it is unarchived.
        if ((action === 'resume' || action === 'run') && before.dotId && this.workspace.dot(before.dotId)?.archivedAt) {
            throw new ScheduleError('This schedule’s socio is archived.', 409);
        }
        await this.store.action(id, action);
        return this.get(userId, id);
    }
    /**
     * A deleted job's schedules stop (CB-64): they are canceled, and stay
     * listed with the job shown as deleted.
     */
    async cancelJobSchedules(userId: string, jobId: string) {
        for (const task of await this.store.jobSchedules(jobId)) {
            if (task.userId === userId && task.status !== 'cancelled') {
                await this.store.action(task.id, 'cancel');
            }
        }
    }
    /** Everyone's schedules by status (operators: counts only). */
    counts() {
        return this.store.scheduleCounts();
    }
}
