import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { DRAINING_MESSAGE } from '../src/server/runtime/contract.js';
import { refusedWhileDraining } from '../src/server/runtime/shutdown.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-37: on SIGTERM the platform drains instead of interrupting turns.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Streams the start of an answer and finishes when `release` is called. */
class GatedAgent extends AbstractAgent {
    release?: () => void;
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const id = `answer-${input.runId}`;
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: id,
                role: 'assistant',
            } as BaseEvent);
            this.release = () => {
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: id,
                    delta: 'Finished after the signal.',
                } as BaseEvent);
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: id,
                } as BaseEvent);
                subscriber.next({
                    type: EventType.RUN_FINISHED,
                    threadId: input.threadId,
                    runId: input.runId,
                } as BaseEvent);
                subscriber.complete();
            };
        });
    }
}

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Titles ask the model after a turn; it is never reached.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
        },
        runner,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    return { platform, workspace, runner, dot, app };
}

const input = (threadId: string, runId: string) => ({
    threadId,
    runId,
    messages: [{ id: `user-${runId}`, role: 'user' as const, content: 'Hi' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
});

it('refuses new web turns with 503 and Retry-After while draining; connect and stop still work', async () => {
    const f = await fixture();
    const thread = await f.platform.createConversation(f.dot.id, 'Chat', 'owner');
    const post = (path: string, body: unknown) =>
        f.platform.handle(
            new Request(`http://localhost/api/copilotkit/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
            'owner',
        );
    // Files on the local disk here (no S3 configured, CB-54), and no data
    // key (CB-62), so the seeded credentials are legacy-sealed (CB-322).
    expect(await f.platform.health()).toEqual({
        ok: true,
        model: true,
        storage: 'local',
        dataKey: 'not_set',
        legacySealed: 2,
        datasetFiles: { missing: 0 },
    });
    f.platform.drain();
    expect(await f.platform.health()).toEqual({
        ok: true,
        model: true,
        storage: 'local',
        dataKey: 'not_set',
        legacySealed: 2,
        draining: true,
        datasetFiles: { missing: 0 },
    });
    const refused = await post(`agent/${f.dot.id}/run`, input(thread.id, 'refused'));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toEqual({
        error: DRAINING_MESSAGE,
        code: 'draining',
    });
    expect(f.runner.hasHistory(thread.id)).toBe(false);
    // Reconnecting to a conversation (and stopping a run) is not a new turn.
    const connect = await post(`agent/${f.dot.id}/connect`, input(thread.id, 'connect'));
    expect(connect.status).toBe(200);
    await connect.text();
    expect((await post(`agent/${f.dot.id}/stop/${thread.id}`, {})).status).not.toBe(503);
});

it('lets a turn in progress finish while draining and counts it until then', async () => {
    const f = await fixture();
    const thread = await f.platform.createConversation(f.dot.id, 'Chat', 'owner');
    const agent = new GatedAgent({});
    const events = lastValueFrom(
        f.runner.run({ threadId: thread.id, agent, input: input(thread.id, 'r1') }).pipe(toArray()),
    );
    await vi.waitFor(() => expect(agent.release).toBeTypeOf('function'));
    f.platform.drain();
    expect(f.platform.inProgress()).toBe(1);
    agent.release!();
    expect((await events).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(f.platform.inProgress()).toBe(0);
    expect(f.runner.recentRuns()).toEqual([expect.objectContaining({ runId: 'r1', status: 'finished' })]);
    const messages = await f.runner.messages(thread.id);
    expect(messages.at(-1)?.content).toBe('Finished after the signal.');
    // Its title is asked for while the model is still mocked.
    await f.platform.titles.idle();
});

it('names the new long-running work a draining server refuses (CB-108)', () => {
    for (const path of [
        '/api/copilotkit/agent/research/run',
        '/api/voice/calls',
        '/api/learning/containers/research/analyze',
    ]) {
        expect(refusedWhileDraining('POST', path), path).toBe(true);
        expect(refusedWhileDraining('GET', path), path).toBe(false);
    }
    for (const path of [
        '/api/copilotkit/agent/research/connect',
        '/api/copilotkit/agent/research/stop/thread-1',
        '/api/copilotkit/agent/research/run/extra',
        '/api/voice/calls/call-1/end',
        '/api/voice/calls/call-1/compute',
        '/api/learning/containers/research/cancel',
        '/api/conversations/thread-1',
        '/api/state',
    ]) {
        expect(refusedWhileDraining('POST', path), path).toBe(false);
    }
});

it('keeps serving the app while draining: only new turns and long work get 503 draining (CB-108)', async () => {
    const f = await fixture();
    const { app } = f;
    for (const user of DEFAULT_MOCK_USERS) {
        f.workspace.recordUser(user);
    }
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const call = (path: string, method = 'GET', body?: unknown) =>
        app.request(`/api${path}`, {
            method,
            headers: {
                cookie,
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const thread = await f.platform.createConversation(f.dot.id, 'Chat', 'alice');
    f.platform.drain();
    for (const [path, body] of [
        [`/copilotkit/agent/${f.dot.id}/run`, input(thread.id, 'refused')],
        ['/voice/calls', { threadId: thread.id, sdp: 'v=0' }],
        ['/learning/containers/research/analyze', {}],
    ] as const) {
        const refused = await call(path, 'POST', body);
        expect(refused.status, path).toBe(503);
        expect(refused.headers.get('retry-after'), path).toBe('60');
        expect(await refused.json(), path).toEqual({
            error: DRAINING_MESSAGE,
            code: 'draining',
        });
    }
    expect(f.runner.hasHistory(thread.id)).toBe(false);
    // The UI, reads, polls and writes carry on.
    for (const path of ['/state', '/workspace', `/conversations/${thread.id}/transcript`]) {
        const read = await call(path);
        expect(read.status, path).toBe(200);
        await read.text();
    }
    const renamed = await call(`/conversations/${thread.id}`, 'PATCH', {
        title: 'Renamed while draining',
    });
    expect(renamed.status).toBe(200);
    expect(f.workspace.thread(thread.id)?.title).toBe('Renamed while draining');
    const connect = await call(`/copilotkit/agent/${f.dot.id}/connect`, 'POST', input(thread.id, 'connect'));
    expect(connect.status).toBe(200);
    await connect.text();
});
