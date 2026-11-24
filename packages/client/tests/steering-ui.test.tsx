import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { QueuedMessage } from '@socio/shared/chat/steering';
import type { Conversation, Dot } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { sameFiles } from '../src/modules/chat/QueuedMessages';
import type { PageContext } from '../src/modules/pages/page-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * A stand-in for CopilotKit as in chat-reconnect-ui.test.tsx: its connect
 * replays what the test's "server" stored onto what the chat shows, and
 * the test scripts its run.
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
// Uploads answer at once, with the attachment's reference (CB-223).
vi.mock('../src/modules/chat/attachments/upload', async (original) => ({
    ...(await original<typeof import('../src/modules/chat/attachments/upload')>()),
    uploadAttachment: vi.fn(async (file: File) => ({
        item: {},
        attachment: {
            id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
            name: file.name,
            mediaType: file.type,
            size: file.size,
            kind: 'image',
        },
    })),
}));
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
const earlier: Message[] = [
    { id: 'u0', role: 'user', content: 'Earlier question' },
    { id: 'a0', role: 'assistant', content: 'Earlier answer' },
];
const answer = (text: string) => {
    const reply: Message = { id: `a-${text}`, role: 'assistant', content: text };
    kit.agent.addMessage(reply);
    kit.server.stored = [...kit.agent.messages];
    return { newMessages: [reply] };
};

/** The server's steering queue for the chat (CB-151), and what was asked of it. */
let queue: QueuedMessage[] = [];
/** The queue's limit (CB-170), and the turn the server started with it. */
let limit = 5;
let serverTurn: string | undefined;
/** A turn runs in the conversation, as the server says (CB-223). */
let serverRunning = false;
/** Another tab fills the queue just before the next POST. */
let filledElsewhere = false;
/** The page the chat is about, if any. */
let page: PageContext | null = null;
let requests: Array<{ method: string; path: string; body?: unknown }> = [];

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    // The waits between attempts at their shortest (750 ms).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    kit.server.stored = [...earlier];
    kit.server.away = false;
    kit.server.health = [];
    kit.runs = [];
    kit.agent.messages = [];
    kit.copilotkit.connectAgent.mockClear();
    kit.copilotkit.runAgent.mockClear();
    kit.copilotkit.stopAgent.mockReset();
    kit.attached = undefined;
    queue = [];
    limit = 5;
    serverTurn = undefined;
    serverRunning = false;
    filledElsewhere = false;
    page = null;
    requests = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
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
            return json(page);
        }
        const steering = path.match(/^\/api\/conversations\/c1\/steering(?:\/(.+))?$/);
        if (steering) {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            const method = init?.method ?? 'GET';
            requests.push({ method, path, body });
            const id = steering[1];
            const at = queue.findIndex((message) => message.id === id);
            if (id && at < 0) {
                return json({ error: 'That message has gone to your socio already.' }, 409);
            }
            const view = () => ({
                messages: queue,
                limit,
                ...(serverTurn && { turn: serverTurn }),
                ...(serverRunning && { running: true }),
            });
            if (method === 'POST' && filledElsewhere) {
                filledElsewhere = false;
                while (queue.length < limit) {
                    queue.push({
                        id: `other${queue.length + 1}`,
                        text: 'From another tab',
                        createdAt: 1,
                        updatedAt: 1,
                    });
                }
            }
            if (method === 'POST' && queue.length >= limit) {
                return json(
                    {
                        error: `Up to ${limit} messages can wait for your socio.`,
                        code: 'queue_full',
                        limit,
                    },
                    429,
                );
            }
            if (method === 'POST') {
                const message: QueuedMessage = {
                    id: `q${queue.length + 1}`,
                    text: body.text,
                    ...(body.attachments && {
                        attachments: (body.attachments as Array<{ id: string }>).map(({ id }) => ({
                            id,
                            name: 'screenshot.png',
                            mediaType: 'image/png',
                            size: 4,
                            kind: 'image' as const,
                        })),
                    }),
                    createdAt: 1,
                    updatedAt: 1,
                };
                queue.push(message);
                return json({ message, ...view() }, 201);
            }
            if (method === 'PATCH') {
                const kept = (body.attachments as Array<{ id: string }> | undefined)?.map(({ id }) => id);
                const files = kept
                    ? queue[at].attachments?.filter((file) => kept.includes(file.id))
                    : queue[at].attachments;
                queue[at] = {
                    ...queue[at],
                    text: body.text,
                    ...(files?.length ? { attachments: files } : { attachments: undefined }),
                };
            }
            if (method === 'DELETE') {
                queue.splice(at, 1);
            }
            return json(view());
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
const error = () => host.querySelector('[data-slot="chat-error"]')?.textContent ?? '';
const box = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;

async function open({ paused = false } = {}) {
    await act(async () =>
        root.render(
            <Chat
                thread={thread}
                dot={dot}
                onConsumed={() => {}}
                voiceReady={false}
                calls={[]}
                paused={paused}
                onSaved={() => {}}
                onSchedule={() => {}}
            />,
        ),
    );
    await until(() => text().includes('Earlier answer'), 'the conversation');
}
async function type(message: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(box(), message);
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
        host
            .querySelector('form[data-slot="chat-composer"]')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
}

const queuedBubbles = () =>
    [...host.querySelectorAll('[data-queued-message]')].map((element) => element.textContent ?? '');
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const transcript = () => host.querySelector('[data-chat-transcript]')?.textContent ?? '';

/** A turn the test ends: `finish` answers it, the server then storing `next`. */
function runningTurn() {
    let finish!: (reply: string, next?: Message[]) => void;
    kit.run = () =>
        new Promise((resolve) => {
            finish = (reply, next) => {
                resolve(answer(reply));
                if (next) {
                    kit.server.stored = next;
                }
            };
        });
    return {
        finish: (reply: string, next?: Message[]) => act(async () => finish(reply, next)),
    };
}

it('queues what is sent while the socio works, shows it waiting, and keeps Stop', async () => {
    await open();
    const turn = runningTurn();
    await type('Fetch the rows');
    await until(() => !!button('Stop response'), 'the running turn');
    // Typing shows the queue button beside Stop.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(box(), 'Use page 2 instead');
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Queue message')).not.toBeNull();
    expect(button('Stop response')).not.toBeNull();
    await type('Use page 2 instead');
    await until(() => queuedBubbles().length === 1, 'the queued message');
    expect(requests).toContainEqual({
        method: 'POST',
        path: '/api/conversations/c1/steering',
        body: { text: 'Use page 2 instead' },
    });
    expect(queuedBubbles()[0]).toContain('Use page 2 instead');
    expect(queuedBubbles()[0]).toContain('Queued · Socio reads this after its current step');
    // Not sent as a turn of its own, and the box is free again.
    expect(kit.runs).toHaveLength(1);
    expect(box().value).toBe('');
    expect(error()).toBe('');
    expect(button('Queue message')).toBeNull();
    expect(button('Stop response')).not.toBeNull();

    // The turn takes it: it shows in the transcript, once, not as queued.
    await act(async () =>
        kit.agent.addMessage({
            id: 'q1',
            role: 'user',
            content: 'Use page 2 instead',
        }),
    );
    expect(queuedBubbles()).toEqual([]);
    expect(transcript().split('Use page 2 instead').length - 1).toBe(1);
    queue.splice(0);
    await turn.finish('Switched to page 2');
    await until(() => !button('Stop response'), 'the turn to end');
    expect(transcript()).toContain('Switched to page 2');
    expect(queuedBubbles()).toEqual([]);
});

it('edits and cancels a queued message, and says when it has gone already', async () => {
    queue = [
        { id: 'q1', text: 'First note', createdAt: 1, updatedAt: 1 },
        { id: 'q2', text: 'Second note', createdAt: 2, updatedAt: 2 },
    ];
    await open();
    // Shown after a reload, waiting for the Dot's next turn.
    await until(() => queuedBubbles().length === 2, 'the queue');
    expect(queuedBubbles()[0]).toContain('Queued · Socio reads this on its next turn');
    const first = host.querySelector('[data-queued-message="q1"]')!;
    await act(async () =>
        [...first.querySelectorAll('button')].find((element) => element.textContent === 'Edit')!.click(),
    );
    const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Edit queued message"]')!;
    expect(editor.value).toBe('First note');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(editor, 'First note, edited');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
        [...first.querySelectorAll('button')].find((element) => element.textContent === 'Save')!.click(),
    );
    await until(() => queuedBubbles()[0].includes('First note, edited'), 'the edit');
    expect(requests).toContainEqual({
        method: 'PATCH',
        path: '/api/conversations/c1/steering/q1',
        body: { text: 'First note, edited' },
    });
    await act(async () =>
        host
            .querySelector<HTMLButtonElement>('[data-queued-message="q2"] [aria-label="Cancel queued message"]')!
            .click(),
    );
    await until(() => queuedBubbles().length === 1, 'the cancel');
    expect(requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/api/conversations/c1/steering/q2',
    });

    // Taken by a turn meanwhile: too late, and the list catches up.
    queue.splice(0);
    await act(async () =>
        host
            .querySelector<HTMLButtonElement>('[data-queued-message="q1"] [aria-label="Cancel queued message"]')!
            .click(),
    );
    await until(() => queuedBubbles().length === 0, 'the list to catch up');
});

it('follows the turn the server starts with what a turn ended before taking', async () => {
    await open();
    const turn = runningTurn();
    await type('Fetch the rows');
    await until(() => !!button('Stop response'), 'the running turn');
    await type('Also page 3');
    await until(() => queuedBubbles().length === 1, 'the queued message');
    const connects = kit.copilotkit.connectAgent.mock.calls.length;
    // The server takes it and starts the next turn with it as the first
    // ends, before the chat hears of the end.
    queue.splice(0);
    const [sent] = kit.runs[0].slice(-1);
    await turn.finish('Here are the rows', [
        ...earlier,
        sent,
        {
            id: 'a-Here are the rows',
            role: 'assistant',
            content: 'Here are the rows',
        },
        { id: 'q1', role: 'user', content: 'Also page 3' },
        { id: 'a-3', role: 'assistant', content: 'Page 3 too' },
    ]);
    await until(() => transcript().includes('Page 3 too'), 'the next turn');
    expect(kit.copilotkit.connectAgent.mock.calls.length).toBe(connects + 1);
    expect(queuedBubbles()).toEqual([]);
    expect(transcript().split('Also page 3').length - 1).toBe(1);
    expect(kit.runs).toHaveLength(1);
});

/** A turn the person stops: Stop ends it in the chat, as CopilotKit's does. */
function stoppableTurn() {
    let end!: () => void;
    kit.run = () => new Promise((resolve) => (end = () => resolve({ newMessages: [] })));
    kit.copilotkit.stopAgent.mockImplementation(() => end());
}
async function queueTwo() {
    await type('Fetch the rows');
    await until(() => !!button('Stop response'), 'the running turn');
    await type('First thing');
    await until(() => queuedBubbles().length === 1, 'the first queued message');
    await type('Second thing');
    await until(() => queuedBubbles().length === 2, 'the second queued message');
}

it('keeps what waits through Stop and follows the turn that sends it next (CB-170)', async () => {
    await open();
    stoppableTurn();
    await queueTwo();
    const [sent] = kit.runs[0].slice(-1);
    const connects = kit.copilotkit.connectAgent.mock.calls.length;
    // The chat reconnects to the stopped turn, which ends a moment later.
    let stoppedEnds!: () => void;
    kit.attached = () => new Promise<void>((done) => (stoppedEnds = done));
    await act(async () => button('Stop response')!.click());
    expect(kit.copilotkit.stopAgent).toHaveBeenCalledTimes(1);
    await until(() => kit.copilotkit.connectAgent.mock.calls.length === connects + 1, 'the reconnect');
    // Never dropped: both still wait, to edit or cancel.
    expect(queuedBubbles()).toHaveLength(2);
    expect(host.querySelectorAll('[aria-label="Cancel queued message"]')).toHaveLength(2);

    // The stopped turn ends; then the server starts the next with both.
    queue.splice(0);
    serverTurn = 'run-2';
    kit.server.stored = [
        ...earlier,
        sent,
        { id: 'q1', role: 'user', content: 'First thing' },
        { id: 'q2', role: 'user', content: 'Second thing' },
        { id: 'a-both', role: 'assistant', content: 'Both read' },
    ];
    await act(async () => stoppedEnds());
    await until(() => transcript().includes('Both read'), 'the next turn');
    expect(kit.copilotkit.connectAgent.mock.calls.length).toBe(connects + 2);
    expect(queuedBubbles()).toEqual([]);
    const shown = transcript();
    expect(shown.split('First thing').length - 1).toBe(1);
    expect(shown.split('Second thing').length - 1).toBe(1);
    expect(shown.indexOf('First thing')).toBeLessThan(shown.indexOf('Second thing'));
    // Sent by the server, not again by the chat.
    expect(kit.runs).toHaveLength(1);
    serverTurn = undefined;
    await until(() => !button('Stop response'), 'the turn to end');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(kit.copilotkit.connectAgent.mock.calls.length).toBe(connects + 2);
});

it('lets the person cancel a queued message after Stop (CB-170)', async () => {
    await open();
    stoppableTurn();
    await queueTwo();
    let stoppedEnds!: () => void;
    kit.attached = () => new Promise<void>((done) => (stoppedEnds = done));
    await act(async () => button('Stop response')!.click());
    await until(() => !!host.querySelector('[data-queued-message="q1"]'), 'the queue after Stop');
    await act(async () =>
        host
            .querySelector<HTMLButtonElement>('[data-queued-message="q1"] [aria-label="Cancel queued message"]')!
            .click(),
    );
    await until(() => queuedBubbles().length === 1, 'the cancel');
    expect(requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/api/conversations/c1/steering/q1',
    });
    expect(queuedBubbles()[0]).toContain('Second thing');
    await act(async () => stoppedEnds());
});

it('keeps the text in the box with a calm note when the queue is full (CB-170)', async () => {
    limit = 2;
    await open();
    runningTurn();
    await queueTwo();
    const posts = () => requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    await type('Third thing');
    // Not sent: the box keeps it, and a quiet note says why.
    expect(posts()).toBe(before);
    expect(box().value).toBe('Third thing');
    const note = () => host.querySelector('[data-slot="chat-notice"]')?.textContent ?? '';
    expect(note()).toBe(
        '2 messages are waiting for Socio, as many as a chat can queue. Yours stays here until Socio reads them, or you cancel one.',
    );
    expect(button('Queue message')!.disabled).toBe(true);
    expect(error()).toBe('');
    expect(queuedBubbles()).toHaveLength(2);

    // Room again once one is canceled.
    await act(async () =>
        host
            .querySelector<HTMLButtonElement>('[data-queued-message="q1"] [aria-label="Cancel queued message"]')!
            .click(),
    );
    await until(() => queuedBubbles().length === 1, 'the cancel');
    expect(note()).toBe('');
    expect(button('Queue message')!.disabled).toBe(false);

    // Filled from another tab meanwhile: the server says no, calmly too.
    filledElsewhere = true;
    await type('Third thing');
    await until(() => queuedBubbles().length === 2, 'the queue read again');
    expect(box().value).toBe('Third thing');
    expect(note()).toContain('2 messages are waiting for Socio');
    expect(error()).toBe('');
    expect(queuedBubbles().join()).not.toContain('Third thing');
});

it('sends and queues what was typed in a page chat, the page only in its banner (CB-158)', async () => {
    page = { id: 'p1', spaceId: 's1', title: 'Opportunity dashboard' };
    await open();
    const banner = () => host.querySelector('[data-slot="page-chat-context"]')?.textContent;
    await until(() => !!banner(), 'the page banner');
    expect(banner()).toBe('Working on Opportunity dashboard');
    const bubble = (id: string) => host.querySelector(`[data-message-id="${id}"] [data-chat-body]`)!;
    const turn = runningTurn();
    const typed = 'Ok now when do you keep working on the goal?';
    await type(typed);
    await until(() => !!button('Stop response'), 'the running turn');
    const sent = kit.runs[0].at(-1)!;
    expect(sent).toMatchObject({ role: 'user', content: typed });
    expect(bubble(sent.id).textContent).toBe(typed);
    // Queued while the Dot works: as typed too, a skill's name first.
    await type('/grill-me ship Friday');
    await until(() => queuedBubbles().length === 1, 'the queued message');
    expect(requests).toContainEqual({
        method: 'POST',
        path: '/api/conversations/c1/steering',
        body: { text: '/grill-me ship Friday' },
    });
    queue.splice(0);
    await turn.finish('At 10:00.');
    await until(() => !button('Stop response'), 'the turn to end');
    // A skill sent from the page chat is found, and shows as its chip.
    runningTurn();
    await type('/grill-me ship Friday');
    await until(() => kit.runs.length === 2, 'the second turn');
    const skill = kit.runs[1].at(-1)!;
    expect(skill.content).toBe('/grill-me ship Friday');
    await until(() => !!bubble(skill.id).querySelector('[data-slot="skill-chip"]'), 'the skill chip');
    expect(bubble(skill.id).textContent).toBe('/grill-meship Friday');
    expect(transcript()).not.toContain('From ');
});

/** Picks `file` with the composer's paperclip, and waits for its upload. */
async function attach(file: File) {
    const input = host.querySelector<HTMLInputElement>('[data-slot="attachment-input"]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await until(() => !!host.querySelector('[aria-label="Attachments to send"]'), 'the attachment in the tray');
}
const screenshot = () =>
    new File([new Uint8Array([137, 80, 78, 71])], 'screenshot.png', {
        type: 'image/png',
    });
async function typeOnly(message: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(box(), message);
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

// CB-223: a screenshot in the box kept the queue button disabled, with the
// reason only in a tooltip a phone never shows: the person could not send
// while the socio worked. A message with attachments queues as one
// without does, and goes once the reply is done.
it('queues a message with an attachment while the socio works, with Enter on a desktop (CB-223)', async () => {
    await open();
    const turn = runningTurn();
    await type('Fetch the rows');
    await until(() => !!button('Stop response'), 'the running turn');
    await attach(screenshot());
    await typeOnly('This is what I see');
    const queue = button('Queue message')!;
    expect(queue).not.toBeNull();
    expect(queue.disabled).toBe(false);
    expect(queue.title).toBe('Socio reads it once its reply is done');
    // Enter sends it, as it sends a message between turns.
    await act(async () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await until(() => queuedBubbles().length === 1, 'the queued message');
    expect(requests).toContainEqual({
        method: 'POST',
        path: '/api/conversations/c1/steering',
        body: {
            text: 'This is what I see',
            attachments: [{ id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA' }],
        },
    });
    // It shows waiting with its file; the box and its tray are free again.
    const bubble = host.querySelector('[data-queued-message="q1"]')!;
    expect(bubble.textContent).toContain('This is what I see');
    expect(bubble.querySelector('[data-chat-body="queued"] ul')).not.toBeNull();
    expect(bubble.textContent).toContain('Queued · Socio reads this once its reply is done');
    expect(host.querySelector('[aria-label="Attachments to send"]')).toBeNull();
    expect(box().value).toBe('');
    expect(kit.runs).toHaveLength(1);
    expect(error()).toBe('');
    await turn.finish('Here are the rows');
});

it('queues text and an attachment at a phone’s width with the queue button (CB-223)', async () => {
    // A phone: 390 px wide, a touch screen, where Enter adds a line.
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(hover: none) and (pointer: coarse)',
        addEventListener() {},
        removeEventListener() {},
    }));
    await open();
    const turn = runningTurn();
    await type('Fetch the rows');
    await until(() => !!button('Stop response'), 'the running turn');

    // Words alone: the queue button beside Stop sends them.
    await typeOnly('Use page 2 instead');
    await act(async () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
    expect(button('Queue message')!.disabled).toBe(false);
    await act(async () => button('Queue message')!.click());
    await until(() => queuedBubbles().length === 1, 'the queued words');

    // A screenshot alone, no words: it queues too, after them.
    await attach(screenshot());
    expect(button('Queue message')!.disabled).toBe(false);
    await act(async () => button('Queue message')!.click());
    await until(() => queuedBubbles().length === 2, 'the queued screenshot');
    expect(requests.filter((request) => request.method === 'POST').map((request) => request.body)).toEqual([
        { text: 'Use page 2 instead' },
        { text: '', attachments: [{ id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA' }] },
    ]);
    expect(queuedBubbles()[0]).toContain('Queued · Socio reads this after its current step');
    expect(queuedBubbles()[1]).toContain('Queued · Socio reads this once its reply is done');
    expect(kit.runs).toHaveLength(1);
    expect(error()).toBe('');
    await turn.finish('Here are the rows');
});

/**
 * The chat opened (a reload) while a turn runs on the server: its connect
 * streams that turn until `end`.
 */
async function reloadMidTurn() {
    kit.server.stored = [...earlier, { id: 'u1', role: 'user', content: 'Fetch the rows' }];
    serverRunning = true;
    let ended!: () => void;
    kit.attached = () => new Promise<void>((resolve) => (ended = resolve));
    await open();
    return {
        end: () =>
            act(async () => {
                serverRunning = false;
                answer('Here are the rows');
                ended();
            }),
    };
}

// CB-223: reloaded during a turn, the chat showed only a disabled Send
// until the turn ended, so nothing could be queued. It now shows the turn
// running, with Stop and Queue, as for a turn sent from this tab.
it('shows a turn running after a reload, with Stop and Queue, on a desktop (CB-223)', async () => {
    const turn = await reloadMidTurn();
    await until(() => !!button('Stop response'), 'the running turn');
    expect(button('Send message')).toBeNull();
    await typeOnly('Use page 2 instead');
    expect(button('Queue message')!.disabled).toBe(false);
    await type('Use page 2 instead');
    await until(() => queuedBubbles().length === 1, 'the queued message');
    expect(requests).toContainEqual({
        method: 'POST',
        path: '/api/conversations/c1/steering',
        body: { text: 'Use page 2 instead' },
    });
    expect(queuedBubbles()[0]).toContain('Queued · Socio reads this after its current step');
    // Stop stops the server's turn, as it does one sent from here.
    await act(async () => button('Stop response')!.click());
    expect(kit.copilotkit.stopAgent).toHaveBeenCalledTimes(1);
    expect(kit.runs).toHaveLength(0);
    queue.splice(0);
    await turn.end();
    await until(() => !button('Stop response'), 'the turn to end');
    expect(button('Send message')).not.toBeNull();
    expect(transcript()).toContain('Here are the rows');
});

it('shows a turn running after a reload, with Stop and Queue, at a phone’s width (CB-223)', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(hover: none) and (pointer: coarse)',
        addEventListener() {},
        removeEventListener() {},
    }));
    const turn = await reloadMidTurn();
    await until(() => !!button('Stop response'), 'the running turn');
    await typeOnly('Use page 2 instead');
    expect(button('Queue message')!.disabled).toBe(false);
    await act(async () => button('Queue message')!.click());
    await until(() => queuedBubbles().length === 1, 'the queued message');
    expect(box().value).toBe('');
    expect(kit.runs).toHaveLength(0);
    queue.splice(0);
    await turn.end();
    await until(() => !button('Stop response'), 'the turn to end');
    expect(button('Send message')).not.toBeNull();
});

it('says in words beside the box why it can’t send what is in it (CB-223)', async () => {
    const note = () =>
        [...host.querySelectorAll('[data-slot="chat-notice"]')].map((element) => element.textContent).join(' ');
    // Still connecting: no turn runs, but the connect hasn't ended.
    let connected!: () => void;
    kit.attached = () => new Promise<void>((resolve) => (connected = resolve));
    await open();
    await typeOnly('Hello');
    expect(button('Send message')!.disabled).toBe(true);
    expect(note()).toContain('Connecting to your conversation. You can send once it’s ready.');
    await act(async () => connected());
    await until(() => !button('Send message')!.disabled, 'the chat to connect');
    expect(note()).toBe('');
    act(() => root.unmount());
    root = createRoot(host);

    // Paused: the message stays in the box, and it says so.
    await open({ paused: true });
    await typeOnly('Hello');
    expect(button('Send message')!.disabled).toBe(true);
    expect(note()).toContain('Socio is paused, so your message stays here until an admin resumes it.');
});

it('edits a queued message with files down to its files, or takes a file off (CB-223)', async () => {
    const file = (id: string, name: string) => ({
        id,
        name,
        mediaType: 'image/png',
        size: 4,
        kind: 'image' as const,
    });
    queue = [
        {
            id: 'q1',
            text: 'Look at these',
            attachments: [
                file('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'before.png'),
                file('cbatt_BBBBBBBBBBBBBBBBBBBBBB', 'after.png'),
            ],
            createdAt: 1,
            updatedAt: 1,
        },
    ];
    await open();
    await until(() => queuedBubbles().length === 1, 'the queue');
    const bubble = () => host.querySelector('[data-queued-message="q1"]')!;
    const press = (label: string) =>
        act(async () =>
            [...bubble().querySelectorAll('button')]
                .find((element) => element.textContent === label || element.getAttribute('aria-label') === label)!
                .click(),
        );
    const editor = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Edit queued message"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const write = (text: string) =>
        act(async () => {
            setValue.call(editor(), text);
            editor().dispatchEvent(new Event('input', { bubbles: true }));
        });
    const save = () => [...bubble().querySelectorAll('button')].find((element) => element.textContent === 'Save')!;

    // Its words gone, its files stay: still a message to save.
    await press('Edit');
    expect(host.querySelector('[aria-label="Files it sends"]')?.textContent).toContain('before.png');
    await write('');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    await until(() => !editor(), 'the edit');
    expect(requests.at(-1)).toEqual({
        method: 'PATCH',
        path: '/api/conversations/c1/steering/q1',
        body: { text: '' },
    });

    // One file taken off; the other goes with it.
    await press('Edit');
    await press('Remove before.png');
    expect(host.querySelector('[aria-label="Files it sends"]')?.textContent).not.toContain('before.png');
    await act(async () => save().click());
    await until(() => !editor(), 'the second edit');
    expect(requests.at(-1)).toEqual({
        method: 'PATCH',
        path: '/api/conversations/c1/steering/q1',
        body: { text: '', attachments: [{ id: 'cbatt_BBBBBBBBBBBBBBBBBBBBBB' }] },
    });
    expect(queue[0].attachments?.map((kept) => kept.name)).toEqual(['after.png']);

    // The last file off, with no words: nothing left to save.
    await press('Edit');
    await press('Remove after.png');
    expect(save().disabled).toBe(true);
    await write('Just words now');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    await until(() => !editor(), 'the third edit');
    expect(requests.at(-1)).toEqual({
        method: 'PATCH',
        path: '/api/conversations/c1/steering/q1',
        body: { text: 'Just words now', attachments: [] },
    });
    expect(queuedBubbles()[0]).toContain('Just words now');
});

it('keeps a queued message’s files as they are only when the edit keeps the same ones, by id (CB-223)', () => {
    const file = (id: string) => ({
        id,
        name: `${id}.png`,
        mediaType: 'image/png',
        size: 4,
        kind: 'image' as const,
    });
    const [a, b] = [file('a'), file('b')];
    expect(sameFiles([a, b], [b, a])).toBe(true);
    // This tab took a off, another took b off: as many, not the same, so
    // the edit names b, which the server refuses, and never keeps a.
    expect(sameFiles([b], [a])).toBe(false);
    expect(sameFiles([a], [a, b])).toBe(false);
    expect(sameFiles([], [])).toBe(true);
});
