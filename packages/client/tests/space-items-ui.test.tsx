// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PageTreeItem } from '@socio/shared/pages/page-library';
import type { PrivateItemsResponse, SpaceItemsResponse } from '@socio/shared/spaces/space-items';
import type { Space, WorkspaceState } from '@socio/shared/types';

import { ShellContext, type Shell } from '../src/shell/shell-context';

import { NavPrivate, NavSpace } from '@/components/nav-spaces';
import { SidebarProvider } from '@/components/ui/sidebar';

// Datasets in Spaces (CB-451): with `datasets-in-spaces` the
// sidebar reads a Space's items (its datasets among its pages, a kind it
// doesn't know shown and never dropped), and the Private group lists the
// person's own datasets in no Space. Without the flag, the page tree as before.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const ITEMS: SpaceItemsResponse = {
    schema: 1,
    spaceId: 's1',
    items: [
        { kind: 'page', id: 'p1', parentId: null, title: 'Roadmap', position: '1', version: 1 },
        {
            kind: 'dataset',
            id: 'd1',
            parentId: 'p1',
            title: 'Tasks',
            position: '2',
            version: 5,
            owner: 'person',
            tables: [{ name: 'tasks', title: 'tasks', rows: 3, analytical: false }],
        },
        // A later kind (a dashboard): this version can't open it.
        { kind: 'dashboard', id: 'x1', parentId: null, title: 'KPIs', position: '3', version: 1 } as never,
    ],
};
const PRIVATE: PrivateItemsResponse = {
    schema: 1,
    scope: 'private',
    items: [
        {
            kind: 'dataset',
            id: 'd2',
            parentId: null,
            title: 'Scratch',
            position: '1',
            version: 1,
            owner: 'person',
            tables: [],
            socio: { id: 'dot1', name: 'Helper' },
        },
    ],
};
const TREE: PageTreeItem[] = [{ id: 'p1', parentId: null, title: 'Roadmap', folder: false }];
let requests: string[] = [];
let root: Root;
let host: HTMLElement;

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
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        requests.push(url.pathname);
        const body =
            url.pathname === '/api/spaces/s1/items'
                ? ITEMS
                : url.pathname === '/api/spaces/s1/page-tree'
                  ? TREE
                  : url.pathname === '/api/data/private-items'
                    ? PRIVATE
                    : { error: 'Not found.' };
        return new Response(JSON.stringify(body), {
            status: 'error' in body ? 404 : 200,
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
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}

const shell = (on: boolean) =>
    ({
        workspace: {
            user: { id: 'olive', name: 'Olive', role: 'member' },
            flags: { on: on ? ['datasets-in-spaces'] : [] },
        } as unknown as WorkspaceState,
    }) as unknown as Shell;

const render = (on: boolean, children: React.ReactNode, at = '/spaces/s1') =>
    act(() =>
        root.render(
            <ShellContext.Provider value={shell(on)}>
                <MemoryRouter initialEntries={[at]}>
                    <SidebarProvider>
                        <ul>{children}</ul>
                    </SidebarProvider>
                </MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
const link = (title: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((element) => element.textContent?.startsWith(title));

it('shows a Space’s datasets among its pages, and keeps a kind it doesn’t know', async () => {
    const space = { id: 's1', name: 'Product' } as Space;
    render(true, <NavSpace space={space} onNavigate={() => {}} />, '/data/datasets/d1');
    act(() => host.querySelector<HTMLElement>('[aria-label="Expand Product"]')!.click());
    await until(() => /Tasks/.test(host.textContent ?? ''), 'the items');
    expect(requests).toEqual(['/api/spaces/s1/items']);
    // The dataset sits under its page and opens on its rows.
    expect(link('Tasks')!.getAttribute('href')).toBe('/data/datasets/d1');
    expect(link('Tasks')!.closest('li')?.parentElement?.closest('li')).toBe(link('Roadmap')!.closest('li'));
    expect(link('Tasks')!.getAttribute('aria-current')).toBe('page');
    // The unknown kind: listed by its title, not a link, with the note.
    const unknown = host.querySelector('[data-kind="dashboard"]')!;
    expect(unknown.textContent).toContain('KPIs');
    expect(unknown.textContent).toContain('Not supported in this version');
    expect(unknown.querySelector('a')).toBeNull();
});

it('reads the page tree as before without the flag', async () => {
    const space = { id: 's1', name: 'Product' } as Space;
    render(false, <NavSpace space={space} onNavigate={() => {}} />);
    act(() => host.querySelector<HTMLElement>('[aria-label="Expand Product"]')!.click());
    await until(() => /Roadmap/.test(host.textContent ?? ''), 'the tree');
    expect(requests).toEqual(['/api/spaces/s1/page-tree']);
    expect(host.textContent).not.toContain('Tasks');
});

it('lists the person’s own datasets in no Space under Private, a socio’s marked with its name', async () => {
    render(true, <NavPrivate onNavigate={() => {}} />);
    expect(requests).toEqual([]);
    act(() => host.querySelector<HTMLElement>('[aria-label="Expand Private"]')!.click());
    await until(() => /Scratch/.test(host.textContent ?? ''), 'the Private group');
    expect(requests).toEqual(['/api/data/private-items']);
    expect(link('Scratch')!.getAttribute('href')).toBe('/data/datasets/d2');
    expect(link('Scratch')!.textContent).toContain('Helper');
});
