// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// The phone header: the title, one status indicator (the connection) and
// a ⋯ menu that holds every other header control, with the same handlers
// as the desktop buttons. jsdom applies no CSS, so both the desktop
// buttons and ⋯ are in the document; which shows is Tailwind's (md).
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let state: State;
let conversations: Conversation[] = [];
let role: 'admin' | 'member' = 'admin';
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Socio',
            instructions: 'Socio helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations,
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
});

let requests: string[] = [];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/settings' && method === 'PATCH') {
        const body = JSON.parse(String(init!.body)) as { paused: boolean };
        requests.push(`PATCH settings paused=${body.paused}`);
        state = { ...state, settings: { ...state.settings, paused: body.paused } };
        return [200, state.settings];
    }
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
    const info = path.match(/^\/api\/conversations\/([^/]+)\/deletion$/);
    if (info) {
        return [200, { scheduledTasks: 0, blocked: null }];
    }
    const transcript = path.match(/^\/api\/conversations\/([^/]+)\/transcript$/);
    if (transcript) {
        return [200, { conversation: conversations.find((c) => c.id === transcript[1]), messages: [] }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    state = {
        settings: { name: 'Brain', paused: false, researchAllowed: false, memoryAllowed: true },
        tasks: [],
        memories: [],
        mode: 'live',
        configured: true,
    };
    role = 'admin';
    conversations = [{ id: 'c1', dotId: 'd1', ownerId: 'alice', title: 'Garden plan', createdAt: 1 }];
    requests = [];
    // jsdom has none; the palette's list scrolls its active row into view.
    Element.prototype.scrollIntoView ??= () => {};
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
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return Response.json(body, { status });
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
    act(() => root.render(<RouterProvider router={createTestRouter(path)} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
}
const header = () => host.querySelector<HTMLElement>('[data-slot="app-header"]')!;
const more = () => header().querySelector<HTMLButtonElement>('[data-slot="header-overflow-button"]')!;
const menu = () => document.querySelector<HTMLElement>('[data-slot="header-overflow-menu"]');
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
/** Opens ⋯ from the keyboard, as Enter on the focused button does. */
async function openMore() {
    await until(() => !!more(), 'the ⋯ button');
    act(() => more().focus());
    key(more(), 'Enter');
    await until(() => !!menu(), 'the ⋯ menu');
}
const items = () =>
    [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
        item.textContent!.replace(/\d+$/, '').replace('?', '').trim(),
    );
const item = (name: string) =>
    [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.replace('?', '').trim() === name,
    );
/** Chooses an item from the keyboard: focus, then Enter. */
function choose(name: string) {
    const entry = item(name);
    expect(entry, name).toBeDefined();
    act(() => entry!.focus());
    key(entry!, 'Enter');
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

it('holds every header control, with the chat’s menu and Help’s, under one labeled ⋯', async () => {
    await open('/chats/c1');
    await until(() => !!header().querySelector('[aria-label="Chat options"]'), 'the chat’s title');
    expect(more().getAttribute('aria-label')).toBe('More options');
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    await openMore();
    await until(() => items().includes('Rename'), 'the chat’s items');
    expect(items()).toEqual([
        'Search',
        'Report issue',
        'Ask a socio',
        'Pause all socios',
        'Show computer',
        'Rename',
        'Archive',
        'Delete',
        'Help and guides',
        'What’s new',
        'Keyboard shortcuts',
    ]);
    expect(menu()!.querySelector('[data-slot="header-chat-items"]')!.textContent).toMatch(/^Chat/);
    expect([...menu()!.querySelectorAll('[role="menuitemradio"]')].map((entry) => entry.textContent)).toEqual([
        'Light',
        'Dark',
        'System',
    ]);
    // Each of the desktop header's buttons has its item here.
    for (const [button, entry] of [
        ['Pause all socios', 'Pause all socios'],
        ['Ask a socio', 'Ask a socio'],
        ['Report issue', 'Report issue'],
        ['Help', 'Help and guides'],
        ['Show computer', 'Show computer'],
        ['Chat options', 'Rename'],
    ]) {
        expect(header().querySelector(`[aria-label="${button}"]`), button).not.toBeNull();
        expect(item(entry!), entry).toBeDefined();
    }
    // Escape closes it and gives the focus back to ⋯.
    key(menu()!, 'Escape');
    await until(() => !menu(), 'the menu closed');
    await until(() => document.activeElement === more(), 'the focus on ⋯');
});

it('shows one status indicator: the connection, while online too', async () => {
    await open('/chats/c1');
    await until(() => !!header().querySelector('[data-slot="connection-indicator"]'), 'the indicator');
    const indicator = header().querySelector<HTMLElement>('[data-slot="connection-indicator"]')!;
    expect(indicator.dataset.stateConnection).toBe('online');
    expect(indicator.getAttribute('aria-label')).toMatch(/^Connection: Online/);
    // The desktop header still shows nothing while all is well.
    expect(header().querySelector('[data-slot="connection-badge"]')).toBeNull();
});

it('pauses and resumes all socios, and shows the computer, with the header buttons’ handlers', async () => {
    await open('/chats/c1');
    await openMore();
    choose('Pause all socios');
    await until(() => requests.includes('PATCH settings paused=true'), 'the pause');
    await until(() => !!header().querySelector('[aria-label="Resume all socios"]'), 'the paused header');
    await openMore();
    expect(item('Resume all socios')).toBeDefined();
    choose('Resume all socios');
    await until(() => requests.includes('PATCH settings paused=false'), 'the resume');
    const computer = () => header().querySelector<HTMLElement>('[aria-label$=" computer"]')!;
    expect(computer().getAttribute('aria-expanded')).toBe('false');
    await openMore();
    choose('Show computer');
    await until(() => computer().getAttribute('aria-expanded') === 'true', 'the computer');
    await openMore();
    expect(item('Hide computer')).toBeDefined();
});

it('leaves Pause out for members', async () => {
    role = 'member';
    await open('/chats/c1');
    await openMore();
    expect(items()).not.toContain('Pause all socios');
    expect(items()).toContain('Search');
});

it('opens what an item opens once the menu has closed, and gives the focus back to ⋯', async () => {
    await open('/chats/c1');
    await openMore();
    choose('Keyboard shortcuts');
    await until(() => !!document.querySelector('[data-slot="shortcuts-dialog"]'), 'the shortcuts');
    await settle();
    expect(menu()).toBeNull();
    key(document.querySelector('[data-slot="shortcuts-dialog"]')!, 'Escape');
    await until(() => !document.querySelector('[data-slot="shortcuts-dialog"]'), 'the shortcuts closed');
    await until(() => document.activeElement === more(), 'the focus on ⋯');
    // Search opens the palette.
    await openMore();
    choose('Search');
    await until(() => !!document.querySelector('[aria-label="Search Socio"]'), 'the palette');
});

it('opens What’s new from ⋯, anchored to it, and gives the focus back there', async () => {
    await open('/chats/c1');
    await openMore();
    choose('What’s new');
    await until(() => !!document.querySelector('[data-slot="whats-new-menu"]'), 'What’s new');
    key(document.querySelector('[data-slot="whats-new-menu"]')!, 'Escape');
    await until(() => !document.querySelector('[data-slot="whats-new-menu"]'), 'What’s new closed');
    await until(() => document.activeElement === more(), 'the focus on ⋯');
});

it('renames the chat in the header and confirms Delete from ⋯, as the title’s menu does', async () => {
    await open('/chats/c1');
    await openMore();
    await until(() => !!item('Rename'), 'Rename');
    choose('Rename');
    const box = () => document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    await until(() => !!box(), 'the title box');
    expect(header().contains(box())).toBe(true);
    await until(() => document.activeElement === box(), 'the focus in the title box');
    key(box()!, 'Escape');
    await until(() => !box(), 'the title back');
    // Delete asks first, in the same dialog.
    await openMore();
    await until(() => !!item('Delete'), 'Delete');
    choose('Delete');
    await until(() => !!document.querySelector('[role="alertdialog"]'), 'the confirm');
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Delete chat?');
});

it('has no chat items away from a chat, and no Report issue on Issues', async () => {
    await open('/issues');
    await openMore();
    expect(items()).not.toContain('Rename');
    expect(items()).not.toContain('Report issue');
    expect(items()).toContain('Ask a socio');
});

// A dialog opened from ⋯ has no trigger of its own (the item went with the
// menu): closing it gives the focus back to ⋯, not to the page's body.
it('gives the focus back to ⋯ when Report issue, opened from it, is cancelled', async () => {
    await open('/chats/c1');
    await openMore();
    choose('Report issue');
    const report = () => document.querySelector<HTMLElement>('[data-slot="report-issue-form"]');
    await until(() => !!report(), 'the report dialog');
    await until(() => report()!.contains(document.activeElement), 'the focus in the dialog');
    key(report()!, 'Escape');
    await until(() => !report(), 'the report dialog closed');
    await until(() => document.activeElement === more(), 'the focus on ⋯');
});

it('gives the focus back to ⋯ when Delete’s confirm, opened from it, is cancelled', async () => {
    await open('/chats/c1');
    // With Escape, then with Cancel.
    for (const cancel of ['Escape', 'Cancel']) {
        await openMore();
        await until(() => !!item('Delete'), 'Delete');
        choose('Delete');
        const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
        await until(() => !!confirm(), 'the confirm');
        await until(() => confirm()!.contains(document.activeElement), 'the focus in the confirm');
        if (cancel === 'Escape') {
            key(confirm()!, 'Escape');
        } else {
            const button = [...confirm()!.querySelectorAll('button')].find((entry) => entry.textContent === 'Cancel')!;
            act(() => button.click());
        }
        await until(() => !confirm(), 'the confirm closed');
        await until(() => document.activeElement === more(), `the focus on ⋯ after ${cancel}`);
        expect(conversations.map((entry) => entry.id)).toEqual(['c1']);
    }
});

it('gives the focus back to ⋯ when Share as a room, opened from it, is cancelled', async () => {
    state = { ...state, settings: { ...state.settings, rooms: { enabled: true } } as State['settings'] };
    await open('/chats/c1');
    await openMore();
    await until(() => !!item('Share as a room…'), 'Share as a room');
    choose('Share as a room…');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    await until(() => !!dialog(), 'the share dialog');
    await until(() => dialog()!.contains(document.activeElement), 'the focus in the share dialog');
    key(dialog()!, 'Escape');
    await until(() => !dialog(), 'the share dialog closed');
    await until(() => document.activeElement === more(), 'the focus on ⋯');
});
