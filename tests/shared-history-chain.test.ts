import { expect, it } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { chained, HISTORY_FORMAT, historyScope, mergeHistory, waitsOnTool } from '@socio/shared/chat/history-chain';

// A chat's history as the web and the app keep it (CB-136): which runs a
// store may show, where it keeps them, and the live turn over them.
const run = (seq: number, messages: HistoryRun['messages'] = [], light = {}, prev: number | null = seq - 10 || null) =>
    ({
        seq,
        prev,
        runId: `r${seq}`,
        status: 'finished',
        startedAt: 0,
        finishedAt: 0,
        messages,
        times: { messages: [], tools: [], reasoning: [] },
        light,
        size: 0,
    }) as HistoryRun;

it('keeps only what chains down from the newest run, oldest first', () => {
    const runs = [10, 20, 30, 40, 50].map((seq) => run(seq));
    expect(chained([runs[4], runs[0], runs[3], runs[1]]).map((r) => r.seq)).toEqual([40, 50]);
    expect(chained(runs).map((r) => r.seq)).toEqual([10, 20, 30, 40, 50]);
    expect(chained([])).toEqual([]);
});

it('keeps each chat under a scope named for the stored format', () => {
    expect(historyScope('c 1')).toBe(`chat:${HISTORY_FORMAT}:c 1`);
});

it('tells a run that waits on the person from one that ended', () => {
    const call = (id: string) => ({
        id: 'a1',
        role: 'assistant' as const,
        toolCalls: [{ id, type: 'function' as const, function: { name: 'review_space_page', arguments: '{}' } }],
    });
    expect(waitsOnTool(run(10, [{ id: 'u1', role: 'user', content: 'Draft it' }, call('c1')]))).toBe(true);
    expect(
        waitsOnTool(run(10, [call('c1'), { id: 't1', role: 'tool', toolCallId: 'c1', content: '{"approved":true}' }])),
    ).toBe(false);
    expect(waitsOnTool(run(10, [{ id: 'a2', role: 'assistant', content: 'Done' }]))).toBe(false);
});

it('merges the store’s runs with the agent’s turns: no duplicates, no gaps, whole results first', () => {
    const runs = [
        run(
            10,
            [
                { id: 'u1', role: 'user', content: 'One' },
                {
                    id: 'r1',
                    role: 'tool',
                    toolCallId: 'c1',
                    content: '{"status":"ok"}',
                },
            ],
            { c1: 50_000 },
        ),
        run(
            20,
            [
                { id: 'u2', role: 'user', content: 'Two' },
                {
                    id: 'r2',
                    role: 'tool',
                    toolCallId: 'c2',
                    content: '{"status":"ok"}',
                },
            ],
            { c2: 50_000 },
        ),
    ];
    // The agent replayed the newest run (whole) and streams a new turn.
    const live = [
        { id: 'u2', role: 'user' as const, content: 'Two' },
        { id: 'r2', role: 'tool' as const, toolCallId: 'c2', content: 'whole' },
        { id: 'u3', role: 'user' as const, content: 'Three' },
    ];
    const merged = mergeHistory(runs, live);
    expect(merged.messages.map((message) => message.id)).toEqual(['u1', 'r1', 'u2', 'r2', 'u3']);
    expect(merged.messages[3].content).toBe('whole');
    expect([...merged.light]).toEqual([['c1', 50_000]]);
    // Without a history: the agent's, as before.
    expect(mergeHistory([], live).messages).toEqual(live);
});
