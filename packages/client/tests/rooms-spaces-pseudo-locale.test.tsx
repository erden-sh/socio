// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import { createReactI18n, I18nextProvider } from '@socio/i18n/react';
import ROUTES from '@socio/i18n/route-namespaces.json';
import { REACTION_LABELS } from '@socio/shared/chat/reactions';
import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { RoomPinsState } from '@socio/shared/rooms/room-pins';
import type { RoomView } from '@socio/shared/rooms/rooms';
import type { SpaceMemoryState, SpacePeopleView } from '@socio/shared/space-memory';
import type { Conversation, State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { PRIVATE_SPACE_COVERS } from '../src/components/private-space';

import { fetchServices, createTestRouter } from './helpers/app-router';

// Rooms and Spaces in en-XA, the pseudo-locale, through the app's real
// routes: each loader asks for its route's namespaces
// (route-namespaces.json) and gets them in en-XA, nothing more, and what
// loads on demand comes from this server's files (the fetch below). Text
// that stays plain English was never translated, and a raw key means a
// route doesn't inline what its page shows. Only Rooms' and Spaces' own
// parts of each page are read: other modules' (a page's view, components/)
// aren't theirs.

// The room's live chat isn't read here (shell-chat-pseudo-locale's job).
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.setConfig({ testTimeout: 30_000 });

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);
const inlined = new Set(
    Object.entries(routes)
        .filter(([id]) => !id.startsWith('$'))
        .flatMap(([, namespaces]) => namespaces),
);
const roomsOrSpaces = (ns: string) => /^(rooms|spaces)(\.|$)/.test(ns);

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out
// from route-namespaces.json, so a namespace a route should inline but
// doesn't stays missing, and its keys show. The live chat's (chat,
// chat.composer…) load on demand on a room's page too.
const ON_DEMAND = ['rooms', 'rooms.dialogs', 'rooms.members', 'rooms.pins', 'spaces.dialogs', 'spaces.promote'];
const SERVED = [...ON_DEMAND, 'chat', 'chat.composer', 'chat.model', 'chat.trace', 'chat.report'];
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || SERVED.includes(ns))
                    .map((ns) => [ns, { hash: 'test', sourceHash: 'test' }]),
            ),
        },
    },
};
const pseudoPage = (namespaces: readonly string[]): PageI18n => ({
    locale: 'en-XA',
    dir: 'ltr',
    manifest,
    resources: { 'en-XA': Object.fromEntries(namespaces.map((ns) => [ns, pseudo(ns)])) },
    offered: ['en-US'],
});

const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const state = {
    settings: { name: 'Alpha', paused: false, researchAllowed: false, memoryAllowed: true, rooms: { enabled: true } },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
const room: Conversation = {
    id: 'r1',
    dotId: 'd1',
    ownerId: 'room:r1',
    title: 'Gamma',
    createdAt: 2,
    kind: 'room',
    roomRole: 'admin',
};
const workspace = {
    user,
    spaces: [{ id: 's1', name: 'Delta', description: '', createdAt: 1, access: 'editor' }],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceId: 's1', spaceIds: ['s1'], createdAt: 1 }],
    conversations: [room],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
    permissions: { createSpaces: true },
} as unknown as WorkspaceState;

const roomView: RoomView = {
    id: 'r1',
    title: 'Gamma',
    dotId: 'd1',
    createdAt: 1,
    createdBy: 'u-ada',
    convertedAt: null,
    archivedAt: null,
    role: 'admin',
    roomsEnabled: true,
    members: [
        {
            userId: 'u-ada',
            name: 'Ada',
            role: 'admin',
            status: 'active',
            invitedBy: null,
            invitedAt: 1,
            inviteExpiresAt: null,
            acceptedAt: 1,
        },
        {
            userId: 'u-alice',
            name: 'Alice',
            role: 'member',
            status: 'active',
            invitedBy: 'u-ada',
            invitedAt: 1,
            inviteExpiresAt: null,
            acceptedAt: 2,
        },
    ],
    socios: [{ dotId: 'd1', name: 'Bob', status: 'active', lead: true }],
} as RoomView;
const pin = {
    id: 'v1',
    pinId: 'p1',
    version: 1,
    text: 'Zeta',
    status: 'pinned',
    origin: 'person',
    supersedes: null,
    pinnedBy: 'u-alice',
    pinnedByName: 'Alice',
    proposedBy: 'u-alice',
    proposedByName: 'Alice',
    proposedAt: 1,
    decidedBy: 'u-ada',
    decidedByName: 'Ada',
    decidedAt: 2,
    endedBy: null,
    endedByName: null,
    endedAt: null,
};
const pins = {
    roomId: 'r1',
    pins: [pin],
    proposals: [{ ...pin, id: 'q1', pinId: 'p2', version: null, text: 'Theta', status: 'proposed', decidedBy: null }],
    can: { propose: true, manage: true },
    quota: { pins: 1, maxPins: 30, chars: 4, maxChars: 6000, proposals: 1, maxProposals: 50 },
    notes: { current: null, versions: [] },
} as unknown as RoomPinsState;

const entry = {
    id: 'v1',
    entryId: 'e1',
    spaceId: 's1',
    version: 1,
    text: 'Iota',
    status: 'active',
    proposedBy: 'u-alice',
    dotId: null,
    threadId: null,
    supersedes: null,
    createdAt: Date.UTC(2026, 9, 1),
    decidedBy: 'u-ada',
    decidedAt: Date.UTC(2026, 9, 2),
    endedBy: null,
    endedAt: null,
    proposedByName: 'Alice',
    dotName: null,
    chatTitle: null,
    decidedByName: 'Ada',
    endedByName: null,
};
const memory = {
    spaceId: 's1',
    access: 'editor',
    entries: [entry],
    proposals: [{ ...entry, id: 'p1', entryId: 'e2', version: null, status: 'proposed', text: 'Kappa' }],
    retired: [],
    retentionDays: 30,
} as unknown as SpaceMemoryState;
const people: SpacePeopleView = {
    spaceId: 's1',
    membersOnly: false,
    people: [{ userId: 'u-alice', name: 'Alice', role: 'member', addedBy: 'u-ada', addedAt: 1 }],
    access: 'editor',
    candidates: [{ id: 'u-eta', name: 'Eta' }],
};
const now = Date.UTC(2026, 10, 20);
const radarEntry = (id: string, title: string, ageDays: number) => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    excerpt: '',
    revision: 2,
    revisions: 1,
    createdAt: now - 400 * 86_400_000,
    updatedAt: now - ageDays * 86_400_000,
    ageDays,
});
const radar = {
    spaceId: 's1',
    now,
    staleDays: 90,
    recent: [radarEntry('pg1', 'Epsilon', 1)],
    open: [{ ...radarEntry('pg1', 'Epsilon', 1), markers: ['todo'], snippet: '' }],
    stale: [radarEntry('pg2', 'Lambda', 200)],
    total: 2,
} as unknown as SpaceRadar;
const page = (id: string, title: string) => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    content: '',
    createdAt: 1,
    updatedAt: Date.UTC(2026, 10, 1),
    revision: 1,
    kind: 'page',
});

/** The data words: names in the fixtures. */
const FIXTURE_TEXT = [
    'Alpha',
    'Gamma',
    'Delta',
    'Epsilon',
    'Zeta',
    'Theta',
    'Iota',
    'Kappa',
    'Lambda',
    'Eta',
    'Bob',
    'Ada',
    'Alice',
    'Mu',
    'Nu',
    // Dates in the fixtures, which Intl spells in English for en-XA.
    'Sep',
    'Oct',
    'Nov',
    'May',
    'PM',
    // The radar's open marker, a word found in the page.
    'todo',
];
/**
 * Shared components' and packages/shared's words, not translated yet: the
 * sidebar's toggle, the breadcrumb's landmark, a dialog's close button, the
 * private Space's lock and the mascot's label (components/, locals/), the
 * Ctrl key, a room's status line (@socio/shared/rooms) and the reactions'
 * labels (@socio/shared/chat).
 */
const SHARED_TEXT = [
    'Toggle Sidebar',
    'Collapse sidebar',
    'breadcrumb',
    'Close',
    'Socio is idle',
    'is idle',
    'Ctrl',
    PRIVATE_SPACE_COVERS,
    'Private: only this Space’s people see it',
    'Private Space',
    'Room · 2 people · Bob answers · you’re an admin',
    ...Object.values(REACTION_LABELS),
];

const respond = (path: string): [number, unknown] => {
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/rooms/invites') {
        return [200, []];
    }
    if (path === '/api/rooms/r1') {
        return [200, roomView];
    }
    if (path === '/api/rooms/r1/pins') {
        return [200, pins];
    }
    if (path === '/api/rooms/r1/invitable') {
        return [200, [{ userId: 'u-eta', name: 'Eta' }]];
    }
    if (path === '/api/rooms/r1/limits/handoffs') {
        return [200, { workspace: 4, room: null, effective: 4 }];
    }
    if (path === '/api/conversations/r1/transcript') {
        return [
            200,
            {
                messages: [
                    { id: 'm1', role: 'user', content: 'Mu', author: { name: 'Alice', you: false } },
                    { id: 'm2', role: 'assistant', content: 'Nu' },
                ],
            },
        ];
    }
    if (path === '/api/conversations/r1/steering') {
        return [200, { messages: [], limit: 5 }];
    }
    if (path === '/api/conversations/r1/reactions') {
        return [200, { shared: true, messages: {} }];
    }
    if (path === '/api/spaces/s1/pages') {
        return [200, [page('pg1', 'Epsilon'), page('pg2', 'Lambda')]];
    }
    if (path === '/api/spaces/s1/memory') {
        return [200, memory];
    }
    if (path === '/api/spaces/s1/people') {
        return [200, people];
    }
    if (path === '/api/spaces/s1/radar') {
        return [200, radar];
    }
    // Whatever else a page asks: nothing to show, in no words.
    return [404, { error: '—' }];
};

let host: HTMLElement;
let root: Root | undefined;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView ??= () => {};
    window.matchMedia = (query: string) =>
        ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as never;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', async (input: string) => {
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            return SERVED.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
        }
        const [status, body] = respond(new URL(input, 'http://app.test').pathname);
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
});

/** What a person reads in `node`, without the parts `skip` names (other modules'). */
function readable(node: Element, skip: readonly string[] = []) {
    const copy = node.cloneNode(true) as Element;
    for (const selector of skip) {
        for (const element of copy.querySelectorAll(selector)) {
            element.remove();
        }
    }
    const attributes = [...copy.querySelectorAll('[aria-label], [title], [placeholder], [alt]')].flatMap((element) =>
        ['aria-label', 'title', 'placeholder', 'alt']
            .map((name) => element.getAttribute(name))
            .filter((value): value is string => !!value),
    );
    return [copy.textContent ?? '', ...attributes];
}

/** The English left once every pseudo-locale string (in brackets) and the fixtures' words are taken out. */
function untranslated(texts: readonly string[]) {
    return texts.flatMap((text) => {
        let rest = text;
        for (let before = ''; before !== rest;) {
            before = rest;
            rest = rest.replace(/\[[^[\]]*\]/g, ' ');
        }
        for (const fixture of [...SHARED_TEXT, ...FIXTURE_TEXT]) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]);
    });
}

async function settle(ticks = 12) {
    for (let tick = 0; tick < ticks; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

async function open(path: string) {
    const router = createTestRouter(path, {
        services: () => ({ ...fetchServices(), i18n: async (namespaces) => pseudoPage(namespaces) }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    return router;
}

const $ = (selector: string) => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found!;
};

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];

it('loads on demand only what no route inlines, and every Rooms and Spaces namespace has a home', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter(roomsOrSpaces);
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    for (const id of ['spaces:space', 'spaces:memory', 'spaces:radar', 'spaces:settings']) {
        expect(routes[id], id).toBeDefined();
    }
    expect(routes.root).toEqual(expect.arrayContaining(['rooms.nav', 'spaces.nav']));
});

it('renders a Space’s library, the header and both sidebars in en-XA with only their namespaces', async () => {
    await open('/spaces/s1');
    $('[data-slot="space-library"]');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="space-library"]')))).toEqual([]);
    expect(untranslated(readable($('[data-slot="space-tabs"]')))).toEqual([]);
    expect(untranslated(readable($('[data-slot="rooms-group"]')))).toEqual([]);
    // The Spaces group: its label and Create Space, without its tree
    // (components/nav-spaces).
    expect(untranslated(readable($('[data-slot="spaces-group"]'), ['[data-sidebar="menu"]']))).toEqual([]);
});

it.each([
    ['/spaces/s1/memory', 'space-memory'],
    ['/spaces/s1/radar', 'space-radar'],
    ['/spaces/s1/settings', 'space-settings'],
])('renders the Space tab %s in en-XA with only its namespaces', async (path, slot) => {
    await open(path);
    $(`[data-slot="${slot}"]`);
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});

it('renders a room in en-XA, with its members and pins, from its on-demand namespaces', async () => {
    await open('/chats/r1?members=1&pins=1');
    await settle(20);
    $('[data-slot="room-composer"]');
    $('[data-slot="room-members"]');
    $('[data-slot="room-pins"]');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        expect(untranslated(readable(dialog))).toEqual([]);
    }
});

it('loads a Space tab’s namespaces with its own loader alone when moving between tabs', async () => {
    const asked: string[][] = [];
    const router = createTestRouter('/spaces/s1', {
        services: () => ({
            ...fetchServices(),
            i18n: async (namespaces) => {
                asked.push([...namespaces]);
                return pseudoPage(namespaces);
            },
        }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    expect(asked).toContainEqual(routes['spaces:space']);
    asked.length = 0;
    await act(async () => router.navigate('/spaces/s1/memory'));
    await settle();
    // Only the tab's loader runs: the Space's (and the root's) hold.
    expect(asked).toEqual([routes['spaces:memory']]);
    expect(untranslated(readable($('[data-slot="space-memory"]')))).toEqual([]);
});

/** A server render with the root's namespaces only (its instance has no backend). */
function serverRender(node: ReactNode) {
    const server = createReactI18n({
        locale: 'en-XA',
        resources: { 'en-XA': Object.fromEntries(routes.root!.map((ns) => [ns, pseudo(ns)])) },
        namespaces: routes.root!,
    });
    return renderToString(<I18nextProvider i18n={server}>{node}</I18nextProvider>);
}

it('renders nothing on the server for what loads on demand, never its keys', async () => {
    const { DeleteSpaceDialog } = await import('../src/modules/spaces/DeleteSpaceDialog');
    const { PlaceDatasetDialog } = await import('../src/modules/spaces/PlaceDatasetDialog');
    const { PromoteFindingDialog } = await import('../src/modules/spaces/PromoteFindingDialog');
    const { CreateRoomDialog } = await import('../src/modules/rooms/RoomDialogs');
    const anyProps = {} as never;
    for (const Component of [DeleteSpaceDialog, PlaceDatasetDialog, PromoteFindingDialog, CreateRoomDialog]) {
        expect(serverRender(<Component {...anyProps} />), Component.displayName).toBe('');
    }
});
