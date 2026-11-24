// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, ConversationDeletion, State, WorkspaceState } from '@socio/shared/types';

import { deleteSentence } from '../src/modules/chat/chat-menu';

import { createTestRouter } from './helpers/app-router';

// CB-66: the chat menu (Rename, Delete) on sidebar rows and in the header.
// The live chat is a stand-in: CopilotKit's package imports a stylesheet
// Node can't load, and the menu lives outside it.
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
const chat = (id: string, title: string, extra: Partial<Conversation> = {}) => ({
    id,
    dotId: 'd1',
    ownerId: 'alice',
    title,
    createdAt: 1,
    ...extra,
});
let conversations: Conversation[] = [];
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role: 'admin' },
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
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});

// The server: renames and deletes, and what each chat's Delete would do.
let requests: string[] = [];
let deletion: Record<string, Partial<ConversationDeletion>> = {};
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
        return [200, { scheduledTasks: 0, blocked: null, ...deletion[info[1]!] }];
    }
    const transcript = path.match(/^\/api\/conversations\/([^/]+)\/transcript$/);
    if (transcript) {
        return [
            200,
            {
                conversation: conversations.find((c) => c.id === transcript[1]),
                messages: [],
            },
        ];
    }
    const one = path.match(/^\/api\/conversations\/([^/]+)$/);
    const found = one && conversations.find((c) => c.id === one[1]);
    if (found && method === 'PATCH') {
        const body = JSON.parse(String(init!.body)) as { title: string };
        requests.push(`PATCH ${found.id} ${body.title}`);
        found.title = body.title;
        found.renamed = true;
        return [200, found];
    }
    if (found && method === 'DELETE') {
        requests.push(`DELETE ${found.id}`);
        conversations = conversations.filter((c) => c !== found);
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
    conversations = [
        chat('c1', 'Garden plan'),
        chat('c2', 'Other chat'),
        chat('t1', 'Team plan', {
            ownerId: 'telegram-team:chat-1',
            team: true,
            source: 'telegram',
        }),
    ];
    requests = [];
    deletion = {};
    // jsdom has none; the tooltip's arrow measures itself with one.
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

/** Waits (in act) until `check` holds, for up to 10 s. */
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
const item = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === name,
    );
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));
    });
async function openMenu(label: string) {
    await until(() => !!byLabel(label), label);
    key(byLabel(label)!, 'Enter');
    await until(() => !!item('Rename'), 'the chat menu');
}
const titleBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
async function startRename(label: string) {
    await openMenu(label);
    act(() => item('Rename')!.click());
    await until(() => !!titleBox(), 'the title box');
}
const type = (value: string) => {
    act(() => {
        titleBox()!.value = value;
    });
};

it('offers the menu only on chats the user owns', async () => {
    const router = await open('/chats/c1');
    await until(() => crumb() === 'Garden plan', 'the chat’s title');
    // The header: the Dot, then the chat’s title with its ⋯.
    expect(header().textContent).toContain('Socio');
    expect(header().querySelector('[aria-label="Chat options"]')).not.toBeNull();
    expect(byLabel('Options for Garden plan')).not.toBeNull();
    expect(byLabel('Options for Other chat')).not.toBeNull();
    // A Telegram team topic the user is only in: no menu anywhere.
    expect(byLabel('Options for Team plan')).toBeNull();
    await act(() => router.navigate('/chats/t1'));
    await until(() => crumb() === 'Team plan', 'the team chat');
    expect(header().querySelector('[aria-label="Chat options"]')).toBeNull();
    // Right-click on a team row keeps the browser's own menu.
    const team = host.querySelector('[data-chat-row="t1"]')!;
    const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        team.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(item('Rename')).toBeUndefined();
});

it('opens the same menu on right-click of a row', async () => {
    await open('/chats/c1');
    await until(() => !!byLabel('Options for Other chat'), 'the rows');
    const row = host.querySelector('[data-chat-row="c2"]')!;
    const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        row.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await until(() => !!item('Rename') && !!item('Delete'), 'the menu');
    expect([...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim())).toEqual([
        'Rename',
        'Archive',
        'Delete',
    ]);
});

it('renames a row in place: Enter saves, Escape and empty keep the title', async () => {
    await open('/chats/c1');
    await startRename('Options for Other chat');
    expect(titleBox()!.value).toBe('Other chat');
    expect(document.activeElement).toBe(titleBox());
    // Escape keeps the old title and saves nothing.
    type('Something else');
    key(titleBox()!, 'Escape');
    await until(() => !titleBox(), 'the row back');
    expect(rowTitles()).toContain('Other chat');
    // Empty restores the old title.
    await startRename('Options for Other chat');
    type('   ');
    key(titleBox()!, 'Enter');
    await until(() => !titleBox(), 'the row back');
    expect(rowTitles()).toContain('Other chat');
    // Typing while composing (an IME) doesn't save.
    await startRename('Options for Other chat');
    type('  Seed order  ');
    key(titleBox()!, 'Enter', { isComposing: true });
    expect(titleBox()).not.toBeNull();
    key(titleBox()!, 'Enter');
    await until(() => rowTitles().includes('Seed order'), 'the new title');
    expect(requests).toEqual(['PATCH c2 Seed order']);
    expect(byLabel('Options for Seed order')).not.toBeNull();
});

it('renames the open chat from the header, and the sidebar follows', async () => {
    await open('/chats/c1');
    await startRename('Chat options');
    expect(header().contains(titleBox())).toBe(true);
    type('Garden plan, v2');
    key(titleBox()!, 'Enter');
    await until(() => crumb() === 'Garden plan, v2', 'the header title');
    expect(rowTitles()).toContain('Garden plan, v2');
    expect(requests).toEqual(['PATCH c1 Garden plan, v2']);
    // Leaving the box saves too.
    await startRename('Chat options');
    type('Garden plan, v3');
    act(() => titleBox()!.blur());
    await until(() => crumb() === 'Garden plan, v3', 'the blurred title');
    expect(requests.at(-1)).toBe('PATCH c1 Garden plan, v3');
});

it('deletes the open chat after a confirm naming its tasks, then opens a new chat with its socio', async () => {
    deletion.c1 = { scheduledTasks: 2 };
    const router = await open('/chats/c1');
    await openMenu('Chat options');
    act(() => item('Delete')!.click());
    await until(() => !!dialog(), 'the confirm dialog');
    expect(dialog()!.textContent).toContain('Delete chat?');
    await until(
        () => dialog()!.textContent!.includes('This will delete “Garden plan” and its 2 scheduled tasks.'),
        'the task count',
    );
    expect(dialog()!.textContent).not.toMatch(/restore/i);
    // Cancel is focused first; Escape keeps the chat.
    expect(document.activeElement?.textContent).toBe('Cancel');
    key(document.activeElement!, 'Escape');
    await until(() => !dialog(), 'the dialog to close');
    expect(requests).toEqual([]);

    await openMenu('Chat options');
    act(() => item('Delete')!.click());
    await until(() => !!dialog(), 'the confirm dialog again');
    const confirm = [...dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!;
    expect(confirm.dataset.variant ?? confirm.className).toMatch(/destructive/);
    act(() => confirm.click());
    await until(() => router.state.location.pathname === '/dots/d1/new', 'a new chat with the socio');
    expect(requests).toEqual(['DELETE c1']);
    await until(() => !rowTitles().includes('Garden plan'), 'the row to go');
});

it('deletes another chat and stays on the open one', async () => {
    const router = await open('/chats/c1');
    await openMenu('Options for Other chat');
    act(() => item('Delete')!.click());
    await until(() => !!dialog(), 'the confirm dialog');
    expect(dialog()!.textContent).toContain('This will delete “Other chat”.');
    act(() => [...dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!.click());
    await until(() => !rowTitles().includes('Other chat'), 'the row to go');
    expect(router.state.location.pathname).toBe('/chats/c1');
    expect(requests).toEqual(['DELETE c2']);
});

it('disables Delete while the socio works, saying why', async () => {
    deletion.c2 = { blocked: 'running', scheduledTasks: 1 };
    await open('/chats/c1');
    await openMenu('Options for Other chat');
    await until(() => item('Delete')?.getAttribute('aria-disabled') === 'true', 'Delete disabled');
    // Still focusable and tappable: choosing it shows the reason, no dialog.
    act(() => item('Delete')!.click());
    await until(() => !!document.querySelector('[role="tooltip"]'), 'the reason');
    expect(document.querySelector('[role="tooltip"]')!.textContent).toBe('Stop the socio first');
    expect(dialog()).toBeNull();
    expect(item('Rename')).toBeDefined();
    expect(requests).toEqual([]);
});

it('words the confirm for none, one and several tasks', () => {
    expect(deleteSentence('Plan', 0)).toBe('This will delete “Plan”.');
    expect(deleteSentence('Plan', 1)).toBe('This will delete “Plan” and its scheduled task.');
    expect(deleteSentence('Plan', 3)).toBe('This will delete “Plan” and its 3 scheduled tasks.');
});
