import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { forceStopLogLine } from '@socio/foundation/runtime/force-stop-log';
import {
    FORCE_STOP_CODE,
    FORCE_STOP_MESSAGE,
    type AppEnvironment,
    type ForceStopResult,
    type OperatorWork,
} from '@socio/shared/operator';
import type { User } from '@socio/shared/types';

import { createApp } from '../src/server/app.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { appEnvironmentFromEnv, shutdownForceFromEnv, type PlatformConfig } from '../src/server/composition/config.js';
import {
    ComputerService,
    abortComputerActions,
    computerActionsInFlight,
} from '../src/server/computers/computer-service.js';
import { forceStop } from '../src/server/runtime/force-stop.js';
import { createShutdown } from '../src/server/runtime/shutdown.js';
import { ChannelTurnAgent } from '../src/server/telegram/telegram-channel.js';
import { runThreadTurnOutcome } from '../src/server/turns/headless.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

/** The computer actions in progress, as the composition hands them to the force stop. */
const computers = { inFlight: computerActionsInFlight, abort: abortComputerActions };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

/** Starts a tool call (a computer step) and waits until it is aborted. */
class ToolAgent extends AbstractAgent {
    aborted = false;
    private release?: () => void;
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TOOL_CALL_START,
                toolCallId: 'call-1',
                toolCallName: 'computer_snapshot',
            } as BaseEvent);
            this.release = () => subscriber.complete();
        });
    }
    abortRun() {
        this.aborted = true;
        this.release?.();
    }
}

async function fixture(environment: AppEnvironment = 'development') {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Titles ask the model after a turn; it is never reached.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const db = testDatabase();
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    const config: PlatformConfig = {
        baseUrl: 'https://model.invalid/v1',
        apiKey: 'unused',
        model: 'qwen-test',
        voiceName: 'marin',
        runtimeUrl: '',
        environment,
        computerSupervisorUrl: 'http://127.0.0.1:4312',
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
    };
    // The server's graph and runtime: the operator's routes read the
    // environment, the drain and page search through it (appHandle).
    const { runtime, edge, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config,
        runner,
        auth: testAuth(),
    });
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const scheduled: AbstractAgent[] = [];
    const scheduler = new Runner(store, { mode: 'live', baseUrl: '' }, async (claim, _memories, signal) => {
        const thread = (await workspace.taskThread(claim.id))!;
        const agent = new ScriptAgent('Checking', true);
        scheduled.push(agent);
        const outcome = await runThreadTurnOutcome(runner, agent, thread, claim.prompt, signal, undefined, 'scheduled');
        return { text: outcome.text, sources: [], sample: false };
    });
    cleanup.push(async () => {
        scheduler.stop();
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const app = createApp({
        store,
        runner: scheduler,
        config: { mode: 'live', baseUrl: '' },
        edge,
        auth: {
            provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
            secureCookies: false,
        },
        runtime,
    });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
            app.request(
                new Request(`http://localhost/api${path}`, {
                    method,
                    headers: {
                        cookie,
                        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal,
                }),
            );
    };
    const dot = workspace.dots()[0];
    /** Starts a web turn that runs until it is stopped. */
    const webTurn = async (agent: AbstractAgent = new ScriptAgent('Hi', true)) => {
        const thread = await platform.createConversation(dot.id, 'Chat', 'alice');
        const runId = `run-${thread.id.slice(0, 8)}`;
        const events = lastValueFrom(
            runner
                .run({
                    threadId: thread.id,
                    agent,
                    input: {
                        threadId: thread.id,
                        runId,
                        messages: [{ id: `user-${runId}`, role: 'user', content: 'Go' }],
                        tools: [],
                        context: [],
                        state: {},
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
        );
        return { thread, runId, events };
    };
    return {
        store,
        workspace,
        runner,
        platform,
        scheduler,
        scheduled,
        config,
        as,
        dot,
        webTurn,
    };
}

it('answers 404 outside development and 403 to members (CB-390: admins pass)', async () => {
    const production = await fixture('production');
    for (const id of ['olga', 'alice']) {
        const call = await production.as(id);
        expect((await call('/operator/force-stop', 'POST', {})).status).toBe(404);
    }
    // The work view stays, for operators, and says it is production.
    const olga = await production.as('olga');
    expect(await (await olga('/operator/work')).json()).toMatchObject({
        environment: 'production',
        forceStop: false,
        draining: false,
    });

    const development = await fixture('development');
    for (const id of ['bob']) {
        const call = await development.as(id);
        expect((await call('/operator/force-stop', 'POST', {})).status).toBe(403);
        expect((await call('/operator/work')).status).toBe(403);
    }
    const operator = await development.as('olga');
    expect((await operator('/operator/force-stop', 'POST', { hold: 'yes' })).status).toBe(400);
    expect(development.platform.draining).toBe(false);
});

it('answers the gate and the work view as before when the client goes away, with no logged failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gone = () => {
        const client = new AbortController();
        client.abort();
        return client.signal;
    };
    // The gate's 404 outside development, and the work view behind it.
    const production = await fixture('production');
    const olga = await production.as('olga');
    expect((await olga('/operator/force-stop', 'POST', {}, gone())).status).toBe(404);
    const work = await olga('/operator/work', 'GET', undefined, gone());
    expect(work.status).toBe(200);
    expect(await work.json()).toMatchObject({ environment: 'production', forceStop: false });
    // In development the gate lets the request through to the force stop.
    const development = await fixture('development');
    const stopped = await (await development.as('olga'))('/operator/force-stop', 'POST', { hold: false }, gone());
    expect(stopped.status).toBe(200);
    expect(errors).not.toHaveBeenCalledWith('API request failed:', expect.anything());
    errors.mockRestore();
});

it('stops running web and Telegram turns with the message, records them, and logs who did it', async () => {
    const f = await fixture();
    const tool = new ToolAgent({});
    const web = await f.webTurn(tool);
    // A Telegram turn, as the channel runs it.
    const failed: string[] = [];
    const telegram = new ChannelTurnAgent({
        runner: f.runner,
        workspace: f.workspace,
        ...telegramServices({ store: f.store, workspace: f.workspace, config: f.config, runner: f.runner }),
        dotId: () => f.dot.id,
        userFor: async () => 'bob',
        agentFor: () => new ScriptAgent('Thinking', true),
        onFailed: (key, message) => failed.push(`${key}: ${message}`),
    });
    const telegramEvents = lastValueFrom(
        telegram
            .run({
                threadId: 'tg-thread-tg:42:dm',
                runId: 'tg-run',
                messages: [{ id: 'tg-user', role: 'user', content: 'Hi' }],
                tools: [],
                context: [],
                state: {},
                forwardedProps: { channelActor: { id: '7' } },
            })
            .pipe(toArray()),
    );
    await vi.waitFor(() => expect(f.runner.running).toBe(2));
    const olga = await f.as('olga');
    const work = (await (await olga('/operator/work')).json()) as OperatorWork;
    expect(work).toMatchObject({
        environment: 'development',
        forceStop: true,
        work: { turns: 2, scheduledTasks: 0 },
    });

    const response = await olga('/operator/force-stop', 'POST', {});
    expect(response.status).toBe(200);
    const result = (await response.json()) as ForceStopResult;
    expect(result).toEqual({
        turns: 2,
        turnSources: { web: 1, telegram: 1 },
        scheduledTasks: 0,
        computerActions: 0,
        jobRuns: 0,
        held: true,
    });
    expect(tool.aborted).toBe(true);
    const events = await web.events;
    expect(events.at(-1)).toEqual({
        type: EventType.RUN_ERROR,
        message: FORCE_STOP_MESSAGE,
        code: FORCE_STOP_CODE,
        timestamp: expect.any(Number),
    });
    // The open computer step says so too.
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
        content: JSON.stringify({
            status: 'stopped',
            reason: 'stop_requested',
            message: FORCE_STOP_MESSAGE,
        }),
    });
    // Telegram replies with the message (the channel's renderer sees a finish).
    expect((await telegramEvents).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(failed).toEqual([`tg:42:dm: ${FORCE_STOP_MESSAGE}`]);
    await vi.waitFor(() => expect(f.runner.running).toBe(0));
    expect(f.runner.recentRuns()).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                runId: web.runId,
                status: 'interrupted',
                error: FORCE_STOP_MESSAGE,
            }),
            expect.objectContaining({ runId: 'tg-run', status: 'interrupted' }),
        ]),
    );
    // Replays show the message after the stored turn.
    expect(f.runner.events(web.thread.id).at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: FORCE_STOP_MESSAGE,
    });
    const logged = vi.mocked(console.log).mock.calls.flat().map(String);
    expect(logged).toContainEqual(
        expect.stringMatching(
            /^Operator: force stop by user=olga at=\d{4}-\d\d-\d\dT[\d:.]+Z turns=2 scheduled=0 computer=0 jobs=0 hold=true$/,
        ),
    );
    expect(logged).toContainEqual(expect.stringMatching(/^Turn: interrupted .* error=operator_stopped$/));
    // Held for the deploy: new turns are refused as while draining.
    expect(f.platform.draining).toBe(true);
    expect(await f.platform.health()).toMatchObject({ draining: true });
    // The work view reads the drain (Lifecycle) when it is asked.
    expect(await (await olga('/operator/work')).json()).toMatchObject({ draining: true });
});

it('without hold, stops what runs and keeps taking new work', async () => {
    const f = await fixture();
    const web = await f.webTurn();
    await vi.waitFor(() => expect(f.runner.running).toBe(1));
    const olga = await f.as('olga');
    const result = (await (await olga('/operator/force-stop', 'POST', { hold: false })).json()) as ForceStopResult;
    expect(result).toMatchObject({ turns: 1, held: false });
    expect((await web.events).at(-1)).toMatchObject({
        message: FORCE_STOP_MESSAGE,
    });
    expect(f.platform.draining).toBe(false);
});

it('interrupts scheduled tasks with the message', async () => {
    const f = await fixture();
    const thread = await f.platform.createConversation(f.dot.id, 'Weekly', 'alice');
    const task = await f.store.createTask('Check the week', null, 'alice');
    await f.workspace.bindTask(task.id, thread.id);
    const tick = f.scheduler.tick();
    await vi.waitFor(() => expect(f.runner.running).toBe(1));
    expect(f.scheduler.running).toBe(1);
    const result = await forceStop(
        { platform: f.platform, scheduler: f.scheduler, computers },
        { by: 'olga', hold: true },
    );
    expect(result).toMatchObject({
        turns: 1,
        turnSources: { scheduled: 1 },
        scheduledTasks: 1,
    });
    await tick;
    expect(await f.store.task(task.id)).toMatchObject({
        status: 'interrupted',
        error: FORCE_STOP_MESSAGE,
    });
    await vi.waitFor(() =>
        expect(f.runner.recentRuns()[0]).toMatchObject({
            status: 'interrupted',
            source: 'scheduled',
        }),
    );
    // Held: the scheduler claims nothing new until the restart.
    await f.store.createTask('Another', null, 'alice');
    await f.scheduler.tick();
    expect(f.scheduler.running).toBe(0);
});

it('aborts computer actions in progress, without stopping the computer', async () => {
    const f = await fixture();
    const requests: string[] = [];
    const service = new ComputerService(f.workspace, f.config, () => false, (async (
        url: string | URL | Request,
        init?: RequestInit,
    ) => {
        requests.push(String(url));
        // The computer never answers; only the abort ends the request.
        return new Promise<Response>((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        );
    }) as typeof fetch);
    await f.workspace.computers.patch(f.dot.id, { enabled: true, browser: true });
    const action = service.action(f.dot.id, 'snapshot', {}, 'agent');
    await vi.waitFor(() => expect(computerActionsInFlight()).toBe(1));
    const result = await forceStop(
        { platform: f.platform, scheduler: f.scheduler, computers },
        { by: 'olga', hold: false },
    );
    expect(result.computerActions).toBe(1);
    await expect(action).rejects.toThrow('Computer request was canceled or timed out.');
    expect(computerActionsInFlight()).toBe(0);
    // Only the listing was asked for: nothing stopped the container.
    expect(requests).toEqual(['http://127.0.0.1:4312/computers']);
    expect((await f.workspace.computers.audit(f.dot.id))[0]).toMatchObject({
        action: 'snapshot',
        outcome: 'failed',
    });
});

it('reads APP_ENV and SHUTDOWN_FORCE; production ignores SHUTDOWN_FORCE', () => {
    expect(appEnvironmentFromEnv({})).toBe('production');
    expect(appEnvironmentFromEnv({ APP_ENV: ' Development ' })).toBe('development');
    expect(appEnvironmentFromEnv({ APP_ENV: 'production' })).toBe('production');
    expect(() => appEnvironmentFromEnv({ APP_ENV: 'dev' })).toThrow('APP_ENV must be development or production.');
    const warn = vi.fn();
    expect(shutdownForceFromEnv({}, 'development', warn)).toBe(false);
    expect(shutdownForceFromEnv({ SHUTDOWN_FORCE: 'true' }, 'development', warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(shutdownForceFromEnv({ SHUTDOWN_FORCE: 'true' }, 'production', warn)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
        'Shutdown: SHUTDOWN_FORCE is ignored outside APP_ENV=development; SIGTERM drains.',
    );
    expect(
        forceStopLogLine(
            'olga',
            {
                turns: 1,
                turnSources: { web: 1 },
                scheduledTasks: 0,
                computerActions: 0,
                jobRuns: 0,
                held: true,
            },
            new Date(Date.UTC(2026, 9, 8, 12)),
        ),
    ).toBe(
        'Operator: force stop by user=olga at=2026-10-08T12:00:00.000Z turns=1 scheduled=0 computer=0 jobs=0 hold=true',
    );
});

it('with SHUTDOWN_FORCE, stops work at once instead of draining', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let running = 2;
    const exit = vi.fn(),
        log = vi.fn();
    const shutdown = createShutdown({
        drain: () => order.push('drain'),
        inProgress: () => running,
        drainMs: 320_000,
        force: async () => {
            order.push('force');
            running = 1;
            // The last stopped turn finishes storing a moment later.
            setTimeout(() => (running = 0), 300);
        },
        stopRunner: () => order.push('stopRunner'),
        stopPlatform: async () => void order.push('stopPlatform'),
        closeServer: async () => void order.push('closeServer'),
        exit,
        report: vi.fn(),
        log,
    });
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(order).toEqual(['drain', 'force', 'stopRunner', 'stopPlatform', 'closeServer']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.mock.calls.flat()).toEqual([
        'Shutdown: SHUTDOWN_FORCE, stopping 2 in progress now.',
        'Shutdown: waiting for stopped work, 1 in progress (up to 5 s).',
        'Shutdown: drained in 1 s.',
    ]);
});

it('with SHUTDOWN_FORCE, a stuck force stop is bounded by its grace', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(),
        log = vi.fn();
    const shutdown = createShutdown({
        inProgress: () => 1,
        drainMs: 320_000,
        force: () => new Promise(() => {}),
        forceGraceMs: 1000,
        stopRunner: () => {},
        stopPlatform: async () => {},
        closeServer: async () => {},
        exit,
        report: vi.fn(),
        log,
    });
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenLastCalledWith('Shutdown: drain deadline passed; interrupting 1 still in progress.');
});
