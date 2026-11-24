import { describe, expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';

import {
    advancedLine,
    COULDNT_SAVE,
    type EditorOutbox,
    editorStart,
    SAVED,
    SAVING,
    saveLine,
    WAITING_TO_SEND,
} from '../../src/editor/page-editor';
import type { OutboxRow, UnsentWrite } from '../../src/sync/outbox';
import { PAGE_CREATE_KIND, PAGE_SAVE_KIND } from '../../src/sync/page-save';

// The page editor's view models (src/editor/page-editor.ts): where
// the editor starts, the save line read from the outbox, Advanced mode's line.

const BODY: Page = {
    id: 'p1',
    spaceId: 's1',
    parentId: null,
    title: 'Roadmap',
    content: 'Server text',
    revision: 4,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: null,
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
};

const save = (draft: string, state: OutboxRow['state'] = 'queued', lane = 'page:p1'): OutboxRow =>
    ({
        id: `r-${draft}`,
        lane,
        kind: PAGE_SAVE_KIND,
        payload: JSON.stringify({
            spaceId: 's1',
            pageId: 'p1',
            base: { title: 'Roadmap', content: 'Server text', revision: 4 },
            draft: { title: 'Roadmap', content: draft },
            ownRevisions: [],
        }),
        payloadVersion: 1,
        state,
        createdAt: 1,
        dependsOn: null,
        idempotencyKey: 'k',
        revision: 1,
    }) as unknown as OutboxRow;

const outboxOf = (rows: OutboxRow[] = [], unsent: UnsentWrite[] = []): EditorOutbox => ({
    rows: () => rows,
    unsent: () => unsent,
    resolve: () => null,
});

describe('where the editor starts', () => {
    const stored = { spaceId: 's1', revision: 4, title: 'Roadmap', content: 'Typed before a kill' };

    it('takes the draft a kill left, then the newest queued save, then the body', () => {
        expect(editorStart(stored, outboxOf([save('Queued')]), 'p1', BODY)).toBe(stored);
        expect(editorStart(undefined, outboxOf([save('Older'), save('Queued')]), 'p1', BODY)).toEqual({
            spaceId: 's1',
            revision: 4,
            title: 'Roadmap',
            content: 'Queued',
        });
        expect(editorStart(undefined, outboxOf(), 'p1', BODY)).toEqual({
            spaceId: 's1',
            revision: 4,
            title: 'Roadmap',
            content: 'Server text',
        });
    });

    it("takes a page made on the phone from its create, and nothing when there's no copy", () => {
        const create = {
            ...save('x'),
            id: 'local-page-1',
            lane: 'page:local-page-1',
            kind: PAGE_CREATE_KIND,
            payload: JSON.stringify({ spaceId: 's1', pageId: 'local-page-1', title: 'New', content: 'Draft' }),
        } as OutboxRow;
        expect(editorStart(undefined, outboxOf([create]), 'local-page-1', null)).toEqual({
            spaceId: 's1',
            revision: 1,
            title: 'New',
            content: 'Draft',
        });
        expect(editorStart(undefined, outboxOf(), 'p1', null)).toBeNull();
    });

    it('never opens on a refused save: the page shows theirs under the banner', () => {
        const refused = {
            id: 'r',
            kind: PAGE_SAVE_KIND,
            lane: 'page-conflict:p1',
            dependsOn: null,
            payload: save('Mine').payload,
            payloadVersion: 1,
            reason: 'conflict',
            createdAt: 1,
        };
        expect(editorStart(undefined, outboxOf([], [refused]), 'p1', BODY)?.content).toBe('Server text');
    });
});

describe('the save line', () => {
    const line = (input: Partial<Parameters<typeof saveLine>[0]> = {}) =>
        saveLine({
            outbox: outboxOf(),
            pageId: 'p1',
            draftError: undefined,
            editing: false,
            connected: true,
            held: false,
            ...input,
        });

    it('says Saved, Saving… and Waiting to send from the page’s rows', () => {
        expect(line()).toEqual({ text: SAVED, tone: 'muted', detail: null });
        expect(line({ editing: true }).text).toBe(SAVING);
        expect(line({ editing: true, connected: false }).text).toBe(WAITING_TO_SEND);
        expect(line({ outbox: outboxOf([save('x')]) }).text).toBe(SAVING);
        expect(line({ outbox: outboxOf([save('x', 'inflight')]), connected: false }).text).toBe(SAVING);
        expect(line({ outbox: outboxOf([save('x')]), connected: false }).text).toBe(WAITING_TO_SEND);
        expect(line({ outbox: outboxOf([save('x')]), held: true }).text).toBe(WAITING_TO_SEND);
        // Another page's row says nothing here.
        expect(line({ outbox: outboxOf([save('x', 'queued', 'page:p2')]) }).text).toBe(SAVED);
    });

    it("says Couldn't save for a refused save or conflict, and a draft over the limits with the web's words", () => {
        const refused = (lane: string) => ({
            id: 'r',
            kind: PAGE_SAVE_KIND,
            lane,
            dependsOn: null,
            payload: '{}',
            payloadVersion: 1,
            reason: 'http-403',
            createdAt: 1,
        });
        expect(line({ outbox: outboxOf([], [refused('page:p1')]) })).toMatchObject({
            text: COULDNT_SAVE,
            tone: 'destructive',
        });
        expect(line({ outbox: outboxOf([], [refused('page-conflict:p1')]) }).text).toBe(COULDNT_SAVE);
        expect(line({ draftError: 'Title must be 160 characters or fewer.' })).toEqual({
            text: COULDNT_SAVE,
            tone: 'destructive',
            detail: 'Title must be 160 characters or fewer.',
        });
    });
});

describe("Advanced mode's line", () => {
    it('says the revision, the queued save’s base and its lane', () => {
        expect(advancedLine(outboxOf([save('x')]), 'p1', 4)).toBe('Revision 4 · base 4 · lane page:p1');
        expect(advancedLine(outboxOf(), 'p1', 7)).toBe('Revision 7 · base – · lane page:p1');
    });
});
