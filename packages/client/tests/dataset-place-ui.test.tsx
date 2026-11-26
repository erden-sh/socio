// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DatasetDetail } from '@socio/shared/data-types';
import type { PageTreeItem } from '@socio/shared/pages/page-library';
import type { WorkspaceState } from '@socio/shared/types';

import { DatasetPage } from '../src/modules/dataspace/DatasetPage';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// "Move to" on a dataset (CB-451): its Space choice lists only
// the Spaces the person edits (and the one it is in), and with
// `datasets-in-spaces` it may sit under a page of its Space.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const TREE: PageTreeItem[] = [
    { id: 'p1', parentId: null, title: 'Plan', folder: false },
    { id: 'p2', parentId: 'p1', title: 'Detail', folder: false },
];
const detail = (sharedSpaceId: string | null): DatasetDetail =>
    ({
        dataset: {
            id: 'd1',
            name: 'Tasks',
            description: '',
            kind: 'dataset',
            ownerUserId: 'olive',
            createdByDotId: null,
            scratchForDotId: null,
            fromDeletedDot: false,
            sharedSpaceId,
            ...(sharedSpaceId ? { spaceParentId: 'p2' } : {}),
            retentionDays: null,
            sizeBytes: 0,
            historyBytes: 0,
            historyDays: null,
            tableCount: 0,
            createdAt: 1,
            updatedAt: 1,
            access: 'owner',
        },
        tables: [],
    }) as unknown as DatasetDetail;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let current: DatasetDetail;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const body =
            url.pathname === '/api/data/datasets/d1'
                ? current
                : url.pathname === '/api/spaces/s-edit/page-tree'
                  ? TREE
                  : url.pathname === '/api/data/audit'
                    ? []
                    : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
            spaces: [
                { id: 's-edit', name: 'Edited', access: 'editor' },
                { id: 's-read', name: 'Read only', access: 'reader' },
            ],
        } as unknown as WorkspaceState,
    }) as unknown as Shell;

const render = (on: boolean, initial: DatasetDetail) => {
    current = initial;
    const router = createMemoryRouter(
        [{ path: '/data/datasets/:datasetId', element: <DatasetPage initial={initial} /> }],
        { initialEntries: ['/data/datasets/d1'] },
    );
    act(() =>
        root.render(
            <ShellContext.Provider value={shell(on)}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
};
const options = (slot: string) =>
    [...(host.querySelector<HTMLSelectElement>(`[data-slot="${slot}"]`)?.options ?? [])].map(
        (option) => option.textContent,
    );

it('offers only the Spaces the person edits', async () => {
    render(false, detail(null));
    await until(() => !!host.querySelector('[data-slot="dataset-share"]'), 'the settings');
    expect(options('dataset-share')).toEqual(['Nobody (private)', 'Edited']);
    // No place under a page without the flag.
    expect(host.querySelector('[data-slot="dataset-parent"]')).toBeNull();
});

it('keeps listing a Space it is in that the person only reads', async () => {
    render(false, { ...detail(null), dataset: { ...detail(null).dataset, sharedSpaceId: 's-read' } });
    await until(() => !!host.querySelector('[data-slot="dataset-share"]'), 'the settings');
    expect(options('dataset-share')).toEqual(['Nobody (private)', 'Edited', 'Read only']);
});

it('moves it under a page of its Space with the flag on', async () => {
    render(true, detail('s-edit'));
    await until(() => options('dataset-parent').length === 3, 'the pages');
    expect(options('dataset-parent')).toEqual(['The Space’s top level', 'Plan', 'Detail']);
    const select = host.querySelector<HTMLSelectElement>('[data-slot="dataset-parent"]')!;
    expect(select.value).toBe('p2');
    expect(select.disabled).toBe(false);
    act(() => {
        select.value = 'p1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => calls.some((call) => call.method === 'PATCH'), 'the move');
    expect(calls.find((call) => call.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: '/api/data/datasets/d1',
        body: { spaceParentId: 'p1' },
    });
});
