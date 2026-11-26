// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { pageSummary, type Page } from '@socio/shared/pages/page-library';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import {
    createTestRouter,
    fetchServices,
    loadRouteModule,
    type LoadRouteModule,
} from '../../packages/client/tests/helpers/app-router';
import { memoriesOf } from '../../packages/client/tests/helpers/memories';

// Radix checkboxes measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

// Chat isn't configured in these workspaces, so CopilotKit never renders;
// its package imports a stylesheet Node can't load.
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
    memories: [{ id: 'm1', text: 'Keep it short.', createdAt: 1 }],
    mode: 'live',
    configured: false,
};

function workspace(role: Role): WorkspaceState {
    return {
        user: { id: role, name: role === 'admin' ? 'Alice' : 'Bob', role },
        spaces: [
            { id: 's1', name: 'Everyday', description: '', createdAt: 1 },
            { id: 's2', name: 'Engineering', description: '', createdAt: 2 },
        ],
        dots: ['Dot', 'Fulano'].map((name, index) => ({
            id: `d${index + 1}`,
            spaceId: 's1',
            spaceIds: ['s1'],
            name,
            instructions: `${name} helps.`,
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: index,
        })),
        conversations: [
            // A team conversation: its stored transcript has an old hash link.
            {
                id: 'c0',
                dotId: 'd2',
                ownerId: role,
                title: 'Team plan',
                createdAt: 2,
                team: true,
            },
            { id: 'c1', dotId: 'd1', ownerId: role, title: 'Mine', createdAt: 1 },
        ],
        // Chat isn't configured, so no CopilotKit runtime is needed here.
        setup: {
            model: false,
            voice: false,
            telegram: 'not_configured',
            missing: ['model'],
        },
        calls: [],
    };
}

// Stored content written before paths: a chat reply with the old link form.
const transcript = {
    messages: [
        {
            id: 'reply',
            role: 'assistant',
            content: 'Saved [the plan](/#/spaces/s1/pages/p1) for the team.',
        },
    ],
};

let role: Role = 'admin';
// Signed out, the user's data answers 401 until a mock sign-in.
let signedIn = true;
let requests: string[] = [];
// What loaders and module gates asked for: the server's part, here in the
// browser, once per navigation.
let served: string[] = [];
// Each Space's pages (none unless a test adds some).
let pages: Record<string, Page[]> = {};
const respond = (path: string, init?: RequestInit): [number, unknown] => {
    if (path === '/api/auth/session') {
        return [200, { provider: 'mock', user: null }];
    }
    if (path === '/api/auth/mock/users') {
        return [200, [{ id: 'member', name: 'Bob', role: 'member' }]];
    }
    if (path === '/api/auth/mock/login') {
        signedIn = true;
        role = 'member';
        return [200, { id: 'member' }];
    }
    if (path === '/api/auth/logout') {
        signedIn = false;
        return [200, { ok: true }];
    }
    if (!signedIn) {
        return [401, { error: 'Sign in to continue.' }];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/memories') {
        return [200, memoriesOf(state.memories)];
    }
    if (path === '/api/workspace') {
        return [200, workspace(role)];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path.startsWith('/api/runs')) {
        return [200, { limit: 100, runs: [] }];
    }
    if (path === '/api/notifications/channels') {
        return [
            200,
            {
                channels: [
                    {
                        id: 'push',
                        label: 'Push notifications',
                        enabled: true,
                        content: 'message',
                        targets: [],
                    },
                ],
                pushKey: 'AQID',
            },
        ];
    }
    // The list has excerpts, not bodies (CB-71).
    const spacePages = path.match(/^\/api\/spaces\/([^/]+)\/pages$/);
    if (spacePages) {
        return [200, (pages[spacePages[1]!] ?? []).map(pageSummary)];
    }
    // A page save (autosave's PATCH) answers with the saved page.
    const pageSave = path.match(/^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/);
    const saved = pageSave
        ? (pages[pageSave[1]!] as { id: string; revision: number }[] | undefined)?.find(
              (page) => page.id === pageSave[2],
          )
        : undefined;
    if (saved && init?.method === 'PATCH') {
        Object.assign(saved, JSON.parse(String(init.body)), {
            revision: saved.revision + 1,
        });
        return [200, saved];
    }
    if (saved) {
        return [200, saved];
    }
    if (path === '/api/conversations/c0/transcript') {
        return [200, transcript];
    }
    if (path.endsWith('/capture')) {
        return [200, null];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
// The views load lazily; give each test room when the machine is busy.
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
    served = [];
    signedIn = true;
    pages = {};
    role = 'admin';
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push(path);
        const [status, body] = respond(path, init);
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

/** Waits (in act) until `check` holds, for up to 5 s (lazy routes load slowly under load). */
async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}

async function open(path: string, as: Role = 'admin', load?: LoadRouteModule) {
    role = as;
    const router = createTestRouter(path, {
        load,
        services: () => fetchServices(served),
    });
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const crumb = () => host.querySelector('[data-slot="breadcrumb-page"]')?.textContent;
const text = () => host.textContent ?? '';
const at = (router: ReturnType<typeof createMemoryRouter>) => router.state.location.pathname;
async function go(router: ReturnType<typeof createMemoryRouter>, to: string) {
    await act(() => router.navigate(to));
}

it('renders each view at its own address', async () => {
    const started = Date.now();
    const router = await open('/');
    expect(crumb()).toBe('Home');
    expect(host.querySelector('[data-slot="home-title"]')?.textContent).toBe('Home');
    const views: [string, string, RegExp][] = [
        // A Dot's home page, then a new chat with it (CB-89).
        ['/dots/d1', 'Dot', /Dot helps\./],
        ['/dots/d2', 'Fulano', /Fulano helps\./],
        ['/dots/d2/new', 'New chat', /Fulano helps\./],
        ['/activity', 'Activity', /A little follow-through/],
        ['/memories', 'Memories', /Keep it short\./],
        ['/learning', 'Learning', /What your socios are learning/],
        ['/issues', 'Issues', /0 open · 0 in progress · 0 done/],
        ['/runs', 'Runs', /Recent turns across the team/],
        ['/spaces/s2', 'Pages', /Engineering/],
        // A conversation's crumb is its title (CB-66), after its Dot's name.
        ['/chats/c0', 'Team plan', /Team conversation in Telegram/],
        ['/nowhere', 'Not found', /Page not found/],
        // The last Dot opened (Fulano, in c0) stays the home Dot.
        ['/chats/missing', 'Fulano', /Conversation not found/],
    ];
    for (const [path, title, body] of views) {
        await go(router, path);
        await until(() => body.test(text()), path);
        expect(crumb(), path).toBe(title);
        expect(at(router)).toBe(path);
    }
    // The sidebar follows the URL.
    await go(router, '/memories');
    const memories = [...host.querySelectorAll('a')].find((link) => link.textContent?.trim().startsWith('Memories'));
    expect(memories?.getAttribute('aria-current')).toBe('page');
    // Navigating never adds a workspace poll: the shell started from its
    // loader, and its own timer asks once per 3 s the walk took (a loaded
    // machine can pass 3 s).
    const count = (list: string[]) => list.filter((path) => path === '/api/workspace').length;
    expect(count(served)).toBeGreaterThanOrEqual(1);
    expect(count(requests) - count(served)).toBeLessThanOrEqual(Math.floor((Date.now() - started) / 3000));
});

it('starts module pages with the shared page header, first in the page (CB-91, CB-220)', async () => {
    const router = await open('/');
    const heading = () => host.querySelector('.legacy-view h1')?.closest('[data-page-heading]');
    const pages: [string, RegExp][] = [
        ['/activity', /A little follow-through/],
        ['/memories', /Keep it short\./],
        ['/data', /What your socios keep for you/],
        ['/media', /Files you and your socios keep/],
        ['/approvals', /Actions with side effects wait for you/],
        ['/apps', /Mini apps your socios build/],
        ['/schedules', /Schedules & jobs/],
        ['/learning', /What your socios are learning/],
        ['/runs', /Recent turns across the team/],
        ['/admin/dots', /Every socio in the workspace/],
        ['/admin/agents', /Connected agents/],
        ['/settings/workspace', /Your workspace, your rules/],
        ['/spaces/s2', /Engineering/],
    ];
    for (const [path, body] of pages) {
        await go(router, path);
        await until(() => body.test(text()) && !!heading(), path);
        // Nothing above it in its page frame: the frame's top is the space.
        expect(heading()!.previousElementSibling, path).toBeNull();
        expect(heading()!.parentElement!.matches('main, section'), path).toBe(true);
    }
    // The Space library has the same header as every other page, with its
    // module's tile.
    expect(heading()!.querySelector('h1')!.className).toContain('md:text-[1.75rem]');
    expect(heading()!.querySelector('span[aria-hidden] svg')).not.toBeNull();
});

it('shows members their own Runs and names Learning Skills', async () => {
    const router = await open('/runs', 'member');
    // A member's own turns (CB-128), not the team's.
    await until(() => /Your recent turns with socios/.test(text()), 'Runs');
    expect(at(router)).toBe('/runs');
    expect(text()).not.toContain('Recent turns across the team');
    await go(router, '/learning');
    await until(() => /Skills\./.test(text()), 'Skills');
    expect(crumb()).toBe('Skills');
    // Admins stay.
    act(() => root.unmount());
    root = createRoot(host);
    const admin = await open('/runs');
    await until(() => /Recent turns/.test(text()), 'Runs');
    expect(at(admin)).toBe('/runs');
});

it('sends /spaces to the first Space and /settings to the settings pages', async () => {
    const router = await open('/spaces');
    await until(() => at(router) === '/spaces/s1', 'the first Space');
    expect(crumb()).toBe('Pages');
    // `/settings` was the Settings dialog's address (CB-18): its first page.
    await go(router, '/settings');
    await until(() => at(router) === '/settings/workspace', 'the redirect');
    await until(() => /Your workspace, your rules/.test(text()), 'Settings');
    expect(crumb()).toBe('General');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const nav = () =>
        [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings"] a')].map((link) => [
            link.textContent,
            link.getAttribute('aria-current'),
        ]);
    // Mock sign-in: no Connected agents; no Telegram bot. People is there
    // for its Service accounts tab (CB-360).
    expect(nav()).toEqual([
        ['General', 'page'],
        ['People', null],
        // Admins' since the operator role was retired (CB-390).
        ['Access', null],
        ['Secrets', null],
        ['Data API', null],
        ['Chat skills', null],
        ['Deleted Spaces', null],
        ['Optional features', null],
        ['Early access', null],
        ['Platform', null],
        ['Profile', null],
        ['Notifications', null],
        ['Inference', null],
        ['Archived chats', null],
        ['Performance', null],
    ]);
    await go(router, '/settings/inference');
    await until(() => crumb() === 'Inference', 'Inference');
    expect(nav()[12]).toEqual(['Inference', 'page']);
    // Account → Notifications (CB-114).
    await go(router, '/settings/notifications');
    await until(() => /Turn it on in each browser|Push notifications/.test(text()), 'Notifications');
    expect(nav()[11]).toEqual(['Notifications', 'page']);
    // An unknown section goes to the first page.
    await go(router, '/settings/nope');
    await until(() => at(router) === '/settings/workspace', 'the unknown one');
});

it('sends Settings → Service accounts to its tab of People, and opens a person’s page (CB-360)', async () => {
    const router = await open('/settings/workspace');
    await go(router, '/settings/service-accounts');
    await until(() => at(router) === '/settings/people', 'the redirect');
    expect(router.state.location.search).toBe('?tab=service-accounts');
    await until(() => !!host.querySelector('[data-slot="service-accounts"]'), 'the Service accounts tab');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(/^Service accounts/);
    expect(crumb()).toBe('People');
    // A person's page: People stays current in the nav; mock sign-in has no accounts.
    await go(router, '/settings/people/someone');
    await until(() => !!host.querySelector('[data-slot="person-page"]'), 'the person page');
    expect(host.querySelector('[data-slot="person-page"] a')?.getAttribute('href')).toBe('/settings/people');
    const people = [...host.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings"] a')].find(
        (link) => link.textContent === 'People',
    );
    expect(people?.getAttribute('aria-current')).toBe('page');
});

it('keeps members to their settings pages', async () => {
    const router = await open('/settings/service-accounts', 'member');
    await until(() => at(router) === '/settings/workspace', 'the redirect');
    await until(() => /Only an admin can change these settings/.test(text()), 'read only');
    expect([...host.querySelectorAll('nav[aria-label="Settings"] a')].map((link) => link.textContent)).toEqual([
        'General',
        'Profile',
        'Notifications',
        'Inference',
        'Archived chats',
        'Performance',
    ]);
});

it('redirects an old hash link to its path, on load and on a hash change', async () => {
    const router = await open('/#/spaces/s1/pages/p1');
    await until(() => at(router) === '/spaces/s1/pages/p1', 'the redirect');
    expect(router.state.location.hash).toBe('');
    expect([...host.querySelectorAll('[data-slot="breadcrumb-link"]')].map((link) => link.textContent)).toEqual([
        'Home',
        'Everyday',
    ]);
    // A hash that isn't an old route is left alone.
    await go(router, '/#section');
    expect(at(router)).toBe('/');
    expect(router.state.location.hash).toBe('#section');
    await go(router, '/#/spaces/s2');
    await until(() => at(router) === '/spaces/s2', 'the second redirect');
});

it('opens an old hash link in a stored chat message in the app', async () => {
    const router = await open('/chats/c0');
    await until(() => /the plan/.test(text()), 'the transcript');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
        (element) => element.textContent === 'the plan',
    );
    // Rendered with its path, followed by the router (no page load).
    expect(link?.getAttribute('href')).toBe('/spaces/s1/pages/p1');
    act(() => link!.click());
    await until(() => at(router) === '/spaces/s1/pages/p1', 'the page');
    expect(crumb()).toBe('Pages');
});

it('shows a page’s title in the breadcrumb and follows a rename (CB-38)', async () => {
    pages = {
        s1: [
            {
                id: 'p1',
                spaceId: 's1',
                parentId: null,
                title: 'Garden plan',
                content: 'Tomatoes first.',
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                sourceThreadId: null,
                createdBy: null,
                cover: null,
                sourceUrl: null,
                sourceTitle: null,
                folder: false,
            },
        ],
    };
    const router = await open('/spaces/s1/pages/p1');
    await until(() => crumb() === 'Garden plan', 'the page title');
    expect([...host.querySelectorAll('[data-slot="breadcrumb-link"]')].map((link) => link.textContent)).toEqual([
        'Home',
        'Everyday',
    ]);
    // Renaming in the title field updates the header as it is typed.
    const input = host.querySelector<HTMLInputElement>('textarea[aria-label="Page title"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Garden plan 2027');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => crumb() === 'Garden plan 2027', 'the new title');
    await until(() => !/Saving|Unsaved/.test(text()), 'the save');
    // The library is Pages again; an unknown page keeps the generic crumb.
    await go(router, '/spaces/s1');
    await until(() => crumb() === 'Pages', 'the library');
    await go(router, '/spaces/s1/pages/missing');
    await until(() => /Page not found/.test(text()), 'not found');
    expect(crumb()).toBe('Pages');
});

it('shows a page that fails to render in the page area, with the shell around it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The Runs page throws while rendering. (A page whose code is gone after
    // a deploy never gets here: React Router reloads the page instead.)
    const load: LoadRouteModule = (file) =>
        file === 'modules/runs/RunsPage.route.tsx'
            ? {
                  default: () => {
                      throw new Error('The Runs page broke.');
                  },
              }
            : loadRouteModule(file);
    const router = await open('/', 'admin', load);
    await go(router, '/runs');
    await until(() => /This page failed to load/.test(text()), 'the error');
    expect(at(router)).toBe('/runs');
    expect(crumb()).toBe('Runs');
    expect(text()).not.toContain('The Runs page broke');
    // The rest of the app still works.
    await go(router, '/memories');
    await until(() => /Keep it short\./.test(text()), 'Memories');
});

it('starts signed out from the loader, and runs the loaders again after sign-in and sign-out', async () => {
    signedIn = false;
    const router = createTestRouter('/runs', {
        services: () => fetchServices(served),
    });
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => /Continue as Bob/.test(text()), 'the sign-in screen');
    // What sign-in offers came from the loader, not a fetch of its own.
    expect(served).toContain('/api/auth/session');
    expect(requests.filter((path) => path === '/api/auth/session')).toEqual(['/api/auth/session']);
    served = [];
    const button = [...host.querySelectorAll('button')].find((item) =>
        item.textContent?.startsWith('Continue as Bob'),
    )!;
    await act(async () => button.click());
    // The loaders ran again for bob: Runs shows a member their own turns.
    await until(() => /Your recent turns with socios/.test(text()), 'the shell');
    expect(at(router)).toBe('/runs');
    expect(served).toContain('/api/workspace');
    expect(text()).not.toContain('Recent turns across the team');
    // Switching user signs out, and the shell's loader says so.
    served = [];
    act(() => {
        host.querySelector('[aria-label="Account: Bob"]')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
    });
    const switchUser = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes('Switch user'),
    )!;
    await act(async () => switchUser.click());
    await until(() => /Continue as Bob/.test(text()), 'sign-in again');
    await until(() => served.includes('/api/auth/session'), 'the loader');
    expect(requests).toContain('/api/auth/logout');
});
