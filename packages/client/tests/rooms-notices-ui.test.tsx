// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RoomPresenceView } from '@socio/shared/rooms/room-notices';
import type { RoomView } from '@socio/shared/rooms/rooms';
import type { Conversation, State, User, WorkspaceState } from '@socio/shared/types';

import { postChanges } from '../src/lib/change-channel';

import { createTestRouter } from './helpers/app-router';

// CB-216 in the room's screens: the composer's picker for people's
// mentions (members only, by id, keyboard and pointer), the transcript's
// "@ you", who else is looking, and each room's notifications in its menu
// and the sidebar. The live chat is a stand-in: CopilotKit's package
// imports a stylesheet Node can't load.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const ALICE: User = { id: 'alice', name: 'Alice Lima', role: 'member' };
const state = (): State => ({
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
        rooms: { enabled: true },
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
});
let conversations: Conversation[] = [];
const room = (extra: Partial<Conversation> = {}): Conversation => ({
    id: 'r1',
    dotId: 'd1',
    ownerId: 'room:r1',
    title: 'Launch room',
    createdAt: 1,
    kind: 'room',
    roomRole: 'member',
    ...extra,
});
let dotName = 'Sebas';
const workspace = (convs: Conversation[] = conversations): WorkspaceState => ({
    user: ALICE,
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: dotName,
            instructions: 'Sebas helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: convs,
    archived: [],
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});
const member = (userId: string, name: string, status = 'active') => ({
    userId,
    name,
    role: 'member' as const,
    status: status as 'active' | 'invited',
    invitedBy: null,
    invitedAt: 1,
    inviteExpiresAt: null,
    acceptedAt: 1,
});
const view = (): RoomView => ({
    id: 'r1',
    title: 'Launch room',
    dotId: 'd1',
    createdAt: 1,
    createdBy: 'alice',
    convertedAt: null,
    archivedAt: null,
    role: 'member',
    roomsEnabled: true,
    members: [
        member('alice', 'Alice Lima'),
        // Two people with one name, and someone only invited.
        member('bob', 'Bob Reyes'),
        member('bob2', 'Bob Reyes'),
        member('ivy', 'Ivy Chen', 'invited'),
    ],
    socios: [{ dotId: 'd1', name: 'Sebas', status: 'active', lead: true }],
});
let presence: RoomPresenceView = { people: [] };
let requests: string[] = [];
// While true the room answers as if the reader was removed: its transcript
// and room view return 404, and it leaves the workspace's conversation list.
let removed = false;
const transcript = [
    {
        id: 'm1',
        role: 'user',
        content: '@Alice Lima can you look?',
        author: { name: 'Bob Reyes', you: false },
        mentions: [{ name: 'Alice Lima', you: true }],
    },
    {
        id: 'm2',
        role: 'user',
        content: '@Alice Lima typed, never picked',
        author: { name: 'Bob Reyes', you: false },
    },
];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : {};
    if (method !== 'GET') {
        requests.push(`${method} ${path} ${JSON.stringify(body)}`);
    }
    if (path === '/api/state') {
        return [200, state()];
    }
    if (path === '/api/workspace') {
        return [200, workspace(removed ? [] : conversations)];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/rooms/invites') {
        return [200, []];
    }
    if (path === '/api/rooms/r1') {
        if (removed) {
            return [404, { error: 'Conversation not found.' }];
        }
        return [200, view()];
    }
    if (path === '/api/rooms/r1/read') {
        return [200, { lastSeq: 1, unread: 0 }];
    }
    if (path === '/api/rooms/r1/presence') {
        return [200, presence];
    }
    if (path === '/api/rooms/r1/notifications' && method === 'PUT') {
        const level = (body as { level: string }).level;
        conversations = [room(level === 'mentions' ? {} : { roomNotify: level as 'mute' })];
        return [200, { level }];
    }
    if (path === '/api/conversations/r1/transcript') {
        if (removed) {
            return [404, { error: 'Conversation not found.' }];
        }
        return [200, { messages: transcript }];
    }
    if (path === '/api/conversations/r1/steering' && method === 'POST') {
        return [
            201,
            {
                message: {
                    id: 'q1',
                    text: (body as { text: string }).text,
                    createdAt: 5,
                    updatedAt: 5,
                },
                messages: [],
                limit: 5,
            },
        ];
    }
    if (path === '/api/conversations/r1/steering') {
        return [200, { messages: [], limit: 5 }];
    }
    if (path === '/api/conversations/r1/reactions') {
        return [200, { shared: true, messages: {} }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    conversations = [room()];
    dotName = 'Sebas';
    presence = { people: [] };
    requests = [];
    removed = false;
    localStorage.clear();
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
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
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
/** Types into the focused text box, its caret at the end. */
const type = (field: HTMLTextAreaElement, value: string) =>
    act(() => {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
        field.setSelectionRange(value.length, value.length);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const options = () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
        (option) => `${option.dataset.mentionOption}:${option.textContent}`,
    );
const composer = async () => {
    await until(() => !!$('textarea[aria-label="Message the room"]'), 'box');
    // The picker lists the room's people once its view is read.
    await until(() => !!$('[data-slot="chat-header"]')?.textContent?.includes('3 people'), 'room');
    return $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
};

it('lists only the room’s other active members as @ is typed, and sends the picked person by id', async () => {
    await open('/chats/r1');
    const box = await composer();
    type(box, 'Hi @bo');
    await until(() => options().length > 0, 'the picker');
    // Both Bob Reyes, by id, numbered by when they joined; never the
    // writer, nor someone only invited.
    expect(options()).toEqual(['bob:BRBob Reyes · 1', 'bob2:BRBob Reyes · 2']);
    // Each with the avatar the room gives them: two tones, one per Bob.
    const tones = [...document.querySelectorAll('[role="option"] [data-slot="avatar-fallback"]')].map(
        (avatar) => avatar.className,
    );
    expect(tones).toHaveLength(2);
    expect(tones[0]).not.toBe(tones[1]);
    expect($('[role="listbox"]')!.getAttribute('aria-label')).toBe('People and socios in the room');
    expect(box.getAttribute('aria-controls')).toBe($('[role="listbox"]')!.id);
    type(box, 'Hi @i');
    await until(() => options().length === 0, 'no invitee');

    // The second Bob, by keyboard.
    type(box, 'Hi @bo');
    await until(() => options().length === 2, 'the picker again');
    key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(document.querySelectorAll('[role="option"]')[1]!.id);
    key(box, 'Enter');
    await until(() => box.value === 'Hi @Bob Reyes ', 'the name in the text');
    expect(options()).toEqual([]);
    type(box, 'Hi @Bob Reyes ship it?');
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests).toContain(
        'POST /api/conversations/r1/steering {"text":"Hi @Bob Reyes ship it?","mentions":[{"userId":"bob2","label":"Bob Reyes"}]}',
    );
});

it('mentions nobody with typed text, closes on Escape and picks with a click', async () => {
    await open('/chats/r1');
    const box = await composer();
    type(box, '@Bo');
    await until(() => options().length === 2, 'the picker');
    key(box, 'Escape');
    await until(() => options().length === 0, 'closed');
    // Typed in full, never picked: no mention goes with it.
    type(box, '@Bob Reyes typed');
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests.at(-1)).toBe('POST /api/conversations/r1/steering {"text":"@Bob Reyes typed"}');
    await until(() => box.value === '', 'emptied');
    type(box, 'and @b');
    await until(() => options().length === 2, 'the picker');
    act(() => document.querySelector<HTMLElement>('[role="option"]')!.click());
    await until(() => box.value === 'and @Bob Reyes ', 'picked');
});

it('marks a message that mentions the reader, from the server’s mentions only', async () => {
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="person"]'), 'the transcript');
    const marks = document.querySelectorAll('[data-slot="mentioned-you"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('mentions you');
});

it('shows who else is looking at the room, in words', async () => {
    presence = {
        people: [
            { userId: 'bob', name: 'Bob Reyes' },
            { userId: 'bob2', name: 'Bob Reyes' },
        ],
    };
    await open('/chats/r1');
    await until(() => !!$('[data-slot="room-presence"]'), 'presence');
    expect($('[data-slot="room-presence"]')!.textContent).toContain('Bob Reyes · 1 and Bob Reyes · 2 are here');
    // Read with the header, never announced as people come and go (CB-219).
    expect($('[data-slot="room-presence"]')!.getAttribute('role')).toBeNull();
    expect($('[data-slot="room-presence"]')!.closest('[aria-live]')).toBeNull();
});

it('mutes a room from its menu, and the sidebar shows it quietly', async () => {
    conversations = [room({ unread: 2 })];
    await open('/');
    await until(() => !!$('[data-room-row="r1"]'), 'the room');
    act(() => $('[data-room-row="r1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    await until(() => !!$('[data-slot="room-notify"]'), 'the menu');
    const radios = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(['Everything', 'Mentions and my turns', 'Muted']);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    // The choices are named by their heading (CB-219).
    const group = $('[data-slot="room-notify"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Notify me about');
    act(() => radios[2]!.click());
    await until(() => requests.includes('PUT /api/rooms/r1/notifications {"level":"mute"}'), 'the save');
    await until(
        () =>
            !!$('[data-room-row="r1"]')?.textContent?.includes('muted') &&
            !$('[data-room-row="r1"] [data-thread-title]')!.className.includes('font-semibold'),
        'the quiet row',
    );
});

it('gives the Pinned and Members header buttons a touch min-width on a phone', async () => {
    // The labels hide on a narrow screen, so without a min-width the
    // buttons shrink to their icon's width; on a touch screen each gets a
    // 44 px min-width to match its min-height (Rooms follow-ups).
    window.matchMedia = (query: string) =>
        ({
            matches: query === '(pointer: coarse)',
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    await open('/chats/r1');
    await composer();
    const header = $('[data-slot="chat-header"]')!;
    const buttons = [...header.querySelectorAll('button')].filter((button) =>
        button.textContent?.match(/Pinned|Members/),
    );
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
        expect(button.className).toContain('pointer-coarse:min-w-11');
    }
});

it('truncates a long lead socio name in the composer placeholder', async () => {
    // A long name no longer wraps the placeholder to a second line: it is
    // cut, with the placeholder's own trailing "…" (Rooms follow-ups).
    dotName = 'Supercalifragilisticexpialidocio';
    await open('/chats/r1');
    const box = await composer();
    expect(box.getAttribute('placeholder')).toBe('Message the room and Supercalifragilisticexpi…');
});

it('shows the room’s own notice, not "Conversation not found", after a member is removed', async () => {
    await open('/chats/r1');
    await composer();
    // The member is removed: the room leaves their chat list and the
    // transcript and room view answer 404. The open room keeps its own
    // "you are no longer in this room" notice (RoomChat's feed.gone) rather
    // than the route's generic "Conversation not found." (Rooms follow-ups).
    removed = true;
    conversations = [];
    // A change note for the room re-reads the shell (the room leaves the
    // sidebar) and the room's feed (its transcript now 404s).
    act(() => postChanges([{ topic: 'conversation', id: 'r1' }]));
    await until(() => !!$('[data-slot="room-gone"]'), 'the room-gone notice');
    expect(document.body.textContent).not.toContain('Conversation not found');
    expect($('[data-slot="room-gone"]')?.textContent).toContain('no longer in this room');
});
