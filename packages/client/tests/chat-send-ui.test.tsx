import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { placeOutgoing, type Outgoing } from '../src/modules/chat/outgoing';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * CB-154: a stand-in for CopilotKit whose agent adds a message as AG-UI's
 * does, onto the same array, and tells its subscribers when a turn
 * starts; the test scripts the run.
 */
const kit = vi.hoisted(() => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    const subscribers = new Set<{ onRunStartedEvent?: () => void }>();
    const errors = new Set<(event: { error: unknown; context: object }) => void>();
    const agent = {
        agentId: 'chat-c1',
        messages: [] as Message[],
        setMessages(next: Message[]) {
            agent.messages = next;
            listeners.forEach((fn) => fn());
        },
        addMessage(message: Message) {
            agent.messages.push(message);
            listeners.forEach((fn) => fn());
        },
        subscribe(subscriber: { onRunStartedEvent?: () => void }) {
            subscribers.add(subscriber);
            return { unsubscribe: () => void subscribers.delete(subscriber) };
        },
        listen(fn: Listener) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
        },
    };
    return {
        agent,
        /** The turn starts: the server has its message. */
        start: () => subscribers.forEach((s) => s.onRunStartedEvent?.()),
        fail: async (error: unknown) => {
            for (const fn of errors) {
                fn({ error, context: { agentId: agent.agentId } });
            }
        },
        runs: [] as Message[][],
        /** The chat's page, for a page chat (CB-158). */
        page: null as null | { id: string; spaceId: string; title: string },
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
            connectAgent: vi.fn(async () => ({ newMessages: [] })),
            runAgent: vi.fn(async () => {
                kit.runs.push([...agent.messages]);
                return kit.run();
            }),
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
const answer = (text: string) => {
    const reply: Message = { id: `a-${text}`, role: 'assistant', content: text };
    kit.agent.addMessage(reply);
    return { newMessages: [reply] };
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    kit.runs = [];
    kit.page = null;
    kit.agent.messages = [
        { id: 'u0', role: 'user', content: 'Earlier question' },
        { id: 'a0', role: 'assistant', content: 'Earlier answer' },
    ];
    kit.copilotkit.runAgent.mockClear();
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        if (path.endsWith('/page-context')) {
            return json(kit.page);
        }
        if (path === '/api/me/inference/options') {
            return json({ options: [], automatic: null });
        }
        return json({ error: 'Not here' }, 404);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
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
const box = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;
const yours = () => [...host.querySelectorAll<HTMLElement>('[data-chat-message="user"]')];
const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === name)!;

async function open() {
    await act(async () =>
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
    await until(() => !!host.textContent?.includes('Earlier answer'), 'the conversation');
}
/** Types `message` and sends it, without waiting for the turn. */
async function send(message: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(box(), message);
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
        host.querySelector('form[data-slot="chat-composer"]')!.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
}

it('shows a sent message at once in its place, pending (dashed, never faded) until its turn starts, in the same node throughout (CB-154)', async () => {
    await open();
    let finish!: (value: unknown) => void;
    kit.run = () => new Promise((resolve) => (finish = resolve));
    await send('Hello there');
    // The moment it is sent: the bubble, last, with its action row; no
    // placeholder in its place.
    const bubble = yours().at(-1)!;
    expect(yours()).toHaveLength(2);
    expect(bubble.textContent).toContain('Hello there');
    expect(bubble.dataset.delivery).toBe('sending');
    // Dashed on a light tint, its words at full contrast: never faded.
    const body = bubble.querySelector('[data-chat-body="user"]')!;
    expect(body.className).toContain('in-data-delivery:border-dashed');
    expect(body.className).toContain('in-data-delivery:text-foreground');
    expect(body.className).not.toMatch(/opacity/);
    expect(bubble.querySelector('[data-slot="message-actions"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/Sending message/);
    expect(box().value).toBe('');
    // The server takes it: the bubble's own look, the same node.
    await act(async () => kit.start());
    expect(yours().at(-1)).toBe(bubble);
    expect(bubble.dataset.delivery).toBeUndefined();
    // The reply comes: still the same node, its row still there.
    await act(async () => finish(answer('Hi!')));
    await until(() => !!host.textContent?.includes('Hi!'), 'the reply');
    expect(yours().at(-1)).toBe(bubble);
    expect(bubble.dataset.delivery).toBeUndefined();
    expect(bubble.querySelector('[data-slot="message-actions"]')).not.toBeNull();
    expect(kit.runs).toHaveLength(1);
});

it('keeps a message the server refused, not sent, with Retry that sends it again (CB-154)', async () => {
    await open();
    kit.run = async () => {
        await kit.fail(
            Object.assign(new Error('HTTP 403: {"error":"Not yours."}'), {
                status: 403,
                payload: { error: 'Not yours.' },
            }),
        );
        return { newMessages: [] };
    };
    await send('Please file this');
    const bubble = yours().at(-1)!;
    await until(() => bubble.dataset.delivery === 'failed', 'the failure');
    // The same bubble, its text kept, with what happened and what to do.
    expect(yours().at(-1)).toBe(bubble);
    expect(bubble.textContent).toContain('Please file this');
    expect(bubble.querySelector('[data-slot="message-not-sent"]')!.textContent).toContain('Not sent');
    expect(host.querySelector('[data-slot="chat-error"]')!.textContent).toContain('Not yours.');
    // No turn carries it: it left the agent.
    expect(kit.agent.messages.map((message) => message.id)).toEqual(['u0', 'a0']);
    expect(button('Retry').disabled).toBe(false);
    kit.run = async () => {
        kit.start();
        return answer('Filed');
    };
    await act(async () => button('Retry').click());
    await until(() => !!host.textContent?.includes('Filed'), 'the reply');
    expect(yours().at(-1)).toBe(bubble);
    expect(bubble.dataset.delivery).toBeUndefined();
    expect(host.querySelector('[data-slot="message-not-sent"]')).toBeNull();
    // The same message, sent once more.
    expect(kit.runs).toHaveLength(2);
    expect(kit.runs[1]!.at(-1)!.id).toBe(kit.runs[0]!.at(-1)!.id);
});

it('retries a page chat’s message as typed, never with its page (CB-154, CB-158)', async () => {
    kit.page = { id: 'p1', spaceId: 's1', title: 'Roadmap' };
    await open();
    await until(() => !!host.textContent?.includes('Roadmap'), 'the page banner');
    kit.run = async () => {
        await kit.fail(
            Object.assign(new Error('HTTP 403: {"error":"Not yours."}'), {
                status: 403,
                payload: { error: 'Not yours.' },
            }),
        );
        return { newMessages: [] };
    };
    await send('Tighten the second section');
    await until(() => yours().at(-1)?.dataset.delivery === 'failed', 'the failure');
    kit.run = async () => {
        kit.start();
        return answer('Done');
    };
    await act(async () => button('Retry').click());
    await until(() => !!host.textContent?.includes('Done'), 'the reply');
    expect(kit.runs.map((run) => run.at(-1)!.content)).toEqual([
        'Tighten the second section',
        'Tighten the second section',
    ]);
});

it('announces a message not sent, names Retry and Edit by it, says why Retry waits, and keeps focus off the page (CB-154)', async () => {
    await open();
    kit.run = async () => {
        await kit.fail(
            Object.assign(new Error('HTTP 403: {"error":"Not yours."}'), {
                status: 403,
                payload: { error: 'Not yours.' },
            }),
        );
        return { newMessages: [] };
    };
    await send('Please file this');
    const bubble = yours().at(-1)!;
    // A polite live region, there while it was sending, says so once.
    const live = bubble.querySelector('[aria-live="polite"]')!;
    await until(() => bubble.dataset.delivery === 'failed', 'the failure');
    expect(live.textContent).toBe('Your message “Please file this” wasn’t sent.');
    const retry = () => bubble.querySelector<HTMLButtonElement>('[aria-label^="Retry"]')!;
    expect(retry().getAttribute('aria-label')).toBe('Retry “Please file this”');
    expect(bubble.querySelector('[aria-label="Edit “Please file this”"]')).not.toBeNull();
    // While another message's turn runs: focusable, and it says why not.
    let finish!: (value: unknown) => void;
    kit.run = () => new Promise((resolve) => (finish = resolve));
    await send('Something else');
    expect(retry().getAttribute('aria-disabled')).toBe('true');
    expect(retry().title).toBe('You can retry once the reply is done');
    expect(retry().disabled).toBe(false);
    await act(async () => retry().click());
    expect(kit.runs).toHaveLength(2);
    await act(async () => {
        kit.start();
        finish(answer('Done'));
    });
    await until(() => retry().getAttribute('aria-disabled') === null, 'Retry');
    // Retried: focus goes to the composer, not the page.
    kit.run = async () => {
        kit.start();
        return answer('Filed');
    };
    await act(async () => retry().click());
    expect(document.activeElement).toBe(box());
    await until(() => !!host.textContent?.includes('Filed'), 'the reply');
});

it('places a message not sent after the one it followed', () => {
    const message = (id: string): Message => ({
        id,
        role: 'user',
        content: id,
    });
    const failed = (id: string, after?: string): Outgoing => ({
        message: message(id),
        text: id,
        status: 'failed',
        after,
    });
    const ids = (messages: readonly Message[]) => messages.map((item) => item.id);
    const shown = [message('a'), message('b'), message('c')];
    expect(ids(placeOutgoing(shown, []))).toEqual(['a', 'b', 'c']);
    expect(ids(placeOutgoing(shown, [failed('x', 'a')]))).toEqual(['a', 'x', 'b', 'c']);
    // First in the chat, or after one no longer shown (older history).
    expect(ids(placeOutgoing(shown, [failed('x')]))).toEqual(['x', 'a', 'b', 'c']);
    expect(ids(placeOutgoing(shown, [failed('x', 'gone')]))).toEqual(['a', 'b', 'c', 'x']);
    // One the agent shows is not shown twice.
    expect(ids(placeOutgoing(shown, [failed('b', 'a')]))).toEqual(['a', 'b', 'c']);
});
