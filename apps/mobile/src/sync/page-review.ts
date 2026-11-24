import type { Message, ToolCall } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import {
    decidePageReview,
    pageReviewApproved,
    pageReviewDeclined,
    type PageReviewEdits,
    type PageReviewRequest,
    pageReviewTool,
    parsePageReviewArgs,
} from '@socio/shared/pages/page-review';

import { AbortedError, NetworkError } from '../net/errors';
import { unhandledRunFailure } from '../net/run-answer';

import { CHAT_WAIT, type ChatSendOptions, startRun, TURN_WAIT_MS } from './chat-send';
import type { ChatHistory, HistoryStore } from './history';
import {
    type CheckOutcome,
    HeldForSignIn,
    type NewOutboxWrite,
    type Outbox,
    type OutboxContext,
    type OutboxKind,
    type SendOutcome,
    type UnsentWrite,
} from './outbox';
import { type Answer, classify, readAnswer, reasonOf } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { reviewEditsError } from './review-edits';
import type { SteeringStore } from './steering';
import { recoverRun } from './turn-recovery';

// The page review:
// `review_space_page`, the one tool the app runs, declared in every run
// (the run client's RUN_TOOLS): Save and Skip, and editing before a Save.
//
// - **The decision is an outbox row** (kind `page-review`, lane
//   `review:<threadId>`, id `review:<threadId>:<toolCallId>`, so one per
//   review): `decidePageReview` (shared, as the web's card) asks for the
//   receipt first, so a save whose answer was lost is never made twice, then
//   saves on Save; then the tool's result goes as a run whose body is the
//   stored history plus exactly that tool message, through
//   chat-send's `startRun`. It settles at RUN_STARTED, recording the result's
//   message id in `ids` (`PAGE_REVIEW_IDS`), and stays `sent` until the
//   history stores it.
// - **Already answered** (a message reached the server and closed the
//   review as skipped, `withReviewsClosed`, or it was decided on the web):
//   nothing is sent. Skip still answers when the receipt can't be had (any
//   4xx but 401, 408 and 429: the page it saved was deleted, the socio no
//   longer reads its Space, or saved from another draft), so a review never
//   stays open for good; Save then goes to `unsent` with its reason.
// - **The lane hold**: before a private chat's message goes, its
//   lane's pre-pull reads the newest stored run. While it waits on a review
//   with no decision sent (`openReviews`, `ids`), the message waits too
//   ("Your message will send after you decide"), since its arrival would
//   close the review as skipped. It goes once the decision's run started,
//   an explicit Skip included, or once the server refused a Skip (its row
//   `unsent`: the message's arrival skips the review in its place).
// - **The check** of a decision whose run may have gone: the result's
//   id stored, or in a replayed run's input (`recoverRun`), is sent;
//   absent with no turn running goes again, which asks the receipt again.
//
// - **Edits**: the person's edits
//   live in `drafts` under `review:<threadId>:<toolCallId>` (review-edits.ts)
//   until the review ends. Save sends a copy in the row (`edits`, payload
//   version 2: an older build keeps such a row without sending it), through
//   shared's `decidePageReview` with the edits, and answers the socio with
//   `edited: true`. Edits over the page limits never queue and, if one got
//   in, go to `unsent` as `invalid-draft`. Once this phone's decision reaches
//   the chat (its run started, or its result is stored), `reviewDecided`
//   clears the edits; a review answered elsewhere leaves them for Copy and
//   "Save as a new page", as does this phone's Continue on a receipt saved
//   elsewhere from another version (a Save without edits: only a Save that
//   carried the edits, or a Skip, clears them).
//
// No React Native: tests/sync runs it under Node against a fake server.

export const PAGE_REVIEW_KIND = 'page-review';
/** The newest payload this build reads: 2 carries the person's edits; an unedited decision stays 1. */
export const PAGE_REVIEW_VERSION = 2;
/** The payload version of a decision: 2 only with edits, so an older build still sends an unedited one. */
const versionOf = (payload: Pick<PageReviewPayload, 'edits'>) =>
    payload.edits === undefined ? 1 : PAGE_REVIEW_VERSION;
/** The `ids` map's kind: a decision row's id to its tool result's message id. */
export const PAGE_REVIEW_IDS = 'page-review';
/** How often a message held by an open review looks again (one history pull each). */
export const REVIEW_WAIT_MS = 10_000;

/** The decisions' lane of a chat: never the chat's message lane, which they hold. */
export const reviewLane = (threadId: string) => `review:${threadId}`;
/** A review's decision row id: one per review. */
export const reviewRowId = (threadId: string, toolCallId: string) => `review:${threadId}:${toolCallId}`;
/** The chat a decisions' lane is, or null for another lane. */
export const reviewLaneThread = (lane: string): string | null => (lane.startsWith('review:') ? lane.slice(7) : null);

/** A page review's decision, as its outbox row keeps it. */
export interface PageReviewPayload {
    readonly threadId: string;
    readonly dotId: string;
    readonly toolCallId: string;
    /** The draft as the socio sent it (the call's arguments): what the receipt is compared with. */
    readonly args: unknown;
    /** Save (true) or Skip (false). */
    readonly approved: boolean;
    /** The tool result message's id, made as the person decides: what the run carries and the history stores. */
    readonly resultId: string;
    /** The person's title and Markdown in place of the socio's (version 2): saved instead of the draft. */
    readonly edits?: PageReviewEdits;
}

export interface PageReviewDecision {
    readonly threadId: string;
    readonly dotId: string;
    readonly toolCallId: string;
    readonly args: unknown;
    readonly approved: boolean;
    /** Save with these edits; ignored by Skip. */
    readonly edits?: PageReviewEdits;
    /** A fresh id (expo-crypto): the result's message id and the idempotency key. */
    readonly newId: () => string;
}

/** The outbox write of a decision. */
export function pageReviewWrite(decision: PageReviewDecision): NewOutboxWrite {
    const { threadId, dotId, toolCallId, args, approved, newId } = decision;
    const payload: PageReviewPayload = {
        threadId,
        dotId,
        toolCallId,
        args,
        approved,
        resultId: newId(),
        ...editsOf(decision),
    };
    return {
        id: reviewRowId(threadId, toolCallId),
        lane: reviewLane(threadId),
        kind: PAGE_REVIEW_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: versionOf(payload),
        idempotencyKey: newId(),
    };
}

/** A Save's edits as the payload keeps them (none for Skip). */
const editsOf = ({ approved, edits }: Pick<PageReviewDecision, 'approved' | 'edits'>) =>
    approved && edits !== undefined ? { edits: { title: edits.title, content: edits.content } } : {};

/**
 * Saves or skips a review: a new decision row, or, for one the server
 * refused (Save's conflict, say), that row changed in place and sent again
 * (Skip after a refused Save, or Retry with the same choice).
 */
export async function decideReview(
    outbox: Pick<Outbox, 'enqueue' | 'unsent' | 'editUnsent' | 'retryUnsent'>,
    decision: PageReviewDecision,
): Promise<void> {
    const id = reviewRowId(decision.threadId, decision.toolCallId);
    const refused = outbox.unsent().find((write) => write.id === id);
    if (refused === undefined) {
        await outbox.enqueue(pageReviewWrite(decision));
        return;
    }
    const { threadId, dotId, toolCallId, args, resultId } = decodePayload(refused.payload);
    // The same result id: a run that may have gone with it is still found (`check`).
    const payload: PageReviewPayload = {
        threadId,
        dotId,
        toolCallId,
        args,
        approved: decision.approved,
        resultId,
        ...editsOf(decision),
    };
    if (JSON.stringify(payload) !== refused.payload) {
        await outbox.editUnsent(id, { payload: JSON.stringify(payload), payloadVersion: versionOf(payload) });
    }
    await outbox.retryUnsent(id, decision.newId());
}

function decodePayload(text: string): PageReviewPayload {
    const value = JSON.parse(text) as Partial<PageReviewPayload> | null;
    if (
        !value ||
        typeof value.threadId !== 'string' ||
        typeof value.dotId !== 'string' ||
        typeof value.toolCallId !== 'string' ||
        typeof value.approved !== 'boolean' ||
        typeof value.resultId !== 'string' ||
        (value.edits !== undefined &&
            (typeof value.edits?.title !== 'string' || typeof value.edits.content !== 'string'))
    ) {
        throw new TypeError('Not a page review decision.');
    }
    return value as PageReviewPayload;
}

/** A review call in a run: its id and the draft as sent. */
export interface ReviewCall {
    readonly toolCallId: string;
    /** The call's arguments, parsed from their JSON text (undefined when they don't read). */
    readonly args: unknown;
}

/** The arguments of a call, parsed. */
export function callArgs(call: Pick<ToolCall, 'function'>): unknown {
    try {
        return JSON.parse(call.function.arguments);
    } catch {
        return undefined;
    }
}

/** The review calls among `messages` that have no result among them. */
function unanswered(messages: readonly Message[]): ReviewCall[] {
    const answered = new Set(messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : [])));
    return messages.flatMap((message) =>
        message.role === 'assistant'
            ? (message.toolCalls ?? [])
                  .filter((call) => call.function.name === pageReviewTool.name && !answered.has(call.id))
                  .map((call) => ({ toolCallId: call.id, args: callArgs(call) }))
            : [],
    );
}

/**
 * The reviews open in a chat: the newest stored run's review calls
 * with no result, once that run has ended (it waits on them, `waitsOnTool`).
 */
export function openReviews(runs: readonly HistoryRun[]): ReviewCall[] {
    const newest = runs.at(-1);
    return newest === undefined || newest.status === 'running' ? [] : unanswered(newest.messages);
}

/** The tool result for a call in the stored history, or null. */
function resultOf(history: Pick<ChatHistory, 'list'>, toolCallId: string): Message | null {
    for (const run of history.list()) {
        for (const message of run.messages) {
            if (message.role === 'tool' && message.toolCallId === toolCallId) {
                return message;
            }
        }
    }
    return null;
}

/** A refused Skip (its row `unsent`): the person can't clear it, so it holds no message. */
function refusedSkip(write: Pick<UnsentWrite, 'kind' | 'payload'>): boolean {
    if (write.kind !== PAGE_REVIEW_KIND) {
        return false;
    }
    try {
        return !decodePayload(write.payload).approved;
    } catch {
        return false;
    }
}

/**
 * The chat message kind's `prepare` hook, over the outbox's refused
 * rows: after the lane's pre-pull, a message waits while the newest stored
 * run waits on a review whose decision hasn't reached the server (`ids` has
 * none). It looks again every `REVIEW_WAIT_MS`. A review whose Skip the
 * server refused holds nothing: the message goes, and its arrival closes the
 * review as skipped, which is what the Skip asked.
 */
export function reviewHold(unsent: () => readonly Pick<UnsentWrite, 'id' | 'kind' | 'payload'>[]) {
    return (
        _write: unknown,
        context: Pick<OutboxContext, 'resolve'>,
        history: Pick<ChatHistory, 'list' | 'threadId'>,
    ): SendOutcome | null => {
        const waiting = openReviews(history.list()).filter(
            (call) => context.resolve(PAGE_REVIEW_IDS, reviewRowId(history.threadId, call.toolCallId)) === null,
        );
        if (waiting.length === 0) {
            return null;
        }
        const skipped = new Set(unsent().flatMap((write) => (refusedSkip(write) ? [write.id] : [])));
        const open = waiting.filter((call) => !skipped.has(reviewRowId(history.threadId, call.toolCallId)));
        return open.length === 0 ? null : { action: 'retry', delayMs: REVIEW_WAIT_MS, reason: CHAT_WAIT.review };
    };
}

/** The overlay's value: what the review's card shows until the history holds its result. */
export interface PageReviewOverlay {
    readonly threadId: string;
    readonly toolCallId: string;
    readonly approved: boolean;
}

/** How a decision's row reads and looks, without what sends it: the chat's cards lay it over. */
export const PAGE_REVIEW_VIEW: OverlayKind<PageReviewPayload> = {
    kind: PAGE_REVIEW_KIND,
    payloadVersion: PAGE_REVIEW_VERSION,
    decode: (payload) => decodePayload(payload),
    overlay({ id, payload }): Overlay {
        const value: PageReviewOverlay = {
            threadId: payload.threadId,
            toolCallId: payload.toolCallId,
            approved: payload.approved,
        };
        return { collection: 'review', key: id, mode: 'insert', value };
    },
};

/** A request's answer that wasn't a 2xx, from the page review's request. */
class ReviewAnswer extends Error {
    override name = 'ReviewAnswer';

    constructor(readonly answer: Answer) {
        super(`HTTP ${answer.status}`);
    }
}

/** A refusal a Skip answers through: any 4xx but sign-in (401), a timeout (408) and a rate limit (429), which pass. */
const skipAnswers = (status: number) =>
    status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

/** The app's path of a saved page (the web's `spacePath`): the tool result's `url`. */
export const reviewedPagePath = (spaceId: string, pageId: string) =>
    `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;

export type PageReviewOptions = Pick<ChatSendOptions, 'newId' | 'me' | 'follows' | 'onTurn' | 'afterWrite'> & {
    readonly histories: Pick<HistoryStore, 'history'>;
    readonly steering: Pick<SteeringStore, 'steering'>;
    /**
     * This phone's decision reached the chat (its run started, or its result
     * is stored): the review's edits in `drafts` go. Called only
     * for a Save that carried the edits, or a Skip: not for a Save without
     * them (Continue on a receipt saved elsewhere), nor for a review answered
     * elsewhere, whose edits stay.
     */
    readonly reviewDecided?: (threadId: string, toolCallId: string) => void;
};

/** The page review's decision kind, over the scope's histories and steering snapshots. */
export function pageReviewKind(options: PageReviewOptions): OutboxKind<PageReviewPayload> {
    const { histories, steering, newId, reviewDecided = () => {} } = options;

    async function pullChat(threadId: string) {
        const chat = steering.steering(threadId);
        const history = histories.history(threadId);
        await chat.refresh();
        const pulled = await history.pull();
        return { history, chat, ok: !chat.state.failed && chat.state.ready && pulled };
    }

    const done = (serverId: string): SendOutcome => ({ action: 'done', serverId, awaitStored: true });
    /**
     * The result `serverId` is this row's own: its edits are done with, when
     * it saved them or skipped. A Save without them (Continue on a receipt
     * saved elsewhere) leaves them: the page doesn't hold them.
     */
    const ours = (payload: PageReviewPayload, serverId: string) => {
        if (serverId === payload.resultId && (!payload.approved || payload.edits !== undefined)) {
            reviewDecided(payload.threadId, payload.toolCallId);
        }
    };

    /** The tool's result: the page saved, or nothing; else what the row does. */
    async function decide(
        payload: PageReviewPayload,
        context: OutboxContext,
    ): Promise<{ readonly result: unknown } | SendOutcome> {
        const { threadId, toolCallId, args, approved, edits } = payload;
        if (approved && !parsePageReviewArgs(args).success) {
            // The sheet offers only Skip for a draft that doesn't read.
            return { action: 'unsent', reason: 'invalid-draft' };
        }
        if (approved && edits !== undefined && reviewEditsError(edits) !== undefined) {
            // The sheet never queues these (checked on the device): the server would refuse them.
            return { action: 'unsent', reason: 'invalid-draft' };
        }
        const request: PageReviewRequest = async <T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
            const response = await context.fetch(`/api${path}`, method === 'POST' ? { method, json: body } : {});
            const answer = await readAnswer(response, context.signal);
            if (answer.status >= 200 && answer.status < 300) {
                return answer.body as T;
            }
            throw new ReviewAnswer(answer);
        };
        try {
            const saving = approved ? edits : undefined;
            const page = await decidePageReview(request, threadId, toolCallId, args, approved, saving);
            return {
                result:
                    page === null
                        ? pageReviewDeclined(args)
                        : pageReviewApproved(page, reviewedPagePath(page.spaceId, page.id), {
                              edited: saving !== undefined,
                          }),
            };
        } catch (error) {
            if (error instanceof HeldForSignIn || error instanceof AbortedError) {
                throw error;
            }
            if (error instanceof NetworkError) {
                // Safe to repeat: the next try asks for the receipt first.
                return { action: 'retry', reason: 'away' };
            }
            if (!(error instanceof ReviewAnswer)) {
                // decidePageReview's own refusal: the receipt is another draft's.
                return approved ? { action: 'unsent', reason: 'conflict' } : { result: pageReviewDeclined(args) };
            }
            const { answer } = error;
            if (!approved && skipAnswers(answer.status)) {
                // A Skip saves nothing, so a receipt it can't read (deleted, the
                // Space no longer readable, gone) never keeps the review open.
                return { result: pageReviewDeclined(args) };
            }
            if (answer.status === 404) {
                return { action: 'unsent', reason: 'gone' };
            }
            if (answer.status === 410) {
                // The page this review saved was deleted since.
                return { action: 'unsent', reason: 'deleted' };
            }
            const action = classify(answer, { method: 'POST' });
            switch (action.action) {
                case 'retry':
                case 'unknown':
                    // A 5xx, or the server away: the receipt makes another try safe.
                    return { action: 'retry', reason: reasonOf(answer) };
                case 'back-off':
                    return action.delayMs === null
                        ? { action: 'retry', reason: action.reason }
                        : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
                default:
                    return { action: 'unsent', reason: reasonOf(answer) };
            }
        }
    }

    return {
        kind: PAGE_REVIEW_KIND,
        payloadVersion: PAGE_REVIEW_VERSION,
        repeatable: false,
        creates: PAGE_REVIEW_IDS,
        decode: (payload) => decodePayload(payload),

        async send({ payload }, context) {
            const { history, chat, ok } = await pullChat(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                return { action: 'unsent', reason: 'gone' };
            }
            if (!ok) {
                // Nothing went yet: the answer to "already answered?" waits for a pull.
                return { action: 'retry', reason: 'away' };
            }
            const stored = resultOf(history, payload.toolCallId);
            if (stored !== null) {
                // Answered already: ours, or closed as skipped by a message, or decided on the web.
                ours(payload, stored.id);
                return done(stored.id);
            }
            const decided = await decide(payload, context);
            if ('action' in decided) {
                return decided;
            }
            if (chat.state.running) {
                // A turn runs (it would take no tool result now): once it ends.
                return { action: 'retry', delayMs: TURN_WAIT_MS, reason: CHAT_WAIT.turn };
            }
            const message: Message = {
                id: payload.resultId,
                role: 'tool',
                toolCallId: payload.toolCallId,
                content: JSON.stringify(decided.result),
            };
            const start = await startRun(options, context, history, {
                threadId: payload.threadId,
                dotId: payload.dotId,
                message,
            });
            if (start.kind === 'started') {
                ours(payload, payload.resultId);
                return done(payload.resultId);
            }
            const { failure } = start;
            switch (failure.action) {
                case 'retry':
                    // No answer, or a proxy's: the run may have started. A server draining took nothing.
                    return start.answered && failure.draining === true
                        ? { action: 'retry', reason: 'away' }
                        : { action: 'unknown', reason: start.answered ? 'away' : 'no-answer' };
                case 'wait':
                    return { action: 'retry', delayMs: failure.retryAfterMs, reason: failure.code ?? 'cycle_rate' };
                case 'setup':
                    return { action: 'hold', reason: CHAT_WAIT.setup };
                case 'sign-in':
                    throw new HeldForSignIn('401 to a run');
                case 'unsent':
                    return { action: 'unsent', reason: failure.reason };
                case 'reupload':
                    return { action: 'unsent', reason: 'content' };
                case 'busy':
                    // A 409 `thread_running` (CB-357): a turn runs and the server took
                    // nothing; a tool result waits for the turn to end, as above.
                    return { action: 'retry', delayMs: TURN_WAIT_MS, reason: CHAT_WAIT.turn };
                case 'stopped':
                case 'ambiguous':
                    return { action: 'unknown', reason: start.accepted ? 'accepted' : failure.action };
                default:
                    return unhandledRunFailure(failure);
            }
        },

        async check({ payload }, context): Promise<CheckOutcome> {
            const { history, chat, ok } = await pullChat(payload.threadId);
            if (history.state.gone || chat.state.gone) {
                // Its send finds the chat gone and moves it to `unsent`.
                return { action: 'not-sent' };
            }
            if (!ok) {
                throw new NetworkError(`/api/conversations/${encodeURIComponent(payload.threadId)}`);
            }
            const stored = resultOf(history, payload.toolCallId);
            if (stored !== null) {
                ours(payload, stored.id);
                return { action: 'sent', serverId: stored.id, awaitStored: true };
            }
            const recovery = await recoverRun({
                id: payload.resultId,
                dotId: payload.dotId,
                threadId: payload.threadId,
                after: history.list().at(-1)?.seq ?? null,
                fetch: context.fetch,
                signal: context.signal,
                newId,
                stored: async (id) => (await history.pull()) && history.has(id),
                probe: async () => (await pullChat(payload.threadId)).ok,
            });
            if (recovery === 'stored') {
                ours(payload, payload.resultId);
                return { action: 'sent', serverId: payload.resultId, awaitStored: true };
            }
            if (recovery === 'gave-up' || chat.state.running) {
                return { action: 'later' };
            }
            // Nothing reached a run: it goes again, and asks for the receipt first.
            return { action: 'not-sent' };
        },

        overlay: PAGE_REVIEW_VIEW.overlay,
    };
}

/**
 * Settles the decisions' `sent` rows as their results are stored, like
 * chat-send's `followStoredChats` for a chat's lane: a row that becomes
 * `sent` while the history already holds its result goes at once (the
 * scope's `onRuns` settles the rest). Returns the unsubscribe.
 */
export function followStoredReviews(
    outbox: Pick<Outbox, 'subscribe' | 'caughtUp'>,
    histories: Pick<HistoryStore, 'held' | 'history'>,
    onError: (error: unknown) => void = () => {},
): () => void {
    return outbox.subscribe((change) => {
        if (change.type !== 'upsert' || change.row.state !== 'sent') {
            return;
        }
        const threadId = reviewLaneThread(change.row.lane);
        if (threadId !== null && histories.held().includes(threadId)) {
            const history = histories.history(threadId);
            outbox.caughtUp(change.row.lane, (id) => history.has(id)).catch(onError);
        }
    });
}
