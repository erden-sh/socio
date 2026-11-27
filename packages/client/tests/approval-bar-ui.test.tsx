import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalView } from '@socio/shared/approvals';
import type { Conversation, Dot } from '@socio/shared/types';

import { HIGHLIGHT_MS, useAsksTo } from '../src/modules/approvals/ApprovalBar';
import { Chat } from '../src/modules/chat/Chat';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
const scrolled: Element[] = [];
Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
};

/**
 * A stand-in for CopilotKit: an agent whose messages the test sets, a core
 * whose connect and run are spies, and a tool-calls view that renders each
 * call through the chat's `*` renderer with its tool result.
 */
const kit = vi.hoisted(() => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    const agent = {
        messages: [] as Message[],
        setMessages(next: Message[]) {
            agent.messages = next;
            listeners.forEach((fn) => fn());
        },
        addMessage(message: Message) {
            agent.setMessages([...agent.messages, message]);
        },
        subscribe: () => ({ unsubscribe() {} }),
        listen(fn: Listener) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
        },
    };
    return {
        agent,
        copilotkit: {
            subscribe: () => ({ unsubscribe() {} }),
            connectAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            runAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            stopAgent: () => {},
        },
        render: undefined as undefined | ((props: unknown) => unknown),
        // CopilotKit re-registers the renderer (remounting every card) when
        // its deps' JSON changes.
        deps: new Set<string>(),
    };
});
vi.mock('@copilotkit/react-core/v2', async () => {
    const React = await import('react');
    return {
        useAgent: () => {
            const [, force] = React.useReducer((n: number) => n + 1, 0);
            React.useEffect(() => kit.agent.listen(force), []);
            return { agent: kit.agent, isReady: true };
        },
        useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
        useRenderTool: (tool: { name?: string; render: (props: unknown) => unknown }, deps: unknown[]) => {
            // The chat's wildcard renderer (approval cards); named ones, such as
            // the coding session card (CB-239), aren't what this test follows.
            if (tool.name !== '*') {
                return;
            }
            kit.render = tool.render;
            kit.deps.add(JSON.stringify(deps));
        },
        useHumanInTheLoop: () => {},
        CopilotChatToolCallsView: ({
            message,
            messages,
        }: {
            message: {
                toolCalls?: Array<{ id: string; function: { name: string } }>;
            };
            messages: Message[];
        }) =>
            (message.toolCalls ?? []).map((call) => (
                <div key={call.id}>
                    {
                        kit.render?.({
                            name: call.function.name,
                            toolCallId: call.id,
                            args: {},
                            status: 'complete',
                            result: messages.find(
                                (entry) =>
                                    entry.role === 'tool' && (entry as { toolCallId?: string }).toolCallId === call.id,
                            )?.content,
                        }) as ReactNode
                    }
                </div>
            )),
    };
});

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Socio',
    instructions: 'Socio helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const thread: Conversation = {
    id: 'c1',
    dotId: 'd1',
    ownerId: 'bob',
    title: 'Chat',
    createdAt: 1,
};
const pending = (id: string) => ({
    status: 'pending_approval',
    approval: { id, summary: 'Save job', url: `/approvals/${id}` },
    message: 'Waiting.',
});
const history = (): Message[] => [
    { id: 'u1', role: 'user', content: 'Save my job and schedule it.' },
    {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
            {
                id: 't1',
                type: 'function',
                function: { name: 'job_save', arguments: '{}' },
            },
            {
                id: 't2',
                type: 'function',
                function: { name: 'schedule_create', arguments: '{}' },
            },
        ],
    },
    {
        id: 'r1',
        role: 'tool',
        toolCallId: 't1',
        content: JSON.stringify(pending('ap1')),
    },
    {
        id: 'r2',
        role: 'tool',
        toolCallId: 't2',
        content: JSON.stringify(pending('ap2')),
    },
    { id: 'a2', role: 'assistant', content: 'Approve them when you can.' },
];
const view = (id: string, extra: Partial<ApprovalView> = {}): ApprovalView => ({
    id,
    dotId: 'd1',
    dotName: 'Ada',
    capability: id === 'ap1' ? 'job.save' : 'schedule.create',
    capabilityLabel: id === 'ap1' ? 'Save a job' : 'Create a schedule',
    summary: id === 'ap1' ? 'Save job “Prices”' : 'Schedule “Prices”',
    details: [],
    status: 'pending',
    decidedVia: null,
    // The schedule was asked first: the bar starts with it.
    createdAt: id === 'ap1' ? 20 : 10,
    expiresAt: Date.now() + 86_400_000,
    auto: null,
    continuation: null,
    ...extra,
});

let views: Record<string, ApprovalView>;
let decisions: string[];
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    views = { ap1: view('ap1'), ap2: view('ap2') };
    decisions = [];
    scrolled.length = 0;
    kit.deps.clear();
    kit.agent.messages = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
                headers: { 'Content-Type': 'application/json' },
            });
        if (path.endsWith('/page-context')) {
            return json(null);
        }
        if (path === '/api/me/inference/options') {
            return json({ options: [], automatic: null });
        }
        const decision = path.match(/^\/api\/approvals\/(\w+)\/decision$/);
        if (decision && init?.method === 'POST') {
            const id = decision[1];
            const verdict = JSON.parse(String(init.body)).decision;
            decisions.push(`${verdict} ${id}`);
            views[id] = view(id, {
                status: verdict === 'approve' ? 'approved' : 'denied',
                decidedVia: 'user',
            });
            return json(views[id]);
        }
        const one = path.match(/^\/api\/approvals\/(\w+)$/);
        if (one) {
            return json(views[one[1]]);
        }
        return new Response(JSON.stringify({ error: 'Not here' }), { status: 404 });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const bar = () => host.querySelector<HTMLElement>('[data-slot="approval-bar"]');
const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message your socio"]')!;
const click = (within: HTMLElement, name: string) =>
    act(() => {
        [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)!.click();
    });
/** Types as a person does: React sees the input event. */
const type = (element: HTMLTextAreaElement, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });

function open(connect: () => Promise<unknown>) {
    vi.spyOn(kit.copilotkit, 'connectAgent').mockImplementation(connect);
    act(() =>
        root.render(
            <Chat
                thread={thread}
                dot={dot}
                onConsumed={() => {}}
                voiceReady={false}
                calls={[]}
                paused={false}
                onSaved={() => {}}
                onSchedule={() => {}}
            />,
        ),
    );
}

it('words the request from its capability', () => {
    let asksTo!: ReturnType<typeof useAsksTo>;
    function Probe() {
        asksTo = useAsksTo();
        return null;
    }
    const probe = createRoot(document.createElement('div'));
    act(() => probe.render(<Probe />));
    expect(asksTo(view('ap2'))).toBe('Ada asks to create a schedule');
    act(() => probe.unmount());
});

it('shows the oldest pending request on the composer, acts on it, and keeps the draft', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    open(async () => {
        await loaded;
        kit.agent.setMessages(history());
    });
    // The reader starts typing before the history (and its requests) loads.
    await until(() => !!box(), 'the composer');
    box().focus();
    type(box(), 'Next: compare it with last month');
    expect(bar()).toBeNull();
    release();
    await until(() => !!bar(), 'the approval bar');
    const textBox = box();
    // The text box is the same element, still usable, with the draft.
    expect(textBox.disabled).toBe(false);
    expect(textBox.value).toBe('Next: compare it with last month');
    expect(document.activeElement).toBe(textBox);
    expect(bar()!.textContent).toContain('Ada asks to create a schedule');
    expect(bar()!.textContent).toContain('Schedule “Prices”');
    expect(bar()!.querySelector('[data-slot="approval-count"]')!.textContent).toBe('1 of 2');
    // Its buttons are ordinary buttons, in the tab order.
    for (const name of ['Show request', 'Deny', 'Approve']) {
        expect([...bar()!.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)?.tabIndex).toBe(
            0,
        );
    }

    // Typing still works with the bar up.
    type(textBox, 'Next: compare it with last month, and the year');
    click(bar()!, 'Approve');
    await until(() => decisions.length === 1, 'the first decision');
    expect(decisions).toEqual(['approve ap2']);
    // The card shows the decision too: the bar decided through it.
    await until(() => !!bar() && !bar()!.textContent?.includes('Schedule'), 'the next request');
    expect(bar()!.textContent).toContain('Ada asks to save a job');
    expect(bar()!.querySelector('[data-slot="approval-count"]')).toBeNull();
    expect(
        host.querySelector('[data-approval-id="ap2"] [data-slot="approval-card"]')!.getAttribute('data-status'),
    ).toBe('approved');

    click(bar()!, 'Deny');
    await until(() => !bar(), 'the bar to lift');
    expect(decisions).toEqual(['approve ap2', 'deny ap1']);
    expect(box()).toBe(textBox);
    expect(textBox.value).toBe('Next: compare it with last month, and the year');
});

/** A goal_set turn: its tool call and result, as the Dot's history holds it. */
const goalTurn = (id: string, result: unknown): Message[] => [
    {
        id: `ga-${id}`,
        role: 'assistant',
        content: '',
        toolCalls: [
            {
                id: `gt-${id}`,
                type: 'function',
                function: { name: 'goal_set', arguments: '{}' },
            },
        ],
    },
    {
        id: `gr-${id}`,
        role: 'tool',
        toolCallId: `gt-${id}`,
        content: JSON.stringify(result),
    },
];
const cardOf = (id: string) => host.querySelector(`[data-approval-id="${id}"] [data-slot="approval-card"]`);

it('shows a pending goal as an approval card, live and after a reload (CB-131)', async () => {
    views = { ap1: view('ap1'), ap2: view('ap2') };
    // A goal_set result as the tool returns it now, and as chats saved
    // before the fix hold it: the approval under `outcome`.
    const flat = { ...pending('ap1'), id: 'ap1', goals: [] };
    const nested = { outcome: { ...pending('ap2'), id: 'ap2' }, goals: [] };
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    open(async () => {
        await loaded;
        kit.agent.setMessages([{ id: 'u1', role: 'user', content: 'Take on a goal.' }, ...goalTurn('1', nested)]);
    });
    release();
    // Replayed from the saved history.
    await until(() => !!cardOf('ap2'), 'the replayed goal card');
    expect(cardOf('ap2')!.textContent).toContain('Approve');
    // Live, as the turn's tool result arrives.
    act(() => kit.agent.setMessages([...kit.agent.messages, ...goalTurn('2', flat)]));
    await until(() => !!cardOf('ap1'), 'the live goal card');
    await until(() => cardOf('ap1')?.getAttribute('data-status') === 'pending', 'the goal card to load');
    await until(() => !!bar(), 'the approval bar');
});

it('lifts when the request is decided elsewhere, from the cards’ poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    open(async () => kit.agent.setMessages([...history().slice(0, 3), history()[4]]));
    await until(() => !!bar(), 'the approval bar');
    expect(bar()!.textContent).toContain('Ada asks to save a job');
    type(box(), 'a draft');
    // Approved on the Approvals page (or by auto review, or in another tab).
    views.ap1 = view('ap1', { status: 'approved', decidedVia: 'user' });
    await act(async () => vi.advanceTimersByTime(5_000));
    await until(() => !bar(), 'the bar to lift');
    expect(decisions).toEqual([]);
    expect(box().value).toBe('a draft');
    // The registry is not in the renderer's deps: the cards never remount.
    expect(kit.deps.size).toBe(1);
});

it('Show request scrolls to the card, focuses it and highlights it for a moment', async () => {
    open(async () => kit.agent.setMessages(history()));
    await until(() => !!bar(), 'the approval bar');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    click(bar()!, 'Show request');
    const anchor = host.querySelector<HTMLElement>('[data-approval-id="ap2"]')!;
    expect(scrolled.at(-1)).toBe(anchor);
    expect(document.activeElement).toBe(anchor);
    expect(anchor.dataset.highlight).toBe('true');
    act(() => vi.advanceTimersByTime(HIGHLIGHT_MS));
    expect(anchor.dataset.highlight).toBeUndefined();
});

it('sends as before while a request waits: a new turn, the requests stay', async () => {
    const run = vi.spyOn(kit.copilotkit, 'runAgent').mockImplementation(async () => {
        kit.agent.setMessages([
            ...kit.agent.messages,
            { id: 'a9', role: 'assistant', content: 'Here is the comparison.' },
        ]);
        return { newMessages: [{ role: 'assistant' }] };
    });
    open(async () => kit.agent.setMessages(history()));
    await until(() => !!bar(), 'the approval bar');
    type(box(), 'Compare it with last month');
    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(false);
    act(() => send.click());
    await until(() => host.textContent!.includes('Here is the comparison.'), 'the reply');
    expect(run).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');
    expect(bar()!.querySelector('[data-slot="approval-count"]')!.textContent).toBe('1 of 2');
});

/** The chat chrome's classes from style.css and transcript.css (CB-95). */
const legacyChrome = [
    'live-chat',
    'chat-persona',
    'chat-persona-actions',
    'chat-model',
    'icon-button',
    'on-call',
    'page-chat-context',
    'chat-transcript',
    'chat-transcript-content',
    'chat-transcript-end',
    'chat-welcome',
    'eyebrow',
    'muted',
    'chat-error',
    'chat-composer',
    'drop-active',
    'source-input',
    'chat-compose-row',
    'send-button',
    'chat-compose-note',
    'scroll-to-end-anchor',
    'scroll-to-end',
    'approval-anchor',
    'approval-bar',
    'approval-bar-text',
    'approval-bar-title',
    'approval-bar-count',
    'approval-bar-summary',
    'approval-bar-actions',
    'attachment-tray-wrap',
    'attachment-tray',
    'attachment-item',
];

it('draws its chrome with the new components, 16 px fields on phones (CB-95, CB-96)', async () => {
    open(async () => kit.agent.setMessages(history()));
    await until(() => !!bar(), 'the approval bar');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Add source page link"]')!.click());
    const frame = host.firstElementChild!;
    // The frame, its header and composer, and the card's anchor; the
    // message list inside keeps its own classes.
    const chrome = [
        frame,
        ...frame.children,
        ...frame.querySelectorAll('[data-slot="chat-header"] *'),
        ...frame.querySelectorAll('form[data-slot="chat-composer"] *'),
        frame.querySelector('[data-approval-id="ap2"]')!,
    ];
    const classes = new Set(chrome.flatMap((element) => [...element.classList]));
    for (const name of legacyChrome) {
        expect(classes.has(name), name).toBe(false);
    }
    // iOS zooms into a field under 16 px: phones get 16, wider screens less.
    // The model picker is a Select's button (CB-257), which iOS leaves alone.
    expect(host.querySelector('[aria-label="Model for this chat"]')!.tagName).toBe('BUTTON');
    for (const label of ['Message your socio', 'Source page URL']) {
        const field = host.querySelector(`[aria-label="${label}"]`)!;
        expect(
            [...field.classList].some((name) => name.startsWith('text-base')),
            label,
        ).toBe(true);
        expect(
            [...field.classList].some((name) => name.startsWith('md:text-')),
            label,
        ).toBe(true);
    }
});
