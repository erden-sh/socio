import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '../../src/data';
import { openDrafts, reviewDraft } from '../../src/sync/chat-drafts';
import { openOutbox } from '../../src/sync/outbox';
import { PAGE_DRAFT_WRITE_MS, parseEditorDraft } from '../../src/sync/page-drafts';
import { PAGE_CREATE_KIND } from '../../src/sync/page-save';
import {
    createReviewDrafts,
    dropEdits,
    REVIEW_EDITS_EMPTY,
    reviewEditStart,
    saveEditsAsNewPage,
    storedEdits,
} from '../../src/sync/review-edits';

import { userDb } from './outbox-fakes';

// A page review's edits on a real user.db: kept in `drafts` under the
// review's own scope through the page draft's throttled writes, never
// queued by themselves; a kill mid-edit loses at most about 2 s; "Save as a
// new page" queues the page and deletes them in one transaction.

const directories: string[] = [];
const files: UserDb[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const file of files.splice(0)) {
        await file.db.close().catch(() => {});
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const THREAD = 'thread-1';
const CALL = 'call-1';
const KEY = reviewDraft(THREAD, CALL);
const DRAFT = { title: 'Launch notes', content: '# Launch', spaceId: 'space-1' };

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

describe('a page review’s edits', () => {
    it('start from the socio’s draft in its Space, then from the edits kept', async () => {
        const s = await setup();
        const reviews = createReviewDrafts({ drafts: s.drafts, connected: () => true });
        expect(reviews.stored(KEY)).toBeUndefined();
        const start = reviewEditStart(reviews.stored(KEY), DRAFT);
        expect(start).toEqual({ spaceId: 'space-1', revision: 0, title: 'Launch notes', content: '# Launch' });
        const editor = reviews.open(KEY, start);
        editor.change({ title: 'Launch notes', content: '# Launch\n\nMore.' });
        await editor.close();
        expect(storedEdits(s.drafts, THREAD, CALL)).toMatchObject({ spaceId: 'space-1', content: '# Launch\n\nMore.' });
        expect(reviewEditStart(reviews.stored(KEY), DRAFT).content).toBe('# Launch\n\nMore.');
        // Nothing queued: a review's edits go only with its Save.
        expect(s.outbox.rows()).toEqual([]);
    });

    it('lose at most 2 s when the app is killed mid-edit', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const s = await setup();
        const reviews = createReviewDrafts({ drafts: s.drafts, connected: () => true });
        const editor = reviews.open(KEY, reviewEditStart(undefined, DRAFT));
        let typed = '';
        for (let second = 0; second < 30; second += 1) {
            typed += `${second} `;
            editor.change({ title: DRAFT.title, content: typed });
            await vi.advanceTimersByTimeAsync(400);
        }
        await vi.advanceTimersByTimeAsync(PAGE_DRAFT_WRITE_MS);
        await s.drafts.flush();
        // The kill: user.db opened again with nothing more written.
        const row = await s.file.db.get<{ text: string }>('SELECT text FROM drafts WHERE scope = ?', [KEY]);
        const kept = parseEditorDraft(row!.text)!;
        expect(typed.startsWith(kept.content)).toBe(true);
        expect(typed.length - kept.content.length).toBeLessThanOrEqual(15);
    });

    it('with no text left, say so and are never valid', async () => {
        const s = await setup();
        const reviews = createReviewDrafts({ drafts: s.drafts, connected: () => true });
        const editor = reviews.open(KEY, reviewEditStart(undefined, DRAFT));
        editor.change({ title: DRAFT.title, content: ' \n' });
        expect(editor.error()).toBe(REVIEW_EDITS_EMPTY);
        await editor.close();
    });

    it('Discard edits deletes them; Save as a new page queues the page and deletes them in one go, once', async () => {
        const s = await setup();
        const reviews = createReviewDrafts({ drafts: s.drafts, connected: () => true });
        const editor = reviews.open(KEY, reviewEditStart(undefined, DRAFT));
        editor.change({ title: 'Kept', content: 'My version' });
        await editor.close();
        const options = {
            outbox: s.outbox,
            newId: (() => {
                let n = 0;
                return () => `id-${(n += 1)}`;
            })(),
            spaceId: 'space-2',
            createdBy: 'user-1',
            serverAt: null,
            known: [],
        };
        const localId = await saveEditsAsNewPage(s.drafts, THREAD, CALL, options);
        expect(localId).not.toBeNull();
        expect(s.outbox.rows()).toMatchObject([{ id: localId, kind: PAGE_CREATE_KIND }]);
        expect(JSON.parse(s.outbox.rows()[0]!.payload)).toMatchObject({
            spaceId: 'space-2',
            title: 'Kept',
            content: 'My version',
        });
        expect(s.drafts.read(KEY).text).toBe('');
        expect(await saveEditsAsNewPage(s.drafts, THREAD, CALL, options)).toBeNull();
        expect(s.outbox.rows()).toHaveLength(1);

        const again = reviews.open(KEY, reviewEditStart(undefined, DRAFT));
        again.change({ title: 'Again', content: 'Text' });
        await again.close();
        dropEdits(s.drafts, THREAD, CALL);
        await s.drafts.flush();
        expect(storedEdits(s.drafts, THREAD, CALL)).toBeUndefined();
    });
});
