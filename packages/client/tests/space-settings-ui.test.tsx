// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SpacePeopleView } from '@socio/shared/space-memory';
import type { Role, Space, State, WorkspaceState } from '@socio/shared/types';

import { NavSpace } from '../src/components/nav-spaces';
import { SidebarProvider } from '../src/components/ui/sidebar';
import { WorkspaceDialog } from '../src/modules/settings/WorkspaceDialog';
import { SpaceSettings } from '../src/modules/spaces/SpaceSettings';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Spaces made private (CB-181): who sees a Space is chosen when it is made
// and under its Settings, labeled with everything it covers; private
// Spaces carry a lock. Opening one to the whole workspace is an admin's.

vi.mock('../src/modules/chat/ModelSelect', () => ({
    ModelSelect: () => null,
    useModelOptions: () => undefined,
}));
vi.mock('../src/modules/settings/WebIdentityField', () => ({
    WebIdentityField: () => null,
    useWebIdentity: () => ({ save: async () => {} }),
}));

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
    description: 'Not for everyone.',
    createdAt: 1,
    private: false,
    access: 'editor',
};

let root: Root;
let host: HTMLElement;
let calls: { method: string; path: string; body?: string }[];
let people: SpacePeopleView;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // The sidebar asks whether it is on a phone.
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname,
            body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (url.pathname === '/api/spaces/s1/access') {
            people = {
                ...people,
                membersOnly: JSON.parse(init!.body as string).membersOnly,
            };
            return Response.json(people);
        }
        if (url.pathname === '/api/spaces/s1/people') {
            return Response.json(people);
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

function render(role: Role, shown: Space = space) {
    const refresh = vi.fn(async () => {});
    const shell = {
        state: { settings: { name: 'Socio', paused: false }, tasks: [] },
        workspace: {
            user: { id: 'me', name: 'Me', role },
            dots: [],
            conversations: [],
            spaces: [shown],
        },
        refresh,
        busy: false,
        mutate: vi.fn(async () => true),
        setError: vi.fn(),
        openDialog: vi.fn(),
    } as unknown as Shell;
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <MemoryRouter initialEntries={['/spaces/s1/settings']}>
                    <SpaceSettings space={shown} />
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
const radio = (label: string) =>
    [...host.querySelectorAll<HTMLLabelElement>('[data-slot="space-audience"] label')]
        .find((item) => item.textContent?.includes(label))!
        .querySelector('input')!;
const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );

it('lets an admin make a Space private after saying everything it covers, and open it again', async () => {
    people = {
        spaceId: 's1',
        membersOnly: false,
        people: [{ userId: 'mo', name: 'Mo', role: 'member', addedBy: 'me', addedAt: 1 }],
        access: 'editor',
        candidates: [{ id: 'nina', name: 'Nina' }],
    };
    const refresh = render('admin');
    await until(() => !!host.querySelector('[data-slot="space-audience"]'), 'the choice');
    // The tabs: Pages, Memory, Settings.
    expect([...host.querySelectorAll('nav[aria-label="Deals sections"] a')].map((link) => link.textContent)).toEqual([
        'Pages',
        'Memory',
        'Radar',
        'Settings',
    ]);
    // The label says what it covers, not memory alone.
    const audience = host.querySelector('[data-slot="space-audience"]')!;
    expect(audience.textContent).toContain('Whole workspace');
    expect(audience.textContent).toContain('Only its people');
    for (const covered of ['pages', 'page chats', 'search', 'apps', 'datasets', 'files', 'memory']) {
        expect(audience.textContent, covered).toContain(covered);
    }
    expect(radio('Whole workspace').checked).toBe(true);
    expect(radio('Whole workspace').disabled).toBe(false);
    // Private, after a confirmation that says who stops seeing it.
    await act(async () => radio('Only its people').click());
    await until(() => !!document.querySelector('[data-slot="space-audience-confirm"]'), 'the confirmation');
    expect(document.querySelector('[data-slot="space-audience-confirm"]')?.textContent).toContain(
        'Everyone else stops seeing it at once',
    );
    await act(async () => button('Make private')!.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the change');
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/api/spaces/s1/access',
        body: JSON.stringify({ membersOnly: true }),
    });
    expect(refresh).toHaveBeenCalled();
    await until(() => radio('Only its people').checked, 'the new choice');
    // Its people: roles to change, a person to remove or add.
    expect(button('Remove Mo')).toBeTruthy();
    expect(host.querySelector('form[aria-label="Add a person"]')).toBeTruthy();
    await act(async () => button('Remove Mo')!.click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the removal');
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/spaces/s1/people/mo');
});

it('gives a member editor the private choice only, and a reader a sentence', async () => {
    people = {
        spaceId: 's1',
        membersOnly: true,
        people: [{ userId: 'me', name: 'Me', role: 'editor', addedBy: 'me', addedAt: 1 }],
        access: 'editor',
        candidates: [],
    };
    render('member', { ...space, private: true });
    await until(() => !!host.querySelector('[data-slot="space-audience"]'), 'the choice');
    expect(radio('Whole workspace').disabled).toBe(true);
    expect(host.textContent).toContain('Only workspace admins make a Space for everyone.');
    // The heading's lock, named for screen readers.
    expect(host.querySelector('[data-page-heading] [data-slot="private-space"]')?.getAttribute('aria-label')).toBe(
        'Private Space',
    );

    act(() => root.unmount());
    root = createRoot(host);
    people = { ...people, access: 'reader', people: [] };
    render('member', { ...space, private: true, access: 'reader' });
    await until(() => !!host.querySelector('[data-slot="space-audience-note"]'), 'the note');
    expect(host.querySelector('[data-slot="space-audience"]')).toBeNull();
    expect(host.textContent).toContain('Private: only its people');
    expect(button('Remove Me')).toBeUndefined();
});

it('lets an editor rename the Space, and shows a reader no rename (CB-366)', async () => {
    people = {
        spaceId: 's1',
        membersOnly: true,
        people: [{ userId: 'me', name: 'Me', role: 'editor', addedBy: 'me', addedAt: 1 }],
        access: 'editor',
        candidates: [],
    };
    const refresh = render('member', { ...space, private: true });
    await until(() => !!host.querySelector('[data-slot="space-name"]'), 'the name');
    const input = host.querySelector<HTMLInputElement>('[data-slot="space-name"] input')!;
    expect(input.value).toBe('Deals');
    expect(input.maxLength).toBe(60);
    // Unchanged or blank: nothing to save.
    expect(button('Rename')!.hasAttribute('disabled')).toBe(true);
    const type = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    type('   ');
    expect(button('Rename')!.hasAttribute('disabled')).toBe(true);
    type('  Pipeline ');
    expect(button('Rename')!.hasAttribute('disabled')).toBe(false);
    await act(async () => button('Rename')!.click());
    await until(() => refresh.mock.calls.length > 0, 'the refresh');
    expect(calls.find((call) => call.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: '/api/spaces/s1',
        body: JSON.stringify({ name: 'Pipeline' }),
    });

    act(() => root.unmount());
    root = createRoot(host);
    people = { ...people, access: 'reader', people: [] };
    render('member', { ...space, private: true, access: 'reader' });
    await until(() => !!host.querySelector('[data-slot="space-audience-note"]'), 'the note');
    expect(host.querySelector('[data-slot="space-name"]')).toBeNull();
});

it('marks a private Space with a lock in the sidebar, and only a private one', async () => {
    act(() =>
        root.render(
            <MemoryRouter>
                <SidebarProvider>
                    <ul>
                        <NavSpace space={{ ...space, private: true }} onNavigate={() => {}} />
                        <NavSpace space={{ ...space, id: 's2', name: 'Open' }} onNavigate={() => {}} />
                    </ul>
                </SidebarProvider>
            </MemoryRouter>,
        ),
    );
    const locks = host.querySelectorAll('[data-slot="private-space"]');
    expect(locks).toHaveLength(1);
    expect(locks[0]!.closest('a')?.textContent).toContain('Deals');
});

it.each([
    ['member', true, true],
    ['admin', false, false],
] as const)('asks who sees a new Space: a %s’s is private by default', async (role, privateByDefault, locked) => {
    const mutate = vi.fn(async (_path: string, _method: string, _body?: unknown) => true);
    await act(async () =>
        root.render(
            <MemoryRouter>
                <WorkspaceDialog
                    dialog={{ type: 'space' }}
                    state={{ settings: {} } as State}
                    workspace={
                        {
                            user: { id: 'me', name: 'Me', role },
                            spaces: [],
                            dots: [],
                            conversations: [],
                        } as unknown as WorkspaceState
                    }
                    onClose={() => {}}
                    mutate={mutate}
                />
            </MemoryRouter>,
        ),
    );
    const choice = (label: string) =>
        [...document.querySelectorAll<HTMLLabelElement>('[data-slot="space-audience"] label')]
            .find((item) => item.textContent?.includes(label))!
            .querySelector('input')!;
    expect(choice('Only its people').checked).toBe(privateByDefault);
    expect(choice('Whole workspace').disabled).toBe(locked);
    const name = document.querySelector<HTMLInputElement>('#entity-name')!;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(name, 'Deals');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (!privateByDefault) {
        await act(async () => choice('Only its people').click());
    }
    await act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mutate.mock.calls[0]).toMatchObject(['/spaces', 'POST', { name: 'Deals', private: true }]);
});
