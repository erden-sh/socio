import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { chat } from '@tanstack/ai';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { toolError } from '@socio/foundation/http/tool-error';
import { modelDebug } from '@socio/foundation/observability/failures';
import {
    RUN_TRACE_EVENT,
    traceTotals,
    turnReasoningKind,
    type TraceEntry,
    type TraceRound,
} from '@socio/shared/runs/run-trace';

import { chatGptAdapter } from '../src/server/inference/chatgpt/index.js';
import { openAICompatibleModel } from '../src/server/inference/openai-compatible.js';
import type { TurnSignals } from '../src/server/turns/contract.js';
import {
    TRACE_MAX_MESSAGES,
    TraceRecorder,
    TurnTracer,
    reasoningKindOf,
    resultOutcome,
} from '../src/server/turns/turn-trace.js';

import { startFakeChatGpt, textReply } from './fixtures/fake-chatgpt.js';
import { completionStream } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

/*
 * CB-185: the turn signals the Operations dashboard needs, captured where
 * they happen: when a turn's request came, who started it, who wrote each
 * message it added, what each round showed of the model's reasoning, codes
 * on the tool errors that had none, and when a scheduled run came due.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Starts, answers once as a socio, and finishes; optionally with signals of its own. */
class AnsweringAgent extends AbstractAgent {
    constructor(
        agentId: string | undefined,
        private entries: unknown[] = [],
        readonly turnSignals?: TurnSignals,
    ) {
        super(agentId ? { agentId } : {});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            for (const value of this.entries) {
                subscriber.next({
                    type: EventType.CUSTOM,
                    name: RUN_TRACE_EVENT,
                    value,
                } as BaseEvent);
            }
            for (const id of [`a-${input.runId}`, `b-${input.runId}`]) {
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: id,
                    role: 'assistant',
                } as BaseEvent);
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: id,
                    delta: 'Done.',
                } as BaseEvent);
                subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    messageId: id,
                } as BaseEvent);
            }
            subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            subscriber.complete();
        });
    }
}

function runnerFixture() {
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => runner.close());
    const run = (runId: string, agent: AbstractAgent, messages: RunAgentInput['messages'], signals?: TurnSignals) =>
        lastValueFrom(
            runner
                .run({
                    threadId: 'thread',
                    agent,
                    ...(signals ? { signals } : {}),
                    input: {
                        threadId: 'thread',
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
    return { runner, run };
}

it('keeps when a turn came, who started it and who wrote each message it added', async () => {
    const f = runnerFixture();
    const before = Date.now();
    await f.run('run-1', new AnsweringAgent('socio-1'), [{ id: 'u1', role: 'user', content: 'Hello.' }], {
        receivedAt: before - 1500,
        trigger: { kind: 'person', id: 'alice' },
    });
    const first = f.runner.runTrace('run-1')!;
    const trace = first.trace!;
    expect(trace.receivedAt).toBe(before - 1500);
    // The queue time: from the request to the run's start.
    expect(first.startedAt - trace.receivedAt!).toBeGreaterThanOrEqual(1500);
    expect(trace.trigger).toEqual({ kind: 'person', id: 'alice' });
    expect(trace.messages).toEqual([
        { id: 'u1', author: { kind: 'person', id: 'alice' }, at: before - 1500 },
        {
            id: 'a-run-1',
            author: { kind: 'socio', id: 'socio-1' },
            at: expect.any(Number),
        },
        {
            id: 'b-run-1',
            author: { kind: 'socio', id: 'socio-1' },
            at: expect.any(Number),
        },
    ]);

    // Another person and another socio in the same chat; the history the
    // input repeats is not the turn's.
    await f.run(
        'run-2',
        new AnsweringAgent('socio-2'),
        [
            { id: 'u1', role: 'user', content: 'Hello.' },
            { id: 'u2', role: 'user', content: 'Me too.' },
        ],
        { receivedAt: Date.now(), trigger: { kind: 'person', id: 'bob' } },
    );
    const second = f.runner.runTrace('run-2')!.trace!;
    expect(second.messages!.map((message) => [message.id, message.author])).toEqual([
        ['u2', { kind: 'person', id: 'bob' }],
        ['a-run-2', { kind: 'socio', id: 'socio-2' }],
        ['b-run-2', { kind: 'socio', id: 'socio-2' }],
    ]);
});

it('takes a browser turn’s signals from its agent, and never a received time after the start', async () => {
    const f = runnerFixture();
    await f.run(
        'run-1',
        new AnsweringAgent('socio-1', [], {
            receivedAt: Date.now() + 60_000,
            trigger: { kind: 'person', id: 'alice' },
        }),
        [{ id: 'u1', role: 'user', content: 'Hello.' }],
    );
    const { startedAt, trace } = f.runner.runTrace('run-1')!;
    expect(trace!.receivedAt).toBe(startedAt);
    expect(trace!.trigger).toEqual({ kind: 'person', id: 'alice' });
});

it('records no signals the server didn’t give, and a turn’s own trace entries can’t set them', async () => {
    const f = runnerFixture();
    await f.run(
        'run-1',
        new AnsweringAgent(undefined, [
            { kind: 'trigger', trigger: { kind: 'person', id: 'mallory' } },
            { kind: 'turn', label: 'm', model: 'm', source: 'shared', cap: 3 },
        ]),
        [{ id: 'u1', role: 'user', content: 'Hello.' }],
    );
    const trace = f.runner.runTrace('run-1')!.trace!;
    expect(trace.receivedAt).toBeUndefined();
    expect(trace.trigger).toBeUndefined();
    // No trigger: the person's message has no author yet (the analytics
    // credit the chat's owner); the socio's has no id without an agent id.
    expect(trace.messages).toEqual([
        { id: 'a-run-1', author: { kind: 'socio' }, at: expect.any(Number) },
        { id: 'b-run-1', author: { kind: 'socio' }, at: expect.any(Number) },
    ]);
    // Runs from before CB-185 read as they did.
    expect(f.runner.recentRuns()[0].trace).toMatchObject({ reason: 'completed' });
});

it('checks the signals it is given, and caps the messages it names', () => {
    const recorder = new TraceRecorder();
    recorder.start(1000, {
        receivedAt: Number.NaN,
        trigger: { kind: 'boss' as never, id: 'x' },
    });
    expect(recorder.trace.receivedAt).toBeUndefined();
    expect(recorder.trace.trigger).toBeUndefined();
    recorder.start(1000, {
        receivedAt: 400,
        trigger: { kind: 'schedule', id: 'task-1' },
    });
    expect(recorder.trace).toMatchObject({
        receivedAt: 400,
        trigger: { kind: 'schedule', id: 'task-1' },
    });
    for (let i = 0; i < TRACE_MAX_MESSAGES + 3; i++) {
        recorder.message(`m${i}`, { kind: 'socio', id: 's' }, 1000);
    }
    expect(recorder.trace.messages).toHaveLength(TRACE_MAX_MESSAGES);
    expect(recorder.trace.dropped).toBe(3);
});

it('gives a web turn’s agent its signals, kept by the runtime’s clone', () => {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
    );
    const signals: TurnSignals = {
        receivedAt: 5,
        trigger: { kind: 'person', id: 'alice' },
    };
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
        },
        workspace.dots()[0].id,
        false,
        undefined,
        { signals },
    );
    expect(agent.turnSignals).toEqual(signals);
    expect(agent.clone().turnSignals).toEqual(signals);
});

/** One traced request to an OpenAI-compatible server answering with `deltas`. */
async function compatibleRound(deltas: Array<Record<string, unknown>>, usage?: Record<string, unknown>) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completionStream(deltas, 'stop', usage));
    const model = openAICompatibleModel({
        source: { type: 'shared', backendId: 'b' },
        label: 'Qwen',
        baseUrl: 'https://unused.invalid/v1',
        model: 'qwen',
        capabilities: { acceptsImages: false },
    });
    const entries: TraceEntry[] = [];
    const tracer = new TurnTracer((entry) => entries.push(entry));
    for await (const chunk of chat({
        threadId: 'thread-1',
        adapter: tracer.adapter(model.adapter({ maxRetries: 0 })),
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
        debug: modelDebug,
    })) {
        void chunk;
    }
    return entries.find((entry) => entry.kind === 'round') as TraceRound;
}

it('marks a self-hosted model’s streamed thinking as raw, and a round without any as none', async () => {
    expect(
        (await compatibleRound([{ role: 'assistant', reasoning_content: 'Let me think.' }, { content: 'Hi.' }]))
            .reasoningKind,
    ).toBe('raw');
    expect((await compatibleRound([{ role: 'assistant', content: '<think>Hm.' }])).reasoningKind).toBe('raw');
    // The tag split across chunks.
    expect(
        (await compatibleRound([{ role: 'assistant', content: ' <th' }, { content: 'ink>Hm.' }])).reasoningKind,
    ).toBe('raw');
    expect((await compatibleRound([{ role: 'assistant', content: 'Hi.' }])).reasoningKind).toBe('none');
    // Counted, not shown.
    expect(
        (
            await compatibleRound([{ role: 'assistant', content: 'Hi.' }], {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
                completion_tokens_details: { reasoning_tokens: 15 },
            })
        ).reasoningKind,
    ).toBe('hidden');
});

it('marks a ChatGPT plan’s reasoning summary as a summary', async () => {
    const fake = await startFakeChatGpt();
    cleanup.push(() => fake.close());
    const tokens = fake.issue();
    const reply = textReply('Hi.', 'resp_1', { summary: '**Thinking** it over' });
    const completed = reply.events.at(-1) as {
        response: {
            usage: { output_tokens_details: { reasoning_tokens: number } };
        };
    };
    completed.response.usage.output_tokens_details.reasoning_tokens = 9;
    fake.state.replies.push(reply);
    const entries: TraceEntry[] = [];
    const tracer = new TurnTracer((entry) => entries.push(entry));
    const adapter = chatGptAdapter({
        endpoints: fake.endpoints,
        getCredentials: async () => ({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            accountId: 'account',
            planType: 'plus',
            expiresAt: Date.now() + 3_600_000,
        }),
        saveCredentials: async () => {},
        markNeedsRelogin: async () => {},
    });
    for await (const chunk of chat({
        threadId: 'thread-1',
        adapter: tracer.adapter(adapter),
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
        debug: modelDebug,
    })) {
        void chunk;
    }
    expect(entries).toEqual([
        expect.objectContaining({
            kind: 'round',
            reasoningTokens: 9,
            reasoningKind: 'summary',
        }),
    ]);
});

it('gives a turn one reasoning kind, or mixed, never counting the notes’ requests', () => {
    const round = (fields: Partial<TraceRound>): TraceRound => ({
        kind: 'round',
        round: 1,
        startedAt: 0,
        endedAt: 1,
        stop: 'stop',
        ...fields,
    });
    expect(reasoningKindOf('summary', true, 5)).toBe('summary');
    expect(reasoningKindOf(undefined, true, undefined)).toBe('raw');
    expect(reasoningKindOf('summary', false, 5)).toBe('hidden');
    expect(reasoningKindOf('raw', false, 0)).toBe('none');
    expect(turnReasoningKind([])).toBeUndefined();
    // Traces from before say nothing.
    expect(traceTotals([round({})])).toEqual({ rounds: 1 });
    expect(
        turnReasoningKind([
            round({ reasoningKind: 'summary' }),
            round({ reasoningKind: 'none', summary: true }),
            round({ round: 2, reasoningKind: 'summary' }),
        ]),
    ).toBe('summary');
    // A round without reasoning, such as a tool step, keeps the turn's kind.
    expect(turnReasoningKind([round({ reasoningKind: 'summary' }), round({ round: 2, reasoningKind: 'none' })])).toBe(
        'summary',
    );
    expect(turnReasoningKind([round({ reasoningKind: 'none' })])).toBe('none');
    // After a fallback to another model.
    expect(
        traceTotals([round({ reasoningKind: 'hidden' }), round({ reasoningKind: 'raw', retry: 1, cause: 'fallback' })])
            .reasoningKind,
    ).toBe('mixed');
});

it('gives the domain errors tools return a code the trace keeps', () => {
    const result = toolError(Object.assign(new Error('Goal not found.'), { status: 404 }));
    expect(result).toEqual({ error: 'Goal not found.', code: 'http_404' });
    expect(resultOutcome(result)).toEqual({
        outcome: 'error',
        error: 'http_404',
    });
    expect(resultOutcome(JSON.stringify(result))).toEqual({
        outcome: 'error',
        error: 'http_404',
    });
    // A permission the person lacks is a refusal, as when thrown.
    expect(resultOutcome({ error: 'Not yours.', code: 'http_403' })).toEqual({
        outcome: 'refused',
        error: 'http_403',
    });
    // Still uncoded elsewhere.
    expect(resultOutcome({ error: 'Something.' })).toEqual({
        outcome: 'error',
        error: 'tool_error',
    });
});

it('keeps when each scheduled run came due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-due-'));
    const store = new Store(testDatabaseFile(join(dir, 'db.sqlite')));
    cleanup.push(
        () => rmSync(dir, { recursive: true, force: true }),
        () => store.close(),
    );
    const task = await store.createTask('Recurring research', 60, 'owner');
    const queued = (await store.task(task.id))!.updatedAt;
    const now = queued + 5_000;
    const first = (await store.claim(now))!;
    // A queued task was due when queued.
    expect(first.dueAt).toBe(queued);
    await store.finish(first, { text: 'One', sources: [], sample: true }, now);
    const second = (await store.claim(now + 90_000))!;
    // A repeating one at its next run's time.
    expect(second.dueAt).toBe(now + 60_000);
    expect((await store.detail(task.id))!.runs.map((run) => run.dueAt)).toEqual([now + 60_000, queued]);
});
