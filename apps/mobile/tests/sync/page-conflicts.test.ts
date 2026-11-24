import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS } from '@socio/shared/pages/page-draft';
import type { Page } from '@socio/shared/pages/page-library';

import type { UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { mergeChangeLines } from '../../src/shell/page-conflict';
import { openDrafts } from '../../src/sync/chat-drafts';
import { type Outbox, OUTBOX_REWRITE_MAX, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import {
    allPageConflicts,
    compareConflict,
    createPageLandings,
    keepTheirs,
    type PageConflict,
    pageConflicts,
    saveMineAsNewPage,
    takeMine,
    type PageMergeChange,
} from '../../src/sync/page-conflicts';
import { createPageDrafts, type EditorDraft, type EditorText } from '../../src/sync/page-drafts';
import {
    createPageSaves,
    PAGE_CREATE_KIND,
    PAGE_SAVE_KIND,
    PAGE_SAVE_VIEWS,
    type PageLanding,
    pageLane,
    pageSaveKind,
    pendingPageText,
} from '../../src/sync/page-save';
import { pageBodyKey } from '../../src/sync/pages';

import { userDb } from './outbox-fakes';

// Merges and the conflict banner (src/sync/page-conflicts.ts and page-save.ts's
// 409 path): two phones, each with its own user.db and outbox, against
// one fake server whose PATCH is src/server/pages's compare-and-set on
// `expectedRevision`. Edits on different lines merge in either order; the same
// line leaves the second phone's edit in `unsent` beside theirs, resolved by
// Use mine, Keep theirs or Save mine as a new page; and nothing typed is lost.

const directories: string[] = [];
const files: UserDb[] = [];
const outboxes: Outbox[] = [];

afterEach(async () => {
    vi.useRealTimers();
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

const LINES = ['# Roadmap', '', 'Ship the app', 'Write the docs', 'Plan the launch'];
const TEXT = `${LINES.join('\n')}\n`;

const PAGE: Page = {
    id: 'p1',
    spaceId: 's1',
    parentId: null,
    title: 'Roadmap',
    content: TEXT,
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'user-me',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
};

function pageServer() {
    const pages = new Map<string, Page>([[PAGE.id, { ...PAGE }]]);
    const log: string[] = [];
    let gate: Promise<void> | null = null;
    let offline = false;
    return {
        pages,
        log,
        page: () => pages.get('p1')!,
        offline(on: boolean) {
            offline = on;
        },
        /** PATCHes wait until the returned function runs. */
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
        /** Someone else's change, straight on the server. */
        edit(change: Partial<Page>) {
            const page = pages.get('p1')!;
            pages.set('p1', { ...page, ...change, revision: page.revision + 1 });
        },
        async handle(path: string, init: AuthedRequestInit = {}): Promise<Response> {
            const method = init.method ?? 'GET';
            log.push(`${method} ${path}`);
            if (offline) {
                throw new NetworkError(path);
            }
            const match = /^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/.exec(path);
            const page = match ? pages.get(decodeURIComponent(match[2]!)) : undefined;
            if (!page || page.spaceId !== decodeURIComponent(match![1]!)) {
                return json(404);
            }
            if (method === 'GET') {
                return json(200, page);
            }
            if (gate) {
                await gate;
            }
            const body = init.json as { title: string; content: string; expectedRevision: number };
            const current = pages.get(page.id)!;
            if (body.expectedRevision !== current.revision) {
                return json(409, { error: 'This page changed.' });
            }
            const next = {
                ...current,
                title: body.title.trim(),
                content: body.content,
                revision: current.revision + 1,
            };
            pages.set(page.id, next);
            return json(200, next);
        },
    };
}
type Server = ReturnType<typeof pageServer>;

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`;

/** A phone: its own user.db and outbox, the page saves, the editor drafts, and the conflict landings. */
async function phone(server: Server) {
    const store = await userDb();
    directories.push(store.directory);
    const file = await store.open();
    files.push(file);
    const bodies = new Map<string, Page>([[pageBodyKey('s1', 'p1'), { ...server.page() }]]);
    const fetchTo: AuthedFetch = (input, init) => server.handle(input, init);
    const landings = createPageLandings();
    const landed: { pageId: string; how: PageLanding }[] = [];
    const changes: PageMergeChange[] = [];
    landings.subscribe((pageId, how, change) => {
        landed.push({ pageId, how });
        changes.push(change);
    });
    let drafts: ReturnType<typeof createPageDrafts> | null = null;
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            pageSaveKind({
                bodies: {
                    put: async (key, page) => {
                        bodies.set(key, page);
                    },
                },
                onSaved: (pageId, from, page) => drafts?.rebase(pageId, from, page),
                onLanded: (pageId, from, sent, to, how) => {
                    drafts?.landed(pageId, from, sent, to);
                    landings.note(pageId, how, sent, to);
                },
                newId,
            }),
        ],
        fetch: fetchTo,
        random: () => 0.5,
    });
    outboxes.push(outbox);
    const chatDrafts = await openDrafts({ db: file.db, state: file.state, outbox });
    const saves = createPageSaves({
        outbox,
        drafts: chatDrafts,
        baseOf: async (spaceId, pageId, revision) => {
            const page = bodies.get(pageBodyKey(spaceId, pageId));
            return page?.revision === revision ? page : null;
        },
        newId,
    });
    drafts = createPageDrafts({ drafts: chatDrafts, connected: () => true, sink: saves });
    const pageDrafts = drafts;
    const body = () => bodies.get(pageBodyKey('s1', 'p1'))!;
    return {
        outbox,
        saves,
        pageDrafts,
        bodies,
        body,
        landed,
        changes,
        /** An editor on the page as the phone holds it, with what the editor bridge's `replace` was handed. */
        editor() {
            const page = body();
            const start: EditorDraft = {
                spaceId: page.spaceId,
                revision: page.revision,
                title: page.title,
                content: page.content,
            };
            const handle = pageDrafts.open('p1', start);
            const replaced: EditorText[] = [];
            handle.onReplace((text) => replaced.push(text));
            return { handle, replaced };
        },
        conflicts: () => pageConflicts(outbox, 'p1'),
    };
}
type Phone = Awaited<ReturnType<typeof phone>>;

/** `text` with line `index` (of LINES) changed by `change`. */
const withLine = (text: string, index: number, change: (line: string) => string) => {
    const lines = text.split('\n');
    lines[index] = change(lines[index]!);
    return lines.join('\n');
};

/** Types `content` into the editor, then lets its debounce, the outbox and the back-offs run. */
async function type(editor: Awaited<ReturnType<Phone['editor']>>, content: string, title?: string) {
    const latest = editor.handle.read();
    editor.handle.change({ title: title ?? latest.title, content });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
}

async function settle(...phones: Phone[]) {
    for (let round = 0; round < 6; round += 1) {
        await vi.advanceTimersByTimeAsync(70_000);
        await Promise.all(phones.map((p) => p.outbox.idle()));
    }
}

const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

describe('page merges and conflicts', () => {
    for (const order of ['A first', 'B first'] as const) {
        it(`edits on different lines merge, ${order}, and the second editor shows the merge`, async () => {
            fake();
            const server = pageServer();
            const [a, b] = [await phone(server), await phone(server)];
            const [first, second] = order === 'A first' ? [a, b] : [b, a];
            const firstEditor = first.editor();
            const secondEditor = second.editor();
            // Both offline-ish: the second's save goes after the first landed.
            second.outbox.start();
            first.outbox.start();
            await type(
                firstEditor,
                withLine(TEXT, 2, (line) => `${line} in May`),
            );
            await settle(first);
            expect(server.page().revision).toBe(4);
            await type(
                secondEditor,
                withLine(TEXT, 4, (line) => `${line} in June`),
            );
            await settle(first, second);

            const merged = withLine(
                withLine(TEXT, 2, (line) => `${line} in May`),
                4,
                (line) => `${line} in June`,
            );
            expect(server.page()).toMatchObject({ content: merged, revision: 5 });
            expect(second.outbox.unsent()).toEqual([]);
            expect(second.outbox.rows()).toEqual([]);
            // The second phone's editor got the merge through the editor bridge's `replace`, and its toast.
            expect(secondEditor.replaced.at(-1)).toEqual({ title: 'Roadmap', content: merged });
            expect(secondEditor.handle.read()).toMatchObject({ content: merged, revision: 5 });
            expect(second.landed).toEqual([{ pageId: 'p1', how: 'merged' }]);
            expect(first.landed).toEqual([]);
            // "See what changed": the merge against what the second phone sent is the first phone's line.
            const [change] = second.changes;
            expect(change).toEqual({
                before: { title: 'Roadmap', content: withLine(TEXT, 4, (line) => `${line} in June`) },
                after: { title: 'Roadmap', content: merged },
            });
            const shown = mergeChangeLines(change!).filter((row) => row.kind !== 'same');
            expect(shown.map((row) => [row.kind, row.text, row.label])).toEqual([
                ['removed', LINES[2], 'Before'],
                ['added', `${LINES[2]} in May`, 'Changed elsewhere'],
            ]);
            // Its next save goes on from the merge: no 409.
            const before = server.log.length;
            await type(secondEditor, `${merged}More\n`);
            await settle(second);
            expect(server.log.slice(before)).toEqual(['PATCH /api/spaces/s1/pages/p1']);
            expect(server.page().content).toBe(`${merged}More\n`);
            await firstEditor.handle.close();
            await secondEditor.handle.close();
        });

        it(`the same line, ${order}: theirs shows, ours waits beside it, and nothing holds the page`, async () => {
            fake();
            const server = pageServer();
            const [a, b] = [await phone(server), await phone(server)];
            const [first, second] = order === 'A first' ? [a, b] : [b, a];
            const secondEditor = second.editor();
            first.outbox.start();
            second.outbox.start();
            const theirs = withLine(TEXT, 2, () => 'Ship the app on iOS');
            await first.saves.savePage('p1', { ...PAGE, content: theirs });
            await settle(first);
            const mine = withLine(TEXT, 2, () => 'Ship the app on Android');
            await type(secondEditor, mine);
            await settle(second);

            expect(server.page()).toMatchObject({ content: theirs, revision: 4 });
            const [conflict, ...more] = second.conflicts();
            expect(more).toEqual([]);
            expect(conflict).toMatchObject({
                pageId: 'p1',
                mine: { content: mine },
                theirs: { content: theirs, revision: 4 },
            });
            expect(second.outbox.unsent()[0]).toMatchObject({ lane: 'page-conflict:p1', reason: 'conflict' });
            expect(second.body()).toMatchObject({ content: theirs, revision: 4 });
            // The editor opens on theirs under the banner; the list shows no draft title over it.
            expect(secondEditor.replaced.at(-1)?.content).toBe(theirs);
            expect(secondEditor.handle.read()).toMatchObject({ content: theirs, revision: 4 });
            expect(second.landed).toEqual([{ pageId: 'p1', how: 'conflict' }]);
            expect(pendingPageText(second.outbox, 'p1')).toBeNull();
            expect(
                overlaysOf({
                    rows: second.outbox.rows(),
                    unsent: second.outbox.unsent(),
                    kinds: PAGE_SAVE_VIEWS,
                    scope: { resolve: () => null },
                }),
            ).toEqual([]);
            // Compare: theirs against mine, the changed line only.
            expect(compareConflict(conflict!).lines.filter((change) => change.kind !== 'same')).toEqual([
                { kind: 'removed', text: 'Ship the app on iOS\n' },
                { kind: 'added', text: 'Ship the app on Android\n' },
            ]);
            await secondEditor.handle.close();
        });
    }

    /** The second phone left with a conflict on line 2, then an edit on line 4 saved on theirs. */
    async function conflicted() {
        fake();
        const server = pageServer();
        const [first, second] = [await phone(server), await phone(server)];
        const editor = second.editor();
        first.outbox.start();
        second.outbox.start();
        const theirs = withLine(TEXT, 2, () => 'Ship the app on iOS');
        await first.saves.savePage('p1', { ...PAGE, content: theirs });
        await settle(first);
        const mine = withLine(TEXT, 2, () => 'Ship the app on Android');
        await type(editor, mine);
        await settle(second);
        // Typing on after the conflict: saved on theirs, with no 409.
        const before = server.log.length;
        const after = withLine(theirs, 4, (line) => `${line} soon`);
        await type(editor, after);
        await settle(second);
        expect(server.log.slice(before)).toEqual(['PATCH /api/spaces/s1/pages/p1']);
        expect(server.page()).toMatchObject({ content: after, revision: 5 });
        expect(second.conflicts()).toHaveLength(1);
        return { server, first, second, editor, theirs, mine, after, conflict: second.conflicts()[0]! };
    }

    it('Keep theirs discards ours; the page keeps theirs and the edit since', async () => {
        const { server, second, editor, after, conflict } = await conflicted();
        expect(await keepTheirs(second.outbox, conflict)).toBe(true);
        await settle(second);
        expect(second.outbox.unsent()).toEqual([]);
        expect(server.page()).toMatchObject({ content: after, revision: 5 });
        await editor.handle.close();
    });

    it('Use mine replaces theirs, on the page the phone holds, and the editor moves onto it', async () => {
        const { server, second, editor, mine, conflict } = await conflicted();
        const current = second.body();
        expect(current.revision).toBe(5);
        expect(
            await takeMine(conflict, { outbox: second.outbox, newId, current, landed: second.pageDrafts.landed }),
        ).toBe(true);
        // Mine, with the edit made since on top, in the editor at once; the row folds it in before it goes.
        const expected = withLine(mine, 4, (line) => `${line} soon`);
        expect(editor.replaced.at(-1)?.content).toBe(expected);
        await editor.handle.flush();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
        await settle(second);
        expect(second.outbox.unsent()).toEqual([]);
        expect(second.outbox.rows()).toEqual([]);
        expect(server.page().content).toBe(expected);
        expect(server.page().revision).toBeGreaterThanOrEqual(6);
        await editor.handle.close();
    });

    it('Use mine after theirs changed again merges or comes back to the banner, never overwriting blind', async () => {
        const { server, second, editor, conflict } = await conflicted();
        // Someone edits the same line again before Use mine goes; the phone still holds revision 5.
        server.edit({ content: withLine(server.page().content, 2, () => 'Ship the app on the web') });
        expect(await takeMine(conflict, { outbox: second.outbox, newId, current: second.body() })).toBe(true);
        await settle(second);
        expect(server.page().content).toContain('Ship the app on the web');
        expect(second.conflicts()).toHaveLength(1);
        expect(second.conflicts()[0]?.theirs?.content).toContain('Ship the app on the web');
        await editor.handle.close();
    });

    it('Save mine as a new page queues the create in the page’s Space, then lets the conflict go', async () => {
        const { second, editor, mine, conflict } = await conflicted();
        const localId = await saveMineAsNewPage(conflict, {
            outbox: second.outbox,
            newId,
            spaceId: conflict.spaceId,
            createdBy: 'user-me',
            serverAt: null,
            known: ['p1'],
        });
        expect(localId).not.toBeNull();
        const create = second.outbox.rows().find((row) => row.kind === PAGE_CREATE_KIND);
        expect(create).toMatchObject({ id: localId, lane: pageLane(localId ?? '') });
        expect(JSON.parse(create!.payload)).toMatchObject({
            spaceId: 's1',
            title: 'Roadmap',
            content: mine,
            parentId: null,
        });
        expect(second.outbox.unsent()).toEqual([]);
        await editor.handle.close();
    });

    it('Use mine with edits typed under the banner on its lines comes back to the banner, never over them', async () => {
        const { server, second, editor, mine, after, conflict } = await conflicted();
        // The person edits line 2 again under the banner, on theirs: saved, revision 6.
        const typed = withLine(after, 2, () => 'Ship the app on iOS and the web');
        await type(editor, typed);
        await settle(second);
        expect(server.page()).toMatchObject({ content: typed, revision: 6 });
        const current = second.body();
        expect(current.revision).toBe(6);
        expect(
            await takeMine(conflict, { outbox: second.outbox, newId, current, landed: second.pageDrafts.landed }),
        ).toBe(true);
        // Mine doesn't merge onto what they typed: the editor keeps it, and so does the server.
        expect(editor.handle.read().content).toBe(typed);
        await settle(second);
        expect(server.page().content).toBe(typed);
        const [again, ...more] = second.conflicts();
        expect(more).toEqual([]);
        // Back at the banner, with Compare showing the page as it is now.
        expect(again).toMatchObject({ mine: { content: mine }, theirs: { content: typed, revision: 6 } });
        await editor.handle.close();
    });

    it('Save mine as a new page tapped twice makes one page', async () => {
        const { second, editor, conflict } = await conflicted();
        const options = {
            outbox: second.outbox,
            newId,
            spaceId: conflict.spaceId,
            createdBy: 'user-me',
            serverAt: null,
            known: ['p1'],
        };
        const [first, repeat] = await Promise.all([
            saveMineAsNewPage(conflict, options),
            saveMineAsNewPage(conflict, options),
        ]);
        expect(first).not.toBeNull();
        expect(repeat).toBe(first);
        // Once the conflict is gone, another tap finds nothing to save.
        expect(await saveMineAsNewPage(conflict, options)).toBeNull();
        expect(second.outbox.rows().filter((row) => row.kind === PAGE_CREATE_KIND)).toHaveLength(1);
        expect(second.outbox.unsent()).toEqual([]);
        await editor.handle.close();
    });

    it('a merge past OUTBOX_REWRITE_MAX goes to the banner: the editor on theirs, no merged toast for it', async () => {
        fake();
        const server = pageServer();
        // Someone keeps editing the page: before each of the phone's PATCHes, a line is added at the end.
        const handle = server.handle.bind(server);
        let busy = OUTBOX_REWRITE_MAX + 1;
        server.handle = async (path, init = {}) => {
            if ((init.method ?? 'GET') === 'PATCH' && busy > 0) {
                busy -= 1;
                server.edit({ content: `${server.page().content}Note ${busy}\n` });
            }
            return handle(path, init);
        };
        const p = await phone(server);
        const editor = p.editor();
        p.outbox.start();
        const mine = withLine(TEXT, 2, (line) => `${line} in May`);
        await type(editor, mine);
        await settle(p);

        const theirs = server.page();
        expect(theirs.content).not.toContain('in May');
        // Each merge the outbox sent said so; the one it can't send lands as the conflict.
        expect(p.landed).toEqual([
            ...Array.from({ length: OUTBOX_REWRITE_MAX }, () => ({ pageId: 'p1', how: 'merged' })),
            { pageId: 'p1', how: 'conflict' },
        ]);
        expect(editor.handle.read()).toMatchObject({ content: theirs.content, revision: theirs.revision });
        expect(editor.replaced.at(-1)?.content).toBe(theirs.content);
        const [conflict, ...more] = p.conflicts();
        expect(more).toEqual([]);
        expect(conflict?.mine.content).toContain('in May');
        expect(conflict?.theirs).toMatchObject({ content: theirs.content, revision: theirs.revision });
        // The next save goes on theirs: ours never reaches the page without Use mine.
        await type(editor, `${theirs.content}More\n`);
        await settle(p);
        expect(server.page().content).toBe(`${theirs.content}More\n`);
        expect(p.conflicts()).toHaveLength(1);
        await editor.handle.close();
    });

    it('own revisions never merge: a row that finds its own save goes again on it', async () => {
        fake();
        const server = pageServer();
        const p = await phone(server);
        // Our own earlier save made revision 4 (its answer lost); this row still says 3.
        server.edit({ content: withLine(TEXT, 2, () => 'Ours, saved before') });
        const row = {
            spaceId: 's1',
            pageId: 'p1',
            base: { title: 'Roadmap', content: TEXT, revision: 3 },
            draft: { title: 'Roadmap', content: withLine(TEXT, 2, () => 'Ours, typed since') },
            ownRevisions: [4],
            bases: [3],
        };
        await p.outbox.enqueue({
            id: 'save-1',
            lane: pageLane('p1'),
            kind: PAGE_SAVE_KIND,
            payload: JSON.stringify(row),
            payloadVersion: 1,
            idempotencyKey: newId(),
        });
        p.outbox.start();
        await settle(p);
        expect(server.page()).toMatchObject({ content: row.draft.content, revision: 5 });
        expect(p.landed).toEqual([]);
        expect(p.outbox.unsent()).toEqual([]);
    });

    it('the replace race: text typed while the save was going is merged again onto the merge', async () => {
        fake();
        const server = pageServer();
        const p = await phone(server);
        const editor = p.editor();
        p.outbox.start();
        const open = server.hold();
        const sent = withLine(TEXT, 2, (line) => `${line} in May`);
        await type(editor, sent);
        await vi.waitFor(() => expect(p.outbox.rows()[0]?.state).toBe('inflight'));
        // Someone else changes line 4, and the person types on line 0 while the PATCH waits.
        server.edit({ content: withLine(TEXT, 4, (line) => `${line} in June`) });
        const typed = withLine(sent, 0, () => '# Roadmap 2027');
        await type(editor, typed);
        open();
        await settle(p);
        const all = withLine(
            withLine(
                withLine(TEXT, 2, (line) => `${line} in May`),
                4,
                (line) => `${line} in June`,
            ),
            0,
            () => '# Roadmap 2027',
        );
        // The editor got its own text with theirs merged in, never the save's snapshot.
        expect(editor.replaced.at(-1)?.content).toBe(all);
        expect(editor.handle.read().content).toBe(all);
        expect(server.page().content).toBe(all);
        expect(p.outbox.unsent()).toEqual([]);
        expect(p.outbox.rows()).toEqual([]);
        await editor.handle.close();
    });

    it('the replace race, unclean: the editor keeps its text and its own save ends at the banner', async () => {
        fake();
        const server = pageServer();
        const p = await phone(server);
        const editor = p.editor();
        p.outbox.start();
        const open = server.hold();
        const sent = withLine(TEXT, 2, (line) => `${line} in May`);
        await type(editor, sent);
        await vi.waitFor(() => expect(p.outbox.rows()[0]?.state).toBe('inflight'));
        server.edit({ content: withLine(TEXT, 3, () => 'Write the docs, theirs') });
        const typed = withLine(sent, 3, () => 'Write the docs, mine');
        await type(editor, typed);
        open();
        await settle(p);
        // Lines 2 and 3 touch, so the save's own merge isn't clean: a conflict, and the editor kept its text.
        const conflicts = p.conflicts();
        expect(conflicts.length).toBeGreaterThanOrEqual(1);
        // Nothing typed is lost: every line of ours is on the server or in a conflict.
        const kept = [server.page().content, ...conflicts.map((conflict) => conflict.mine.content)].join('\n');
        expect(kept).toContain('Ship the app in May');
        expect(kept).toContain('Write the docs, mine');
        expect(server.page().content).toContain('Write the docs, theirs');
        await editor.handle.close();
    });
});

/** A small seeded random (mulberry32), so a failing run can be repeated. */
function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('no loss (fuzz)', () => {
    it('two phones typing on random lines, online and off: every word typed is on the server or in a conflict', async () => {
        fake();
        const seen = { merged: 0, conflict: 0 };
        for (let seed = 1; seed <= 12; seed += 1) {
            const random = seeded(seed);
            const server = pageServer();
            const phones = [await phone(server), await phone(server)];
            const editors = phones.map((p) => p.editor());
            phones.forEach((p) => p.outbox.start());
            const typed: string[][] = [[], []];
            for (let step = 0; step < 16; step += 1) {
                const who = random() < 0.5 ? 0 : 1;
                const line = Math.floor(random() * LINES.length);
                const word = `w${seed}x${step}p${who}`;
                typed[who]!.push(word);
                const editor = editors[who]!;
                editor.handle.change({
                    title: editor.handle.read().title,
                    content: withLine(editor.handle.read().content, line, (text) => `${text} ${word}`),
                });
                server.offline(random() < 0.2);
                await vi.advanceTimersByTimeAsync(Math.floor(random() * 3_000));
            }
            server.offline(false);
            phones.forEach((p) => p.outbox.wake());
            await Promise.all(editors.map((editor) => editor.handle.close()));
            await settle(...phones);
            for (const [who, p] of phones.entries()) {
                const where = `seed ${seed}, phone ${who}`;
                expect(p.outbox.rows(), where).toEqual([]);
                const reasons = p.outbox.unsent().map((write) => write.reason);
                expect(
                    reasons.every((reason) => reason === 'conflict'),
                    where,
                ).toBe(true);
                const kept = [
                    server.page().content,
                    ...allPageConflicts(p.outbox).map((c: PageConflict) => c.mine.content),
                ].join('\n');
                for (const word of typed[who]!) {
                    expect(kept, `${where}: ${word}`).toContain(word);
                }
                for (const { how } of p.landed) {
                    seen[how] += 1;
                }
            }
        }
        // The runs went through both paths.
        expect(seen.merged).toBeGreaterThan(0);
        expect(seen.conflict).toBeGreaterThan(0);
    }, 120_000);
});
