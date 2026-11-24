import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS, PAGE_CONTENT_MAX } from '@socio/shared/pages/page-draft';

import type { UserDb } from '../../src/data';
import { chatDraft, type Drafts, DRAFTS_KEPT, openDrafts, reviewDraft } from '../../src/sync/chat-drafts';
import { openOutbox } from '../../src/sync/outbox';
import {
    createPageDrafts,
    type EditorDraft,
    PAGE_DRAFT_WRITE_MS,
    pageDraft,
    type PageDraftSink,
    parseEditorDraft,
} from '../../src/sync/page-drafts';
import { endFakeTime, fakeTime } from '../helpers/fake-time';

import { userDb } from './outbox-fakes';

// The page editor's draft (src/sync/page-drafts.ts) on a real user.db: `page:`
// and `review:` drafts outlive the bound, a kill at random points of two
// minutes of typing loses at most 2 s, dispose mid-stretch writes the latest,
// offline writes go into the queued row, and an over-limit draft queues
// nothing.

const directories: string[] = [];
const files: UserDb[] = [];

afterEach(async () => {
    endFakeTime();
    for (const file of files.splice(0)) {
        await file.db.close();
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const START: EditorDraft = { spaceId: 's1', revision: 3, title: 'Roadmap', content: 'Hello' };

async function setup() {
    const store = await userDb();
    directories.push(store.directory);
    const open = async () => {
        const file = await store.open();
        files.push(file);
        const outbox = await openOutbox({
            db: file.db,
            state: file.state,
            kinds: [],
            fetch: (() => {
                throw new Error('no requests');
            }) as never,
        });
        const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
        return { file, outbox, drafts };
    };
    return { ...(await open()), open };
}

/** The editor draft on disk for `pageId`, read through a fresh connection's drafts. */
const onDisk = async (file: UserDb, pageId: string): Promise<EditorDraft | undefined> => {
    const row = await file.db.get<{ text: string }>('SELECT text FROM drafts WHERE scope = ?', [pageDraft(pageId)]);
    return row ? parseEditorDraft(row.text) : undefined;
};

/** A sink that records the page save's calls; `queued` says whether the page has a row that can change. */
function fakeSink(drafts: Drafts, queued = false) {
    const updates: EditorDraft[] = [];
    const saves: (EditorDraft | undefined)[] = [];
    const sink: PageDraftSink = {
        async updateQueued(_pageId, draft) {
            if (queued) {
                updates.push(draft);
            }
            return queued;
        },
        async save(pageId) {
            const text = drafts.read(pageDraft(pageId)).text;
            saves.push(text ? parseEditorDraft(text) : undefined);
        },
    };
    return { sink, updates, saves };
}

describe('the bound', () => {
    it(`never drops a page’s or a review’s draft past ${DRAFTS_KEPT} others`, async () => {
        let time = 1;
        const { file, outbox } = await setup();
        const drafts = await openDrafts({ db: file.db, state: file.state, outbox, now: () => time });
        drafts.write(pageDraft('p-old'), '{"old":true}');
        drafts.write(reviewDraft('t1', 'call-1'), '{"title":"Edited"}');
        for (let i = 0; i <= DRAFTS_KEPT + 5; i += 1) {
            time += 1;
            drafts.write(chatDraft(`c${i}`), `draft ${i}`);
        }
        await drafts.flush();
        const scopes = (await file.db.all<{ scope: string }>('SELECT scope FROM drafts')).map((row) => row.scope);
        expect(scopes).toContain('page:p-old');
        expect(scopes).toContain('review:t1:call-1');
        // The bound counts only the others: the newest 50 chats stay.
        expect(scopes.filter((scope) => scope.startsWith('chat:'))).toHaveLength(DRAFTS_KEPT);
        expect(drafts.read(chatDraft('c0')).text).toBe('');
        await drafts.close();
    });
});

describe('writing the editor’s text', () => {
    it('writes the first change at once, then at most every 1.5 s, and nothing for an unchanged start', async ({
        signal,
    }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const pages = createPageDrafts({ drafts, connected: () => true });
        const editor = pages.open('p1', START);
        await time.advance(5_000);
        expect(await onDisk(file, 'p1')).toBeUndefined();

        editor.change({ title: 'Roadmap', content: 'Hello w' });
        await time.advance(0);
        expect((await onDisk(file, 'p1'))?.content).toBe('Hello w');
        editor.change({ title: 'Roadmap', content: 'Hello wo' });
        await time.advance(PAGE_DRAFT_WRITE_MS - 100);
        expect((await onDisk(file, 'p1'))?.content).toBe('Hello w');
        await time.advance(100);
        expect(await onDisk(file, 'p1')).toEqual({ ...START, content: 'Hello wo' });
        expect(pages.stored('p1')).toEqual({ ...START, content: 'Hello wo' });
        await pages.close();
        await drafts.close();
    });

    // Three kills at random points, from a fixed seed so a failure repeats: one test each, so a loaded
    // machine never runs all three against one test's timeout.
    const STRETCH_MS = 120_000;
    const KEY_MS = 120;
    const KILLS = (() => {
        let seed = 7;
        return [0, 1, 2].map((run) => {
            seed = (seed * 16807) % 2147483647;
            return { run, killAt: Math.floor((seed / 2147483647) * STRETCH_MS) };
        });
    })();
    it.for(KILLS)(
        'loses at most 2 s when killed at a random point of two minutes of typing (run $run, at $killAt ms)',
        async ({ run, killAt }, { signal }) => {
            const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            const { drafts, open } = await setup();
            const pages = createPageDrafts({ drafts, connected: () => true });
            const editor = pages.open('p1', { ...START, content: '' });
            /** When each length of text was typed. */
            const typedAt: number[] = [];
            let text = '';
            for (let at = 0; at < killAt; at += KEY_MS) {
                text += 'x';
                typedAt[text.length] = at;
                editor.change({ title: START.title, content: text });
                await time.advance(Math.min(KEY_MS, killAt - at));
            }
            // Killed: no close, no flush. What the next launch reads:
            const next = await open();
            const kept = (await openDrafts({ db: next.file.db, state: next.file.state, outbox: next.outbox })).read(
                pageDraft('p1'),
            ).text;
            const length = kept ? (parseEditorDraft(kept)?.content.length ?? 0) : 0;
            const lostSince = length === text.length ? killAt : (typedAt[length + 1] ?? 0);
            expect(killAt - lostSince, `run ${run}, killed at ${killAt} ms`).toBeLessThanOrEqual(2_000);
        },
    );

    it('writes the latest on dispose mid-stretch, and refuses opening after', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const pages = createPageDrafts({ drafts, connected: () => true });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'one' });
        await time.advance(200);
        editor.change({ title: 'Roadmap 2', content: 'one two' });
        // As the scope's dispose: the page editors, then the drafts.
        await pages.close();
        await drafts.close();
        expect(await onDisk(file, 'p1')).toEqual({ ...START, title: 'Roadmap 2', content: 'one two' });
        expect(() => pages.open('p2', START)).toThrow();
        // No timer is left.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a flush (Android Back, leaving) writes at once', async ({ signal }) => {
        fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const pages = createPageDrafts({ drafts, connected: () => true });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'a' });
        editor.change({ title: 'Roadmap', content: 'ab' });
        await editor.flush();
        expect((await onDisk(file, 'p1'))?.content).toBe('ab');
        await editor.close();
        await drafts.close();
    });
});

describe('the queue (the page save’s sink)', () => {
    it('online, the debounce writes the draft and then asks to save it', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { drafts } = await setup();
        const { sink, saves, updates } = fakeSink(drafts, true);
        const pages = createPageDrafts({ drafts, connected: () => true, sink });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'a' });
        await time.advance(300);
        editor.change({ title: 'Roadmap', content: 'ab' });
        await time.advance(AUTOSAVE_DEBOUNCE_MS - 1);
        expect(saves).toEqual([]);
        await time.advance(1);
        expect(saves).toEqual([{ ...START, content: 'ab' }]);
        // Online never touches the queued row.
        expect(updates).toEqual([]);
        await pages.close();
        await drafts.close();
    });

    it('closing the editor within the debounce saves the last edit once', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { drafts } = await setup();
        const { sink, saves } = fakeSink(drafts, false);
        const pages = createPageDrafts({ drafts, connected: () => true, sink });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'a' });
        await time.advance(300);
        editor.change({ title: 'Roadmap', content: 'ab' });
        await time.advance(AUTOSAVE_DEBOUNCE_MS - 100);
        expect(saves).toEqual([]);
        // Back, before the 800 ms.
        await editor.close();
        expect(saves).toEqual([{ ...START, content: 'ab' }]);
        await time.advance(AUTOSAVE_DEBOUNCE_MS * 3);
        expect(saves).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        // Closed with nothing pending: no second save.
        await editor.close();
        expect(saves).toHaveLength(1);
        await drafts.close();
    });

    it('dispose within the debounce saves every pending editor before the drafts close', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { drafts } = await setup();
        const { sink, saves } = fakeSink(drafts, false);
        const pages = createPageDrafts({ drafts, connected: () => true, sink });
        const one = pages.open('p1', START);
        const two = pages.open('p2', START);
        const three = pages.open('p3', START);
        one.change({ title: 'Roadmap', content: 'one' });
        two.change({ title: 'Roadmap', content: 'two' });
        // Invalid: written, never saved.
        three.change({ title: '', content: 'three' });
        await time.advance(100);
        await pages.close();
        await drafts.close();
        expect(saves.map((draft) => draft?.content).sort()).toEqual(['one', 'two']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('closing within the debounce on an invalid draft writes it and saves nothing', async ({ signal }) => {
        fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const { sink, saves } = fakeSink(drafts, false);
        const pages = createPageDrafts({ drafts, connected: () => true, sink });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'a' });
        editor.change({ title: '', content: 'ab' });
        await editor.close();
        expect(await onDisk(file, 'p1')).toEqual({ ...START, title: '', content: 'ab' });
        expect(saves).toEqual([]);
        await drafts.close();
    });

    it('offline, a write goes into the queued row in place and clears the editor draft', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        let online = true;
        const { sink, updates, saves } = fakeSink(drafts, true);
        const pages = createPageDrafts({ drafts, connected: () => online, sink });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'online' });
        await time.advance(0);
        expect((await onDisk(file, 'p1'))?.content).toBe('online');
        online = false;
        await time.advance(PAGE_DRAFT_WRITE_MS);
        expect(saves).toEqual([{ ...START, content: 'online' }]);
        editor.change({ title: 'Roadmap', content: 'offline' });
        await time.advance(PAGE_DRAFT_WRITE_MS);
        expect(updates.map((draft) => draft.content)).toEqual(['offline']);
        expect(await onDisk(file, 'p1')).toBeUndefined();
        // Past the debounce: the queued row holds it, so no save of an empty draft.
        expect(saves).toEqual([{ ...START, content: 'online' }]);
        await editor.close();
        expect(saves).toHaveLength(1);
        await pages.close();
        await drafts.close();
    });

    it('offline with no row that can change, the editor draft is written, then saved', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const { sink, saves } = fakeSink(drafts, false);
        const pages = createPageDrafts({ drafts, connected: () => false, sink });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'in flight' });
        await time.advance(0);
        expect((await onDisk(file, 'p1'))?.content).toBe('in flight');
        // The first edit made offline still becomes a row.
        await time.advance(AUTOSAVE_DEBOUNCE_MS);
        expect(saves).toEqual([{ ...START, content: 'in flight' }]);
        await pages.close();
        await drafts.close();
    });

    it('an over-limit or untitled draft stays here with the web’s words and queues nothing', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        let online = true;
        const { sink, saves, updates } = fakeSink(drafts, true);
        const pages = createPageDrafts({ drafts, connected: () => online, sink });
        const editor = pages.open('p1', START);
        const long = 'x'.repeat(PAGE_CONTENT_MAX + 1);
        editor.change({ title: 'Roadmap', content: long });
        expect(editor.error()).toBe(
            'Use a title up to 160 characters and a document up to 100,000 characters. Your draft is still here.',
        );
        await time.advance(AUTOSAVE_DEBOUNCE_MS * 3);
        online = false;
        editor.change({ title: '   ', content: 'short' });
        expect(editor.error()).toBeDefined();
        await time.advance(AUTOSAVE_DEBOUNCE_MS * 3);
        expect(saves).toEqual([]);
        expect(updates).toEqual([]);
        // Still on disk, as typed.
        expect(await onDisk(file, 'p1')).toEqual({ ...START, title: '   ', content: 'short' });
        // Fixed, it goes.
        editor.change({ title: 'Roadmap', content: 'short' });
        expect(editor.error()).toBeUndefined();
        await time.advance(PAGE_DRAFT_WRITE_MS);
        expect(updates.map((draft) => draft.title)).toEqual(['Roadmap']);
        await pages.close();
        await drafts.close();
    });
});

describe('a write that fails', () => {
    it('is written again by the next flush when the disk refused it', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        let failing = true;
        const flaky: Drafts = {
            ...drafts,
            read: (scope) => drafts.read(scope),
            write(scope, text) {
                if (failing) {
                    throw new Error('disk full');
                }
                drafts.write(scope, text);
            },
            flush: () => drafts.flush(),
        };
        const errors: unknown[] = [];
        const pages = createPageDrafts({ drafts: flaky, connected: () => true, onError: (e) => errors.push(e) });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'not yet on disk' });
        await time.advance(0);
        expect(errors).toHaveLength(1);
        expect(await onDisk(file, 'p1')).toBeUndefined();
        failing = false;
        await editor.flush();
        expect((await onDisk(file, 'p1'))?.content).toBe('not yet on disk');
        await pages.close();
        await drafts.close();
    });

    /** `drafts` whose writes throw while `failing.on` is set. */
    const flakyDrafts = (drafts: Drafts) => {
        const failing = { on: true };
        const flaky: Drafts = {
            ...drafts,
            read: (scope) => drafts.read(scope),
            write(scope, text) {
                if (failing.on) {
                    throw new Error('disk full');
                }
                drafts.write(scope, text);
            },
            flush: () => drafts.flush(),
        };
        return { flaky, failing };
    };

    it('online, a save whose write failed is still queued by the next flush, and by close', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const { flaky, failing } = flakyDrafts(drafts);
        const { sink, saves } = fakeSink(drafts);
        const pages = createPageDrafts({ drafts: flaky, connected: () => true, sink, onError: () => {} });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'typed online' });
        // The debounce ends on a write the disk refuses: nothing to save yet.
        await time.advance(AUTOSAVE_DEBOUNCE_MS);
        expect(saves).toEqual([]);
        failing.on = false;
        await editor.flush();
        expect((await onDisk(file, 'p1'))?.content).toBe('typed online');
        expect(saves.map((saved) => saved?.content)).toEqual(['typed online']);
        // Owed once: a second flush only writes.
        await editor.flush();
        expect(saves).toHaveLength(1);

        const other = pages.open('p2', START);
        failing.on = true;
        other.change({ title: 'Roadmap', content: 'typed, then left' });
        await time.advance(AUTOSAVE_DEBOUNCE_MS);
        failing.on = false;
        await other.close();
        expect(saves.map((saved) => saved?.content)).toEqual(['typed online', 'typed, then left']);
        await pages.close();
        await drafts.close();
    });

    it('a rebase while a write fails still leaves it to the next flush', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const { flaky, failing } = flakyDrafts(drafts);
        const errors: unknown[] = [];
        const pages = createPageDrafts({ drafts: flaky, connected: () => true, onError: (e) => errors.push(e) });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'during a save' });
        // An earlier save answered while this write is still on its way to the disk.
        pages.rebase('p1', [START.revision], { spaceId: 's1', revision: 4 });
        await time.advance(0);
        expect(errors).toHaveLength(1);
        failing.on = false;
        await editor.flush();
        expect(await onDisk(file, 'p1')).toEqual({
            spaceId: 's1',
            revision: 4,
            title: 'Roadmap',
            content: 'during a save',
        });
        await pages.close();
        await drafts.close();
    });

    it('offline, a rejected updateQueued falls back to the editor draft', async ({ signal }) => {
        const time = fakeTime(signal, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { file, drafts } = await setup();
        const saves: string[] = [];
        const sink: PageDraftSink = {
            updateQueued: () => Promise.reject(new Error('outbox closed')),
            async save(pageId) {
                saves.push(pageId);
            },
        };
        const errors: unknown[] = [];
        const pages = createPageDrafts({ drafts, connected: () => false, sink, onError: (e) => errors.push(e) });
        const editor = pages.open('p1', START);
        editor.change({ title: 'Roadmap', content: 'kept anyway' });
        await time.advance(0);
        expect(errors).toHaveLength(1);
        expect((await onDisk(file, 'p1'))?.content).toBe('kept anyway');
        // And, written to drafts, the debounce saves it as a row.
        await time.advance(AUTOSAVE_DEBOUNCE_MS);
        expect(saves).toEqual(['p1']);
        await pages.close();
        await drafts.close();
    });
});
