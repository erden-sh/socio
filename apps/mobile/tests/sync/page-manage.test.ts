import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Page, PageCover } from '@socio/shared/pages/page-library';

import type { UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { keptPage, LAST_SCREEN_KEY, pageScreen } from '../../src/shell/last-screen';
import { unsentWhy } from '../../src/shell/unsent';
import { openDrafts } from '../../src/sync/chat-drafts';
import { type Outbox, openOutbox, type SendOutcome } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { pageDraft } from '../../src/sync/page-drafts';
import {
    createLocalPages,
    createPage,
    deletePage,
    movePage,
    PAGE_MANAGE_REFUSALS,
    PAGE_MANAGE_VIEWS,
    pageManageKinds,
    PAGE_FOLDER_KIND,
    pendingFolder,
    removePageCover,
    restorePageCover,
    setPageCover,
    setPageFolder,
} from '../../src/sync/page-manage';
import { createPageSaves, PAGE_IDS, PAGE_SAVE_KIND, PAGE_SAVE_REFUSALS, pageSaveKind } from '../../src/sync/page-save';
import type { PageMove } from '../../src/sync/page-store';
import { pageBodyKey } from '../../src/sync/pages';
import type { ConfirmedChange } from '../../src/sync/snapshot-cache';

import { userDb } from './outbox-fakes';

// Creating, moving and deleting pages, and covers (src/sync/page-manage.ts) on
// a real user.db against a fake server that answers as src/server/pages's routes do: POST
// creates (title trimmed, 404 for a parent not there, 410 for a deleted one),
// move (to another Space only; 400 "already there"), soft delete (403, 409 for
// subpages without `?subpages=true`, 410 once deleted), covers and folders
// (CB-426: `folder` on create and on the PATCH, a compare-and-set on the
// revision; `legacy()` plays a server from before folders, whose strict schemas
// answer the field with 400 and whose pages carry no mark).

const directories: string[] = [];
const files: UserDb[] = [];
const outboxes: Outbox[] = [];

afterEach(async () => {
    for (const outbox of outboxes.splice(0)) {
        await outbox.dispose();
    }
    for (const file of files.splice(0)) {
        await file.db.close();
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = 'user-me';
/** The server's clock, which the device's never matches. */
const SERVER_START = Date.parse('2026-11-09T10:00:00Z');

type Stored = Page & { deleted?: boolean };

function page(id: string, change: Partial<Page> = {}): Stored {
    return {
        id,
        spaceId: 's1',
        parentId: null,
        title: 'Roadmap',
        content: 'Hello',
        revision: 3,
        createdAt: SERVER_START - 86_400_000,
        updatedAt: SERVER_START - 86_400_000,
        sourceThreadId: null,
        createdBy: ME,
        cover: null,
        sourceUrl: null,
        sourceTitle: null,
        folder: false,
        ...change,
    };
}

function pagesServer() {
    const pages = new Map<string, Stored>([['p1', page('p1')]]);
    const log: string[] = [];
    let serverNow = SERVER_START;
    let ids = 0;
    let offline = false;
    let legacy = false;
    /** Requests matching this land, then their answers are lost. */
    let lose: RegExp | null = null;
    /** Statuses the next DELETE of a page answers with, before anything happens. */
    const deleteAnswers: number[] = [];
    /** A move's copies of a page's images in the new Space (page-moves.ts rewrites their fences). */
    const fenceCopies = new Map<string, string>();
    const live = (spaceId: string) => [...pages.values()].filter((p) => p.spaceId === spaceId && !p.deleted);
    const subtree = (root: Stored) => {
        const tree = [root];
        for (let at = 0; at < tree.length; at++) {
            tree.push(...live(root.spaceId).filter((p) => p.parentId === tree[at]!.id));
        }
        return tree;
    };
    const summary = ({ content: _content, sourceUrl: _url, sourceTitle: _title, ...rest }: Stored) => ({
        ...rest,
        excerpt: '',
    });
    return {
        pages,
        log,
        deleteAnswers,
        fenceCopies,
        offline(on: boolean) {
            offline = on;
        },
        /** A server from before folders. */
        legacy() {
            legacy = true;
            for (const [id, { folder: _, ...rest }] of pages) {
                pages.set(id, rest as Stored);
            }
        },
        loseAnswers(match: RegExp | null) {
            lose = match;
        },
        tick(ms: number) {
            serverNow += ms;
        },
        /** Someone else adds a page. */
        add(id: string, change: Partial<Page>) {
            pages.set(id, page(id, { createdAt: serverNow, updatedAt: serverNow, revision: 1, ...change }));
        },
        async handle(path: string, init: AuthedRequestInit = {}): Promise<Response> {
            const method = init.method ?? 'GET';
            log.push(`${method} ${path}`);
            if (offline) {
                throw new NetworkError(path);
            }
            const answer = this.answer(path, method, init.json as Record<string, unknown> | undefined);
            if (lose?.test(`${method} ${path}`)) {
                throw new NetworkError(path);
            }
            return answer;
        },
        answer(path: string, method: string, body: Record<string, unknown> | undefined): Response {
            serverNow += 1;
            const location = /^\/api\/pages\/([^/]+)\/location$/.exec(path);
            if (location) {
                const found = pages.get(decodeURIComponent(location[1]!));
                return found && !found.deleted ? json(200, { spaceId: found.spaceId }) : json(404);
            }
            const list = /^\/api\/spaces\/([^/]+)\/pages$/.exec(path);
            if (list) {
                const spaceId = decodeURIComponent(list[1]!);
                if (method === 'GET') {
                    return json(200, live(spaceId).map(summary));
                }
                if (legacy && body !== undefined && 'folder' in body) {
                    return json(400, { error: 'Unrecognized key: "folder"' });
                }
                const parentId = (body?.parentId as string | null) ?? null;
                if (parentId !== null) {
                    const parent = pages.get(parentId);
                    if (!parent || parent.spaceId !== spaceId) {
                        return json(404);
                    }
                    if (parent.deleted) {
                        return json(410);
                    }
                }
                ids += 1;
                const made = page(`srv-${ids}`, {
                    spaceId,
                    parentId,
                    title: String(body?.title).trim(),
                    content: String(body?.content ?? ''),
                    revision: 1,
                    createdAt: serverNow,
                    updatedAt: serverNow,
                    folder: body?.folder === true,
                });
                pages.set(made.id, made);
                return json(201, made);
            }
            const match = /^\/api\/spaces\/([^/]+)\/pages\/([^/?]+)(\/move|\/cover)?(\?subpages=true)?$/.exec(path);
            if (!match) {
                return json(404);
            }
            const spaceId = decodeURIComponent(match[1]!);
            const found = pages.get(decodeURIComponent(match[2]!));
            if (!found || found.spaceId !== spaceId) {
                return json(404);
            }
            if (found.deleted) {
                return json(410);
            }
            if (match[3] === '/move') {
                const to = String(body?.spaceId);
                if (to === spaceId) {
                    return json(400, { error: 'This page is already in that Space.' });
                }
                const tree = subtree(found);
                for (const item of tree) {
                    pages.set(item.id, {
                        ...item,
                        spaceId: to,
                        parentId: item.id === found.id ? ((body?.parentId as string | null) ?? null) : item.parentId,
                        revision: item.revision + 1,
                        content: [...fenceCopies].reduce(
                            (content, [from, copy]) => content.replaceAll(`/embeds/${from}/`, `/embeds/${copy}/`),
                            item.content,
                        ),
                    });
                }
                return json(200, { page: pages.get(found.id), moved: tree.map((item) => item.id) });
            }
            if (match[3] === '/cover') {
                if (method === 'DELETE') {
                    pages.set(found.id, { ...found, cover: null });
                    return json(200, { previous: found.cover?.id ?? null });
                }
                const id = body?.fileId ? `embed-of-${String(body.fileId)}` : String(body?.embedId);
                const next = { ...found, cover: { id, url: `/api/media/embeds/${id}/content` } };
                pages.set(found.id, next);
                return json(200, next);
            }
            if (method === 'GET') {
                return json(200, found);
            }
            if (method === 'PATCH') {
                if (legacy && body !== undefined && 'folder' in body) {
                    return json(400, { error: 'A valid page patch and expectedRevision are required.' });
                }
                if (body?.expectedRevision !== found.revision) {
                    return json(409);
                }
                const next = {
                    ...found,
                    title: body.title === undefined ? found.title : String(body.title).trim(),
                    content: body.content === undefined ? found.content : String(body.content),
                    ...(typeof body.folder === 'boolean' ? { folder: body.folder } : {}),
                    revision: found.revision + 1,
                };
                pages.set(found.id, next);
                return json(200, next);
            }
            if (method === 'DELETE') {
                const forced = deleteAnswers.shift();
                if (forced !== undefined) {
                    return json(forced);
                }
                const tree = subtree(found);
                if (tree.length > 1 && !match[4]) {
                    return json(409);
                }
                for (const item of tree) {
                    pages.set(item.id, { ...item, deleted: true });
                }
                return json(200, { deleted: tree.map((item) => item.id) });
            }
            return json(405);
        },
    };
}
type Server = ReturnType<typeof pagesServer>;

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`;

/** A fake of the uploads to Files: an upload that is ready once `ready(id)` says so. */
function fakeUploads() {
    const ready = new Map<string, string>();
    const forgotten: string[] = [];
    return {
        ready,
        forgotten,
        prepare: async (id: string): Promise<SendOutcome | null> =>
            ready.has(id) ? null : { action: 'retry', reason: 'uploading' },
        resolve: (id: string) => ready.get(id) ?? null,
        forget: async (id: string) => void forgotten.push(id),
    };
}

/** A phone: user.db, the outbox with the page save and page management kinds, the drafts and the saves. */
async function phone(server: Server, options: { now?: () => number } = {}) {
    const store = await userDb();
    directories.push(store.directory);
    const file = await store.open();
    files.push(file);
    const bodies = new Map<string, Page>([[pageBodyKey('s1', 'p1'), { ...server.pages.get('p1')! }]]);
    const confirmed: ConfirmedChange[] = [];
    const moves: PageMove[] = [];
    const rebased: { pageId: string; from: readonly number[]; revision: number }[] = [];
    const uploads = fakeUploads();
    const cache = {
        confirm: async (change: ConfirmedChange) => void confirmed.push(change),
        rows: () => new Map(),
    };
    const fetchTo: AuthedFetch = (input, init) => server.handle(input, init);
    let outboxRef: Outbox | null = null;
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            pageSaveKind({ bodies: { put: async (key, p) => void bodies.set(key, p) }, newId }),
            ...pageManageKinds({
                bodies: {
                    put: async (key, p) => void bodies.set(key, p),
                    read: async (key) => bodies.get(key) ?? null,
                },
                cache,
                uploads,
                onMoved: (move) => moves.push(move),
                onSaved: (pageId, from, p) => rebased.push({ pageId, from, revision: p.revision }),
                holdsRow: (id) => outboxRef?.rows().some((row) => row.id === id) ?? false,
                newId,
            }),
        ],
        fetch: fetchTo,
        random: () => 0.5,
        ...(options.now ? { now: options.now } : {}),
    });
    outboxRef = outbox;
    outboxes.push(outbox);
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
    const saves = createPageSaves({
        outbox,
        drafts,
        baseOf: async (spaceId, pageId, revision) => {
            const held = bodies.get(pageBodyKey(spaceId, pageId));
            return held?.revision === revision ? held : null;
        },
        newId,
    });
    const write = { outbox, newId };
    return { file, outbox, drafts, saves, bodies, confirmed, moves, rebased, uploads, write };
}

const settled = (outbox: Outbox) =>
    vi.waitFor(() => expect(outbox.rows()).toEqual([]), { timeout: 8_000, interval: 20 });
const requests = (server: Server, method: string) => server.log.filter((line) => line.startsWith(`${method} `));

describe('creating pages', () => {
    it('a create sends once, resolves its local id and hands the page off; a queued edit folds into it', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const { localId } = await createPage({
            ...p.write,
            spaceId: 's1',
            title: '  ',
            createdBy: ME,
            serverAt: SERVER_START,
            known: ['p1'],
        });
        expect(localId).toMatch(/^local-page-/);
        const shown = overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_MANAGE_VIEWS, scope: p.outbox });
        expect(shown[0]).toMatchObject({ key: localId, mode: 'insert', value: { title: 'Untitled page' } });
        // The editor's first words fold into the create while it waits.
        const start = { spaceId: 's1', revision: 1, title: 'Untitled page', content: '' };
        expect(await p.saves.savePage(localId, { ...start, content: 'First' })).toBe('folded');
        p.outbox.start();
        await settled(p.outbox);
        expect(requests(server, 'POST')).toEqual(['POST /api/spaces/s1/pages']);
        const pageId = p.outbox.resolve(PAGE_IDS, localId)!;
        expect(server.pages.get(pageId)).toMatchObject({ title: 'Untitled page', content: 'First', revision: 1 });
        expect(p.bodies.get(pageBodyKey('s1', pageId))).toMatchObject({ content: 'First' });
        expect(p.confirmed).toContainEqual(expect.objectContaining({ scope: 's1', key: pageId, version: 1 }));

        // An edit under either id afterwards is a PATCH of the server's page at revision 1.
        expect(await p.saves.savePage(localId, { ...start, content: 'First, then more' })).toBe('queued');
        await settled(p.outbox);
        expect(server.pages.get(pageId)).toMatchObject({ content: 'First, then more', revision: 2 });
        expect(p.outbox.unsent()).toEqual([]);
    });

    it('two "Untitled page" creates whose answers were lost are told apart by content, the clock 10 minutes off either way', async () => {
        for (const skew of [-600_000, 600_000]) {
            const server = pagesServer();
            const p = await phone(server, { now: () => Date.now() + skew });
            server.loseAnswers(/^POST /);
            const made = [];
            for (const content of ['Alpha', 'Beta']) {
                made.push(
                    await createPage({
                        ...p.write,
                        spaceId: 's1',
                        content,
                        createdBy: ME,
                        serverAt: SERVER_START,
                        known: ['p1'],
                    }),
                );
            }
            p.outbox.start();
            await vi.waitFor(() => expect(requests(server, 'POST')).toHaveLength(2), { timeout: 5_000 });
            server.loseAnswers(null);
            await settled(p.outbox);
            // Each was created exactly once, and each local id names its own page.
            console.log(JSON.stringify(server.log), JSON.stringify(p.outbox.unsent()));
            expect(requests(server, 'POST')).toHaveLength(2);
            const [alpha, beta] = made.map(({ localId }) => server.pages.get(p.outbox.resolve(PAGE_IDS, localId)!));
            expect(alpha).toMatchObject({ content: 'Alpha' });
            expect(beta).toMatchObject({ content: 'Beta' });
            expect(p.outbox.unsent()).toEqual([]);
        }
    });

    it('two pages just like it are "Couldn’t confirm this was sent"; none after no answer goes again', async () => {
        const server = pagesServer();
        const p = await phone(server);
        // Someone else's identical page appears after the person's create was lost.
        server.loseAnswers(/^POST /);
        const { localId } = await createPage({
            ...p.write,
            spaceId: 's1',
            title: 'Notes',
            createdBy: ME,
            serverAt: SERVER_START,
            known: ['p1'],
        });
        server.add('twin', { title: 'Notes', content: '', createdBy: ME });
        p.outbox.start();
        await vi.waitFor(() => expect(p.outbox.holds()).toHaveLength(1), { timeout: 5_000 });
        expect(p.outbox.holds()[0]!.root).toMatchObject({ id: localId, cause: 'unconfirmed' });
        expect([...p.outbox.holds()[0]!.root.candidates!].sort()).toEqual(['srv-1', 'twin']);
        expect(requests(server, 'POST')).toHaveLength(1);

        // Nothing landed at all: the check finds none and it goes again, once.
        const other = await phone(server);
        server.offline(true);
        const second = await createPage({
            ...other.write,
            spaceId: 's1',
            title: 'Fresh',
            createdBy: ME,
            serverAt: SERVER_START,
            known: [...server.pages.keys()],
        });
        other.outbox.start();
        await vi.waitFor(() => expect(requests(server, 'POST')).toHaveLength(2), { timeout: 5_000 });
        server.offline(false);
        server.loseAnswers(null);
        await settled(other.outbox);
        expect([...server.pages.values()].filter((item) => item.title === 'Fresh')).toHaveLength(1);
        expect(other.outbox.resolve(PAGE_IDS, second.localId)).not.toBeNull();
    });

    it('a child made under an offline parent waits for it and is created under its server id', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const parent = await createPage({
            ...p.write,
            spaceId: 's1',
            title: 'Parent',
            createdBy: ME,
            serverAt: null,
            known: [],
        });
        const child = await createPage({
            ...p.write,
            spaceId: 's1',
            parentId: parent.localId,
            title: 'Child',
            createdBy: ME,
            serverAt: null,
            known: [],
        });
        expect(child.row.dependsOn).toBe(parent.localId);
        p.outbox.start();
        await settled(p.outbox);
        const parentId = p.outbox.resolve(PAGE_IDS, parent.localId)!;
        expect(server.pages.get(p.outbox.resolve(PAGE_IDS, child.localId)!)).toMatchObject({ parentId });

        // A parent the server deleted meanwhile refuses the child with words.
        server.pages.set(parentId, { ...server.pages.get(parentId)!, deleted: true });
        await createPage({
            ...p.write,
            spaceId: 's1',
            parentId,
            title: 'Late',
            createdBy: ME,
            serverAt: null,
            known: [],
        });
        await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
        expect(unsentWhy(p.outbox.unsent()[0]!.reason)).toBe('Its parent page was deleted');
    });

    it('re-keys the editor draft and the last screen once the create resolves, also after a kill', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const values = new Map<string, string>();
        const viewState = {
            get: (key: string) => values.get(key) ?? null,
            set: (key: string, value: string) => void values.set(key, value),
        };
        const local = createLocalPages({ outbox: p.outbox, drafts: p.drafts, viewState });
        const heard: [string, string][] = [];
        local.subscribe((from, to) => heard.push([from, to]));
        const { localId } = await createPage({ ...p.write, spaceId: 's1', createdBy: ME, serverAt: null, known: [] });
        values.set(LAST_SCREEN_KEY, pageScreen('s1', localId));
        p.drafts.write(pageDraft(localId), '{"v":1}');
        p.outbox.start();
        await settled(p.outbox);
        const pageId = p.outbox.resolve(PAGE_IDS, localId)!;
        await vi.waitFor(() => expect(heard).toEqual([[localId, pageId]]));
        expect(keptPage(values.get(LAST_SCREEN_KEY))).toEqual({ spaceId: 's1', pageId });
        expect(p.drafts.read(pageDraft(pageId)).text).toBe('{"v":1}');
        expect(local.resolve(localId)).toBe(pageId);
        local.dispose();

        // A kill between the settle and the moves: the next open makes them.
        values.set(LAST_SCREEN_KEY, pageScreen('s1', localId));
        const again = createLocalPages({ outbox: p.outbox, drafts: p.drafts, viewState });
        expect(keptPage(values.get(LAST_SCREEN_KEY))).toEqual({ spaceId: 's1', pageId });
        again.dispose();
    });
});

describe('moving and deleting pages', () => {
    it('a move lands, follows the page, and a save queued behind it needs no 409', async () => {
        const server = pagesServer();
        const p = await phone(server);
        await movePage({ ...p.write, spaceId: 's1', pageId: 'p1', to: 's2' });
        expect(overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_MANAGE_VIEWS, scope: p.outbox })[0]?.value).toEqual({
            spaceId: 's2',
            parentId: null,
        });
        const start = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'Hello' };
        expect(await p.saves.savePage('p1', { ...start, content: 'Hello there' })).toBe('queued');
        p.outbox.start();
        await settled(p.outbox);
        expect(server.log.filter((line) => !line.startsWith('GET'))).toEqual([
            'POST /api/spaces/s1/pages/p1/move',
            'PATCH /api/spaces/s2/pages/p1',
        ]);
        expect(server.pages.get('p1')).toMatchObject({ spaceId: 's2', content: 'Hello there', revision: 5 });
        expect(p.moves).toEqual([{ pageId: 'p1', from: 's1', to: 's2' }]);
        expect(p.rebased[0]).toEqual({ pageId: 'p1', from: [3], revision: 4 });
        expect(p.confirmed).toContainEqual({ collection: 'pages', scope: 's1', key: 'p1', deleted: true });
    });

    it('a move that rewrote image fences rebases no editor: its next save never puts the old images back', async () => {
        const server = pagesServer();
        const fence = (id: string) => `![chart](/api/media/embeds/${id}/content)`;
        server.pages.set('p1', page('p1', { content: fence('e1') }));
        server.fenceCopies.set('e1', 'e1-copy');
        const p = await phone(server);
        await movePage({ ...p.write, spaceId: 's1', pageId: 'p1', to: 's2' });
        p.outbox.start();
        await settled(p.outbox);
        expect(server.pages.get('p1')).toMatchObject({ spaceId: 's2', revision: 4, content: fence('e1-copy') });
        expect(p.rebased).toEqual([]);

        // The editor stayed on revision 3, with the old fence: its save meets a 409, not the move's revision.
        const start = { spaceId: 's1', revision: 3, title: 'Roadmap', content: fence('e1') };
        expect(await p.saves.savePage('p1', { ...start, content: `${fence('e1')} and more` })).toBe('queued');
        await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 8_000, interval: 20 });
        expect(server.pages.get('p1')).toMatchObject({ revision: 4, content: fence('e1-copy') });
    });

    it('a phone-made page moved under a phone-made parent waits while the parent’s create is on its way', async () => {
        const server = pagesServer();
        const p = await phone(server);
        // The parent's create is slow to answer: the child's create and its move get there first.
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const handle = server.handle.bind(server);
        server.handle = async (path, init) => {
            if (path === '/api/spaces/s2/pages' && init?.method === 'POST') {
                await gate;
            }
            return handle(path, init);
        };
        const base = { ...p.write, createdBy: ME, serverAt: null, known: [] };
        const parent = await createPage({ ...base, spaceId: 's2', title: 'Parent' });
        const child = await createPage({ ...base, spaceId: 's1', title: 'Child' });
        const move = await movePage({
            ...p.write,
            spaceId: 's1',
            pageId: child.localId,
            to: 's2',
            parentId: parent.localId,
        });
        p.outbox.start();
        await vi.waitFor(
            () => expect(p.outbox.rows().find((row) => row.id === move.id)?.lastError).toBe('waiting-parent'),
            {
                timeout: 5_000,
            },
        );
        expect(p.outbox.unsent()).toEqual([]);
        release();
        await settled(p.outbox);
        expect(p.outbox.unsent()).toEqual([]);
        const parentId = p.outbox.resolve(PAGE_IDS, parent.localId)!;
        expect(server.pages.get(p.outbox.resolve(PAGE_IDS, child.localId)!)).toMatchObject({ spaceId: 's2', parentId });
    });

    it('a move under a phone-made parent whose create was refused goes to Unsent', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const base = { ...p.write, createdBy: ME, serverAt: null, known: [] };
        // The parent goes under a page the server doesn't have: its create is refused (404).
        const parent = await createPage({ ...base, spaceId: 's2', parentId: 'ghost', title: 'Parent' });
        const child = await createPage({ ...base, spaceId: 's1', title: 'Child' });
        await movePage({ ...p.write, spaceId: 's1', pageId: child.localId, to: 's2', parentId: parent.localId });
        p.outbox.start();
        await vi.waitFor(() => expect(p.outbox.unsent().map((write) => write.reason)).toHaveLength(2), {
            timeout: 5_000,
        });
        expect(p.outbox.unsent().map((write) => write.reason)).toContain(PAGE_MANAGE_REFUSALS.noParent);
        expect(server.log.filter((line) => line.endsWith('/move'))).toEqual([]);
    });

    it('a lost move is done when the page is already there; one moved elsewhere goes from there', async () => {
        const server = pagesServer();
        const p = await phone(server);
        server.loseAnswers(/move$/);
        await movePage({ ...p.write, spaceId: 's1', pageId: 'p1', to: 's2' });
        p.outbox.start();
        await vi.waitFor(() => expect(requests(server, 'POST')).toHaveLength(1), { timeout: 5_000 });
        server.loseAnswers(null);
        await settled(p.outbox);
        expect(server.log).toContain('GET /api/pages/p1/location');
        expect(p.outbox.unsent()).toEqual([]);

        // Someone moved it to s3 first: the move goes from s3.
        server.pages.set('p1', { ...server.pages.get('p1')!, spaceId: 's3' });
        await movePage({ ...p.write, spaceId: 's2', pageId: 'p1', to: 's4' });
        await settled(p.outbox);
        expect(server.pages.get('p1')).toMatchObject({ spaceId: 's4' });
    });

    it('a delete queued behind a save goes after it; 410 is done', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const start = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'Hello' };
        await p.saves.savePage('p1', { ...start, content: 'Last words' });
        await deletePage({ ...p.write, uploads: p.uploads, drafts: p.drafts, spaceId: 's1', pageId: 'p1' });
        expect(p.outbox.rows().map((row) => row.kind)).toEqual([PAGE_SAVE_KIND, 'page-delete']);
        p.outbox.start();
        await settled(p.outbox);
        expect(server.log.filter((line) => !line.startsWith('GET'))).toEqual([
            'PATCH /api/spaces/s1/pages/p1',
            'DELETE /api/spaces/s1/pages/p1',
        ]);
        expect(server.pages.get('p1')).toMatchObject({ deleted: true, content: 'Last words' });
        expect(p.confirmed).toContainEqual({ collection: 'pages', scope: 's1', key: 'p1', deleted: true });

        await deletePage({ ...p.write, uploads: p.uploads, drafts: p.drafts, spaceId: 's1', pageId: 'p1' });
        await settled(p.outbox);
        expect(p.outbox.unsent()).toEqual([]);
    });

    it('a page whose create hasn’t gone is dropped with its writes, and nothing is sent', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const base = { ...p.write, createdBy: ME, serverAt: null, known: [] };
        const made = await createPage({ ...base, spaceId: 's1', title: 'Draft page' });
        await setPageCover({
            ...p.write,
            uploads: p.uploads,
            spaceId: 's1',
            pageId: made.localId,
            current: null,
            uploadId: 'u1',
        });
        await movePage({ ...p.write, spaceId: 's1', pageId: made.localId, to: 's2' });
        // The editor's draft of it: nothing would ever save it once the page is dropped.
        p.drafts.write(pageDraft(made.localId), '{"v":1,"spaceId":"s1","revision":1,"title":"T","content":"typed"}');
        expect(p.outbox.rows()).toHaveLength(3);
        expect(
            await deletePage({ ...p.write, uploads: p.uploads, drafts: p.drafts, spaceId: 's1', pageId: made.localId }),
        ).toBeNull();
        expect(p.outbox.rows()).toEqual([]);
        expect(p.drafts.read(pageDraft(made.localId)).text).toBe('');
        expect(p.uploads.forgotten).toEqual(['u1']);
        p.outbox.start();
        await p.outbox.idle();
        expect(server.log).toEqual([]);
    });

    it('a page with a subpage made under it is queued as a delete, and nothing is dropped', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const base = { ...p.write, createdBy: ME, serverAt: null, known: [] };
        const parent = await createPage({ ...base, spaceId: 's1', title: 'Parent' });
        const child = await createPage({ ...base, spaceId: 's1', parentId: parent.localId, title: 'Child' });
        const behind = await deletePage({
            ...p.write,
            uploads: p.uploads,
            drafts: p.drafts,
            spaceId: 's1',
            pageId: parent.localId,
            subpages: [child.localId],
        });
        expect(behind).not.toBeNull();
        expect(p.outbox.rows().map((row) => row.id)).toEqual([parent.localId, child.localId, behind!.id]);
    });

    it('a page whose create is already on its way is created, then deleted', async () => {
        const server = pagesServer();
        const p = await phone(server);
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const handle = server.handle.bind(server);
        let posted = false;
        server.handle = async (path, init) => {
            if (init?.method === 'POST') {
                posted = true;
                await gate;
            }
            return handle(path, init);
        };
        const made = await createPage({ ...p.write, spaceId: 's1', createdBy: ME, serverAt: null, known: [] });
        p.outbox.start();
        await vi.waitFor(() => expect(posted).toBe(true));
        expect(
            await deletePage({ ...p.write, uploads: p.uploads, drafts: p.drafts, spaceId: 's1', pageId: made.localId }),
        ).not.toBeNull();
        release();
        await settled(p.outbox);
        expect(requests(server, 'DELETE')).toHaveLength(1);
        expect(server.pages.get(p.outbox.resolve(PAGE_IDS, made.localId)!)).toMatchObject({ deleted: true });
    });

    it('deletes the subpages the confirm named; a new one, a 409 or a 403 goes to Unsent with words', async () => {
        const server = pagesServer();
        server.add('c1', { parentId: 'p1' });
        const p = await phone(server);
        p.outbox.start();

        // The confirm named none: the list shows c1, so nothing is sent.
        await deletePage({ ...p.write, uploads: p.uploads, drafts: p.drafts, spaceId: 's1', pageId: 'p1' });
        await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
        expect(p.outbox.unsent()[0]!.reason).toBe(PAGE_MANAGE_REFUSALS.newSubpages);
        expect(unsentWhy(p.outbox.unsent()[0]!.reason)).toBe('This page has new subpages');
        expect(requests(server, 'DELETE')).toEqual([]);
        await p.outbox.discardUnsent(p.outbox.unsent()[0]!.id);

        // 409 and 403, by status.
        for (const [status, reason] of [
            [409, PAGE_MANAGE_REFUSALS.hasSubpages],
            [403, PAGE_MANAGE_REFUSALS.deleteRefused],
        ] as const) {
            server.deleteAnswers.push(status);
            await deletePage({
                ...p.write,
                uploads: p.uploads,
                drafts: p.drafts,
                spaceId: 's1',
                pageId: 'p1',
                subpages: ['c1'],
            });
            await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
            expect(p.outbox.unsent()[0]!.reason).toBe(reason);
            expect(unsentWhy(reason)).not.toBe(unsentWhy('some-unknown-code'));
            await p.outbox.discardUnsent(p.outbox.unsent()[0]!.id);
        }

        // Named: it goes with `?subpages=true`, and both are deleted.
        await deletePage({
            ...p.write,
            uploads: p.uploads,
            drafts: p.drafts,
            spaceId: 's1',
            pageId: 'p1',
            subpages: ['c1'],
        });
        await settled(p.outbox);
        expect(requests(server, 'DELETE').at(-1)).toBe('DELETE /api/spaces/s1/pages/p1?subpages=true');
        expect(server.pages.get('c1')).toMatchObject({ deleted: true });
    });
});

describe('page covers', () => {
    const current: PageCover = { id: 'old-embed', url: '/api/media/embeds/old-embed/content' };

    it('a cover picked offline waits for its upload, then goes once online', async () => {
        const server = pagesServer();
        const p = await phone(server);
        server.offline(true);
        expect(
            await setPageCover({
                ...p.write,
                uploads: p.uploads,
                spaceId: 's1',
                pageId: 'p1',
                current: null,
                uploadId: 'u1',
            }),
        ).toBe('queued');
        expect(overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_MANAGE_VIEWS, scope: p.outbox })[0]?.value).toEqual({
            coverUpload: 'u1',
        });
        p.outbox.start();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requests(server, 'PUT')).toEqual([]);
        // Online, the upload lands; the PUT follows.
        server.offline(false);
        p.uploads.ready.set('u1', 'file-1');
        p.outbox.wake();
        await settled(p.outbox);
        expect(requests(server, 'PUT')).toEqual(['PUT /api/spaces/s1/pages/p1/cover']);
        expect(server.pages.get('p1')?.cover?.id).toBe('embed-of-file-1');
        expect(p.uploads.forgotten).toEqual(['u1']);
    });

    it('a removal’s Undo while it waits sends nothing; after it went, it puts the cover back', async () => {
        const server = pagesServer();
        server.pages.set('p1', { ...server.pages.get('p1')!, cover: current });
        const p = await phone(server);
        const options = { ...p.write, uploads: p.uploads, spaceId: 's1', pageId: 'p1', current };
        expect(await removePageCover(options)).toBe('queued');
        expect(await restorePageCover({ ...options, embedId: current.id })).toBe('removed');
        expect(p.outbox.rows()).toEqual([]);

        p.outbox.start();
        await removePageCover(options);
        await settled(p.outbox);
        expect(server.pages.get('p1')?.cover).toBeNull();
        await restorePageCover({ ...options, current: null, embedId: current.id });
        await settled(p.outbox);
        expect(server.pages.get('p1')?.cover?.id).toBe('old-embed');
        expect(requests(server, 'DELETE')).toHaveLength(1);
        expect(p.outbox.unsent()).toEqual([]);
    });

    it('a queued cover upload replaced by a newer change, or by an Undo, is forgotten', async () => {
        const server = pagesServer();
        server.pages.set('p1', { ...server.pages.get('p1')!, cover: current });
        const p = await phone(server);
        const options = { ...p.write, uploads: p.uploads, spaceId: 's1', pageId: 'p1', current };
        expect(await setPageCover({ ...options, uploadId: 'u1' })).toBe('queued');
        // The same image again changes nothing.
        expect(await setPageCover({ ...options, uploadId: 'u1' })).toBe('folded');
        expect(p.uploads.forgotten).toEqual([]);
        // Another image replaces it.
        expect(await setPageCover({ ...options, uploadId: 'u2' })).toBe('folded');
        expect(p.uploads.forgotten).toEqual(['u1']);
        // Then a removal, and its Undo: no image of them is ever the cover.
        expect(await removePageCover(options)).toBe('folded');
        expect(p.uploads.forgotten).toEqual(['u1', 'u2']);
        expect(await restorePageCover({ ...options, embedId: current.id })).toBe('removed');
        expect(p.outbox.rows()).toEqual([]);
        expect(p.uploads.forgotten).toEqual(['u1', 'u2']);
    });

    it('a page deleted meanwhile refuses its cover with words', async () => {
        const server = pagesServer();
        server.pages.set('p1', { ...server.pages.get('p1')!, deleted: true });
        const p = await phone(server);
        p.uploads.ready.set('u2', 'file-2');
        await setPageCover({
            ...p.write,
            uploads: p.uploads,
            spaceId: 's1',
            pageId: 'p1',
            current: null,
            uploadId: 'u2',
        });
        p.outbox.start();
        await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
        expect(p.outbox.unsent()[0]!.reason).toBe(PAGE_SAVE_REFUSALS.deleted);
    });
});

describe('folders (CB-426)', () => {
    const kinds = (p: Awaited<ReturnType<typeof phone>>) => p.outbox.rows().map((row) => row.kind);

    it('a toggle made offline shows at once and goes as the mark alone, with its revision; the body stays', async () => {
        const server = pagesServer();
        const p = await phone(server);
        server.offline(true);
        expect(await setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 })).toBe(
            'queued',
        );
        expect(overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_MANAGE_VIEWS, scope: p.outbox })[0]).toMatchObject({
            key: 'p1',
            mode: 'patch',
            value: { folder: true, excerpt: '' },
        });
        expect(pendingFolder(p.outbox, 'p1')).toBe(true);
        p.outbox.start();
        await vi.waitFor(() => expect(requests(server, 'PATCH')).toHaveLength(1), { timeout: 5_000 });
        server.offline(false);
        p.outbox.wake();
        await settled(p.outbox);
        expect(server.pages.get('p1')).toMatchObject({ folder: true, content: 'Hello', title: 'Roadmap', revision: 4 });
        expect(pendingFolder(p.outbox, 'p1')).toBeNull();
        // The answer goes to the body and the list; the list's summary has no excerpt of the hidden body.
        expect(p.bodies.get(pageBodyKey('s1', 'p1'))).toMatchObject({ folder: true, revision: 4 });
        expect(p.confirmed).toContainEqual(
            expect.objectContaining({
                key: 'p1',
                version: 4,
                value: expect.objectContaining({ folder: true, excerpt: '' }),
            }),
        );
        expect(p.rebased).toContainEqual({ pageId: 'p1', from: [3], revision: 4 });
    });

    it('a second toggle while one waits folds into it, and back again takes it out with nothing sent', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const toggle = (folder: boolean) =>
            setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder, revision: 3 });
        expect(await toggle(true)).toBe('queued');
        expect(await toggle(true)).toBe('folded');
        expect(kinds(p)).toEqual([PAGE_FOLDER_KIND]);
        expect(await toggle(false)).toBe('removed');
        expect(p.outbox.rows()).toEqual([]);
        p.outbox.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(requests(server, 'PATCH')).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ folder: false, revision: 3 });
    });

    it('a save queued ahead of it moves its revision: no 409, two PATCHes, the save’s text kept', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const start = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'Hello' };
        expect(await p.saves.savePage('p1', { ...start, content: 'Hello there' })).toBe('queued');
        await setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 });
        p.outbox.start();
        await settled(p.outbox);
        expect(server.log.filter((line) => !line.startsWith('GET'))).toEqual([
            'PATCH /api/spaces/s1/pages/p1',
            'PATCH /api/spaces/s1/pages/p1',
        ]);
        expect(requests(server, 'GET')).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ content: 'Hello there', folder: true, revision: 5 });
    });

    it('someone’s edit meanwhile: the 409 reads the page and the mark goes again on its revision', async () => {
        const server = pagesServer();
        const p = await phone(server);
        server.pages.set('p1', { ...server.pages.get('p1')!, content: 'Edited elsewhere', revision: 4 });
        await setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 });
        p.outbox.start();
        await settled(p.outbox);
        expect(server.log).toEqual([
            'PATCH /api/spaces/s1/pages/p1',
            'GET /api/spaces/s1/pages/p1',
            'PATCH /api/spaces/s1/pages/p1',
        ]);
        expect(server.pages.get('p1')).toMatchObject({ content: 'Edited elsewhere', folder: true, revision: 5 });
        expect(p.outbox.unsent()).toEqual([]);
    });

    it('already a folder (someone else’s toggle, or a lost answer) is done with no second PATCH', async () => {
        const server = pagesServer();
        const p = await phone(server);
        server.pages.set('p1', { ...server.pages.get('p1')!, folder: true, revision: 4 });
        await setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 });
        p.outbox.start();
        await settled(p.outbox);
        expect(requests(server, 'PATCH')).toHaveLength(1);
        expect(p.bodies.get(pageBodyKey('s1', 'p1'))).toMatchObject({ folder: true, revision: 4 });
    });

    it('a page deleted meanwhile, or a server from before folders, refuses it with words', async () => {
        const gone = pagesServer();
        gone.pages.set('p1', { ...gone.pages.get('p1')!, deleted: true });
        const p = await phone(gone);
        await setPageFolder({ ...p.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 });
        p.outbox.start();
        await vi.waitFor(() => expect(p.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
        expect(p.outbox.unsent()[0]!.reason).toBe(PAGE_SAVE_REFUSALS.deleted);

        const old = pagesServer();
        old.legacy();
        const q = await phone(old);
        await setPageFolder({ ...q.write, spaceId: 's1', pageId: 'p1', folder: true, revision: 3 });
        q.outbox.start();
        await vi.waitFor(() => expect(q.outbox.unsent()).toHaveLength(1), { timeout: 5_000 });
        expect(q.outbox.unsent()[0]!.reason).toBe(PAGE_SAVE_REFUSALS.invalid);
        expect(unsentWhy(q.outbox.unsent()[0]!.reason)).not.toBe('');
        expect(old.pages.get('p1')).toMatchObject({ revision: 3, content: 'Hello' });
    });

    it('New folder sends `folder: true` with its create; a page made on the phone takes a toggle into its create', async () => {
        const server = pagesServer();
        const p = await phone(server);
        const { localId } = await createPage({
            ...p.write,
            spaceId: 's1',
            title: 'Plans',
            content: 'Never shown',
            createdBy: ME,
            serverAt: SERVER_START,
            known: ['p1'],
            folder: true,
        });
        const shown = overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_MANAGE_VIEWS, scope: p.outbox });
        expect(shown[0]).toMatchObject({ key: localId, mode: 'insert', value: { folder: true, excerpt: '' } });
        // A plain page made on the phone, turned into a folder before its create went: one POST.
        const second = await createPage({
            ...p.write,
            spaceId: 's1',
            title: 'Archive',
            createdBy: ME,
            serverAt: SERVER_START,
            known: ['p1'],
        });
        expect(
            await setPageFolder({ ...p.write, spaceId: 's1', pageId: second.localId, folder: true, revision: 0 }),
        ).toBe('folded');
        expect(kinds(p)).toEqual(['page-create', 'page-create']);
        p.outbox.start();
        await settled(p.outbox);
        expect(requests(server, 'POST')).toHaveLength(2);
        expect(requests(server, 'PATCH')).toEqual([]);
        expect(server.pages.get(p.outbox.resolve(PAGE_IDS, localId)!)).toMatchObject({ title: 'Plans', folder: true });
        expect(server.pages.get(p.outbox.resolve(PAGE_IDS, second.localId)!)).toMatchObject({
            title: 'Archive',
            folder: true,
        });
    });

    it('a plain page’s create never names `folder`, so a server from before folders still takes it', async () => {
        const server = pagesServer();
        server.legacy();
        const p = await phone(server);
        const { localId } = await createPage({
            ...p.write,
            spaceId: 's1',
            title: 'Plain',
            createdBy: ME,
            serverAt: SERVER_START,
            known: ['p1'],
        });
        p.outbox.start();
        await settled(p.outbox);
        expect(p.outbox.unsent()).toEqual([]);
        expect(p.outbox.resolve(PAGE_IDS, localId)).not.toBeNull();
    });
});
