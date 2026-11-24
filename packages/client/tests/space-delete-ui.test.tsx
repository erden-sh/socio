// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SpacePeopleView } from '@socio/shared/space-memory';
import type { DeletedSpace, Role, Space } from '@socio/shared/types';

import { DeletedSpacesSection } from '../src/modules/settings/DeletedSpacesSection';
import { SETTINGS_GROUPS } from '../src/modules/settings/sections';
import { SpaceSettings } from '../src/modules/spaces/SpaceSettings';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Deleting a Space (CB-277): the Settings tab's "Delete this Space", for
// those who may, behind a dialog that names what goes with it and asks
// for the Space's name; and admins' Settings → Deleted Spaces, to restore.

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const space: Space = {
    id: 's1',
    name: 'Deals',
    description: '',
    createdAt: 1,
    private: true,
    access: 'editor',
};

let root: Root;
let host: HTMLElement;
let calls: { method: string; path: string }[];
let people: SpacePeopleView;
let deleted: DeletedSpace[];
let refused: string | undefined;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    refused = undefined;
    deleted = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname });
        if (url.pathname === '/api/spaces/s1/people') {
            return Response.json(people);
        }
        if (url.pathname === '/api/spaces/s1' && refused) {
            return Response.json({ error: refused }, { status: 409 });
        }
        if (url.pathname === '/api/admin/spaces/deleted') {
            return Response.json({ spaces: deleted });
        }
        return Response.json({ ok: true });
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
});

function shellFor(role: Role) {
    const refresh = vi.fn(async () => {});
    const shell = {
        state: { settings: { name: 'Socio', paused: false }, tasks: [] },
        workspace: {
            user: { id: 'me', name: 'Me', role },
            dots: [],
            conversations: [],
            spaces: [space],
        },
        refresh,
        busy: false,
        mutate: vi.fn(async () => true),
        setError: vi.fn(),
        openDialog: vi.fn(),
    } as unknown as Shell;
    return { shell, refresh };
}

function render(role: Role, view: Partial<SpacePeopleView> = {}) {
    people = {
        spaceId: 's1',
        membersOnly: true,
        people: [],
        access: 'editor',
        candidates: [],
        ...view,
    };
    const { shell, refresh } = shellFor(role);
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <MemoryRouter initialEntries={['/spaces/s1/settings']}>
                    <Routes>
                        <Route path="/spaces/s1/settings" element={<SpaceSettings space={space} />} />
                        <Route path="/spaces" element={<p>All Spaces</p>} />
                    </Routes>
                </MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
    return refresh;
}
async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const loaded = () => until(() => !!host.querySelector('[data-slot="space-people"]'), 'the page');
async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it.each([
    ['a private Space’s editor', 'member', { membersOnly: true }, true],
    ['a private Space’s member', 'member', { access: 'reader' }, false],
    ['an editor of a Space for the whole workspace', 'member', { membersOnly: false }, false],
    ['an admin, any Space', 'admin', { membersOnly: false }, true],
] as const)('offers deleting it to %s: %s', async (_who, role, view, shown) => {
    render(role, view);
    await loaded();
    expect(!!host.querySelector('[data-slot="space-delete"]')).toBe(shown);
});

it('deletes a Space only once its name is typed, after naming what goes with it', async () => {
    const refresh = render('member');
    await loaded();
    await act(async () => button('Delete this Space')!.click());
    await until(() => !!document.querySelector('[data-slot="delete-space"]'), 'the dialog');
    const dialog = document.querySelector('[data-slot="delete-space"]')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    // It scrolls on a short, narrow screen rather than running off it.
    expect(dialog.className).toContain('overflow-y-auto');
    expect(dialog.textContent).toContain('Delete “Deals”?');
    for (const named of [
        'pages',
        'Page chats and Ask chats',
        'memory',
        'Apps, datasets and link cards shared with it',
        'Socios’ access',
        'restore',
    ]) {
        expect(dialog.textContent, named).toContain(named);
    }
    // A labeled field; the button waits for the exact name.
    const input = dialog.querySelector('input')!;
    // The name field has the keyboard as it opens.
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Type Deals to confirm');
    const remove = button('Delete Space')!;
    expect(remove.disabled).toBe(true);
    await type(input, 'deals');
    expect(remove.disabled).toBe(true);
    // Enter in a field that doesn't match does nothing.
    await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await type(input, ' Deals ');
    expect(remove.disabled).toBe(false);
    // Enter deletes it, as the button would.
    await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => !!host.textContent?.includes('All Spaces'), 'the list');
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/spaces/s1' }]);
    expect(refresh).toHaveBeenCalled();
});

it('says why a Space can’t be deleted, and keeps it', async () => {
    refused =
        'A socio saves new pages to this Space by default (Sebas). Choose another default Space in its settings first.';
    render('admin');
    await loaded();
    await act(async () => button('Delete this Space')!.click());
    await until(() => !!document.querySelector('[data-slot="delete-space"] input'), 'the dialog');
    await type(document.querySelector<HTMLInputElement>('[data-slot="delete-space"] input')!, 'Deals');
    await act(async () => button('Delete Space')!.click());
    await until(() => !!document.querySelector('[data-slot="delete-space"] [role="alert"]'), 'the refusal');
    expect(document.querySelector('[data-slot="delete-space"] [role="alert"]')?.textContent).toBe(refused);
    expect(host.textContent).not.toContain('All Spaces');
    // Cancel closes it.
    await act(async () => button('Cancel')!.click());
    await until(() => !document.querySelector('[data-slot="delete-space"]'), 'the dialog to close');
});

it('lists deleted Spaces for admins with who deleted them and when, and restores one', async () => {
    expect(
        SETTINGS_GROUPS.flatMap((group) => group.entries).find((entry) => entry.id === 'deleted-spaces'),
    ).toMatchObject({ label: 'Deleted Spaces', role: 'admin' });
    deleted = [
        {
            id: 's1',
            name: 'Deals',
            description: '',
            createdAt: 1,
            deletedAt: Date.UTC(2026, 9, 12, 15, 4),
            deletedBy: 'ada',
            deletedByName: 'Ada',
            private: true,
            pages: 3,
        },
    ];
    const { shell, refresh } = shellFor('admin');
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <DeletedSpacesSection />
            </ShellContext.Provider>,
        ),
    );
    await until(() => !!host.querySelector('ul[aria-label="Deleted Spaces"]'), 'the list');
    const row = host.querySelector('ul[aria-label="Deleted Spaces"] li')!;
    expect(row.textContent).toContain('Deals');
    expect(row.textContent).toContain('Deleted by Ada');
    expect(row.textContent).toContain('2026');
    expect(row.textContent).toContain('3 pages');
    expect(row.querySelector('[data-slot="private-space"]')).toBeTruthy();
    await act(async () => button('Restore Deals')!.click());
    await until(() => !!host.querySelector('[data-slot="deleted-spaces-empty"]'), 'the empty list');
    expect(calls.find((call) => call.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/admin/spaces/s1/restore',
    });
    expect(refresh).toHaveBeenCalled();
});
