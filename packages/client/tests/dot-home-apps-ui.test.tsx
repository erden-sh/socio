// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DotAppEntry, DotAppsState } from '@socio/shared/apps/app-types';
import type { Dot, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// CB-260: a socio's home page lists the apps it built that this person may
// open (the server decides which, tests/apps.test.ts), published or in
// development, without asking for their state or starting any. The live
// chat is a stand-in, as in dot-home-ui.test.tsx.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
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
const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
    id,
    spaceId: 's1',
    spaceIds: ['s1'],
    name,
    instructions: `${name} helps.`,
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
    ...extra,
});
const workspace = (): WorkspaceState => ({
    user: { id: 'bob', name: 'Bob', role: 'member' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [dot('d1', 'Dot'), dot('d2', 'Ada')],
    conversations: [],
    archived: [],
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});
const entry = (id: string, name: string, extra: Partial<DotAppEntry> = {}): DotAppEntry => ({
    id,
    name,
    description: '',
    status: 'ephemeral',
    owner: true,
    sharedSpaceName: null,
    liveVersion: null,
    updatedAt: Date.now() - 60_000,
    ...extra,
});

let apps: DotAppsState | 'fail' = { enabled: true, apps: [] };
let asked: string[] = [];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    asked.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    if (path === '/api/schedules') {
        return [200, { goals: [], schedules: [], jobs: [] }];
    }
    if (path === '/api/approvals') {
        return [200, { pending: [] }];
    }
    if (path.endsWith('/runs')) {
        return [200, []];
    }
    if (path === '/api/issues/filed') {
        return [200, []];
    }
    if (path === '/api/apps/dots/d1') {
        return apps === 'fail' ? [500, { error: 'Boom.' }] : [200, apps];
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
    Element.prototype.scrollIntoView = () => {};
    apps = { enabled: true, apps: [] };
    asked = [];
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
    await until(() => !!host.querySelector('[data-slot="dot-home"]'), 'home');
    return router;
}
const section = () => host.querySelector<HTMLElement>('[data-slot="dot-apps"]');
const items = () => [...host.querySelectorAll<HTMLElement>('[data-slot="dot-app"]')];
const linkOf = (item: HTMLElement) => item.querySelector('a')!;

it('lists its apps with their stage, each opening without starting it', async () => {
    apps = {
        enabled: true,
        apps: [
            entry('board--dot', 'Board', {
                status: 'promoted',
                liveVersion: 3,
                description: 'The team’s board.',
                sharedSpaceName: 'Everyday',
            }),
            entry('tracker--dot', 'Tracker', {
                owner: false,
                ownerName: 'Alice',
            }),
            entry('draft--dot', 'Draft', { status: 'packaged' }),
            entry('old--dot', 'Old', { status: 'unpublished', liveVersion: 1 }),
        ],
    };
    await open('/dots/d1');
    await until(() => items().length === 4, 'the apps');
    // The section is named, after the dashboard and before the chats.
    const named = section()!;
    expect(named.getAttribute('aria-labelledby')).toBe('dot-apps');
    expect(host.querySelector('#dot-apps')?.textContent).toBe('Apps');
    const order = [...host.querySelectorAll('[data-slot="dot-home-column"], #dot-apps, #dot-chats')].map(
        (element) => element.id || 'column',
    );
    expect(order.indexOf('dot-apps')).toBeGreaterThan(order.lastIndexOf('column'));
    expect(order.indexOf('dot-apps')).toBeLessThan(order.indexOf('dot-chats'));
    // Published or in development, as the server said; details per row.
    expect(
        items().map((item) => [item.dataset.status, item.querySelector('[data-slot="dot-app-stage"]')?.textContent]),
    ).toEqual([
        ['promoted', 'Published'],
        ['ephemeral', 'In development'],
        ['packaged', 'In development'],
        ['unpublished', 'Unpublished'],
    ]);
    const [board, tracker, draft, old] = items();
    expect(board.textContent).toMatch(/Board.*The team’s board\..*Version 3 · Shared with Everyday · /);
    expect(tracker.textContent).toContain('Shared by Alice');
    expect(draft.textContent).toContain('Only you');
    // A row opens the app through the sign-in hand-off, in a new tab; an
    // unpublished one goes to the Apps page, where its owner publishes it.
    for (const [item, id] of [
        [board, 'board--dot'],
        [tracker, 'tracker--dot'],
        [draft, 'draft--dot'],
    ] as const) {
        const link = linkOf(item);
        expect(link.getAttribute('href')).toBe(`/apps/${id}/open`);
        expect(link.target).toBe('_blank');
        expect(link.rel).toContain('noopener');
        expect(link.textContent).toContain('(opens in a new tab)');
    }
    expect(linkOf(old).getAttribute('href')).toBe('/apps');
    expect(linkOf(old).target).toBe('');
    // All apps: the Apps page.
    const all = [...named.querySelectorAll('a')].find((link) => link.textContent === 'All apps');
    expect(all?.getAttribute('href')).toBe('/apps');
    // Keyboard: every row is a real link in the tab order.
    for (const item of items()) {
        const link = linkOf(item);
        act(() => link.focus());
        expect(document.activeElement).toBe(link);
        expect(link.tabIndex).toBe(0);
    }
    // One light read for this socio: never the probing list, a launch or a start.
    expect(asked).toContain('GET /api/apps/dots/d1');
    expect(asked.filter((line) => /\/api\/apps(\?|$)/.test(line))).toEqual([]);
    expect(asked.filter((line) => /launch|start|publish/.test(line))).toEqual([]);
});

it('stacks on a narrow screen and widens in columns', async () => {
    apps = { enabled: true, apps: [entry('a--dot', 'A'), entry('b--dot', 'B')] };
    await open('/dots/d1');
    await until(() => items().length === 2, 'the apps');
    const list = host.querySelector<HTMLElement>('[data-slot="dot-apps-list"]')!;
    // One column by default (narrow), more only by the page's container width.
    expect(list.className.split(' ')).toContain('grid-cols-1');
    expect(
        list.className
            .split(' ')
            .filter((name) => /grid-cols-[2-9]/.test(name))
            .every((name) => name.startsWith('@')),
    ).toBe(true);
    // Long names and descriptions truncate or clamp instead of overflowing.
    for (const item of items()) {
        expect(item.className).toContain('min-w-0');
        expect(item.querySelector('.truncate')).not.toBeNull();
    }
});

it('says so when it has no apps this person can open', async () => {
    await open('/dots/d1');
    await until(() => !!host.querySelector('[data-slot="dot-apps-empty"]'), 'the empty state');
    expect(host.querySelector('[data-slot="dot-apps-empty"]')?.textContent).toMatch(
        /^Dot hasn’t built an app you can open yet\./,
    );
    expect(items()).toEqual([]);
});

it('says so when its apps could not be read', async () => {
    apps = 'fail';
    await open('/dots/d1');
    await until(
        () => host.querySelector('[data-slot="dot-apps-empty"]')?.textContent === 'Could not load its apps.',
        'the failure',
    );
});

it('shows no section where mini apps are not set up', async () => {
    apps = { enabled: false, apps: [] };
    await open('/dots/d1');
    await until(() => asked.includes('GET /api/apps/dots/d1'), 'the read');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(section()).toBeNull();
});
