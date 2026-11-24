import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_WAIT, chatWaitCopy, REVIEW_HOLD_LINE, TURN_WAIT_MS } from '../../src/sync/chat-send';
import { openOutbox, type OutboxKind } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import {
    decideReview,
    openReviews,
    PAGE_REVIEW_IDS,
    PAGE_REVIEW_KIND,
    PAGE_REVIEW_VERSION,
    PAGE_REVIEW_VIEW,
    pageReviewKind,
    pageReviewWrite,
    reviewHold,
    reviewRowId,
    REVIEW_WAIT_MS,
} from '../../src/sync/page-review';

import { chatServer, cleanup, DOT, openChat, type Server, settle, setup, type Setup, THREAD } from './chat-server';

// The page review (Save and Skip only): its decision as an outbox row on a real outbox (user.db), history
// store (cache.db) and steering snapshot, against chat-server.ts's fake
// server, whose reviewed-page routes answer as src/server's do. Save asks for
// the receipt, saves, then sends the tool result as a run; Skip sends the
// declined result; a save whose answer was lost is never made twice; and a
// message waits while a review is open.

afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
});

const CALL = 'call-review-1';
const DRAFT = { title: 'Launch notes', content: '# Launch\n\nWhat shipped.', spaceId: 'space-1' };

let ids = 0;
const newId = () => `rv-${++ids}`;

async function reviewing(
    server: Server,
    args: unknown = DRAFT,
    reviewDecided?: (threadId: string, toolCallId: string) => void,
): Promise<Setup> {
    server.storeReview(CALL, args);
    const s = await setup(server, { reviews: true, ...(reviewDecided ? { reviewDecided } : {}) });
    await openChat(s);
    return s;
}

const decide = (s: Setup, approved: boolean, args: unknown = DRAFT, edits?: { title: string; content: string }) =>
    decideReview(s.outbox, {
        threadId: THREAD,
        dotId: DOT,
        toolCallId: CALL,
        args,
        approved,
        newId,
        ...(edits ? { edits } : {}),
    });

/** The tool results the runs carried. */
const toolResults = (server: Server) =>
    server.runBodies.flat().flatMap((message) => (message.role === 'tool' ? [message] : []));

describe('a page review’s decision', () => {
    it('Save asks for the receipt, saves the draft, then answers the socio with the page as the run’s only message', async () => {
        const server = chatServer();
        const s = await reviewing(server);
        expect(openReviews(s.histories.history(THREAD).list())).toEqual([{ toolCallId: CALL, args: DRAFT }]);
        await decide(s, true);
        await settle(s);
        expect(server.log.filter((line) => line.includes('reviewed-page'))).toEqual([
            `GET /api/conversations/${THREAD}/reviewed-page/${CALL}`,
            `POST /api/conversations/${THREAD}/reviewed-page`,
        ]);
        expect(server.runBodies).toHaveLength(1);
        const [message] = server.runBodies[0]!;
        expect(message).toMatchObject({ role: 'tool', toolCallId: CALL });
        expect(JSON.parse(message!.content as string)).toEqual({
            approved: true,
            pageId: 'page-1',
            spaceId: 'space-1',
            url: '/spaces/space-1/pages/page-1',
        });
        // Settled at RUN_STARTED, then gone once the history stored the result.
        expect(s.outbox.rows()).toEqual([]);
        expect(s.outbox.resolve(PAGE_REVIEW_IDS, reviewRowId(THREAD, CALL))).toBe(message!.id);
        expect(openReviews(s.histories.history(THREAD).list())).toEqual([]);
    });

    it('Skip saves nothing and sends the declined result', async () => {
        const server = chatServer();
        const s = await reviewing(server);
        await decide(s, false);
        await settle(s);
        expect(server.reviewPosts).toBe(0);
        expect(toolResults(server).map((message) => JSON.parse(message.content as string))).toEqual([
            { approved: false, message: 'The owner declined this draft. Do not save it.' },
        ]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a save whose answer was lost is restored from its receipt on the retry, never made twice', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.reviewScripts.push('drop');
        const s = await reviewing(server);
        await decide(s, true);
        await settle(s);
        expect(server.reviewPosts).toBe(1);
        expect(server.runBodies).toEqual([]);
        expect(s.outbox.rows()[0]).toMatchObject({ state: 'queued', lastError: 'away' });
        await vi.advanceTimersByTimeAsync(1_000);
        await settle(s);
        expect(server.reviewPosts).toBe(1);
        expect(toolResults(server)).toHaveLength(1);
        expect(JSON.parse(toolResults(server)[0]!.content as string)).toMatchObject({
            approved: true,
            pageId: 'page-1',
        });
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a run whose answer was lost after the server took it is found in the replay, and goes once', async () => {
        const server = chatServer();
        server.runScripts.push('drop');
        const s = await reviewing(server);
        await decide(s, false);
        await settle(s);
        // Unknown, then checked: the running turn's input holds the result.
        expect(server.runBodies).toHaveLength(1);
        expect(server.connects.asked).toBeGreaterThan(0);
        server.finishTurn();
        await s.histories.history(THREAD).pull();
        await settle(s);
        expect(s.outbox.rows()).toEqual([]);
        expect(toolResults(server)).toHaveLength(1);
    });

    it('a run the server refuses as busy (409 thread_running, CB-357) waits for the turn, never unknown, and goes once', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.runScripts.push('busy-elsewhere');
        const s = await reviewing(server);
        await decide(s, false);
        await settle(s);
        expect(server.runBodies).toHaveLength(1);
        expect(server.connects.asked).toBe(0);
        expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['queued', CHAT_WAIT.turn]]);
        server.finishTurn();
        await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);
        await settle(s);
        expect(server.runBodies).toHaveLength(2);
        expect(server.runBodies[1]).toEqual([expect.objectContaining({ role: 'tool', toolCallId: CALL })]);
        await s.histories.history(THREAD).pull();
        await settle(s);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a review answered elsewhere sends nothing more', async () => {
        const server = chatServer();
        const s = await reviewing(server);
        server.answerReview(CALL);
        await decide(s, true);
        await settle(s);
        expect(server.reviewPosts).toBe(0);
        expect(server.runBodies).toEqual([]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a receipt saved from another draft refuses Save, and Skip then answers in its place', async () => {
        const server = chatServer();
        server.receipts.set(CALL, {
            id: 'page-9',
            spaceId: 'space-1',
            reviewDraft: { title: 'Older', content: 'Other text', spaceId: 'space-1' },
        });
        const s = await reviewing(server);
        await decide(s, true);
        await settle(s);
        expect(s.outbox.unsent()).toMatchObject([{ id: reviewRowId(THREAD, CALL), reason: 'conflict' }]);
        const shown = overlaysOf({
            rows: s.outbox.rows(),
            unsent: s.outbox.unsent(),
            kinds: [PAGE_REVIEW_VIEW],
            scope: s.outbox,
        });
        expect(shown).toMatchObject([
            { state: 'unsent', reason: 'conflict', value: { toolCallId: CALL, approved: true } },
        ]);
        await decide(s, false);
        await settle(s);
        expect(s.outbox.unsent()).toEqual([]);
        expect(toolResults(server).map((message) => JSON.parse(message.content as string).approved)).toEqual([false]);
    });

    it('the page it saved deleted since: Skip still answers', async () => {
        const server = chatServer();
        server.receipts.set(CALL, 'deleted');
        const s = await reviewing(server);
        await decide(s, false);
        await settle(s);
        expect(toolResults(server)).toHaveLength(1);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a receipt the socio can no longer read (403): Skip still answers, Save is refused', async () => {
        const server = chatServer();
        server.receipts.set(CALL, 'forbidden');
        const s = await reviewing(server);
        await decide(s, true);
        await settle(s);
        expect(s.outbox.unsent()).toMatchObject([{ id: reviewRowId(THREAD, CALL), reason: 'http-403' }]);
        await decide(s, false);
        await settle(s);
        expect(s.outbox.unsent()).toEqual([]);
        expect(toolResults(server).map((message) => JSON.parse(message.content as string).approved)).toEqual([false]);
        expect(s.outbox.rows()).toEqual([]);
    });
});

describe('the lane hold while a review is open', () => {
    it('a receipt answering 403: Skip answers, and the held message goes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.receipts.set(CALL, 'forbidden');
        const s = await reviewing(server);
        await s.send('one more thing', 'm-1');
        await settle(s);
        expect(server.count('one more thing')).toBe(0);
        await decide(s, false);
        await settle(s);
        await vi.advanceTimersByTimeAsync(REVIEW_WAIT_MS);
        await settle(s);
        expect(server.count('one more thing')).toBe(1);
        expect(server.runBodies.map((body) => body.map((message) => message.role))).toEqual([['tool'], ['user']]);
        expect(s.outbox.unsent()).toEqual([]);
    });

    it('a Skip whose run the server refuses holds no message: it goes, and closes the review', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        const s = await reviewing(server);
        await s.send('one more thing', 'm-1');
        await settle(s);
        expect(server.count('one more thing')).toBe(0);
        server.runScripts.push({ status: 403, body: { error: 'Forbidden.' } });
        await decide(s, false);
        await settle(s);
        expect(s.outbox.unsent()).toMatchObject([{ id: reviewRowId(THREAD, CALL) }]);
        await vi.advanceTimersByTimeAsync(REVIEW_WAIT_MS);
        await settle(s);
        expect(server.count('one more thing')).toBe(1);
    });

    it('a message waits until the person decides, then goes after the decision', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        const s = await reviewing(server);
        await s.send('one more thing', 'm-1');
        await settle(s);
        expect(server.count('one more thing')).toBe(0);
        expect(s.outbox.rows()[0]).toMatchObject({ id: 'm-1', state: 'queued', lastError: CHAT_WAIT.review });
        expect(chatWaitCopy(CHAT_WAIT.review, 'Ada')).toBe(REVIEW_HOLD_LINE);
        await vi.advanceTimersByTimeAsync(REVIEW_WAIT_MS);
        await settle(s);
        expect(server.count('one more thing')).toBe(0);
        await decide(s, false);
        await settle(s);
        await vi.advanceTimersByTimeAsync(REVIEW_WAIT_MS);
        await settle(s);
        expect(server.count('one more thing')).toBe(1);
        // The tool result went first, then the message in its own run.
        expect(server.runBodies.map((body) => body.map((message) => message.role))).toEqual([['tool'], ['user']]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('holds only for a review in the newest run with no decision sent', () => {
        const server = chatServer();
        server.storeReview(CALL, DRAFT);
        const history = { threadId: THREAD, list: () => server.runs };
        const none = { resolve: () => null };
        const hold = reviewHold(() => []);
        expect(hold(null, none, history)).toEqual({
            action: 'retry',
            delayMs: REVIEW_WAIT_MS,
            reason: CHAT_WAIT.review,
        });
        expect(hold(null, { resolve: () => 'result-1' }, history)).toBeNull();
        const row = (approved: boolean) => ({
            id: reviewRowId(THREAD, CALL),
            kind: PAGE_REVIEW_KIND,
            payload: JSON.stringify({
                threadId: THREAD,
                dotId: DOT,
                toolCallId: CALL,
                args: DRAFT,
                approved,
                resultId: 'r',
            }),
        });
        // A refused Save still holds (the person can Skip); a refused Skip doesn't.
        expect(reviewHold(() => [row(true)])(null, none, history)).not.toBeNull();
        expect(reviewHold(() => [row(false)])(null, none, history)).toBeNull();
        server.answerReview(CALL);
        expect(hold(null, none, history)).toBeNull();
    });
});

describe('a review saved with the person’s edits', () => {
    const EDITS = { title: 'Launch notes, edited ', content: '# Launch\n\nWhat shipped, and why.' };

    it('Save sends the edits (payload 2), answers the socio with edited: true, then clears the edits', async () => {
        const server = chatServer();
        const decided: string[] = [];
        const s = await reviewing(server, DRAFT, (thread, call) => decided.push(`${thread}:${call}`));
        await decide(s, true, DRAFT, EDITS);
        expect(s.outbox.rows()[0]).toMatchObject({ payloadVersion: PAGE_REVIEW_VERSION });
        await settle(s);
        // The server trims the title, as it stores it.
        expect(server.reviewBodies).toEqual([
            { title: 'Launch notes, edited', content: EDITS.content, spaceId: 'space-1', toolCallId: CALL },
        ]);
        expect(JSON.parse(toolResults(server)[0]!.content as string)).toMatchObject({
            approved: true,
            pageId: 'page-1',
            edited: true,
        });
        expect(decided).toEqual([`${THREAD}:${CALL}`]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('an unedited decision stays payload 1, so an older build still sends it', () => {
        const write = (edits?: typeof EDITS) =>
            pageReviewWrite({
                threadId: THREAD,
                dotId: DOT,
                toolCallId: CALL,
                args: DRAFT,
                approved: true,
                newId,
                ...(edits ? { edits } : {}),
            });
        expect(write().payloadVersion).toBe(1);
        expect(write(EDITS).payloadVersion).toBe(2);
        // Skip carries no edits.
        expect(
            pageReviewWrite({
                threadId: THREAD,
                dotId: DOT,
                toolCallId: CALL,
                args: DRAFT,
                approved: false,
                newId,
                edits: EDITS,
            }).payloadVersion,
        ).toBe(1);
    });

    it('a lost answer is retried with the same edits and restored from its receipt, saved once', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.reviewScripts.push('drop');
        const s = await reviewing(server);
        await decide(s, true, DRAFT, EDITS);
        await settle(s);
        expect(server.reviewPosts).toBe(1);
        expect(s.outbox.rows()[0]).toMatchObject({ state: 'queued', lastError: 'away' });
        await vi.advanceTimersByTimeAsync(1_000);
        await settle(s);
        expect(server.reviewPosts).toBe(1);
        expect(toolResults(server).map((message) => JSON.parse(message.content as string))).toMatchObject([
            { approved: true, pageId: 'page-1', edited: true },
        ]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a review decided elsewhere sends nothing and keeps the edits (reviewDecided not called)', async () => {
        const server = chatServer();
        const decided: string[] = [];
        const s = await reviewing(server, DRAFT, (thread, call) => decided.push(`${thread}:${call}`));
        server.answerReview(CALL);
        await decide(s, true, DRAFT, EDITS);
        await settle(s);
        expect(server.reviewPosts).toBe(0);
        expect(server.runBodies).toEqual([]);
        expect(decided).toEqual([]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('Continue on a receipt saved elsewhere from the socio’s draft (or with none) answers with it and keeps the edits', async () => {
        for (const reviewDraft of [DRAFT, undefined]) {
            const server = chatServer();
            const decided: string[] = [];
            server.receipts.set(CALL, {
                id: 'page-7',
                spaceId: 'space-1',
                title: DRAFT.title,
                ...(reviewDraft === undefined ? {} : { reviewDraft }),
            });
            const s = await reviewing(server, DRAFT, (thread, call) => decided.push(`${thread}:${call}`));
            // The sheet's Continue (sendEdits false): a Save without the edits.
            await decide(s, true);
            expect(s.outbox.rows()[0]).toMatchObject({ payloadVersion: 1 });
            await settle(s);
            expect(server.reviewPosts).toBe(0);
            const [result] = toolResults(server).map((message) => JSON.parse(message.content as string));
            expect(result).toMatchObject({ approved: true, pageId: 'page-7' });
            expect(result.edited).toBeFalsy();
            // The page doesn't hold the edits: they stay for Copy and Save as a new page.
            expect(decided).toEqual([]);
            expect(s.outbox.rows()).toEqual([]);
            expect(s.outbox.unsent()).toEqual([]);
            await cleanup();
        }
    });

    it('a Skip from this phone clears the edits once it reaches the chat', async () => {
        const server = chatServer();
        const decided: string[] = [];
        const s = await reviewing(server, DRAFT, (thread, call) => decided.push(`${thread}:${call}`));
        await decide(s, false, DRAFT, EDITS);
        await settle(s);
        expect(decided).toEqual([`${THREAD}:${CALL}`]);
    });

    it('a receipt holding other edits refuses the save as a conflict', async () => {
        const server = chatServer();
        server.receipts.set(CALL, {
            id: 'page-9',
            spaceId: 'space-1',
            reviewDraft: { title: 'Other edits', content: 'Not these', spaceId: 'space-1' },
        });
        const s = await reviewing(server);
        await decide(s, true, DRAFT, EDITS);
        await settle(s);
        expect(s.outbox.unsent()).toMatchObject([{ id: reviewRowId(THREAD, CALL), reason: 'conflict' }]);
        expect(server.reviewPosts).toBe(0);
    });

    it('edits over the limits (or with no text) never save: the row goes to unsent as invalid-draft', async () => {
        const server = chatServer();
        const s = await reviewing(server);
        await decide(s, true, DRAFT, { title: 'Empty', content: '  ' });
        await settle(s);
        expect(s.outbox.unsent()).toMatchObject([{ reason: 'invalid-draft' }]);
        expect(server.reviewPosts).toBe(0);
        // Retry in place with fixed edits: the same row, sent.
        await decide(s, true, DRAFT, EDITS);
        await settle(s);
        expect(s.outbox.unsent()).toEqual([]);
        expect(server.reviewBodies).toMatchObject([{ content: EDITS.content }]);
    });

    it('an older build keeps a version 2 row without sending it', async () => {
        const server = chatServer();
        const s = await reviewing(server);
        const older = { ...pageReviewKind({ histories: s.histories, steering: s.steering, newId }), payloadVersion: 1 };
        const { file } = s;
        await s.outbox.dispose();
        const outbox = await openOutbox({
            db: file.db,
            state: file.state,
            kinds: [older as OutboxKind<unknown>],
            fetch: server.fetch,
        });
        await outbox.enqueue(
            pageReviewWrite({
                threadId: THREAD,
                dotId: DOT,
                toolCallId: CALL,
                args: DRAFT,
                approved: true,
                newId,
                edits: EDITS,
            }),
        );
        outbox.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(server.reviewPosts).toBe(0);
        expect(outbox.status()).toMatchObject({ undecodable: 1 });
        expect(outbox.rows()).toMatchObject([{ id: reviewRowId(THREAD, CALL), state: 'queued', payloadVersion: 2 }]);
        await outbox.dispose();
    });
});
