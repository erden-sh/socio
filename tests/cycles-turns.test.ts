import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import { defineTool } from '@copilotkit/runtime/v2';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import { senderMetadata } from '@socio/foundation/workspace/client-messages';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { steeringQueue } from '../src/server/context/steering.js';
import { turnLogLine } from '../src/server/turns/local-runner.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Work cycles in real turns (CB-211): the runner opens each run's cycle,
// the turn's model requests draw on its budget, and a limit ends the turn
// with a visible reason, never silently.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'member' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const SECRET = 'cycles-secret-0123456789abcdef';
const MODEL_URL = 'https://model.invalid/v1';
const realFetch = globalThis.fetch.bind(globalThis);

const fetchCall = (id: string) =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name: 'fetch_rows', arguments: '{"page":1}' },
                },
            ],
        },
        'tool_calls',
        { prompt_tokens: 9_000, completion_tokens: 500, total_tokens: 9_500 },
    );
const say = (content: string, usage?: Record<string, unknown>) =>
    completion({ role: 'assistant', content }, 'stop', usage);

async function fixture(config: Partial<PlatformConfig> = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {
        store,
        workspace,
        platform,
        app,
        config: full,
        dispose,
    } = await makeTestRuntime({
        config: {
            baseUrl: MODEL_URL,
            apiKey: 'unused',
            model: 'custom-model',
            sessionSecret: SECRET,
            modelRetry: { baseMs: 5 },
            ...config,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.dots()[0];
    const thread = workspace.bindThread('chat', dot.id, 'Chat', 'alice');
    const replies: Array<() => Response> = [];
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (!String(input).startsWith(MODEL_URL)) {
            return realFetch(input, init);
        }
        const body = String(init?.body ?? '');
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        requests += 1;
        return (replies.shift() ?? (() => say('Done.')))();
    });
    const fetchRows = defineTool({
        name: 'fetch_rows',
        description: 'Fetch a page of rows.',
        parameters: z.object({ page: z.number() }),
        execute: async () => '[{"id":1}]',
    });
    let runs = 0;
    /** A web turn in Alice's chat, as the runtime runs one; its events. */
    const turn = async (
        messages: Message[] = [
            {
                id: `u${runs + 1}`,
                role: 'user',
                content: 'Fetch rows.',
                metadata: senderMetadata({ id: 'alice', name: 'Alice' }),
            } as Message,
        ],
    ) => {
        const runId = `run-${(runs += 1)}`;
        const agent = new DotAgent(store, workspace, full, dot.id, false, undefined, {
            inference: platform.inference,
            extensions: { ...platform.dotExtensions, tools: () => [fetchRows] },
            signals: { trigger: { kind: 'person', id: 'alice' } },
        });
        agent.threadId = thread.id;
        agent.setMessages(messages);
        const events = await lastValueFrom(
            platform.runner
                .run({
                    threadId: thread.id,
                    agent,
                    input: {
                        threadId: thread.id,
                        runId,
                        messages,
                        state: {},
                        tools: [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
        );
        return { runId, events };
    };
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async (path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
                status: response.status,
                body: (await response.json().catch(() => null)) as Record<string, unknown>,
            };
        };
    };
    const cycleRows = () =>
        workspace.db
            .prepare(
                'SELECT id, status, endReason, tokensUsed, costUsd, costKnown, initiatorId, actingUserId, dispatchKey FROM work_cycles ORDER BY startedAt, rowid',
            )
            .all() as Array<Record<string, unknown>>;
    return {
        store,
        workspace,
        platform,
        dot,
        thread,
        replies,
        requests: () => requests,
        turn,
        as,
        cycleRows,
    };
}

const errorOf = (events: BaseEvent[]) =>
    events.find((event) => event.type === EventType.RUN_ERROR) as { message?: string; code?: string } | undefined;

it('stops a turn whose next model request its cycle cannot afford, and says why', async () => {
    const f = await fixture();
    await f.store.updateSettings({ limits: { roomCycleTokens: 10_000 } });
    f.replies.push(() => fetchCall('c1'));
    const { runId, events } = await f.turn();
    // The first round ran (9,500 tokens); the second was never sent.
    expect(f.requests()).toBe(1);
    expect(errorOf(events)).toMatchObject({
        code: 'cycle_tokens',
        message: TURN_FAILURE_MESSAGES.cycle_tokens,
    });
    const { trace, status } = f.platform.runner.runTrace(runId)!;
    expect(status).toBe('failed');
    expect(trace?.end?.reason).toBe('cycle_limit');
    expect(trace?.cycle).toMatchObject({
        kind: 'private',
        hop: 0,
        actingUserId: 'alice',
        dotId: f.dot.id,
        billing: 'workspace',
        tokens: 9_500,
        stop: 'tokens',
    });
    expect(f.cycleRows()).toEqual([
        expect.objectContaining({
            status: 'ended',
            endReason: 'tokens',
            tokensUsed: 9_500,
            initiatorId: 'alice',
            actingUserId: 'alice',
            dispatchKey: 'u1',
        }),
    ]);
    // The log line names the cycle and its initiator; the owner acts.
    const line = turnLogLine({
        status: 'failed',
        runId,
        threadId: f.thread.id,
        ownerId: 'alice',
        source: 'web',
        ms: 10,
        initiator: trace?.trigger,
        cycle: trace?.cycle,
    });
    expect(line).toContain(`cycle=${trace?.cycle?.id}`);
    expect(line).toContain('initiator=person:alice');
    expect(line).toContain('limit=tokens');
    expect(line).not.toContain('acting=');
});

it('finishes within its limits with spend unknown when the model reports no cost', async () => {
    const f = await fixture();
    // A spend cap applies only to known cost: it can't stop this one.
    await f.store.updateSettings({ limits: { roomCycleSpendUsd: 0.01 } });
    f.replies.push(() => say('All done.', { prompt_tokens: 1_000, completion_tokens: 20 }));
    const { runId, events } = await f.turn();
    expect(errorOf(events)).toBeUndefined();
    const { trace } = f.platform.runner.runTrace(runId)!;
    expect(trace?.end?.reason).toBe('completed');
    expect(trace?.cycle).toMatchObject({ tokens: 1_020 });
    expect(trace?.cycle).not.toHaveProperty('costUsd');
    expect(trace?.cycle).not.toHaveProperty('stop');
    expect(f.cycleRows()).toEqual([
        expect.objectContaining({
            status: 'ended',
            endReason: 'completed',
            costUsd: null,
            costKnown: 0,
        }),
    ]);
});

it('turns away a message past the chat’s rate before any model request', async () => {
    const f = await fixture();
    await f.store.updateSettings({ limits: { roomMessagesPerMinute: 2 } });
    expect((await f.turn()).events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(errorOf((await f.turn()).events)).toBeUndefined();
    const before = f.requests();
    const third = await f.turn();
    expect(errorOf(third.events)).toMatchObject({
        code: 'cycle_rate',
        message: TURN_FAILURE_MESSAGES.cycle_rate,
    });
    expect(f.requests()).toBe(before);
    // The message is kept, with why it did not run.
    expect((await f.platform.runner.messages(f.thread.id)).at(-1)?.id).toBe('u3');
    // The queue counts toward the same minute, and says so.
    const alice = await f.as('alice');
    const queued = await alice(`/api/conversations/${f.thread.id}/steering`, 'POST', { text: 'And this.' });
    expect(queued).toMatchObject({
        status: 429,
        body: { code: 'cycle_rate', error: TURN_FAILURE_MESSAGES.cycle_rate },
    });
});

it('dispatches queued messages per author, each a cycle of their own, only for who may send', async () => {
    const f = await fixture();
    const queue = steeringQueue(f.workspace.db);
    // Bob can't queue in Alice's chat; a row of his (from before, say) never
    // runs as him, nor as her.
    await queue.add(f.thread.id, 'bob', 'Mine.', 1);
    await queue.add(f.thread.id, 'alice', 'Hers.', 2);
    expect(await f.platform.steering.consider(f.thread.id)).toBe(true);
    await vi.waitFor(() => expect(f.platform.runner.activeRunId(f.thread.id)).toBeUndefined(), {
        timeout: 10_000,
        interval: 10,
    });
    expect(await queue.list(f.thread.id, 'alice')).toEqual([]);
    expect(await queue.list(f.thread.id, 'bob')).toHaveLength(1);
    expect(f.cycleRows()).toEqual([
        expect.objectContaining({
            initiatorId: 'alice',
            actingUserId: 'alice',
            endReason: 'completed',
        }),
    ]);
    // Nothing more starts while only Bob's wait.
    expect(await f.platform.steering.consider(f.thread.id)).toBe(false);
});

it('carries a waiting cycle on through a turn’s context, and refuses a context that breaks the rules', async () => {
    const f = await fixture();
    f.replies.push(() => say('Waiting.', { prompt_tokens: 100, completion_tokens: 10 }));
    const { runId } = await f.turn();
    const first = f.platform.runner.runTrace(runId)!.trace!.cycle!;
    // As if its step waited for an approval (CB-209 sends the context).
    f.workspace.db.prepare("UPDATE work_cycles SET status='waiting', endReason=NULL WHERE id=?").run(first.id);
    const stored = (await f.platform.cycles.cycle(first.id))!;
    const context = f.platform.cycles.context(stored);
    const outcome = await f.platform.turnOutcome(f.thread.id, 'Carry on.', new AbortController().signal, { context });
    const next = f.platform.runner.runTrace(outcome.runId)!.trace!;
    expect(next.cycle?.id).toBe(first.id);
    expect(next.trigger).toEqual({ kind: 'person', id: 'alice' });
    expect(await f.platform.cycles.cycle(first.id)).toMatchObject({
        steps: 2,
        status: 'ended',
    });
    await expect(
        f.platform.turnOutcome(f.thread.id, 'Again.', new AbortController().signal, {
            context: { ...context, billing: { kind: 'person', userId: 'bob' } },
        }),
    ).rejects.toThrow('billed to someone other than the acting person');
    await expect(
        f.platform.turnOutcome(f.thread.id, 'Again.', new AbortController().signal, {
            context: { ...context, conversationId: 'other' },
        }),
    ).rejects.toThrow('another conversation');
    // An ended cycle takes no more work: the step is refused, visibly.
    await expect(
        f.platform.turnOutcome(f.thread.id, 'Again.', new AbortController().signal, {
            context,
        }),
    ).rejects.toThrow(TURN_FAILURE_MESSAGES.cycle_ended);
});

it('answers a chat message past the rate with 429 and its text kept, before storing it', async () => {
    const f = await fixture();
    await f.store.updateSettings({ limits: { roomMessagesPerMinute: 1 } });
    const post = async (id: string, runId: string) => {
        const response = await f.platform.handle(
            new Request(`http://localhost/api/copilotkit/agent/${f.dot.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    threadId: f.thread.id,
                    runId,
                    messages: [{ id, role: 'user', content: 'Hello.' }],
                    tools: [],
                    context: [],
                    state: {},
                    forwardedProps: {},
                }),
            }),
            'alice',
        );
        return { status: response.status, text: await response.text() };
    };
    const first = await post('w1', 'web-1');
    expect(first.status).toBe(200);
    await vi.waitFor(() => expect(f.platform.runner.activeRunId(f.thread.id)).toBeUndefined(), {
        timeout: 10_000,
        interval: 10,
    });
    expect(f.requests()).toBe(1);
    // The person who sent it started its cycle, counted for the minute.
    expect(f.cycleRows()).toEqual([expect.objectContaining({ initiatorId: 'alice', dispatchKey: 'w1' })]);
    const second = await post('w2', 'web-2');
    expect(second.status).toBe(429);
    expect(JSON.parse(second.text)).toEqual({
        error: TURN_FAILURE_MESSAGES.cycle_rate,
        code: 'cycle_rate',
    });
    expect(f.requests()).toBe(1);
    expect((await f.platform.runner.messages(f.thread.id)).map((m) => m.id)).not.toContain('w2');
});
