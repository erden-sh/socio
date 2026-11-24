import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';
import { Chat } from '../src/modules/chat/Chat';
import { hasUnseenMessages } from '../src/modules/chat/use-follow-run';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * CB-74: the same chat open in two tabs. The rendered chat is tab B;
 * `other` is tab A's end of the changes channel. CopilotKit is a stand-in
 * whose connect replays `server` (what the runner stored).
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
            runAgent: async (_: { agent: unknown }): Promise<{ newMessages: Message[] }> => ({ newMessages: [] }),
            stopAgent: () => {},
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
        CopilotChatToolCallsView: () => null,
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
const first: Message[] = [
    { id: 'u1', role: 'user', content: 'Plan my week.' },
    { id: 'a1', role: 'assistant', content: 'Here is a plan.' },
];
const fromTabA: Message[] = [
    { id: 'u2', role: 'user', content: 'Add a gym day.' },
    { id: 'a2', role: 'assistant', content: 'Thursday is gym day.' },
];

// What the server stored for c1.
let server: Message[];
let requests: string[];
let other: FakeBroadcastChannel;
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    server = [...first];
    requests = [];
    kit.agent.messages = [];
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    vi.spyOn(kit.copilotkit, 'connectAgent').mockImplementation(async () => {
        kit.agent.setMessages([...server]);
    });
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push(path);
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
        if (path === '/api/conversations/c1/transcript') {
            return json({
                conversation: thread,
                messages: server.map(({ id, role, content }) => ({
                    id,
                    role,
                    text: content,
                    content,
                })),
            });
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
    closeChangeChannel();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 200)));
const text = () => host.textContent ?? '';
// What this tab posted (tab A's own messages are on `other`).
const posted = () =>
    FakeBroadcastChannel.posted.filter((entry) => entry.name === CHANGES_CHANNEL && entry.data !== noteForC1);
let noteForC1: unknown;
const noteFromTabA = (id = 'c1') => {
    noteForC1 = [{ topic: 'conversation', id }];
    other.postMessage(noteForC1);
};

async function openChat() {
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
    await until(() => text().includes('Here is a plan.'), 'the chat');
    await settle();
}

it('a message sent in another tab, and the reply, show here without a reload', async () => {
    await openChat();
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(1);
    server = [...first, ...fromTabA];
    noteFromTabA();
    await until(() => text().includes('Thursday is gym day.'), 'the reply');
    expect(text()).toContain('Add a gym day.');
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(2);
    await settle();
    // The catch-up tells no tab anything: no ping-pong.
    expect(posted()).toEqual([]);
    // Nor does the Dot look busy, or the composer stay held.
    expect(host.querySelector('[aria-label="Stop response"]')).toBeNull();
});

it('a note with nothing new here reads the transcript only', async () => {
    await openChat();
    requests = [];
    noteFromTabA();
    await until(() => requests.includes('/api/conversations/c1/transcript'), 'the transcript');
    await settle();
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(1);
    expect(posted()).toEqual([]);
});

it('a note about another chat asks nothing about this one', async () => {
    await openChat();
    requests = [];
    noteFromTabA('c2');
    await settle();
    expect(requests).not.toContain('/api/conversations/c1/transcript');
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(1);
});

it('a note during a turn of this tab catches up once the turn is over', async () => {
    await openChat();
    let finish: () => void = () => {};
    vi.spyOn(kit.copilotkit, 'runAgent').mockImplementation(async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        const reply: Message = {
            id: 'a3',
            role: 'assistant',
            content: 'Noted here.',
        };
        kit.agent.addMessage(reply);
        return { newMessages: [reply] };
    });
    const box = host.querySelector<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;
    act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(box, 'From tab B.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => box.form!.requestSubmit());
    await until(() => !!host.querySelector('[aria-label="Stop response"]'), 'the turn');
    // Tab A's turn landed meanwhile.
    server = [...first, ...fromTabA];
    requests = [];
    noteFromTabA();
    await settle();
    expect(requests).not.toContain('/api/conversations/c1/transcript');
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(1);
    // This tab's turn ends (the server has it after tab A's).
    server = [
        ...server,
        ...kit.agent.messages.slice(first.length),
        { id: 'a3', role: 'assistant', content: 'Noted here.' },
    ];
    act(() => finish());
    await until(() => text().includes('Thursday is gym day.'), 'the catch-up');
    expect(text()).toContain('Noted here.');
    expect(kit.copilotkit.connectAgent).toHaveBeenCalledTimes(2);
    await settle();
    // One note: this tab's own turn. The catch-up made none.
    expect(posted().map((entry) => entry.data)).toEqual([[{ topic: 'conversation', id: 'c1' }]]);
});

it('tells a new message by its id', () => {
    expect(hasUnseenMessages(first, first)).toBe(false);
    expect(hasUnseenMessages(first, [{ id: 'u1' }])).toBe(false);
    expect(hasUnseenMessages(first, [...first, { id: 'u2' }])).toBe(true);
});
