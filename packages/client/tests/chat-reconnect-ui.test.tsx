import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { pause } from '../src/shell/reconnect';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * CB-108: a stand-in for CopilotKit whose connect replays what the test's
 * "server" stored onto what the chat shows and whose run the test scripts, reporting failures to
 * the core's subscribers as CopilotKit does (it never throws them).
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
            /** An error a connect ends with, the server explaining it. */
            connectError: undefined as unknown,
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
                if (kit.server.connectError) {
                    await fail(kit.server.connectError);
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
let healthChecks: number;
beforeEach(() => {
    // The waits between attempts at their shortest (750 ms).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    kit.server.stored = [...earlier];
    kit.server.away = false;
    kit.server.connectError = undefined;
    kit.server.health = [];
    kit.runs = [];
    kit.agent.messages = [];
    kit.copilotkit.connectAgent.mockClear();
    kit.copilotkit.runAgent.mockClear();
    kit.copilotkit.stopAgent.mockReset();
    kit.attached = undefined;
    healthChecks = 0;
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        if (path === '/healthz') {
            healthChecks++;
            const next = kit.server.health.shift() ?? { ok: true };
            if (next === 'down') {
                throw new TypeError('Failed to fetch');
            }
            return json(next);
        }
        if (path.endsWith('/page-context')) {
            return json(null);
        }
        // What the server stored, as the chat's history asks it (CB-154).
        if (path === '/api/conversations/c1/transcript') {
            return json({ messages: kit.server.stored });
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
const error = () => host.querySelector('[data-slot="chat-error"]')?.textContent ?? '';
const box = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;

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
const sentIds = () => kit.runs.map((run) => run.at(-1)?.id);
/** Your message shown as not sent (CB-154), with Retry and Edit. */
const notSent = () => host.querySelector<HTMLElement>('[data-chat-message="user"][data-delivery="failed"]');
const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === name)!;

it('holds a turn refused while draining, says "Updating…", and sends it once the next server is up', async () => {
    await open();
    kit.server.health = [{ ok: true, draining: true }, 'down', { ok: true }];
    let refused = true;
    kit.run = async () => {
        if (refused) {
            refused = false;
            await kit.fail(draining);
            return { newMessages: [] };
        }
        return answer('Back after the update');
    };
    await type('Hello during the deploy');
    await until(() => !!notice(), 'the updating notice');
    expect(notice()).toBe('Socio is updating. Your message will send as soon as it’s back.');
    expect(text()).toContain('Updating…');
    expect(text()).toContain('Hello during the deploy');
    expect(error()).toBe('');
    await until(() => text().includes('Back after the update'), 'the answer');
    expect(notice()).toBe('');
    expect(error()).toBe('');
    expect(healthChecks).toBe(3);
    // Sent twice: refused, then once more with the same message.
    expect(kit.runs).toHaveLength(2);
    expect(new Set(sentIds()).size).toBe(1);
    expect(kit.server.stored.filter((message) => message.role === 'user')).toHaveLength(2);
});

it('never sends a turn twice: one the server took before it went away shows from the replay', async () => {
    await open();
    kit.server.health = ['down', { ok: true }];
    kit.run = async () => {
        // The server stored the turn and its answer, then the stream broke.
        const [turn] = kit.agent.messages.slice(-1);
        kit.server.stored = [...earlier, turn!, { id: 'a1', role: 'assistant', content: 'Stored before the restart' }];
        await kit.fail(new TypeError('network error'));
        return { newMessages: [] };
    };
    await type('Hello as it restarts');
    await until(() => text().includes('Stored before the restart'), 'the stored answer');
    expect(kit.runs).toHaveLength(1);
    expect(notice()).toBe('');
    expect(error()).toBe('');
    expect(kit.agent.messages.filter((message) => message.role === 'user')).toHaveLength(2);
});

it('reconnects an opened chat on its own while the server is away', async () => {
    kit.server.away = true;
    kit.server.health = ['down'];
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
    await until(() => !!notice(), 'the reconnecting notice');
    expect(notice()).toBe('Socio is updating. Reconnecting…');
    expect(error()).toBe('');
    kit.server.away = false;
    await until(() => text().includes('Earlier answer'), 'the conversation');
    expect(notice()).toBe('');
    expect(kit.copilotkit.connectAgent.mock.calls.length).toBeGreaterThan(1);
});

it('keeps a message stopped while waiting as not sent, to retry or edit (CB-154)', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        await kit.fail(draining);
        return { newMessages: [] };
    };
    await type('Never mind');
    await until(() => !!notice(), 'the updating notice');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    await until(() => !notice(), 'the notice to go');
    // In its place, not sent; out of the agent, so no turn carries it.
    expect(notSent()!.textContent).toContain('Never mind');
    expect(notSent()!.textContent).toContain('Not sent');
    expect(kit.agent.messages.some((message) => message.content === 'Never mind')).toBe(false);
    expect(box().value).toBe('');
    expect(kit.runs).toHaveLength(1);
    expect(kit.copilotkit.stopAgent).not.toHaveBeenCalled();
    expect(error()).toBe('');
    // Edit takes it back to the box.
    await act(async () => button('Edit').click());
    expect(box().value).toBe('Never mind');
    expect(host.querySelector('[data-chat-transcript]')!.textContent).not.toContain('Never mind');
    expect(kit.runs).toHaveLength(1);
});

it('still shows an error the server explained', async () => {
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
    await type('Hello');
    await until(() => !!error(), 'the error');
    expect(error()).toContain('Not yours.');
    expect(notice()).toBe('');
    expect(kit.runs).toHaveLength(1);
});

it('stops the run it reattached to, keeping the turn the server has, and never offers to send it again', async () => {
    await open();
    kit.run = async () => {
        // The server took the turn and is still answering when the stream
        // breaks (a phone puts the app away).
        const [turn] = kit.agent.messages.slice(-1);
        kit.server.stored = [...earlier, turn!];
        kit.attached = () =>
            new Promise<void>((resolve) => {
                kit.agent.addMessage({
                    id: 'a1',
                    role: 'assistant',
                    content: 'Half a reply',
                });
                kit.copilotkit.stopAgent.mockImplementation(() => resolve());
            });
        await kit.fail(new TypeError('network error'));
        return { newMessages: [] };
    };
    await type('Hello from the phone');
    await until(() => text().includes('Half a reply'), 'the reattached reply');
    // The reply streams: no "Updating…" while it does.
    expect(notice()).toBe('');
    expect(text()).not.toContain('Updating…');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    expect(kit.copilotkit.stopAgent).toHaveBeenCalledTimes(1);
    await until(() => !host.querySelector('[aria-label="Stop response"]'), 'the turn to end');
    const transcript = host.querySelector('[data-chat-transcript]')!.textContent;
    expect(transcript).toContain('Hello from the phone');
    expect(transcript).toContain('Half a reply');
    expect(box().value).toBe('');
    expect(error()).toBe('');
    expect(kit.runs).toHaveLength(1);
});

it('keeps a turn the server may have when stopped while waiting, and shows it not sent once a reconnect shows it never arrived', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        await kit.fail(new TypeError('network error'));
        return { newMessages: [] };
    };
    await type('Did this arrive?');
    await until(() => !!notice(), 'the updating notice');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    await until(() => !!error(), 'the error');
    expect(error()).toContain('Reconnect to see whether your message arrived');
    // Shown, dimmed: whether it arrived isn't known (CB-154).
    expect(host.querySelector('[data-chat-message="user"][data-delivery="sending"]')!.textContent).toContain(
        'Did this arrive?',
    );
    expect(box().value).toBe('');
    expect(kit.copilotkit.stopAgent).not.toHaveBeenCalled();
    // The server never had it: the reconnect's replay shows so.
    kit.server.health = [];
    await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="chat-error"] button')!.click());
    await until(() => !!notSent(), 'the message not sent');
    expect(notSent()!.textContent).toContain('Did this arrive?');
    expect(box().value).toBe('');
    expect(kit.runs).toHaveLength(1);
    // Retry sends the same message.
    kit.run = async () => answer('Arrived this time');
    await act(async () => button('Retry').click());
    await until(() => text().includes('Arrived this time'), 'the answer');
    expect(notSent()).toBeNull();
    expect(kit.runs).toHaveLength(2);
    expect(new Set(sentIds()).size).toBe(1);
});

it('never gives back a turn the server has when the run carrying on after its review is refused', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        // The server took the turn and answered with a page review...
        const [turn] = kit.agent.messages.slice(-1);
        const review: Message = {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 'review1',
                    type: 'function',
                    function: { name: 'review_space_page', arguments: '{}' },
                },
            ],
        };
        kit.agent.addMessage(review);
        kit.server.stored = [...earlier, turn!, review];
        // ...then started draining. The person approves, and the run that
        // carries on (CopilotKit's, inside the turn's) is refused.
        kit.agent.addMessage({
            id: 't1',
            role: 'tool',
            toolCallId: 'review1',
            content: '{"approved":true}',
        });
        await kit.fail(draining);
        return { newMessages: [] };
    };
    await type('Draft my notes');
    await until(() => !!notice(), 'the updating notice');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    await until(() => !!error(), 'the error');
    // Not "wasn't sent": the server has it.
    expect(error()).toContain('Reconnect to see whether your message arrived');
    expect(box().value).toBe('');
    expect(host.querySelector('[data-chat-transcript]')!.textContent).toContain('Draft my notes');
    // The reconnect's replay has the turn and the review, still to decide.
    kit.server.health = [];
    await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="chat-error"] button')!.click());
    await until(() => !kit.agent.messages.some((message) => message.id === 't1'), 'the replay');
    expect(kit.agent.messages.map((message) => message.id)).toEqual(['u0', 'a0', sentIds()[0], 'a1']);
    expect(box().value).toBe('');
    expect(error()).toBe('');
    expect(kit.runs).toHaveLength(1);
});

it('says it is offline, not updating, while the browser has no network, and sends the turn once it is back online', async () => {
    await open();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => void window.dispatchEvent(new Event('offline')));
    // Offline, nothing answers.
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    let offline = true;
    kit.run = async () => {
        if (offline) {
            offline = false;
            await kit.fail(new TypeError('Failed to fetch'));
            return { newMessages: [] };
        }
        return answer('Back online');
    };
    await type('Hello from the train');
    await until(() => !!notice(), 'the offline notice');
    expect(notice()).toBe('You’re offline. Your message will send once you’re back online.');
    expect(text()).toContain('Offline');
    expect(text()).not.toMatch(/updating/i);
    expect(error()).toBe('');
    // Back online: it asks at once and sends the turn, as after an update.
    onLine.mockReturnValue(true);
    kit.server.health = [];
    await act(async () => void window.dispatchEvent(new Event('online')));
    await until(() => text().includes('Back online'), 'the answer');
    expect(notice()).toBe('');
    expect(error()).toBe('');
    expect(kit.runs).toHaveLength(2);
    expect(new Set(sentIds()).size).toBe(1);
});

it('still says updating for a turn refused while draining when the browser is online', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        await kit.fail(draining);
        return { newMessages: [] };
    };
    await type('Hello during the deploy');
    await until(() => !!notice(), 'the updating notice');
    expect(notice()).toBe('Socio is updating. Your message will send as soon as it’s back.');
    expect(text()).not.toMatch(/offline/i);
});

it('ends a wait between attempts once the browser is back online', async () => {
    const started = Date.now();
    const waited = pause(10_000);
    window.dispatchEvent(new Event('online'));
    await waited;
    expect(Date.now() - started).toBeLessThan(1000);
    const stop = new AbortController();
    const stopped = pause(10_000, stop.signal);
    stop.abort();
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
});

it('settles a message given up on once a later one is taken: never dimmed for good (CB-154)', async () => {
    await open();
    kit.server.health = Array.from({ length: 50 }, () => 'down' as const);
    kit.run = async () => {
        // The server stored it, then the stream broke.
        const [turn] = kit.agent.messages.slice(-1);
        kit.server.stored = [...earlier, turn!];
        await kit.fail(new TypeError('network error'));
        return { newMessages: [] };
    };
    await type('First, stored after all');
    await until(() => !!notice(), 'the updating notice');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    await until(() => !!error(), 'the error');
    expect(host.querySelector('[data-delivery="sending"]')!.textContent).toContain('First, stored after all');
    // No Reconnect: another message instead.
    kit.server.health = [];
    kit.run = async () => answer('Second answered');
    await type('Second message');
    await until(() => text().includes('Second answered'), 'the answer');
    await until(() => !host.querySelector('[data-delivery]'), 'the first to settle');
    expect(text()).toContain('First, stored after all');
});

it('shows a message as not sent when the reconnect after a break fails with an error the server explained (CB-154)', async () => {
    await open();
    kit.server.health = [{ ok: true }];
    kit.run = async () => {
        await kit.fail(new TypeError('network error'));
        return { newMessages: [] };
    };
    kit.server.connectError = Object.assign(new Error('HTTP 500: {"error":"Broken."}'), {
        status: 500,
        payload: { error: 'Broken.' },
    });
    await type('Did it go?');
    await until(() => !!notSent(), 'the message not sent');
    expect(notSent()!.textContent).toContain('Did it go?');
    expect(kit.runs).toHaveLength(1);
});

it('never shows a message the server stored as not sent when stopped before its turn started, and Retry only shows one it has (CB-154)', async () => {
    await open();
    kit.run = async () => {
        // Stored, then stopped before RUN_STARTED reached the browser.
        const [turn] = kit.agent.messages.slice(-1);
        kit.server.stored = [...earlier, turn!];
        return { newMessages: [] };
    };
    await type('Stored, then stopped');
    await until(() => !host.querySelector('[aria-label="Stop response"]'), 'the turn to end');
    await until(() => !host.querySelector('[data-delivery]'), 'the message to settle');
    expect(notSent()).toBeNull();
    // Refused, then the server has it after all: Retry sends nothing.
    kit.run = async () => {
        await kit.fail(
            Object.assign(new Error('HTTP 403: {"error":"Not yours."}'), {
                status: 403,
                payload: { error: 'Not yours.' },
            }),
        );
        return { newMessages: [] };
    };
    await type('Refused, then there');
    await until(() => !!notSent(), 'the message not sent');
    const id = notSent()!.dataset.messageId!;
    kit.server.stored = [...kit.server.stored, { id, role: 'user', content: 'Refused, then there' }];
    await act(async () => button('Retry').click());
    await until(() => !notSent(), 'the message to settle');
    expect(text()).toContain('Refused, then there');
    expect(kit.runs).toHaveLength(2);
});
