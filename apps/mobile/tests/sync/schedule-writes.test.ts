import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { GoalView, ScheduleView } from '@socio/shared/schedule-types';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { AbortedError, NetworkError } from '../../src/net/errors';
import { unsentListRows } from '../../src/shell/unsent';
import { type Outbox, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import {
    actOnSchedule,
    actOnTask,
    commentOnGoal,
    GOAL_COMMENT_IDS,
    newestGoalComment,
    type OnlineContext,
    onlineActionCopy,
    runJobNow,
    runNowBlocked,
    runScheduleNow,
    SCHEDULE_REASON,
    SCHEDULE_WRITE_VIEWS,
    scheduleWriteKinds,
    ScheduleWriteError,
    shownSchedules,
    stopJob,
} from '../../src/sync/schedule-writes';
import { GOALS, SCHEDULES } from '../../src/sync/schedules';
import type { ConfirmedChange } from '../../src/sync/snapshot-cache';

import { turns, userDb } from './outbox-fakes';

// Schedules, goals and tasks writes on a real outbox (user.db on node:sqlite)
// against a fake server whose routes answer as src/server/schedules/routes.ts
// and composition/http/turns.ts do: statuses only, never text. Goals and jobs
// have no HTTP create, so they exist only here, on the fake server.

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Script = 'drop' | 'hang' | 'offline' | { readonly status: number; readonly body?: unknown };

const SETTINGS = { paused: false, researchAllowed: true };

function server() {
    let clock = 1_000;
    const schedules = new Map<string, ScheduleView & { archived?: boolean }>();
    const goals = new Map<string, GoalView>();
    const tasks = new Map<string, { id: string; status: string }>();
    const runningJobs = new Set<string>();
    const scripts = new Map<string, Script[]>();
    const log: string[] = [];
    let next = 0;
    let researchAllowed = true;

    const schedule = (fields: Partial<ScheduleView> & { archived?: boolean } = {}) => {
        const item = {
            id: `sch-${++next}`,
            title: 'Morning digest',
            prompt: 'Summarize the news',
            kind: 'turn' as const,
            cadence: 'every day at 09:00',
            timezone: 'Europe/Madrid',
            intervalSeconds: null,
            status: 'scheduled' as const,
            origin: 'user' as const,
            dotId: 'dot-1',
            dotName: 'Ada',
            jobId: null,
            jobName: null,
            threadId: null,
            nextRunAt: null,
            lastRun: null,
            error: null,
            createdAt: clock,
            ...fields,
        };
        schedules.set(item.id, item);
        return item;
    };
    const goal = (fields: Partial<GoalView> = {}): GoalView => {
        clock += 10;
        const item: GoalView = {
            id: `G-${String(++next).padStart(8, '0')}`,
            userId: 'user-1',
            dotId: 'dot-1',
            title: 'Ship the report',
            detail: '',
            status: 'active',
            progress: null,
            comments: [],
            scheduleId: 'sch-goal',
            threadId: null,
            cadence: null,
            nextRunAt: null,
            createdAt: clock,
            updatedAt: clock,
            closedAt: null,
            ...fields,
        };
        goals.set(item.id, item);
        return item;
    };
    const addComment = (goalId: string, body: string, author: 'person' | 'dot' = 'person') => {
        const item = goals.get(goalId)!;
        clock += 10;
        item.comments = [...item.comments, { id: `GC-${++next}`, author, body, createdAt: clock }];
        item.updatedAt = clock;
        return item;
    };
    const shown = (item: ScheduleView & { archived?: boolean }) => {
        const { archived: _a, ...view } = item;
        return view;
    };
    const answer = async (key: string, path: string, init: AuthedRequestInit, apply: () => Response) => {
        const scripted = scripts.get(key)?.shift();
        if (scripted === 'offline') {
            throw new NetworkError(path);
        }
        if (scripted === 'drop') {
            apply();
            throw new NetworkError(path);
        }
        if (scripted === 'hang') {
            apply();
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new AbortedError(path, init.signal?.reason)), {
                    once: true,
                });
            });
        }
        if (scripted !== undefined) {
            return json(scripted.status, scripted.body ?? {});
        }
        return apply();
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body = init.json as Record<string, unknown> | undefined;
        log.push(`${method} ${input}${body?.action ? ` ${String(body.action)}` : ''}`);
        const path = new URL(input, 'https://brain.example.test').pathname;
        if (path === '/api/schedules' && method === 'GET') {
            return answer('GET schedules', path, init, () =>
                json(200, {
                    schedules: [...schedules.values()].map(shown),
                    goals: [...goals.values()],
                    jobs: [],
                    limits: {},
                    usage: {},
                }),
            );
        }
        let match = /^\/api\/schedules\/goals\/([^/]+)\/comments$/.exec(path);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]!);
            return answer('POST comment', path, init, () => {
                const item = goals.get(id);
                if (item === undefined) {
                    return json(404, { error: 'Goal not found.' });
                }
                if (item.status === 'done' || item.status === 'cancelled') {
                    return json(409, { error: 'This goal is done.' });
                }
                const text = typeof body?.body === 'string' ? body.body.trim() : '';
                if (!text || text.length > 1000) {
                    return json(400, { error: 'Write the comment in 1 to 1000 characters.' });
                }
                return json(200, addComment(id, text));
            });
        }
        match = /^\/api\/schedules\/jobs\/([^/]+)\/(run|stop)$/.exec(path);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]!);
            return answer(`POST job ${match[2]}`, path, init, () => {
                if (match![2] === 'run') {
                    runningJobs.add(id);
                    return json(200, { id: `run-${++next}`, jobId: id, status: 'queued' });
                }
                if (!runningJobs.delete(id)) {
                    return json(409, { error: 'The job isn’t running.' });
                }
                return json(200, { id, status: 'cancelled' });
            });
        }
        match = /^\/api\/schedules\/([^/]+)\/actions$/.exec(path);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]!);
            return answer('POST action', path, init, () => {
                const item = schedules.get(id);
                const action = body?.action;
                if (item === undefined) {
                    return json(404, { error: 'Schedule not found.' });
                }
                if (action === 'run' && !researchAllowed) {
                    return json(403, { error: 'Research is disabled in Settings.' });
                }
                if (item.status === 'cancelled' && action !== 'cancel') {
                    return json(409, { error: 'This schedule was canceled.' });
                }
                if ((action === 'resume' || action === 'run') && item.archived) {
                    return json(409, { error: 'This schedule’s socio is archived.' });
                }
                const status =
                    action === 'pause'
                        ? 'paused'
                        : action === 'cancel'
                          ? 'cancelled'
                          : action === 'run'
                            ? 'queued'
                            : item.status === 'paused'
                              ? 'scheduled'
                              : item.status;
                Object.assign(item, { status });
                return json(200, shown(item));
            });
        }
        match = /^\/api\/tasks\/([^/]+)\/actions$/.exec(path);
        if (match && method === 'POST') {
            const id = decodeURIComponent(match[1]!);
            return answer('POST task', path, init, () => {
                const item = tasks.get(id);
                if (item === undefined) {
                    return json(404, { error: 'Task not found.' });
                }
                if (body?.action === 'run' && !researchAllowed) {
                    return json(403, { error: 'Research is disabled in Settings.' });
                }
                item.status = body?.action === 'run' ? 'queued' : body?.action === 'pause' ? 'paused' : 'cancelled';
                return json(200, item);
            });
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        log,
        schedules,
        goals,
        tasks,
        runningJobs,
        schedule,
        goal,
        addComment,
        now: () => clock,
        set researchAllowed(value: boolean) {
            researchAllowed = value;
        },
        script(key: string, ...answers: Script[]) {
            scripts.set(key, [...(scripts.get(key) ?? []), ...answers]);
        },
        count: (prefix: string) => log.filter((entry) => entry.startsWith(prefix)).length,
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

let ids = 0;
const newId = () => `id-${++ids}`;

interface Phone {
    readonly outbox: Outbox;
    readonly confirmed: ConfirmedChange[];
    readonly pulled: string[];
    start(): void;
    settle(): Promise<void>;
    until(done: () => boolean): Promise<void>;
    relaunch(): Promise<Phone>;
}

async function open(
    srv: Server,
    { files, start = true }: { files?: Awaited<ReturnType<typeof userDb>>; start?: boolean } = {},
): Promise<Phone> {
    const user = files ?? (await userDb());
    if (!files) {
        cleanups.push(() => rmSync(user.directory, { recursive: true, force: true }));
    }
    const file = await user.open();
    const confirmed: ConfirmedChange[] = [];
    const pulled: string[] = [];
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: scheduleWriteKinds({
            cache: { confirm: async (change) => void confirmed.push(change) },
            afterWrite: (path) => pulled.push(path),
        }),
        fetch: srv.fetch,
        random: () => 0,
    });
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await outbox.dispose();
            await file.db.close().catch(() => {});
        }
    };
    cleanups.push(close);
    if (start) {
        outbox.start();
    }
    const phone: Phone = {
        outbox,
        confirmed,
        pulled,
        start: () => outbox.start(),
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await phone.settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await phone.settle();
            }
        },
        async relaunch() {
            await close();
            return open(srv, { files: user });
        },
    };
    return phone;
}

const empty = (phone: Phone) => phone.outbox.rows().length === 0;
const unsentRows = (phone: Phone) =>
    unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), { chatTitle: () => null, resolve: () => null });

describe('pausing, resuming and cancelling a schedule', () => {
    it('pause, resume and pause written offline make one request, the newest intent', async () => {
        const srv = server();
        const item = srv.schedule();
        const phone = await open(srv, { start: false });
        expect(await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'pause', newId })).toBe('queued');
        expect(await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'resume', newId })).toBe('folded');
        expect(await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'pause', newId })).toBe('folded');
        expect(phone.outbox.rows()).toHaveLength(1);
        phone.start();
        await phone.until(() => empty(phone));
        expect(srv.log.filter((line) => line.startsWith('POST'))).toEqual([
            `POST /api/schedules/${item.id}/actions pause`,
        ]);
        expect(srv.schedules.get(item.id)!.status).toBe('paused');
        expect(phone.confirmed).toEqual([
            expect.objectContaining({
                collection: SCHEDULES,
                key: item.id,
                value: expect.objectContaining({ status: 'paused' }),
            }),
        ]);
        expect(phone.pulled).toContain(`/api/schedules/${item.id}/actions`);
    });

    it('a queued cancel is never overwritten by a later pause, which goes after it and is refused', async () => {
        const srv = server();
        const item = srv.schedule();
        const phone = await open(srv, { start: false });
        await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'cancel', newId });
        expect(await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'pause', newId })).toBe('queued');
        expect(phone.outbox.rows()).toHaveLength(2);
        phone.start();
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(srv.schedules.get(item.id)!.status).toBe('cancelled');
        expect(phone.outbox.unsent()[0]!.reason).toBe(SCHEDULE_REASON.closed);
        expect(unsentRows(phone)).toEqual([
            expect.objectContaining({
                what: 'Pause schedule',
                where: 'Schedules',
                why: 'That schedule was cancelled, or its socio is archived',
            }),
        ]);
    });

    it('a cancel folds over a queued pause', async () => {
        const srv = server();
        const item = srv.schedule();
        const phone = await open(srv, { start: false });
        await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'pause', newId });
        expect(await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'cancel', newId })).toBe('folded');
        phone.start();
        await phone.until(() => empty(phone));
        expect(srv.count('POST')).toBe(1);
        expect(srv.schedules.get(item.id)!.status).toBe('cancelled');
    });

    it('a 409 (its socio archived) goes to unsent, and a newer intent replaces it', async () => {
        const srv = server();
        const item = srv.schedule({ status: 'paused', archived: true });
        const phone = await open(srv);
        await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'resume', newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe(SCHEDULE_REASON.closed);
        await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'cancel', newId });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.schedules.get(item.id)!.status).toBe('cancelled');
    });

    it('a gone schedule: a pause goes to unsent, a cancel is done', async () => {
        const srv = server();
        const phone = await open(srv);
        await actOnSchedule(phone.outbox, { scheduleId: 'sch-gone', action: 'pause', newId });
        await actOnSchedule(phone.outbox, { scheduleId: 'sch-gone-2', action: 'cancel', newId });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent().map((write) => write.reason)).toEqual([SCHEDULE_REASON.gone]);
        expect(unsentRows(phone)[0]!.why).toBe('That schedule is no longer here');
    });

    it('safe to repeat: an answer lost after the server paused it goes again, unchecked', async () => {
        const srv = server();
        const item = srv.schedule();
        const phone = await open(srv);
        srv.script('POST action', 'drop');
        await actOnSchedule(phone.outbox, { scheduleId: item.id, action: 'pause', newId });
        await phone.until(() => empty(phone));
        expect(srv.count('POST')).toBe(2);
        expect(srv.schedules.get(item.id)!.status).toBe('paused');
    });
});

describe('commenting on a goal', () => {
    const comment = (phone: Phone, srv: Server, goalId: string, body: string, serverAt: number | null = srv.now()) =>
        commentOnGoal(phone.outbox, {
            goalId,
            body,
            newId,
            after: newestGoalComment(srv.goals.get(goalId)),
            serverAt,
        });

    it('posts the trimmed body, records the comment’s id and hands the goal to cache.db', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        const localId = await comment(phone, srv, item.id, '  The deadline moved to Friday  ');
        await phone.until(() => empty(phone));
        const [stored] = srv.goals.get(item.id)!.comments;
        expect(stored!.body).toBe('The deadline moved to Friday');
        expect(phone.outbox.resolve(GOAL_COMMENT_IDS, localId)).toBe(stored!.id);
        expect(phone.confirmed).toEqual([
            expect.objectContaining({ collection: GOALS, key: item.id, version: srv.goals.get(item.id)!.updatedAt }),
        ]);
    });

    it('refuses an empty or too long comment before queuing', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        await expect(comment(phone, srv, item.id, '   ')).rejects.toThrow(ScheduleWriteError);
        await expect(comment(phone, srv, item.id, 'x'.repeat(1001))).rejects.toThrow(ScheduleWriteError);
        expect(phone.outbox.rows()).toHaveLength(0);
    });

    it('an answer lost after the server stored it: the check finds it, and it never goes twice', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        srv.script('POST comment', 'drop');
        const localId = await comment(phone, srv, item.id, 'Use the new numbers');
        await phone.until(() => empty(phone));
        expect(srv.goals.get(item.id)!.comments).toHaveLength(1);
        expect(srv.count('POST')).toBe(1);
        expect(phone.outbox.resolve(GOAL_COMMENT_IDS, localId)).toBe(srv.goals.get(item.id)!.comments[0]!.id);
    });

    it('a kill with the comment in flight: after the relaunch exactly one comment', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        srv.script('POST comment', 'hang');
        await comment(phone, srv, item.id, 'Kill me once');
        await turns(30);
        expect(srv.goals.get(item.id)!.comments).toHaveLength(1);
        const after = await phone.relaunch();
        await after.until(() => empty(after));
        expect(srv.goals.get(item.id)!.comments).toHaveLength(1);
        expect(srv.count('POST')).toBe(1);
    });

    it('a request that never arrived goes again after the check finds nothing', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        srv.script('POST comment', { status: 502 });
        await comment(phone, srv, item.id, 'Second try');
        await phone.until(() => empty(phone));
        expect(srv.goals.get(item.id)!.comments).toHaveLength(1);
        expect(srv.count('POST')).toBe(2);
    });

    it('two identical comments, the first lost after storing: each settles on its own comment', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        srv.script('POST comment', 'drop');
        const first = await comment(phone, srv, item.id, '+1');
        const second = await comment(phone, srv, item.id, '+1');
        await phone.until(() => empty(phone));
        const stored = srv.goals.get(item.id)!.comments;
        expect(stored).toHaveLength(2);
        expect(
            new Set([phone.outbox.resolve(GOAL_COMMENT_IDS, first), phone.outbox.resolve(GOAL_COMMENT_IDS, second)]),
        ).toEqual(new Set(stored.map((entry) => entry.id)));
    });

    it('the same words from the web at the same moment: the person decides, with both for View', async () => {
        const srv = server();
        const item = srv.goal();
        const phone = await open(srv);
        srv.script('POST comment', 'drop');
        await comment(phone, srv, item.id, 'Twice');
        srv.addComment(item.id, 'Twice');
        await phone.until(() => phone.outbox.holds().length === 1);
        const [group] = phone.outbox.holds();
        expect(group!.root.cause).toBe('unconfirmed');
        expect(group!.root.candidates).toHaveLength(2);
    });

    it('a socio’s comment with the same words, or an older one of the person’s, is no candidate', async () => {
        const srv = server();
        const item = srv.goal();
        srv.addComment(item.id, 'Same');
        const phone = await open(srv);
        srv.script('POST comment', 'offline');
        await comment(phone, srv, item.id, 'Same');
        srv.addComment(item.id, 'Same', 'dot');
        await phone.until(() => empty(phone));
        expect(srv.goals.get(item.id)!.comments.filter((entry) => entry.author === 'person')).toHaveLength(2);
    });

    it('a closed goal’s comment goes to unsent with words and the text to copy', async () => {
        const srv = server();
        const item = srv.goal({ status: 'done' });
        const phone = await open(srv);
        await comment(phone, srv, item.id, 'Too late');
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(unsentRows(phone)).toEqual([
            expect.objectContaining({
                what: 'Goal comment',
                where: 'Schedules',
                text: 'Too late',
                why: 'That goal is closed, or keeps no more comments',
            }),
        ]);
    });
});

describe('online only: Run now, task actions and Stop', () => {
    const online = (srv: Server, connected: boolean | null = true, pulled: string[] = []): OnlineContext => ({
        fetch: srv.fetch,
        connected,
        afterWrite: (path) => pulled.push(path),
    });

    it('offline, Run now and a task’s Pause send nothing, queue nothing and say “Needs a connection”', async () => {
        const srv = server();
        const item = srv.schedule();
        srv.tasks.set('task-1', { id: 'task-1', status: 'running' });
        const phone = await open(srv);
        const offline = online(srv, false);
        const results = [
            await runScheduleNow(offline, { scheduleId: item.id, settings: SETTINGS }),
            await runJobNow(offline, { jobId: 'job-1', settings: SETTINGS }),
            await actOnTask(offline, { taskId: 'task-1', action: 'pause' }),
            await actOnTask(offline, { taskId: 'task-1', action: 'cancel' }),
            await stopJob(offline, { jobId: 'job-1' }),
        ];
        expect(results.every((result) => result.outcome === 'offline')).toBe(true);
        expect(onlineActionCopy(results[0]!)).toBe('Needs a connection');
        await phone.settle();
        expect(srv.log).toEqual([]);
        expect(phone.outbox.rows()).toHaveLength(0);
        expect(srv.tasks.get('task-1')!.status).toBe('running');
    });

    it('no answer is never sent again by itself', async () => {
        const srv = server();
        srv.tasks.set('task-1', { id: 'task-1', status: 'running' });
        srv.script('POST task', 'drop');
        const result = await actOnTask(online(srv), { taskId: 'task-1', action: 'pause' });
        expect(result).toEqual({ outcome: 'no-answer' });
        await turns(30);
        expect(srv.count('POST')).toBe(1);
        expect(onlineActionCopy(result)).toMatch(/Check before you try again/);
    });

    it('a task’s Pause, Cancel and Run now go once and pull what changed', async () => {
        const srv = server();
        srv.tasks.set('task-1', { id: 'task-1', status: 'running' });
        const pulled: string[] = [];
        const context = online(srv, true, pulled);
        expect((await actOnTask(context, { taskId: 'task-1', action: 'pause' })).outcome).toBe('done');
        expect(srv.tasks.get('task-1')!.status).toBe('paused');
        expect((await actOnTask(context, { taskId: 'task-1', action: 'run', settings: SETTINGS })).outcome).toBe(
            'done',
        );
        expect((await actOnTask(context, { taskId: 'task-1', action: 'cancel' })).outcome).toBe('done');
        expect(srv.log).toEqual([
            'POST /api/tasks/task-1/actions pause',
            'POST /api/tasks/task-1/actions run',
            'POST /api/tasks/task-1/actions cancel',
        ]);
        expect(pulled).toEqual(Array(3).fill('/api/tasks/task-1/actions'));
    });

    it('Run now is blocked while socios are paused or research is off, with no request', async () => {
        const srv = server();
        const item = srv.schedule();
        expect(runNowBlocked({ paused: true, researchAllowed: true })).toBe('paused');
        expect(runNowBlocked({ paused: false, researchAllowed: false })).toBe('research-off');
        expect(runNowBlocked(SETTINGS, 'cancelled')).toBe('cancelled');
        expect(runNowBlocked(SETTINGS, 'paused')).toBeNull();
        const blocked = await runScheduleNow(online(srv), {
            scheduleId: item.id,
            settings: { paused: false, researchAllowed: false },
        });
        expect(blocked).toEqual({ outcome: 'blocked', why: 'research-off' });
        expect(
            await actOnTask(online(srv), {
                taskId: 't',
                action: 'run',
                settings: { paused: true, researchAllowed: true },
            }),
        ).toEqual({ outcome: 'blocked', why: 'paused' });
        expect(srv.log).toEqual([]);
    });

    it('a 403 from the server still gets words, and Run now’s schedule goes to cache.db', async () => {
        const srv = server();
        const item = srv.schedule();
        const confirmed: ConfirmedChange[] = [];
        const context: OnlineContext = {
            ...online(srv),
            cache: { confirm: async (change) => void confirmed.push(change) },
        };
        srv.researchAllowed = false;
        const refused = await runScheduleNow(context, { scheduleId: item.id, settings: SETTINGS });
        expect(refused).toEqual({ outcome: 'refused', reason: 'http-403' });
        expect(onlineActionCopy(refused)).toBe('Running now is turned off for this workspace');
        srv.researchAllowed = true;
        expect((await runScheduleNow(context, { scheduleId: item.id, settings: SETTINGS })).outcome).toBe('done');
        expect(confirmed).toEqual([
            expect.objectContaining({
                collection: SCHEDULES,
                key: item.id,
                value: expect.objectContaining({ status: 'queued' }),
            }),
        ]);
    });

    it('Stop on a running job goes once; one that isn’t running is done', async () => {
        const srv = server();
        srv.runningJobs.add('job-1');
        expect((await stopJob(online(srv), { jobId: 'job-1' })).outcome).toBe('done');
        expect(srv.runningJobs.has('job-1')).toBe(false);
        expect((await stopJob(online(srv), { jobId: 'job-1' })).outcome).toBe('done');
        expect(srv.count('POST /api/schedules/jobs/job-1/stop')).toBe(2);
    });
});

describe('the view', () => {
    it('Schedules shows each write at once over the stored rows, and a refused one as stored', async () => {
        const srv = server();
        const paused = srv.schedule({ status: 'paused', cadence: 'every day at 09:00' });
        const running = srv.schedule({ status: 'scheduled' });
        const goal = srv.goal();
        const phone = await open(srv, { start: false });
        await actOnSchedule(phone.outbox, { scheduleId: paused.id, action: 'resume', newId });
        await actOnSchedule(phone.outbox, { scheduleId: running.id, action: 'pause', newId });
        const localId = await commentOnGoal(phone.outbox, {
            goalId: goal.id,
            body: 'Noted',
            newId,
            after: null,
            serverAt: null,
        });
        const overlays = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: phone.outbox.unsent(),
            kinds: SCHEDULE_WRITE_VIEWS,
            scope: phone.outbox,
        });
        const view = shownSchedules(srv.schedules.values(), srv.goals.values(), overlays);
        expect(view.schedules.find((item) => item.id === paused.id)).toMatchObject({
            status: 'scheduled',
            pending: 'queued',
        });
        expect(view.schedules.find((item) => item.id === running.id)).toMatchObject({
            status: 'paused',
            pending: 'queued',
        });
        expect(view.goals[0]!.comments).toEqual([
            expect.objectContaining({ id: localId, body: 'Noted', author: 'person', pending: 'queued' }),
        ]);

        const refused = shownSchedules(
            srv.schedules.values(),
            [],
            [{ ...overlays[1]!, state: 'unsent', reason: SCHEDULE_REASON.closed }],
        );
        expect(refused.schedules.find((item) => item.id === running.id)).toMatchObject({
            status: 'scheduled',
            pending: 'unsent',
            reason: SCHEDULE_REASON.closed,
        });
    });
});
