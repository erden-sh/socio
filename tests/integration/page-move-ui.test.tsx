// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { pageSummary, type Page } from '@socio/shared/pages/page-library';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

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
    spaces: [
        { id: 's1', name: 'Everyday', description: '', createdAt: 1 },
        { id: 's2', name: 'Workshop', description: '', createdAt: 2 },
    ],
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

// The server: every Space's pages, and the moves asked for.
let pages: Page[] = [];
let moves: Array<{ path: string; body: unknown }> = [];
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
    const list = path.match(/^\/api\/spaces\/([^/]+)\/pages$/);
    if (list) {
        return [200, pages.filter((item) => item.spaceId === list[1]).map(pageSummary)];
    }
    const located = path.match(/^\/api\/pages\/([^/]+)\/location$/);
    if (located) {
        const found = pages.find((item) => item.id === located[1]);
        return found ? [200, { spaceId: found.spaceId }] : [404, { error: 'Page not found.' }];
    }
    const move = path.match(/^\/api\/spaces\/([^/]+)\/pages\/([^/]+)\/move$/);
    if (move && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { spaceId: string };
        moves.push({ path, body });
        const tree = [move[2]!];
        for (let i = 0; i < tree.length; i++) {
            tree.push(...pages.filter((item) => item.parentId === tree[i]).map((item) => item.id));
        }
        pages = pages.map((item) =>
            tree.includes(item.id)
                ? {
                      ...item,
                      spaceId: body.spaceId,
                      parentId: item.id === move[2] ? null : item.parentId,
                      revision: item.revision + 1,
                  }
                : item,
        );
        return [200, { page: pages.find((item) => item.id === move[2]), moved: tree }];
    }
    const one = path.match(/^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/);
    if (one) {
        const found = pages.find((item) => item.id === one[2] && item.spaceId === one[1]);
        if (found) {
            return [200, found];
        }
        return [404, { error: 'Page not found in this Space.' }];
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
    moves = [];
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

const title = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')?.value;

it('moves a page with its subpages to another Space from “Move to…”, then opens it there', async () => {
    pages = [page('p1', 'Garden plan'), page('p2', 'Beds', { parentId: 'p1' }), page('p3', 'Other')];
    const router = await open('/spaces/s1/pages/p1');
    await openPageMenu();
    expect(menuItem('Move within Space')).toBeDefined();
    click(menuItem('Move to…'));
    await until(() => !!dialog(), 'the move dialog');
    expect(dialog()!.textContent).toContain('Move “Garden plan”');
    expect(dialog()!.textContent).toContain('with its subpage');
    // Only the other Spaces are offered.
    const select = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Destination Space"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Workshop']);
    expect([...dialog()!.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Beds']);
    click(button('Move pages', dialog()!));
    await until(() => router.state.location.pathname === '/spaces/s2/pages/p1', 'the page in its new Space');
    expect(moves).toEqual([{ path: '/api/spaces/s1/pages/p1/move', body: { spaceId: 's2' } }]);
    await until(() => title() === 'Garden plan', 'the moved page');
    expect(document.body.textContent).toContain('Moved “Garden plan” to Workshop');
});

it('says there is nowhere to go when the workspace has one Space', async () => {
    pages = [page('p1', 'Garden plan')];
    const only = workspace();
    only.spaces = only.spaces.slice(0, 1);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const [status, body] = url.pathname === '/api/workspace' ? [200, only] : respond(url, init);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    await open('/spaces/s1/pages/p1');
    await openPageMenu();
    click(menuItem('Move to…'));
    await until(() => !!dialog(), 'the move dialog');
    expect(dialog()!.textContent).toContain('There is no other Space to move it to.');
    expect(button('Move page', dialog()!)!.disabled).toBe(true);
});

it('opens an old link to a moved page in the Space it is in now', async () => {
    pages = [page('p1', 'Garden plan', { spaceId: 's2' }), page('p3', 'Other')];
    const router = await open('/spaces/s1/pages/p1');
    await until(() => router.state.location.pathname === '/spaces/s2/pages/p1', 'the page in its new Space');
    await until(() => title() === 'Garden plan', 'the moved page');
    // A page that is nowhere is still not found.
    await act(() => router.navigate('/spaces/s1/pages/never'));
    await until(() => /Page not found/.test(text()), 'not found');
});
