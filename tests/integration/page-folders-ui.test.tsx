// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS } from '@socio/shared/pages/page-draft';
import { pageSummary, type Page } from '@socio/shared/pages/page-library';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from '../../packages/client/tests/helpers/app-router';

// Chat isn't configured in these workspaces, so CopilotKit never renders;
// its package imports a stylesheet Node can't load.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
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
    configured: false,
};
const users = {
    alice: { id: 'alice', name: 'Alice', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users = 'alice';
const workspace = (): WorkspaceState => ({
    user: users[me],
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
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
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});
const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    content: `${title} body.`,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'bob',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    folder: false,
    ...extra,
});

// The server: the Space's pages, the folder switches and the pages created.
let pages: Page[] = [];
let switches: Array<{ id: string; folder: boolean }> = [];
let created: unknown[] = [];
// Every PATCH (the autosave), with the page's folder mark when it came.
let patches: Array<{ id: string; folder: boolean; body: Record<string, unknown> }> = [];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
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
    if (path === '/api/spaces/s1/pages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Partial<Page>;
        created.push(body);
        const made = page(`new-${created.length}`, body.title!, {
            parentId: body.parentId ?? null,
            content: '',
            folder: !!body.folder,
        });
        pages = [...pages, made];
        return [201, made];
    }
    if (path === '/api/spaces/s1/pages') {
        return [200, pages.map(pageSummary)];
    }
    const toggle = path.match(/^\/api\/spaces\/s1\/pages\/([^/]+)\/folder$/);
    if (toggle && init?.method === 'PUT') {
        const { folder } = JSON.parse(String(init.body)) as { folder: boolean };
        switches.push({ id: toggle[1]!, folder });
        pages = pages.map((item) =>
            item.id === toggle[1]
                ? { ...item, folder, revision: item.revision + 1, updatedAt: item.updatedAt + 1 }
                : item,
        );
        return [200, pages.find((item) => item.id === toggle[1])];
    }
    const one = path.match(/^\/api\/spaces\/s1\/pages\/([^/]+)$/);
    if (one) {
        const found = pages.find((item) => item.id === one[1]);
        if (found && init?.method === 'PATCH') {
            // Recorded and applied, as the server would: a stale revision is a conflict.
            const { expectedRevision, ...fields } = JSON.parse(String(init.body)) as Record<string, unknown>;
            patches.push({ id: found.id, folder: found.folder, body: { ...fields, expectedRevision } });
            if (expectedRevision !== found.revision) {
                return [409, { error: 'This page changed.' }];
            }
            const saved = { ...found, ...fields, revision: found.revision + 1, updatedAt: found.updatedAt + 1 } as Page;
            pages = pages.map((item) => (item.id === found.id ? saved : item));
            return [200, saved];
        }
        if (found) {
            return [200, found];
        }
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
    me = 'alice';
    pages = [];
    switches = [];
    created = [];
    patches = [];
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

/** Waits (in act) until `check` holds, for up to 10 s (lazy routes load slowly under load). */
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
const text = () => host.textContent ?? '';
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | undefined) =>
    act(() => {
        element!.click();
    });
/** Opens the page's ⋯ menu (a Radix menu opens on a key or a pointer). */
async function openPageMenu() {
    await until(() => !!button('Page actions'), 'the page');
    act(() => {
        button('Page actions')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => !!menuItem('Move to…'), 'the page menu');
}
const menuItem = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === name);

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

// Folders (CB-426): a page marked as a folder shows its contents instead of its body, which it keeps.

it('shows a folder’s contents instead of its body, with no editor, and says it keeps its text', async () => {
    pages = [
        page('f1', 'Projects', { folder: true, content: 'Text from when it was a page.' }),
        page('p2', 'Roadmap', { parentId: 'f1' }),
        page('f3', 'Archive', { parentId: 'f1', folder: true, content: '' }),
    ];
    await open('/spaces/s1/pages/f1');
    await until(() => !!host.querySelector('[data-slot="folder-contents"]'), 'the folder');
    const contents = host.querySelector('[data-slot="folder-contents"]')!;
    const links = [...contents.querySelectorAll('nav[aria-label="In this folder"] a')];
    expect(links.map((link) => link.textContent)).toEqual(['Roadmap', 'Archive']);
    // The folder inside has the folder icon.
    expect(links[1]!.querySelector('svg.lucide-folder')).not.toBeNull();
    expect(host.querySelector('[data-slot="folder-kept-text"]')!.textContent).toBe(
        'This folder keeps its page text. Turn it back into a page to see it.',
    );
    // No editor: neither the visual one nor the Markdown source.
    expect(host.querySelector('[data-slot="editor-loading"]')).toBeNull();
    expect(host.querySelector('[contenteditable]')).toBeNull();
    expect(host.querySelector('textarea[aria-label="Page Markdown"]')).toBeNull();
    expect(text()).not.toContain('Text from when it was a page.');
    // Its title stays editable.
    expect(host.querySelector('.document-title')).not.toBeNull();
    // An empty folder says so, with no kept-text line.
    pages = pages.map((item) => (item.id === 'f1' ? { ...item, content: '' } : item));
    await open('/spaces/s1/pages/f3');
    await until(() => text().includes('This folder is empty.'), 'the empty folder');
    expect(host.querySelector('[data-slot="folder-kept-text"]')).toBeNull();
});

it('turns a page into a folder from its menu and back, never saving over its text', async () => {
    pages = [page('p1', 'Garden plan', { content: 'Beds and paths.' })];
    await open('/spaces/s1/pages/p1');
    await openPageMenu();
    click(menuItem('Turn into folder'));
    await until(() => !!host.querySelector('[data-slot="folder-contents"]'), 'the folder view');
    expect(switches).toEqual([{ id: 'p1', folder: true }]);
    expect(host.querySelector('[data-slot="folder-kept-text"]')).not.toBeNull();
    // Renamed as a folder: past the autosave's delay, the save sends the title and never the body.
    await type(host.querySelector<HTMLTextAreaElement>('textarea.document-title')!, 'Garden');
    await until(() => patches.length === 1 && text().includes('All changes saved'), 'the title save');
    await act(() => new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 200)));
    expect(patches).toEqual([
        { id: 'p1', folder: true, body: { title: 'Garden', parentId: null, expectedRevision: 2 } },
    ]);
    await openPageMenu();
    expect(menuItem('Turn into folder')).toBeUndefined();
    expect(menuItem('Markdown source')).toBeUndefined();
    click(menuItem('Turn into page'));
    await until(() => !host.querySelector('[data-slot="folder-contents"]'), 'the page again');
    expect(switches).toEqual([
        { id: 'p1', folder: true },
        { id: 'p1', folder: false },
    ]);
    // Nothing saved after the switch back either, once the delay has passed.
    await act(() => new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 200)));
    // No save of the folder carried a body, and the page's text is as it was.
    expect(patches.filter((patch) => patch.folder && 'content' in patch.body)).toEqual([]);
    expect(pages[0]).toMatchObject({ title: 'Garden', content: 'Beds and paths.', folder: false });
});

it('makes a new folder inside a folder, named in its dialog', async () => {
    pages = [page('f1', 'Projects', { folder: true, content: '' })];
    await open('/spaces/s1/pages/f1');
    await until(() => !!host.querySelector('[data-slot="folder-contents"]'), 'the folder');
    click(button('New folder', host.querySelector('[data-slot="folder-contents"]')!));
    await until(() => !!dialog(), 'the name dialog');
    expect(button('Create folder', dialog()!)!.disabled).toBe(true);
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!, 'Designs');
    click(button('Create folder', dialog()!));
    await until(() => !dialog(), 'the dialog to close');
    expect(created).toEqual([{ title: 'Designs', content: '', parentId: 'f1', folder: true }]);
    await until(() => text().includes('Designs'), 'the new folder inside');
});
