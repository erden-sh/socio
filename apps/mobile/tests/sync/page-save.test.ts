import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS } from '@socio/shared/pages/page-draft';
import type { Page } from '@socio/shared/pages/page-library';

import type { UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { unsentWhy } from '../../src/shell/unsent';
import { openDrafts } from '../../src/sync/chat-drafts';
import { type Outbox, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { createPageDrafts, type EditorDraft, pageDraft } from '../../src/sync/page-drafts';
import {
    createPageSaves,
    PAGE_CREATE_KIND,
    PAGE_IDS,
    PAGE_SAVE_KIND,
    PAGE_SAVE_REFUSALS,
    PAGE_SAVE_VIEWS,
    pageLane,
    type PageSavePayload,
    pageSaveKind,
    pendingPageText,
} from '../../src/sync/page-save';
import { pageBodyKey } from '../../src/sync/pages';
import { endFakeTime, fakeTime } from '../helpers/fake-time';

import { killAt, outboxUntil, userDb } from './outbox-fakes';

// Saving a page (src/sync/page-save.ts) on a real user.db against a fake
// server whose PATCH answers as src/server/pages's does: a compare-and-set on `expectedRevision` (409), the
// title trimmed, 404 for a page not in that Space, 410 for a deleted one.

const directories: string[] = [];
const files: UserDb[] = [];
const outboxes: Outbox[] = [];

afterEach(async () => {
    endFakeTime();
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

const PAGE: Page = {
    id: 'p1',
    spaceId: 's1',
    parentId: null,
    title: 'Roadmap',
    content: 'Hello',
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'user-me',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    folder: false,
};

function pageServer() {
    const pages = new Map<string, Page & { deleted?: boolean }>([[PAGE.id, { ...PAGE }]]);
    const log: string[] = [];
    let offline = false;
    /** The next PATCH lands, then its answer is lost. */
    let loseNext = false;
    let gate: Promise<void> | null = null;
    const patched: number[] = [];
    return {
        pages,
        log,
        patched,
        offline(on: boolean) {
            offline = on;
        },
        loseNextAnswer() {
            loseNext = true;
        },
        hold(): () => void {
            let open = () => {};
            gate = new Promise((resolve) => {
                open = resolve;
            });
            return () => {
                gate = null;
                open();
            };
        },
        /** Someone else's change. */
        edit(id: string, change: Partial<Page>) {
            const page = pages.get(id)!;
            pages.set(id, { ...page, ...change, revision: page.revision + 1 });
        },
        async handle(path: string, init: AuthedRequestInit = {}): Promise<Response> {
            const method = init.method ?? 'GET';
            log.push(`${method} ${path}`);
            if (offline) {
                throw new NetworkError(path);
            }
            const location = /^\/api\/pages\/([^/]+)\/location$/.exec(path);
            if (location) {
                const page = pages.get(decodeURIComponent(location[1]!));
                return page && !page.deleted ? json(200, { spaceId: page.spaceId }) : json(404);
            }
            const match = /^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/.exec(path);
            if (!match) {
                return json(404);
            }
            const page = pages.get(decodeURIComponent(match[2]!));
            if (!page || page.spaceId !== decodeURIComponent(match[1]!)) {
                return json(404, { error: 'Page not found' });
            }
            if (page.deleted) {
                return json(410, { error: 'This page was deleted.' });
            }
            if (method === 'GET') {
                return json(200, page);
            }
            if (gate) {
                await gate;
            }
            const body = init.json as {
                title?: string;
                content?: string;
                expectedRevision: number;
                parentId?: unknown;
            };
            if ('parentId' in body) {
                throw new Error('A save never sends parentId.');
            }
            if (body.expectedRevision !== page.revision) {
                return json(409, { error: 'This page changed.' });
            }
            const next = {
                ...page,
                title: body.title?.trim() ?? page.title,
                content: body.content ?? page.content,
                revision: page.revision + 1,
            };
            pages.set(page.id, next);
            patched.push(next.revision);
            if (loseNext) {
                loseNext = false;
                throw new NetworkError(path);
            }
            return json(200, next);
        },
    };
}
type Server = ReturnType<typeof pageServer>;

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`;

/** A phone: user.db, the outbox with the save kind, the drafts, the page saves and the editor drafts. */
async function phone(
    server: Server,
    options: {
        store?: Awaited<ReturnType<typeof userDb>>;
        kill?: ReturnType<typeof killAt>;
        /** The bodies' cache write fails. */
        failBodies?: boolean;
    } = {},
) {
    const store = options.store ?? (await userDb());
    if (!options.store) {
        directories.push(store.directory);
    }
    const file = await store.open();
    files.push(file);
    // The kill counts steps only once the phone has opened (`armed`).
    let armed = false;
    const killed = options.kill ? options.kill.db(file.db) : file.db;
    const pick = () => (armed ? killed : file.db);
    const db: typeof file.db = {
        exec: (sql) => pick().exec(sql),
        run: (sql, params) => pick().run(sql, params),
        get: (sql, params) => pick().get(sql, params),
        all: (sql, params) => pick().all(sql, params),
        transaction: (task) => pick().transaction(task),
        close: () => file.db.close(),
    } as typeof file.db;
    /** The bodies the phone holds, by body key. */
    const bodies = new Map<string, Page>([[pageBodyKey('s1', 'p1'), { ...PAGE }]]);
    let connected = true;
    const fetchTo: AuthedFetch = (input, init) => server.handle(input, init);
    let rebase: (pageId: string, from: readonly number[], to: Page) => void = () => {};
    const outbox = await openOutbox({
        db,
        state: file.state,
        kinds: [
            pageSaveKind({
                bodies: {
                    put: async (key, page) => {
                        if (options.failBodies) {
                            throw new Error('cache.db is full');
                        }
                        bodies.set(key, page);
                    },
                },
                onSaved: (pageId, from, page) => rebase(pageId, from, page),
                newId,
            }),
        ],
        fetch: options.kill ? options.kill.fetch(fetchTo) : fetchTo,
        random: () => 0.5,
    });
    if (!options.kill) {
        // A killed phone's outbox waits forever on its steps: never disposed.
        outboxes.push(outbox);
    }
    const drafts = await openDrafts({ db, state: file.state, outbox });
    const saves = createPageSaves({
        outbox,
        drafts,
        baseOf: async (spaceId, pageId, revision) => {
            const page = bodies.get(pageBodyKey(spaceId, pageId));
            return page?.revision === revision ? page : null;
        },
        newId,
    });
    const pageDrafts = createPageDrafts({ drafts, connected: () => connected, sink: saves });
    rebase = pageDrafts.rebase;
    armed = true;
    return {
        store,
        file,
        outbox,
        drafts,
        saves,
        pageDrafts,
        bodies,
        setConnected(on: boolean) {
            connected = on;
            server.offline(!on);
            if (on) {
                outbox.wake();
            }
        },
    };
}

const START: EditorDraft = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'Hello' };
const draft = (content: string, title = 'Roadmap'): EditorDraft => ({ ...START, title, content });
const patches = (server: Server) => server.log.filter((line) => line.startsWith('PATCH'));
const gets = (server: Server) => server.log.filter((line) => line.startsWith('GET'));
const payloads = (outbox: Outbox) =>
    outbox
        .rows()
        .filter((row) => row.kind === PAGE_SAVE_KIND)
        .map((row) => JSON.parse(row.payload) as PageSavePayload);

describe('page saves', () => {
    it('two minutes of offline typing make one row and at most two PATCHes on reconnect', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const server = pageServer();
        const p = await phone(server);
        p.setConnected(false);
        p.outbox.start();
        const editor = p.pageDrafts.open('p1', START);
        let text = 'Hello';
        for (let at = 0; at < 120_000; at += 150) {
            text += 'x';
            editor.change({ title: 'Roadmap', content: text });
            await time.advance(150);
        }
        await editor.flush();
        await time.advance(AUTOSAVE_DEBOUNCE_MS * 2);
        expect(p.outbox.rows().filter((row) => row.kind === PAGE_SAVE_KIND)).toHaveLength(1);
        expect(payloads(p.outbox)[0]).toMatchObject({
            draft: { content: text },
            base: { revision: 3, content: 'Hello' },
        });
        expect(pendingPageText(p.outbox, 'p1')).toMatchObject({ content: text, state: 'pending' });

        p.setConnected(true);
        await time.advance(70_000);
        await p.outbox.idle();
        expect(patches(server).length).toBeGreaterThan(0);
        expect(server.patched.length).toBeLessThanOrEqual(2);
        expect(server.pages.get('p1')).toMatchObject({ content: text, revision: 4 });
        expect(p.outbox.rows()).toEqual([]);
        expect(p.drafts.read(pageDraft('p1')).text).toBe('');
        await editor.close();
    });

    it('three online stretches send three PATCHes and no GET', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const server = pageServer();
        const p = await phone(server);
        p.outbox.start();
        const editor = p.pageDrafts.open('p1', START);
        let text = 'Hello';
        for (let stretch = 0; stretch < 3; stretch += 1) {
            for (let key = 0; key < 10; key += 1) {
                text += String(stretch);
                editor.change({ title: 'Roadmap', content: text });
                await time.advance(100);
            }
            await time.advance(5_000);
            await p.outbox.idle();
        }
        expect(patches(server)).toHaveLength(3);
        expect(gets(server)).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ content: text, revision: 6 });
        expect(editor.read().revision).toBe(6);
        await editor.close();
    });

    it('a title with trailing spaces sends one PATCH; a no-op is never sent', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const server = pageServer();
        const p = await phone(server);
        p.outbox.start();
        const editor = p.pageDrafts.open('p1', START);
        editor.change({ title: 'Plans  ', content: 'Hello' });
        await time.advance(5_000);
        await p.outbox.idle();
        // Typing on with the same text, and a trailing space more: nothing changed for the server.
        editor.change({ title: 'Plans ', content: 'Hello' });
        await time.advance(5_000);
        await p.outbox.idle();
        expect(patches(server)).toHaveLength(1);
        expect(server.pages.get('p1')?.title).toBe('Plans');
        expect(await p.saves.savePage('p1', { ...draft('Hello', 'Plans'), revision: 4 })).toBe('none');
        expect(p.outbox.rows()).toEqual([]);
        await editor.close();
    });

    it('a save whose cache write fails still moves the editor to the new revision', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const server = pageServer();
        const p = await phone(server, { failBodies: true });
        p.outbox.start();
        const editor = p.pageDrafts.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'Hello there' });
        await time.advance(5_000);
        await p.outbox.idle();
        expect(server.pages.get('p1')).toMatchObject({ content: 'Hello there', revision: 4 });
        expect(editor.read().revision).toBe(4);
        // So the next save goes against revision 4, with no 409.
        editor.change({ title: 'Roadmap', content: 'Hello there again' });
        await time.advance(5_000);
        await p.outbox.idle();
        expect(server.pages.get('p1')).toMatchObject({ content: 'Hello there again', revision: 5 });
        expect(gets(server)).toEqual([]);
        expect(p.outbox.rows()).toEqual([]);
        await editor.close();
    });

    it('folds into the queued row, and removes it when the edits go back to the base', async () => {
        const server = pageServer();
        const p = await phone(server);
        expect(await p.saves.savePage('p1', draft('Hello A'))).toBe('queued');
        expect(await p.saves.savePage('p1', draft('Hello AB'))).toBe('folded');
        expect(payloads(p.outbox).map((payload) => payload.draft.content)).toEqual(['Hello AB']);
        expect(
            overlaysOf({ rows: p.outbox.rows(), kinds: PAGE_SAVE_VIEWS, scope: { resolve: () => null } }).map(
                ({ collection, key, value }) => ({ collection, key, value }),
            ),
        ).toEqual([{ collection: 'pages', key: 'p1', value: { title: 'Roadmap' } }]);
        expect(await p.saves.savePage('p1', draft('Hello', 'Roadmap '))).toBe('removed');
        expect(p.outbox.rows()).toEqual([]);
        expect(await p.saves.savePage('p1', { ...draft('x'), title: ' ' })).toBe('invalid');
        expect(p.outbox.rows()).toEqual([]);
    });

    it('a draft behind a row in flight queues behind it, and the first settle moves its base', async () => {
        const server = pageServer();
        const p = await phone(server);
        p.outbox.start();
        const open = server.hold();
        await p.saves.savePage('p1', draft('Hello 1'));
        await outboxUntil(p.outbox, () => p.outbox.rows()[0]?.state === 'inflight', { idle: false });
        expect(await p.saves.savePage('p1', draft('Hello 12'))).toBe('queued');
        expect(await p.saves.savePage('p1', draft('Hello 123'))).toBe('folded');
        expect(payloads(p.outbox)[1]).toMatchObject({ base: { content: 'Hello 1', revision: 3 } });
        open();
        await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
        expect(patches(server)).toHaveLength(2);
        expect(gets(server)).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ content: 'Hello 123', revision: 5 });
    });

    it('a lost success then a 409 is done with no merge', async () => {
        const server = pageServer();
        const p = await phone(server);
        server.loseNextAnswer();
        p.outbox.start();
        await p.saves.savePage('p1', draft('Hello there'));
        await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
        expect(server.patched).toEqual([4]);
        expect(gets(server)).toEqual(['GET /api/spaces/s1/pages/p1']);
        expect(p.outbox.unsent()).toEqual([]);
        expect(p.bodies.get(pageBodyKey('s1', 'p1'))).toMatchObject({ content: 'Hello there', revision: 4 });
    });

    it('someone’s move then a save keeps the move, and the editor’s next saves go on from it', async () => {
        const server = pageServer();
        const p = await phone(server);
        const editor = p.pageDrafts.open('p1', START);
        // A kill's draft on disk, on the same base: it moves with the editor.
        p.drafts.write(pageDraft('p1'), JSON.stringify({ v: 1, ...draft('Hello moved') }));
        // A move within the Space bumps the revision only.
        server.edit('p1', { parentId: 'p0' });
        await p.saves.savePage('p1', { ...editor.read(), content: 'Hello moved' });
        p.outbox.start();
        await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
        expect(server.pages.get('p1')).toMatchObject({ parentId: 'p0', content: 'Hello moved', revision: 5 });
        // The row went on 3, then on 4 after the 409: the editor and the stored draft follow it to 5.
        expect(editor.read()).toMatchObject({ spaceId: 's1', revision: 5 });
        expect(p.pageDrafts.stored('p1')).toMatchObject({ spaceId: 's1', revision: 5 });

        // The next save takes its revision from the editor: no 409, nothing in Unsent.
        const before = server.log.length;
        await p.saves.savePage('p1', { ...editor.read(), content: 'Hello again' });
        await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
        expect(server.log.slice(before)).toEqual(['PATCH /api/spaces/s1/pages/p1']);
        expect(p.outbox.unsent()).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ content: 'Hello again', revision: 6 });
        expect(editor.read().revision).toBe(6);
        await editor.close();
    });

    it('a move to another Space is relocated, and two saves after it go to the new Space', async () => {
        const server = pageServer();
        const p = await phone(server);
        const editor = p.pageDrafts.open('p1', START);
        p.outbox.start();
        server.edit('p1', { spaceId: 's2' });
        await p.saves.savePage('p1', { ...editor.read(), content: 'Hello there' });
        await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
        expect(server.pages.get('p1')).toMatchObject({ spaceId: 's2', content: 'Hello there', revision: 5 });
        expect(server.log).toContain('GET /api/pages/p1/location');
        expect(editor.read()).toMatchObject({ spaceId: 's2', revision: 5 });

        for (const content of ['Hello one', 'Hello two']) {
            const before = server.log.length;
            await p.saves.savePage('p1', { ...editor.read(), content });
            await outboxUntil(p.outbox, () => p.outbox.rows().length === 0);
            expect(server.log.slice(before)).toEqual(['PATCH /api/spaces/s2/pages/p1']);
        }
        expect(p.outbox.unsent()).toEqual([]);
        expect(server.pages.get('p1')).toMatchObject({ spaceId: 's2', content: 'Hello two', revision: 7 });
        expect(editor.read()).toMatchObject({ spaceId: 's2', revision: 7 });
        await editor.close();
    });

    it('someone else’s edit of the same line is a conflict; 410, 403 and a 400 go to Unsent with words', async () => {
        const server = pageServer();
        const p = await phone(server);
        server.edit('p1', { content: 'Theirs' });
        await p.saves.savePage('p1', draft('Mine'));
        p.outbox.start();
        await outboxUntil(p.outbox, () => p.outbox.unsent().length === 1);
        expect(p.outbox.unsent()[0]?.reason).toBe(PAGE_SAVE_REFUSALS.conflict);
        expect(p.bodies.get(pageBodyKey('s1', 'p1'))?.content).toBe('Theirs');
        // Under the banner the page shows theirs; ours waits in the conflict lane, leaving `page:p1` free.
        expect(p.outbox.unsent()[0]?.lane).toBe('page-conflict:p1');
        expect(pendingPageText(p.outbox, 'p1')).toBeNull();
        expect(server.pages.get('p1')?.content).toBe('Theirs');

        const other = pageServer();
        const q = await phone(other);
        other.pages.set('p1', { ...other.pages.get('p1')!, deleted: true });
        await q.saves.savePage('p1', draft('Gone'));
        q.outbox.start();
        await outboxUntil(q.outbox, () => q.outbox.unsent().length === 1);
        expect(q.outbox.unsent()[0]?.reason).toBe(PAGE_SAVE_REFUSALS.deleted);
        expect(unsentWhy(PAGE_SAVE_REFUSALS.deleted)).toBe('This page was deleted');
        expect(unsentWhy(PAGE_SAVE_REFUSALS.refused)).toBe('You can’t edit this page');
        expect(unsentWhy(PAGE_SAVE_REFUSALS.invalid)).toBe('It couldn’t be saved as written');
    });

    it('an edit while the create is queued folds into it; in flight, it waits for it at revision 1', async () => {
        const server = pageServer();
        const p = await phone(server);
        const local = 'local-page-1';
        await p.outbox.enqueue({
            id: local,
            lane: pageLane(local),
            kind: PAGE_CREATE_KIND,
            payload: JSON.stringify({ spaceId: 's1', pageId: local, title: 'Untitled page', content: '' }),
            payloadVersion: 1,
            idempotencyKey: newId(),
        });
        const start = { spaceId: 's1', revision: 1, title: 'Untitled page', content: '' };
        expect(await p.saves.savePage(local, { ...start, content: 'First' })).toBe('folded');
        expect(JSON.parse(p.outbox.rows()[0]!.payload)).toMatchObject({ content: 'First' });

        // Gone to the server (no page management kinds here): in flight when the app died, unknown on the next open.
        await p.outbox.dispose();
        await p.file.db.run("UPDATE outbox SET state = 'inflight' WHERE id = ?", [local]);
        const again = await phone(server, { store: p.store });
        expect(again.outbox.rows()[0]).toMatchObject({ id: local });
        expect(await again.saves.savePage(local, { ...start, content: 'First, then more' })).toBe('queued');
        const save = again.outbox.rows().find((row) => row.kind === PAGE_SAVE_KIND)!;
        expect(save.dependsOn).toBe(local);
        expect(JSON.parse(save.payload)).toMatchObject({
            base: { title: 'Untitled page', content: 'First', revision: 1 },
            ownRevisions: [1],
        });
        // Never created: once resolved through `ids` it would go; without, a refused create holds it.
        expect(again.outbox.resolve(PAGE_IDS, local)).toBeNull();
    });

    it('a kill between every two steps saves the last draft once, with no row left', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let survived = false;
        for (let at = 0; !survived; at += 1) {
            const server = pageServer();
            const kill = killAt(at);
            const p = await phone(server, { kill });
            // A kill may leave a step waiting forever: nothing here awaits one.
            void p.saves.savePage('p1', draft('Hello A')).catch(() => {});
            p.outbox.start();
            await time.advance(5_000);
            const revision = p.bodies.get(pageBodyKey('s1', 'p1'))!.revision;
            void p.saves.savePage('p1', { ...draft('Hello AB'), revision }).catch(() => {});
            await time.advance(5_000);
            void p.outbox.dispose();
            // Relaunch: a fresh connection to the same user.db, no kill.
            const again = await phone(server, { store: p.store });
            again.outbox.start();
            await time.advance(120_000);
            const where = `killed at step ${at}: ${kill.steps.join(', ')}`;
            expect(again.outbox.rows(), where).toEqual([]);
            expect(again.outbox.unsent(), where).toEqual([]);
            const content = server.pages.get('p1')!.content;
            expect(['Hello', 'Hello A', 'Hello AB'], where).toContain(content);
            if (!kill.killed) {
                expect(content).toBe('Hello AB');
            }
            survived = !kill.killed;
            // Each PATCH that landed made a new revision: none landed twice.
            expect(server.patched, where).toEqual([...new Set(server.patched)]);
            expect(at, 'every step was killed once').toBeLessThan(40);
        }
    });
});
