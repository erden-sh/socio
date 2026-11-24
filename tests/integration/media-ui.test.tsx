// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GrantView } from '@socio/shared/data-types';
import type { MediaItem, MediaListing } from '@socio/shared/media-types';
import type { Dot } from '@socio/shared/types';

import type { Shell } from '../../packages/client/src/shell/shell-context';
import { DEFAULT_DATA_LIMITS } from '../../src/server/dataspace/contract';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Uploads go through the shared raw-upload helper; the test answers them.
const upload = vi.hoisted(() => ({ uploadToFolder: vi.fn() }));
vi.mock('../../packages/client/src/modules/chat/attachments/upload', () => upload);

const { MediaPage } = await import('../../packages/client/src/modules/media/MediaPage');
const { ShellContext } = await import('../../packages/client/src/shell/shell-context');

const dots: Dot[] = ['Dot', 'Fulano'].map((name, index) => ({
    id: `d${index + 1}`,
    spaceId: 's1',
    spaceIds: ['s1'],
    name,
    instructions: `${name} helps.`,
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: index,
}));

const item = (extra: Partial<MediaItem>): MediaItem => ({
    id: 'f1',
    path: 'shot.png',
    name: 'shot.png',
    folder: '',
    size: 2048,
    mediaType: 'image/png',
    kind: 'image',
    createdAt: 1,
    updatedAt: 1,
    createdByDotId: null,
    dotName: null,
    attachments: [],
    ...extra,
});
const shot = item({
    attachments: [
        {
            id: 'cbatt_a',
            threadId: 'c1',
            threadTitle: 'Garden plan',
            dotId: 'd1',
            dotName: 'Dot',
            source: 'web',
            boundAt: 2,
        },
    ],
});
const notes = item({
    id: 'f2',
    path: 'notes.md',
    name: 'notes.md',
    mediaType: 'text/markdown',
    kind: 'text',
    attachments: [
        {
            id: 'cbatt_b',
            threadId: 'gone',
            threadTitle: null,
            dotId: 'd1',
            dotName: 'Dot',
            source: 'web',
            boundAt: 2,
        },
    ],
});
const report = item({
    id: 'f3',
    path: 'q3.pdf',
    name: 'q3.pdf',
    mediaType: 'application/pdf',
    kind: 'pdf',
    createdByDotId: 'd1',
    dotName: 'Dot',
});

let calls: Array<{ method: string; path: string; body?: unknown }>;
let grants: GrantView[];
let items: MediaItem[];
const listing = (folder: string): MediaListing => ({
    folder,
    folders: folder ? [] : ['attachments/', 'dots/', 'reports/'],
    tree: ['attachments/', 'dots/', 'dots/d1/', 'reports/'],
    items: folder ? [] : items,
    usage: {
        userId: 'alice',
        datasets: 0,
        datasetBytes: 0,
        files: items.length,
        fileBytes: 6144,
        totalBytes: 512 * 1024 * 1024,
    },
    limits: { ...DEFAULT_DATA_LIMITS, fileMaxBytes: 1000 },
});

function respond(url: URL, init?: RequestInit): [number, unknown] {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    if (url.pathname === '/api/media') {
        return [200, listing(url.searchParams.get('folder') ?? '')];
    }
    if (url.pathname === '/api/media/items/f2/content') {
        return [200, '# Plan\nWater the tomatoes.'];
    }
    if (method === 'PATCH' && body?.path === 'dots/shot.png') {
        return [409, { error: 'There is a file at dots/shot.png already.' }];
    }
    if (url.pathname.startsWith('/api/media/items/')) {
        return method === 'PATCH' ? [200, { ...shot, path: body.path }] : [200, { ok: true }];
    }
    if (url.pathname === '/api/media/folders') {
        return method === 'POST' ? [201, body] : [200, { deleted: 2 }];
    }
    if (url.pathname === '/api/data/grants') {
        if (method === 'PUT') {
            grants.push({
                id: 'g2',
                dotId: body.dotId,
                dotName: dots.find((dot) => dot.id === body.dotId)!.name,
                datasetId: null,
                datasetName: null,
                folder: body.folder,
                access: body.access,
                createdBy: 'alice',
                createdAt: 3,
            });
        }
        return [200, grants];
    }
    if (url.pathname.startsWith('/api/data/grants/')) {
        grants = grants.filter((grant) => !url.pathname.endsWith(grant.id));
        return [200, { ok: true }];
    }
    return [404, { error: 'Not found.' }];
}

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => {
    calls = [];
    items = [shot, notes, report];
    grants = [
        {
            id: 'g1',
            dotId: 'd1',
            dotName: 'Dot',
            datasetId: null,
            datasetName: null,
            folder: 'reports/',
            access: 'read',
            createdBy: 'alice',
            createdAt: 1,
        },
    ];
    upload.uploadToFolder.mockReset();
    upload.uploadToFolder.mockImplementation(async (file: File) => ({
        item: item({ name: file.name }),
    }));
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
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
async function open(path = '/media') {
    const shell = { workspace: { dots } } as unknown as Shell;
    const router = createMemoryRouter(
        [
            {
                path: '/media',
                element: (
                    <ShellContext.Provider value={shell}>
                        <MediaPage />
                    </ShellContext.Provider>
                ),
            },
            { path: '/chats/:id', element: <p>A chat</p> },
        ],
        { initialEntries: [path] },
    );
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="media-grid"], [data-slot="media-empty"]'), 'the files');
    return router;
}
const text = () => document.body.textContent ?? '';
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLElement>('button, a')].find(
        (element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name,
    );
const click = (element: Element | undefined) =>
    act(() => {
        (element as HTMLElement).click();
    });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    act(() => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    });
}
const listed = () =>
    calls.filter(
        (call) => call.path.startsWith('/api/media') && call.method === 'GET' && !call.path.includes('/items/'),
    );

it('browses folders, filters by kind and shows where each file came from', async () => {
    const router = await open();
    // The tree: chat attachments, the Dots' folders by name, the user's own.
    const tree = host.querySelector('[data-slot="media-folders"]')!;
    expect([...tree.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual([
        'All files',
        'Chat attachments',
        'Socios',
        'reports',
    ]);
    const cards = [...host.querySelectorAll('[data-slot="media-card"]')];
    expect(cards.map((card) => card.getAttribute('data-kind'))).toEqual(['image', 'text', 'pdf']);
    // Images are the original, loaded lazily; others get a type icon.
    const image = cards[0].querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/media/items/f1/content');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(cards[2].querySelector('img')).toBeNull();
    expect(cards[2].querySelector('svg')).not.toBeNull();
    expect(text()).toContain('512.0 MB of 1024.0 MB used (50%)');

    click(button('Images'));
    await until(() => listed().some((call) => call.path === '/api/media?kind=image'), 'the kind filter');
    expect(router.state.location.search).toBe('?kind=image');

    click(button('List'));
    await until(() => !!host.querySelector('[data-slot="media-list"]'), 'the list');
    const from = host.querySelector<HTMLAnchorElement>('[data-slot="media-from"]')!;
    expect(from.textContent).toBe('Garden plan · Dot');
    expect(from.getAttribute('href')).toBe('/chats/c1');
    expect(text()).toContain('A deleted conversation');
    expect(host.querySelector('[data-item="q3.pdf"]')!.textContent).toContain('Dot');

    // Into a folder: by the tree, with breadcrumbs back out.
    expect(tree.querySelector('[data-folder="dots/d1/"]')).toBeNull();
    click(tree.querySelector('[data-folder="dots/"]')!);
    await until(() => router.state.location.search.includes('folder=dots%2F'), 'the Dots folder');
    await until(
        () =>
            !!host.querySelector('[data-folder="dots/d1/"]') &&
            host.querySelector('[data-folder="dots/d1/"]')!.textContent === 'Dot',
        'the Dot’s folder by name',
    );
    click(host.querySelector('[data-folder="dots/d1/"]')!);
    await until(
        () => host.querySelector('[data-slot="media-crumbs"]')!.textContent === 'All filesSociosDot',
        'the breadcrumbs',
    );
    await until(() => text().includes('Nothing matches.'), 'an empty folder');
});

it('previews by kind and moves, renames and deletes a file', async () => {
    await open();
    // Text: the start of the file in a <pre>.
    click(button('Open notes.md'));
    await until(
        () =>
            dialog()?.querySelector('[data-slot="media-text-preview"]')?.textContent?.includes('Water the tomatoes.') ??
            false,
        'the text preview',
    );
    expect(dialog().textContent).toContain('A deleted conversation');
    click(button('Close', dialog()));
    // PDF: details and a download.
    click(button('Open q3.pdf'));
    await until(() => !!dialog(), 'the preview');
    expect(dialog().textContent).toContain('No preview for this file.');
    expect(button('Download', dialog())!.getAttribute('href')).toBe('/api/media/items/f3/content?download=1');
    click(button('Close', dialog()));
    // Image: full size, then moved into a folder under a new name.
    click(button('Open shot.png'));
    await until(() => !!dialog(), 'the image preview');
    expect(dialog().querySelector('img')!.getAttribute('src')).toBe('/api/media/items/f1/content');
    click(button('Move or rename', dialog()));
    await until(() => !!document.querySelector('[data-slot="media-move-dialog"]'), 'the move dialog');
    change(dialog().querySelector<HTMLSelectElement>('select[aria-label="Folder"]')!, 'reports/');
    const name = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    change(name, '../bad');
    expect(dialog().textContent).toContain('Use letters, digits');
    expect((button('Move', dialog()) as HTMLButtonElement).disabled).toBe(true);
    change(name, 'login.png');
    const before = listed().length;
    await act(async () => {
        (button('Move', dialog()) as HTMLButtonElement).click();
    });
    await until(() => calls.some((call) => call.method === 'PATCH'), 'the move');
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
        path: '/api/media/items/f1',
        body: { path: 'reports/login.png' },
    });
    await until(() => listed().length > before, 'the reload');

    // Deleting warns that conversations show it as removed.
    click(button('Open shot.png'));
    await until(() => !!dialog(), 'the preview');
    click(button('Delete', dialog()));
    await until(() => !!document.querySelector('[data-slot="media-confirm-delete"]'), 'the confirmation');
    const confirm = document.querySelector<HTMLElement>('[data-slot="media-confirm-delete"]')!;
    expect(confirm.textContent).toContain('It was attached in a conversation, which will show it as removed.');
    // CB-64: deletes are kept; the dialog never claims permanence.
    expect(confirm.textContent).toContain('It’s removed from your files.');
    expect(confirm.textContent).not.toContain('for good');
    await act(async () => button('Delete', confirm)!.click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the delete');
    expect(calls.find((call) => call.method === 'DELETE')!.path).toBe('/api/media/items/f1');
});

it('uploads by picker, drop and paste into the open folder, refusing files too large', async () => {
    vi.spyOn(toast, 'success').mockReturnValue(1);
    const error = vi.spyOn(toast, 'error').mockReturnValue(1);
    await open('/media?folder=reports/');
    const page = host.querySelector('[data-slot="media-page"]')!;
    const small = (name: string) => new File(['hello'], name);

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Upload files"]')!;
    Object.defineProperty(input, 'files', {
        value: [small('a.txt'), new File([new Uint8Array(2000)], 'big.bin')],
        configurable: true,
    });
    await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => upload.uploadToFolder.mock.calls.length === 1, 'upload');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('big.bin: files can be at most'));
    expect(upload.uploadToFolder.mock.calls[0][0].name).toBe('a.txt');
    expect(upload.uploadToFolder.mock.calls[0][1]).toBe('reports/');

    // Dropped anywhere on the page, with a drop zone while dragging.
    const drag = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: { files: [small('b.md')], types: ['Files'] },
        });
        page.dispatchEvent(event);
        return event;
    };
    act(() => void drag('dragover'));
    expect(host.querySelector('[data-slot="media-drop"]')!.textContent).toBe('Drop to upload into reports');
    await act(async () => {
        expect(drag('drop').defaultPrevented).toBe(true);
    });
    await until(() => upload.uploadToFolder.mock.calls.length === 2, 'drop');
    expect(host.querySelector('[data-slot="media-drop"]')).toBeNull();

    // Pasted: a screenshot gets a name; pasted text is left alone.
    const paste = (files: File[]) => {
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
            value: {
                items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
            },
        });
        document.body.dispatchEvent(event);
        return event;
    };
    await act(async () => {
        expect(paste([]).defaultPrevented).toBe(false);
        expect(paste([new File(['x'], 'image.png', { type: 'image/png' })]).defaultPrevented).toBe(true);
    });
    await until(() => upload.uploadToFolder.mock.calls.length === 3, 'paste');
    expect(upload.uploadToFolder.mock.calls[2][0].name).toBe('image.png');
});

it('makes a new folder, and gives and takes Dot access to one', async () => {
    const router = await open('/media?folder=reports/');
    click(button('New folder'));
    await until(() => !!dialog(), 'the new folder dialog');
    expect(dialog().querySelector<HTMLSelectElement>('select[aria-label="Folder"]')!.value).toBe('reports/');
    change(dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'Q4');
    await act(async () => button('Create', dialog())!.click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the new folder');
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        path: '/api/media/folders',
        body: { path: 'reports/Q4/' },
    });
    await until(() => router.state.location.search === '?folder=reports%2FQ4%2F', 'the new folder opened');

    // Dot access on reports/: its grant, one more, then one fewer.
    act(() => void router.navigate('/media?folder=reports/'));
    await until(() => !!button('Folder actions'), 'the folder menu');
    const trigger = button('Folder actions')!;
    act(() => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => !!document.querySelector('[role="menuitem"]'), 'the menu items');
    const access = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === 'Socio access',
    )!;
    act(() => access.click());
    await until(() => !!document.querySelector('[data-grant="Dot"]'), 'the folder’s grants');
    const panel = document.querySelector<HTMLElement>('[data-slot="media-folder-access"]')!;
    // Only Dots without a grant here can be given one.
    const pickDot = panel.querySelector<HTMLSelectElement>('select[aria-label="Socio"]')!;
    expect([...pickDot.options].map((option) => option.textContent)).toEqual(['Give a socio access…', 'Fulano']);
    change(pickDot, 'd2');
    change(panel.querySelector<HTMLSelectElement>('select[aria-label="Access"]')!, 'write');
    await act(async () => button('Grant', panel)!.click());
    await until(() => !!document.querySelector('[data-grant="Fulano"]'), 'the new grant');
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/api/data/grants',
        body: { dotId: 'd2', folder: 'reports/', access: 'write' },
    });
    await act(async () => button('Remove', document.querySelector('[data-grant="Dot"]')!)!.click());
    await until(() => !document.querySelector('[data-grant="Dot"]'), 'the grant removed');
    expect(calls.find((call) => call.method === 'DELETE')!.path).toBe('/api/data/grants/g1');
});

it('moves files and folders by dragging them onto a folder, with Undo (CB-255)', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(1);
    const error = vi.spyOn(toast, 'error').mockReturnValue(1);
    await open();
    const grid = host.querySelector<HTMLElement>('[data-slot="media-grid"]')!;
    const tree = host.querySelector<HTMLElement>('[data-slot="media-folders"]')!;
    const crumbs = host.querySelector<HTMLElement>('[data-slot="media-crumbs"]')!;
    const target = (within: HTMLElement, folder: string) =>
        within.querySelector<HTMLElement>(`[data-drop-folder="${folder}"]`)!;
    // What the browser hands each drag event; only a drag from this page
    // carries the Media type.
    let transfer: { types: string[] };
    const fire = (element: Element, type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        act(() => void element.dispatchEvent(event));
        return event;
    };
    const start = async (element: Element) => {
        transfer = {
            types: [],
            setData(type: string) {
                this.types.push(type);
            },
        } as { types: string[] };
        fire(element, 'dragstart');
        await until(() => !!host.querySelector('[data-slot="media-moving"]'), 'the drag');
    };
    const patches = () => calls.filter((call) => call.method === 'PATCH');
    const card = (name: string) => button(`Open ${name}`, grid)!;

    // A file: the folders it can go to show it; where it is takes nothing.
    await start(card('shot.png'));
    expect(host.querySelector('[data-slot="media-moving"]')!.textContent).toContain('Moving shot.png');
    expect(fire(target(tree, ''), 'dragover').defaultPrevented).toBe(false);
    expect(fire(target(crumbs, ''), 'dragover').defaultPrevented).toBe(false);
    expect(target(tree, 'reports/').className).toContain('outline-dashed');
    expect(fire(target(grid, 'reports/'), 'dragover').defaultPrevented).toBe(true);
    expect(target(grid, 'reports/').className).toContain('ring-2');
    expect(fire(target(grid, 'reports/'), 'drop').defaultPrevented).toBe(true);
    await until(() => patches().length === 1, 'the move');
    expect(patches()[0]).toMatchObject({
        path: '/api/media/items/f1',
        body: { path: 'reports/shot.png' },
    });
    expect(host.querySelector('[data-slot="media-moving"]')).toBeNull();
    await until(() => success.mock.calls.length === 1, 'the toast');
    const [said, options] = success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(said).toBe('Moved shot.png to reports.');
    expect(options.action.label).toBe('Undo');
    // Undo moves it back where it was.
    await act(async () => options.action.onClick());
    await until(() => patches().length === 2, 'the undo');
    expect(patches()[1].body).toEqual({ path: 'shot.png' });
    await until(() => success.mock.calls.some(([text]) => text === 'Moved shot.png back.'), 'the undo toast');

    // A name taken where it lands: refused, and said so.
    await start(card('shot.png'));
    fire(target(grid, 'dots/'), 'dragover');
    fire(target(grid, 'dots/'), 'drop');
    await until(() => error.mock.calls.length === 1, 'the clash');
    expect(error).toHaveBeenCalledWith('There is a file at dots/shot.png already.');

    // A folder: not into itself; Socios and its own folders don't drag.
    expect(target(grid, 'dots/').getAttribute('draggable')).toBeNull();
    expect(target(grid, 'reports/').getAttribute('draggable')).toBe('true');
    await start(target(grid, 'reports/'));
    expect(fire(target(grid, 'reports/'), 'dragover').defaultPrevented).toBe(false);
    expect(fire(target(tree, 'dots/'), 'dragover').defaultPrevented).toBe(false);
    expect(fire(target(tree, ''), 'dragover').defaultPrevented).toBe(false);
    fire(target(tree, 'attachments/'), 'dragover');
    fire(target(tree, 'attachments/'), 'drop');
    await until(() => patches().length === 4, 'the folder move');
    expect(patches()[3]).toMatchObject({
        path: '/api/media/folders',
        body: { from: 'reports/', to: 'attachments/reports/' },
    });
    // A drag let go elsewhere moves nothing.
    await start(card('notes.md'));
    fire(card('notes.md'), 'dragend');
    await until(() => !host.querySelector('[data-slot="media-moving"]'), 'the drag to end');
    expect(patches()).toHaveLength(4);
});

it('moves a folder with "Move to…" from the keyboard (CB-255)', async () => {
    vi.spyOn(toast, 'success').mockReturnValue(1);
    await open();
    // Socios and a socio's own folders keep their place: no menu.
    expect(button('More actions for Socios')).toBeUndefined();
    act(() => {
        button('More actions for reports')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
    });
    await until(() => !!document.querySelector('[role="menuitem"]'), 'the menu items');
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((entry) => entry.textContent?.trim())).toEqual(['Move to…']);
    act(() => items[0].click());
    await until(() => !!document.querySelector('[data-slot="media-move-dialog"]'), 'the move dialog');
    const pick = dialog().querySelector<HTMLSelectElement>('select[aria-label="Folder"]')!;
    // Not into itself, nor straight into Socios.
    expect([...pick.options].map((option) => option.value)).toEqual(['', 'attachments/', 'dots/d1/']);
    change(pick, 'attachments/');
    await act(async () => button('Move', dialog())!.click());
    await until(() => calls.some((call) => call.method === 'PATCH'), 'the move');
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
        path: '/api/media/folders',
        body: { from: 'reports/', to: 'attachments/reports/' },
    });
    await until(() => !document.querySelector('[data-slot="media-move-dialog"]'), 'the dialog to close');
});
