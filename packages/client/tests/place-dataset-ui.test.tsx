// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DatasetView } from '@socio/shared/data-types';
import type { PrivateItemsResponse } from '@socio/shared/spaces/space-items';
import type { Space, WorkspaceState } from '@socio/shared/types';

import { PlaceDatasetDialog } from '../src/modules/spaces/PlaceDatasetDialog';
import { SpaceLibrary } from '../src/modules/spaces/SpaceLibrary';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Placing datasets from a Space (CB-451): the Space's dataset
// menu shows to its editors only, with `datasets-in-spaces`; "New dataset"
// makes one placed there, "Add existing dataset" lists the person's own in
// no Space (and, for admins, the workspace's unplaced ones) and places it.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const PRIVATE: PrivateItemsResponse = {
    schema: 1,
    scope: 'private',
    items: [
        {
            kind: 'dataset',
            id: 'mine',
            parentId: null,
            title: 'Mine',
            position: '1',
            version: 1,
            owner: 'person',
            tables: [],
        },
    ],
};
const ALL = [
    { id: 'mine', name: 'Mine', ownerUserId: 'alice', sharedSpaceId: null, access: 'owner' },
    {
        id: 'events',
        name: 'Events',
        ownerUserId: 'ws:workspace',
        sharedSpaceId: null,
        access: 'owner',
        plugin: { id: 'events', name: 'Events plugin' },
    },
    { id: 'placed', name: 'Placed', ownerUserId: 'ws:workspace', sharedSpaceId: 's2', access: 'owner' },
] as unknown as DatasetView[];
let calls: Array<{ method: string; path: string; body?: unknown }>;
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
            url.pathname === '/api/data/private-items'
                ? PRIVATE
                : url.pathname === '/api/data/datasets' && method === 'GET'
                  ? ALL
                  : { id: 'made', name: 'Placed one' };
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
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

const shell = (on: boolean) =>
    ({
        workspace: { flags: { on: on ? ['datasets-in-spaces'] : [] } } as unknown as WorkspaceState,
    }) as unknown as Shell;

it.each([
    ['an editor, flag on', 'editor', true, true],
    ['a reader, flag on', 'reader', true, false],
    ['an editor, flag off', 'editor', false, false],
] as const)('shows the Space’s dataset menu to %s: %s', (_, access, on, shown) => {
    act(() =>
        root.render(
            <ShellContext.Provider value={shell(on)}>
                <MemoryRouter>
                    <SpaceLibrary
                        space={{ id: 's1', name: 'Team', access } as Space}
                        pages={[]}
                        onPage={() => {}}
                        onNew={() => {}}
                        onDeleted={() => {}}
                    />
                </MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
    expect(!!host.querySelector('[data-slot="space-new-dataset"]')).toBe(shown);
});

const renderDialog = (mode: 'new' | 'existing', admin: boolean, onPlaced: (id: string) => void) =>
    act(() =>
        root.render(
            <PlaceDatasetDialog
                space={{ id: 's1', name: 'Team' }}
                mode={mode}
                admin={admin}
                onOpenChange={() => {}}
                onPlaced={onPlaced}
            />,
        ),
    );
const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;

it('makes a new dataset placed in the Space', async () => {
    const placed: string[] = [];
    renderDialog('new', false, (id) => placed.push(id));
    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Dataset name"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Tasks');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Create').click());
    await until(() => placed.length === 1, 'the placed dataset');
    expect(calls).toEqual([
        { method: 'POST', path: '/api/data/datasets', body: { name: 'Tasks', sharedSpaceId: 's1' } },
    ]);
    expect(placed).toEqual(['made']);
});

it('adds one of the person’s datasets in no Space, and for admins the workspace’s unplaced ones', async () => {
    const placed: string[] = [];
    renderDialog('existing', true, (id) => placed.push(id));
    const select = () => document.body.querySelector<HTMLSelectElement>('[aria-label="Dataset"]');
    await until(() => !!select(), 'the candidates');
    expect([...select()!.options].map((option) => option.textContent)).toEqual([
        'Mine',
        'Events (Written by Events plugin)',
    ]);
    act(() => {
        select()!.value = 'events';
        select()!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Add').click());
    await until(() => placed.length === 1, 'the placed dataset');
    expect(calls.at(-1)).toEqual({ method: 'PATCH', path: '/api/data/datasets/events', body: { sharedSpaceId: 's1' } });
});

it('lists only the person’s own for a member', async () => {
    renderDialog('existing', false, () => {});
    const select = () => document.body.querySelector<HTMLSelectElement>('[aria-label="Dataset"]');
    await until(() => !!select(), 'the candidates');
    expect([...select()!.options].map((option) => option.textContent)).toEqual(['Mine']);
    expect(calls.map((call) => call.path)).toEqual(['/api/data/private-items']);
});
