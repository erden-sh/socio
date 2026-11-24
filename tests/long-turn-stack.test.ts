import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import type { Message } from '@ag-ui/core';
import { defineTool } from '@copilotkit/runtime/v2';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { OUTPUT_LIMIT_NOTE } from '@socio/foundation/turns/output-limit';
import { LOOP_END_EVENT } from '@socio/shared/loop-end';
import { CONTEXT_COMPACTION_EVENT } from '@socio/shared/runs/run-phase';
import { RUN_TRACE_EVENT, loopRound } from '@socio/shared/runs/run-trace';

import { resetCalibration } from '../src/server/context/budget.js';
import { lastRoundNote } from '../src/server/turns/agent-loop.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// One long, tool-heavy turn through the whole stack (CB-126 to CB-129): the
// agent loop's cap and last round without tools, the output-limit recovery,
// the turn's trace and the context fitting, on a fake Chat Completions model.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const WINDOW = 16_384;
const CAP = 4;

/** Characters of filler that read like a data result. */
const rows = (chars: number, seed: number) => {
    const row = `{"id":${seed},"name":"row ${seed}","value":${seed * 7}},`;
    return `[${row.repeat(Math.ceil(chars / row.length))}`.slice(0, chars);
};

type Request = {
    tools?: unknown[];
    messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

const callRound = (id: string, args: string, finish = 'tool_calls') =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name: 'fetch_rows', arguments: args },
                },
            ],
        },
        finish,
        { prompt_tokens: 3_000, completion_tokens: 20, total_tokens: 3_020 },
    );

it('runs a long tool-heavy turn to its cap: every round fitted, the trace complete, one loop end', async () => {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => runner.close(),
        () => workspace.close(),
        () => store.close(),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dot = workspace.dots()[0];
    workspace.bindThread('long', dot.id, 'Long', 'owner');
    const fetchRows = defineTool({
        name: 'fetch_rows',
        description: 'Fetch a page of rows.',
        parameters: z.object({ page: z.number() }),
        execute: async ({ page }: { page: number }) => rows(12_000, 100 + page),
    });
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
            contextWindow: WINDOW,
            dotModelRounds: CAP,
        },
        dot.id,
        false,
        undefined,
        { extensions: { tools: () => [fetchRows] } },
    );

    // The model: the notes' summaries answer as notes; the first round's
    // prompt is refused as too long; then a call, a call the output limit
    // cut off, another call, and (without tools) the status.
    const requests: Array<{ body: string; parsed: Request }> = [];
    let rounds = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.includes('running notes')) {
            return completion({
                role: 'assistant',
                content: 'PINNED:\n- Working on: the rows report\nSUMMARY:\nThe Dot fetched rows for a report.',
            });
        }
        const parsed = JSON.parse(body) as Request;
        requests.push({ body, parsed });
        if (requests.length === 1) {
            return new Response(
                JSON.stringify({
                    error: {
                        message: `This model's maximum context length is ${WINDOW} tokens.`,
                        type: 'invalid_request_error',
                        code: 'context_length_exceeded',
                    },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
        }
        rounds += 1;
        if (!parsed.tools?.length) {
            return completion({
                role: 'assistant',
                content: 'Fetched three pages; the report itself is still to do.',
            });
        }
        if (rounds === 2) {
            return callRound('cut', '{"page":', 'length');
        }
        return callRound(`call-${rounds}`, JSON.stringify({ page: rounds }));
    });

    // A long thread of big tool results before this turn.
    const history: Message[] = [];
    for (let index = 0; index < 8; index++) {
        history.push(
            { id: `u${index}`, role: 'user', content: `Fetch page ${index}.` },
            {
                id: `a${index}`,
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: `c${index}`,
                        type: 'function',
                        function: {
                            name: 'fetch_rows',
                            arguments: JSON.stringify({ page: index }),
                        },
                    },
                ],
            },
            {
                id: `r${index}`,
                role: 'tool',
                toolCallId: `c${index}`,
                content: rows(12_000, index),
            },
            {
                id: `b${index}`,
                role: 'assistant',
                content: `Page ${index} done. ${'The rows add up as expected, and the totals match the last report. '.repeat(60)}`,
            },
        );
    }
    const input: RunAgentInput = {
        threadId: 'long',
        runId: 'run-long',
        state: {},
        context: [],
        messages: [...history, { id: 'u-last', role: 'user', content: 'Fetch the next pages.' }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = input.threadId;
    agent.setMessages(input.messages);
    const events = await lastValueFrom(runner.run({ threadId: 'long', agent, input }).pipe(toArray()));

    // The turn completes, with the status of its last round.
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    const stored = await runner.messages('long');
    expect(stored.filter((message) => message.role === 'assistant').at(-1)?.content).toBe(
        'Fetched three pages; the report itself is still to do.',
    );

    // The loop ends once, at its cap: the refusal's retry is no extra round.
    const named = (name: string) =>
        events.filter(
            (event: BaseEvent) => event.type === EventType.CUSTOM && (event as { name?: string }).name === name,
        );
    expect(named(LOOP_END_EVENT).map((event) => event.value)).toEqual([{ reason: 'round_cap', rounds: CAP, cap: CAP }]);
    expect(events.at(-2)).toMatchObject({ name: LOOP_END_EVENT });
    // Compaction events reach the chat (its status line), trace entries don't.
    expect(named(CONTEXT_COMPACTION_EVENT).length).toBeGreaterThanOrEqual(CAP);
    expect(named(RUN_TRACE_EVENT)).toEqual([]);

    // Every request was fitted: the first refused, then one for each round.
    expect(requests).toHaveLength(CAP + 1);
    const whole = JSON.stringify(input.messages).length;
    for (const { body } of requests) {
        expect(body.length).toBeLessThan(whole / 2);
    }
    // Round 3 (after the refusal and the retry, round 2) hears of the cut call.
    expect(requests[3].parsed.messages).toContainEqual(
        expect.objectContaining({
            role: 'tool',
            tool_call_id: 'cut',
            content: expect.stringContaining(OUTPUT_LIMIT_NOTE),
        }),
    );
    // The last round has no tools, and its note; it was fitted too, after
    // its round's big result came in.
    const last = requests.at(-1)!;
    expect(last.parsed.tools ?? []).toEqual([]);
    expect(last.body).toContain(lastRoundNote(CAP));
    expect(last.body).toContain('Fetch the next pages.');
    expect(last.body.length).toBeLessThan(WINDOW * 3);

    // The trace: each request, the retry within round 1, the compactions.
    const trace = runner.runTrace('run-long')!.trace!;
    expect(trace.turn?.cap).toBe(CAP);
    const loop = trace.rounds.filter(loopRound);
    expect(loop.map((round) => [round.round, round.stop])).toEqual([
        [1, 'error'],
        [2, 'length'],
        [3, 'tool_calls'],
        [4, 'stop'],
    ]);
    expect(loop[0].error).toBe('context_length_exceeded');
    expect(trace.rounds.filter((round) => round.retry)).toEqual([
        expect.objectContaining({ round: 1, retry: 1, stop: 'tool_calls' }),
    ]);
    // The notes' summaries, written while round 1 was fitted (before its
    // first request and before its retry), are traced as such, not as rounds.
    const summaries = trace.rounds.filter((round) => round.summary);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries.every((round) => round.round === 1)).toBe(true);
    expect(trace.tools).toContainEqual(
        expect.objectContaining({
            round: 2,
            name: 'fetch_rows',
            outcome: 'error',
            error: 'output_limit',
        }),
    );
    const compactions = trace.compactions ?? [];
    expect(new Set(compactions.map((entry) => entry.round))).toEqual(new Set([1, 2, 3, 4]));
    expect(compactions[0]).toMatchObject({
        round: 1,
        retried: 0,
        window: WINDOW,
    });
    expect(compactions).toContainEqual(expect.objectContaining({ round: 1, retried: 1 }));
    // The last round, without tools, starts from the notes too.
    expect(compactions.at(-1)).toMatchObject({ round: CAP, retried: 0 });
    expect(compactions.at(-1)!.summarised).toBeGreaterThan(0);
    expect(compactions.at(-1)!.stubbed).toBeGreaterThan(0);
    for (const entry of compactions) {
        expect(entry.afterTokens).toBeLessThan(entry.beforeTokens);
        expect(entry.afterTokens).toBeLessThan(WINDOW);
    }
    expect(trace.end).toEqual({ reason: 'round_cap', rounds: CAP, cap: CAP });
    expect(trace.totals?.rounds).toBe(CAP);
});
