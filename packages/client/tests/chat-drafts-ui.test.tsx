import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot, User } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { DRAFT_KEY_PREFIX, forgetDrafts } from '../src/modules/chat/chat-drafts';
import { forgetSessionMemory } from '../src/shell/auth-channel';
import { CurrentUser } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';
import { DotChat } from '../src/views/ChatViews';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * CB-153: unsent composer text is kept per person and chat. The stand-in
 * for CopilotKit is chat-reconnect-ui.test.tsx's: its connect replays
 * what the test's "server" stored, and the test scripts its runs.
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
    };
    const fail = async (error: unknown) => {
        for (const fn of errors) {
            fn({ error, context: { agentId: agent.agentId } });
        }
    };
    return {
        agent,
        errors,
        fail,
        // What the server has; a connect replays it, or fails with `away`.
        server: {
            stored: [] as Message[],
            away: false,
            health: [] as Array<{ ok: boolean; draining?: boolean } | 'down'>,
        },
        runs: [] as Message[][],
        attached: undefined as undefined | (() => Promise<void>),
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
                if (kit.server.away) {
                    await fail(new TypeError('Failed to fetch'));
                    return { newMessages: [] };
                }
                // As CopilotKit's: it only adds what the replay has and the chat
                // doesn't show yet (reconnect-follow-up.test.ts).
                const shown = new Set(agent.messages.map((message) => message.id));
                agent.setMessages([
                    ...agent.messages,
                    ...kit.server.stored.filter((message) => !shown.has(message.id)),
                ]);
                // Reattached to a run still going: it streams until that ends.
                const attached = kit.attached;
                kit.attached = undefined;
                await attached?.();
                return { newMessages: [] };
            }),
            runAgent: vi.fn(async (_: { agent: unknown }) => {
                kit.runs.push(agent.messages);
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
const chat = (id: string): Conversation => ({
    id,
    dotId: 'd1',
    ownerId: 'bob',
    title: `Chat ${id}`,
    createdAt: 1,
});
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const alice: User = { id: 'alice', name: 'Alice', role: 'member' };
const earlier: Message[] = [
    { id: 'u0', role: 'user', content: 'Earlier question' },
    { id: 'a0', role: 'assistant', content: 'Earlier answer' },
];
const draining = Object.assign(new Error('HTTP 503: {"error":"Socio is updating.","code":"draining"}'), {
    status: 503,
    payload: { error: 'Socio is updating.', code: 'draining' },
});
const answer = (text: string) => {
    const reply: Message = { id: `a-${text}`, role: 'assistant', content: text };
    kit.agent.addMessage(reply);
    kit.server.stored = [...kit.agent.messages];
    return { newMessages: [reply] };
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    localStorage.clear();
    forgetDrafts();
    kit.server.stored = [...earlier];
    kit.server.away = false;
    kit.server.health = [];
    kit.runs = [];
    kit.agent.messages = [];
    kit.run = async () => answer('Sure');
    kit.copilotkit.connectAgent.mockClear();
    kit.copilotkit.runAgent.mockClear();
    kit.attached = undefined;
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        if (path === '/healthz') {
            const next = kit.server.health.shift() ?? { ok: true };
            if (next === 'down') {
                throw new TypeError('Failed to fetch');
            }
            return json(next);
        }
        if (path.endsWith('/page-context')) {
            return json(null);
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
const text = () => host.textContent ?? '';
const notice = () => host.querySelector('[data-slot="chat-notice"]')?.textContent ?? '';
const box = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;
const kept = () => Object.keys(localStorage).filter((key) => key.startsWith(DRAFT_KEY_PREFIX));

async function open(id = 'c1', user: User = bob) {
    await act(async () =>
        root.render(
            <CurrentUser.Provider value={user}>
                <Chat
                    key={`${user.id}:${id}`}
                    thread={chat(id)}
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
    await until(() => text().includes('Earlier answer'), 'the conversation');
}
/** Leaves the chat (another page, a closed tab). */
async function leave() {
    await act(async () => root.render(<div />));
}
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
async function type(message: string, field: () => HTMLTextAreaElement | null = box) {
    await act(async () => {
        setValue.call(field(), message);
        field()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function submit() {
    await act(async () =>
        host
            .querySelector('form[data-slot="chat-composer"]')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
}

it('keeps each chat’s unsent text when switching chats and back', async () => {
    await open('c1');
    await type('Half a thought for c1');
    await open('c2');
    expect(box().value).toBe('');
    await type('Another for c2');
    await open('c1');
    expect(box().value).toBe('Half a thought for c1');
    await open('c2');
    expect(box().value).toBe('Another for c2');
    // Never sent on its own.
    expect(kit.runs).toHaveLength(0);
});

it('keeps text typed during a running turn when leaving and coming back, and never sends it', async () => {
    await open();
    let finish!: () => void;
    kit.run = () =>
        new Promise((resolve) => {
            finish = () => resolve(answer('Done thinking'));
        });
    await type('First question');
    await submit();
    await until(() => kit.runs.length === 1, 'the turn to start');
    expect(box().value).toBe('');
    await type('A follow-up for later');
    await leave();
    await open();
    expect(box().value).toBe('A follow-up for later');
    await act(async () => finish());
    await until(() => text().includes('Done thinking'), 'the answer');
    expect(box().value).toBe('A follow-up for later');
    expect(kit.runs).toHaveLength(1);
});

it('keeps the text across a reload', async () => {
    await open();
    await type('Survives a reload');
    await leave();
    // A reload: this tab's memory is gone, the browser's storage stays.
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await open();
    expect(box().value).toBe('Survives a reload');
});

it('clears the draft once sent, and when its text is deleted', async () => {
    await open();
    await type('Send me');
    expect(kept()).toHaveLength(1);
    await submit();
    await until(() => text().includes('Sure'), 'the answer');
    expect(box().value).toBe('');
    expect(kept()).toHaveLength(0);
    await type('Changed my mind');
    expect(kept()).toHaveLength(1);
    await type('');
    expect(kept()).toHaveLength(0);
    await leave();
    await open();
    expect(box().value).toBe('');
});

it('puts a message that never left back in the box, even after leaving the chat while it waited', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        await kit.fail(draining);
        return { newMessages: [] };
    };
    await type('Sent during the deploy');
    await submit();
    await until(() => !!notice(), 'the updating notice');
    await leave();
    kit.server.health = [];
    await open();
    expect(box().value).toBe('Sent during the deploy');
    expect(kit.runs).toHaveLength(1);
});

it('after a reload, gives back a sent message the server never got, and not one it has', async () => {
    const marker = (id: string, sent: string) =>
        localStorage.setItem(
            `${DRAFT_KEY_PREFIX}bob:chat:c1`,
            JSON.stringify({ text: '', at: 1, sending: { id, text: sent } }),
        );
    marker('lost', 'Lost in the reload');
    await open();
    await until(() => box().value === 'Lost in the reload', 'the text back');
    expect(kit.runs).toHaveLength(0);
    await leave();
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    kit.server.stored = [...earlier, { id: 'arrived', role: 'user', content: 'Arrived before the reload' }];
    marker('arrived', 'Arrived before the reload');
    await open();
    await until(() => kept().length === 0, 'the marker to settle');
    expect(box().value).toBe('');
});

it('keeps drafts per person, drops another person’s, and forgets them all on sign-out', async () => {
    await open('c1', bob);
    await type('Bob’s private draft');
    await open('c1', alice);
    expect(box().value).toBe('');
    expect(kept().some((key) => key.includes('bob'))).toBe(false);
    await type('Alice’s draft');
    expect(kept()).toEqual([`${DRAFT_KEY_PREFIX}alice:chat:c1`]);
    await leave();
    forgetSessionMemory();
    expect(kept()).toHaveLength(0);
    await open('c1', alice);
    expect(box().value).toBe('');
});

it('keeps the new-chat box’s text per socio until the chat starts', async () => {
    let started = false;
    const shell = {
        state: { settings: { paused: false } },
        workspace: {
            user: bob,
            dots: [dot],
            setup: { model: true, telegram: 'not_configured' },
        },
        admin: false,
        configured: true,
        busy: false,
        newConversation: async () => started,
        openDialog: () => {},
        openTarget: () => {},
        pane: false,
        setPane: () => {},
    } as unknown as Shell;
    const newChat = async () => {
        const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
            initialEntries: ['/dots/d1'],
        });
        await act(async () =>
            root.render(
                <CurrentUser.Provider value={bob}>
                    <ShellContext.Provider value={shell}>
                        <RouterProvider router={router} />
                    </ShellContext.Provider>
                </CurrentUser.Provider>,
            ),
        );
    };
    const field = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Start a conversation"]');
    const start = () =>
        act(async () =>
            host
                .querySelector('form[data-slot="new-chat-composer"]')!
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
    await newChat();
    await type('An idea for a new chat', field);
    await leave();
    await newChat();
    expect(field()!.value).toBe('An idea for a new chat');
    // The chat didn't start: the text stays.
    await start();
    expect(field()!.value).toBe('An idea for a new chat');
    started = true;
    await start();
    await until(() => field()!.value === '', 'the box to empty');
    expect(kept()).toHaveLength(0);
});

it('keeps a message shown as not sent in the draft, so coming back gives it back (CB-154)', async () => {
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
    await type('Refused here');
    await submit();
    await until(() => !!host.querySelector('[data-delivery="failed"]'), 'the message not sent');
    // Shown in place, with Retry: not in the box twice.
    expect(box().value).toBe('');
    expect(kept()).toHaveLength(1);
    await leave();
    await open();
    await until(() => box().value === 'Refused here', 'the text back');
    expect(kit.runs).toHaveLength(1);
});

/** A send the server refuses for good (not for an update). */
const refuse = async () => {
    await kit.fail(
        Object.assign(new Error('HTTP 403: {"error":"Not yours."}'), {
            status: 403,
            payload: { error: 'Not yours.' },
        }),
    );
    return { newMessages: [] };
};
const failed = () => !!host.querySelector('[data-delivery="failed"]');

it('gives back a message not sent after a reload, though another was sent after it (CB-154)', async () => {
    await open();
    kit.run = refuse;
    await type('A, refused');
    await submit();
    await until(failed, 'A not sent');
    kit.run = async () => answer('B answered');
    await type('B, sent');
    await submit();
    await until(() => text().includes('B answered'), 'B’s answer');
    expect(box().value).toBe('');
    await leave();
    await open();
    await until(() => box().value === 'A, refused', 'A back in the box');
});

it('gives back a message not sent after a reload next to what was typed since (CB-154)', async () => {
    await open();
    kit.run = refuse;
    await type('A, refused');
    await submit();
    await until(failed, 'A not sent');
    await type('Typed since');
    await leave();
    await open();
    await until(() => box().value === 'Typed since\n\nA, refused', 'both in the box');
});
