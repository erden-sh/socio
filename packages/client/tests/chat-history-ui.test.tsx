import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { HISTORY_AFTER_HEADER } from '@socio/shared/chat/chat-history';
import type { Conversation, Dot } from '@socio/shared/types';

import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';
import { Chat } from '../src/modules/chat/Chat';
import { forgetHistories } from '../src/modules/chat/sync/chat-history';
import { CurrentUser } from '../src/shell/current-user';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';
import { FakeHistory } from './helpers/fake-history';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};

/**
 * CB-136: a long chat on the client store. It shows the store's turns and
 * pages older ones in above, keeping the reader's place; CopilotKit's
 * connection replays only what came after them (the cursor header); another
 * tab's note pulls what's new; a long result loads whole when its step
 * opens; cards render from history; and a turn riding out a restart is
 * never sent twice, though the replay no longer has the whole chat.
 */
const kit = vi.hoisted(() => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    const errors = new Set<(event: { error: unknown; context: object }) => void>();
    const agent = {
        agentId: 'chat-c1',
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
        // AG-UI's request builder, which the chat adds its cursor to and
        // narrows the messages of (CB-156).
        requestInit(input?: { messages: Message[] }): RequestInit {
            return {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...(input ? { body: JSON.stringify(input) } : {}),
            };
        },
    };
    return {
        agent,
        errors,
        // What a connect replays: the turns after the chat's cursor.
        tail: [] as Message[],
        away: false,
        headers: [] as Array<Record<string, string>>,
        run: (async () => undefined) as () => Promise<unknown>,
        copilotkit: {
            subscribe: (subscriber: { onError?: (event: { error: unknown; context: object }) => void }) => {
                if (subscriber.onError) {
                    errors.add(subscriber.onError);
                }
                return {
                    unsubscribe: () => {
                        if (subscriber.onError) {
                            errors.delete(subscriber.onError);
                        }
                    },
                };
            },
            connectAgent: vi.fn(async (_: { agent: unknown }) => {
                kit.headers.push(agent.requestInit().headers as Record<string, string>);
                const shown = new Set(agent.messages.map((message) => message.id));
                agent.setMessages([...agent.messages, ...kit.tail.filter((message) => !shown.has(message.id))]);
                return { newMessages: [] };
            }),
            runAgent: vi.fn(async (_: { agent: unknown }) => kit.run()),
            stopAgent: vi.fn(),
        },
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
        useRenderTool: () => {},
        useHumanInTheLoop: () => {},
        // The cards CopilotKit renders: their tools' names, to check.
        CopilotChatToolCallsView: ({ message }: { message: { toolCalls?: { function: { name: string } }[] } }) =>
            React.createElement(
                'div',
                { 'data-card': '' },
                (message.toolCalls ?? []).map((call) => call.function.name).join(','),
            ),
    };
});

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Dot',
    instructions: 'Dot helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const thread: Conversation = {
    id: 'c1',
    dotId: 'd1',
    ownerId: 'alice',
    title: 'Chat',
    createdAt: 1,
};

let server: FakeHistory;
let fetched: string[];
let root: Root;
let host: HTMLElement;
let other: FakeBroadcastChannel;
beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    forgetHistories();
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    server = new FakeHistory(3);
    fetched = [];
    kit.tail = [];
    kit.away = false;
    kit.headers = [];
    kit.agent.messages = [];
    kit.run = async () => undefined;
    kit.copilotkit.connectAgent.mockClear();
    kit.copilotkit.runAgent.mockClear();
    vi.stubGlobal('fetch', async (input: string) => {
        fetched.push(input);
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        if (path === '/healthz') {
            return json({ ok: true });
        }
        if (path.endsWith('/page-context')) {
            return json(null);
        }
        if (path === '/api/me/inference/options') {
            return json({ options: [], automatic: null });
        }
        return server.respond(input, 'c1') ?? json({ error: 'Not here' }, 404);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    forgetHistories();
    closeChangeChannel();
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
const shown = (text: string) => host.textContent!.includes(text);
const open = () =>
    act(() =>
        root.render(
            <CurrentUser.Provider value={{ id: 'alice', name: 'Alice', role: 'member' }}>
                <Chat
                    thread={thread}
                    dot={dot}
                    onConsumed={() => {}}
                    voiceReady={false}
                    calls={[]}
                    paused={false}
                    onSaved={() => {}}
                    onSchedule={() => {}}
                />
            </CurrentUser.Provider>,
        ),
    );
const turn = (n: number): Message[] => [
    { id: `u${n}`, role: 'user', content: `Question ${n}` },
    { id: `a${n}`, role: 'assistant', content: `Answer ${n}` },
];
const loaded = () =>
    until(
        () =>
            !!host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]') &&
            kit.copilotkit.connectAgent.mock.calls.length > 0,
        'the chat to connect',
    );

it('shows the newest turns, replays none of them on connect, and pages older ones in above, keeping the place', async () => {
    for (let n = 1; n <= 5; n++) {
        server.turn(n);
    }
    open();
    await until(() => shown('Answer 5') && shown('Answer 3'), 'the newest page');
    expect(shown('Answer 2')).toBe(false);
    await loaded();
    // The connection asked only for what comes after the newest run.
    expect(kit.headers[0][HISTORY_AFTER_HEADER]).toBe('50');
    expect(host.textContent!.match(/Answer 5/g)).toHaveLength(1);
    // jsdom lays nothing out: each message is 100 px below the one before.
    const scroller = host.querySelector<HTMLElement>('[data-chat-transcript]')!;
    let scrollTop = 250;
    Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const messages = [...host.querySelectorAll('[data-message-id]')];
        const index = messages.indexOf(this);
        const top = index === -1 ? 0 : index * 100 - scrollTop;
        return {
            top,
            bottom: top + 80,
            left: 0,
            right: 0,
            height: 80,
        } as DOMRect;
    });
    const earlier = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Show earlier messages',
    )!;
    act(() => earlier.click());
    await until(() => shown('Answer 1'), 'the earlier turns');
    expect(server.asked).toContain('before=30');
    // Four messages came in above: the reader's place moved down with them.
    expect(scrollTop).toBe(650);
    // The first turn reached: nothing more to show.
    expect(shown('Show earlier messages')).toBe(false);
});

it('pulls what another tab added when its note comes', async () => {
    for (let n = 1; n <= 2; n++) {
        server.turn(n);
    }
    kit.tail = turn(2);
    open();
    await loaded();
    await until(() => shown('Answer 2'), 'the history');
    server.turn(3);
    kit.tail = [...turn(2), ...turn(3)];
    other.postMessage([{ topic: 'conversation', id: 'c1' }]);
    await until(() => shown('Answer 3'), 'the other tab’s turn');
    expect(server.asked).toContain('after=20');
    expect(host.textContent!.match(/Answer 3/g)).toHaveLength(1);
});

it('loads a long result whole when its step opens, and renders cards from history', async () => {
    server.add(
        [
            { id: 'u1', role: 'user', content: 'Pull the report' },
            {
                id: 'a1',
                role: 'assistant',
                content: 'Here it is.',
                toolCalls: [
                    {
                        id: 'call-big',
                        type: 'function',
                        function: {
                            name: 'query_dataset',
                            arguments: '{"sql":"SELECT 1"}',
                        },
                    },
                    {
                        id: 'call-approval',
                        type: 'function',
                        function: { name: 'send_report', arguments: '{}' },
                    },
                ],
            },
            {
                id: 'r-big',
                role: 'tool',
                toolCallId: 'call-big',
                content: '{"status":"ok","title":"Opportunities"}',
            },
            {
                id: 'r-approval',
                role: 'tool',
                toolCallId: 'call-approval',
                content: JSON.stringify({
                    status: 'pending_approval',
                    approval: { id: 'approval-1' },
                }),
            },
        ],
        {
            light: { 'call-big': 250_000 },
            // When it happened (CB-72), as the server read it from the events.
            times: {
                messages: [['u1', 1_000]],
                tools: [['call-big', { start: 1_500, end: 3_000 }]],
                reasoning: [],
            },
        },
    );
    server.results.set(
        'call-big',
        JSON.stringify({
            status: 'ok',
            title: 'Opportunities',
            rows: [{ name: 'Northwind renewal' }],
        }),
    );
    open();
    await loaded();
    await until(() => shown('Here it is.'), 'the history');
    // The approval's card, from the store's run.
    expect(host.querySelector('[data-card]')!.textContent).toBe('send_report');
    // Its step's time, from the run's times.
    expect(host.querySelector('[data-slot="turn-trace"] summary')!.textContent).toContain('Worked for 2s');
    const toggle = (details: HTMLDetailsElement) =>
        act(() => {
            details.open = true;
            details.dispatchEvent(new Event('toggle'));
        });
    toggle(host.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]')!);
    expect(fetched.some((url) => url.includes('/tool-results/'))).toBe(false);
    toggle(host.querySelector<HTMLDetailsElement>('[data-tool="query_dataset"]')!);
    await until(() => shown('Northwind renewal'), 'the whole result');
    expect(fetched.filter((url) => url.endsWith('/tool-results/call-big'))).toHaveLength(1);
});

for (const stored of [true, false]) {
    it(
        stored
            ? 'never sends a turn twice when the server stored it, though the replay holds only the newest turns'
            : 'sends a turn the server never got again once it is back',
        async () => {
            server.turn(1);
            kit.tail = turn(1);
            open();
            await loaded();
            let attempt = 0;
            kit.run = async () => {
                attempt += 1;
                const message = kit.agent.messages.at(-1)!;
                if (attempt === 1) {
                    // The server took the turn and finished it, then went away
                    // before answering: the stream broke off.
                    if (stored) {
                        server.add([message, { id: 'a-stored', role: 'assistant', content: 'Stored answer' }]);
                    }
                    for (const fn of kit.errors) {
                        fn({
                            error: new TypeError('Failed to fetch'),
                            context: { agentId: 'chat-c1' },
                        });
                    }
                    return undefined;
                }
                const reply: Message = {
                    id: 'a-resent',
                    role: 'assistant',
                    content: 'Answer again',
                };
                kit.agent.addMessage(reply);
                return { newMessages: [reply] };
            };
            const box = host.querySelector('textarea')!;
            act(() => {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Hello there');
                box.dispatchEvent(new Event('input', { bubbles: true }));
            });
            act(() => box.form!.requestSubmit());
            await until(() => (stored ? shown('Stored answer') : shown('Answer again')), 'the turn’s answer');
            expect(kit.copilotkit.runAgent).toHaveBeenCalledTimes(stored ? 1 : 2);
            expect(host.textContent!.match(/Hello there/g)).toHaveLength(1);
        },
    );
}

// CB-156: a turn with a screenshot made every later request carry it, until
// the app refused them all with "Request is too large."
const playTurn = (): Message[] => [
    { id: 'u1', role: 'user', content: 'Question 1' },
    {
        id: 'a1-call',
        role: 'assistant',
        content: '',
        toolCalls: [
            {
                id: 'call-shot',
                type: 'function',
                function: { name: 'computer_screenshot', arguments: '{}' },
            },
        ],
    },
    {
        id: 'shot',
        role: 'tool',
        toolCallId: 'call-shot',
        content: JSON.stringify({ base64: 'A'.repeat(1_800_000) }),
    },
    { id: 'a1', role: 'assistant', content: 'Answer 1' },
];
const type = (text: string) => {
    const box = host.querySelector('textarea')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => box.form!.requestSubmit());
};

it('sends only the new message after a turn with a screenshot, and still shows the whole chat', async () => {
    server.turn(1);
    kit.tail = playTurn();
    open();
    await loaded();
    const bodies: string[] = [];
    kit.run = async () => {
        bodies.push(String(kit.agent.requestInit({ messages: kit.agent.messages }).body));
        const reply: Message = { id: 'a2', role: 'assistant', content: 'Watching' };
        kit.agent.addMessage(reply);
        return { newMessages: [reply] };
    };
    type('I wanna watch you play');
    await until(() => shown('Watching'), 'the answer');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].length).toBeLessThan(1_000);
    const sent = (JSON.parse(bodies[0]) as { messages: Message[] }).messages;
    expect(sent.map((message) => message.content)).toEqual(['I wanna watch you play']);
    // The agent keeps the turn it replayed, screenshot and all.
    expect(kit.agent.messages.some((message) => message.id === 'shot')).toBe(true);
    expect(shown('Answer 1')).toBe(true);
});

it('puts a message the server refused for its size back in the box, calmly, and leaves it out of later requests', async () => {
    server.turn(1);
    kit.tail = turn(1);
    open();
    await loaded();
    kit.run = async () => {
        for (const fn of kit.errors) {
            fn({
                error: Object.assign(new Error('HTTP 413: {"error":"Request is too large."}'), {
                    status: 413,
                    payload: { error: 'Request is too large.' },
                }),
                context: { agentId: 'chat-c1' },
            });
        }
        return undefined;
    };
    type('A very long paste');
    await until(
        () => shown('That message is too long to send. Shorten it or attach it as a file, then send it again.'),
        'the notice',
    );
    expect(host.textContent).not.toMatch(/too large/i);
    expect(host.querySelector('textarea')!.value).toBe('A very long paste');
    expect(kit.agent.messages.some((message) => message.content === 'A very long paste')).toBe(false);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Reconnect')).toBe(false);
});

it('keeps Reconnect for a connect the server refused for its size, without "too large"', async () => {
    server.turn(1);
    kit.copilotkit.connectAgent.mockImplementationOnce(async () => {
        for (const fn of kit.errors) {
            fn({
                error: Object.assign(new Error('HTTP 413: {"error":"Request is too large."}'), {
                    status: 413,
                    payload: { error: 'Request is too large.' },
                }),
                context: { agentId: 'chat-c1' },
            });
        }
        return { newMessages: [] };
    });
    open();
    await until(() => shown('Conversation could not connect.'), 'the notice');
    expect(host.textContent).not.toMatch(/too large|too long/i);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Reconnect')).toBe(true);
});
