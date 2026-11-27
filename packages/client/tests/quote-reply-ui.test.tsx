import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILT_IN_SKILLS, invokedSkill } from '@socio/shared/chat/chat-skills';
import { quoteOf, QUOTED_COMMAND_NOTE, splitQuote, withQuote } from '@socio/shared/chat/quote-reply';
import { parseRoomMentions } from '@socio/shared/rooms/room-mentions';
import { messageTargets } from '@socio/shared/rooms/room-view';
import type { RoomSocioView, RoomView } from '@socio/shared/rooms/rooms';
import type { Conversation, Dot, MessageAuthor, User } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { chatTakesReplies, messageReplyAuthor, type ReplyTo } from '../src/modules/chat/quote-reply';
import { CurrentUser } from '../src/shell/current-user';

// Quote-reply on the web (CB-571): the app's format from shared, Reply where
// the app offers it, the chip, the draft keeping the quote, quote-only sends
// refused, and a quoted message drawn as a quote. Rooms' half is in
// rooms-ui.test.tsx.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/** A stand-in for CopilotKit (chat-send-ui.test.tsx's): the test scripts the run. */
const kit = vi.hoisted(() => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    const subscribers = new Set<{ onRunStartedEvent?: () => void }>();
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
        runs: [] as Message[][],
        copilotkit: {
            subscribe: () => ({ unsubscribe: () => {} }),
            connectAgent: vi.fn(async () => ({ newMessages: [] })),
            runAgent: vi.fn(async () => {
                kit.runs.push([...agent.messages]);
                const reply: Message = { id: `a-${kit.runs.length}`, role: 'assistant', content: 'Noted.' };
                agent.addMessage(reply);
                return { newMessages: [reply] };
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
    name: 'Archiver',
    instructions: 'Archiver helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const chat: Conversation = { id: 'c1', dotId: 'd1', ownerId: 'ada', title: 'Chat', createdAt: 1 };
const ADA: User = { id: 'ada', name: 'Ada', role: 'member' };
/** The app's own case (apps/mobile/tests/chat/quote-reply.test.ts): the same input, the same bytes. */
const REPLY_TEXT = 'Yes! erden means *to ground*.';
const APP_PREFIX = '> **Archiver:** Yes! erden means \\*to ground\\*.';

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    kit.runs = [];
    kit.agent.messages = [
        { id: 'u0', role: 'user', content: 'What does erden mean?' },
        { id: 'a0', role: 'assistant', content: REPLY_TEXT },
    ];
    localStorage.clear();
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const box = () => $<HTMLTextAreaElement>('[aria-label="Message your socio"]')!;
const sendButton = () => $<HTMLButtonElement>('button[aria-label="Send message"]')!;
const replyOn = (id: string) => $<HTMLButtonElement>(`[data-message-id="${id}"] [data-message-reply]`);
const chip = () => $('[data-slot="quote-chip"]');
const note = () => $('[data-slot="quote-command-note"]')!;
const click = (element: Element | null | undefined) => act(() => (element as HTMLElement).click());
async function type(value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(box(), value);
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const submit = () =>
    act(() => {
        $('form[data-slot="chat-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

async function open(thread: Conversation = chat, user: User | undefined = ADA) {
    await act(async () =>
        root.render(
            <CurrentUser value={user}>
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
            </CurrentUser>,
        ),
    );
    await until(() => !!host.textContent?.includes('erden means'), 'the conversation');
}

describe('the format, from shared', () => {
    it('is the app’s, byte for byte, for the same input', () => {
        const quote = quoteOf('Archiver', REPLY_TEXT);
        expect(quote.prefix).toBe(APP_PREFIX);
        expect(withQuote(quote, 'Thanks')).toBe(`${APP_PREFIX}\n\nThanks`);
    });

    it('keeps a quoted @mention inert: it neither mentions nor routes', () => {
        const sent = withQuote(quoteOf('Bob', 'Ask @Ledger and @Alice about it'), 'ok');
        expect(sent).toContain('@\u2060Ledger');
        expect(
            parseRoomMentions(sent, {
                socios: [{ id: 'd2', name: 'Ledger' }],
                people: [{ id: 'alice', name: 'Alice' }],
            }),
        ).toEqual({ socios: [], people: [] });
        const socios: RoomSocioView[] = [
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
            { dotId: 'd2', name: 'Ledger', status: 'active', lead: false },
        ];
        expect(messageTargets(sent, socios).map((socio) => socio.name)).toEqual(['Sebas']);
    });

    it('makes a quote and a command after it no command: shared’s invokedSkill finds none', () => {
        expect(invokedSkill('/done', BUILT_IN_SKILLS)?.skill.name).toBe('done');
        expect(invokedSkill(withQuote(quoteOf('Archiver', REPLY_TEXT), '/done'), BUILT_IN_SKILLS)).toBeUndefined();
    });
});

describe('where Reply is offered', () => {
    const room: RoomView = {
        id: 'r1',
        title: 'Launch room',
        dotId: 'd1',
        createdAt: 1,
        createdBy: 'ada',
        convertedAt: null,
        archivedAt: null,
        role: 'member',
        roomsEnabled: true,
        members: [
            {
                userId: 'ada',
                name: 'Ada Lovelace',
                role: 'member',
                status: 'active',
                invitedBy: null,
                invitedAt: 1,
                inviteExpiresAt: null,
                acceptedAt: 1,
            },
        ],
        socios: [{ dotId: 'd1', name: 'Sebas', status: 'active', lead: true }],
    };
    const reply: Message = { id: 'a', role: 'assistant', content: 'Hello' };
    const mine: Message & { author: MessageAuthor } = {
        id: 'u',
        role: 'user',
        content: 'Hi',
        author: { id: 'ada', name: 'Ada', you: true },
    };
    const bobs: Message & { author: MessageAuthor } = {
        id: 'b',
        role: 'user',
        content: 'Hey',
        author: { id: 'bob', name: 'Bob', you: false },
    };
    const inRoom = { socio: 'Sebas', room: { view: room, me: 'ada' } };

    it('on a socio’s reply in a chat, never on your own message there', () => {
        expect(messageReplyAuthor(reply, 'Hello', { socio: 'Archiver' })).toBe('Archiver');
        expect(messageReplyAuthor(mine, 'Hi', { socio: 'Archiver' })).toBeNull();
    });

    it('in a room on the socio’s replies and on everyone’s messages, yours by your name in the room', () => {
        expect(messageReplyAuthor(reply, 'Hello', inRoom)).toBe('Sebas');
        expect(messageReplyAuthor(bobs, 'Hey', inRoom)).toBe('Bob');
        expect(messageReplyAuthor(mine, 'Hi', inRoom)).toBe('Ada Lovelace');
    });

    it('never on a reply still being written, or one with no words', () => {
        expect(messageReplyAuthor(reply, 'Hel', { socio: 'Archiver', streaming: true })).toBeNull();
        expect(messageReplyAuthor(reply, '  ', { socio: 'Archiver' })).toBeNull();
    });

    it('not in a team topic or a Telegram chat, whose composers are read-only', () => {
        expect(chatTakesReplies(chat)).toBe(true);
        expect(chatTakesReplies({ ...chat, team: true })).toBe(false);
        expect(chatTakesReplies({ ...chat, source: 'telegram' })).toBe(false);
    });

    it('draws no Reply on a streaming reply, and puts Reply first in the action row', () => {
        const to: ReplyTo = {
            author: (message, text, streaming) => messageReplyAuthor(message, text, { socio: 'Archiver', streaming }),
            quote: () => {},
        };
        act(() =>
            root.render(
                <ChatTranscript
                    messages={[
                        { id: 'u1', role: 'user', content: 'One' },
                        { id: 'a1', role: 'assistant', content: 'Done' },
                        { id: 'u2', role: 'user', content: 'Two' },
                        { id: 'a2', role: 'assistant', content: 'Writ' },
                    ]}
                    calls={[]}
                    streamingId="a2"
                    running
                    reply={to}
                />,
            ),
        );
        expect(
            [...host.querySelectorAll('[data-message-reply]')].map((button) =>
                button.closest('[data-message-id]')!.getAttribute('data-message-id'),
            ),
        ).toEqual(['a1']);
        const row = $('[data-message-id="a1"] [data-slot="message-actions"]')!;
        expect(row.querySelector('button')!.getAttribute('aria-label')).toBe('Reply');
    });
});

describe('in a private chat', () => {
    it('offers Reply on the socio’s reply only, by keyboard and by name', async () => {
        await open();
        expect(replyOn('u0')).toBeNull();
        const button = replyOn('a0')!;
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('aria-label')).toBe('Reply');
        expect(button.tabIndex).not.toBe(-1);
        expect(button.closest('[data-slot="message-actions"]')!.querySelector('button')).toBe(button);
    });

    it('offers none in a Telegram chat', async () => {
        await open({ ...chat, source: 'telegram' });
        expect(host.querySelector('[data-message-reply]')).toBeNull();
    });

    it('quotes over the box, keeps what was typed, refuses a quote alone and sends the app’s bytes', async () => {
        await open();
        await type('Half a thought');
        await click(replyOn('a0'));
        expect(chip()!.textContent).toContain('Replying to Archiver');
        expect($('[data-slot="quote-chip-excerpt"]')!.textContent).toBe('Yes! erden means *to ground*.');
        expect(chip()!.querySelector('button')!.getAttribute('aria-label')).toBe('Remove quote');
        // The box keeps the words; the quote is the chip's.
        expect(box().value).toBe('Half a thought');
        expect(document.activeElement).toBe(box());
        await type('');
        expect(sendButton().disabled).toBe(true);
        await type('Thanks');
        expect(sendButton().disabled).toBe(false);
        await submit();
        await until(() => kit.runs.length === 1, 'the turn');
        const sent = kit.runs[0]!.at(-1)!;
        expect(sent.content).toBe(`${APP_PREFIX}\n\nThanks`);
        expect(sent.content).toBe(withQuote(quoteOf('Archiver', REPLY_TEXT), 'Thanks'));
        await until(() => !chip(), 'the chip gone with the send');
    });

    it('keeps the quote in the draft across a reopen; the x takes it out, the words stay', async () => {
        await open();
        await click(replyOn('a0'));
        await type('Still thinking');
        const stored = () => localStorage.getItem('socio:draft:ada:chat:c1') ?? '';
        expect(stored()).toContain(JSON.stringify(APP_PREFIX).slice(1, -1));
        act(() => root.unmount());
        root = createRoot(host);
        await open();
        expect(chip()!.textContent).toContain('Replying to Archiver');
        expect(box().value).toBe('Still thinking');
        await click(chip()!.querySelector('button[aria-label="Remove quote"]'));
        expect(chip()).toBeNull();
        expect(box().value).toBe('Still thinking');
        expect(splitQuote(JSON.parse(stored()).text as string).quote).toBeNull();
    });

    it('with `/done` after the quote: the note, said as it appears, no skill menu, and no chip in the message', async () => {
        await open();
        await click(replyOn('a0'));
        expect(note().getAttribute('role')).toBe('status');
        expect(note().textContent).toBe('');
        await type('/do');
        expect(note().textContent).toBe(QUOTED_COMMAND_NOTE);
        expect(host.querySelector('[role="listbox"]')).toBeNull();
        await type('/done');
        await submit();
        await until(() => kit.runs.length === 1, 'the turn');
        const sent = String(kit.runs[0]!.at(-1)!.content);
        expect(sent).toBe(`${APP_PREFIX}\n\n/done`);
        expect(invokedSkill(sent, BUILT_IN_SKILLS)).toBeUndefined();
        await until(() => host.querySelectorAll('[data-chat-message="user"]').length === 2, 'the message');
        const mine = [...host.querySelectorAll('[data-chat-message="user"]')].at(-1)!;
        expect(mine.querySelector('[data-slot="skill-chip"]')).toBeNull();
        expect(
            mine
                .querySelector('blockquote')!
                .textContent!.replace(/\u2060/g, '')
                .trim(),
        ).toBe('Archiver: Yes! erden means *to ground*.');
        expect(mine.querySelector('[data-chat-body] > p')!.textContent).toBe('/done');
    });
});

describe('a quoted message', () => {
    it('shows its quote as a quote block: the author in bold, the excerpt as text, then the words', () => {
        const text = withQuote(quoteOf('Bob', 'Lunch at *noon*? Ask @Alice'), 'Sure');
        act(() => root.render(<ChatTranscript messages={[{ id: 'u1', role: 'user', content: text }]} calls={[]} />));
        const quote = $('[data-chat-body="user"] blockquote')!;
        expect(quote.querySelector('strong')!.textContent).toBe('Bob:');
        // Escapes and the word joiner don't show: the words as written.
        expect(quote.textContent!.replace(/\u2060/g, '').trim()).toBe('Bob: Lunch at *noon*? Ask @Alice');
        expect(quote.querySelector('em')).toBeNull();
        expect($('[data-chat-body="user"] > p')!.textContent).toBe('Sure');
        expect($('[data-slot="skill-chip"]')).toBeNull();
    });
});
