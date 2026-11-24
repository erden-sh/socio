// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { State, WorkspaceState } from '@socio/shared/types';

import { firstClause, homeCounts } from '../src/shell/Home';

import { createTestRouter } from './helpers/app-router';

// CB-77: Home never scrolls sideways. jsdom does no layout, so this checks
// the classes that guarantee it: a long chat title (a URL with no spaces)
// truncates because every grid on the way up names its columns
// (minmax(0, 1fr), never `auto`) and every flex item can shrink.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const longUrl = `https://x.com/someone/article/${'2108212094214529135'.repeat(6)}`;
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
    configured: false,
};
const workspace: WorkspaceState = {
    user: { id: 'alice', name: 'Alice', role: 'admin' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: ['Dot', 'A Dot with a very long name that goes on and on'].map((name, index) => ({
        id: `d${index + 1}`,
        spaceId: 's1',
        spaceIds: ['s1'],
        name,
        instructions: `${name} helps. `.repeat(20),
        researchAllowed: false,
        memoryAllowed: false,
        createdAt: index,
    })),
    conversations: [
        { id: 'c1', dotId: 'd1', ownerId: 'alice', title: longUrl, createdAt: 2 },
        {
            id: 'c2',
            dotId: 'd2',
            ownerId: 'alice',
            title: 'A plan',
            createdAt: 1,
            team: true,
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
const respond = (path: string): [number, unknown] => {
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    // What's new (CB-166): a release whose text has no spaces either.
    if (path === '/api/releases') {
        return [
            200,
            {
                current: '0.7.0',
                releases: [
                    {
                        version: '0.7.0',
                        tag: 'v0.7.0',
                        date: '2026-10-22',
                        summary: longUrl,
                        highlights: [{ title: longUrl, issue: 'CB-157' }],
                        url: '/releases/v0.7.0',
                    },
                ],
            },
        ];
    }
    if (path === '/api/releases/seen') {
        return [200, { lastSeen: '0.7.0' }];
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
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string) => {
        const [status, body] = respond(new URL(input, 'http://app.test').pathname);
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
    delete workspace.plugins;
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
async function openHome() {
    act(() => root.render(<RouterProvider router={createTestRouter('/')} />));
    await until(
        () =>
            !!host.querySelector('[data-slot="home-recent-link"]') &&
            !!host.querySelector('[data-slot="release-card"]'),
        'Home',
    );
    return host.querySelector<HTMLElement>('[data-slot="home"]')!;
}
const classes = (element: Element) => element.className.toString().split(/\s+/);
// A grid's own column template, not only at a breakpoint.
const namesColumns = (element: Element) => classes(element).some((name) => name.startsWith('grid-cols-'));
const isGrid = (element: Element) => classes(element).includes('grid');
const isFlex = (element: Element) => classes(element).some((name) => name === 'flex' || name === 'inline-flex');

it('loads the embed launcher as a new document for its frame CSP', async () => {
    workspace.plugins = [
        {
            id: 'planner',
            name: 'Planner',
            description: '',
            display: 'embed',
            mode: 'service',
            openAllow: [],
            openAnyHttps: false,
            routes: false,
            origin: 'https://planner.apps.example',
            entryPath: '/',
        },
    ];
    const home = await openHome();
    const link = home.querySelector<HTMLAnchorElement>('a[href="/plugins/planner"]')!;
    expect(link).not.toBeNull();
    let intercepted: boolean | undefined;
    document.addEventListener(
        'click',
        (event) => {
            intercepted = event.defaultPrevented;
            event.preventDefault();
        },
        { once: true },
    );
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(intercepted).toBe(false);
});
const canShrink = (element: Element) =>
    classes(element).some((name) => ['min-w-0', 'truncate'].includes(name) || name.startsWith('line-clamp-'));

/** Why `element` could push Home wider than its column, or nothing. */
function widens(element: Element, home: Element): string | undefined {
    for (let node = element; node !== home; node = node.parentElement!) {
        const parent = node.parentElement!;
        const where = `${node.tagName.toLowerCase()} "${node.textContent!.slice(0, 30)}"`;
        if (isGrid(parent) && !namesColumns(parent)) {
            return `${where} sits in a grid with an auto column`;
        }
        if (isFlex(parent) && !canShrink(node)) {
            return `${where} is a flex item without min-w-0`;
        }
    }
}

it('lays Home out on grids that keep long text from widening the page', async () => {
    const home = await openHome();
    // Centered, at most 72rem, its columns following its own width.
    expect(classes(home)).toEqual(expect.arrayContaining(['@container', 'mx-auto', 'w-full', 'max-w-6xl']));
    // One layout system: the page and its sections are grids, each naming
    // its columns.
    const grids = [home, ...home.querySelectorAll('*')].filter(isGrid);
    expect(grids.length).toBeGreaterThan(5);
    for (const grid of grids) {
        expect(namesColumns(grid), grid.outerHTML.slice(0, 120)).toBe(true);
    }
    for (const child of home.children) {
        expect(child.tagName === 'SECTION' || isGrid(child)).toBe(true);
    }
    // Apps and At a glance: side by side when there is room, stacked when not.
    const apps = home.querySelector('[aria-labelledby="home-apps"]')!;
    expect(classes(apps.parentElement!)).toEqual(
        expect.arrayContaining(['grid-cols-1', '@4xl:grid-cols-[minmax(0,1fr)_20rem]']),
    );

    // The long URL and the long Dot name truncate, and nothing between them
    // and the page can grow past its column.
    const link = home.querySelector('[data-slot="home-recent-link"]')!;
    const title = [...link.querySelectorAll('span')].find((span) => span.textContent === longUrl)!;
    expect(classes(title)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    const truncated = [...home.querySelectorAll('.truncate, [class*="line-clamp-"]')];
    expect(truncated.length).toBeGreaterThan(5);
    for (const element of truncated) {
        expect(widens(element, home), element.textContent!).toBeUndefined();
    }
});

it("links a Dot's card to its home page, with a separate New chat link", async () => {
    const home = await openHome();
    const cards = [...home.querySelectorAll('[data-slot="dot-card"]')];
    expect(cards).toHaveLength(2);
    for (const [index, card] of cards.entries()) {
        const id = `d${index + 1}`;
        const main = card.querySelector<HTMLAnchorElement>('[data-slot="dot-link"]')!;
        const fresh = card.querySelector<HTMLAnchorElement>('[data-slot="dot-new-chat"]')!;
        expect(main.getAttribute('href')).toBe(`/dots/${id}`);
        expect(fresh.getAttribute('href')).toBe(`/dots/${id}/new`);
        expect(fresh.getAttribute('aria-label')).toBe(`New chat with ${workspace.dots[index].name}`);
        // One main link and a sibling: never a link inside a link.
        expect(card.tagName).toBe('DIV');
        expect(main.contains(fresh)).toBe(false);
        expect(main.querySelector('a, button')).toBeNull();
        expect(card.querySelectorAll('a')).toHaveLength(2);
        // A phone-sized tap target (44px) until md.
        expect(classes(fresh)).toEqual(expect.arrayContaining(['size-11']));
    }
});

it('titles Home with real counts, no second Search, socios with their state, and Apps and At a glance as single cards (CB-308)', async () => {
    state.tasks = [
        {
            id: 't1',
            prompt: 'Check in',
            status: 'running',
            intervalSeconds: null,
            nextRunAt: null,
            createdAt: 1,
            updatedAt: 1,
            error: null,
            lease: null,
            leaseUntil: null,
            dotId: 'd2',
        },
    ];
    try {
        const home = await openHome();
        expect(home.querySelector('[data-slot="home-title"]')?.textContent).toBe('Home');
        expect(home.querySelector('[data-slot="home-subtitle"]')?.textContent).toBe(
            '2 socios · 1 Space · 2 chats · 1 scheduled task',
        );
        // The sidebar keeps Search and Ctrl K; the page has none of its own.
        expect([...home.querySelectorAll('button')].some((button) => button.textContent?.startsWith('Search'))).toBe(
            false,
        );
        // The state word beside each socio, from the data the shell has.
        expect(
            [...home.querySelectorAll('[data-slot="dot-card"]')].map(
                (card) => card.querySelector('[data-slot="dot-state"]')?.textContent,
            ),
        ).toEqual(['Idle', 'Working']);
        expect(home.querySelector('[data-slot="dot-card"] [class*="line-clamp-"]')?.className).toContain(
            'line-clamp-2',
        );
        // Apps: one card of rows, each cut to its first clause.
        const apps = home.querySelector('[data-slot="home-apps"]')!;
        expect(apps.querySelectorAll('[data-slot="module-card"]').length).toBe(
            home.querySelectorAll('[data-slot="module-card"]').length,
        );
        const approvals = apps.querySelector('[data-module="approvals"]');
        expect(approvals?.textContent).toContain('What your socios ask to do');
        expect(approvals?.textContent).not.toContain('which actions need you');
        expect(approvals?.querySelector('[aria-hidden] svg')).not.toBeNull();
        // At a glance: one card, its widgets rows in it.
        const glance = home.querySelector('[data-slot="home-glance"]')!;
        expect(glance.className).toContain('divide-y');
        expect(glance.querySelectorAll('[data-slot="home-widget"]').length).toBeGreaterThan(0);
    } finally {
        state.tasks = [];
    }
});

it('marks a socio Paused while the workspace is paused (CB-308)', async () => {
    state.settings.paused = true;
    try {
        const home = await openHome();
        expect([...home.querySelectorAll('[data-slot="dot-state"]')].map((label) => label.textContent)).toEqual([
            'Paused',
            'Paused',
        ]);
    } finally {
        state.settings.paused = false;
    }
});

it('cuts an app’s description to its first clause and counts only what there is (CB-308)', () => {
    expect(firstClause('Start a conversation with one of your socios.')).toBe(
        'Start a conversation with one of your socios',
    );
    expect(firstClause('Recurring work your socios do for you, and the jobs they run.')).toBe(
        'Recurring work your socios do for you',
    );
    expect(firstClause('The team’s issue tracker: bugs, ideas.')).toBe('The team’s issue tracker');
    expect(homeCounts({ socios: 1, spaces: 0, chats: 0, tasks: 0 })).toBe('1 socio');
});
