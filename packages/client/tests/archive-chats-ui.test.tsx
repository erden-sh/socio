// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { liveTopicsOf, notesForWrite } from '@socio/shared/live/change-notes';
import type { Conversation, State, WorkspaceState } from '@socio/shared/types';

import { chatModule } from '../src/modules/chat/module';
import { dotPath } from '../src/modules/chat/nav';
import { findChat } from '../src/shell/shell-context';

import { createTestRouter } from './helpers/app-router';

// Archive in the chat menu (no confirm, a toast with Undo), the
// archived chat's notice when opened by its link, and Account →
// Archived chats. The live chat is a stand-in, as in
// chat-menu-ui.test.tsx.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
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
    configured: true,
};
const chat = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    dotId: 'd1',
    ownerId: 'alice',
    title,
    createdAt: 1,
    ...extra,
});
// The server's chats: archived ones carry `archivedAt`, as the store does.
let chats: Conversation[] = [];
const dots: WorkspaceState['dots'] = [
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
    {
        id: 'd2',
        spaceId: 's1',
        spaceIds: ['s1'],
        name: 'Ada',
        instructions: 'Ada helps.',
        researchAllowed: false,
        memoryAllowed: false,
        createdAt: 2,
    },
];
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role: 'admin' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots,
    conversations: chats.filter((c) => !c.archivedAt),
    archived: chats.filter((c) => c.archivedAt).sort((a, b) => b.archivedAt! - a.archivedAt!),
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});

let requests: string[] = [];
let clock = 1_000;
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
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
    const one = path.match(/^\/api\/conversations\/([^/]+)$/);
    const found = one && chats.find((c) => c.id === one[1]);
    if (found && method === 'PATCH') {
        const body = JSON.parse(String(init!.body)) as { archived: boolean };
        requests.push(`PATCH ${found.id} archived=${body.archived}`);
        if (body.archived) {
            found.archivedAt ??= clock++;
        } else {
            delete found.archivedAt;
        }
        return [200, found];
    }
    if (found && method === 'DELETE') {
        requests.push(`DELETE ${found.id}`);
        chats = chats.filter((c) => c !== found);
        return [200, { ok: true }];
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
    chats = [
        chat('c1', 'Garden plan'),
        chat('c2', 'Other chat'),
        chat('c3', 'Ada’s chat', { dotId: 'd2' }),
        chat('a1', 'Old trip', { archivedAt: 500 }),
        chat('a2', 'Older trip', { archivedAt: 400, dotId: 'd2' }),
    ];
    requests = [];
    clock = 1_000;
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
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const header = () => host.querySelector<HTMLElement>('[data-slot="app-header"]')!;
const crumb = () => header().querySelector('[data-slot="breadcrumb-page"]')?.textContent;
const rowTitles = () => [...host.querySelectorAll('[data-thread-title]')].map((item) => item.textContent);
const menuItems = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((entry) => entry.textContent?.trim());
const item = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === name,
    );
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
async function openMenu(label: string) {
    await until(() => !!byLabel(label), label);
    key(byLabel(label)!, 'Enter');
    await until(() => !!item('Rename'), 'the chat menu');
}
const toasts = () => [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
const undo = () =>
    toasts()
        .flatMap((toast) => [...toast.querySelectorAll('button')])
        .find((button) => button.textContent === 'Undo');
const notice = () => host.querySelector<HTMLElement>('[data-slot="archived-chat"]');
const archivedList = () => document.querySelector<HTMLElement>('[data-slot="archived-chats"]');
const archivedRows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-archived-chat]')].map((row) => row.dataset.archivedChat);

it('archives a chat from its row without asking, and Undo brings it back', async () => {
    const router = await open('/chats/c1');
    await until(() => rowTitles().includes('Other chat'), 'the rows');
    expect(rowTitles()).not.toContain('Old trip');
    await openMenu('Options for Other chat');
    expect(menuItems()).toEqual(['Rename', 'Archive', 'Delete']);
    act(() => item('Archive')!.click());
    await until(() => !rowTitles().includes('Other chat'), 'the row to go');
    // No confirm: archive is undone, not asked.
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await until(() => !!undo(), 'the toast with Undo');
    expect(toasts().some((t) => t.textContent?.includes('Chat archived'))).toBe(true);
    expect(router.state.location.pathname).toBe('/chats/c1');
    act(() => undo()!.click());
    await until(() => rowTitles().includes('Other chat'), 'the row back');
    expect(router.state.location.pathname).toBe('/chats/c1');
    expect(requests).toEqual(['PATCH c2 archived=true', 'PATCH c2 archived=false']);
});

it('archives the open chat from the header: a new chat with its Dot, and Undo returns to it', async () => {
    const router = await open('/chats/c1');
    await until(() => crumb() === 'Garden plan', 'the chat');
    await openMenu('Chat options');
    act(() => item('Archive')!.click());
    await until(() => router.state.location.pathname === '/dots/d1/new', 'a new chat with the Dot');
    await until(() => !rowTitles().includes('Garden plan'), 'the row to go');
    await until(() => !!undo(), 'Undo');
    act(() => undo()!.click());
    await until(() => router.state.location.pathname === '/chats/c1', 'back in the chat');
    await until(() => rowTitles().includes('Garden plan'), 'the row back');
    expect(notice()).toBeNull();
    expect(requests).toEqual(['PATCH c1 archived=true', 'PATCH c1 archived=false']);
});

it('leaves archived chats out of the sidebar, the palette and Home', async () => {
    // Ada's only live chat archived; her Dot opens its home page (CB-89).
    chats.find((c) => c.id === 'c3')!.archivedAt = 600;
    const shell = workspace();
    expect(dotPath(dots[1]!)).toBe('/dots/d2');
    const commands = chatModule.commands!({
        workspace: shell,
    } as Parameters<NonNullable<typeof chatModule.commands>>[0]);
    const labels = commands.map((command) => command.label);
    expect(labels).toEqual(expect.arrayContaining(['Garden plan', 'Other chat']));
    for (const archived of ['Ada’s chat', 'Old trip', 'Older trip']) {
        expect(labels).not.toContain(archived);
    }
    // Still found by id, so their links open.
    expect(findChat(shell, 'a1')?.title).toBe('Old trip');
    expect(findChat(shell, 'nope')).toBeUndefined();

    await open('/');
    await until(() => rowTitles().includes('Garden plan'), 'the sidebar');
    expect(rowTitles()).toEqual(['Garden plan', 'Other chat']);
    const home = host.querySelector('[aria-labelledby="home-recent"]');
    const recent = home?.textContent ?? host.textContent!;
    expect(recent).toContain('Garden plan');
    for (const archived of ['Ada’s chat', 'Old trip', 'Older trip']) {
        expect(recent).not.toContain(archived);
    }
    const ada = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent?.trim() === 'Ada');
    expect(ada?.getAttribute('href')).toBe('/dots/d2');
});

it('opens an archived chat by its link, with a notice that unarchives it', async () => {
    await open('/chats/a1');
    await until(() => crumb() === 'Old trip', 'the archived chat');
    expect(host.querySelector('[data-slot="live-chat-stand-in"]')).not.toBeNull();
    await until(() => !!notice(), 'the notice');
    expect(notice()!.textContent).toContain('This chat is archived.');
    expect(notice()!.getAttribute('role')).toBe('status');
    // Not in the sidebar, even while open.
    expect(rowTitles()).not.toContain('Old trip');
    // Its header menu offers Unarchive instead of Archive.
    await openMenu('Chat options');
    expect(menuItems()).toEqual(['Rename', 'Unarchive', 'Delete']);
    key(document.activeElement!, 'Escape');
    await until(() => !item('Rename'), 'the menu to close');
    const button = [...notice()!.querySelectorAll('button')].find((entry) => entry.textContent === 'Unarchive')!;
    act(() => button.click());
    await until(() => !notice(), 'the notice to go');
    await until(() => rowTitles().includes('Old trip'), 'the row');
    expect(crumb()).toBe('Old trip');
    expect(requests).toEqual(['PATCH a1 archived=false']);
    await until(() => toasts().some((t) => t.textContent?.includes('Chat unarchived')), 'the toast');
});

async function openArchivedChats() {
    await until(() => !!byLabel('Account: Alice'), 'the account menu');
    key(byLabel('Account: Alice')!, 'Enter');
    await until(() => !!item('Account'), 'the account item');
    act(() => item('Account')!.click());
    // Settings → Account (a page since CB-95), then its Archived chats.
    await until(() => !!document.querySelector('nav[aria-label="Settings"]'), 'the settings page');
    act(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings"] a')]
            .find((link) => link.textContent === 'Archived chats')!
            .click(),
    );
    await until(() => !!document.querySelector('[data-slot="archived-chats-section"]'), 'the archived chats page');
    const section = document.querySelector<HTMLElement>('[data-slot="archived-chats-section"]')!;
    expect(section.textContent).toContain('2 archived chats');
    act(() => [...section.querySelectorAll('button')].find((button) => button.textContent === 'Manage')!.click());
    await until(() => !!archivedList(), 'Archived chats');
}

it('lists archived chats in Account, the last archived first, with Unarchive and Delete', async () => {
    const router = await open('/chats/c1');
    await openArchivedChats();
    expect(archivedList()!.textContent).toContain('Archived chats');
    expect(archivedRows()).toEqual(['a1', 'a2']);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-archived-chat="${id}"]`)!;
    // Title, Dot and date.
    expect(row('a2').textContent).toContain('Older trip');
    expect(row('a2').textContent).toContain('Ada · Archived');
    expect(row('a2').querySelector('time')).not.toBeNull();
    // Unarchive: it leaves the list for the sidebar.
    act(() => byLabel('Unarchive Older trip')!.click());
    await until(() => archivedRows().length === 1, 'the row to go');
    await until(() => rowTitles().includes('Older trip'), 'the sidebar row');
    // Delete asks first, as from the menu.
    act(() => byLabel('Delete Old trip')!.click());
    await until(() => !!document.querySelector('[role="alertdialog"]'), 'the confirm');
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain('This will delete “Old trip”.');
    act(() => [...confirm.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!.click());
    await until(() => archivedRows().length === 0, 'the list to empty');
    expect(archivedList()!.textContent).toContain('You have no archived chats.');
    expect(router.state.location.pathname).toBe('/settings/archived-chats');
    expect(requests).toEqual(['PATCH a2 archived=false', 'DELETE a1']);
});

it('opens a chat from the archived list, closing it', async () => {
    const router = await open('/chats/c1');
    await openArchivedChats();
    const link = [...archivedList()!.querySelectorAll<HTMLAnchorElement>('a')].find(
        (entry) => entry.textContent === 'Older trip',
    )!;
    expect(link.getAttribute('href')).toBe('/chats/a2');
    act(() => link.click());
    await until(() => router.state.location.pathname === '/chats/a2', 'the archived chat');
    await until(() => !archivedList(), 'the list to close');
    await until(() => !document.querySelector('[data-slot="archived-chats-section"]'), 'the settings page to go');
    await until(() => !!notice(), 'the notice');
    expect(crumb()).toBe('Older trip');
});

it('tells the other tabs about an archive, by id only', () => {
    // The chat menu's PATCH: the other tabs' shells re-read.
    const notes = notesForWrite('/conversations/c2');
    expect(notes).toEqual([{ topic: 'conversation', id: 'c2' }]);
    expect(liveTopicsOf(notes[0]!)).toEqual(['shell', 'conversation:c2']);
});
