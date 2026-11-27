// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AskLookup } from '@socio/shared/ask';
import type { Conversation, Dot } from '@socio/shared/types';

import type { Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The live chat is CopilotKit's; here, what the panel hands it.
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: ({ thread, dot, initialPrompt }: { thread: Conversation; dot: Dot; initialPrompt?: string }) => (
        <div data-testid="chat" data-thread={thread.id} data-dot={dot.id} data-prompt={initialPrompt ?? ''} />
    ),
}));

const { AskButton } = await import('../src/modules/ask/AskPanel');
const { askContextOf, isAskShortcut } = await import('../src/modules/ask/ask-context');
const { ShellContext } = await import('../src/shell/shell-context');

const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
    id,
    spaceId: 's1',
    spaceIds: ['s1'],
    name,
    instructions: '',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
    ...extra,
});
const dots = [
    dot('d1', 'Fulano'),
    dot('d2', 'Mingo', { ownerId: 'alice' }),
    dot('d3', 'Elsewhere', { spaceId: 's2', spaceIds: ['s2'] }),
    dot('d4', 'Retired', { archivedAt: 1 }),
];
const thread: Conversation = {
    id: 't1',
    dotId: 'd1',
    ownerId: 'alice',
    title: 'About Launch plan',
    createdAt: 1,
};

let requests: { method: string; url: string; body?: unknown }[] = [];
let existing: Conversation | null = null;
beforeEach(() => {
    requests = [];
    existing = null;
    window.innerWidth = 1280;
    vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (url.startsWith('/api/ask/conversation') && method === 'GET') {
            const query = new URL(url, 'http://x').searchParams;
            const kind = query.get('kind');
            return Response.json({
                context:
                    kind === 'page' && query.get('id') === 'f1'
                        ? { kind, id: 'f1', title: 'Clients', path: '/spaces/s1/pages/f1', folder: true }
                        : kind === 'page'
                          ? {
                                kind,
                                id: query.get('id') ?? '',
                                title: 'Launch plan',
                                path: '/spaces/s1/pages/p1',
                            }
                          : { kind: 'general', id: '', title: null, path: null },
                dotId: query.get('dotId') ?? 'd1',
                conversation: (query.get('dotId') ?? 'd1') === 'd1' ? existing : null,
            } satisfies AskLookup);
        }
        if (url === '/api/ask/conversation') {
            return Response.json({
                context: { kind: 'page', id: 'p1', title: 'Launch plan', path: '' },
                conversation: { ...thread, dotId: body.dotId },
            });
        }
        return Response.json({ ok: true });
    });
});
let root: Root | undefined;
afterEach(() => {
    act(() => root?.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const refresh = vi.fn(async () => {});
async function render(path: string) {
    const shell = {
        state: { settings: { paused: false } },
        workspace: {
            dots,
            calls: [],
            setup: { missing: [], voice: false },
        },
        admin: false,
        refresh,
        openDialog: () => {},
        setPane: () => {},
    } as unknown as Shell;
    const element = (
        <ShellContext.Provider value={shell}>
            <button type="button">Elsewhere in the view</button>
            <AskButton />
        </ShellContext.Provider>
    );
    const router = createMemoryRouter(
        [
            { path: '/', element },
            { path: '/spaces/:spaceId/pages/:pageId', element },
            { path: '/chats/:threadId', element },
        ],
        { initialEntries: [path] },
    );
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = () => document.querySelector<HTMLButtonElement>('[aria-label="Ask a socio"]')!;
const dialog = () => document.querySelector('[data-slot="sheet-content"]');
const key = (init: KeyboardEventInit) =>
    act(async () => {
        window.dispatchEvent(
            new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                ...init,
            }),
        );
    });

it('reads the screen’s item from the route, and ⌘J / Ctrl+J only', () => {
    expect(askContextOf({ spaceId: 's1', pageId: 'p1' })).toEqual({
        kind: 'page',
        id: 'p1',
        spaceId: 's1',
    });
    expect(askContextOf({ issueKey: 'CB-12' })).toEqual({
        kind: 'issue',
        id: 'CB-12',
    });
    expect(askContextOf({ datasetId: 'ds' })).toEqual({
        kind: 'dataset',
        id: 'ds',
    });
    expect(askContextOf({ scheduleId: 'sc' })).toEqual({
        kind: 'schedule',
        id: 'sc',
    });
    // A chat or a socio's page has no item of its own.
    expect(askContextOf({ threadId: 't1', dotId: 'd1' })).toEqual({
        kind: 'general',
        id: '',
    });
    const press = (init: KeyboardEventInit) => isAskShortcut(new KeyboardEvent('keydown', init));
    expect(press({ key: 'j', ctrlKey: true })).toBe(true);
    expect(press({ key: 'J', metaKey: true })).toBe(true);
    expect(press({ key: 'j' })).toBe(false);
    expect(press({ key: 'j', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ key: 'k', ctrlKey: true })).toBe(false);
});

it('opens beside a page with its context, the socios that may answer, and a focused box; the first message opens the conversation', async () => {
    await render('/spaces/s1/pages/p1');
    expect(dialog()).toBeNull();
    await act(async () => button().click());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Ask a socio');
    expect(document.querySelector('[data-slot="ask-context"]')!.textContent).toBe('About this page: Launch plan');
    expect(requests[0]).toMatchObject({
        method: 'GET',
        url: '/api/ask/conversation?kind=page&id=p1',
    });
    // Only socios that may use the page's Space, never archived ones.
    const picker = document.querySelector<HTMLSelectElement>('[aria-label="Socio to ask"]')!;
    expect([...picker.options].map((option) => option.text)).toEqual(['Fulano', 'Mingo (yours)']);
    expect(picker.value).toBe('d1');
    // Beside the view, not over it: no overlay, and the box has focus.
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    const box = document.querySelector<HTMLTextAreaElement>('#ask-prompt')!;
    expect(document.activeElement).toBe(box);
    expect(dialog()!.className).toContain('motion-reduce:animate-none!');

    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(box, 'What is missing?');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(requests.at(-1)).toEqual({
        method: 'POST',
        url: '/api/ask/conversation',
        body: { kind: 'page', id: 'p1', dotId: 'd1' },
    });
    const chat = document.querySelector<HTMLElement>('[data-testid="chat"]')!;
    expect(chat.dataset).toMatchObject({
        thread: 't1',
        dot: 'd1',
        prompt: 'What is missing?',
    });
    expect(refresh).toHaveBeenCalled();
});

it('shows the conversation there is, remembers a picked socio, and toggles on the shortcut with focus back where it was', async () => {
    existing = thread;
    await render('/');
    const elsewhere = document.querySelector<HTMLButtonElement>('button')!;
    elsewhere.focus();
    await key({ key: 'j', ctrlKey: true });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[data-slot="ask-context"]')!.textContent).toContain(
        'Nothing on this screen is shared',
    );
    expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.dataset.thread).toBe('t1');
    // Every socio the person may use, on a screen without a Space.
    const picker = document.querySelector<HTMLSelectElement>('[aria-label="Socio to ask"]')!;
    expect(picker.options).toHaveLength(3);
    await act(async () => {
        picker.value = 'd2';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(requests).toContainEqual({
        method: 'PUT',
        url: '/api/ask/socio',
        body: { dotId: 'd2' },
    });
    expect(requests.at(-1)?.url).toBe('/api/ask/conversation?kind=general&id=&dotId=d2');
    // No conversation with that socio yet: the box to start one.
    expect(document.querySelector('[data-testid="chat"]')).toBeNull();
    expect(document.querySelector('#ask-prompt')).not.toBeNull();

    await key({ key: 'j', metaKey: true });
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
});

it('leaves a conversation the main view shows to the view', async () => {
    existing = thread;
    await render('/chats/t1');
    await act(async () => button().click());
    await settle();
    expect(document.querySelector('[data-testid="chat"]')).toBeNull();
    expect(dialog()!.textContent).toContain('open in the main view');
});

it('is a modal bottom sheet on a phone', async () => {
    window.innerWidth = 390;
    await render('/spaces/s1/pages/p1');
    await act(async () => button().click());
    await settle();
    expect(dialog()!.className).toContain('rounded-t-2xl');
    expect(dialog()!.className).toContain('inset-x-0 bottom-0');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
    // Escape closes it.
    await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
});

it('offers no "Ask about this page" on a folder: it asks as on a screen with no item (CB-426)', async () => {
    await render('/spaces/s1/pages/f1');
    await act(async () => button().click());
    await settle();
    await settle();
    // The page's lookup says it is a folder; the panel then asks with no item.
    expect(requests.map((request) => request.url)).toEqual([
        '/api/ask/conversation?kind=page&id=f1',
        '/api/ask/conversation?kind=general&id=',
    ]);
    const box = document.querySelector<HTMLTextAreaElement>('#ask-prompt')!;
    expect(box.placeholder).toBe('Ask anything…');
    expect(document.querySelector('[data-slot="ask-context"]')!.textContent).toBe(
        'Nothing on this screen is shared. Ask anything.',
    );
    expect(dialog()!.textContent).not.toContain('this page');
});
