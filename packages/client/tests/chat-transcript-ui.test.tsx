import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { TraceTimes, type TimedEvent } from '@socio/shared/runs/trace-times';

import { ChatTranscript, thoughtLabel } from '../src/modules/chat/ChatTranscript';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.useRealTimers();
});

function render(
    messages: Message[],
    streamingId?: string,
    { times, running = false }: { times?: TraceTimes; running?: boolean } = {},
) {
    if (!host) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    }
    act(() =>
        root!.render(
            <ChatTranscript messages={messages} calls={[]} streamingId={streamingId} times={times} running={running} />,
        ),
    );
    return host;
}

const table = [
    'Here are the apps:',
    '',
    '| App | Reported installations | Rating |',
    '|---|---:|---|',
    '| Notes | 1,200,000 | 4.6 |',
    '| Tasks | 85,000 | 4.1 |',
].join('\n');

const reasoning = (id: string, content: string): Message => ({
    id,
    role: 'reasoning',
    content,
});
const block = (view: HTMLElement) => view.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]')!;
/** Opens or closes a folded block as a click on it would. */
const toggle = (details: HTMLDetailsElement) =>
    act(() => {
        details.open = !details.open;
        details.dispatchEvent(new Event('toggle'));
    });
/** A reasoning message's start and end times, as the runner stamps them. */
const thinking = (id: string, start: number, end: number): TimedEvent[] => [
    { type: 'REASONING_MESSAGE_START', messageId: id, timestamp: start },
    { type: 'REASONING_MESSAGE_END', messageId: id, timestamp: end },
];

it('renders a GFM table in an assistant message inside the scroll wrapper', () => {
    const view = render([{ id: 'a', role: 'assistant', content: table }]);
    const bubble = view.querySelector('[data-chat-body="assistant"]')!;
    const element = bubble.querySelector('[data-chat-table] > table')!;
    expect(element).not.toBeNull();
    expect([...element.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
        'App',
        'Reported installations',
        'Rating',
    ]);
    expect(
        [...element.querySelectorAll('tbody tr')].map((row) =>
            [...row.querySelectorAll('td')].map((td) => td.textContent),
        ),
    ).toEqual([
        ['Notes', '1,200,000', '4.6'],
        ['Tasks', '85,000', '4.1'],
    ]);
    // Not the old run-on paragraph of pipes.
    expect(bubble.textContent).not.toContain('|---');
});

it('renders a GFM table in a reasoning block too', () => {
    const view = render([reasoning('r', table)]);
    toggle(block(view));
    expect(block(view).querySelectorAll('[data-chat-table] > table tbody tr')).toHaveLength(2);
});

it('folds consecutive reasoning messages into one block, before the answer', () => {
    const view = render([
        { id: 'u', role: 'user', content: 'Compare the apps' },
        reasoning('r1', 'First thought'),
        // Assistant text in between does not split it either: a turn's text
        // shows after its work.
        { id: 'a1', role: 'assistant', content: 'Let me check' },
        reasoning('r2', 'Second thought'),
        reasoning('r3', 'Third thought'),
        { id: 'a', role: 'assistant', content: 'Here is the answer' },
    ]);
    expect(view.querySelectorAll('[data-slot="turn-trace"]')).toHaveLength(1);
    const folded = block(view);
    // From history without times: no duration.
    expect(folded.querySelector('summary')!.textContent).toBe('Thought');
    expect(folded.open).toBe(false);
    // Folded, its text is not even rendered.
    expect(folded.textContent).not.toContain('First thought');
    toggle(folded);
    expect([...folded.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
        'First thought',
        'Second thought',
        'Third thought',
    ]);
    expect(
        folded.compareDocumentPosition(view.querySelector('[data-chat-body="assistant"]')!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
});

it('starts a new trace for each turn', () => {
    const view = render([
        { id: 'u1', role: 'user', content: 'First' },
        reasoning('r1', 'First thought'),
        { id: 'u2', role: 'user', content: 'Second' },
        reasoning('r2', 'Second thought'),
    ]);
    const blocks = [...view.querySelectorAll<HTMLDetailsElement>('[data-slot="turn-trace"]')];
    blocks.forEach(toggle);
    expect(blocks.map((each) => [...each.querySelectorAll('p')].map((p) => p.textContent))).toEqual([
        ['First thought'],
        ['Second thought'],
    ]);
});

it('stays folded while reasoning streams, keeps the same block as parts arrive, and times it from the events', () => {
    const first = [reasoning('r1', 'First thought')];
    const times = new TraceTimes(thinking('r1', 0, 4_000));
    const streaming = block(render(first, 'r1', { times, running: true }));
    // Folded while it streams (CB-66): the label only.
    expect(streaming.querySelector('summary')!.textContent).toBe('Thinking');
    expect(streaming.querySelector('summary .animate-shimmer')).not.toBeNull();
    expect(streaming.open).toBe(false);

    // An earlier part streaming does not make the block stream.
    const second = [...first, reasoning('r2', 'Second thought')];
    expect(block(render(second, 'r1', { times, running: true })).querySelector('summary')!.textContent).toBe(
        'Thought for 4s',
    );

    for (const event of thinking('r2', 8_000, 12_000)) {
        times.add(event);
    }
    const again = block(render(second, 'r2', { times, running: true }));
    // Same element: the block is not remounted as parts arrive.
    expect(again).toBe(streaming);
    expect(again.querySelector('summary')!.textContent).toBe('Thinking');
    expect(again.open).toBe(false);

    // From the first part to the last.
    const done = block(render(second, undefined, { times }));
    expect(done.querySelector('summary')!.textContent).toBe('Thought for 12s');
    expect(done.querySelector('summary .animate-shimmer')).toBeNull();
    expect(done.open).toBe(false);
    // A click opens the full text.
    act(() => done.querySelector('summary')!.click());
    expect(done.open).toBe(true);
});

it('reads "Thought for 12s" from a stored run’s times, after a reload', () => {
    // A reload builds the times from the history the connection replays.
    const times = new TraceTimes([
        { type: 'REASONING_START', messageId: 'r1', timestamp: 1_000 },
        { type: 'REASONING_MESSAGE_START', messageId: 'r1', timestamp: 1_000 },
        { type: 'REASONING_MESSAGE_END', messageId: 'r1', timestamp: 13_200 },
        { type: 'REASONING_END', messageId: 'r1', timestamp: 13_200 },
    ]);
    const view = render(
        [
            { id: 'u', role: 'user', content: 'Why?' },
            reasoning('r1', 'Because.'),
            { id: 'a', role: 'assistant', content: 'That is why.' },
        ],
        undefined,
        { times },
    );
    expect(block(view).querySelector('summary')!.textContent).toBe('Thought for 12s');
});

it('labels a short think "Thought for 1s", and a long one in minutes', () => {
    expect(thoughtLabel(0)).toBe('Thought for 1s');
    expect(thoughtLabel(72)).toBe('Thought for 1m 12s');
    expect(thoughtLabel(undefined)).toBe('Thought');
});

it('keeps a block the reader opened open as more parts stream in', () => {
    const first = [reasoning('r1', 'First thought')];
    const folded = block(render(first));
    toggle(folded);
    const second = [...first, reasoning('r2', 'Second thought')];
    block(render(second, 'r2', { running: true }));
    const done = block(render(second));
    expect(done).toBe(folded);
    expect(done.open).toBe(true);
});

// CB-283: a room's transcript now carries a socio turn's reasoning and tool
// calls (with their times), and the shared transcript renders them as a
// trace — the same component the private chat uses.
it('renders a tool call as a trace step, with its time (CB-283)', () => {
    const times = new TraceTimes([
        { type: 'TOOL_CALL_START', toolCallId: 'c1', timestamp: 1_000 },
        { type: 'TOOL_CALL_RESULT', toolCallId: 'c1', timestamp: 2_500 },
    ]);
    const view = render(
        [
            { id: 'u', role: 'user', content: 'What is on today?' },
            {
                id: 'a',
                role: 'assistant',
                content: 'Here is the plan.',
                toolCalls: [
                    {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'calendar_read', arguments: '{}' },
                    },
                ],
            },
            {
                id: 'r',
                role: 'tool',
                toolCallId: 'c1',
                content: '{"ok":true}',
            },
        ],
        undefined,
        { times },
    );
    const trace = block(view);
    // Folded by default once the turn is done; its summary says it worked.
    expect(trace.querySelector('summary')!.textContent).toContain('Worked');
    toggle(trace);
    // A tool step shows, named for the tool.
    expect(trace.querySelector('[data-tool="calendar_read"]')).not.toBeNull();
});
