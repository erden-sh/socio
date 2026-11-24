import { AbstractAgent, compactEvents, type BaseEvent, type Message } from '@ag-ui/client';
// @vitest-environment jsdom
import { Search, Terminal, Wrench } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { from, type Observable } from 'rxjs';
import { afterEach, expect, it } from 'vitest';

import { TraceTimes } from '@socio/shared/runs/trace-times';

import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { messageTime } from '../src/modules/chat/MessageActions';
import { toolLabel } from '../src/modules/chat/trace/tool-labels';
import { TurnTrace } from '../src/modules/chat/trace/TurnTrace';

import { traceTurnEvents } from './fixtures/trace-turn';

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
});

/** Rebuilds messages from stored events, as a chat's connection does. */
class Replay extends AbstractAgent {
    constructor(private events: BaseEvent[]) {
        super({});
    }
    run(): Observable<BaseEvent> {
        throw new Error('replay only');
    }
    protected connect() {
        return from(this.events);
    }
}
const STARTED = Date.UTC(2026, 9, 17, 13, 4, 0);
/** The scripted turn as a reload shows it: its messages and times. */
async function history(timed = true) {
    const events = compactEvents(traceTurnEvents({ threadId: 't', runId: 'r', startedAt: STARTED, timed }));
    const replay = new Replay(events);
    replay.threadId = 't';
    await replay.connectAgent();
    return { messages: replay.messages, times: new TraceTimes(events) };
}

function render(messages: Message[], options: { times?: TraceTimes; running?: boolean } = {}) {
    if (!host) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    }
    act(() =>
        root!.render(<ChatTranscript messages={messages} calls={[]} times={options.times} running={options.running} />),
    );
    return host;
}
const trace = (view: HTMLElement) => view.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]')!;
const steps = (view: HTMLElement) => [...view.querySelectorAll<HTMLDetailsElement>('[data-slot="trace-step"]')];
const lines = (view: HTMLElement) => steps(view).map((step) => step.querySelector('summary')!.textContent);
const toggle = (details: HTMLDetailsElement) =>
    act(() => {
        details.open = !details.open;
        details.dispatchEvent(new Event('toggle'));
    });
const step = (view: HTMLElement, tool: string) => view.querySelector<HTMLDetailsElement>(`[data-tool="${tool}"]`)!;

it('sums up a stored turn in one folded line, and lists its steps in order with verbs and times (CB-72)', async () => {
    const { messages, times } = await history();
    const view = render(messages, { times });
    const folded = trace(view);
    expect(folded.open).toBe(false);
    expect(folded.querySelector('summary')!.textContent).toBe('Worked for 31s · 8 steps· 1 failed');
    // Folded, the steps are not rendered at all.
    expect(steps(view)).toEqual([]);
    // Before the reply.
    expect(
        folded.compareDocumentPosition(view.querySelector('[data-chat-body="assistant"]')!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    toggle(folded);
    // Reasoning and calls interleaved as they happened (by their times).
    expect(lines(view)).toEqual([
        'Thought for 12s',
        'Searched the board for “export”0.5s',
        'Searched pages for “CSV export”0.6s',
        'Read “Data exports”0.4s',
        'Thought for 4s',
        'Ran a script cd reports8.4s',
        'Queried a datasetFailed0.4s',
        'Thought for 3s',
    ]);
    expect(steps(view).map((each) => each.dataset.state)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        'failed',
        'done',
    ]);
    // No wall of JSON anywhere.
    expect(view.textContent).not.toContain('{"');
});

it('opens a step to its input and result, rendered only while open', async () => {
    const { messages, times } = await history();
    const view = render(messages, { times });
    toggle(trace(view));
    const exec = step(view, 'computer_exec');
    expect(exec.querySelector('[data-slot="trace-details"]')).toBeNull();
    toggle(exec);
    const blocks = [...exec.querySelectorAll('[data-slot="trace-code"]')].map((code) => ({
        label: code.querySelector('[data-slot="trace-code-label"]')!.textContent,
        text: code.querySelector('pre')!.textContent,
    }));
    expect(blocks.map((each) => each.label)).toEqual(['Command', 'Output']);
    expect(blocks[0].text).toBe('cd reports\npython3 export_week.py --week 41 --format csv\nwc -l week-41.csv');
    expect(blocks[1].text).toContain('Wrote 7 rows to week-41.csv');
    // Each block, and each section, has its copy button.
    expect(exec.querySelectorAll('button[aria-label="Copy"]')).toHaveLength(4);
    expect(exec.textContent).toContain('Exit code0');
    // An empty stderr is left out.
    expect(exec.textContent).not.toContain('Errors');

    // A search's matches read as a list, not JSON.
    const board = step(view, 'search_improvements');
    toggle(board);
    expect(
        [...board.querySelectorAll('[data-slot="trace-items"] li')].map(
            (item) => item.querySelector('[data-slot="trace-item-title"]')!.textContent,
        ),
    ).toEqual(['CB-41 CSV export drops the header row', 'CB-58 Export a Space as Markdown']);
    expect(board.textContent).toContain('The weekly export leaves out');

    // Closing it drops the details again.
    toggle(exec);
    expect(exec.querySelector('[data-slot="trace-details"]')).toBeNull();
    // And the trace folds back to its line.
    toggle(trace(view));
    expect(steps(view)).toEqual([]);
});

it('marks a failed step, with its error first and not repeated', async () => {
    const { messages, times } = await history();
    const view = render(messages, { times });
    toggle(trace(view));
    const query = step(view, 'data_query');
    expect(query.dataset.state).toBe('failed');
    expect(query.querySelector('[data-slot="trace-step-failed"]')!.textContent).toBe('Failed');
    toggle(query);
    expect(query.querySelector('[role="alert"]')!.textContent).toBe('no such table: weekly_sales');
    // The SQL is code; the result held only the error, so no result section.
    expect(query.querySelector('[data-slot="trace-code"] pre')!.textContent).toContain('FROM weekly_sales');
    expect(query.querySelector('[aria-label="Result"]')).toBeNull();
});

it('shows each message’s time in its action row', async () => {
    const { messages, times } = await history();
    const view = render(messages, { times });
    const stamps = [...view.querySelectorAll('[data-slot="message-time"] time')];
    expect(stamps.map((stamp) => stamp.getAttribute('dateTime'))).toEqual([
        new Date(STARTED).toISOString(),
        new Date(STARTED + 31_400).toISOString(),
    ]);
    expect(stamps[0].textContent).toBe(messageTime(STARTED));
});

it('formats message times in en-US: the time today, the date before', () => {
    const at = new Date(2026, 9, 17, 15, 4).getTime();
    expect(messageTime(at, new Date(2026, 9, 17, 18).getTime())).toBe('3:04 PM');
    expect(messageTime(at, new Date(2026, 9, 20).getTime())).toBe('Oct 17, 3:04 PM');
    expect(messageTime(at, new Date(2027, 0, 2).getTime())).toBe('Oct 17, 2026, 3:04 PM');
});

it('renders a run stored without times gracefully: same steps, no durations or times', async () => {
    const { messages, times } = await history(false);
    const view = render(messages, { times });
    expect(trace(view).querySelector('summary')!.textContent).toBe('Worked through 7 steps· 1 failed');
    toggle(trace(view));
    // Without times the reasoning after the calls can't be placed: it folds
    // into one block after them.
    expect(lines(view)).toEqual([
        'Thought',
        'Searched the board for “export”',
        'Searched pages for “CSV export”',
        'Read “Data exports”',
        'Ran a script cd reports',
        'Queried a datasetFailed',
        'Thought',
    ]);
    expect(view.querySelectorAll('[data-slot="message-time"]')).toHaveLength(0);
    expect(view.textContent).toContain('Last week (week 41)');
});

it('shows a running turn open, with its live step, and folds it when the turn ends', async () => {
    const { messages, times } = await history();
    // The turn so far: the script still running, nothing after it.
    const later = ['call-exec-r', 'call-query-r'];
    const running = messages.flatMap((message): Message[] =>
        (message.role === 'tool' && later.includes(message.toolCallId)) || message.id === 'think-3-r'
            ? []
            : message.role === 'assistant'
              ? [
                    {
                        ...message,
                        content: '',
                        toolCalls: message.toolCalls?.filter((call) => call.id !== 'call-query-r'),
                    },
                ]
              : [message],
    );
    const view = render(running, { times, running: true });
    const open = trace(view);
    expect(open.open).toBe(true);
    expect(open.querySelector('summary')!.textContent).toBe('Working · 6 steps');
    const exec = step(view, 'computer_exec');
    expect(exec.dataset.state).toBe('running');
    expect(exec.querySelector('[aria-label="Running"]')).not.toBeNull();
    expect(exec.querySelector('summary')!.textContent).toBe('Running a script cd reports');

    // The turn ends: folded, and the same element.
    render(messages, { times });
    expect(trace(view)).toBe(open);
    expect(open.open).toBe(false);
    expect(open.querySelector('summary')!.textContent).toContain('Worked for');
});

it('keeps the reader’s choice: a live trace they closed stays closed', async () => {
    const { messages, times } = await history();
    const view = render(messages, { times, running: true });
    toggle(trace(view));
    expect(trace(view).open).toBe(false);
    render(messages, { times, running: true });
    expect(trace(view).open).toBe(false);
});

it('gives each tool label its lucide icon, the wrench for an unknown tool', () => {
    expect(toolLabel('search_improvements', {}, {}, true).icon).toBe(Search);
    expect(toolLabel('computer_exec', { command: 'ls' }, {}, false).icon).toBe(Terminal);
    expect(toolLabel('frobnicate_widgetList', {}, {}, true).icon).toBe(Wrench);
});

it('shows a screenshot as a thumbnail that opens at full size, an older inline one too (CB-157)', async () => {
    const id = `cbatt_${'s'.repeat(22)}`;
    const png = `iVBORw0KGgo${'A'.repeat(2_000)}`;
    const call = (callId: string) => ({
        id: `a-${callId}`,
        role: 'assistant' as const,
        content: '',
        toolCalls: [
            {
                id: callId,
                type: 'function' as const,
                function: { name: 'computer_screenshot', arguments: '{}' },
            },
        ],
    });
    const messages = [
        { id: 'u', role: 'user', content: 'Look at the board.' },
        call('old'),
        {
            id: 'r-old',
            role: 'tool',
            toolCallId: 'old',
            content: JSON.stringify({ base64: png, width: 1280, height: 800 }),
        },
        call('new'),
        {
            id: 'r-new',
            role: 'tool',
            toolCallId: 'new',
            content: JSON.stringify({
                url: 'https://reversi.example.test/',
                width: 1280,
                height: 800,
                image: { id, mediaType: 'image/jpeg', size: 143_000 },
            }),
        },
        { id: 'b', role: 'assistant', content: 'Black to move.' },
    ] as Message[];
    const view = render(messages);
    toggle(trace(view));
    const [old, shot] = view.querySelectorAll<HTMLDetailsElement>('[data-tool="computer_screenshot"]');
    toggle(shot);
    const thumb = shot.querySelector<HTMLButtonElement>('[data-slot="trace-image"]')!;
    expect(thumb.querySelector('img')!.getAttribute('src')).toBe(`/api/media/attachments/${id}/content`);
    // The rest of the result reads as fields; no reference as JSON.
    expect(shot.textContent).toContain('https://reversi.example.test/');
    expect(shot.textContent).not.toContain(id);
    act(() => thumb.click());
    const viewer = document.querySelector('[data-slot="attachment-viewer"]')!;
    expect(viewer.querySelector('img')!.getAttribute('src')).toBe(`/api/media/attachments/${id}/content`);
    expect(viewer.textContent).toContain('Screenshot');
    // An older version's base64 screenshot shows as the image, not as text.
    toggle(old);
    expect(old.querySelector('[data-slot="trace-image"] img')!.getAttribute('src')).toBe(
        `data:image/png;base64,${png}`,
    );
    expect(old.textContent).not.toContain('Binary data');
});

it('shows a shared-dataset notice under the folded trace, with a link to the dataset (CB-337)', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const step = (id: string, result: unknown) => ({
        kind: 'tool' as const,
        id,
        call: { id, type: 'function' as const, function: { name: 'data_insert', arguments: '{"table":"items"}' } },
        result: JSON.stringify(result),
        span: {},
    });
    const notice = {
        kind: 'shared_dataset',
        text: 'Saved to “Sebas shared”, Sebas’s shared dataset. Admins and other people who use Sebas can see it.',
        href: '/data/datasets/d1',
    };
    act(() =>
        root!.render(
            <TurnTrace
                live={false}
                steps={[
                    step('a', { status: 'done', dataset: 'Sebas shared', result: {}, notice }),
                    step('b', { status: 'done', dataset: 'Sebas shared', result: {} }),
                ]}
            />,
        ),
    );
    expect(host.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]')!.open).toBe(false);
    const shown = [...host.querySelectorAll('[data-slot="shared-data-notice"]')];
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toContain('Sebas’s shared dataset');
    expect(shown[0].querySelector('a')!.getAttribute('href')).toBe('/data/datasets/d1');
});
