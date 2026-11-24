// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { OthersQueuedMessage, QueuedMessage } from '@socio/shared/chat/steering';
import type { RoomPinOutcome, RoomPinVersion, RoomPinsState } from '@socio/shared/rooms/room-pins';
import { ROOM_TOPIC_CONVERT_TEXT, type RoomTopicCode, type RoomTopicView } from '@socio/shared/rooms/room-telegram';
import {
    ROOM_CONVERT_TEXT,
    ROOM_DISCLOSURE_TEXT,
    ROOM_DISCLOSURE_VERSION,
    type RoomInvite,
    type RoomView,
} from '@socio/shared/rooms/rooms';
import type { Conversation, State, User, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// CB-212 (client half): the room screens behind Settings → Rooms. The
// sidebar's Rooms and invitations, creating a room and sharing a chat as
// one with the history confirmed, joining with the disclosure, the room
// itself (who wrote each message, the room's queue, read-only states),
// its Members panel with roles, invites, removal and handing admin on,
// and none of it while Rooms are off. The live chat is a stand-in:
// CopilotKit's package imports a stylesheet Node can't load.
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
let me: User = ALICE;
let roomsEnabled = true;
const state = (): State => ({
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
        rooms: { enabled: roomsEnabled },
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
});
const chat = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    dotId: 'd1',
    ownerId: 'alice',
    title,
    createdAt: 1,
    kind: 'private',
    ...extra,
});
let conversations: Conversation[] = [];
let archived: Conversation[] = [];
/** More company socios (CB-206's rooms with several). */
let moreDots: WorkspaceState['dots'] = [];
const workspace = (): WorkspaceState => ({
    user: me,
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Sebas',
            instructions: 'Sebas helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
        {
            id: 'mine',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Pocket',
            ownerId: 'alice',
            instructions: 'Mine only.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
        ...moreDots,
    ],
    conversations,
    archived,
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});

let view: RoomView;
const roomView = (extra: Partial<RoomView> = {}): RoomView => ({
    id: 'r1',
    title: 'Launch room',
    dotId: 'd1',
    createdAt: 1,
    createdBy: 'alice',
    convertedAt: null,
    archivedAt: null,
    role: 'admin',
    roomsEnabled: true,
    members: [
        {
            userId: 'alice',
            name: 'Alice Lima',
            role: 'admin',
            status: 'active',
            invitedBy: null,
            invitedAt: 1,
            inviteExpiresAt: null,
            acceptedAt: 1,
        },
        {
            userId: 'bob',
            name: 'Bob Reyes',
            role: 'member',
            status: 'active',
            invitedBy: 'alice',
            invitedAt: 1,
            inviteExpiresAt: null,
            acceptedAt: 2,
        },
    ],
    socios: [{ dotId: 'd1', name: 'Sebas', status: 'active', lead: true }],
    ...extra,
});
// The room's pinned facts (CB-217).
const pinRow = (extra: Partial<RoomPinVersion>): RoomPinVersion => ({
    id: 'v1',
    pinId: 'p1',
    version: 1,
    text: 'Decision: launch on 3 November',
    status: 'pinned',
    origin: 'person',
    supersedes: null,
    pinnedBy: 'bob',
    pinnedByName: 'Bob Reyes',
    proposedBy: 'bob',
    proposedByName: 'Bob Reyes',
    proposedAt: 1,
    decidedBy: 'alice',
    decidedByName: 'Alice Lima',
    decidedAt: 2,
    endedBy: null,
    endedByName: null,
    endedAt: null,
    ...extra,
});
let pins: RoomPinsState;
const pinsView = (extra: Partial<RoomPinsState> = {}): RoomPinsState => ({
    roomId: 'r1',
    pins: [
        pinRow({}),
        pinRow({
            id: 'v2',
            pinId: 'p2',
            text: 'Goal: ship the beta',
            pinnedBy: 'alice',
            pinnedByName: 'Alice Lima',
            proposedBy: 'alice',
            proposedByName: 'Alice Lima',
        }),
    ],
    proposals: [
        pinRow({
            id: 'q1',
            pinId: 'p3',
            version: null,
            text: 'Open: who signs off?',
            status: 'proposed',
            pinnedBy: null,
            pinnedByName: null,
            decidedBy: null,
            decidedByName: null,
            decidedAt: null,
        }),
    ],
    can: { propose: true, manage: true },
    quota: {
        pins: 2,
        maxPins: 30,
        chars: 49,
        maxChars: 6000,
        proposals: 1,
        maxProposals: 50,
    },
    notes: {
        current: {
            version: 3,
            turns: 12,
            summary: 'Alice and Bob planned the launch.',
            facts: ['Decision: Bob runs the jobs'],
            names: [],
            updatedAt: 3,
        },
        versions: [
            {
                version: 3,
                fromTurns: 8,
                turns: 12,
                method: 'model',
                dotName: 'Sebas',
                actingName: 'Bob Reyes',
                added: [],
                at: 3,
            },
        ],
    },
    ...extra,
});
const pinsAnswer = (outcome: RoomPinOutcome['outcome'] = 'done'): [number, RoomPinOutcome] => [
    200,
    { outcome, state: pins },
];
let invites: RoomInvite[] = [];
const invite = (): RoomInvite => ({
    roomId: 'r2',
    title: 'Design crit',
    role: 'member',
    invitedBy: 'bob',
    invitedByName: 'Bob Reyes',
    invitedAt: 1,
    inviteExpiresAt: Date.UTC(2026, 10, 4),
    memberCount: 3,
    disclosure: { version: ROOM_DISCLOSURE_VERSION, text: ROOM_DISCLOSURE_TEXT },
});
let transcript: unknown[] = [];
const TRANSCRIPT = [
    {
        id: 'm1',
        role: 'user',
        content: 'Can we ship Friday?',
        author: { name: 'Bob Reyes', you: false },
    },
    { id: 'm2', role: 'assistant', content: 'Friday works.' },
    {
        id: 'm3',
        role: 'user',
        content: 'Great, thanks.',
        author: { name: 'Alice Lima', you: true },
    },
];

// The room's Telegram topic (CB-214).
let topicView: RoomTopicView;
const topicCode: RoomTopicCode = {
    code: 'c0de-1234abcd',
    expiresAt: Date.UTC(2026, 9, 28, 15, 10),
    command: '/bind@brain_bot c0de-1234abcd',
    bot: 'brain_bot',
};

let requests: string[] = [];
/** The last create-room body, for the CB-278 dialog test. */
let createBody: unknown = null;
// A turn runs in the room (the steering view says so).
let running = false;
// Others' queued messages, which only a room admin is sent (CB-215).
let others: OthersQueuedMessage[] | undefined;
// The reader's own queued messages.
let mine: QueuedMessage[] = [];
let refuse: Record<string, [number, unknown]> = {};
// The room's own handoff limit, lower than the workspace's 4.
let handoffs: number | undefined;
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : {};
    if (method !== 'GET') {
        requests.push(`${method} ${path} ${JSON.stringify(body)}`);
    }
    const key = `${method} ${path}`;
    if (refuse[key]) {
        return refuse[key]!;
    }
    if (path === '/api/state') {
        return [200, state()];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/rooms/invites') {
        return [200, invites];
    }
    if (path === '/api/rooms/people') {
        return [
            200,
            [
                { userId: 'bob', name: 'Bob Reyes' },
                { userId: 'cara', name: 'Cara Diaz' },
            ],
        ];
    }
    if (path === '/api/rooms' && method === 'POST') {
        createBody = body;
        const made = chat('r9', (body as { title: string }).title, {
            kind: 'room',
            ownerId: 'room:r9',
            roomRole: 'admin',
        });
        conversations = [made, ...conversations];
        return [201, made];
    }
    if (path === '/api/rooms/c1/convert') {
        conversations = conversations.map((item) =>
            item.id === 'c1' ? { ...item, kind: 'room', ownerId: 'room:c1', roomRole: 'admin' } : item,
        );
        return [201, conversations.find((item) => item.id === 'c1')];
    }
    if (path === '/api/rooms/r2/accept') {
        invites = [];
        conversations = [
            chat('r2', 'Design crit', {
                kind: 'room',
                ownerId: 'room:r2',
                roomRole: 'member',
            }),
            ...conversations,
        ];
        return [200, roomView({ id: 'r2', title: 'Design crit', role: 'member' })];
    }
    if (path === '/api/rooms/r1/telegram' && method === 'GET') {
        return [200, topicView];
    }
    if (path === '/api/rooms/r1/telegram/code' || path === '/api/rooms/telegram/topics/t1/code') {
        return [201, topicCode];
    }
    if (path === '/api/rooms/r2/decline') {
        invites = [];
        return [200, { ok: true }];
    }
    const read = path.match(/^\/api\/rooms\/(r\d)\/read$/);
    if (read && method === 'POST') {
        conversations = conversations.map((item) => (item.id === read[1] ? { ...item, unread: undefined } : item));
        return [200, { lastSeq: 9, unread: 0 }];
    }
    const room = path.match(/^\/api\/rooms\/(r\d)(\/.*)?$/);
    if (room) {
        const rest = room[2] ?? '';
        if (rest === '' && method === 'GET') {
            return [200, view];
        }
        if (rest === '/invitable') {
            return [200, [{ userId: 'cara', name: 'Cara Diaz' }]];
        }
        if (rest === '/invites') {
            return [201, {}];
        }
        if (rest === '/pins' && method === 'GET') {
            return [200, pins];
        }
        if (rest === '/pins/p1/history') {
            return [
                200,
                [
                    pinRow({ id: 'v1b', version: 2, text: 'Decision: launch on 3 Nov' }),
                    pinRow({
                        status: 'superseded',
                        endedBy: 'bob',
                        endedByName: 'Bob Reyes',
                        endedAt: 4,
                    }),
                ],
            ];
        }
        if (rest.startsWith('/pins') || rest.startsWith('/pin-proposals')) {
            return pinsAnswer(
                method === 'POST' && rest === '/pins' ? (view.role === 'admin' ? 'pinned' : 'proposed') : 'done',
            );
        }
        if (rest === '/members/bob' && method === 'PATCH') {
            view = roomView({
                members: view.members.map((member) =>
                    member.userId === 'bob' ? { ...member, role: 'admin' } : member,
                ),
            });
            return [200, view];
        }
        if (rest === '/members/bob' && method === 'DELETE') {
            view = roomView({
                members: view.members.filter((member) => member.userId !== 'bob'),
            });
            return [200, view];
        }
        if (rest === '/leave') {
            conversations = conversations.filter((item) => item.id !== room[1]);
            return [200, { ok: true }];
        }
        if (rest === '/archive' || rest === '/unarchive') {
            return [200, view];
        }
        // Every member reads the handoff limit; the room's other limits
        // (its budget) only its admins, and members it is shown to.
        if (rest === '/limits/handoffs') {
            return [200, { workspace: 4, room: handoffs ?? null, effective: handoffs ?? 4 }];
        }
        if (rest === '/limits' && view.role !== 'admin' && !view.usageVisible) {
            return [
                403,
                {
                    error: 'Only this room’s admins see its use and limits.',
                    code: 'usage_hidden',
                },
            ];
        }
        if (rest === '/limits' && method === 'PUT') {
            handoffs = (body as { handoffsPerCycle?: number }).handoffsPerCycle;
        }
        if (rest === '/limits') {
            return [
                200,
                {
                    workspace: { handoffsPerCycle: 4, cycleTokens: 2_000_000 },
                    room: {
                        cycleTokens: 500_000,
                        ...(handoffs !== undefined && { handoffsPerCycle: handoffs }),
                    },
                    effective: {
                        handoffsPerCycle: handoffs ?? 4,
                        cycleTokens: 500_000,
                    },
                },
            ];
        }
        return [200, view];
    }
    const conv = path.match(/^\/api\/conversations\/([^/]+)(\/.*)?$/);
    if (conv) {
        const rest = conv[2] ?? '';
        if (rest === '/transcript') {
            return [200, { messages: conv[1] === 'r1' ? transcript : [] }];
        }
        if (rest === '/steering' && method === 'POST') {
            // Taken by a turn at once: it runs, and isn't stored yet.
            running = true;
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
        const cancelled = rest.match(/^\/steering\/(.+)$/);
        if (cancelled && method === 'DELETE') {
            others = others?.filter((message) => message.id !== cancelled[1]);
            mine = mine.filter((message) => message.id !== cancelled[1]);
            return [200, { messages: mine, limit: 5, others }];
        }
        if (cancelled && method === 'PATCH') {
            mine = mine.map((message) =>
                message.id === cancelled[1] ? { ...message, text: (body as { text: string }).text } : message,
            );
            return [200, { messages: mine, limit: 5 }];
        }
        if (rest === '/steering') {
            return [
                200,
                {
                    messages: mine,
                    limit: 5,
                    ...(running && { running }),
                    ...(others && { others }),
                },
            ];
        }
        if (rest === '/reactions') {
            return [200, { shared: true, messages: {} }];
        }
        if (rest === '/deletion') {
            return [200, { scheduledTasks: 0, blocked: null }];
        }
        if (rest === '/capture') {
            return [200, null];
        }
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
    me = ALICE;
    roomsEnabled = true;
    conversations = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'admin',
        }),
        chat('c1', 'Garden plan'),
    ];
    archived = [];
    moreDots = [];
    transcript = TRANSCRIPT;
    view = roomView();
    topicView = {
        available: true,
        bot: 'brain_bot',
        linked: true,
        topic: null,
        unanswered: [],
        suggested: [],
    };
    pins = pinsView();
    invites = [];
    requests = [];
    createBody = null;
    running = false;
    others = undefined;
    mine = [];
    refuse = {};
    handoffs = undefined;
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
const byLabel = (label: string) => $(`[aria-label="${label}"]`);
const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
const item = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
        entry.textContent?.trim().startsWith(name),
    );
const click = (element: Element | null | undefined) => act(() => (element as HTMLElement).click());
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
/** Types into a React-controlled field. */
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(() => {
        const proto = Object.getPrototypeOf(field) as object;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const select = (field: HTMLSelectElement, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('change', { bubbles: true }));
    });
const check = (scope: ParentNode = document) => click(scope.querySelector('[role="checkbox"]'));
const sidebarRooms = () =>
    [...host.querySelectorAll('[data-room-row]')].map((row) => row.querySelector('[data-thread-title]')?.textContent);
const recentChats = () =>
    [...host.querySelectorAll('[data-chat-row]')].map((row) => row.querySelector('[data-thread-title]')?.textContent);

it('shows nothing room-shaped while Rooms are off; a room’s link opens read-only', async () => {
    roomsEnabled = false;
    view = roomView({ roomsEnabled: false });
    invites = [invite()];
    const router = await open('/');
    await until(() => recentChats().includes('Garden plan'), 'the chats');
    // No Rooms group, no invitations, no room among the chats or on Home.
    expect($('[data-slot="rooms-group"]')).toBeNull();
    expect($('[data-slot="room-invites-notice"]')).toBeNull();
    expect(recentChats()).toEqual(['Garden plan']);
    expect(host.textContent).not.toContain('Launch room');
    // A private chat's menu has no "Share as a room".
    key(byLabel('Options for Garden plan')!, 'Enter');
    await until(() => !!item('Rename'), 'the chat menu');
    expect(item('Share as a room')).toBeUndefined();
    key(document.activeElement!, 'Escape');
    // The room's own link: readable, nothing to write in.
    await act(() => router.navigate('/chats/r1'));
    await until(() => !!$('[data-room-speaker="person"]'), 'the room');
    expect($('[data-slot="room-composer"]')).toBeNull();
    expect($('[data-slot="chat-note"]')?.textContent).toContain('Rooms are turned off in Settings');
});

it('lists rooms apart from chats, makes one and opens its Members', async () => {
    const router = await open('/');
    await until(() => sidebarRooms().length === 1, 'the Rooms group');
    expect(sidebarRooms()).toEqual(['Launch room']);
    expect(recentChats()).toEqual(['Garden plan']);
    click(byLabel('New room'));
    await until(() => !!$('[data-slot="create-room"]'), 'the dialog');
    // Company socios only: not a personal one.
    const socio = $<HTMLSelectElement>('[data-slot="create-room"] select')!;
    expect([...socio.options].map((option) => option.text)).toEqual(['Sebas']);
    const create = button('Create room')!;
    expect(create.disabled).toBe(true);
    type($<HTMLInputElement>('[data-slot="create-room"] input')!, 'Ops sync');
    click(button('Create room'));
    await until(() => router.state.location.pathname === '/chats/r9', 'the room');
    expect(router.state.location.search).toBe('?members=1');
    expect(requests).toContain('POST /api/rooms {"dotId":"d1","title":"Ops sync"}');
});

it('makes a room with several socios, invited people and a description, sending one payload (CB-278)', async () => {
    // A second company socio, so the "More socios" checklist shows.
    moreDots = [
        {
            id: 'd2',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Ledger',
            instructions: 'Knows billing.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ];
    const router = await open('/');
    await until(() => sidebarRooms().length === 1, 'the Rooms group');
    click(byLabel('New room'));
    await until(() => !!$('[data-slot="create-room"]'), 'the dialog');
    const dialog = $('[data-slot="create-room"]')!;
    // The description field is in the document, and the dialog scrolls (its
    // content has overflow and a max height), so the keyboard never covers it.
    expect(dialog.querySelector('textarea')).not.toBeNull();
    expect(dialog.getAttribute('class') ?? '').toContain('overflow-y-auto');
    expect(dialog.getAttribute('class') ?? '').toContain('max-h-[90svh]');
    // Name the room.
    type($<HTMLInputElement>('[data-slot="create-room"] input')!, 'Ops sync');
    // Wait for both checklists to render: one further socio (Ledger) and two
    // invited people (Bob, Cara) — three checkboxes in total.
    await until(
        () => dialog.querySelectorAll('[data-slot="checkbox"]').length === 3,
        'the socios and people checklists',
    );
    const checkboxes = [...dialog.querySelectorAll<HTMLButtonElement>('[data-slot="checkbox"]')];
    // Tick Ledger (further socio) and Bob (invited person).
    click(checkboxes[0]);
    await until(() => checkboxes[0]!.getAttribute('data-state') === 'checked', 'Ledger checked');
    click(checkboxes[1]);
    await until(() => checkboxes[1]!.getAttribute('data-state') === 'checked', 'Bob checked');
    // Type a description.
    const desc = $<HTMLTextAreaElement>('[data-slot="create-room"] textarea')!;
    type(desc, 'Plan the launch together.');
    click(button('Create room'));
    await until(() => router.state.location.pathname === '/chats/r9', 'the room');
    // The payload carries the lead, the further socio, the invited person
    // and the description, in one request.
    expect(createBody).toEqual({
        dotId: 'd1',
        title: 'Ops sync',
        dotIds: ['d2'],
        userIds: ['bob'],
        description: 'Plan the launch together.',
    });
});

it('shares a private chat as a room only once the history is confirmed', async () => {
    await open('/chats/c1');
    key(byLabel('Options for Garden plan')!, 'Enter');
    await until(() => !!item('Share as a room'), 'the chat menu');
    click(item('Share as a room'));
    await until(() => !!$('[data-slot="convert-room"]'), 'the dialog');
    expect($('[data-slot="convert-room"]')!.textContent).toContain(ROOM_CONVERT_TEXT);
    expect(button('Make it a room')!.disabled).toBe(true);
    check($('[data-slot="convert-room"]')!);
    click(button('Make it a room'));
    await until(() => requests.some((line) => line.startsWith('POST /api/rooms/c1/convert')), 'the conversion');
    expect(requests).toContain('POST /api/rooms/c1/convert {"confirmHistory":true}');
    await until(() => sidebarRooms().includes('Garden plan'), 'the new room');
});

it('joins an invite only after its disclosure, and declines without one', async () => {
    invites = [invite()];
    const router = await open('/');
    await until(() => !!$('[data-slot="room-invites-notice"]'), 'the notice');
    click(button('Review'));
    await until(() => !!$('[data-room-invite="r2"]'), 'the invite');
    const card = $('[data-room-invite="r2"]')!;
    expect(card.textContent).toContain('Bob Reyes invited you');
    expect(card.textContent).toContain('3 people in it');
    expect(card.textContent).toContain(ROOM_DISCLOSURE_TEXT);
    expect(button('Join room Design crit')!.disabled).toBe(true);
    check(card);
    click(button('Join room Design crit'));
    await until(() => router.state.location.pathname === '/chats/r2', 'the room');
    expect(requests).toContain(`POST /api/rooms/r2/accept {"disclosureVersion":${ROOM_DISCLOSURE_VERSION}}`);
});

it('declines an invite from the sidebar', async () => {
    invites = [invite()];
    await open('/');
    // The count is said with its name (CB-219): the badge beside it is
    // hidden from screen readers, as a label on a plain div is never read.
    await until(() => !!button('Invitations, 1 waiting'), 'the sidebar entry');
    const badge = $('[data-sidebar="menu-badge"]')!;
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.hasAttribute('aria-label')).toBe(false);
    click(button('Invitations, 1 waiting'));
    await until(() => !!button('Decline Design crit'), 'the invite');
    click(button('Decline Design crit'));
    await until(() => requests.some((line) => line.startsWith('POST /api/rooms/r2/decline')), 'the decline');
});

it('says who wrote each message and sends to the room’s queue', async () => {
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="person"]'), 'the transcript');
    const speakers = [...document.querySelectorAll('[data-room-speaker]')].map(
        (label) => `${label.getAttribute('data-room-speaker')}:${label.textContent?.replace(/\s+/g, '')}`,
    );
    expect(speakers).toEqual(['person:BRBobReyes', 'socio:Sebassocio', 'you:You']);
    expect($('[data-slot="chat-header"]')!.textContent).toContain('Room · 2 people · Sebas answers · you’re an admin');
    const box = $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    type(box, 'Ship it');
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests).toContain('POST /api/conversations/r1/steering {"text":"Ship it"}');
    await until(() => box.value === '', 'the box emptied');
    // Taken by a turn before the next read: still shown, being read.
    await until(() => !!$('[data-delivering-message="q1"]'), 'the sent message');
    expect($('[data-delivering-message="q1"]')!.textContent).toContain('Sebas is reading this');
    // While it runs: Stop, and a new message is queued.
    expect(byLabel('Stop the answer')).not.toBeNull();
    expect(byLabel('Queue message')).not.toBeNull();
    expect($('[data-slot="chat-notice"]')!.textContent).toBe('Sebas is answering…');
});

it('keeps the text when the room refuses it', async () => {
    refuse['POST /api/conversations/r1/steering'] = [
        429,
        { error: 'This room takes 20 messages a minute.', code: 'cycle_rate' },
    ];
    await open('/chats/r1');
    const box = await (async () => {
        await until(() => !!$('textarea[aria-label="Message the room"]'), 'box');
        return $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    })();
    type(box, 'One more');
    key(box, 'Enter');
    await until(() => !!$('[data-slot="room-send-problem"]'), 'the problem');
    expect($('[data-slot="room-send-problem"]')!.textContent).toBe('This room takes 20 messages a minute.');
    expect(box.value).toBe('One more');
});

it('an archived room is read-only, with Unarchive for its admins', async () => {
    conversations = [];
    archived = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'admin',
            archivedAt: 9,
        }),
    ];
    view = roomView({ archivedAt: 9 });
    await open('/chats/r1');
    await until(() => !!$('[data-slot="archived-room"]'), 'the notice');
    expect($('[data-slot="room-composer"]')).toBeNull();
    click(
        [...$('[data-slot="archived-room"]')!.querySelectorAll('button')].find(
            (item) => item.textContent === 'Unarchive',
        ),
    );
    await until(() => requests.some((line) => line.startsWith('POST /api/rooms/r1/unarchive')), 'the unarchive');
});

it('lets a room admin invite, change roles and remove; a member only reads', async () => {
    await open('/chats/r1?members=1');
    await until(() => !!$('[data-slot="room-members"]'), 'the panel');
    await until(() => !!$('[data-slot="room-members"] select'), 'the invite form');
    const panel = $('[data-slot="room-members"]')!;
    expect(panel.textContent).toContain('People (2)');
    // Invite Cara, a member by default.
    click(button('Invite'));
    await until(() => requests.some((line) => line.includes('/invites')), 'the invite');
    expect(requests).toContain('POST /api/rooms/r1/invites {"userId":"cara","role":"member"}');
    // Bob's menu: Make admin, Remove; the only admin (Alice) has none.
    expect(byLabel('Options for Alice Lima')).toBeNull();
    key(byLabel('Options for Bob Reyes')!, 'Enter');
    await until(() => !!item('Make admin'), 'Bob’s menu');
    click(item('Make admin'));
    await until(() => requests.some((line) => line.startsWith('PATCH /api/rooms/r1/members/bob')), 'the role change');
    expect(requests).toContain('PATCH /api/rooms/r1/members/bob {"role":"admin"}');
    key(byLabel('Options for Bob Reyes')!, 'Enter');
    await until(() => !!item('Remove from room'), 'Bob’s menu');
    click(item('Remove from room'));
    await until(() => requests.some((line) => line.startsWith('DELETE /api/rooms/r1/members/bob')), 'the removal');
});

it('invites from the composer with /invite (CB-285): an admin picks a person; a member gets no command', async () => {
    await open('/chats/r1');
    await until(() => !!$('[data-slot="room-composer"]'), 'the composer');
    const box = $('[data-slot="room-composer"] textarea') as HTMLTextAreaElement;
    // The admin's placeholder names the command.
    expect(box.placeholder).toContain('/invite');
    type(box, '/invite');
    await until(() => !!$('[data-slot="room-invite-menu"]'), 'the invite menu');
    const menu = $('[data-slot="room-invite-menu"]')!;
    // Cara is the one invitable person the room returns.
    expect(menu.textContent).toContain('Cara Diaz');
    // Send is disabled while the command is active: a click on a pick invites.
    expect(button('Send message')!.disabled).toBe(true);
    click($('[data-invite-option="cara"]'));
    await until(() => requests.some((line) => line.includes('/invites')), 'the invite');
    expect(requests).toContain('POST /api/rooms/r1/invites {"userId":"cara","role":"member"}');
    // The composer is cleared once the invite goes.
    await until(() => box.value === '', 'the composer cleared');
});

it('hides the admin controls from a member', async () => {
    conversations = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'member',
        }),
    ];
    view = roomView({ role: 'member' });
    await open('/chats/r1?members=1');
    await until(() => !!$('[data-slot="room-members"]'), 'the panel');
    await until(() => !!$('[data-room-member="bob"]'), 'the people');
    expect($('[data-slot="room-members"]')!.querySelectorAll('[aria-label^="Options for"]')).toHaveLength(0);
    expect($('[data-slot="room-members"]')!.textContent).not.toContain('Invite someone');
    expect(button('Make lead')).toBeUndefined();
    // A member's composer has no /invite command (CB-285): typing it is text.
    const box = $('[data-slot="room-composer"] textarea') as HTMLTextAreaElement;
    expect(box.placeholder).not.toContain('/invite');
    type(box, '/invite');
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect($('[data-slot="room-invite-menu"]')).toBeNull();
});

it('hands the admin role on as the last admin leaves', async () => {
    const router = await open('/chats/r1?members=1');
    await until(() => !!button('Leave room'), 'the panel');
    click(button('Leave room'));
    await until(() => !!$('[data-slot="leave-room"]'), 'the dialog');
    expect($('[data-slot="leave-room"]')!.textContent).toContain('A room always keeps an admin');
    const successor = $<HTMLSelectElement>('[data-slot="leave-room"] select')!;
    expect(successor.value).toBe('bob');
    select(successor, 'bob');
    click(button('Hand over and leave'));
    await until(() => router.state.location.pathname === '/', 'home');
    const handed = requests.findIndex((line) => line.startsWith('PATCH /api/rooms/r1/members/bob {"role":"admin"}'));
    const left = requests.findIndex((line) => line.startsWith('POST /api/rooms/r1/leave'));
    expect(handed).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThan(handed);
});

it('gives focus back to Members when its panel closes, however it opened', async () => {
    await open('/chats/r1?members=1');
    await until(() => !!$('[data-slot="room-members"]'), 'the panel');
    key($('[data-slot="room-members"]')!, 'Escape');
    await until(() => !$('[data-slot="room-members"]'), 'the panel closed');
    await until(() => document.activeElement?.textContent?.trim() === 'Members', 'focus on Members');
});

it('marks a room with something new in the sidebar, and clears it as the room is read (CB-215)', async () => {
    conversations = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'admin',
            unread: 3,
        }),
        chat('r3', 'Ops room', {
            kind: 'room',
            ownerId: 'room:r3',
            roomRole: 'member',
            unread: 120,
        }),
        chat('c1', 'Garden plan'),
    ];
    const router = await open('/');
    const row = (id: string) => $(`[data-room-row="${id}"]`)!;
    await until(() => !!$('[data-room-row="r1"]'), 'the rooms');
    expect(row('r1').querySelector('[data-room-unread]')!.textContent).toBe('3, 3 unread');
    expect(row('r1').querySelector('[data-thread-title]')!.className).toContain('font-semibold');
    // A long-unread room says 99+.
    expect(row('r3').querySelector('[data-room-unread]')!.textContent).toBe('99+, 99+ unread');
    // Nothing was marked read just by being listed.
    expect(requests.some((line) => line.includes('/read'))).toBe(false);

    // Opening the room marks it read, and the sidebar follows.
    await act(() => router.navigate('/chats/r1'));
    await until(() => requests.includes('POST /api/rooms/r1/read {}'), 'the room marked read');
    await until(() => !row('r1').querySelector('[data-room-unread]'), 'the count cleared');
    expect(row('r1').querySelector('[data-thread-title]')!.className).not.toContain('font-semibold');
    // The other room keeps its count.
    expect(row('r3').querySelector('[data-room-unread]')).not.toBeNull();
    expect(requests.filter((line) => line.includes('/read'))).toEqual(['POST /api/rooms/r1/read {}']);
});

it('shows a room admin the others’ queued messages, to cancel after asking, never to edit (CB-215)', async () => {
    others = [
        {
            id: 'q-bob',
            text: 'Bob’s follow-up',
            files: 1,
            author: { name: 'Bob Reyes' },
            createdAt: 3,
            updatedAt: 3,
        },
        {
            id: 'q-gone',
            text: 'From someone who left',
            files: 0,
            author: { name: 'Cara Diaz' },
            held: true,
            createdAt: 4,
            updatedAt: 4,
        },
    ];
    await open('/chats/r1');
    await until(() => !!$('[data-others-queued-message="q-bob"]'), 'the others’ queue');
    const bob = $('[data-others-queued-message="q-bob"]')!;
    expect(bob.textContent).toContain('Bob Reyes');
    expect(bob.textContent).toContain('Bob’s follow-up');
    expect(bob.textContent).toContain('1 file');
    // Cancel only: there is no Edit for someone else's message.
    expect([...bob.querySelectorAll('button')].map((item) => item.textContent)).toEqual(['Cancel']);
    expect($('[data-others-queued-message="q-gone"]')!.textContent).toContain(
        'won’t be sent while Cara Diaz can’t write here',
    );

    // It asks first, naming whose it is; Keep it leaves it.
    click(button('Cancel Bob Reyes’s queued message'));
    expect(bob.textContent).toContain('Cancel Bob Reyes’s message?');
    click(button('Keep it'));
    expect(requests.some((line) => line.startsWith('DELETE'))).toBe(false);
    // Focus goes back to its Cancel; Escape keeps it too.
    expect(document.activeElement).toBe(button('Cancel Bob Reyes’s queued message'));
    click(button('Cancel Bob Reyes’s queued message'));
    key(button('Cancel message')!, 'Escape');
    expect(button('Cancel message')).toBeUndefined();
    click(button('Cancel Bob Reyes’s queued message'));
    click(button('Cancel message'));
    await until(() => requests.includes('DELETE /api/conversations/r1/steering/q-bob {}'), 'the cancel');
    await until(() => !$('[data-others-queued-message="q-bob"]'), 'the cancelled message gone');
    expect($('[data-others-queued-message="q-gone"]')).not.toBeNull();
    // Its buttons gone with it, focus is on the message box (CB-219).
    expect(document.activeElement).toBe($('[data-slot="room-composer"] textarea'));
});

it('shows a member no one else’s queued messages (CB-215)', async () => {
    view = roomView({ role: 'member' });
    conversations = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'member',
        }),
    ];
    // Even were the server to send some, a member's screen asks for none.
    others = [
        {
            id: 'q-bob',
            text: 'Bob’s follow-up',
            files: 0,
            author: { name: 'Bob Reyes' },
            createdAt: 3,
            updatedAt: 3,
        },
    ];
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="person"]'), 'the transcript');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect($('[data-slot="others-queued-messages"]')).toBeNull();
});

it('keeps the room’s draft for this person and this room only (CB-215)', async () => {
    await open('/chats/r1');
    await until(() => !!$('textarea[aria-label="Message the room"]'), 'box');
    type($<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!, 'Half a thought');
    await until(() => Object.keys(localStorage).some((key) => key.startsWith('socio:draft:')), 'the draft stored');
    expect(Object.keys(localStorage).filter((key) => key.startsWith('socio:draft:'))).toEqual([
        'socio:draft:alice:chat:r1',
    ]);
    expect(localStorage.getItem('socio:draft:alice:chat:r1')).toContain('Half a thought');
});

it('links a room to a Telegram topic only once its admin confirms who reads it, and offers people to invite (CB-214)', async () => {
    topicView = {
        ...topicView,
        unanswered: [
            {
                reason: 'not_member',
                person: { userId: 'cara', name: 'Cara Diaz' },
                lastSeenAt: 5,
                seen: 2,
            },
            { reason: 'unlinked', username: 'stranger', lastSeenAt: 4, seen: 1 },
        ],
        suggested: [{ userId: 'dan', name: 'Dan Ortiz' }],
    };
    await open('/chats/r1');
    await until(() => !!byLabel('Options for Launch room'), 'the room menu');
    key(byLabel('Options for Launch room')!, 'Enter');
    await until(() => !!item('Telegram topic'), 'the menu');
    click(item('Telegram topic'));
    await until(() => !!$('[data-slot="room-topic-status"]'), 'the dialog');
    const dialog = $('[data-slot="room-topic"]')!;
    expect(dialog.textContent).toContain('Not linked to a Telegram topic.');
    expect(dialog.textContent).toContain('@stranger · not linked to Socio');
    expect(dialog.textContent).toContain('Seen in the Telegram group');
    // Nothing until the audience is confirmed.
    expect(button('Get a code')!.disabled).toBe(true);
    check(dialog);
    click(button('Get a code'));
    await until(() => !!$('[data-slot="topic-code"]'), 'the code');
    expect(requests).toContain('POST /api/rooms/r1/telegram/code {"confirmAudience":true}');
    expect($('[data-slot="topic-code"]')!.textContent).toContain('/bind@brain_bot c0de-1234abcd');
    // The code just came: focus is on its Copy, so it is read out (CB-219).
    expect(document.activeElement).toBe(byLabel('Copy the command'));
    // Invite someone the topic didn't answer: an invite, never a member.
    const invites = [...dialog.querySelectorAll('li')].filter((row) => row.textContent?.includes('Cara Diaz'));
    click(invites[0]!.querySelector('button'));
    await until(() => requests.some((line) => line.includes('/api/rooms/r1/invites')), 'the invite');
    expect(requests).toContain('POST /api/rooms/r1/invites {"userId":"cara","role":"member"}');
});

it('shows a linked topic to a member without the admin controls, and unlinks it for an admin (CB-214)', async () => {
    topicView = {
        ...topicView,
        topic: {
            status: 'active',
            topicId: '7',
            boundAt: 5,
            boundByName: 'Alice Lima',
            endedAt: null,
        },
    };
    await open('/chats/r1');
    await until(() => !!byLabel('Options for Launch room'), 'the room menu');
    key(byLabel('Options for Launch room')!, 'Enter');
    await until(() => !!item('Telegram topic'), 'the menu');
    click(item('Telegram topic'));
    await until(() => !!$('[data-slot="room-topic-status"]'), 'the dialog');
    expect($('[data-slot="room-topic-status"]')!.textContent).toContain(
        'Linked to topic #7 in the Telegram group by Alice Lima',
    );
    expect(button('Get a code')).toBeUndefined();
    click(button('Unlink topic'));
    await until(() => requests.some((line) => line.startsWith('DELETE /api/rooms/r1/telegram')), 'the unlink');
});

it('offers a legacy team topic’s reader to make it a room, after confirming who reads it (CB-214)', async () => {
    conversations = [
        ...conversations,
        chat('t1', 'Telegram topic 8', {
            ownerId: 'telegram-team:-100',
            team: true,
            source: 'telegram',
            telegram: { kind: 'topic', chatId: '-100', topicId: '8' },
        }),
    ];
    await open('/chats/t1');
    await until(() => !!button('Make this topic a room…'), 'the offer');
    click(button('Make this topic a room…'));
    await until(() => !!$('[data-slot="convert-topic"]'), 'the dialog');
    // It says the old transcript stays with its current readers.
    expect($('[data-slot="convert-topic-transcript"]')!.textContent).toBe(ROOM_TOPIC_CONVERT_TEXT);
    expect(button('Get a code')!.disabled).toBe(true);
    check($('[data-slot="convert-topic"]')!);
    click(button('Get a code'));
    await until(() => !!$('[data-slot="topic-code"]'), 'the code');
    expect(requests).toContain('POST /api/rooms/telegram/topics/t1/code {"confirmAudience":true}');
});

it('makes no offer on a team topic while Rooms are off (CB-214)', async () => {
    roomsEnabled = false;
    conversations = [
        chat('t1', 'Telegram topic 8', {
            ownerId: 'telegram-team:-100',
            team: true,
            source: 'telegram',
            telegram: { kind: 'topic', chatId: '-100', topicId: '8' },
        }),
    ];
    await open('/chats/t1');
    await until(() => !!$('[data-slot="chat-note"]')?.textContent?.includes('Reply in'), 'the topic');
    expect(button('Make this topic a room…')).toBeUndefined();
});

it('lets a room admin pin, edit, unpin and decide, with each pin’s history and the room’s notes', async () => {
    await open('/chats/r1');
    await until(() => !!button('Pinned'), 'the Pinned button');
    click(button('Pinned'));
    await until(() => !!$('[data-room-pin="p1"]'), 'the pins');
    const panel = $('[data-slot="room-pins"]')!;
    expect(panel.textContent).toContain('Pinned (2 of 30)');
    expect($('[data-room-pin="p1"]')!.textContent).toContain('Pinned by Bob Reyes');
    expect($('[data-room-pin="p2"]')!.textContent).toContain('Pinned by you');
    // Pin a new fact: at once, as a room admin.
    await until(() => !!$('[data-slot="room-pins"] textarea'), 'the pin form');
    const box = $<HTMLTextAreaElement>('[data-slot="room-pins"] textarea')!;
    type(box, '  Name: launch-plan.md ');
    click(button('Pin'));
    await until(() => requests.some((line) => line.startsWith('POST /api/rooms/r1/pins ')), 'the pin');
    expect(requests).toContain('POST /api/rooms/r1/pins {"text":"Name: launch-plan.md","origin":"person"}');
    // Edit Bob's pin, from the version shown.
    const inPin = (pinId: string, name: string) =>
        [...$(`[data-room-pin="${pinId}"]`)!.querySelectorAll('button')].find((item) => item.textContent === name)!;
    await until(() => !inPin('p1', 'Edit').disabled, 'the pin done');
    click(inPin('p1', 'Edit'));
    await until(() => !!$('[data-room-pin="p1"] textarea'), 'the editor');
    const editor = $<HTMLTextAreaElement>('[data-room-pin="p1"] textarea')!;
    type(editor, 'Decision: launch on 4 November');
    key(editor, 'Enter');
    await until(() => requests.some((line) => line.startsWith('PUT /api/rooms/r1/pins/p1')), 'the edit');
    expect(requests).toContain('PUT /api/rooms/r1/pins/p1 {"text":"Decision: launch on 4 November","baseVersion":1}');
    // Unpin; approve the proposal; pin a fact of the notes.
    await until(() => !inPin('p2', 'Unpin').disabled, 'the edit done');
    click(inPin('p2', 'Unpin'));
    const settled = () => !button('Approve')?.disabled;
    await until(settled, 'the unpin done');
    click(button('Approve'));
    await until(settled, 'the approval done');
    click(button('Pin: Decision: Bob runs the jobs'));
    await until(() => requests.length >= 5, 'the changes');
    expect(requests).toEqual(
        expect.arrayContaining([
            'DELETE /api/rooms/r1/pins/p2 {}',
            'POST /api/rooms/r1/pin-proposals/q1/approve {}',
            'POST /api/rooms/r1/pins {"text":"Decision: Bob runs the jobs","origin":"notes"}',
        ]),
    );
    // The notes, their version and who folded them.
    expect($('[data-slot="room-notes-summary"]')!.textContent).toBe('Alice and Bob planned the launch.');
    expect(panel.textContent).toContain('Version 3, covering the first 12 turns');
    expect($('[data-slot="room-notes-versions"]')!.textContent).toContain(
        'v3 · turns 9–12 · by Sebas in Bob Reyes’s turn',
    );
    // A pin's history: each version, who did what.
    click(inPin('p1', 'History'));
    await until(() => !!$('[data-slot="room-pin-history"]'), 'the history');
    const history = $('[data-slot="room-pin-history"]')!.textContent!;
    expect(history).toContain('v2');
    expect(history).toContain('Replaced');
    expect(history).toContain('Proposed by Bob Reyes, approved by Alice Lima, replaced by Bob Reyes');
    // Escape closes it, and focus goes back to Pinned.
    key(panel, 'Escape');
    await until(() => !$('[data-slot="room-pins"]'), 'the panel closed');
    await until(() => document.activeElement?.textContent?.trim() === 'Pinned', 'focus on Pinned');
});

it('lets a member propose and suggest changes, change only their own pins, and withdraw', async () => {
    conversations = [
        chat('r1', 'Launch room', {
            kind: 'room',
            ownerId: 'room:r1',
            roomRole: 'member',
        }),
    ];
    me = { id: 'bob', name: 'Bob Reyes', role: 'member' };
    view = roomView({ role: 'member' });
    pins = pinsView({ can: { propose: true, manage: false } });
    await open('/chats/r1?pins=1');
    await until(() => !!$('[data-room-pin="p1"]'), 'the pins');
    const panel = $('[data-slot="room-pins"]')!;
    expect(panel.textContent).toContain('Propose a fact');
    expect(button('Approve')).toBeUndefined();
    const buttonsOf = (selector: string) =>
        [...$(selector)!.querySelectorAll('button')].map((item) => item.textContent);
    // His own pin: Edit and Unpin. Alice's: only a suggestion.
    expect(buttonsOf('[data-room-pin="p1"]')).toEqual(['Edit', 'Unpin', 'History']);
    expect(buttonsOf('[data-room-pin="p2"]')).toEqual(['Suggest a change', 'History']);
    click(button('Withdraw'));
    await until(() => requests.includes('POST /api/rooms/r1/pin-proposals/q1/withdraw {}'), 'the withdrawal');
    // Read-only: nothing to change.
    pins = pinsView({ can: { propose: false, manage: false } });
    act(() => root.unmount());
    root = createRoot(host);
    await open('/chats/r1?pins=1');
    await until(() => !!$('[data-room-pin="p1"]'), 'the pins again');
    expect($('[data-slot="room-pins"]')!.textContent).toContain('read-only');
    expect(buttonsOf('[data-room-pin="p1"]')).toEqual(['History']);
    expect(button('Withdraw')).toBeUndefined();
});

it('with several socios: names each reply’s socio, shows a handoff, and routes by the socio picked', async () => {
    // CB-206: Ledger joins Sebas (the lead).
    moreDots = [
        {
            id: 'd2',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Ledger',
            instructions: 'Knows billing.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ];
    view = roomView({
        socios: [
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
            { dotId: 'd2', name: 'Ledger', status: 'active', lead: false },
        ],
    });
    transcript = [
        {
            id: 'm1',
            role: 'user',
            content: 'How is billing?',
            author: { name: 'Bob Reyes', you: false },
        },
        {
            id: 'm2',
            role: 'assistant',
            content: 'Over to Ledger.',
            socioId: 'd1',
        },
        {
            id: 'socio:room_handoff:h1',
            role: 'user',
            content: 'Sebas handed this to Ledger: Ledger knows billing',
            handoff: {
                kind: 'handoff',
                from: { id: 'd1', name: 'Sebas' },
                to: { id: 'd2', name: 'Ledger' },
                reason: 'Ledger knows billing',
            },
        },
        {
            id: 'm3',
            role: 'assistant',
            content: 'Billing is fine.',
            socioId: 'd2',
        },
    ];
    await open('/chats/r1');
    await until(() => !!$('[data-room-handoff]'), 'the handoff line');
    expect($('[data-room-handoff]')!.textContent).toBe('Sebas handed this to Ledger: Ledger knows billing');
    expect($('[data-room-handoff]')!.getAttribute('role')).toBe('note');
    const speakers = [...document.querySelectorAll('[data-room-speaker]')].map(
        (label) => `${label.getAttribute('data-room-speaker')}:${label.textContent?.replace(/\s+/g, '')}`,
    );
    // The handoff is no one's message: no speaker for it.
    expect(speakers).toEqual(['person:BRBobReyes', 'socio:Sebassocio', 'socio:Ledgersocio']);
    // The composer says who a message goes to before it is sent.
    const box = $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    const sendTo = () => $('[data-slot="room-send-to"]')!.textContent;
    expect(sendTo()).toContain('To Sebas, the lead');
    type(box, 'Quick one');
    key(byLabel('Mention a socio')!, 'Enter');
    await until(() => !!item('Ledger'), 'the socio picker');
    expect(item('Sebas')!.textContent).toContain('lead');
    click(item('Ledger'));
    await until(() => box.value === 'Quick one @Ledger ', 'the mention');
    // Focus is back in the message, after the name, to type on.
    await until(() => document.activeElement === box, 'focus in the box');
    expect(box.selectionStart).toBe('Quick one @Ledger '.length);
    expect(sendTo()).toContain('To Ledger');
    type(box, `${box.value}and @Sebas`);
    expect(sendTo()).toContain('To Ledger, then Sebas');
    // CB-284: typing @Sebas now opens the @mention picker (socios are in it).
    // Close it so Enter sends, not picks.
    key(box, 'Escape');
    await until(() => !$('[data-slot="people-mentions"]'), 'the picker closed');
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests).toContain('POST /api/conversations/r1/steering {"text":"Quick one @Ledger and @Sebas"}');
    // Members shows the handoffs a room admin may lower.
    click(button('Members'));
    await until(() => !!$('[data-slot="room-handoffs"] select'), 'the handoffs control');
    const options = [...document.querySelectorAll('[data-slot="room-handoffs"] option')].map(
        (option) => option.textContent,
    );
    expect(options).toEqual(['The workspace’s (4)', '1', '2', '3']);
    // Lowered, the room's other limits are saved as they were.
    select($<HTMLSelectElement>('[data-slot="room-handoffs"] select')!, '2');
    await until(() => requests.some((line) => line.startsWith('PUT /api/rooms/r1/limits')), 'the save');
    expect(requests).toContain('PUT /api/rooms/r1/limits {"cycleTokens":500000,"handoffsPerCycle":2}');
    await until(() => $<HTMLSelectElement>('[data-slot="room-handoffs"] select')!.value === '2', 'the saved value');
});

it('tells two active people with one name apart in words: Members, the people picker and the messages', async () => {
    const bob2 = {
        userId: 'bob-2',
        name: 'Bob Reyes',
        role: 'member' as const,
        status: 'active' as const,
        invitedBy: 'alice',
        invitedAt: 3,
        inviteExpiresAt: null,
        acceptedAt: 4,
    };
    view = roomView();
    view = roomView({ members: [...view.members, bob2] });
    transcript = [
        ...TRANSCRIPT,
        {
            id: 'm4',
            role: 'user',
            content: 'I can take the notes.',
            author: { id: 'bob-2', name: 'Bob Reyes', you: false },
        },
    ];
    transcript[0] = {
        ...(transcript[0] as object),
        author: { id: 'bob', name: 'Bob Reyes', you: false },
    };
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="person"]'), 'the transcript');
    // The messages: by join order, Bob (joined at 2) is 1, the other 2.
    const speakers = [...document.querySelectorAll('[data-room-speaker="person"]')].map((label) => label.textContent);
    expect(speakers).toEqual(['BRBob Reyes · 1', 'BRBob Reyes · 2']);
    // The people picker.
    const box = $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    box.focus();
    type(box, '@Bo');
    await until(() => !!$('[data-mention-option]'), 'the people picker');
    expect([...document.querySelectorAll('[data-mention-option]')].map((option) => option.textContent)).toEqual([
        'BRBob Reyes · 1',
        'BRBob Reyes · 2',
    ]);
    key(box, 'ArrowDown');
    key(box, 'Enter');
    // The text says the name; the pick is the second Bob, by id.
    await until(() => box.value === '@Bob Reyes ', 'the mention');
    type(box, `${box.value}hi`);
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests.find((line) => line.includes('/steering'))).toContain(
        '"mentions":[{"userId":"bob-2","label":"Bob Reyes"}]',
    );
    // Members, and its ⋯ by the number too.
    click(button('Members'));
    await until(() => !!$('[data-room-member="bob-2"]'), 'the members');
    expect($('[data-room-member="bob"]')!.textContent).toContain('Bob Reyes · 1');
    expect($('[data-room-member="bob-2"]')!.textContent).toContain('Bob Reyes · 2');
    expect(byLabel('Options for Bob Reyes · 2')).not.toBeNull();
    // Alice, alone with her name, is as she was.
    expect($('[data-room-member="alice"]')!.textContent).toContain('Alice Lima (you)');
});

it('tells a member the handoff limit even when the room’s use and budget are hidden from them', async () => {
    me = { id: 'bob', name: 'Bob Reyes', role: 'member' };
    handoffs = 2;
    view = roomView({
        role: 'member',
        usageVisible: false,
        socios: [
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
            { dotId: 'd2', name: 'Ledger', status: 'active', lead: false },
        ],
    });
    await open('/chats/r1');
    await until(() => !!button('Members'), 'the room');
    click(button('Members'));
    await until(() => !!$('[data-slot="room-handoffs"]'), 'the handoff limit');
    // Said in words, with no control and nothing of the budget.
    expect($('[data-slot="room-handoffs"]')!.textContent).toBe(
        'A message’s work can pass between socios up to 2 times.',
    );
    expect($('[data-slot="room-handoffs"] select')).toBeNull();
    expect($('[data-slot="room-members"]')!.textContent).not.toContain('Use and limits');
});

it('with one socio: no picker, and the lead’s name as before', async () => {
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="socio"]'), 'the transcript');
    expect(byLabel('Mention a socio')).toBeNull();
    expect($('[data-slot="room-send-to"]')!.textContent).toBe('Everyone in the room reads it');
});

// CB-219: the room's screens with a keyboard, a screen reader and a finger.

it('says what the socio does in a polite region that is always there, never the reply as it streams (CB-219)', async () => {
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="socio"]'), 'the transcript');
    // There before anything runs, so the first change is heard.
    const live = $('[data-slot="room-live-status"]')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');
    // The transcript is in no live region, so a streamed reply is never
    // read out word by word; the only live bits in it are a message's
    // "wasn't sent", empty unless one failed (CB-154).
    const transcript = $('[data-chat-transcript]')!;
    expect(transcript.closest('[aria-live], [role="status"]')).toBeNull();
    const inside = () => [...transcript.querySelectorAll('[aria-live], [role="status"], [role="log"]')];
    expect(inside().map((region) => region.textContent)).toEqual(inside().map(() => ''));
    const box = $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    type(box, 'Ship it');
    key(box, 'Enter');
    await until(() => live.textContent === 'Sebas is answering…', 'the status');
    // The visible line says the same, and isn't said twice.
    const notice = $('[data-slot="chat-notice"]')!;
    expect(notice.textContent).toBe('Sebas is answering…');
    expect(notice.getAttribute('role')).toBeNull();
    expect(notice.getAttribute('aria-hidden')).toBe('true');
});

it('the people picker is a list the text box controls, by keyboard, with its count said (CB-219)', async () => {
    view = roomView({
        members: [
            ...roomView().members,
            {
                userId: 'bea',
                name: 'Bea Cruz',
                role: 'member',
                status: 'active',
                invitedBy: 'alice',
                invitedAt: 1,
                inviteExpiresAt: null,
                acceptedAt: 3,
            },
        ],
    });
    await open('/chats/r1');
    await until(() => !!$('[data-room-speaker="socio"]'), 'the transcript');
    const box = $<HTMLTextAreaElement>('textarea[aria-label="Message the room"]')!;
    const status = $('[data-slot="people-mentions-status"]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    expect(box.getAttribute('aria-autocomplete')).toBe('list');
    expect(box.getAttribute('aria-haspopup')).toBe('listbox');
    expect(box.hasAttribute('aria-controls')).toBe(false);
    act(() => box.focus());
    type(box, '@B');
    act(() => {
        box.setSelectionRange(2, 2);
        box.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await until(() => !!$('[role="listbox"]'), 'the list');
    const list = $('[role="listbox"]')!;
    // CB-284: the picker now names socios too, though @B matches only people.
    expect(list.getAttribute('aria-label')).toBe('People and socios in the room');
    expect(box.getAttribute('aria-controls')).toBe(list.id);
    const options = [...list.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(['BCBea Cruz', 'BRBob Reyes']);
    // Each option is a finger's size on a touch screen.
    for (const option of options) {
        expect(option.className).toContain('pointer-coarse:min-h-11');
    }
    expect(status.textContent).toBe('2 people to mention');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    // Escape closes it, and says so by saying nothing more.
    key(box, 'Escape');
    expect($('[role="listbox"]')).toBeNull();
    expect(box.hasAttribute('aria-activedescendant')).toBe(false);
    expect(status.textContent).toBe('');
});

it('autocompletes socios alongside people in the @mention picker, labeled by kind (CB-284)', async () => {
    moreDots = [
        {
            id: 'd2',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Ledger',
            instructions: 'Knows billing.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ];
    view = roomView({
        socios: [
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
            { dotId: 'd2', name: 'Ledger', status: 'active', lead: false },
        ],
    });
    await open('/chats/r1');
    await until(() => !!$('[data-slot="room-composer"]'), 'the composer');
    const box = $('[data-slot="room-composer"] textarea') as HTMLTextAreaElement;
    act(() => box.focus());
    // @S matches Sebas (a socio) — no people's names start with S.
    type(box, '@S');
    await until(() => !!$('[data-slot="people-mentions"]'), 'the picker');
    const options = [...$('[data-slot="people-mentions"]')!.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(1);
    const socio = options[0]!;
    expect(socio.getAttribute('data-mention-kind')).toBe('socio');
    expect(socio.textContent).toContain('Sebas');
    expect(socio.textContent).toContain('lead');
    // Picking the socio inserts @Sebas (the server routes by the text).
    click(socio);
    await until(() => box.value === '@Sebas ', 'the socio mention inserted');
    // A socio pick carries no people-mention payload: the send has no mentions.
    key(box, 'Enter');
    await until(() => requests.some((line) => line.includes('/steering')), 'the send');
    expect(requests).toContain('POST /api/conversations/r1/steering {"text":"@Sebas"}');
});

it('an edited pin takes the focus; Escape cancels the edit, not the panel, and focus goes back to Edit (CB-219)', async () => {
    await open('/chats/r1?pins=1');
    await until(() => !!$('[data-room-pin="p1"]'), 'the pins');
    const edit = () =>
        [...$('[data-room-pin="p1"]')!.querySelectorAll('button')].find((item) => item.textContent === 'Edit');
    click(edit());
    await until(() => !!$('[data-room-pin="p1"] textarea'), 'the editor');
    const editor = $<HTMLTextAreaElement>('[data-room-pin="p1"] textarea')!;
    expect(document.activeElement).toBe(editor);
    key(editor, 'Escape');
    await until(() => !$('[data-room-pin="p1"] textarea'), 'the edit cancelled');
    // The panel stays, and focus is back where the edit began.
    expect($('[data-slot="room-pins"]')).not.toBeNull();
    await until(() => document.activeElement === edit(), 'focus on Edit');
    // Escape outside an edit still closes the panel.
    key(edit()!, 'Escape');
    await until(() => !$('[data-slot="room-pins"]'), 'the panel closed');
});

it('a queued message’s Edit gets the focus back, and its Cancel hands it to the message box (CB-219)', async () => {
    running = true;
    mine = [{ id: 'q7', text: 'One more thing', createdAt: 4, updatedAt: 4 }];
    await open('/chats/r1');
    await until(() => !!$('[data-queued-message="q7"]'), 'the queued message');
    const queued = $('[data-queued-message="q7"]')!;
    const edit = () => [...queued.querySelectorAll('button')].find((item) => item.textContent === 'Edit');
    for (const control of queued.querySelectorAll('button')) {
        expect(control.className).toContain('pointer-coarse:min-h-11');
    }
    click(edit());
    const editor = $<HTMLTextAreaElement>('textarea[aria-label="Edit queued message"]')!;
    expect(document.activeElement).toBe(editor);
    key(editor, 'Escape');
    await until(() => document.activeElement === edit(), 'focus on Edit');
    click(button('Cancel queued message'));
    await until(() => requests.includes('DELETE /api/conversations/r1/steering/q7 {}'), 'the cancel');
    await until(() => !$('[data-queued-message="q7"]'), 'the message gone');
    expect(document.activeElement).toBe($('[data-slot="room-composer"] textarea'));
});

it('gives a finger 44 px across the room’s controls (CB-219)', async () => {
    moreDots = [
        {
            id: 'd2',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Ledger',
            instructions: 'Knows billing.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ];
    view = roomView({
        socios: [
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
            { dotId: 'd2', name: 'Ledger', status: 'active', lead: false },
        ],
    });
    await open('/chats/r1');
    await until(() => !!byLabel('Mention a socio'), 'the socio picker');
    const touch = 'pointer-coarse:min-h-11';
    expect(button('Pinned')!.className).toContain(touch);
    expect(button('Members')!.className).toContain(touch);
    expect(byLabel('Mention a socio')!.className).toContain('size-11');
    // The socio picker's items.
    key(byLabel('Mention a socio')!, 'Enter');
    await until(() => !!$('[data-socio="d2"]'), 'the socios');
    expect($('[data-socio="d2"]')!.className).toContain(touch);
    key(document.activeElement!, 'Escape');
    await until(() => !$('[data-socio="d2"]'), 'the picker closed');
    await until(() => document.activeElement === byLabel('Mention a socio'), 'focus back on the picker');
    // The room's sidebar row and its ⋯, as every sidebar row (the
    // sidebar's own, app-wide).
    const row = $('[data-room-row="r1"]')!;
    expect(row.querySelector('a')!.className).toContain(touch);
    expect(byLabel('Options for Launch room')!.className).toContain('pointer-coarse:after:-inset-3');
    // Members: a person's ⋯, the socios' buttons, Leave.
    click(button('Members'));
    await until(() => !!byLabel('Options for Bob Reyes'), 'the members');
    expect(byLabel('Options for Bob Reyes')!.className).toContain('pointer-coarse:size-11');
    expect(button('Make lead')!.className).toContain(touch);
    expect(button('Leave room')!.className).toContain(touch);
    // The panel's own close has a finger's hit area too.
    const close = [...$('[data-slot="room-members"]')!.querySelectorAll('button')].find(
        (item) => item.textContent === 'Close',
    )!;
    expect(close.className).toContain('pointer-coarse:after:-inset-3.5');
});

it('gives focus back to what opened a room dialog: a sidebar button, a notice, a menu’s ⋯ (CB-219)', async () => {
    invites = [invite()];
    await open('/');
    await until(() => !!byLabel('New room'), 'the Rooms group');
    // New room, from the sidebar's +.
    act(() => byLabel('New room')!.focus());
    click(byLabel('New room'));
    await until(() => !!$('[data-slot="create-room"]'), 'the dialog');
    key($('[data-slot="create-room"]')!, 'Escape');
    await until(() => !$('[data-slot="create-room"]'), 'the dialog closed');
    await until(() => document.activeElement === byLabel('New room'), 'focus on New room');
    // The invitations, from Home's notice.
    const review = button('Review')!;
    act(() => review.focus());
    click(review);
    await until(() => !!$('[data-slot="room-invites"]'), 'the invitations');
    key($('[data-slot="room-invites"]')!, 'Escape');
    await until(() => !$('[data-slot="room-invites"]'), 'the invitations closed');
    await until(() => document.activeElement === review, 'focus on Review');
    // Rename, from the room's ⋯ in the sidebar.
    const options = byLabel('Options for Launch room')!;
    act(() => options.focus());
    key(options, 'Enter');
    await until(() => !!item('Rename'), 'the room menu');
    act(() => item('Rename')!.focus());
    click(item('Rename'));
    await until(() => !!$('[data-slot="rename-room"]'), 'the rename dialog');
    key($('[data-slot="rename-room"]')!, 'Escape');
    await until(() => !$('[data-slot="rename-room"]'), 'the dialog closed');
    await until(() => document.activeElement === options, 'focus on its ⋯');
});
