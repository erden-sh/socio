// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CursorPage, OperationsSettingsView, OpsTurnRow } from '@socio/shared/operations/operations';
import type {
    OpsAccessRow,
    OpsChatHistoryPage,
    OpsChatView,
    OpsRoomAudit,
    OpsTranscriptRun,
} from '@socio/shared/operations/operations-access';
import type { State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// CB-188's pages: Operations → Access log, the admin transcript view of a
// chat, and the Overview's turns linking to it.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
};
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role: 'admin' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Manny',
            instructions: 'Manny helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});

const NOW = Date.UTC(2026, 9, 22, 12);
const HOUR = 3_600_000;
const ENTRIES = 60;
const GONE = '0b5e4a51-2d7c-4c1e-9d3a-7f6e5d4c3b2a';
const entry = (index: number): OpsAccessRow => ({
    at: NOW - index * HOUR,
    viewerId: index % 2 ? 'olga' : 'alice',
    viewerName: index % 2 ? 'Olga' : 'Alice',
    surface: index % 3 ? 'turns' : 'chat',
    subjectKind: index % 3 ? 'person' : 'chat',
    subjectId: index % 3 ? 'bob' : 't-bob',
    subjectName: index % 3 ? 'Bob' : 'Quarterly numbers',
    content: !(index % 3),
    filters: index % 3 ? { person: 'bob' } : { via: 'overview' },
    filterNames: index % 3 ? { person: 'Bob' } : {},
    requestId: `r${index}`,
    // The third: a deleted socio's turns, narrowed to a Space.
    ...(index === 2 && {
        subjectKind: 'socio',
        subjectId: GONE,
        subjectName: null,
        filters: { via: 'activity', socio: GONE, space: 's1', range: '30d' },
        filterNames: { socio: null, space: 'Engineering' },
    }),
    // The fourth: a room's transcript (CB-213), kept with its room.
    ...(index === 3 && {
        subjectId: 't-room',
        subjectName: 'Launch',
        filters: { room: 't-room', via: 'activity' },
        filterNames: { room: 'Launch' },
    }),
    // The sixth: a room's turn's trace, with its initiator and socio.
    ...(index === 5 && {
        surface: 'trace',
        subjectKind: 'run',
        subjectId: 'run-room',
        subjectName: null,
        content: true,
        filters: { room: 't-room', initiator: 'ada', socio: 'd1' },
        filterNames: { room: 'Launch', initiator: 'Ada', socio: 'Manny' },
    }),
    id: `e${index}`,
});
const TURNS = 25;
const run = (index: number): OpsTranscriptRun => ({
    seq: index + 1,
    prev: index ? index : null,
    runId: `run-${index}`,
    status: 'finished',
    startedAt: NOW - (TURNS - index) * HOUR,
    finishedAt: NOW - (TURNS - index) * HOUR + 1000,
    messages: [
        {
            id: `u${index}`,
            role: 'user',
            content: `Question ${index}`,
            metadata: { author: { name: 'Bob', you: false } },
        },
        { id: `a${index}`, role: 'assistant', content: `Answer ${index}` },
    ],
    times: { messages: [], tools: [], reasoning: [] },
    light: {},
    size: 100,
});
const chat: OpsChatView = {
    id: 't-bob',
    title: 'Quarterly numbers',
    socioId: 'd1',
    socioName: 'Manny',
    ownerId: 'bob',
    ownerName: 'Bob',
    createdAt: NOW - 30 * HOUR,
    archivedAt: null,
    team: false,
    room: null,
};

let requests: string[] = [];
const settings: OperationsSettingsView = {
    timeZone: 'UTC',
    sessionGapMinutes: 30,
    defaults: { timeZone: 'UTC', sessionGapMinutes: 30 },
};
const page = <T,>(url: URL, all: number, size: number, item: (index: number) => T): CursorPage<T> => {
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const end = Math.min(all, start + size);
    return {
        items: Array.from({ length: end - start }, (_, i) => item(start + i)),
        next: end < all ? String(end) : null,
    };
};
const respond = (url: URL): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path.startsWith('/api/operations/')) {
        requests.push(`${path}${url.search}`);
    }
    if (path === '/api/operations/settings') {
        return [200, settings];
    }
    if (path === '/api/operations/access-log') {
        return [200, page(url, ENTRIES, Number(url.searchParams.get('limit')), entry)];
    }
    if (path === '/api/operations/chats/t-bob') {
        return [200, chat];
    }
    // What its turns read (CB-194).
    if (path === '/api/operations/chats/t-bob/grounding') {
        return [
            200,
            {
                refs: [
                    {
                        kind: 'page',
                        spaceId: 's1',
                        spaceName: 'Everyday',
                        refId: 'p1',
                        title: 'Pricing policy',
                        runs: 3,
                        firstAt: Date.UTC(2026, 9, 21, 6),
                        lastAt: Date.UTC(2026, 9, 21, 9),
                    },
                    {
                        kind: 'dataset',
                        spaceId: null,
                        spaceName: null,
                        refId: 'ds1',
                        title: null,
                        runs: 1,
                        firstAt: Date.UTC(2026, 9, 21, 7),
                        lastAt: Date.UTC(2026, 9, 21, 7),
                    },
                    {
                        kind: 'recall',
                        spaceId: null,
                        spaceName: null,
                        refId: 'call-1',
                        title: null,
                        runs: 1,
                        firstAt: Date.UTC(2026, 9, 21, 8),
                        lastAt: Date.UTC(2026, 9, 21, 8),
                    },
                ],
                more: false,
            },
        ];
    }
    if (path === '/api/operations/chats/t-bob/history')
    // Newest first, 20 turns a page.
    {
        return [200, page(url, TURNS, 20, (index) => run(TURNS - 1 - index)) satisfies OpsChatHistoryPage];
    }
    // A Telegram team topic: the server names each message's author.
    if (path === '/api/operations/chats/t-team') {
        return [
            200,
            {
                ...chat,
                id: 't-team',
                title: 'Team agenda',
                ownerId: 'telegram-team:-100',
                ownerName: 'Telegram team',
                team: true,
            },
        ];
    }
    if (path === '/api/operations/chats/t-team/history') {
        return [
            200,
            {
                items: [
                    {
                        ...run(0),
                        messages: [
                            {
                                id: 'm1',
                                role: 'user',
                                content: 'What is on the agenda?',
                                metadata: { author: { name: 'Bob', you: false } },
                            },
                            {
                                id: 'm2',
                                role: 'user',
                                content: 'And the budget?',
                                metadata: { author: { name: 'Olga', you: false } },
                            },
                            { id: 'm3', role: 'assistant', content: 'The offsite.' },
                        ],
                    },
                ],
                next: null,
            } satisfies OpsChatHistoryPage,
        ];
    }
    // A room (CB-213): its people in the heading, its audit on request.
    if (path === '/api/operations/chats/t-room') {
        return [
            200,
            {
                ...chat,
                id: 't-room',
                title: 'Launch',
                ownerId: 'room:t-room',
                ownerName: null,
                room: {
                    members: [
                        { name: 'Ada', role: 'admin', status: 'active' },
                        { name: 'Mo', role: 'member', status: 'active' },
                        { name: 'Ivy', role: 'member', status: 'invited' },
                    ],
                    socios: [{ name: 'Manny', lead: true }],
                    createdByName: 'Ada',
                    convertedAt: null,
                },
            } satisfies OpsChatView,
        ];
    }
    if (path === '/api/operations/chats/t-room/history') {
        return [200, { items: [], next: null } satisfies OpsChatHistoryPage];
    }
    if (path === '/api/operations/chats/t-room/room-events') {
        return [
            200,
            {
                events: [
                    {
                        id: 3,
                        at: NOW - HOUR,
                        actorName: 'Nina',
                        action: 'denied',
                        targetKind: 'room',
                        targetName: 'Launch',
                        outcome: 'denied',
                        detail: 'read: not_found',
                    },
                    {
                        id: 2,
                        at: NOW - 2 * HOUR,
                        actorName: 'Ada',
                        action: 'invite',
                        targetKind: 'person',
                        targetName: 'Mo',
                        outcome: 'ok',
                        detail: 'member',
                    },
                    {
                        id: 1,
                        at: NOW - 3 * HOUR,
                        actorName: 'Ada',
                        action: 'create',
                        targetKind: 'room',
                        targetName: 'Launch',
                        outcome: 'ok',
                        detail: '',
                    },
                ],
            } satisfies OpsRoomAudit,
        ];
    }
    if (path === '/api/operations/chats/gone') {
        return [404, { error: 'There is no such chat.' }];
    }
    if (path === '/api/operations/turns') {
        return [
            200,
            page(url, 2, 50, (index): OpsTurnRow => ({
                runId: `r${index}`,
                threadId: 't-bob',
                socioId: 'd1',
                socioName: 'Manny',
                source: 'web',
                status: 'finished',
                startedAt: NOW - index * HOUR,
                finishedAt: NOW - index * HOUR + 1000,
                tokens: 1200,
                toolCalls: 1,
                toolErrors: 0,
            })),
        ];
    }
    if (path === '/api/operations/overview' || path.startsWith('/api/operations/series')) {
        return [500, { error: 'Not in this test.' }];
    }
    return [404, { error: 'Not found.' }];
};

let observers: Array<{
    callback: IntersectionObserverCallback;
    nodes: Element[];
}> = [];
const scrollToEnd = () =>
    act(() => {
        for (const observer of observers) {
            observer.callback(
                observer.nodes.map((target) => ({ isIntersecting: true, target }) as never),
                observer as never,
            );
        }
    });

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
    requests = [];
    observers = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            nodes: Element[] = [];
            constructor(public callback: IntersectionObserverCallback) {
                observers.push(this);
            }
            observe(node: Element) {
                this.nodes.push(node);
            }
            disconnect() {
                observers = observers.filter((item) => item !== this);
            }
        },
    );
    vi.stubGlobal('fetch', async (input: string) => {
        const [status, body] = respond(new URL(input, 'http://app.test'));
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
const heading = () => host.querySelector('h1')?.textContent;
const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name);
const entries = () => [...host.querySelectorAll<HTMLElement>('[data-slot="ops-access-entry"]')];

it('lists every admin’s views, newest first, loading more as it scrolls', async () => {
    await open('/operations/access-log');
    await until(() => heading() === 'Access log', 'the section');
    await until(() => entries().length === 50, 'the first page');
    // A log, not a slice of the range: no range bar.
    expect(host.querySelector('[aria-label="Range"]')).toBeNull();
    const [chatOpen, personList] = entries();
    expect(chatOpen.textContent).toBe('AliceChat transcriptQuarterly numbersContentfrom Overview · Oct 22, 12:00');
    expect(chatOpen.querySelector('a')?.getAttribute('href')).toBe('/operations/chats/t-bob?via=access-log');
    expect(personList.textContent).toBe('OlgaTurns listBobperson Bob · Oct 22, 11:00');
    expect(personList.querySelector('a')?.getAttribute('href')).toBe('/operations?person=bob');
    scrollToEnd();
    await until(() => entries().length === ENTRIES, 'the rest');
    expect(requests).toEqual(
        expect.arrayContaining([
            '/api/operations/access-log?limit=50',
            '/api/operations/access-log?limit=50&cursor=50',
        ]),
    );
});

it('names the socio, person and Space an entry was narrowed to, or a short id once gone', async () => {
    await open('/operations/access-log');
    await until(() => entries().length === 50, 'the first page');
    const gone = entries()[2];
    expect(gone.textContent).toBe(
        'AliceTurns list0b5e4a51…from Activity · socio 0b5e4a51…, space Engineering, range 30d · Oct 22, 10:00',
    );
    expect(gone.textContent).not.toContain(GONE);
    expect(gone.querySelector('a')?.getAttribute('href')).toBe(`/operations?socio=${GONE}`);
});

it('reads a chat for an admin, newest turns first, and says the view is logged', async () => {
    await open('/operations/chats/t-bob?via=overview');
    await until(() => heading() === 'Quarterly numbers', 'the chat');
    await until(() => !!host.textContent?.includes('Answer 24'), 'the newest turns');
    // The heading's request comes first, so the log has the open before the turns.
    expect(requests.slice(-2)).toEqual([
        '/api/operations/chats/t-bob?via=overview',
        '/api/operations/chats/t-bob/history?via=overview&limit=50',
    ]);
    expect(host.textContent).toContain('Manny with Bob, since Oct 21, 06:00. Read-only.');
    const note = host.querySelector('[data-slot="ops-transcript-note"]')!;
    expect(note.textContent).toContain('Opening it was written to the access log');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/operations/access-log');
    // The person's messages on the left, with their name; no composer.
    const people = [...host.querySelectorAll<HTMLElement>('[data-chat-message="other"]')];
    expect(people).toHaveLength(20);
    expect(people[0].querySelector('[data-chat-author]')?.textContent).toBe('Bob');
    expect(host.querySelector('textarea')).toBeNull();
    // Oldest to newest on screen, the earlier ones on request.
    const text = host.querySelector('[data-slot="ops-transcript"]')!.textContent!;
    expect(text.indexOf('Question 5')).toBeLessThan(text.indexOf('Question 24'));
    expect(text).not.toContain('Question 4');
    act(() => button('Load earlier turns')!.click());
    await until(() => !!host.textContent?.includes('Question 0'), 'the earlier turns');
    expect(requests.at(-1)).toBe('/api/operations/chats/t-bob/history?via=overview&limit=50&cursor=20');
    expect(button('Load earlier turns')).toBeUndefined();
    const all = host.querySelector('[data-slot="ops-transcript"]')!.textContent!;
    expect(all.indexOf('Question 0')).toBeLessThan(all.indexOf('Question 5'));
});

it('names each person in a team topic’s transcript, not the team', async () => {
    await open('/operations/chats/t-team?via=overview');
    await until(() => heading() === 'Team agenda', 'the chat');
    await until(() => !!host.textContent?.includes('The offsite.'), 'the transcript');
    expect(host.textContent).toContain('Manny with Telegram team');
    const people = [...host.querySelectorAll<HTMLElement>('[data-chat-message="other"]')];
    expect(
        people.map((message) => [
            message.querySelector('[data-chat-author]')?.textContent,
            message.textContent?.includes('agenda')
                ? 'agenda'
                : message.textContent?.includes('budget')
                  ? 'budget'
                  : '',
        ]),
    ).toEqual([
        ['Bob', 'agenda'],
        ['Olga', 'budget'],
    ]);
});

it('says when a chat can’t be opened', async () => {
    await open('/operations/chats/gone');
    await until(() => host.querySelector('[role="alert"]')?.textContent === 'There is no such chat.', 'the error');
    expect(requests).not.toContain('/api/operations/chats/gone/history');
});

it('links each of the Overview’s turns to its chat', async () => {
    await open('/operations');
    await until(() => host.querySelectorAll('[data-slot="ops-turn"]').length === 2, 'the turns');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('[data-slot="ops-turn"] a')].find(
        (item) => item.textContent === 'Open chat',
    )!;
    expect(link.getAttribute('href')).toBe('/operations/chats/t-bob?via=overview');
    expect(link.getAttribute('aria-label')).toBe('Open the chat of Manny’s turn at Oct 22, 12:00');
});

it('shows what grounded a chat once asked, from the logged route (CB-194)', async () => {
    await open('/operations/chats/t-bob?via=overview');
    await until(() => heading() === 'Quarterly numbers', 'the chat');
    const card = host.querySelector('[data-slot="ops-chat-grounding"]')!;
    expect(card.textContent).toContain('What grounded this chat');
    // Read only when opened.
    expect(requests.some((path) => path.includes('/grounding'))).toBe(false);
    const details = card.querySelector('details')!;
    act(() => {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
    });
    await until(() => !!host.querySelector('[data-slot="ops-chat-refs"]'), 'the references');
    expect(requests).toContain('/api/operations/chats/t-bob/grounding?via=overview');
    const refs = host.querySelector('[data-slot="ops-chat-refs"]')!;
    expect(refs.querySelectorAll('li')).toHaveLength(2);
    expect(refs.textContent).toContain('Pricing policy');
    expect(refs.textContent).toContain('Everyday');
    expect(refs.textContent).toContain('3 turns');
    expect(refs.textContent).toContain('A removed dataset');
    // Recalls of the chat itself are counted, not listed.
    expect(host.querySelector('[data-slot="ops-chat-recalls"]')!.textContent).toContain(
        'Recalled 1 earlier part of this chat',
    );
});

it('marks a room’s entries, and says a room turn’s room, initiator and socio (CB-213)', async () => {
    await open('/operations/access-log');
    await until(() => entries().length === 50, 'the first page');
    const room = entries()[3];
    expect(room.textContent).toBe('OlgaChat transcriptLaunchRoomContentfrom Activity · Oct 22, 09:00');
    expect(room.querySelector('a')?.getAttribute('href')).toBe('/operations/chats/t-room?via=access-log');
    const trace = entries()[5];
    expect(trace.textContent).toBe(
        'OlgaTurn tracerun-roomContentroom Launch, started by Ada, socio Manny · Oct 22, 07:00',
    );
    expect(trace.textContent).not.toContain('room:');
});

it('heads a room with its people, not an owner, and shows its audit from the logged route (CB-213)', async () => {
    await open('/operations/chats/t-room?via=access-log');
    await until(() => heading() === 'Launch', 'the room');
    expect(host.textContent).toContain(
        'A room: Manny with Ada (admin), Mo; 1 invited, since Oct 21, 06:00. Read-only.',
    );
    expect(host.querySelector('[data-slot="ops-transcript-note"]')!.textContent).toContain(
        'You’re reading this room as an admin.',
    );
    const card = host.querySelector('[data-slot="ops-room-audit"]')!;
    expect(card.textContent).toContain('Room audit');
    // Read only when opened.
    expect(requests.some((path) => path.includes('/room-events'))).toBe(false);
    const details = card.querySelector('details')!;
    act(() => {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
    });
    await until(() => !!host.querySelector('[data-slot="ops-room-events"]'), 'the audit');
    expect(requests).toContain('/api/operations/chats/t-room/room-events?via=access-log');
    const lines = [...host.querySelectorAll<HTMLElement>('[data-slot="ops-room-events"] li')];
    expect(lines.map((line) => line.textContent)).toEqual([
        'Nina was refused · read: not_foundRefusedOct 22, 11:00',
        'Ada invited Mo · memberOct 22, 10:00',
        'Ada made the roomOct 22, 09:00',
    ]);
    expect(lines[0]!.dataset.outcome).toBe('denied');
});

it('gives a private chat no room audit', async () => {
    await open('/operations/chats/t-bob?via=overview');
    await until(() => heading() === 'Quarterly numbers', 'the chat');
    expect(host.querySelector('[data-slot="ops-room-audit"]')).toBeNull();
});
