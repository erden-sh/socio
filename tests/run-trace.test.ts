import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { defineTool } from '@copilotkit/runtime/v2';
import { chat } from '@tanstack/ai';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { modelDebug } from '@socio/foundation/observability/failures';
import { LOOP_END_EVENT } from '@socio/shared/loop-end';
import {
    RUN_TRACE_EVENT,
    cachedPercent,
    traceTotals,
    type TraceEntry,
    type TraceRound,
} from '@socio/shared/runs/run-trace';
import { roundTokens } from '@socio/shared/runs/token-usage';

import { chatGptAdapter } from '../src/server/inference/chatgpt/index.js';
import { TurnTracer, inferLoopEnd, resultOutcome, traceSummary } from '../src/server/turns/turn-trace.js';

import { startFakeChatGpt, textReply } from './fixtures/fake-chatgpt.js';
import { completion, completionStream } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'the-merger-plan';

/** A Dot whose turn has these tools (the module tools' place). */
function dotFixture(tools: ReturnType<typeof defineTool>[]) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => runner.close(),
        () => workspace.close(),
        () => store.close(),
    );
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Traced', 'owner');
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
        },
        dot.id,
        false,
        undefined,
        { extensions: { tools: () => tools } },
    );
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: `Look up ${SECRET}.` }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = input.threadId;
    agent.setMessages(input.messages);
    const run = () => lastValueFrom(runner.run({ threadId: 'thread', agent, input }).pipe(toArray()));
    return { runner, run };
}

const call = (index: number, id: string, name: string, args: unknown) => ({
    index,
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

it('records each model round and tool call with its time, stop reason, tokens and outcome, never content', async () => {
    const tool = (name: string, execute: (args: { q: string }) => Promise<unknown>) =>
        defineTool({
            name,
            description: name,
            parameters: z.object({ q: z.string() }),
            execute,
        });
    const f = dotFixture([
        tool('lookup', async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { found: `${SECRET} result` };
        }),
        tool('broken', async () => {
            throw new TypeError(`cannot read ${SECRET}`);
        }),
        tool('fetch_site', async () => ({
            ok: false,
            reason: 'blocked',
            message: `blocked ${SECRET}`,
        })),
        tool('ask_first', async () => ({
            status: 'pending_approval',
            id: 'req-1',
            message: 'Waiting for the user’s approval.',
        })),
    ]);
    vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
            completionStream(
                [
                    {
                        role: 'assistant',
                        tool_calls: [
                            call(0, 'c1', 'lookup', { q: SECRET }),
                            call(1, 'c2', 'broken', { q: SECRET }),
                            call(2, 'c3', 'fetch_site', { q: SECRET }),
                            call(3, 'c4', 'ask_first', { q: SECRET }),
                        ],
                    },
                ],
                'tool_calls',
                {
                    prompt_tokens: 1_200,
                    completion_tokens: 40,
                    total_tokens: 1_240,
                    completion_tokens_details: { reasoning_tokens: 12 },
                },
            ),
        )
        .mockResolvedValueOnce(
            completion({ role: 'assistant', content: `Found ${SECRET}.` }, 'stop', {
                prompt_tokens: 1_500,
                completion_tokens: 8,
                total_tokens: 1_508,
            }),
        );
    const events = await f.run();
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    // The trace is the runner's: clients never get its events.
    expect(events.filter((event) => (event as { name?: string }).name === RUN_TRACE_EVENT)).toEqual([]);
    expect(JSON.stringify(f.runner.events('thread'))).not.toContain(RUN_TRACE_EVENT);

    const stored = f.runner.runTrace('run')!;
    expect(stored.status).toBe('finished');
    const trace = stored.trace!;
    expect(trace.turn).toEqual({
        label: 'custom-model',
        model: 'custom-model',
        source: 'shared',
        // The default cap (CB-127).
        cap: 30,
    });
    expect(trace.rounds).toEqual([
        expect.objectContaining({
            round: 1,
            stop: 'tool_calls',
            inputTokens: 1_200,
            outputTokens: 40,
            reasoningTokens: 12,
            // Counted but not shown (CB-185).
            reasoningKind: 'hidden',
        }),
        expect.objectContaining({
            round: 2,
            stop: 'stop',
            inputTokens: 1_500,
            outputTokens: 8,
            reasoningKind: 'none',
        }),
    ]);
    for (const round of trace.rounds) {
        expect(round.endedAt).toBeGreaterThanOrEqual(round.startedAt);
        expect(round.firstOutputMs).toBeGreaterThanOrEqual(0);
    }
    // The second round starts after the tools ran.
    expect(trace.rounds[1].startedAt).toBeGreaterThanOrEqual(trace.rounds[0].endedAt);
    const tools = Object.fromEntries(trace.tools.map((t) => [t.name, t]));
    expect(tools).toEqual({
        lookup: expect.objectContaining({ round: 1, outcome: 'ok', callId: 'c1' }),
        broken: expect.objectContaining({ outcome: 'error', error: 'TypeError' }),
        fetch_site: expect.objectContaining({
            outcome: 'refused',
            error: 'blocked',
        }),
        ask_first: expect.objectContaining({ outcome: 'ok' }),
    });
    expect(tools.lookup.endedAt - tools.lookup.startedAt).toBeGreaterThanOrEqual(25);
    expect(trace.waits).toEqual([expect.objectContaining({ for: 'approval', name: 'ask_first', round: 1 })]);
    // The turn's own loop-end event (CB-127) says how it ended.
    expect(trace.end).toEqual({
        reason: 'completed',
        rounds: 2,
        cap: 30,
    });
    expect(trace.totals).toEqual({
        rounds: 2,
        inputTokens: 2_700,
        outputTokens: 48,
        reasoningTokens: 12,
        reasoningKind: 'hidden',
    });
    // Names, times and codes only.
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(f.runner.recentRuns()[0].trace).toEqual({
        reason: 'completed',
        rounds: 2,
        inputTokens: 2_700,
        outputTokens: 48,
    });
});

it('records a round that ends in an error, and the turn’s error end', async () => {
    const f = dotFixture([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
            new Response('{"error":{"message":"image input not supported"}}', {
                status: 400,
            }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = await f.run();
    expect(events.at(-1)?.type).toBe('RUN_ERROR');
    const { trace } = f.runner.runTrace('run')!;
    expect(trace!.rounds).toEqual([expect.objectContaining({ round: 1, stop: 'error', error: 'http_400' })]);
    expect(trace!.end).toMatchObject({ reason: 'error', rounds: 1 });
});

it('traces the model’s own stop under the output-limit and argument checks, and the calls they skipped', async () => {
    let ran = 0;
    const f = dotFixture([
        defineTool({
            name: 'write_notes',
            description: 'write_notes',
            parameters: z.object({ q: z.string() }),
            execute: async () => {
                ran += 1;
                return { ok: true };
            },
        }),
    ]);
    const round = (id: string, args: string, finish: string) =>
        completion(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id,
                        type: 'function',
                        function: { name: 'write_notes', arguments: args },
                    },
                ],
            },
            finish,
        );
    vi.spyOn(globalThis, 'fetch')
        // Cut off by the output limit (CB-126), then unreadable (CB-12).
        .mockResolvedValueOnce(round('cut', `{"q":"${SECRET}`, 'length'))
        .mockResolvedValueOnce(round('bad', 'not json at all', 'tool_calls'))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Done.' }, 'stop'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = await f.run();
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(ran).toBe(0);
    const { trace } = f.runner.runTrace('run')!;
    // The model's own stop, not the `tool_calls` the turn carried on with.
    expect(trace!.rounds.map((entry) => entry.stop)).toEqual(['length', 'tool_calls', 'stop']);
    expect(trace!.tools).toEqual([
        expect.objectContaining({
            round: 1,
            name: 'write_notes',
            callId: 'cut',
            outcome: 'error',
            error: 'output_limit',
        }),
        expect.objectContaining({
            round: 2,
            name: 'write_notes',
            callId: 'bad',
            outcome: 'error',
            error: 'unreadable_arguments',
        }),
    ]);
    // One loop-end event, passed on to clients and kept in the trace.
    expect(events.filter((event) => (event as { name?: string }).name === LOOP_END_EVENT)).toEqual([
        expect.objectContaining({
            value: { reason: 'completed', rounds: 3, cap: 30 },
        }),
    ]);
    expect(trace!.end).toEqual({ reason: 'completed', rounds: 3, cap: 30 });
    expect(JSON.stringify(trace)).not.toContain(SECRET);
});

it('reads tokens and the stop reason from a ChatGPT plan’s response.completed', async () => {
    const fake = await startFakeChatGpt();
    cleanup.push(() => fake.close());
    const tokens = fake.issue();
    const reply = textReply('Hi.');
    const completed = reply.events.at(-1) as {
        response: {
            usage: { output_tokens_details: { reasoning_tokens: number } };
            incomplete_details?: { reason: string };
        };
    };
    completed.response.usage.output_tokens_details.reasoning_tokens = 3;
    completed.response.incomplete_details = { reason: 'max_output_tokens' };
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
            round: 1,
            stop: 'length',
            inputTokens: 42,
            outputTokens: 7,
            reasoningTokens: 3,
            // No summary came: the reasoning was hidden (CB-185).
            reasoningKind: 'hidden',
        }),
    ]);
});

/** Streams these trace entries and events, as a Dot turn does, then finishes. */
class TracedAgent extends AbstractAgent {
    constructor(
        private entries: unknown[],
        private extra: BaseEvent[] = [],
        private reply = `About ${SECRET}`,
    ) {
        super({});
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
            subscriber.next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: `m-${input.runId}`,
                role: 'assistant',
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `m-${input.runId}`,
                delta: this.reply,
            } as BaseEvent);
            subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: `m-${input.runId}`,
            } as BaseEvent);
            for (const event of this.extra) {
                subscriber.next(event);
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

const capRounds = (n: number) => [
    { kind: 'turn', label: 'Homelab', model: 'qwen', source: 'shared', cap: n },
    ...Array.from({ length: n }, (_, i) => ({
        kind: 'round',
        round: i + 1,
        startedAt: 1_000 + i * 100,
        endedAt: 1_050 + i * 100,
        inputTokens: 100,
        outputTokens: 10,
        stop: 'tool_calls',
    })),
];

async function platformFixture() {
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: { apiKey: '', model: '' },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Traced', 'alice');
    const turn = (agent: AbstractAgent, runId: string) => {
        const messages = [{ id: `u-${runId}`, role: 'user' as const, content: SECRET }];
        agent.threadId = 'thread';
        agent.setMessages(messages);
        return lastValueFrom(
            platform.runner
                .run({
                    threadId: 'thread',
                    agent,
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
    };
    return { platform, turn };
}

it('takes the loop-end event as the reason, passes it on, and logs it on the turn’s line', async () => {
    const f = await platformFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const loopEnd = {
        type: EventType.CUSTOM,
        name: LOOP_END_EVENT,
        value: { reason: 'round_cap', rounds: 5, cap: 5 },
    } as BaseEvent;
    const events = await f.turn(new TracedAgent(capRounds(5), [loopEnd]), 'r1');
    // Clients get the loop-end event; trace entries stay on the server.
    expect(events.filter((event) => event.type === EventType.CUSTOM)).toMatchObject([{ name: LOOP_END_EVENT }]);
    const { trace } = f.platform.runner.runTrace('r1')!;
    expect(trace!.end).toEqual({ reason: 'round_cap', rounds: 5, cap: 5 });
    expect(trace!.rounds).toHaveLength(5);
    // Logged once the run's source is read (CB-110: through the Telegram
    // port, which is async).
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const line = log.mock.calls.map((args) => args.join(' ')).at(-1)!;
    expect(line).toMatch(
        /^Turn: finished run=r1 thread=thread user=alice source=web ms=\d+ cycle=[\w-]+ hop=0 reason=round_cap rounds=5 tokens_in=500 tokens_out=50$/,
    );
    expect(line).not.toContain(SECRET);

    // Without the event, the same turn's reason is worked out: the cap.
    await f.turn(new TracedAgent(capRounds(5)), 'r2');
    expect(f.platform.runner.runTrace('r2')!.trace!.end).toEqual({
        reason: 'round_cap',
        rounds: 5,
        cap: 5,
        inferred: true,
    });
    // A malformed loop-end value is ignored.
    const [turn, round] = capRounds(1);
    await f.turn(
        new TracedAgent(
            [
                { ...turn, cap: 5 },
                { ...round, stop: 'stop' },
            ],
            [
                {
                    type: EventType.CUSTOM,
                    name: LOOP_END_EVENT,
                    value: { reason: 'bored', rounds: -1 },
                } as BaseEvent,
            ],
        ),
        'r3',
    );
    expect(f.platform.runner.runTrace('r3')!.trace!.end).toMatchObject({
        reason: 'completed',
        inferred: true,
    });
    await vi.waitFor(() =>
        expect(log.mock.calls.at(-1)!.join(' ')).toContain('reason=completed rounds=1 tokens_in=100 tokens_out=10'),
    );
});

it('works out why a loop ended when the turn does not say', () => {
    const trace = (stops: string[], cap = 5) => ({
        turn: { label: 'Homelab', model: null, source: 'shared', cap },
        rounds: stops.map((stop, i) => ({
            kind: 'round' as const,
            round: i + 1,
            startedAt: 0,
            endedAt: 1,
            stop: stop as 'stop',
        })),
        tools: [],
        waits: [],
    });
    expect(inferLoopEnd(trace(['tool_calls', 'stop']), 'finished')).toEqual({
        reason: 'completed',
        rounds: 2,
        cap: 5,
    });
    expect(inferLoopEnd(trace(['length']), 'finished').reason).toBe('output_limit');
    expect(inferLoopEnd(trace(['tool_calls', 'tool_calls'], 2), 'finished')).toEqual({
        reason: 'round_cap',
        rounds: 2,
        cap: 2,
    });
    expect(inferLoopEnd(trace(['cancelled']), 'failed', 'time_limit').reason).toBe('time_limit');
    expect(inferLoopEnd(trace(['cancelled']), 'failed', 'stopped').reason).toBe('stopped');
    expect(inferLoopEnd(trace(['error']), 'failed', 'model_unavailable').reason).toBe('error');
    expect(inferLoopEnd(trace([]), 'stopped').reason).toBe('stopped');
    expect(inferLoopEnd(trace([]), 'interrupted').reason).toBe('interrupted');
});

it('reads a tool result’s outcome without keeping its payload', () => {
    expect(resultOutcome({ text: SECRET })).toEqual({ outcome: 'ok' });
    expect(resultOutcome({ ok: false, reason: 'timeout', message: SECRET })).toEqual({
        outcome: 'timeout',
        error: 'timeout',
    });
    expect(resultOutcome({ ok: false, reason: 'rate_limited' })).toEqual({
        outcome: 'refused',
        error: 'rate_limited',
    });
    expect(resultOutcome(JSON.stringify({ error: SECRET }))).toEqual({
        outcome: 'error',
        error: 'tool_error',
    });
    expect(resultOutcome({ exitCode: 2, stderr: SECRET })).toEqual({
        outcome: 'error',
        error: 'exit_code',
    });
    expect(resultOutcome({ status: 'denied' })).toEqual({
        outcome: 'refused',
        error: 'denied',
    });
    expect(resultOutcome({ ok: false, reason: `${SECRET} with spaces` })).toEqual({
        outcome: 'error',
        error: 'not_ok',
    });
    expect(roundTokens([{ inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 }])).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        cachedTokens: 1,
    });
});

it('adds up the cached input, for the turn’s cache-hit share (CB-139)', () => {
    const round = (fields: Partial<TraceRound>): TraceRound => ({
        kind: 'round',
        round: 1,
        startedAt: 0,
        endedAt: 1,
        stop: 'stop',
        ...fields,
    });
    const totals = traceTotals([
        round({ inputTokens: 10_000, cachedTokens: 0 }),
        round({ round: 2, inputTokens: 12_000, cachedTokens: 9_600 }),
        round({ round: 2, summary: true, inputTokens: 2_000 }),
    ]);
    expect(totals).toEqual({
        rounds: 2,
        inputTokens: 24_000,
        cachedTokens: 9_600,
    });
    expect(cachedPercent(totals)).toBe(40);
    expect(traceSummary({ end: { reason: 'completed', rounds: 2, cap: 30 }, totals })).toEqual({
        reason: 'completed',
        rounds: 2,
        inputTokens: 24_000,
        cachedTokens: 9_600,
    });
    // A model that reports no cache: no share, rather than 0%.
    expect(traceTotals([round({ inputTokens: 5 })])).not.toHaveProperty('cachedTokens');
    expect(cachedPercent({ inputTokens: 5 })).toBeUndefined();
});

it('keeps tracing out of the turn’s way when it fails', async () => {
    const tracer = new TurnTracer(() => {
        throw new Error('trace sink down');
    });
    async function* stream() {
        yield { type: 'TEXT_MESSAGE_START' };
        yield { type: 'RUN_FINISHED', finishReason: 'stop' };
    }
    const adapter = tracer.adapter({ chatStream: stream } as never);
    const seen: string[] = [];
    for await (const chunk of adapter.chatStream({} as never)) {
        seen.push(chunk.type);
    }
    expect(seen).toEqual(['TEXT_MESSAGE_START', 'RUN_FINISHED']);
    const [tool] = tracer.tools([{ name: 'echo', execute: async (input: never) => input }]);
    expect(await tool.execute!('same' as never)).toBe('same');
});
