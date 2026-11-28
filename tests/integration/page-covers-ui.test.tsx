// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { coverUrl, pageSummary, type CoverImage, type PageCover, type Page } from '@socio/shared/pages/page-library';
import type { Role, Space, State, WorkspaceState } from '@socio/shared/types';

import { coverFileProblem, PageCoverArea } from '../../packages/client/src/modules/pages/PageCover';
// The page's and the picker's words (pages, pages.cover), as the client's tests read them.
import '../../packages/client/tests/setup/en-us-i18n';
import { SpaceLibrary } from '../../packages/client/src/modules/spaces/SpaceLibrary';
import { createTestRouter } from '../../packages/client/tests/helpers/app-router';

// Page covers (CB-308): Add cover on the page's top for its editors, the
// picker's Upload and From this Space, the 200 px band with Change cover
// and Remove (Undo puts the cover back), and the library's hybrid band.

// The upload is XHR with progress (attachments/upload.ts): stood in for.
const uploads: File[] = [];
vi.mock('../../packages/client/src/modules/chat/attachments/upload', () => ({
    uploadToFolder: async (file: File, folder: string, options?: { onProgress?: (n: number) => void }) => {
        uploads.push(file);
        options?.onProgress?.(1);
        return { item: { id: `file-${uploads.length}`, path: `${folder}${file.name}` } };
    },
}));
// Chat isn't configured in these workspaces, so CopilotKit never renders.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const cover = (id: string): PageCover => ({ id, url: coverUrl(id) });
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
    createdBy: 'alice',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    folder: false,
    ...extra,
});
const spaceImages: CoverImage[] = [
    { id: 'emb-hills', url: coverUrl('emb-hills'), name: 'hills.png', mediaType: 'image/png', createdAt: 2 },
    { id: 'emb-sand', url: coverUrl('emb-sand'), name: 'sand.webp', mediaType: 'image/webp', createdAt: 1 },
];

// The server: the Space's pages, its images, and the cover requests made.
let pages: Page[] = [];
let requests: Array<{ method: string; path: string; body?: unknown }> = [];
let embedCounter = 0;
const state: State = {
    settings: { name: 'Brain', paused: false, researchAllowed: false, memoryAllowed: true },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role: 'admin' as Role },
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
    setup: { model: false, voice: false, telegram: 'not_configured', missing: ['model'] },
    calls: [],
});
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
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
    if (path === '/api/spaces/s1/cover-images') {
        return [200, spaceImages];
    }
    if (path === '/api/spaces/s1/pages') {
        return [200, pages.map(pageSummary)];
    }
    const coverRoute = path.match(/^\/api\/spaces\/s1\/pages\/([^/]+)\/cover$/);
    if (coverRoute) {
        requests.push({ method, path, body });
        const found = pages.find((item) => item.id === coverRoute[1])!;
        if (method === 'DELETE') {
            const previous = found.cover?.id ?? null;
            Object.assign(found, { cover: null, updatedAt: found.updatedAt + 1 });
            return [200, { previous }];
        }
        const choice = body as { fileId?: string; embedId?: string };
        const id = choice.embedId ?? `emb-new-${++embedCounter}`;
        Object.assign(found, { cover: cover(id), updatedAt: found.updatedAt + 1 });
        return [200, found];
    }
    const one = path.match(/^\/api\/spaces\/s1\/pages\/([^/]+)$/);
    if (one) {
        const found = pages.find((item) => item.id === one[1]);
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
    pages = [];
    requests = [];
    uploads.length = 0;
    embedCounter = 0;
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
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | null | undefined) =>
    act(() => {
        element!.click();
    });
const picker = () => document.querySelector<HTMLElement>('[data-slot="cover-picker"]');
const band = () => host.querySelector<HTMLElement>('[data-slot="page-cover"]');

function renderArea(props: Partial<Parameters<typeof PageCoverArea>[0]> = {}) {
    const changes: Array<PageCover | null> = [];
    const render = (extra: Partial<Parameters<typeof PageCoverArea>[0]> = {}) =>
        act(() =>
            root.render(
                <div className="group/page-top">
                    <PageCoverArea
                        spaceId="s1"
                        pageId="p1"
                        cover={null}
                        editable
                        onChange={(next) => changes.push(next)}
                        {...props}
                        {...extra}
                    />
                </div>,
            ),
        );
    render();
    return { changes, render };
}

it('offers Add cover to editors only, and shows readers the cover without controls', () => {
    renderArea();
    const add = button('Add cover');
    expect(add).toBeDefined();
    // Hidden until the page's top is hovered or focused; touch screens always show it.
    expect(add!.className).toContain('opacity-0');
    expect(add!.className).toContain('group-hover/page-top:opacity-100');
    expect(add!.className).toContain('group-focus-within/page-top:opacity-100');
    expect(add!.className).toContain('[@media(hover:none)]:opacity-100');

    renderArea({ editable: false });
    expect(host.textContent).toBe('');
    renderArea({ editable: false, cover: cover('emb-1') });
    expect(band()!.querySelector('img')!.getAttribute('src')).toBe('/api/media/embeds/emb-1/content');
    expect(band()!.className).toContain('h-50');
    expect(button('Change cover')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
});

it('sets a cover from the images already in the Space', async () => {
    pages = [page('p1', 'Plan')];
    const { changes } = renderArea();
    click(button('Add cover'));
    await until(() => !!picker(), 'the picker');
    expect(picker()!.textContent).toContain('Upload an image');
    expect(picker()!.textContent).toContain('or drop one here · PNG, JPEG or WebP, up to 5 MB');
    expect(picker()!.textContent).toContain('From this Space');
    // No stock photos: an upload, or the Space's own images.
    expect(picker()!.textContent).not.toMatch(/unsplash|stock/i);
    await until(() => !!button('Use hills.png'), 'the Space’s images');
    expect(button('Use sand.webp')).toBeDefined();
    click(button('Use hills.png'));
    await until(() => changes.length === 1, 'the cover');
    expect(requests).toEqual([
        { method: 'PUT', path: '/api/spaces/s1/pages/p1/cover', body: { embedId: 'emb-hills' } },
    ]);
    expect(changes).toEqual([cover('emb-hills')]);
    await until(() => !picker(), 'the picker to close');
});

it('uploads an image into the person’s Files and sets it, refusing other files first', async () => {
    pages = [page('p1', 'Plan')];
    const { changes } = renderArea();
    click(button('Add cover'));
    await until(() => !!picker(), 'the picker');
    const input = document.querySelector<HTMLInputElement>('[data-slot="cover-file"]')!;
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    const choose = (file: File) =>
        act(() => {
            Object.defineProperty(input, 'files', { value: [file], configurable: true });
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    choose(new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }));
    await until(() => !!picker()!.querySelector('[role="alert"]'), 'the type refusal');
    expect(picker()!.querySelector('[role="alert"]')!.textContent).toBe('Choose a PNG, JPEG or WebP image.');
    expect(uploads).toEqual([]);
    choose(new File([new Uint8Array(5 * 1048576 + 1)], 'huge.png', { type: 'image/png' }));
    await until(() => /at most 5 MB/.test(picker()!.textContent ?? ''), 'the size refusal');
    expect(uploads).toEqual([]);

    choose(new File([new Uint8Array(10)], 'beach.jpg', { type: 'image/jpeg' }));
    await until(() => changes.length === 1, 'the cover');
    expect(uploads.map((file) => file.name)).toEqual(['beach.jpg']);
    expect(requests).toEqual([{ method: 'PUT', path: '/api/spaces/s1/pages/p1/cover', body: { fileId: 'file-1' } }]);
    expect(changes).toEqual([cover('emb-new-1')]);
});

it('tells what a cover may be', () => {
    expect(coverFileProblem({ type: 'image/webp', size: 5 * 1048576 })).toBeUndefined();
    expect(coverFileProblem({ type: 'image/svg+xml', size: 10 })).toBe('type');
    expect(coverFileProblem({ type: 'image/gif', size: 10 })).toBe('type');
    expect(coverFileProblem({ type: 'image/png', size: 5 * 1048576 + 1 })).toBe('size');
});

it('shows an editor Change cover and Remove over the band, and a cover whose image is gone', async () => {
    pages = [page('p1', 'Plan', { cover: cover('emb-1') })];
    const { render } = renderArea({ cover: cover('emb-1') });
    expect(button('Change cover')).toBeDefined();
    expect(button('Remove')).toBeDefined();
    expect(button('Change cover')!.className).toContain('group-hover/page-top:opacity-100');
    click(button('Change cover'));
    await until(() => !!picker(), 'the picker');
    // The image's file was deleted: the editor sees why, and can change it.
    act(() => band()!.querySelector('img')!.dispatchEvent(new Event('error')));
    await until(() => /no longer available/.test(band()!.textContent ?? ''), 'the missing image');
    expect(button('Change cover')).toBeDefined();
    render({ editable: false });
    expect(host.textContent).toBe('');
});

/** Waits for the app shell at `path`. */
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}

it('removes a cover from the page with Undo, which puts the previous one back', async () => {
    pages = [page('p1', 'Garden plan', { cover: cover('emb-1') })];
    await open('/spaces/s1/pages/p1');
    await until(() => !!band(), 'the cover band');
    expect(band()!.querySelector('img')!.getAttribute('src')).toBe('/api/media/embeds/emb-1/content');
    click(button('Remove'));
    await until(() => !band(), 'the band to go');
    await until(() => /Cover removed/.test(document.body.textContent ?? ''), 'the toast');
    expect(button('Add cover')).toBeDefined();
    click(button('Undo'));
    await until(() => !!band(), 'the cover back');
    expect(requests.map(({ method, body }) => [method, body])).toEqual([
        ['DELETE', undefined],
        ['PUT', { embedId: 'emb-1' }],
    ]);
    expect(band()!.querySelector('img')!.getAttribute('src')).toBe('/api/media/embeds/emb-1/content');
});

it('adds a cover from the page’s top, and the library gets its bands', async () => {
    pages = [page('p1', 'Garden plan'), page('p2', 'Other')];
    const router = await open('/spaces/s1/pages/p1');
    await until(() => !!button('Add cover'), 'Add cover');
    // The cover and the title share the hover group.
    expect(button('Add cover')!.closest('.group\\/page-top')!.querySelector('.document-title')).not.toBeNull();
    click(button('Add cover'));
    await until(() => !!button('Use sand.webp'), 'the Space’s images');
    click(button('Use sand.webp'));
    await until(() => !!band(), 'the cover band');
    act(() => {
        void router.navigate('/spaces/s1');
    });
    await until(() => host.querySelectorAll('[data-slot="library-card-band"]').length === 2, 'the bands');
    const bands = [...host.querySelectorAll<HTMLElement>('[data-slot="library-page-card"]')].map((card) => [
        card.querySelector('h3')!.textContent,
        card.querySelector<HTMLElement>('[data-slot="library-card-band"]')!.dataset.cover,
    ]);
    expect(bands).toEqual([
        ['Garden plan', 'image'],
        ['Other', 'tile'],
    ]);
});

const summary = (id: string, title: string, extra: Partial<Page> = {}) => pageSummary(page(id, title, extra));

function renderLibrary(
    hasCovers: boolean,
    list = [summary('p1', 'Covered', { cover: cover('emb-1') }), summary('p2', 'Plain')],
) {
    act(() =>
        root.render(
            <SpaceLibrary
                space={{ id: 's1', name: 'Everyday', description: '', createdAt: 1 } as Space}
                pages={list}
                hasCovers={hasCovers}
                onPage={() => {}}
                onNew={() => {}}
                onDeleted={() => {}}
            />,
        ),
    );
}

it('gives every grid card a band in a Space with covers: its cover, or the page tile', () => {
    renderLibrary(true);
    const cards = [...host.querySelectorAll<HTMLElement>('[data-slot="library-page-card"]')];
    expect(cards).toHaveLength(2);
    const [covered, plain] = cards.map((card) => card.querySelector<HTMLElement>('[data-slot="library-card-band"]')!);
    expect(covered.className).toContain('h-30');
    expect(covered.dataset.cover).toBe('image');
    expect(covered.querySelector('img')!.getAttribute('src')).toBe('/api/media/embeds/emb-1/content');
    // The neutral band keeps the Spaces module's tone tile.
    expect(plain.dataset.cover).toBe('tile');
    expect(plain.querySelector('svg')!.parentElement!.className).toContain('text-sky-700');
    // A cover whose image fails to load falls back to the tile.
    act(() => covered.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(covered.dataset.cover).toBe('tile');
});

it('keeps compact cards in a Space without covers, and rows in the list view', () => {
    renderLibrary(false, [summary('p2', 'Plain')]);
    expect(host.querySelector('[data-slot="library-card-band"]')).toBeNull();
    renderLibrary(true);
    click(button('List view'));
    expect(host.querySelector('[data-slot="library-card-band"]')).toBeNull();
});
