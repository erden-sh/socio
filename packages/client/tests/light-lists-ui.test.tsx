// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { IssueTitle } from '@socio/shared/issues/issue-types';
import type { PageTreeItem } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import { NavSpace } from '@/components/nav-spaces';
import { SidebarProvider } from '@/components/ui/sidebar';
import { issuesModule } from '@/modules/issues/module';
import type { ModuleContext } from '@/modules/types';

// The sidebar's page tree and the palette's issue commands ask for the
// light lists (titles, parents, statuses), never full lists with bodies.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const TREE: PageTreeItem[] = [
    { id: 'p1', parentId: null, title: 'Roadmap' },
    { id: 'p2', parentId: 'p1', title: 'Q3 goals' },
    { id: 'p3', parentId: null, title: 'Notes' },
];
const ISSUES: IssueTitle[] = [{ number: 12, title: 'Login fails on Safari', status: 'in_progress' }];
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
        requests.push(url.pathname + url.search);
        const body =
            url.pathname === '/api/spaces/s1/page-tree'
                ? TREE
                : url.pathname === '/api/issues/titles'
                  ? ISSUES
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

it('loads the sidebar page tree as titles and parents and nests it', async () => {
    const space = { id: 's1', name: 'Product' } as Space;
    act(() =>
        root.render(
            <MemoryRouter initialEntries={['/spaces/s1/pages/p2']}>
                <SidebarProvider>
                    <ul>
                        <NavSpace space={space} onNavigate={() => {}} />
                    </ul>
                </SidebarProvider>
            </MemoryRouter>,
        ),
    );
    // Nothing loads until the tree opens.
    expect(requests).toEqual([]);
    act(() => host.querySelector<HTMLElement>('[aria-label="Expand Product"]')!.click());
    await until(() => /Q3 goals/.test(host.textContent ?? ''), 'the tree');
    expect(requests).toEqual(['/api/spaces/s1/page-tree']);
    const link = (title: string) =>
        [...host.querySelectorAll<HTMLAnchorElement>('a')].find((element) => element.textContent === title)!;
    // The child sits under its parent, in the list's order.
    expect(link('Q3 goals').closest('li')?.parentElement?.closest('li')).toBe(link('Roadmap').closest('li'));
    expect([...host.querySelectorAll('a')].map((element) => element.textContent)).toEqual([
        'Product',
        'Roadmap',
        'Q3 goals',
        'Notes',
    ]);
    expect(link('Q3 goals').getAttribute('href')).toBe('/spaces/s1/pages/p2');
    expect(link('Q3 goals').getAttribute('aria-current')).toBe('page');
});

it('builds the palette’s issue commands from issue titles', async () => {
    const context = {} as ModuleContext;
    const signal = new AbortController().signal;
    const issues = await issuesModule.loadCommands!(context, signal);
    expect(requests).toEqual(['/api/issues/titles']);
    expect(issues).toMatchObject([
        {
            id: 'issue:12',
            label: 'Login fails on Safari',
            hint: 'CB-12',
            keywords: ['CB-12', 'in progress'],
        },
    ]);
});
