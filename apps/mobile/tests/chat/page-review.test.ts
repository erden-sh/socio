import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Message, ToolCall } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import { matchesReviewedDraft, pageReviewApproved } from '@socio/shared/pages/page-review';

import { cardsOf, pageReviewCard } from '../../src/chat/cards';
import { cardCalls } from '../../src/chat/cards';
import {
    type PageReviewCard,
    REVIEW_EDITED,
    REVIEW_EDITS_KEPT,
    readReviewReceipt,
    REVIEW_CHECKING,
    REVIEW_CONFLICT,
    REVIEW_DELETED,
    REVIEW_ENDED,
    REVIEW_NOT_SAVED,
    REVIEW_NOTHING_YET,
    REVIEW_READY,
    REVIEW_SAVED,
    reviewCardView,
    reviewDraftShown,
    reviewSheetView,
    DISCARD_EDITS_CONFIRM,
    SKIP_EDITS_CONFIRM,
    skipConfirm,
} from '../../src/chat/page-review';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import type { OverlayItem } from '../../src/sync/outbox-overlay';

// The page review's card and sheet (Save and Skip, no editing): what each says
// and offers, under Node.

const DRAFT = { title: 'Launch notes', content: '# Launch\n\n<br>What shipped.', spaceId: 'space-1' };
const call = (args: unknown = DRAFT): ToolCall => ({
    id: 'call-1',
    type: 'function',
    function: { name: 'review_space_page', arguments: JSON.stringify(args) },
});
const card = (result?: unknown, args: unknown = DRAFT) =>
    pageReviewCard(call(args), result === undefined ? undefined : JSON.stringify(result)) as PageReviewCard;
const decision = (state: OverlayItem['state'], approved: boolean, reason: string | null = null): OverlayItem => ({
    id: 'review:thread-1:call-1',
    collection: 'review',
    key: 'review:thread-1:call-1',
    mode: 'insert',
    value: { threadId: 'thread-1', toolCallId: 'call-1', approved },
    state,
    reason,
    createdAt: 1,
});
const page = (draft = DRAFT) =>
    ({
        id: 'page-1',
        spaceId: 'space-1',
        title: draft.title,
        reviewDraft: draft,
    }) as never;

describe('the page review card', () => {
    it('is a card of its call, never a trace step', () => {
        const message: Message = { id: 'a-1', role: 'assistant', content: '', toolCalls: [call()] };
        expect(cardsOf(message, new Map(), null)).toMatchObject([
            { id: 'card:call-1', card: { kind: 'page-review', toolCallId: 'call-1', args: DRAFT, result: null } },
        ]);
        expect(cardCalls([message])(call())).toBe(true);
    });

    it('reads its stored result: the page saved, or skipped', () => {
        expect(card({ approved: true, pageId: 'p-1', spaceId: 's-1', url: '/spaces/s-1/pages/p-1' }).result).toEqual({
            approved: true,
            page: { spaceId: 's-1', pageId: 'p-1' },
        });
        expect(card({ approved: false, message: 'declined' }).result).toEqual({ approved: false, page: null });
    });

    it('says where the review stands', () => {
        const none = { open: false, stored: true, decision: undefined };
        expect(reviewCardView(card(), { ...none, open: true })).toMatchObject({
            heading: REVIEW_READY,
            note: REVIEW_NOTHING_YET,
            action: { kind: 'review' },
            waiting: true,
        });
        expect(reviewCardView(card(), { ...none, stored: false })).toMatchObject({
            heading: 'Draft on its way',
            action: null,
        });
        expect(reviewCardView(card(), none)).toMatchObject({ heading: REVIEW_ENDED, note: REVIEW_NOT_SAVED });
        expect(reviewCardView(card(), { ...none, open: true, decision: decision('sending', true) })).toMatchObject({
            heading: 'Saving…',
            action: null,
        });
        expect(reviewCardView(card(), { ...none, open: true, decision: decision('queued', false) })).toMatchObject({
            heading: 'Skipping…',
        });
        expect(reviewCardView(card(), { ...none, open: true, decision: decision('sent', true) })).toMatchObject({
            heading: REVIEW_SAVED,
        });
        expect(
            reviewCardView(card(), { ...none, open: true, decision: decision('unsent', true, 'conflict') }),
        ).toMatchObject({
            heading: 'Couldn’t save this page',
            note: REVIEW_CONFLICT,
            action: { kind: 'review' },
            problem: true,
        });
        expect(reviewCardView(card({ approved: true, pageId: 'p-1', spaceId: 's-1' }), none)).toMatchObject({
            heading: REVIEW_SAVED,
            action: { kind: 'open-page', href: '/spaces/s-1/pages/p-1' },
        });
    });

    it('shows the draft’s title and Markdown, a title missing as Untitled draft', () => {
        // Simple HTML becomes Markdown first, as on the web (a <br> is a hard break).
        expect(reviewDraftShown(DRAFT)).toEqual({ title: 'Launch notes', content: '# Launch\n\n\\\nWhat shipped.' });
        expect(reviewDraftShown({ content: 'Body' })).toEqual({ title: 'Untitled draft', content: 'Body' });
    });
});

describe('the page review sheet: Save and Skip only', () => {
    const open = { open: true, decision: undefined };

    it('offers Save and Skip while the receipt is checked, and with none', () => {
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'checking' } })).toEqual({
            heading: REVIEW_READY,
            lines: [{ text: REVIEW_CHECKING, problem: false }],
            save: 'Save',
            skip: true,
            page: null,
            edit: true,
            discard: false,
            keep: false,
            sendEdits: false,
        });
        // Offline: the decision asks for the receipt itself.
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'unknown' } })).toMatchObject({
            save: 'Save',
            skip: true,
        });
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'none' } })).toMatchObject({
            lines: [{ text: REVIEW_NOTHING_YET, problem: false }],
        });
    });

    it('restores a decision already saved from its receipt: Continue answers with that page', () => {
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: page() } })).toMatchObject({
            heading: REVIEW_SAVED,
            save: 'Continue',
            skip: false,
            page: '/spaces/space-1/pages/page-1',
        });
    });

    it('offers only Skip for a receipt of another draft, a deleted page, or a draft that doesn’t read', () => {
        const other = page({ ...DRAFT, content: 'Another text' });
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: other } })).toMatchObject({
            heading: 'Review changed',
            lines: [{ text: REVIEW_CONFLICT, problem: true }],
            save: null,
            skip: true,
        });
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'deleted' } })).toMatchObject({
            lines: [{ text: REVIEW_DELETED, problem: true }],
            save: null,
            skip: true,
        });
        const invalid = reviewSheetView(card(undefined, { title: '', content: 'x' }), {
            ...open,
            receipt: { kind: 'none' },
        });
        expect(invalid).toMatchObject({ heading: 'Draft needs fixing', save: null, skip: true });
        expect(invalid.lines[0]!.text).toContain('title');
    });

    it('offers nothing once decided, and Retry (Save) or Skip after a refusal', () => {
        expect(
            reviewSheetView(card(), { ...open, receipt: { kind: 'none' }, decision: decision('queued', true) }),
        ).toMatchObject({ heading: 'Saving…', save: null, skip: false });
        expect(reviewSheetView(card({ approved: false }), { ...open, receipt: { kind: 'none' } })).toMatchObject({
            heading: REVIEW_ENDED,
            save: null,
            skip: false,
        });
        expect(
            reviewSheetView(card(), {
                ...open,
                receipt: { kind: 'none' },
                decision: decision('unsent', true, 'http-403'),
            }),
        ).toMatchObject({ heading: 'Couldn’t save this page', save: 'Save', skip: true });
    });
});

describe('a review saved with edits, seen from a second device', () => {
    it('shows it saved with its page, never as another draft', () => {
        const edited = page({ ...DRAFT, content: 'Edited on the other phone' });
        const result = pageReviewApproved({ id: 'page-1', spaceId: 'space-1' }, '/spaces/space-1/pages/page-1', {
            edited: true,
        });
        const stored = card(result);
        expect(reviewCardView(stored, { open: false, stored: true, decision: undefined })).toMatchObject({
            heading: REVIEW_SAVED,
            action: { kind: 'open-page', href: '/spaces/space-1/pages/page-1' },
        });
        expect(
            reviewSheetView(stored, { open: true, receipt: { kind: 'saved', page: edited }, decision: undefined }),
        ).toEqual({
            heading: REVIEW_SAVED,
            lines: [],
            save: null,
            skip: false,
            page: '/spaces/space-1/pages/page-1',
            edit: false,
            discard: false,
            keep: false,
            sendEdits: false,
        });
        // The same receipt with the result left out is shared's check too.
        expect(matchesReviewedDraft(edited, DRAFT, result)).toBe(true);
        expect(matchesReviewedDraft(edited, DRAFT)).toBe(false);
    });
});

describe('the receipt, asked as the sheet opens', () => {
    const answering =
        (status: number, body: unknown): AuthedFetch =>
        async () =>
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it('reads none, a saved page, a deleted one, and anything else as unknown', async () => {
        expect(await readReviewReceipt(answering(200, null), 't', 'c')).toEqual({ kind: 'none' });
        expect(await readReviewReceipt(answering(200, { id: 'p' }), 't', 'c')).toEqual({
            kind: 'saved',
            page: { id: 'p' },
        });
        expect(await readReviewReceipt(answering(410, { error: 'Gone' }), 't', 'c')).toEqual({ kind: 'deleted' });
        expect(await readReviewReceipt(answering(403, { error: 'No' }), 't', 'c')).toEqual({ kind: 'unknown' });
        const offline: AuthedFetch = async (input) => {
            throw new NetworkError(input);
        };
        expect(await readReviewReceipt(offline, 't', 'c')).toEqual({ kind: 'unknown' });
    });

    it('asks the conversation’s reviewed-page path for the call', async () => {
        const asked: string[] = [];
        const fetch: AuthedFetch = async (input) => {
            asked.push(input);
            return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
        };
        await readReviewReceipt(fetch, 'thread 1', 'call/1');
        expect(asked).toEqual(['/api/conversations/thread%201/reviewed-page/call%2F1']);
    });
});

describe('editing the draft before saving it', () => {
    const open = { open: true, decision: undefined, receipt: { kind: 'none' } as const };
    const EDITS = { title: 'Launch notes v2', content: '# Launch\n\nRewritten.' };

    it('offers Edit wherever Save is, and none for a draft that doesn’t read or a saved one', () => {
        expect(reviewSheetView(card(), open)).toMatchObject({ save: 'Save', edit: true, discard: false });
        expect(reviewSheetView(card(undefined, { title: '', content: 'x' }), open)).toMatchObject({
            save: null,
            edit: false,
        });
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: page() } })).toMatchObject({
            save: 'Continue',
            edit: false,
        });
    });

    it('shows the person’s version with Save and Discard edits', () => {
        expect(reviewDraftShown(DRAFT, EDITS)).toEqual(EDITS);
        expect(reviewSheetView(card(), { ...open, edits: EDITS })).toMatchObject({
            heading: REVIEW_READY,
            lines: [{ text: REVIEW_EDITED, problem: false }],
            save: 'Save',
            skip: true,
            edit: true,
            discard: true,
            keep: false,
        });
    });

    it('checks the edits on the device: no Save over the limits or with no text, with the words why', () => {
        const empty = reviewSheetView(card(), { ...open, edits: { title: 'Notes', content: '' } });
        expect(empty).toMatchObject({ save: null, skip: true, edit: true, discard: true });
        expect(empty.lines[0]).toMatchObject({ problem: true });
        const long = reviewSheetView(card(), { ...open, edits: { title: 'x'.repeat(161), content: 'Text' } });
        expect(long).toMatchObject({ save: null });
        expect(long.lines[0]!.text).toContain('160');
    });

    it('decided elsewhere: the edits stay with Copy and Save as a new page', () => {
        const skipped = card({ approved: false, message: 'Skipped' });
        expect(reviewSheetView(skipped, { ...open, open: false, edits: EDITS })).toMatchObject({
            lines: [{ text: REVIEW_EDITS_KEPT, problem: false }],
            save: null,
            skip: false,
            edit: false,
            discard: true,
            keep: true,
        });
        // This phone's own decision on its way: nothing to keep.
        expect(reviewSheetView(card(), { ...open, decision: decision('queued', true), edits: EDITS })).toMatchObject({
            keep: false,
            discard: false,
        });
        // Saved from another draft: only Skip for the review, the edits kept.
        expect(
            reviewSheetView(card(), {
                ...open,
                receipt: { kind: 'saved', page: page({ ...DRAFT, content: 'Other' }) },
                edits: EDITS,
            }),
        ).toMatchObject({ save: null, skip: true, keep: true, discard: true });
        expect(
            reviewSheetView(card(), { ...open, decision: decision('unsent', true, 'conflict'), edits: EDITS }),
        ).toMatchObject({ save: null, skip: true, keep: true });
    });

    it('a receipt holding these edits (a lost answer) is this review’s: Continue', () => {
        const saved = page({ ...DRAFT, title: EDITS.title, content: EDITS.content });
        expect(
            reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: saved }, edits: EDITS }),
        ).toMatchObject({
            save: 'Continue',
            keep: false,
            sendEdits: true,
        });
    });

    it('a receipt saved elsewhere from the socio’s draft (or with no draft): Continue without the edits, kept', () => {
        const legacy = { id: 'page-1', spaceId: 'space-1', title: DRAFT.title } as never;
        for (const saved of [page(), legacy]) {
            expect(
                reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: saved }, edits: EDITS }),
            ).toMatchObject({
                heading: REVIEW_SAVED,
                lines: [{ text: REVIEW_EDITS_KEPT, problem: false }],
                save: 'Continue',
                skip: false,
                edit: false,
                discard: true,
                keep: true,
                sendEdits: false,
            });
        }
        // Without edits, nothing to keep or send.
        expect(reviewSheetView(card(), { ...open, receipt: { kind: 'saved', page: page() } })).toMatchObject({
            save: 'Continue',
            keep: false,
            sendEdits: false,
        });
        // A new Save sends the edits.
        expect(reviewSheetView(card(), { ...open, edits: EDITS })).toMatchObject({ save: 'Save', sendEdits: true });
    });
});

describe('Skip with edits', () => {
    const screen = readFileSync(join(import.meta.dirname, '../../src/screens/page-review.tsx'), 'utf8');

    it('asks first when there are edits, as Discard edits does, and not without', () => {
        expect(skipConfirm(null)).toBeNull();
        expect(skipConfirm({ title: 'Launch notes', content: 'Mine' })).toEqual(SKIP_EDITS_CONFIRM);
        expect(DISCARD_EDITS_CONFIRM.title).toBe('Discard your edits?');
    });

    it('asks in Discard edits’ words: the same title and destructive button', () => {
        expect(SKIP_EDITS_CONFIRM.title).toBe(DISCARD_EDITS_CONFIRM.title);
        expect(SKIP_EDITS_CONFIRM.action).toBe(DISCARD_EDITS_CONFIRM.action);
        // Only the line differs: it says what Skip does besides.
        expect(SKIP_EDITS_CONFIRM.message).toMatch(/skipped/);
    });

    it('wires the sheet’s Skip through the confirm, never straight to the decision', () => {
        const button = /testID="page-review-skip"/.exec(screen);
        expect(button).not.toBeNull();
        const skipButton = screen.slice(screen.lastIndexOf('<Button', button!.index), button!.index);
        expect(skipButton).toContain('onPress={skip}');
        expect(screen).toMatch(/const skip = \(\) => \{\s*const confirm = skipConfirm\(edits\);/);
        expect(screen).toMatch(/Alert\.alert\(confirm\.title, confirm\.message/);
    });
});
