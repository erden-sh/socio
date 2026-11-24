import type { RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LOOP_END_EVENT } from '@socio/shared/loop-end';
import type { TraceRetry } from '@socio/shared/runs/run-trace';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { steeringQueue } from '../src/server/context/steering.js';
import { CHATGPT_KIND, chatGptKind } from '../src/server/inference/chatgpt-kind.js';
import { retryAfterMs } from '../src/server/inference/chatgpt/errors.js';
import { resetRefreshState } from '../src/server/inference/chatgpt/refresh.js';
import { TelegramChannel } from '../src/server/telegram/telegram-channel.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../src/server/turns/contract.js';
import {
    RetryBudget,
    busyReason,
    fallbackNote,
    busyModel,
    retriedRequests,
    retryWait,
    statusReply,
} from '../src/server/turns/model-busy.js';

import { startFakeChatGpt, textReply, toolCallReply, type ResponsesReply } from './fixtures/fake-chatgpt.js';
import { fakeTelegram } from './fixtures/fake-telegram.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { takeEgressAttempts } from './setup/egress-guard.js';

/**
 * A busy model in a Dot turn (CB-140): retried within the turn, then the
 * shared model for the rest of it where allowed, else a status of what was
 * done instead of a bare error. On the fake ChatGPT backend and a stubbed
 * shared model; nothing leaves the machine.
 */

// The ChatGPT kind gets the real fetch: tests stub the global one for the
// shared backend only.
const realFetch = globalThis.fetch.bind(globalThis);
const SHARED_URL = 'https://model.invalid/v1';
const SHARED_LABEL = 'Self-hosted (custom-model)';
// The fake plan's label.
const CHATGPT = 'ChatGPT (Plus)';
const CONFIG: PlatformConfig = {
    baseUrl: SHARED_URL,
    apiKey: 'local-key',
    model: 'custom-model',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: 'model-busy-secret-0123456789abcdef',
    // Short backoffs, so the tests run in milliseconds.
    modelRetry: { baseMs: 5 },
};
const RATE_LIMITED: ResponsesReply = {
    status: 429,
    body: { error: { code: 'rate_limit_exceeded', message: 'Slow down.' } },
};

type Fake = Awaited<ReturnType<typeof startFakeChatGpt>>;
let fake: Fake;
const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
    resetRefreshState();
    fake = await startFakeChatGpt();
});
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    await fake.close();
    expect(takeEgressAttempts()).toEqual([]);
});

/** Bob, connected to the fake ChatGPT plan, and his turns on it. */
async function fixture(config: PlatformConfig = CONFIG) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, workspace, platform, dispose } = await makeTestRuntime({ config });
    cleanup.push(dispose);
    let clock = Date.now();
    platform.inference.register(
        chatGptKind({
            endpoints: fake.endpoints,
            fetch: realFetch,
            now: () => clock,
        }),
    );
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => runner.close());
    await platform.inference.updateSettings({ allowedByoKinds: [CHATGPT_KIND] });
    await platform.inference.connect('bob', CHATGPT_KIND, {});
    fake.state.device = 'approved';
    clock += 1000;
    expect(await platform.inference.connect('bob', CHATGPT_KIND, {})).toEqual({
        state: 'connected',
    });
    const dot = workspace.dots()[0];
    workspace.bindThread('t-bob', dot.id, 'Hi', 'bob');
    // The shared model's requests, answered in order.
    const shared: Array<() => Response> = [];
    const sharedBodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (!String(url).startsWith(SHARED_URL)) {
            return realFetch(url, init);
        }
        sharedBodies.push(String(init?.body ?? ''));
        const next = shared.shift();
        return next ? next() : new Response('{"error":{"message":"no reply"}}', { status: 500 });
    });
    let runs = 0;
    /** One web turn as bob, with the module tools; its events and trace. */
    const turn = async (text = 'Look through my Spaces.') => {
        const runId = `run-${(runs += 1)}`;
        const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
            inference: platform.inference,
            extensions: platform.dotExtensions,
        });
        const input: RunAgentInput = {
            threadId: 't-bob',
            runId,
            state: {},
            context: [],
            messages: [{ id: `u-${runId}`, role: 'user', content: text }],
            tools: [],
            forwardedProps: {},
        };
        agent.threadId = 't-bob';
        agent.setMessages(input.messages);
        const startedAt = Date.now();
        const events = await lastValueFrom(runner.run({ threadId: 't-bob', agent, input }).pipe(toArray()));
        return {
            events,
            ms: Date.now() - startedAt,
            trace: runner.runTrace(runId)!.trace!,
            text: events
                .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
                .map((event) => (event as unknown as { delta: string }).delta)
                .join(''),
            loopEnd: (
                events.find((event) => (event as { name?: string }).name === LOOP_END_EVENT) as
                    | { value?: unknown }
                    | undefined
            )?.value,
        };
    };
    return {
        store,
        workspace,
        platform,
        runner,
        config,
        shared,
        sharedBodies,
        turn,
    };
}

const responsesRequests = () => fake.requests.filter((r) => r.path === '/backend-api/codex/responses');
const types = (events: { type: string }[]) => events.map((e) => e.type);
/** The shared model calls a tool, then answers. */
const sharedToolCall = (name: string) => () =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id: 'shared_call',
                    type: 'function',
                    function: { name, arguments: '{}' },
                },
            ],
        },
        'tool_calls',
    );
const sharedText = (content: string) => () => completion({ role: 'assistant', content });

it('sends a rate-limited request again within the round, and traces the wait', async () => {
    const f = await fixture();
    fake.state.replies.push(RATE_LIMITED, textReply('Here you go.'));
    const { events, trace, text, loopEnd } = await f.turn();
    expect(types(events)).not.toContain('RUN_ERROR');
    expect(text).toBe('Here you go.');
    expect(responsesRequests()).toHaveLength(2);
    // One round of the loop: the retry is a request of the same round.
    expect(loopEnd).toEqual({ reason: 'completed', rounds: 1, cap: 30 });
    expect(trace.rounds).toEqual([
        expect.objectContaining({
            round: 1,
            stop: 'error',
            error: 'chatgpt_rate_limited',
        }),
        expect.objectContaining({
            round: 1,
            retry: 1,
            cause: 'rate_limited',
            stop: 'stop',
        }),
    ]);
    expect(trace.totals?.rounds).toBe(1);
    expect(trace.retries).toEqual([
        expect.objectContaining({
            round: 1,
            reason: 'rate_limited',
            attempt: 1,
            error: 'chatgpt_rate_limited',
            waitMs: expect.any(Number),
        }),
    ]);
    expect(trace.fallback).toBeUndefined();
    expect(f.sharedBodies).toEqual([]);
});

it('delivers a steering message once when its round falls back to the shared model', async () => {
    const f = await fixture();
    // Waiting when the turn starts: it goes after round 1's call (CB-151).
    const queued = await steeringQueue(f.workspace.db).add('t-bob', 'bob', 'Only the team Space, please.');
    fake.state.replies.push(
        toolCallReply('list_authorized_spaces', {}),
        RATE_LIMITED,
        RATE_LIMITED,
        RATE_LIMITED,
        RATE_LIMITED,
    );
    f.shared.push(sharedText('Just the team Space, then.'));
    const { events, text } = await f.turn();
    expect(types(events)).not.toContain('RUN_ERROR');
    expect(text).toContain('Just the team Space, then.');
    // Round 1 never had it; each try of round 2 had it once, ChatGPT's and
    // the shared model's.
    const tries = responsesRequests().map((request) => request.body);
    expect(tries).toHaveLength(5);
    expect(tries[0]).not.toContain('Only the team Space');
    for (const body of [...tries.slice(1), ...f.sharedBodies]) {
        expect(body.split('Only the team Space, please.').length - 1).toBe(1);
    }
    expect(f.sharedBodies).toHaveLength(1);
    // Taken and shown once.
    expect(
        events.filter((event) => event.type === 'TEXT_MESSAGE_START' && (event as { role?: string }).role === 'user'),
    ).toEqual([expect.objectContaining({ messageId: queued.id })]);
    expect(await steeringQueue(f.workspace.db).list('t-bob', 'bob')).toEqual([]);
});

it('waits as long as Retry-After asks before sending again', async () => {
    const f = await fixture();
    // The wait is the hint and a jitter of up to 200 ms on 1 s, rounded up:
    // the jitter is pinned at its top, where a draw past 0.995 had made it
    // 1200, not under it as this once said (CI, now and then).
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    fake.state.replies.push({ ...RATE_LIMITED, headers: { 'Retry-After': '1' } }, textReply('After the wait.'));
    const { text, trace } = await f.turn();
    expect(text).toBe('After the wait.');
    const [first, second] = responsesRequests();
    expect(second.at - first.at).toBeGreaterThanOrEqual(1000);
    const [retry] = trace.retries as TraceRetry[];
    expect(retry.waitMs).toBe(1200);
});

it('waits at least the hint and at most 200 ms more for a 1 s Retry-After', () => {
    const failure = { type: 'RUN_ERROR', code: 'chatgpt_rate_limited', rawEvent: { retryAfterMs: 1000 } };
    expect(retryWait(failure, 1, DEFAULT_RETRY_POLICY, () => 0)).toBe(1000);
    expect(retryWait(failure, 1, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1100);
    expect(retryWait(failure, 1, DEFAULT_RETRY_POLICY, () => 0.9999)).toBe(1200);
});

it('carries on with the shared model when the person’s plan stays rate limited, and says so once', async () => {
    const f = await fixture();
    // Round 1 works on ChatGPT; round 2 is rate limited every time.
    fake.state.replies.push(
        toolCallReply('list_authorized_spaces', {}),
        RATE_LIMITED,
        RATE_LIMITED,
        RATE_LIMITED,
        RATE_LIMITED,
    );
    f.shared.push(sharedToolCall('list_authorized_spaces'), sharedText('You have one Space.'));
    const { events, trace, text, loopEnd } = await f.turn();
    expect(types(events)).not.toContain('RUN_ERROR');
    // Four tries on ChatGPT (the first and three retries), then the shared model.
    expect(responsesRequests()).toHaveLength(5);
    expect(f.sharedBodies).toHaveLength(2);
    // The shared model gets the turn so far: the tool call ChatGPT made.
    expect(f.sharedBodies[0]).toContain('list_authorized_spaces');
    const note = fallbackNote(CHATGPT, SHARED_LABEL, 'rate_limited');
    expect(text).toBe(`${note}You have one Space.`);
    expect(text.split('shared model').length - 1).toBe(1);
    expect(loopEnd).toEqual({
        reason: 'completed',
        rounds: 3,
        cap: 30,
        fallback: { from: CHATGPT, to: SHARED_LABEL },
    });
    expect(trace.end?.fallback).toEqual({ from: CHATGPT, to: SHARED_LABEL });
    expect(trace.fallback).toEqual(
        expect.objectContaining({
            round: 2,
            from: CHATGPT,
            to: SHARED_LABEL,
            reason: 'rate_limited',
        }),
    );
    expect(trace.retries?.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
    // Round 2 went again on the shared model; the retries count no rounds.
    expect(trace.rounds.filter((round) => round.cause === 'fallback')).toEqual([
        expect.objectContaining({ round: 2, retry: 1 }),
    ]);
    expect(trace.totals?.rounds).toBe(3);
    // The phase line names the model it moved to.
    expect(events.filter((event) => (event as { name?: string }).name === 'socio.run-model')).toContainEqual(
        expect.objectContaining({ value: { label: SHARED_LABEL, model: null } }),
    );
});

it('never falls back when an admin turned it off, or the person chose their plan for the conversation: it ends with a status', async () => {
    const f = await fixture();
    const busyTurn = async () => {
        fake.state.replies.push(
            toolCallReply('list_authorized_spaces', {}),
            ...Array.from({ length: 4 }, () => RATE_LIMITED),
        );
        return f.turn();
    };
    const expectStatus = (result: Awaited<ReturnType<typeof busyTurn>>) => {
        expect(types(result.events)).not.toContain('RUN_ERROR');
        expect(result.events.at(-1)?.type).toBe('RUN_FINISHED');
        expect(result.text).toBe(
            statusReply(CHATGPT, 'rate_limited', [{ name: 'list_authorized_spaces', failed: false }]),
        );
        expect(result.text).toContain('`list_authorized_spaces`');
        expect(result.loopEnd).toEqual({
            reason: 'model_unavailable',
            rounds: 2,
            cap: 30,
        });
        expect(result.trace.end?.reason).toBe('model_unavailable');
        expect(result.trace.fallback).toBeUndefined();
        expect(f.sharedBodies).toEqual([]);
    };

    // The admin's switch (Settings → General).
    await f.store.updateSettings({ modelFallback: false });
    expectStatus(await busyTurn());

    // On again, but bob picked his plan for this conversation.
    await f.store.updateSettings({ modelFallback: true });
    f.workspace.setThreadInference('t-bob', {
        source: 'byo',
        kind: CHATGPT_KIND,
    });
    expectStatus(await busyTurn());
});

it('ends a full outage with a status listing the tools that ran, resumable by the next message', async () => {
    const f = await fixture();
    const outage: ResponsesReply = {
        status: 503,
        body: { error: { message: 'Service unavailable' } },
    };
    fake.state.replies.push(toolCallReply('list_authorized_spaces', {}), ...Array.from({ length: 4 }, () => outage));
    // The shared model is down too. Its client doesn't retry on its own (the
    // turn does), so each request is one of the turn's attempts.
    const down = () =>
        new Response('{"error":{"message":"overloaded"}}', {
            status: 503,
            headers: { 'retry-after-ms': '1' },
        });
    f.shared.push(...Array.from({ length: 4 }, () => down));
    const { events, trace, text, loopEnd } = await f.turn();
    expect(types(events)).not.toContain('RUN_ERROR');
    expect(text).toBe(statusReply(SHARED_LABEL, 'unavailable', [{ name: 'list_authorized_spaces', failed: false }]));
    expect(text).toContain('**Done so far:** `list_authorized_spaces`.');
    expect(text).toContain('carry on');
    expect(loopEnd).toMatchObject({
        reason: 'model_unavailable',
        rounds: 2,
        fallback: { from: CHATGPT, to: SHARED_LABEL },
    });
    expect(trace.retries?.map((retry) => [retry.reason, retry.error, retry.attempt])).toEqual([
        ['unavailable', 'chatgpt_unavailable', 1],
        ['unavailable', 'chatgpt_unavailable', 2],
        ['unavailable', 'chatgpt_unavailable', 3],
        ['unavailable', 'http_503', 1],
        ['unavailable', 'http_503', 2],
        ['unavailable', 'http_503', 3],
    ]);
    // 4 attempts, not 8: no hidden retries of the client.
    expect(f.sharedBodies).toHaveLength(4);

    // The next message carries on: the status and the tool call are history.
    fake.state.replies.push(textReply('Carrying on.'));
    const next = await f.turn('Carry on.');
    expect(next.text).toBe('Carrying on.');
    const input = JSON.parse(responsesRequests().at(-1)!.body) as {
        input: { type?: string; name?: string }[];
    };
    expect(input.input.some((item) => item.type === 'function_call' && item.name === 'list_authorized_spaces')).toBe(
        true,
    );
});

it('says the switch to the shared model, and ends an outage with its status, in Telegram as in the app (CB-145)', async () => {
    const f = await fixture();
    const bot = await fakeTelegram();
    const channel = new TelegramChannel({
        settings: {
            token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012',
            allowedChatIds: [],
        },
        runner: f.runner,
        store: f.store,
        workspace: f.workspace,
        ...telegramServices({
            store: f.store,
            workspace: f.workspace,
            config: f.config,
            runner: f.runner,
            inference: f.platform.inference,
            extensions: f.platform.dotExtensions,
        }),
        isUser: (id) => id === 'bob',
        apiRoot: bot.apiRoot,
    });
    cleanup.push(
        () => bot.close(),
        () => channel.stop(),
    );
    await channel.start();
    await f.workspace.telegram.redeem((await f.workspace.telegram.createCode('bob')).code, '43');
    const shown = (text: string) =>
        bot.waitFor(
            (c) => ['sendMessage', 'editMessageText'].includes(c.method) && String(c.body.text).includes(text),
            10_000,
        );
    fake.state.replies.push(RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED);
    f.shared.push(sharedText('You have one Space.'));
    bot.message({
        text: 'Look through my Spaces.',
        chat: { id: 43, type: 'private' },
        from: { id: 43 },
    });
    const answer = await shown('You have one Space.');
    expect(String(answer.body.text)).toContain(
        `${CHATGPT} is busy right now, so I carried on with the shared model (${SHARED_LABEL})`,
    );

    // A full outage after a tool ran: its status, not a bare error.
    const outage: ResponsesReply = {
        status: 503,
        body: { error: { message: 'Service unavailable' } },
    };
    fake.state.replies.push(toolCallReply('list_authorized_spaces', {}), ...Array.from({ length: 4 }, () => outage));
    f.shared.push(
        ...Array.from(
            { length: 4 },
            () => () =>
                new Response('{"error":{"message":"overloaded"}}', {
                    status: 503,
                    headers: { 'retry-after-ms': '1' },
                }),
        ),
    );
    bot.message({
        text: 'Look again.',
        chat: { id: 43, type: 'private' },
        from: { id: 43 },
    });
    const status = await shown('list_authorized_spaces');
    expect(String(status.body.text)).toContain('Done so far:');
});

it('keeps the error when nothing was done yet, so the person sees why', async () => {
    const f = await fixture();
    await f.store.updateSettings({ modelFallback: false });
    fake.state.replies.push(...Array.from({ length: 4 }, () => RATE_LIMITED));
    const { events, loopEnd } = await f.turn();
    expect(events.find((event) => event.type === 'RUN_ERROR')).toMatchObject({
        code: 'chatgpt_rate_limited',
    });
    expect(loopEnd).toMatchObject({ reason: 'error', rounds: 1 });
    expect(responsesRequests()).toHaveLength(4);
});

it('never retries a request that streamed output before it failed', async () => {
    const f = await fixture();
    const partial = textReply('Half an answer');
    // The answer starts, then the backend fails it as rate limited.
    const events = partial.events.slice(0, 5);
    fake.state.replies.push(
        {
            events: [
                ...events,
                {
                    type: 'response.failed',
                    response: { error: { code: 'rate_limit_exceeded' } },
                },
            ],
        },
        textReply('Should not be asked for.'),
    );
    const { trace, text, loopEnd } = await f.turn();
    expect(responsesRequests()).toHaveLength(1);
    expect(f.sharedBodies).toEqual([]);
    expect(trace.retries).toBeUndefined();
    expect(trace.fallback).toBeUndefined();
    // What was said stays, once, and the status follows it.
    expect(text.startsWith('Half an')).toBe(true);
    expect(text).not.toContain('Should not');
    expect(text).toContain(statusReply(CHATGPT, 'rate_limited', []));
    expect(loopEnd).toMatchObject({ reason: 'model_unavailable', rounds: 1 });
});

it('waits no longer than the turn time limit allows, leaving room for the end', async () => {
    // A 3 s turn keeps 600 ms free at its end: a 3 s Retry-After is not waited.
    const f = await fixture({ ...CONFIG, turnTimeLimitSeconds: 3 });
    await f.store.updateSettings({ modelFallback: false });
    fake.state.replies.push(toolCallReply('list_authorized_spaces', {}), {
        ...RATE_LIMITED,
        headers: { 'Retry-After': '3' },
    });
    const { ms, trace, loopEnd } = await f.turn();
    expect(ms).toBeLessThan(2_000);
    expect(trace.retries).toBeUndefined();
    expect(loopEnd).toMatchObject({ reason: 'model_unavailable' });
});

it('bounds a turn’s waits by its deadline, its reserve and the policy, across requests', async () => {
    let now = 0;
    const policy: RetryPolicy = {
        attempts: 10,
        baseMs: 100,
        maxWaitMs: 1_000,
        maxTotalWaitMs: 60_000,
    };
    // A 10 s turn: a fifth (2 s) is kept free, so waits must end by 8 s.
    const budget = new RetryBudget(10_000, 10_000, policy, () => now);
    expect(budget.take(5_000)).toBe(true);
    now = 5_000;
    expect(budget.take(3_500)).toBe(false);
    expect(budget.take(3_000)).toBe(true);
    expect(budget.waited).toBe(8_000);
    // The policy's total, whatever the deadline.
    const capped = new RetryBudget(Date.now() + 1e9, 1e9, {
        ...policy,
        maxTotalWaitMs: 1_000,
    });
    expect(capped.take(800)).toBe(true);
    expect(capped.take(300)).toBe(false);

    // Real requests: always rate limited, with a 60 ms hint each time, in a
    // 400 ms turn whose last 80 ms are kept free.
    const started = Date.now();
    const calls: number[] = [];
    const retries: unknown[] = [];
    const model = {
        chatStream: async function* () {
            calls.push(Date.now() - started);
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield {
                type: 'RUN_ERROR',
                code: 'chatgpt_rate_limited',
                message: 'busy',
                rawEvent: { code: 'chatgpt_rate_limited', retryAfterMs: 60 },
            };
        },
    } as unknown as AnyTextAdapter;
    const adapter = retriedRequests(model, {
        budget: new RetryBudget(started + 400, 400, policy),
        policy,
        trace: { retry: (entry) => retries.push(entry), again: () => {} },
        log: () => {},
        random: () => 0,
    });
    const chunks = [];
    for await (const chunk of adapter.chatStream({} as never)) {
        chunks.push(chunk.type);
    }
    const waited = Date.now() - started;
    // The failure as it came, once the budget ran out.
    expect(chunks).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(retries.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(retries.length + 1);
    expect(waited).toBeLessThan(400);
    expect(retries.reduce((sum: number, entry) => sum + (entry as TraceRetry).waitMs, 0)).toBeLessThanOrEqual(320);
});

it('keeps the last fifth of the turn free at the default limit', () => {
    let now = 0;
    const limit = 300_000;
    const budget = new RetryBudget(limit, limit, DEFAULT_RETRY_POLICY, () => now);
    // Waits are capped at 60 s a turn, so move the clock instead: 240 s is
    // the last moment a wait may end.
    now = 215_000;
    expect(budget.take(25_001)).toBe(false);
    expect(budget.take(25_000)).toBe(true);
});

it('says a wait was cut short when Stop ends it, and sends nothing again', async () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseMs: 10_000 };
    const controller = new AbortController();
    const retries: TraceRetry[] = [];
    let calls = 0;
    const model = {
        chatStream: async function* () {
            calls += 1;
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield {
                type: 'RUN_ERROR',
                code: 'chatgpt_rate_limited',
                message: 'busy',
            };
        },
    } as unknown as AnyTextAdapter;
    const adapter = retriedRequests(model, {
        budget: new RetryBudget(Date.now() + 1e9, 1e9, policy),
        policy,
        trace: {
            retry: (entry) => retries.push(entry as TraceRetry),
            again: () => {},
        },
        log: () => {},
        random: () => 0,
    });
    setTimeout(() => controller.abort(), 30);
    const chunks = [];
    for await (const chunk of adapter.chatStream({
        request: { signal: controller.signal },
    } as never)) {
        chunks.push(chunk.type);
    }
    expect(chunks).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(calls).toBe(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ cutShort: true });
    expect(retries[0].waitMs).toBeLessThan(1_000);
});

it('applies the shared model’s image limit after a switch', async () => {
    const seen: unknown[] = [];
    const image = (id: string) => ({
        type: 'image',
        source: { type: 'url', value: id },
    });
    const busy = {
        chatStream: async function* () {
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'RUN_ERROR', code: '429', message: 'busy' };
        },
    } as unknown as AnyTextAdapter;
    const shared = {
        chatStream: async function* (request: { messages: unknown }) {
            seen.push(request.messages);
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
        },
    } as unknown as AnyTextAdapter;
    for (const maxImages of [0, 1]) {
        seen.length = 0;
        const adapter = busyModel(busy, {
            label: 'ChatGPT',
            fallback: async () => ({
                adapter: shared,
                label: 'Homelab',
                model: 'orion',
                modelOptions: {},
                maxImages,
            }),
        });
        const stream = adapter.chatStream({
            messages: [
                { role: 'user', content: [{ type: 'text', content: 'a' }, image('1')] },
                { role: 'user', content: [image('2'), image('3')] },
            ],
        } as never);
        for await (const chunk of stream) {
            void chunk;
        }
        const parts = (seen[0] as { content: { type: string }[] }[]).flatMap((message) =>
            message.content.map((part) => part.type),
        );
        // The most recent `maxImages` images stay; the rest are notes.
        expect(parts.filter((type) => type === 'image')).toHaveLength(maxImages);
        expect(parts).toHaveLength(4);
    }
});

it('reads why a model is busy and how long it asked to wait', () => {
    expect(busyReason({ code: 'chatgpt_rate_limited' })).toBe('rate_limited');
    expect(busyReason({ code: '429', message: '429 Too many' })).toBe('rate_limited');
    expect(busyReason({ code: 'chatgpt_usage_limit' })).toBe('usage_limit');
    expect(busyReason({ code: '503' })).toBe('unavailable');
    expect(busyReason({ code: 'chatgpt_unavailable' })).toBe('unavailable');
    expect(busyReason({ message: 'terminated' })).toBe('unavailable');
    expect(busyReason(new TypeError('fetch failed'))).toBe('unavailable');
    // Nothing a wait or another model mends.
    expect(busyReason({ code: 'chatgpt_context_too_long' })).toBeUndefined();
    expect(busyReason({ code: 'chatgpt_needs_relogin' })).toBeUndefined();
    expect(busyReason({ code: 'insufficient_quota', status: 429 })).toBeUndefined();
    expect(busyReason({ code: '400', message: 'bad request' })).toBeUndefined();

    const now = Date.UTC(2026, 9, 21, 12);
    expect(retryAfterMs(new Headers({ 'retry-after': '7' }), undefined, now)).toBe(7_000);
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250' }), undefined, now)).toBe(250);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(now + 4_000).toUTCString() }), undefined, now)).toBe(
        4_000,
    );
    expect(retryAfterMs(new Headers(), new Date(now + 2_500), now)).toBe(2_500);
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
});
