// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type { AgentRunSummary, State, User } from '@socio/shared/types';
import type { RunList } from '@socio/shared/web/web';

import { ModulesProvider } from '../src/modules/context';
import { RunsView } from '../src/modules/runs/RunsView';
import { ShellContext, type Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };

function run(fields: Partial<AgentRunSummary> = {}): AgentRunSummary {
    return {
        runId: 'r1',
        threadId: 't1',
        status: 'finished',
        source: 'web',
        startedAt: 1_000,
        finishedAt: 2_500,
        error: null,
        errorDetail: null,
        title: 'Pricing review',
        dotName: 'Dot',
        ownerId: 'alice',
        ownerName: 'Alice',
        readable: true,
        ...fields,
    };
}

let root: Root;
let host: HTMLElement;
let answer: RunList;
let traceAnswer: RunTraceView | undefined;
let calls: string[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    answer = { limit: 50, runs: [] };
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        calls.push(url.pathname + url.search);
        return new Response(JSON.stringify(url.pathname.endsWith('/trace') ? traceAnswer : answer), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
function render(node: ReactNode) {
    const shell = {
        state: { settings: {}, tasks: [], memories: [] } as unknown as State,
        workspace: { user: alice },
        admin: true,
        configured: true,
    } as unknown as Shell;
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <ModulesProvider modules={[]}>
                    <MemoryRouter>{node}</MemoryRouter>
                </ModulesProvider>
            </ShellContext.Provider>,
        ),
    );
}

it('lists turns in a table, with errors and links to readable chats', async () => {
    answer = {
        limit: 50,
        runs: [
            run(),
            run({
                runId: 'r2',
                threadId: 't2',
                status: 'failed',
                error: 'The model did not answer.',
                errorDetail: 'upstream 504',
                finishedAt: null,
            }),
            run({
                runId: 'r3',
                threadId: 't3',
                title: null,
                readable: false,
                ownerName: 'Bob',
                source: 'telegram',
            }),
        ],
    };
    const opened: string[] = [];
    render(<RunsView onOpen={(id) => opened.push(id)} />);
    await until(() => host.querySelectorAll('[data-slot="table-row"][data-run]').length === 3, 'the rows');
    expect(calls).toContain('/api/runs');
    const table = host.querySelector('[data-slot="runs-table"]')!;
    expect(table.tagName).toBe('TABLE');
    // It scrolls in its own container, not the page (CB-96).
    expect(table.parentElement?.dataset.slot).toBe('table-container');
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
        'Status',
        'Conversation',
        'Owner',
        'Source',
        'Started',
        'Duration',
    ]);
    const rows = [...table.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows.map((row) => row.dataset.status)).toEqual(['finished', 'failed', 'finished']);
    expect(rows[0].textContent).toContain('1.5 sec');
    // Status as a dot and a word; one date format, the full time on hover (CB-308).
    expect(rows.map((row) => row.querySelector('[data-slot="run-status"]')?.textContent)).toEqual([
        'Finished',
        'Failed',
        'Finished',
    ]);
    const started = rows[0].querySelector('time')!;
    expect(started.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}, (?:\d{4}, )?\d{1,2}:\d{2} [AP]M$/);
    expect(started.title).toMatch(/\d{4} at \d{1,2}:\d{2}:\d{2} [AP]M/);
    expect(rows[1].textContent).toContain('…');
    expect(rows[1].querySelector('[data-slot="run-error"]')?.textContent).toBe('The model did not answer.');
    expect(rows[1].querySelector('[data-slot="run-error-detail"]')?.textContent).toBe('upstream 504');
    // An unreadable chat is plain text; a readable one opens.
    expect(rows[2].querySelector('button')).toBeNull();
    expect(rows[2].textContent).toContain('Deleted conversation');
    expect(rows[2].textContent).toContain('Telegram');
    act(() => rows[0].querySelector('button')!.click());
    expect(opened).toEqual(['t1']);
    // The filter keeps its accessible name.
    const filter = host.querySelector('[aria-label="Filter by status"]')!;
    expect(filter.getAttribute('role')).toBe('combobox');
    expect(filter.textContent).toBe('All turns');
    // No legacy classes left (CB-95).
    const legacy = new Set([
        'runs-view',
        'runs-toolbar',
        'runs-table',
        'run-status',
        'run-error',
        'text-button',
        'chat-error',
        'muted',
    ]);
    for (const element of host.querySelectorAll('[class]')) {
        for (const name of element.classList) {
            expect(legacy.has(name) || name.startsWith('run-'), name).toBe(false);
        }
    }
});

it('says when there are no turns, and when the list is cut', async () => {
    render(<RunsView onOpen={() => {}} />);
    await until(() => /No turns yet\./.test(host.textContent ?? ''), 'empty');
    answer = { limit: 1, runs: [run()] };
    act(() => root.unmount());
    root = createRoot(host);
    render(<RunsView onOpen={() => {}} initial={answer} />);
    expect(host.textContent).toContain('Showing the latest 1.');
});

it('shows each turn’s end and tokens, and opens its trace as a timeline (CB-128)', async () => {
    answer = {
        limit: 50,
        runs: [
            run({
                trace: {
                    reason: 'round_cap',
                    rounds: 5,
                    inputTokens: 12_400,
                    outputTokens: 820,
                    // The model's prompt cache (CB-139).
                    cachedTokens: 9_920,
                },
            }),
            // Before traces: no trace to open.
            run({ runId: 'r0', threadId: 't0' }),
        ],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 2_500,
        trace: {
            turn: { label: 'Homelab', model: 'qwen', source: 'shared', cap: 5 },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_000,
                    endedAt: 1_400,
                    firstOutputMs: 250,
                    inputTokens: 1_200,
                    outputTokens: 40,
                    cachedTokens: 600,
                    stop: 'tool_calls',
                },
                {
                    kind: 'round',
                    round: 2,
                    startedAt: 2_100,
                    endedAt: 2_500,
                    stop: 'error',
                    error: 'http_503',
                },
            ],
            tools: [
                {
                    kind: 'tool',
                    round: 1,
                    name: 'search_web',
                    startedAt: 1_400,
                    endedAt: 2_100,
                    outcome: 'timeout',
                    error: 'TimeoutError',
                },
            ],
            waits: [{ kind: 'wait', for: 'approval', name: 'job_run', round: 1, at: 2_100 }],
            end: { reason: 'round_cap', rounds: 5, cap: 5 },
            totals: {
                rounds: 2,
                inputTokens: 1_200,
                outputTokens: 40,
                cachedTokens: 600,
            },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    const rows = () => [...host.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows()[0].querySelector('[data-slot="trace-summary"]')?.textContent).toBe(
        'Hit the round cap · 5 rounds · 12.4k in · 80% cached · 820 out',
    );
    expect(rows()[1].querySelector('[data-slot="trace-summary"]')).toBeNull();
    expect(rows()[1].querySelector('button[aria-expanded]')).toBeNull();
    const toggle = rows()[0].querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    // The status is the row's disclosure (CB-308): a chevron and the word.
    expect(toggle.textContent).toBe('Finished');
    expect(toggle.getAttribute('aria-label')).toBe('Show the trace of Pricing review');
    act(() => toggle.click());
    await until(() => !!host.querySelector('[data-slot="trace-timeline"]'), 'the timeline');
    expect(calls).toContain('/api/runs/r1/trace');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const timeline = host.querySelector('[data-slot="run-timeline"]')!;
    expect(timeline.textContent).toContain('Hit the round cap');
    expect(timeline.textContent).toContain('2 rounds of 5 at most · 1.2k in · 50% cached · 40 out');
    expect(timeline.textContent).toContain('Homelab · qwen');
    const entries = [...timeline.querySelectorAll<HTMLElement>('[data-slot="trace-entry"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(['round', 'tool', 'round', 'wait']);
    expect(entries[0].textContent).toBe(
        'Round 1 called tools · 1.2k in · 50% cached · 40 out · first output 250 ms400 ms',
    );
    expect(entries[1].textContent).toBe('search_web timed out · TimeoutError700 ms');
    expect(entries[2].textContent).toContain('error · http_503');
    expect(entries[3].textContent).toBe('Waiting for approval· job_run');
    // Opened again it closes.
    act(() => toggle.click());
    expect(host.querySelector('[data-slot="run-timeline"]')).toBeNull();
});

it('shows a round’s context compaction, its retry and the notes’ request in the timeline (CB-129)', async () => {
    answer = {
        limit: 50,
        runs: [run({ trace: { reason: 'completed', rounds: 1 } })],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 2_500,
        trace: {
            turn: { label: 'Homelab', model: 'qwen', source: 'shared', cap: 5 },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_010,
                    endedAt: 1_200,
                    stop: 'stop',
                    summary: true,
                },
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_210,
                    endedAt: 1_300,
                    stop: 'error',
                    error: 'context_length_exceeded',
                },
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_310,
                    endedAt: 2_500,
                    stop: 'stop',
                    retry: 1,
                },
            ],
            compactions: [
                {
                    kind: 'compaction',
                    round: 1,
                    at: 1_205,
                    beforeTokens: 182_400,
                    afterTokens: 88_000,
                    window: 128_000,
                    stubbed: 12,
                    summarised: 3,
                    retried: 0,
                },
                {
                    kind: 'compaction',
                    round: 1,
                    at: 1_305,
                    beforeTokens: 182_400,
                    afterTokens: 61_000,
                    window: 128_000,
                    stubbed: 1,
                    summarised: 0,
                    retried: 1,
                },
            ],
            tools: [],
            waits: [],
            end: { reason: 'completed', rounds: 1, cap: 5 },
            totals: { rounds: 1 },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    act(() => host.querySelector('tbody tr')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await until(() => !!host.querySelector('[data-slot="trace-timeline"]'), 'the timeline');
    const timeline = host.querySelector('[data-slot="run-timeline"]')!;
    // A retry and the notes' request are not rounds of the loop.
    expect(timeline.textContent).toContain('1 round of 5 at most');
    const entries = [...timeline.querySelectorAll<HTMLElement>('[data-slot="trace-entry"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(['round', 'compaction', 'round', 'compaction', 'round']);
    expect(entries[0].textContent).toContain('Notes for round 1 answered');
    expect(entries[1].textContent).toBe(
        'Context fitted· 182.4k → 88.0k of 128.0k tokens · 12 results cut · 3 turns in notes',
    );
    expect(entries[2].textContent).toContain('Round 1 error · context_length_exceeded');
    expect(entries[3].textContent).toBe('Context fitted· 182.4k → 61.0k of 128.0k tokens · 1 result cut · retry 1');
    expect(entries[4].textContent).toContain('Round 1, retry 1 answered');
});

it('shows the reactions the Dot was told of before its first round (CB-133)', async () => {
    answer = {
        limit: 50,
        runs: [run({ trace: { reason: 'completed', rounds: 1 } })],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 2_500,
        trace: {
            turn: { label: 'Homelab', model: 'qwen', source: 'shared', cap: 5 },
            reactions: {
                kind: 'reactions',
                at: 1_005,
                counts: { down: 1, 'needs-work': 2 },
            },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_005,
                    endedAt: 2_500,
                    stop: 'stop',
                },
            ],
            tools: [],
            waits: [],
            end: { reason: 'completed', rounds: 1, cap: 5 },
            totals: { rounds: 1 },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    act(() => host.querySelector('tbody tr')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await until(() => !!host.querySelector('[data-slot="trace-timeline"]'), 'the timeline');
    const entries = [...host.querySelectorAll<HTMLElement>('[data-slot="trace-entry"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(['reactions', 'round']);
    expect(entries[0].textContent).toBe('Told of reactions· 👎 bad reply 1 · 🛠 needs work 2');
});

it('shows who wrote the notes, their tokens and a plain summary kept, and which facts went with the round (CB-137, CB-134)', async () => {
    answer = {
        limit: 50,
        runs: [run({ trace: { reason: 'completed', rounds: 1 } })],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 30_000,
        trace: {
            turn: { label: 'ChatGPT', model: 'gpt-6', source: 'byo:chatgpt', cap: 5 },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_010,
                    endedAt: 15_000,
                    inputTokens: 12_100,
                    outputTokens: 640,
                    stop: 'stop',
                    summary: true,
                },
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 15_100,
                    endedAt: 30_000,
                    stop: 'stop',
                },
            ],
            notes: [
                {
                    kind: 'notes',
                    round: 1,
                    startedAt: 1_005,
                    endedAt: 15_000,
                    by: 'shared',
                    model: 'qwen38-flash',
                    turns: 6,
                    inputTokens: 12_100,
                    outputTokens: 640,
                },
                {
                    kind: 'notes',
                    round: 1,
                    startedAt: 15_001,
                    endedAt: 15_002,
                    by: 'shared',
                    model: 'qwen38-flash',
                    turns: 2,
                    fallback: 'cap',
                },
            ],
            compactions: [
                {
                    kind: 'compaction',
                    round: 1,
                    at: 15_050,
                    beforeTokens: 182_400,
                    afterTokens: 88_000,
                    window: 128_000,
                    stubbed: 0,
                    summarised: 8,
                    retried: 0,
                    selection: 'relevance',
                    pinnedShown: 64,
                    pinnedStored: 212,
                    notesTokens: 4_100,
                    selectMs: 900,
                },
            ],
            tools: [],
            waits: [],
            end: { reason: 'completed', rounds: 1, cap: 5 },
            totals: { rounds: 1, inputTokens: 12_100, outputTokens: 640 },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    act(() => host.querySelector('tbody tr')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await until(() => !!host.querySelector('[data-slot="trace-timeline"]'), 'the timeline');
    const entries = [...host.querySelectorAll<HTMLElement>('[data-slot="trace-entry"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(['notes', 'round', 'notes', 'compaction', 'round']);
    expect(entries[0].textContent).toContain('Notes by the shared model (qwen38-flash)· 6 turns · 12.1k in · 640 out');
    expect(entries[2].textContent).toContain('2 turns · plain summary: this turn’s summaries were used up');
    expect(entries[2].querySelector('[data-slot="trace-notes"]')!.className).not.toContain('text-destructive');
    expect(entries[3].textContent).toBe(
        'Context fitted· 182.4k → 88.0k of 128.0k tokens · 8 turns in notes · 64 of 212 facts by relevance',
    );
});

it('shows a busy model’s retries, the switch to the shared model and a turn no model could finish (CB-140)', async () => {
    answer = {
        limit: 50,
        runs: [run({ trace: { reason: 'model_unavailable', rounds: 2 } })],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 9_000,
        trace: {
            turn: { label: 'ChatGPT', model: null, source: 'byo:chatgpt', cap: 30 },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_000,
                    endedAt: 2_000,
                    stop: 'tool_calls',
                },
                {
                    kind: 'round',
                    round: 2,
                    startedAt: 2_100,
                    endedAt: 2_200,
                    stop: 'error',
                    error: 'chatgpt_rate_limited',
                },
                {
                    kind: 'round',
                    round: 2,
                    startedAt: 4_300,
                    endedAt: 4_400,
                    stop: 'error',
                    error: 'chatgpt_rate_limited',
                    retry: 1,
                    cause: 'rate_limited',
                },
                {
                    kind: 'round',
                    round: 2,
                    startedAt: 4_500,
                    endedAt: 5_000,
                    stop: 'error',
                    error: 'http_503',
                    retry: 1,
                    cause: 'fallback',
                },
            ],
            retries: [
                {
                    kind: 'retry',
                    round: 2,
                    at: 2_200,
                    reason: 'rate_limited',
                    waitMs: 2_100,
                    attempt: 1,
                    error: 'chatgpt_rate_limited',
                },
                {
                    kind: 'retry',
                    round: 2,
                    at: 2_250,
                    reason: 'unavailable',
                    waitMs: 400,
                    attempt: 2,
                    error: 'http_503',
                    cutShort: true,
                },
            ],
            fallback: {
                kind: 'fallback',
                round: 2,
                at: 4_400,
                from: 'ChatGPT',
                to: 'Homelab',
                reason: 'rate_limited',
            },
            tools: [],
            waits: [],
            end: {
                reason: 'model_unavailable',
                rounds: 2,
                cap: 30,
                fallback: { from: 'ChatGPT', to: 'Homelab' },
            },
            totals: { rounds: 2 },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    const summary = host.querySelector<HTMLElement>('[data-slot="trace-summary"]')!;
    expect(summary.textContent).toContain('Model unavailable');
    expect(summary.querySelector('.text-destructive')).not.toBeNull();
    act(() => host.querySelector('tbody tr')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await until(() => !!host.querySelector('[data-slot="trace-timeline"]'), 'the timeline');
    const entries = [...host.querySelectorAll<HTMLElement>('[data-slot="trace-entry"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual([
        'round',
        'round',
        'retry',
        'retry',
        'round',
        'fallback',
        'round',
    ]);
    expect(entries[2].textContent).toBe('Rate limited· chatgpt_rate_limited · waited 2.1 sec, then sent again');
    expect(entries[3].textContent).toBe('Out of reach· http_503 · waited 400 ms, cut short, nothing sent again');
    expect(entries[4].textContent).toMatch(/^Round 2, retry 1 \(rate limited\)/);
    expect(entries[5].textContent).toBe('Switched to the shared model· ChatGPT was busy, so Homelab carried on');
    expect(entries[6].textContent).toMatch(/^Round 2, on the shared model/);
});

it('shows a tool call’s screenshot as a thumbnail, and a note to someone who can’t read the chat (CB-157)', async () => {
    const image = `cbatt_${'r'.repeat(22)}`;
    answer = {
        limit: 50,
        runs: [run({ trace: { reason: 'completed', rounds: 2 } })],
    };
    traceAnswer = {
        runId: 'r1',
        status: 'finished',
        startedAt: 1_000,
        finishedAt: 2_500,
        trace: {
            turn: { label: 'Homelab', model: 'qwen', source: 'shared', cap: 5 },
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt: 1_005,
                    endedAt: 1_200,
                    stop: 'tool_calls',
                },
                {
                    kind: 'round',
                    round: 2,
                    startedAt: 1_500,
                    endedAt: 2_500,
                    stop: 'stop',
                },
            ],
            tools: [
                {
                    kind: 'tool',
                    round: 1,
                    name: 'computer_screenshot',
                    startedAt: 1_200,
                    endedAt: 1_500,
                    outcome: 'ok',
                    image,
                },
            ],
            waits: [],
            end: { reason: 'completed', rounds: 2, cap: 5 },
            totals: { rounds: 2 },
        },
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => !!host.querySelector('[data-slot="trace-summary"]'), 'the summary');
    act(() => host.querySelector('tbody tr')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    await until(() => !!host.querySelector('[data-slot="trace-image"]'), 'the thumbnail');
    const thumb = host.querySelector('[data-slot="trace-image"] img')!;
    expect(thumb.getAttribute('src')).toBe(`/api/media/attachments/${image}/content`);
    // The route says 404 to someone who can't read the chat.
    act(() => thumb.dispatchEvent(new Event('error')));
    expect(host.querySelector('[data-slot="trace-image-missing"]')!.textContent).toBe(
        'The image isn’t available: it was deleted, or you can’t read this chat.',
    );
});

it('marks a room’s turns, each by who started it, and offers no trace the viewer can’t open (CB-213)', async () => {
    answer = {
        limit: 50,
        runs: [
            run({
                runId: 'own',
                threadId: 'room-1',
                title: 'Launch',
                ownerId: 'alice',
                ownerName: 'Alice',
                room: true,
                trace: { reason: 'completed', rounds: 1 },
            }),
            // Another member's, as a room admin lists it: no trace to open,
            // even while it runs.
            run({
                runId: 'theirs',
                threadId: 'room-1',
                title: 'Launch',
                status: 'running',
                finishedAt: null,
                ownerId: 'mo',
                ownerName: 'Mo',
                room: true,
                canTrace: false,
                trace: null,
            }),
        ],
    };
    render(<RunsView onOpen={() => {}} />);
    await until(() => host.querySelectorAll('[data-slot="table-row"][data-run]').length === 2, 'the rows');
    const [own, theirs] = [...host.querySelectorAll<HTMLElement>('tbody tr[data-run]')];
    expect(own!.textContent).toContain('Alice · room');
    expect(theirs!.textContent).toContain('Mo · room');
    expect(own!.querySelector('[aria-label^="Show the trace"]')).not.toBeNull();
    expect(theirs!.querySelector('[aria-label^="Show the trace"]')).toBeNull();
    expect(host.textContent).not.toContain('room:');
});
