// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { pageSummary, type Page } from '@socio/shared/pages/page-library';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { PageReviewCard } from '../../packages/client/src/modules/pages/PageReviewCard';
import { createTestRouter } from '../../packages/client/tests/helpers/app-router';

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
    memories: [],
    mode: 'live',
    configured: false,
};
const users = {
    alice: { id: 'alice', name: 'Alice', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users = 'alice';
const workspace = (): WorkspaceState => ({
    user: users[me],
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Dot',
            instructions: 'Dot helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});
const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    content: `${title} body.`,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'bob',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    ...extra,
});

// The server: the Space's pages, and the ids deleted (answered with 410).
let pages: Page[] = [];
let deleted: Set<string>;
let deletes: string[] = [];
// The pages read one by one (GET /api/spaces/s1/pages/:id).
let reads: string[] = [];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
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
    // The list has excerpts, not bodies (CB-71); a page has its body.
    if (path === '/api/spaces/s1/pages') {
        return [200, pages.map(pageSummary)];
    }
    const one = path.match(/^\/api\/spaces\/s1\/pages\/([^/]+)$/);
    if (one) {
        const found = pages.find((item) => item.id === one[1]);
        if (init?.method === 'DELETE' && found) {
            deletes.push(`${found.id}${url.search}`);
            const gone = [found.id, ...pages.filter((item) => item.parentId === found.id).map((item) => item.id)];
            pages = pages.filter((item) => !gone.includes(item.id));
            for (const id of gone) {
                deleted.add(id);
            }
            return [200, { deleted: gone }];
        }
        if (found) {
            reads.push(found.id);
            return [200, found];
        }
        if (deleted.has(one[1]!)) {
            return [410, { error: 'This page was deleted.' }];
        }
    }
    if (path === '/api/conversations/t1/reviewed-page/call-1') {
        return [410, { error: 'This page was deleted.' }];
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
    me = 'alice';
    pages = [];
    deleted = new Set();
    deletes = [];
    reads = [];
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

/** Waits (in act) until `check` holds, for up to 10 s (lazy routes load slowly under load). */
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
const text = () => host.textContent ?? '';
const crumb = () => host.querySelector('[data-slot="breadcrumb-page"]')?.textContent;
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | undefined) =>
    act(() => {
        element!.click();
    });
/** Opens the page's ⋯ menu (a Radix menu opens on a key or a pointer). */
async function openPageMenu() {
    await until(() => !!button('Page actions'), 'the page');
    act(() => {
        button('Page actions')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => !!menuItem('Download Markdown'), 'the page menu');
}
const menuItem = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === name);

it('deletes a page from its menu after a confirm naming it, then shows the Space', async () => {
    pages = [page('p1', 'Garden plan'), page('p2', 'Other')];
    const router = await open('/spaces/s1/pages/p1');
    await openPageMenu();
    click(menuItem('Delete page'));
    await until(() => !!dialog(), 'the confirm dialog');
    expect(dialog()!.textContent).toContain('Delete “Garden plan”?');
    // Cancel is focused first (Enter doesn't delete); Escape keeps the page.
    expect(document.activeElement?.textContent).toBe('Cancel');
    act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await until(() => !dialog(), 'the dialog to close');
    expect(deletes).toEqual([]);

    await openPageMenu();
    click(menuItem('Delete page'));
    await until(() => !!dialog(), 'the confirm dialog again');
    click(button('Delete page', dialog()!));
    await until(() => router.state.location.pathname === '/spaces/s1', 'the Space');
    expect(deletes).toEqual(['p1']);
    await until(() => /All pages/.test(text()), 'the library');
    expect([...host.querySelectorAll('[data-slot="library-page-card"] h3')].map((item) => item.textContent)).toEqual([
        'Other',
    ]);
    // A toast says what went.
    expect(document.body.textContent).toContain('Deleted “Garden plan”');
});

it('names the subpages that go with a page and asks the server for them', async () => {
    pages = [page('p1', 'Plan'), page('p2', 'Detail', { parentId: 'p1' }), page('p3', 'Unrelated')];
    await open('/spaces/s1');
    await until(() => !!button('Delete Plan'), 'the library');
    click(button('Delete Plan'));
    await until(() => !!dialog(), 'the confirm dialog');
    expect(dialog()!.textContent).toContain('Its subpage will be deleted with it');
    expect([...dialog()!.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Detail']);
    click(button('Delete pages', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(deletes).toEqual(['p1?subpages=true']);
    await until(() => !text().includes('Detail'), 'the list to refresh');
    expect(text()).toContain('Unrelated');
});

it('offers Delete to members only on pages they created', async () => {
    me = 'bob';
    pages = [
        page('p1', 'Mine'),
        page('p2', 'Alice’s', { createdBy: 'alice' }),
        page('p3', 'From before', { createdBy: null }),
    ];
    await open('/spaces/s1');
    await until(() => /Mine/.test(text()), 'the library');
    expect(button('Delete Mine')).toBeDefined();
    expect(button('Delete Alice’s')).toBeUndefined();
    expect(button('Delete From before')).toBeUndefined();
    await act(async () => {
        root.unmount();
    });
    root = createRoot(host);
    await open('/spaces/s1/pages/p2');
    await openPageMenu();
    expect(menuItem('Download Markdown')).toBeDefined();
    expect(menuItem('Delete page')).toBeUndefined();
});

it('says a linked page was deleted, rather than not found', async () => {
    deleted.add('gone');
    const router = await open('/spaces/s1/pages/gone');
    await until(() => /This page was deleted/.test(text()), 'the deleted state');
    expect(crumb()).toBe('Deleted page');
    await act(() => router.navigate('/spaces/s1/pages/never'));
    await until(() => /Page not found/.test(text()), 'not found');
    expect(crumb()).toBe('Pages');
    click(button('Back to all pages', host));
    await until(() => router.state.location.pathname === '/spaces/s1', 'the Space');
});

it('shows a review card whose saved page was deleted as such', async () => {
    act(() =>
        root.render(
            <PageReviewCard
                args={{ title: 'Plan', content: 'Body', spaceId: 's1' }}
                status="complete"
                threadId="t1"
                toolCallId="call-1"
                onSaved={() => {}}
            />,
        ),
    );
    await until(() => /Saved, then deleted/.test(text()), 'the deleted review');
    expect(text()).toContain('The page saved from this review was deleted.');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('Retry review', host)).toBeUndefined();
});

it('shows the deleted state when someone else deletes the open page', async () => {
    pages = [page('p1', 'Shared plan')];
    await open('/spaces/s1/pages/p1');
    await until(() => !!button('Page actions'), 'the page');
    // Deleted elsewhere: the next poll (every 3 s) no longer lists it.
    pages = [];
    deleted.add('p1');
    await until(() => /This page was deleted/.test(text()), 'the deleted state');
    expect(host.querySelector('textarea[aria-label="Page title"]')).toBeNull();
});

it('reads the open page’s body on its own, and again when someone else saves it (CB-71)', async () => {
    pages = [page('p1', 'Garden plan'), page('p2', 'Other')];
    const router = await open('/spaces/s1/pages/p1');
    const title = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')?.value;
    await until(() => title() === 'Garden plan', 'the page');
    expect(reads).toEqual(['p1']);
    // Another person saves it: the next poll lists a newer revision.
    pages[0] = { ...pages[0]!, title: 'Garden plan 2', revision: 2 };
    await until(() => title() === 'Garden plan 2', 'the saved page');
    expect(reads).toEqual(['p1', 'p1']);
    // Another page of the Space: its own body, once.
    await act(() => router.navigate('/spaces/s1/pages/p2'));
    await until(() => title() === 'Other', 'the other page');
    expect(reads).toEqual(['p1', 'p1', 'p2']);
});

it('links three-level ancestors and direct children through the real page route', async () => {
    pages = [
        page('p1', 'Garden'),
        page('p2', 'Beds', { parentId: 'p1' }),
        page('p3', 'Tomatoes', { parentId: 'p2' }),
        page('foreign', 'Private child', { parentId: 'p2', spaceId: 'private' }),
    ];
    const router = await open('/spaces/s1/pages/p2');
    await until(() => !!host.querySelector('nav[aria-label="Child pages"]'), 'child navigation');
    const child = host.querySelector<HTMLAnchorElement>('nav[aria-label="Child pages"] a')!;
    expect(child.textContent).toContain('Tomatoes');
    expect(child.href).toContain('/spaces/s1/pages/p3');
    expect(host.querySelector('nav[aria-label="Child pages"]')!.textContent).not.toContain('Private child');
    await act(async () => child.click());
    await until(() => router.state.location.pathname.endsWith('/p3') && crumb() === 'Tomatoes', 'child route');
    const mobile = host.querySelector('nav[aria-label="Parent pages"]')!;
    expect([...mobile.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Garden', 'Beds']);
    const header = host.querySelector('[data-slot="app-header"]')!;
    expect([...header.querySelectorAll('[data-slot="breadcrumb-link"]')].map((a) => a.textContent)).toEqual(['Beds']);
    const parent = mobile.querySelector<HTMLAnchorElement>('a[href="/spaces/s1/pages/p1"]')!;
    await act(async () => parent.click());
    await until(() => crumb() === 'Garden', 'ancestor route');
    await until(() => !!host.querySelector('nav[aria-label="Child pages"]'), 'parent children');
    expect(host.querySelector('nav[aria-label="Child pages"]')!.textContent).toContain('Beds');
    expect(host.querySelector('nav[aria-label="Child pages"]')!.textContent).not.toContain('Tomatoes');
});

it('shows complete parent paths in All pages without replacing search or the flat library', async () => {
    pages = [page('p1', 'Garden'), page('p2', 'Beds', { parentId: 'p1' }), page('p3', 'Tomatoes', { parentId: 'p2' })];
    await open('/spaces/s1');
    await until(() => host.querySelectorAll('[data-slot="library-page-card"]').length === 3, 'all pages');
    expect(host.querySelector('[data-slot="library-page-card"] [aria-label="Parent pages"]')?.textContent).toBe(
        'Garden',
    );
    expect(
        [...host.querySelectorAll('[data-slot="library-page-card"] [aria-label="Parent pages"]')].some(
            (e) => e.textContent === 'Garden › Beds',
        ),
    ).toBe(true);
});

it('bounds a deep real AppHeader while keeping the full path available by keyboard and preserving page navigation', async () => {
    pages = Array.from({ length: 36 }, (_, index) =>
        page(`deep-${index}`, `Ancestor ${index} ${'long '.repeat(30)}`.trim(), {
            parentId: index ? `deep-${index - 1}` : null,
        }),
    );
    const router = await open('/spaces/s1/pages/deep-35');
    await until(() => crumb() === pages[35]!.title, 'deep page header');
    const header = host.querySelector('[data-slot="app-header"]')!;
    const trigger = header.querySelector<HTMLButtonElement>('[aria-label="Show full breadcrumb path"]')!;
    expect(trigger).not.toBeNull();
    expect([...header.querySelectorAll('[data-slot="breadcrumb-link"]')].map((a) => a.textContent)).toEqual([
        pages[34]!.title,
    ]);
    // Full ancestry remains in the phone body; collapsing the desktop header
    // must not remove any parent from that separate navigation.
    expect(host.querySelectorAll('nav[aria-label="Parent pages"] a')).toHaveLength(35);
    act(() => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await until(() => !!document.querySelector('[role="menu"]'), 'full path menu');
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(38);
    const parent = menu.querySelector<HTMLAnchorElement>('a[href="/spaces/s1/pages/deep-0"]')!;
    expect(parent.textContent).toBe(pages[0]!.title);
    await act(async () => parent.click());
    await until(
        () => router.state.location.pathname.endsWith('/deep-0') && crumb() === pages[0]!.title,
        'full path ancestor route',
    );
    expect(header.querySelector('[aria-label="Show full breadcrumb path"]')).toBeNull();
    expect([...header.querySelectorAll('[data-slot="breadcrumb-link"]')].map((a) => a.textContent)).toEqual([
        'Home',
        'Everyday',
    ]);
});
