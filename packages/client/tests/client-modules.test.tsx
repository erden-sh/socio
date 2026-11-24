import { FlaskConical } from 'lucide-react';
// @vitest-environment jsdom
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider, type RouteObject } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ModuleId } from '@socio/shared/modules';
import type { AgentRunSummary, Role, State, WorkspaceState } from '@socio/shared/types';

import { ModulesProvider } from '../src/modules/context';
import {
    launcherCards,
    moduleCommands,
    navGroups,
    sidebarEntries,
    slotEntries,
    visibleModules,
} from '../src/modules/derive';
import { gateHandle, ModuleGate } from '../src/modules/gate';
import { clientModules } from '../src/modules/registry';
import type { ClientModule, ModuleContext, PaletteCommand, SlotProps } from '../src/modules/types';
import { isPaletteShortcut } from '../src/shell/CommandPalette';

import { createTestRouter } from './helpers/app-router';
import { memoriesOf } from './helpers/memories';

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
        spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
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
            {
                id: 'c1',
                dotId: 'd1',
                ownerId: role,
                title: 'Garden plan',
                createdAt: 1,
            },
        ],
        setup: {
            model: false,
            voice: false,
            telegram: 'not_configured',
            missing: ['model'],
        },
        calls: [],
    };
}

const contextFor = (role: Role): ModuleContext => {
    const space = workspace(role);
    return {
        admin: role === 'admin',
        workspace: space,
        state,
        configured: false,
        homeDot: space.dots[0]!,
    };
};

it('carries document navigation through plugin sidebar, launcher and palette targets', () => {
    const context = contextFor('admin');
    context.workspace.plugins = [
        ...['embed', 'tab'].map((display) => ({
            id: display,
            name: display,
            description: '',
            display: display as 'embed' | 'tab',
            mode: 'service' as const,
            openAllow: [],
            openAnyHttps: false,
            routes: false,
            origin: `https://${display}.apps.example`,
            entryPath: '/',
        })),
        {
            id: 'calendar',
            name: 'Calendar',
            description: '',
            display: 'embed' as const,
            mode: 'bundled' as const,
            openAllow: [],
            openAnyHttps: false,
            routes: false,
            origin: '',
            entryPath: '/',
        },
    ];
    for (const derive of [sidebarEntries, launcherCards]) {
        const entries = derive(clientModules, context);
        // A bundled plugin is a page of this client: a client navigation.
        expect(entries.find((item) => item.id === 'plugin:calendar')?.opens).toEqual({
            path: '/plugins/calendar',
            reloadDocument: false,
            activeBelow: true,
        });
        expect(entries.find((item) => item.id === 'plugin:embed')?.opens).toEqual({
            path: '/plugins/embed',
            reloadDocument: true,
            activeBelow: true,
        });
        // A tab plugin opens from its own address too (CB-446): no page under it is the platform's.
        expect(entries.find((item) => item.id === 'plugin:tab')?.opens).toEqual({
            path: '/plugins/tab',
            reloadDocument: false,
            activeBelow: true,
        });
    }
    const open = vi.fn();
    moduleCommands(clientModules, context)
        .find((item) => item.id === 'plugin:embed')!
        .run({ open } as unknown as Parameters<PaletteCommand['run']>[0]);
    expect(open).toHaveBeenCalledWith({
        path: '/plugins/embed',
        reloadDocument: true,
        activeBelow: true,
    });
    // Members get the plugins the server listed for them (their audience).
    const member = contextFor('member');
    member.workspace.plugins = context.workspace.plugins;
    expect(sidebarEntries(clientModules, member).map((item) => item.id)).toContain('plugin:calendar');
});

// A module written the way a new one is: a manifest with slot
// contributions, added with one line (here: appended to the list), and its
// pages: a gate layout and a route, as its `routes.ts` and route files give
// them (here: route objects added to the shell).
function FakeAction({ moduleId }: SlotProps['header.actions']) {
    return <button aria-label="Fake action">on {moduleId ?? 'home'}</button>;
}
function FakeRunAction({ run }: SlotProps['run.actions']) {
    return <button aria-label={`Fake run action ${run.runId}`}>File</button>;
}
function FakeWidget() {
    return <p>Fake widget says hi</p>;
}
const fake: ClientModule = {
    id: 'fake' as ModuleId,
    title: 'Fake lab',
    description: 'A module the registry has never seen.',
    icon: FlaskConical,
    tone: 'rose',
    order: 65,
    opens: { path: '/fake' },
    sidebar: 'workspace',
    badge: () => 7,
    commands: () => [
        {
            id: 'fake:brew',
            label: 'Brew a potion',
            group: 'Actions',
            run: ({ navigate }) => navigate('/fake'),
        },
    ],
    slots: {
        'header.actions': [FakeAction],
        'run.actions': [FakeRunAction],
        'home.widgets': [FakeWidget],
    },
};
const secret: ClientModule = {
    ...fake,
    id: 'secret' as ModuleId,
    title: 'Secret lab',
    order: 66,
    opens: { path: '/secret' },
    access: 'admin',
    commands: undefined,
    slots: { 'home.widgets': [() => <p>Secret widget</p>] },
};
const modules = [...clientModules, fake, secret];
/** A module's gate layout with one page, as `routes.ts` would declare it. */
const moduleRoute = (id: ModuleId, path: string, Page: ComponentType): RouteObject => ({
    id: `module:${id}`,
    handle: gateHandle(id),
    Component: () => <ModuleGate id={id} />,
    children: [{ id, path, Component: Page }],
});
const extraRoutes = [
    moduleRoute(fake.id, 'fake', () => <main>The fake lab page</main>),
    moduleRoute(secret.id, 'secret', () => <main>The secret page</main>),
];

it('derives the sidebar, launcher, palette and slots from the registry', () => {
    const admin = contextFor('admin');
    const member = contextFor('member');
    expect(visibleModules(clientModules, admin).map((m) => m.id)).toEqual([
        'chat',
        'spaces',
        'activity',
        'memories',
        'data',
        'media',
        'approvals',
        'apps',
        'schedules',
        'plugins',
        'learning',
        'issues',
        'runs',
        'dots',
        'connected-agents',
        'settings',
        'operations',
        // Platform: admins since the operator role was retired (CB-390).
        'operator',
        'ask',
        'help',
    ]);
    // Telegram appears once configured; the admin module is admins'. Runs
    // is everyone's: a member's own turns (CB-128).
    const telegram = {
        ...admin,
        workspace: {
            ...admin.workspace,
            setup: { ...admin.workspace.setup, telegram: 'online' as const },
        },
    };
    expect(visibleModules(clientModules, telegram).map((m) => m.id)).toContain('telegram');
    const memberIds = visibleModules(modules, member).map((m) => m.id);
    expect(memberIds).toContain('runs');
    expect(memberIds).not.toContain('operations');
    expect(memberIds).not.toContain('secret');
    expect(memberIds).toContain('fake');
    // The launcher lists every visible module, with members' names.
    const cards = launcherCards(modules, member);
    expect(cards.find((card) => card.id === 'learning')?.title).toBe('Skills');
    expect(cards.map((card) => card.id)).toContain('fake');
    expect(cards.find((card) => card.id === fake.id)?.badge).toBe('7');
    // Sidebar items sit in order by `order`; groups come from chat and spaces.
    expect(sidebarEntries(modules, admin).map((entry) => entry.id)).toEqual([
        'activity',
        'memories',
        'data',
        'media',
        'approvals',
        'apps',
        'schedules',
        'plugins',
        'learning',
        'issues',
        'fake',
        'secret',
        'runs',
        'dots',
        'connected-agents',
        'settings',
        'operations',
        // Platform: admins since the operator role was retired (CB-390).
        'operator',
        'help',
    ]);
    // Chat's Socios, Recent chats and Rooms (CB-212, empty while off).
    expect(navGroups(modules, admin).map((group) => group.key)).toEqual(['chat:0', 'spaces:0', 'chat:1', 'chat:2']);
    // A "Go to" per visible module, then the modules' own commands.
    const labels = moduleCommands(modules, member).map((item) => item.label);
    expect(labels).toContain('Go to Fake lab');
    expect(labels).toContain('Brew a potion');
    expect(labels).toContain('New chat with Fulano');
    expect(labels).toContain('Go to Runs');
    expect(labels).not.toContain('Go to Secret lab');
    // Slots gather contributions from visible modules only.
    const widgets = (context: ModuleContext) => slotEntries(modules, context, 'home.widgets').map((entry) => entry.key);
    expect(widgets(admin)).toContain('secret:home.widgets:0');
    expect(widgets(member)).not.toContain('secret:home.widgets:0');
    expect(widgets(member)).toContain('fake:home.widgets:0');
    // Issues contributes "Report issue" and the Dot request notices; Ask
    // its panel's button (CB-26), which has no page to go to.
    expect(slotEntries(modules, member, 'header.actions').map((e) => e.moduleId)).toEqual([
        'issues',
        'issues',
        'fake',
        'ask',
    ]);
    expect(labels).not.toContain('Go to Ask a socio');
    expect(labels).toContain('Ask a socio about this screen');
});

it('opens the palette on Cmd/Ctrl+K, except where an editor took the key', () => {
    const key = (init: KeyboardEventInit, target?: HTMLElement) => {
        const event = new KeyboardEvent('keydown', {
            key: 'k',
            cancelable: true,
            bubbles: true,
            ...init,
        });
        if (target) {
            Object.defineProperty(event, 'target', { value: target });
        }
        return event;
    };
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({}))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    const handled = key({ ctrlKey: true });
    handled.preventDefault();
    expect(isPaletteShortcut(handled)).toBe(false);
    const editor = document.createElement('div');
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    expect(isPaletteShortcut(key({ metaKey: true }, editor))).toBe(false);
});

// --- The fake module in the running app -----------------------------------

const run: AgentRunSummary = {
    runId: 'r1',
    threadId: 'c1',
    status: 'failed',
    source: 'web',
    startedAt: 1,
    finishedAt: 2,
    title: 'Garden plan',
    readable: true,
} as AgentRunSummary;

let role: Role = 'admin';
let requests: string[] = [];
/** Answers `GET /api/spaces/search` when set; it may wait (a slow server). */
let searchHandler: ((url: URL, signal?: AbortSignal | null) => Promise<unknown>) | undefined;
let failDelete = false;
const respond = (method: string, path: string): [number, unknown] => {
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/memories') {
        return [200, memoriesOf(state.memories)];
    }
    // The page's episodes (CB-180): none here.
    if (path === '/api/memories/episodes') {
        return [200, { episodes: [], total: 0, retentionDays: 180 }];
    }
    if (path === '/api/workspace') {
        return [200, workspace(role)];
    }
    // The palette and the home widget read titles only.
    if (path === '/api/issues/titles') {
        return [200, [{ number: 12, title: 'Login fails on Safari', status: 'open' }]];
    }
    if (path === '/api/learning/containers') {
        return [200, []];
    }
    if (path.startsWith('/api/runs')) {
        return [200, { limit: 100, runs: [run] }];
    }
    if (path === '/api/pages/titles') {
        return [
            200,
            [
                {
                    id: 'p1',
                    spaceId: 's1',
                    title: 'Roadmap',
                    freshness: { basis: 'edited', at: Date.now() - 3 * 86_400_000 },
                },
            ],
        ];
    }
    if (method === 'DELETE' && failDelete) {
        return [500, { error: 'Disk full.' }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
let consoleError: ReturnType<typeof vi.spyOn>;
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
    // cmdk measures and scrolls its items.
    Element.prototype.scrollIntoView = () => {};
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    requests = [];
    role = 'admin';
    failDelete = false;
    consoleError = vi.spyOn(console, 'error');
    searchHandler = undefined;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const path = url.pathname;
        requests.push(path);
        if (path === '/api/spaces/search' && searchHandler) {
            const body = await searchHandler(url, init?.signal);
            if (init?.signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        const [status, body] = respond(init?.method ?? 'GET', path);
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
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
async function open(path: string, as: Role = 'admin') {
    role = as;
    const router = createTestRouter(path, { extraRoutes });
    act(() =>
        root.render(
            <ModulesProvider modules={modules}>
                <RouterProvider router={router} />
            </ModulesProvider>,
        ),
    );
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const text = () => document.body.textContent ?? '';
const crumb = () => host.querySelector('[data-slot="breadcrumb-page"]')?.textContent;
const sidebarLink = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]')].find((element) =>
        element.textContent?.trim().startsWith(name),
    );
const press = (init: KeyboardEventInit) =>
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
    });
async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('mounts a new module from its manifest and its routes: sidebar, route, launcher, palette, slots', async () => {
    const router = await open('/');
    // The launcher: its card and its widget, and the header slot.
    await until(() => /Fake widget says hi/.test(text()), 'the widget');
    const card = host.querySelector<HTMLAnchorElement>('[data-module="fake"]');
    expect(card?.getAttribute('href')).toBe('/fake');
    expect(card?.textContent).toContain('A module the registry has never seen');
    expect(card?.title).toBe('A module the registry has never seen.');
    expect(host.querySelector('[aria-label="Fake action"]')?.textContent).toBe('on home');
    // The sidebar item, with its badge, leads to its lazy route.
    const item = sidebarLink('Fake lab');
    expect(item?.getAttribute('href')).toBe('/fake');
    act(() => item!.click());
    await until(() => /The fake lab page/.test(text()), 'the fake page');
    expect(router.state.location.pathname).toBe('/fake');
    expect(crumb()).toBe('Fake lab');
    expect(item?.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[aria-label="Fake action"]')?.textContent).toBe('on fake');
    // The palette (Ctrl+K) finds it and its command.
    await act(() => router.navigate('/'));
    press({ key: 'k', ctrlKey: true });
    const input = await (async () => {
        await until(() => !!document.querySelector('[aria-label="Search Socio"]'), 'the palette');
        return document.querySelector<HTMLInputElement>('[aria-label="Search Socio"]')!;
    })();
    await type(input, 'fake');
    await until(() => /Go to Fake lab/.test(text()), 'the palette result');
    const option = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((element) =>
        element.textContent?.includes('Go to Fake lab'),
    );
    act(() => option!.click());
    await until(() => router.state.location.pathname === '/fake', 'navigation');
    expect(document.querySelector('[aria-label="Search Socio"]')).toBe(null);
    // run.actions: the Runs view renders other modules' per-run actions.
    await act(() => router.navigate('/runs'));
    await until(() => !!host.querySelector('[aria-label="Fake run action r1"]'), 'the run action');
    expect(consoleError).not.toHaveBeenCalled();
});

it('finds pages, chats and issues in the palette and opens them', async () => {
    const router = await open('/');
    press({ key: 'k', metaKey: true });
    await until(() => !!document.querySelector('[aria-label="Search Socio"]'), 'the palette');
    // Fetched once on opening; listed only once something is typed.
    await until(
        () => requests.includes('/api/issues/titles') && requests.includes('/api/pages/titles'),
        'the palette loads',
    );
    // Titles only, in one request: no Space's full page list.
    expect(requests.filter((path) => path.includes('/pages'))).toEqual(['/api/pages/titles']);
    // Issues read titles too, never the whole issue list.
    expect(requests).not.toContain('/api/issues');
    expect(text()).not.toContain('Roadmap');
    expect(text()).toContain('Garden plan');
    const choose = async (query: string, label: string, path: string) => {
        if (!document.querySelector('[aria-label="Search Socio"]')) {
            press({ key: 'k', ctrlKey: true });
        }
        await until(() => !!document.querySelector('[aria-label="Search Socio"]'), 'the palette');
        await type(document.querySelector<HTMLInputElement>('[aria-label="Search Socio"]')!, query);
        await until(() => text().includes(label), label);
        const option = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((element) =>
            element.textContent?.includes(label),
        );
        act(() => option!.click());
        await until(() => router.state.location.pathname === path, path);
    };
    await choose('roadmap', 'Roadmap', '/spaces/s1/pages/p1');
    await choose('CB-12', 'Login fails on Safari', '/issues/CB-12');
    await choose('fulano', 'New chat with Fulano', '/dots/d2/new');
    await choose('garden', 'Garden plan', '/chats/c1');
});

it('adds page text hits from the server as you type, below the instant title hits', async () => {
    const DAY = 86_400_000;
    const asked: Array<{
        q: string;
        exact: boolean;
        signal?: AbortSignal | null;
    }> = [];
    const gates: Array<() => void> = [];
    const answers: Record<string, unknown> = {
        road: {
            query: 'road',
            corrected: null,
            more: false,
            results: [
                {
                    id: 'p1',
                    spaceId: 's1',
                    title: 'Roadmap',
                    updatedAt: 1,
                    matched: 'word',
                    snippet: [{ text: 'The plan for the year.', match: false }],
                    freshness: { basis: 'edited', at: Date.now() - 3 * DAY },
                },
                {
                    id: 'p2',
                    spaceId: 's1',
                    title: 'Quarter notes',
                    updatedAt: 1,
                    matched: 'word',
                    snippet: [
                        { text: '…see the ', match: false },
                        { text: 'roadmap', match: true },
                        { text: ' doc.', match: false },
                    ],
                    freshness: { basis: 'used', at: Date.now() - 2 * DAY },
                },
            ],
        },
        invioce: {
            query: 'invoice',
            corrected: 'invoice',
            more: false,
            results: [
                {
                    id: 'p3',
                    spaceId: 's1',
                    title: 'Billing',
                    updatedAt: 1,
                    matched: 'word',
                    snippet: [{ text: 'invoice', match: true }],
                    freshness: { basis: 'edited', at: Date.now() },
                },
            ],
        },
    };
    searchHandler = async (url, signal) => {
        const q = url.searchParams.get('q') ?? '';
        const exact = url.searchParams.get('exact') === 'true';
        asked.push({ q, exact, signal });
        if (q === 'slow') {
            await new Promise<void>((done) => gates.push(done));
        }
        return (
            (!exact && answers[q]) || {
                query: q,
                corrected: null,
                more: false,
                results: [],
            }
        );
    };
    await open('/');
    press({ key: 'k', ctrlKey: true });
    await until(() => !!document.querySelector('[aria-label="Search Socio"]'), 'the palette');
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search Socio"]')!;
    await until(() => requests.includes('/api/pages/titles'), 'the titles');
    const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map((item) => item.textContent ?? '');
    // The title hit at once, with its freshness; the server is asked a moment later.
    await type(input, 'road');
    await until(() => rows().some((row) => row.includes('Roadmap')), 'Roadmap');
    expect(asked).toEqual([]);
    expect(rows().find((row) => row.includes('Roadmap'))).toContain('Edited 3 days ago');
    await until(() => rows().some((row) => row.includes('Quarter notes')), 'the hit');
    expect(asked.map((entry) => entry.q)).toEqual(['road']);
    // Appended below; the title row kept its place and took its snippet.
    const pages = rows().filter((row) => /Roadmap|Quarter notes/.test(row));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Roadmap');
    expect(pages[0]).toContain('The plan for the year.');
    expect(pages[1]).toContain('Used this week');
    expect([...document.querySelectorAll('[data-slot="snippet-match"]')].map((mark) => mark.textContent)).toEqual([
        'roadmap',
    ]);
    expect(document.querySelector('[data-slot="snippet-match"]')?.tagName).toBe('MARK');
    // Backspacing to an answered query asks nothing again.
    await type(input, 'roa');
    await type(input, 'road');
    await until(() => rows().some((row) => row.includes('Quarter notes')), 'cached');
    expect(asked.filter((entry) => entry.q === 'road')).toHaveLength(1);
    // A slow answer: "Searching pages…" while nothing is listed; typing on
    // aborts it; then "Nothing found." once the server found nothing too.
    await type(input, 'slow');
    await until(() => text().includes('Searching pages…'), 'searching');
    expect(text()).not.toContain('Nothing found.');
    await until(() => asked.some((entry) => entry.q === 'slow'), 'the slow request');
    await type(input, 'slowly');
    expect(asked.find((entry) => entry.q === 'slow')!.signal?.aborted).toBe(true);
    for (const release of gates.splice(0)) {
        release();
    }
    await until(() => text().includes('Nothing found.'), 'nothing found');
    expect(text()).not.toContain('Searching pages…');
    // A correction, and searching the words as typed instead.
    await type(input, 'invioce');
    await until(() => text().includes('Showing results for invoice'), 'the correction');
    expect(rows()[0]).toContain('Showing results for invoice');
    expect(rows()[0]).toContain('Search instead for invioce');
    expect(rows()[1]).toContain('Billing');
    // The first page row is highlighted, not the correction.
    expect(document.querySelector('[cmdk-item][data-selected="true"]')?.textContent?.includes('Billing')).toBe(true);
    const correction = document.querySelector<HTMLElement>('[data-slot="palette-correction"]')!;
    act(() => correction.click());
    await until(() => asked.some((entry) => entry.q === 'invioce' && entry.exact), 'the exact search');
    await until(() => text().includes('Nothing found.'), 'nothing for invioce');
    expect(text()).not.toContain('Showing results for');
});

it('hides admin-only modules from members and sends their routes home', async () => {
    const router = await open('/secret', 'member');
    await until(() => router.state.location.pathname === '/', 'the redirect');
    expect(text()).not.toContain('The secret page');
    expect(sidebarLink('Secret lab')).toBeUndefined();
    expect(host.querySelector('[data-module="secret"]')).toBeNull();
    expect(host.querySelector('[data-module="runs"]')).not.toBeNull();
    expect(host.querySelector('[data-module="fake"]')).not.toBeNull();
    await until(() => /Fake widget says hi/.test(text()), 'the widget');
    expect(text()).not.toContain('Secret widget');
    // Admins open it.
    act(() => root.unmount());
    root = createRoot(host);
    const admin = await open('/secret');
    await until(() => /The secret page/.test(text()), 'the secret page');
    expect(admin.state.location.pathname).toBe('/secret');
});

it('shows a failed action as a toast instead of a banner', async () => {
    failDelete = true;
    await open('/memories');
    await until(() => /Keep it short\./.test(text()), 'Memories');
    act(() => host.querySelector<HTMLElement>('[aria-label="Forget memory"]')!.click());
    act(() =>
        [...document.querySelectorAll<HTMLElement>('[data-slot="forget-memory"] button')]
            .find((button) => button.textContent === 'Forget')!
            .click(),
    );
    await until(() => /Disk full\./.test(text()), 'the toast');
    expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain('Disk full.');
    expect(document.querySelector('.error-banner')).toBeNull();
});

it('says the browser is offline, not that the server is updating, and asks again once it is back online', async () => {
    await open('/memories');
    await until(() => /Keep it short\./.test(text()), 'Memories');
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    await until(() => /You’re offline\./.test(text()), 'the offline toast');
    expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain(
        'You’re offline. Reconnecting when you’re back online.',
    );
    expect(text()).not.toMatch(/updating/i);
    // Back online: the shell asks at once, and the notice goes.
    onLine.mockReturnValue(true);
    const asked = requests.length;
    act(() => void window.dispatchEvent(new Event('online')));
    await until(() => !/You’re offline\./.test(text()), 'the toast to go');
    expect(requests.slice(asked)).toContain('/api/state');
});
