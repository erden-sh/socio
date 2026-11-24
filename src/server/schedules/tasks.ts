import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import type { Action, Detail, Result, Settings, Task } from '@socio/shared/types';

import { nextRun, parseCadence } from './cadence.js';
import {
    SCHEDULE_PAUSE_AFTER_FAILURES,
    type Claim,
    type ScheduleInput,
    type TaskClaimsShape,
    type TasksShape,
} from './contract.js';
import type { NewTask, TaskRepositories } from './domain/repositories.js';

/**
 * Scheduled tasks and their runs (CB-110: the Scheduling context's, out of
 * the core store): a person's research tasks and schedules, claimed one at
 * a time by the runner under a lease. Each change is one unit of work over
 * the repositories, which joins a caller's or queues behind another
 * chain's; the core store keeps its names for them.
 */
export class TaskService implements TasksShape, TaskClaimsShape {
    /**
     * A schedule never runs sooner than this after its previous run started
     * (the minimum interval, kept even where DST shortens a cron's gap).
     */
    scheduleMinGapMs: () => number = () => 60_000;
    /** How long a claimed task is held before another claim may take it over. */
    leaseMs = 180_000;

    constructor(
        private uow: UnitOfWork,
        private repos: TaskRepositories,
        /** The workspace's switches: a claim waits while paused or off. */
        private settings: () => Settings,
    ) {}

    private get tasks() {
        return this.repos.tasks;
    }

    /** The user's tasks, newest first. */
    list(userId: string) {
        return this.tasks.list(userId);
    }
    /** Every live task, for the worker and its lifecycle checks. */
    all() {
        return this.tasks.all();
    }
    /** Request boundary check: the task exists and is the user's. */
    async owned(id: string, userId: string) {
        const task = await this.get(id);
        return task?.userId === userId ? task : undefined;
    }
    /** A live task; a deleted one is missing. */
    get(id: string) {
        return this.tasks.get(id);
    }
    /** A task, deleted or not, with its stamp (admin, tests). */
    withDeleted(id: string) {
        return this.tasks.withDeleted(id);
    }
    create(prompt: string, intervalSeconds: number | null, userId: string): Promise<Task> {
        return this.uow.run(
            async () => {
                const now = Date.now();
                const id = randomUUID();
                await this.tasks.insert({
                    id,
                    prompt,
                    status: 'queued',
                    intervalSeconds,
                    createdAt: now,
                    userId,
                });
                await this.event(id, null, 'Task added to the research queue.');
                return (await this.get(id))!;
            },
            { label: 'add task' },
        );
    }
    async detail(id: string): Promise<Detail | undefined> {
        const task = await this.get(id);
        if (!task) {
            return undefined;
        }
        return {
            task,
            runs: await this.repos.runs.list(id),
            events: await this.repos.events.list(id),
        };
    }
    /** A line in the task's history. */
    event(taskId: string, runId: string | null, text: string) {
        return this.repos.events.add(taskId, runId, text, Date.now());
    }
    /** Inside a unit of work: the task stops, with `reason`, as `status`. */
    private async invalidate(task: Task, status: Task['status'], reason: string) {
        const now = Date.now();
        if (task.lease) {
            await this.repos.runs.end(task.lease, { status: 'interrupted', finishedAt: now, error: reason }, true);
        }
        await this.tasks.update(task.id, {
            status,
            lease: null,
            leaseUntil: null,
            updatedAt: now,
            error: status === 'interrupted' ? reason : null,
        });
        await this.event(task.id, task.lease, reason);
        // An interrupted schedule keeps its cadence: it runs again next time.
        if (status === 'interrupted' && task.cadence) {
            await this.reschedule((await this.get(task.id))!, now);
        }
    }
    /**
     * Inside the caller's unit of work: every running task is interrupted
     * with `reason` (the workspace's settings stopped them).
     */
    async interruptRunning(reason: string) {
        for (const task of await this.all()) {
            if (task.status === 'running') {
                await this.invalidate(task, 'interrupted', reason);
            }
        }
    }
    /**
     * The next run of a cadence task, from now and at least the minimum
     * interval after its last run; `scheduled` until then. Null (and the
     * task fails) when the cadence no longer parses or never runs again.
     */
    nextRunOf(task: Task, now = Date.now()): number | null {
        if (!task.cadence) {
            return null;
        }
        try {
            const after = Math.max(now, (task.lastRunAt ?? 0) + this.scheduleMinGapMs() - 1);
            return nextRun(parseCadence(task.cadence), task.timezone || 'UTC', after, task.createdAt);
        } catch {
            return null;
        }
    }
    private async reschedule(task: Task, now: number) {
        const next = this.nextRunOf(task, now);
        await this.tasks.update(
            task.id,
            next === null
                ? {
                      status: 'failed',
                      nextRunAt: null,
                      error: 'This schedule’s cadence never runs again.',
                      updatedAt: now,
                  }
                : { status: 'scheduled', nextRunAt: next, updatedAt: now },
        );
    }
    action(id: string, action: Action): Promise<Task | undefined> {
        return this.uow.run(
            async () => {
                const task = await this.get(id);
                if (!task) {
                    return undefined;
                }
                if (action === 'run' && task.status === 'running') {
                    return task;
                }
                if (action === 'resume') {
                    return this.resume(task);
                }
                const status = action === 'run' ? 'queued' : action === 'pause' ? 'paused' : 'cancelled';
                await this.invalidate(
                    task,
                    status,
                    action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
                );
                await this.tasks.update(id, { error: null, nextRunAt: null });
                return this.get(id);
            },
            { label: `task ${action}` },
        );
    }
    /** Would run again: queued, running, or waiting for its next time. */
    private static pausable(task: Task) {
        return (
            ['queued', 'running'].includes(task.status) ||
            (!!task.nextRunAt && !['paused', 'cancelled'].includes(task.status))
        );
    }
    /** Inside a unit of work: pauses the task with `reason` as its error. */
    private async pause(task: Task, reason: string) {
        await this.invalidate(task, 'paused', reason);
        await this.tasks.update(task.id, { error: reason, nextRunAt: null });
    }
    /**
     * Pauses the given tasks that would run again (a Dot archived), with the
     * reason as their error; returns how many. Others are left as they are.
     */
    pauseTasks(ids: readonly string[], reason: string): Promise<number> {
        return this.uow.run(
            async () => {
                let paused = 0;
                for (const id of new Set(ids)) {
                    const owner = (await this.withDeleted(id))?.userId;
                    const task = owner ? await this.owned(id, owner) : undefined;
                    if (!task || !TaskService.pausable(task)) {
                        continue;
                    }
                    await this.pause(task, reason);
                    paused++;
                }
                return paused;
            },
            { label: 'pause tasks' },
        );
    }
    /** The ids of tasks proposed by a Dot (schedules and goals). */
    dotScheduleIds(dotId: string) {
        return this.tasks.idsOfDot(dotId);
    }
    /** Live Dot-made turn schedules whose prompt names a goal. */
    goalScheduleCandidates() {
        return this.tasks.goalCandidates();
    }
    /**
     * Ends a running task's repeats after this run (its goal was met in the
     * run): no cadence or interval, so finishing it schedules nothing more.
     */
    async endAfterRun(id: string) {
        await this.tasks.update(id, { cadence: null, intervalSeconds: null, updatedAt: Date.now() }, 'running');
    }
    /**
     * Pauses every task of this user that would run again (queued, running,
     * or waiting for its next time), with `reason` as its error, so the
     * Schedules page says why. They are kept; resuming one clears it. Used
     * when the user is deactivated (accounts.ts). Returns how many.
     */
    async pausableCountOf(userId: string): Promise<number> {
        return (await this.list(userId)).filter((task) => TaskService.pausable(task)).length;
    }
    pauseOwnedBy(userId: string, reason: string): Promise<number> {
        return this.uow.run(
            async () => {
                let paused = 0;
                for (const task of await this.list(userId)) {
                    if (!TaskService.pausable(task)) {
                        continue;
                    }
                    await this.pause(task, reason);
                    paused++;
                }
                return paused;
            },
            { label: 'pause owned tasks' },
        );
    }
    /**
     * Resumes a paused task: a schedule waits for its next time, a repeating
     * task for its interval; anything else is queued, as `run` does.
     */
    private async resume(task: Task): Promise<Task> {
        if (task.status !== 'paused') {
            return task;
        }
        const now = Date.now();
        if (task.cadence) {
            await this.tasks.update(task.id, { error: null, updatedAt: now });
            await this.reschedule(task, now);
        } else {
            await this.tasks.update(task.id, {
                status: task.intervalSeconds ? 'completed' : 'queued',
                nextRunAt: task.intervalSeconds ? now + task.intervalSeconds * 1000 : null,
                error: null,
                updatedAt: now,
            });
        }
        await this.event(task.id, null, 'Task resumed.');
        return (await this.get(task.id))!;
    }
    /** Creates a schedule; it waits for its first time, `scheduled`. */
    createSchedule(input: ScheduleInput): Promise<Task> {
        return this.uow.run(
            async () => {
                const now = Date.now();
                const id = randomUUID();
                const task: NewTask = {
                    id,
                    prompt: input.prompt,
                    status: 'scheduled',
                    intervalSeconds: null,
                    createdAt: now,
                    userId: input.userId,
                    title: input.title,
                    cadence: input.cadence,
                    timezone: input.timezone,
                    dotId: input.dotId,
                    kind: input.kind,
                    jobId: input.jobId ?? null,
                    origin: input.origin ?? null,
                };
                await this.tasks.insert(task);
                await this.reschedule((await this.get(id))!, now);
                await this.event(id, null, `Schedule created: ${input.cadence} (${input.timezone}).`);
                return (await this.get(id))!;
            },
            { label: 'create schedule' },
        );
    }
    /** The user's schedules and repeating tasks, newest first. */
    schedules(userId: string) {
        return this.tasks.schedules(userId);
    }
    /** Schedules not canceled (the per-user cap counts them). */
    activeScheduleCount(userId: string) {
        return this.tasks.activeScheduleCount(userId);
    }
    /** Schedules by status, for everyone (the operators' counts). */
    scheduleCounts() {
        return this.tasks.scheduleCounts();
    }
    /** A task's latest runs, newest first (no results). */
    recentRuns(taskId: string, limit = 5) {
        return this.repos.runs.recent(taskId, limit);
    }
    /**
     * A page of a task's runs with their results, newest first: older than
     * the run `before` (one of the task's) when given. `more` says whether
     * older ones are there. Undefined for a `before` that isn't the task's.
     */
    taskRuns(taskId: string, limit: number, before?: string) {
        return this.repos.runs.page(taskId, limit, before);
    }
    /**
     * Deletes one of the user's tasks, unless running (CB-64: hides it, so
     * the worker never claims it again). Its runs and events are kept and
     * read only through it. `withParent` is what it went with
     * (`conversation:<id>`, `job:<id>`).
     */
    deleteTask(id: string, userId: string, withParent: string | null = null, now = Date.now()): Promise<boolean> {
        return this.uow.run(
            async () => {
                const task = await this.owned(id, userId);
                if (!task || task.status === 'running') {
                    return false;
                }
                await this.tasks.remove(id, userId, withParent, now);
                return true;
            },
            { label: 'delete task' },
        );
    }
    /** The live schedules that run a job (stopped when it is deleted). */
    jobSchedules(jobId: string) {
        return this.tasks.forJob(jobId);
    }
    schedule(id: string, intervalSeconds: number | null) {
        return this.uow.run(
            async () => {
                const task = await this.get(id);
                if (!task) {
                    return undefined;
                }
                // A cadence schedule keeps its cadence; it has no repeat interval.
                if (task.cadence) {
                    return task;
                }
                const next =
                    intervalSeconds && task.status === 'completed' ? Date.now() + intervalSeconds * 1000 : null;
                await this.tasks.update(id, {
                    intervalSeconds,
                    nextRunAt: next,
                    updatedAt: Date.now(),
                });
                await this.event(
                    id,
                    null,
                    intervalSeconds
                        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
                        : 'Repeat schedule removed.',
                );
                return this.get(id);
            },
            { label: 'repeat task' },
        );
    }
    claim(now = Date.now(), admitted: () => boolean = () => true): Promise<Claim | null> {
        return this.uow.run(
            async () => {
                // Leadership may have changed while this claim waited for the writer.
                if (!admitted()) {
                    return null;
                }
                const settings = this.settings();
                if (settings.paused || !settings.researchAllowed) {
                    return null;
                }
                for (const task of await this.tasks.expired(now)) {
                    await this.invalidate(
                        task,
                        'interrupted',
                        'Worker lease expired. Review completed effects before retrying.',
                    );
                }
                const task = await this.tasks.due(now);
                if (!task || !admitted()) {
                    return null;
                }
                const lease = randomUUID();
                // A schedule's run was due at its time; a queued task's when queued.
                const dueAt = task.status === 'queued' ? task.updatedAt : (task.nextRunAt ?? null);
                await this.tasks.update(task.id, {
                    status: 'running',
                    lease,
                    leaseUntil: now + this.leaseMs,
                    nextRunAt: null,
                    updatedAt: now,
                    lastRunAt: now,
                });
                if (!task.cadence) {
                    await this.tasks.update(task.id, { error: null });
                }
                await this.repos.runs.start(lease, task.id, now, dueAt);
                await this.event(task.id, lease, 'Research worker started.');
                return { ...(await this.get(task.id))!, lease, dueAt };
            },
            { label: 'claim task' },
        );
    }
    async owns(claim: Claim): Promise<boolean> {
        const task = await this.get(claim.id);
        return task?.status === 'running' && task.lease === claim.lease;
    }
    finish(claim: Claim, result: Result, now = Date.now()): Promise<boolean> {
        return this.uow.run(
            async () => {
                if (!(await this.owns(claim))) {
                    return false;
                }
                const task = (await this.get(claim.id))!;
                await this.repos.runs.end(claim.lease, {
                    status: 'completed',
                    finishedAt: now,
                    result,
                });
                await this.tasks.update(claim.id, {
                    status: 'completed',
                    lease: null,
                    leaseUntil: null,
                    updatedAt: now,
                    nextRunAt: task.intervalSeconds ? now + task.intervalSeconds * 1000 : null,
                    error: null,
                });
                if (task.cadence) {
                    await this.reschedule((await this.get(claim.id))!, now);
                }
                await this.event(
                    claim.id,
                    claim.lease,
                    result.sample ? 'Fictional sample brief ready.' : 'Research brief ready.',
                );
                return true;
            },
            { label: 'finish task' },
        );
    }
    interrupt(claim: Claim, reason: string): Promise<void> {
        return this.uow.run(
            async () => {
                if (await this.owns(claim)) {
                    await this.invalidate(claim, 'interrupted', reason);
                }
            },
            { label: 'interrupt task' },
        );
    }
    fail(claim: Claim, error: string): Promise<void> {
        return this.uow.run(
            async () => {
                if (!(await this.owns(claim))) {
                    return;
                }
                const now = Date.now();
                await this.repos.runs.end(claim.lease, {
                    status: 'failed',
                    finishedAt: now,
                    error,
                });
                await this.tasks.update(claim.id, {
                    status: 'failed',
                    lease: null,
                    leaseUntil: null,
                    error,
                    updatedAt: now,
                });
                await this.event(claim.id, claim.lease, error);
                // A schedule tries again at its next time, unless it keeps failing.
                const task = (await this.get(claim.id))!;
                if (!task.cadence) {
                    return;
                }
                const recent = await this.recentRuns(claim.id, SCHEDULE_PAUSE_AFTER_FAILURES);
                if (recent.length === SCHEDULE_PAUSE_AFTER_FAILURES && recent.every((run) => run.status === 'failed')) {
                    await this.tasks.update(claim.id, {
                        status: 'paused',
                        nextRunAt: null,
                        error: `Paused after ${SCHEDULE_PAUSE_AFTER_FAILURES} failed runs in a row: ${error}`.slice(
                            0,
                            500,
                        ),
                    });
                    await this.event(
                        claim.id,
                        claim.lease,
                        `Schedule paused after ${SCHEDULE_PAUSE_AFTER_FAILURES} failed runs in a row.`,
                    );
                } else {
                    await this.reschedule(task, now);
                }
            },
            { label: 'fail task' },
        );
    }
    /** Gives tasks from before user accounts to a user; says how many. */
    assignUnowned(userId: string) {
        return this.tasks.assignUnowned(userId);
    }
}
