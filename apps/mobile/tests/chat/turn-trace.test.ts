import { readFileSync } from 'node:fs';

import type { Message } from '@ag-ui/core';
import { describe, expect, it, vi } from 'vitest';

import type { HistoryPage, HistoryRun } from '@socio/shared/chat/chat-history';
import { NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import type { RunTraceView } from '@socio/shared/runs/run-trace';

import { loadRunTrace, runTracePath } from '../../src/chat/run-trace';
import { resultEntries, valueEntries } from '../../src/chat/trace-values';
import { transcriptRows } from '../../src/chat/transcript';
import { chatTurns, liveSummary, STEP_FAILED, traceSheet, traceSummary } from '../../src/chat/turn-trace';
import type { AuthedFetch } from '../../src/net/authed-fetch';

// Turn traces over the "smoke trace" fixtures, captured from a local
// server (apps/mobile/e2e/servers.mjs, the fake model's "smoke trace" turn:
// reasoning, two lookups, a query that fails, an answer). The history page
// is what `/history` answered, the run what `/api/runs/:runId/trace` did.

const fixture = <T>(name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
const page = fixture<HistoryPage>('smoke-trace-history.json');
const runView = fixture<RunTraceView>('smoke-trace-run.json');
const runs = page.runs;
const run = runs[0]!;
const loaded = { state: 'loaded', view: runView } as const;

describe('chatTurns over smoke trace', () => {
    it('finds the one turn that did work, anchored before its first message from the socio', () => {
        const turns = chatTurns(runs);
        expect(turns).toHaveLength(1);
        const turn = turns[0]!;
        expect(turn.id).toBe('r2-user-1');
        expect(turn.anchor).toBe(run.messages[1]!.id);
        expect(turn.runIds).toEqual([run.runId]);
        // Reasoning, three tools, reasoning: in the order they happened, by their times.
        expect(turn.steps.map((step) => (step.kind === 'tool' ? step.call.function.name : step.kind))).toEqual([
            'reasoning',
            'list_authorized_spaces',
            'search_space_pages',
            'data_query',
            'reasoning',
        ]);
    });

    it("builds a chat's turns once for the same runs, and again for a new run", () => {
        const first = chatTurns([...runs]);
        // A streaming frame hands over a new array of the same (immutable) runs.
        expect(chatTurns([...runs])).toBe(first);
        const next: HistoryRun = { ...run, runId: 'r2-next', messages: [] };
        const grown = chatTurns([...runs, next]);
        expect(grown).not.toBe(first);
        expect(grown).toEqual(first);
        // A rebuilt run (a copy, as a fresh page would bring) isn't taken for the old one.
        expect(chatTurns([{ ...run }])).not.toBe(first);
        expect(chatTurns(runs)).toBe(first);
    });

    it('sums up the finished turn in one row with its failure', () => {
        const summary = traceSummary(chatTurns(runs)[0]!);
        expect(summary).toEqual({ label: 'Worked for 8.3s · 5 steps', icon: 'list-checks', failed: 1 });
    });

    it('says "Thought for 2s" for a turn that only reasoned, and "Thought" with no times', () => {
        const thought: HistoryRun = {
            ...run,
            messages: [
                run.messages[0]!,
                run.messages[1]!,
                { id: 'a1', role: 'assistant', content: 'Done.' } as Message,
            ],
        };
        expect(traceSummary(chatTurns([thought])[0]!)).toMatchObject({ label: 'Thought for 2s', icon: 'brain' });
        const untimed = { ...thought, times: { messages: [], tools: [], reasoning: [] } };
        expect(traceSummary(chatTurns([untimed])[0]!)).toMatchObject({ label: 'Thought' });
    });

    it('leaves page reviews and approvals out of the steps: they are cards', () => {
        const review: HistoryRun = {
            ...run,
            seq: 3,
            prev: 2,
            runId: 'run-review',
            messages: [
                { id: 'u2', role: 'user', content: 'review it' } as Message,
                {
                    id: 'a2',
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'rv', type: 'function', function: { name: 'review_space_page', arguments: '{}' } },
                    ],
                } as Message,
            ],
            times: { messages: [], tools: [], reasoning: [] },
        };
        expect(chatTurns([run, review]).map((turn) => turn.id)).toEqual(['r2-user-1']);
    });
});

describe('the transcript with traces', () => {
    it('puts the trace row before the reply, which still shows', () => {
        const rows = transcriptRows(runs, NO_LIVE_TURN);
        expect(rows.map((row) => row.kind)).toEqual(['user', 'trace', 'reply']);
        expect(rows[1]).toMatchObject({ id: 'trace:r2-user-1', turn: 'r2-user-1', failed: 1 });
    });

    it('shows the running turn as "Thinking" or "Working" from its phase, never openable', () => {
        const thinking = transcriptRows([], {
            running: true,
            phase: 'thinking',
            messages: [{ id: 'u9', role: 'user', content: 'smoke trace' } as Message],
        });
        expect(thinking.map((row) => row.id)).toEqual(['u9', 'trace:live']);
        expect(thinking[1]).toMatchObject({ label: 'Thinking', turn: null });
        const writing = transcriptRows([], {
            running: true,
            phase: 'working',
            streamingId: 'a9',
            messages: [
                { id: 'u9', role: 'user', content: 'smoke trace' } as Message,
                { id: 'a9', role: 'assistant', content: 'Tra' } as Message,
            ],
        });
        expect(writing.map((row) => row.id)).toEqual(['u9', 'trace:live', 'a9']);
        expect(liveSummary('writing')).toBeNull();
        expect(liveSummary(undefined)).toBeNull();
    });
});

describe('the trace sheet with Advanced mode off', () => {
    const sheet = traceSheet(chatTurns(runs)[0]!, false);

    it("words each step as the web does, a failure in the tool's words", () => {
        expect(sheet.steps.map(({ verb, detail, state, message }) => ({ verb, detail, state, message }))).toEqual([
            { verb: 'Thought for 2s', detail: undefined, state: 'done', message: undefined },
            { verb: 'Listed the Spaces', detail: undefined, state: 'done', message: undefined },
            { verb: 'Searched pages', detail: 'for “export”', state: 'done', message: undefined },
            {
                verb: 'Queried',
                detail: 'a dataset',
                state: 'failed',
                message: 'The query failed: no such table: weekly_sales',
            },
            { verb: 'Thought for 2s', detail: undefined, state: 'done', message: undefined },
        ]);
    });

    it('opens reasoning to its text, and shows no inputs, results, ids, times or codes', () => {
        expect(sheet.steps[0]!.text).toBe('Working out the steps. ');
        for (const step of sheet.steps) {
            expect(step.advanced).toBeUndefined();
            expect(step.result).toBeUndefined();
        }
        expect(sheet.advanced).toBeUndefined();
        expect(JSON.stringify(sheet)).not.toContain(run.runId);
        expect(JSON.stringify(sheet)).not.toContain('http_400');
    });

    it('gives a failure with nothing to say the general line', () => {
        const bare: HistoryRun = {
            ...run,
            messages: run.messages.map((message) =>
                message.role === 'tool' && message.toolCallId === 'call-2-data_query'
                    ? ({ ...message, content: '{"ok":false}' } as Message)
                    : message,
            ),
        };
        expect(traceSheet(chatTurns([bare])[0]!, false).steps[3]!.message).toBe(STEP_FAILED);
    });
});

describe('tool images in the trace (CB-416, the web’s ToolImageThumb)', () => {
    const ID = 'cbatt_AbCdEfGhIjKlMnOpQrStUv';
    const withResult = (content: string): HistoryRun => ({
        ...run,
        messages: run.messages.map((message) =>
            message.role === 'tool' && message.toolCallId === 'call-1-search_space_pages'
                ? ({ ...message, content } as Message)
                : message,
        ),
    });

    it('gives a step whose result names a picture that picture, with or without Advanced mode', () => {
        const named = withResult(
            JSON.stringify({ name: 'Board page', image: { id: ID, mediaType: 'image/png', size: 2048 } }),
        );
        for (const advanced of [false, true]) {
            const steps = traceSheet(chatTurns([named])[0]!, advanced).steps;
            expect(steps[2]!.image, String(advanced)).toEqual({ id: ID, name: 'Board page' });
            expect(steps.filter((step) => step.image !== undefined)).toHaveLength(1);
        }
        const unnamed = withResult(JSON.stringify({ image: { id: ID, mediaType: 'image/jpeg', size: 9 } }));
        expect(traceSheet(chatTurns([unnamed])[0]!, false).steps[2]!.image).toEqual({ id: ID, name: 'Screenshot' });
    });

    it('takes no picture a result doesn’t name as the shared rules allow', () => {
        for (const content of [
            JSON.stringify({ image: { id: 'not-an-attachment', mediaType: 'image/png', size: 1 } }),
            JSON.stringify({ image: { id: ID, mediaType: 'image/svg+xml', size: 1 } }),
            JSON.stringify({ image: { id: ID, mediaType: 'image/png' } }),
            '{"results":[]}',
        ]) {
            expect(traceSheet(chatTurns([withResult(content)])[0]!, false).steps[2]!.image, content).toBeUndefined();
        }
    });

    it('opens a pictured step to the picture through the image cache and the viewer (turn-trace.tsx)', () => {
        const sheet = readFileSync(new URL('../../src/screens/turn-trace.tsx', import.meta.url), 'utf8');
        expect(sheet).toContain('step.advanced !== undefined || step.image !== undefined');
        expect(sheet).toContain('<CardPicture image={step.image} testID={`trace-image-${step.id}`} />');
    });
});

describe('the trace sheet with Advanced mode on', () => {
    const turn = chatTurns(runs)[0]!;
    const sheet = traceSheet(turn, true, [loaded]);
    const query = sheet.steps[3]!;

    it("adds each tool step's time, call id, input, result and raw codes", () => {
        expect(query.advanced).toMatchObject({
            callId: 'call-2-data_query',
            tool: 'data_query',
            duration: '0.1s',
            codes: ['error', 'http_400'],
        });
        expect(query.advanced!.input!.entries).toEqual([
            { kind: 'code', label: 'SQL', text: 'SELECT week, SUM(revenue)\nFROM weekly_sales\nGROUP BY week' },
        ]);
        expect(query.result).toContain('no such table');
        expect(resultEntries(query.result!)).toEqual([
            { kind: 'row', name: 'Error', value: 'The query failed: no such table: weekly_sales' },
            // `code` is a code field on the web too.
            { kind: 'code', label: 'Code', text: 'http_400' },
        ]);
        // A tool with no arguments shows no input.
        expect(sheet.steps[1]!.advanced!.input).toBeUndefined();
        // A list of found things is one line each.
        expect(resultEntries(sheet.steps[1]!.result!)).toEqual([
            {
                kind: 'items',
                label: 'Result',
                items: [
                    {
                        title: 'Everyday',
                        meta: 'ID 329de4d4-b34c-4b00-a652-4af9cee6f5a3 · Created at 1794145351936',
                        excerpt: 'A little space for your day.',
                    },
                ],
                more: 0,
            },
        ]);
    });

    it("shows the run's id, model, rounds, timings and end code from its trace", () => {
        const section = sheet.advanced!.runs[0]!;
        expect(sheet.advanced!.turnId).toBe('r2-user-1');
        expect(section.state).toBe('loaded');
        expect(section.rows).toEqual([
            { name: 'Run', value: 'r2-capture-run-1', copy: true },
            { name: 'Status', value: 'finished' },
            { name: 'Took', value: '8.3s' },
            { name: 'Waited to start', value: '<0.1s' },
            { name: 'Model', value: 'Self-hosted (fake-model) · fake-model' },
            { name: 'Source', value: 'shared' },
            { name: 'Rounds', value: '4' },
            { name: 'Reasoning', value: 'raw' },
            { name: 'Cycle tokens', value: '34,436' },
            { name: 'Ended', value: 'Completed (completed)' },
        ]);
        expect(section.rounds).toEqual([
            'Round 1 · 2s · first output <0.1s · tool_calls',
            'Round 2 · 2s · first output 2s · tool_calls',
            'Round 3 · 2s · first output 2s · tool_calls',
            'Round 4 · 2s · first output <0.1s · stop',
        ]);
    });

    it('shows token counts and their cached share when the model reported them', () => {
        const counted: RunTraceView = {
            ...runView,
            trace: {
                ...runView.trace!,
                totals: { rounds: 4, inputTokens: 12_000, outputTokens: 340, cachedTokens: 3_000 },
            },
        };
        const rows = traceSheet(turn, true, [{ state: 'loaded', view: counted }]).advanced!.runs[0]!.rows;
        expect(rows).toContainEqual({ name: 'Input tokens', value: '12,000 (25% cached)' });
        expect(rows).toContainEqual({ name: 'Output tokens', value: '340' });
    });

    it('says while the trace loads, when it failed, and when the server has none for this person', () => {
        expect(traceSheet(turn, true).advanced!.runs[0]).toMatchObject({ state: 'loading', rounds: [] });
        expect(traceSheet(turn, true, [{ state: 'failed' }]).advanced!.runs[0]!.state).toBe('failed');
        expect(traceSheet(turn, true, [{ state: 'loaded', view: null }]).advanced!.runs[0]!.state).toBe('missing');
        // Codes come only from the trace.
        expect(traceSheet(turn, true).steps[3]!.advanced!.codes).toEqual([]);
    });

    it('marks a preview, so the sheet fetches its whole result as the step opens', () => {
        const light: HistoryRun = { ...run, light: { 'call-0-list_authorized_spaces': 9_000 } };
        const steps = traceSheet(chatTurns([light])[0]!, true).steps;
        expect(steps[1]!.advanced!.lightSize).toBe(9_000);
        expect(steps[2]!.advanced!.lightSize).toBeUndefined();
    });
});

describe('valueEntries', () => {
    it('keeps code fields, long text and nested objects as blocks, after the short rows', () => {
        expect(
            valueEntries(
                { stdout: 'ok', exitCode: 0, nested: { a: [1, { b: 2 }] }, tags: ['x', 'y'], empty: '' },
                'Result',
            ),
        ).toEqual([
            { kind: 'row', name: 'Exit code', value: '0' },
            { kind: 'row', name: 'Tags', value: 'x, y' },
            { kind: 'code', label: 'Output', text: 'ok' },
            { kind: 'code', label: 'Nested', text: JSON.stringify({ a: [1, { b: 2 }] }, null, 2) },
        ]);
        expect(valueEntries('a\nb', 'Result')).toEqual([{ kind: 'code', label: 'Result', text: 'a\nb' }]);
        expect(valueEntries({ image: 'A'.repeat(2_000) }, 'Result')).toEqual([
            { kind: 'row', name: 'Image', value: 'Binary data, 1 KB' },
        ]);
    });
});

describe('loadRunTrace', () => {
    const answer = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    it('asks the run trace route and takes its view', async () => {
        const fetch = vi.fn<AuthedFetch>(async () => answer(200, runView));
        expect(await loadRunTrace(fetch, 'r2-capture-run-1')).toEqual(runView);
        expect(fetch).toHaveBeenCalledWith('/api/runs/r2-capture-run-1/trace', undefined);
        expect(runTracePath('a/b')).toBe('/api/runs/a%2Fb/trace');
    });

    it("is null on a 404 (another person's run), and throws on any other failure or shape", async () => {
        expect(await loadRunTrace(async () => answer(404, { error: 'Run not found.' }), 'x')).toBeNull();
        await expect(loadRunTrace(async () => answer(500, { error: 'boom' }), 'x')).rejects.toMatchObject({
            status: 500,
        });
        await expect(loadRunTrace(async () => answer(200, { runId: 'other' }), 'x')).rejects.toThrow();
    });
});
