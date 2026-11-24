import type { IssueComment, IssueDetail } from '@socio/shared/issues/issue-types';

import { NetworkError } from '../net/errors';

import type { Drafts } from './chat-drafts';
import { answeredWithError, issueCommentsDraft } from './issue-create';
import type { IssueDetails } from './issue-details';
import { isLocalIssue, ISSUE_IDS, serverIssueKey, shownIssueKey } from './local-ids';
import type {
    CheckOutcome,
    NewOutboxWrite,
    Outbox,
    OutboxContext,
    OutboxKind,
    OutboxRow,
    OutboxWrite,
    SendOutcome,
    SettleStatements,
} from './outbox';
import { UNSENT_GONE } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, type WriteMethod } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { serverSince } from './server-clock';

// Issue comments:
// adding, editing and deleting a comment on an issue, each an outbox kind.
//
// - **Lane** `issue-comments:<issue>`, apart from the issue's create and
//   field edits (`issue:<issue>`, issue-create.ts and issue-edit.ts) and its
//   vote: a refused comment never holds a field edit, and a field edit never
//   holds a comment. A
//   comment on an issue filed offline (`CB-?`, a local key) waits for the
//   create (`dependsOn`) in the local key's lane, and a later one joins that
//   lane while it still holds a write, so comments keep their order across
//   the create's resolution (local-ids.ts, as new chats' writes do). Issue
//   attachments go in the same lane.
// - **Add** (`issue-comment`, `POST /api/issues/:n/comments {body}`). The
//   body is trimmed before it is queued, as the server stores it
//   (`commentInput`: `z.string().trim().min(1).max(10_000)`). The comment
//   has a local id (`pending-comment-<uuid>`) until its create resolves: the
//   server's id goes to `ids` (`issue-comment`), so an edit or a delete
//   written before then, and the files attached to it, name the local id.
//   Not safe to repeat (the server takes no Idempotency-Key): the outbox's
//   check reads the issue's detail fresh and keeps its comments by the person
//   (`authorId`, the payload's), with the same trimmed body, created at or
//   after `serverSince`, not among the comments the screen showed as the
//   person sent it (`seen`, issue-create.ts's `after` for comments) and no other write's
//   (`context.claimed`). One is the write's; two are "Couldn't confirm this
//   was sent"; none goes again after a request with no answer, and waits for
//   the person after an error answer (the server may still be saving it), as
//   the issue's create does. With neither bound (no Date seen, no detail held) an
//   older identical "+1" could pass for it, so even one match waits for the
//   person.
// - **Edit** (`comment-edit`, `PATCH …/comments/:id {body}`) and **delete**
//   (`comment-delete`, `DELETE …/comments/:id`, where a 404 or 410 is done)
//   are safe to repeat. A later edit of the same comment folds into the
//   queued one, and a delete drops the comment's queued edits.
// - **In place** (as chat-manage.ts's `editQueuedMessage`): editing or deleting a
//   comment not yet sent (its add queued, held or in `unsent`) changes or
//   removes its row there, with no request. Only one that may have reached
//   the server is edited or deleted over the network, after its add settles.
// - **Answers**, never the server's text: 400 is "couldn't be sent as
//   written"; a 403 on an edit or a delete is someone else's comment; 404
//   and 410 are the issue or the comment gone (`UNSENT_GONE`;
//   issue-details.ts's `onGone` also moves the lane). A readable 503 goes
//   again; a proxy's page, a plain 5xx or no answer to an add is `unknown`,
//   which the check settles.
// - **The hand-off**: an answer's comment goes into the issue's held
//   detail (`issueDetails.put`) before the row goes, so it never flickers
//   out, then the detail is read again (`afterWrite`, `notesForWrite`'s
//   `issue` topic).
// - **On screen** (`overlay`): rows of `issue-comments`, an added one by its
//   id (the server's once known) and an edit or a delete as a patch on it;
//   the issue screen lays them over the detail's comments.
//
// No React Native: tests/sync runs it under Node against a fake server.

export const ISSUE_COMMENT_KIND = 'issue-comment';
export const COMMENT_EDIT_KIND = 'comment-edit';
export const COMMENT_DELETE_KIND = 'comment-delete';
const VERSION = 1;

/** The `ids` map's kind for an added comment's server id. */
export const COMMENT_IDS = 'issue-comment';
/** What the overlays lay over: the issue detail's comments. */
export const ISSUE_COMMENTS = 'issue-comments';
/** The server's limit on a comment (`commentInput`). */
export const COMMENT_MAX_CHARS = 10_000;

/** Refusals' codes, which the Unsent list words. */
export const COMMENT_REFUSALS = {
    invalid: 'comment-invalid',
    /** A 403 on an edit or a delete: not the person's comment. */
    notYours: 'comment-not-yours',
    /** Its issue was filed offline and never created. */
    noIssue: 'no-issue',
    /** An edit of a comment whose add never reached the server. */
    noComment: 'no-comment',
} as const;

/** Issue `key`'s comments and attachments lane. */
export const issueCommentsLane = (key: string) => `issue-comments:${key}`;

const LOCAL_COMMENT_PREFIX = 'pending-comment-';
/** Whether `id` is a comment's local id, never the server's. */
export const isLocalComment = (id: string) =>
    id.startsWith(LOCAL_COMMENT_PREFIX) && id.length > LOCAL_COMMENT_PREFIX.length;
/** A new local comment id from a fresh UUID (expo-crypto). */
export const newLocalCommentId = (newId: () => string) => `${LOCAL_COMMENT_PREFIX}${newId()}`;

export interface IssueCommentPayload {
    /** The issue's key: its number, or its local key while filed offline. */
    readonly issue: string;
    /** Trimmed, as the server stores it. */
    readonly body: string;
    /** The person commenting (the scope's app user id): the check's author. */
    readonly authorId: string;
    /** The scope's newest Date header as the person sent it, or null. */
    readonly serverAt: number | null;
    /**
     * The ids of the comments the issue's detail showed as the person sent it
     * (`seenComments`), none of which is this one; null with no detail held.
     */
    readonly seen: readonly string[] | null;
}

/** The ids of the comments `detail` shows, for `commentOnIssue`'s `seen`; null with no detail. */
export const seenComments = (detail: Pick<IssueDetail, 'comments'> | null | undefined): string[] | null =>
    detail ? detail.comments.map((comment) => comment.id) : null;

export interface CommentEditPayload {
    readonly issue: string;
    /** The comment's id: the server's, or a local one its add resolves. */
    readonly commentId: string;
    readonly body: string;
}

export interface CommentDeletePayload {
    readonly issue: string;
    readonly commentId: string;
}

/** A comment's text the server won't take: blank, or over `COMMENT_MAX_CHARS` once trimmed. */
export class CommentError extends RangeError {
    override readonly name = 'CommentError';
}

/** `text` as the server stores it, or a throw (CommentError) for text it refuses. */
export function commentBody(text: string): string {
    const body = text.trim();
    if (body === '') {
        throw new CommentError('A comment needs some text.');
    }
    if (body.length > COMMENT_MAX_CHARS) {
        throw new CommentError(`A comment has at most ${COMMENT_MAX_CHARS.toLocaleString('en-US')} characters.`);
    }
    return body;
}

type Lanes = Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;

/**
 * Where a comment write on issue `issue` goes: for an issue not created yet,
 * its local key's lane after its create; for a number, the lane of a local
 * key that resolved to it while that lane still holds a write; else its own.
 */
export function commentRoute(outbox: Lanes, issue: string): { lane: string; dependsOn: string | null } {
    if (isLocalIssue(issue)) {
        return {
            lane: issueCommentsLane(issue),
            dependsOn: outbox.resolve(ISSUE_IDS, issue) === null ? issue : null,
        };
    }
    const prefix = issueCommentsLane('');
    for (const write of [...outbox.rows(), ...outbox.unsent()]) {
        const local = write.lane.startsWith(prefix) ? write.lane.slice(prefix.length) : null;
        if (local !== null && isLocalIssue(local) && outbox.resolve(ISSUE_IDS, local) === issue) {
            return { lane: write.lane, dependsOn: null };
        }
    }
    return { lane: issueCommentsLane(issue), dependsOn: null };
}

export interface CommentOnIssueOptions {
    readonly outbox: Lanes;
    readonly drafts: Pick<Drafts, 'enqueueFromDraft'>;
    /** A fresh UUID (expo-crypto): the local id and the row's idempotency key. */
    readonly newId: () => string;
    /** The issue's key as its screen holds it: a number, or a local key. */
    readonly issue: string;
    /** The scope's app user id. */
    readonly authorId: string;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt?: number | null;
    /**
     * `seenComments` of the issue's held detail. An issue filed offline has
     * none to show (`[]` by default); for a number, null means none held.
     */
    readonly seen?: readonly string[] | null;
    /** The box sent: the issue's comment box by default. */
    readonly draft?: string;
    /** Rows that go with the comment, in its transaction (attachments: one per file, each waiting on it). */
    readonly more?: (commentId: string) => readonly NewOutboxWrite[];
    /** More statements for the insert's transaction (attachments: the tray's files move to their rows). */
    readonly also?: SettleStatements;
}

/**
 * Sends what the issue's comment box holds as a comment, the box cleared in
 * the insert's transaction: the comment's local id and its row, or null for
 * a box of blank text. Rejects (CommentError, OutboxError, DraftError) with
 * the box as it was.
 */
export async function commentOnIssue(
    options: CommentOnIssueOptions,
): Promise<{ readonly commentId: string; readonly row: OutboxRow } | null> {
    const { outbox, drafts, newId, issue, authorId, serverAt = null, more, also } = options;
    const seen = options.seen ?? (isLocalIssue(issue) ? [] : null);
    const commentId = newLocalCommentId(newId);
    const where = commentRoute(outbox, issue);
    const row = await drafts.enqueueFromDraft(
        options.draft ?? issueCommentsDraft(issue),
        (text) => {
            const payload: IssueCommentPayload = { issue, body: commentBody(text), authorId, serverAt, seen };
            const write: NewOutboxWrite = {
                id: commentId,
                lane: where.lane,
                kind: ISSUE_COMMENT_KIND,
                payload: JSON.stringify(payload),
                payloadVersion: VERSION,
                idempotencyKey: newId(),
                ...(where.dependsOn === null ? {} : { dependsOn: where.dependsOn }),
            };
            const rest = more?.(commentId) ?? [];
            return rest.length === 0 ? write : [write, ...rest];
        },
        also ? { also } : {},
    );
    return row === null ? null : { commentId, row };
}

type CommentOutbox = Pick<
    Outbox,
    'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf' | 'editUnsent' | 'discardUnsent'
>;

/** What an edit or a delete did: changed on the phone, or queued for the server. */
export type CommentChange = 'in-place' | 'queued';

export interface CommentInput {
    readonly issue: string;
    readonly commentId: string;
    /** A fresh UUID (expo-crypto): a queued row's id and key. */
    readonly newId: () => string;
}

/** The comment's add while it is still in the outbox. */
const addRow = (outbox: Pick<Outbox, 'rows'>, commentId: string) =>
    outbox.rows().find((row) => row.id === commentId && row.kind === ISSUE_COMMENT_KIND) ?? null;

const refusedAdd = (outbox: Pick<Outbox, 'unsent'>, commentId: string) =>
    outbox.unsent().find((write) => write.id === commentId && write.kind === ISSUE_COMMENT_KIND);

const notSentYet = (row: OutboxRow | null): row is OutboxRow =>
    row !== null && (row.state === 'queued' || row.state === 'held');

function parse<P>(text: string): P | null {
    try {
        return JSON.parse(text) as P;
    } catch {
        return null;
    }
}

/** Edits comment `commentId`: its add in place while it hasn't gone, else `PATCH` once its add settles. Throws CommentError. */
export async function editComment(
    outbox: CommentOutbox,
    input: CommentInput & { text: string },
): Promise<CommentChange> {
    const { issue, commentId, newId } = input;
    const body = commentBody(input.text);
    const row = addRow(outbox, commentId);
    if (notSentYet(row)) {
        const payload = parse<IssueCommentPayload>(row.payload);
        if (
            payload !== null &&
            (await outbox.update(
                row.id,
                { payload: JSON.stringify({ ...payload, body }), payloadVersion: VERSION },
                outbox.revisionOf(row.id),
            ))
        ) {
            return 'in-place';
        }
    }
    const refused = refusedAdd(outbox, commentId);
    const old = refused === undefined ? null : parse<IssueCommentPayload>(refused.payload);
    if (
        refused !== undefined &&
        old !== null &&
        (await outbox.editUnsent(refused.id, { payload: JSON.stringify({ ...old, body }), payloadVersion: VERSION }))
    ) {
        return 'in-place';
    }
    const where = commentRoute(outbox, issue);
    const queued = outbox
        .rows()
        .filter((item) => item.lane === where.lane && item.kind === COMMENT_EDIT_KIND && item.state === 'queued')
        .find((item) => parse<CommentEditPayload>(item.payload)?.commentId === commentId);
    if (queued !== undefined) {
        const payload = parse<CommentEditPayload>(queued.payload)!;
        if (
            await outbox.update(
                queued.id,
                { payload: JSON.stringify({ ...payload, body }), payloadVersion: VERSION },
                outbox.revisionOf(queued.id),
            )
        ) {
            return 'queued';
        }
    }
    const pending = addRow(outbox, commentId);
    const payload: CommentEditPayload = { issue, commentId, body };
    await outbox.enqueue({
        id: newId(),
        lane: where.lane,
        kind: COMMENT_EDIT_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
        ...((pending?.id ?? where.dependsOn) === null ? {} : { dependsOn: pending?.id ?? where.dependsOn }),
    });
    return 'queued';
}

/** Deletes comment `commentId` (after the screen's confirm): its add goes while it hasn't gone, else `DELETE` once it settles. */
export async function deleteComment(outbox: CommentOutbox, input: CommentInput): Promise<CommentChange> {
    const { issue, commentId, newId } = input;
    const row = addRow(outbox, commentId);
    if (notSentYet(row) && (await outbox.remove(row.id, outbox.revisionOf(row.id))) !== null) {
        return 'in-place';
    }
    if (refusedAdd(outbox, commentId) !== undefined && (await outbox.discardUnsent(commentId)) !== null) {
        return 'in-place';
    }
    const where = commentRoute(outbox, issue);
    const mine = (kind: string) =>
        outbox
            .rows()
            .filter((item) => item.lane === where.lane && item.kind === kind)
            .filter((item) => parse<{ commentId?: string }>(item.payload)?.commentId === commentId);
    // Its queued edits would change what is being deleted: they go.
    for (const edit of mine(COMMENT_EDIT_KIND)) {
        if (edit.state === 'queued') {
            await outbox.remove(edit.id, outbox.revisionOf(edit.id));
        }
    }
    for (const refused of outbox.unsent()) {
        if (refused.kind === COMMENT_EDIT_KIND && parse<CommentEditPayload>(refused.payload)?.commentId === commentId) {
            await outbox.discardUnsent(refused.id);
        }
    }
    if (mine(COMMENT_DELETE_KIND).some((item) => item.state === 'queued')) {
        return 'queued';
    }
    const pending = addRow(outbox, commentId);
    const payload: CommentDeletePayload = { issue, commentId };
    const dependsOn = pending?.id ?? where.dependsOn;
    await outbox.enqueue({
        id: newId(),
        lane: where.lane,
        kind: COMMENT_DELETE_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
        ...(dependsOn === null ? {} : { dependsOn }),
    });
    return 'queued';
}

// ---- The kinds -----------------------------------------------------------------

export interface IssueCommentOptions {
    /** The scope's issue details: an answer's comment goes into the held detail. */
    readonly issueDetails?: Pick<IssueDetails, 'peek' | 'put'>;
    /** After a write the server took: the issue's detail is read again (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

const commentsPath = (number: string) => `/api/issues/${encodeURIComponent(number)}/comments`;
const commentPath = (number: string, id: string) => `${commentsPath(number)}/${encodeURIComponent(id)}`;
const detailPath = (number: string) => `/api/issues/${encodeURIComponent(number)}`;

/** A classifier action as a send's outcome; `delivered` is the kind's own. */
function outcome(action: Exclude<ClassifierAction, { action: 'delivered' }>, answer: Answer): SendOutcome {
    switch (action.action) {
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        default:
            return { action: 'unsent', reason: `http-${answer.status}` };
    }
}

const gone = (status: number) => status === 404 || status === 410;

/** Answers every comment write reads the same way. */
function commonAnswer(answer: Answer, method: WriteMethod): ClassifierAction | undefined {
    if (answer.status === 400) {
        return { action: 'unsent', reason: COMMENT_REFUSALS.invalid };
    }
    if (answer.status === 413) {
        return { action: 'unsent', reason: 'too-large' };
    }
    if (answer.status === 403) {
        return { action: 'unsent', reason: method === 'POST' ? 'refused' : COMMENT_REFUSALS.notYours };
    }
    return undefined;
}

/** The add's answers before the outbox's defaults: it isn't safe to repeat, so a proxy's page is `unknown`, never `retry`. */
function addAnswer(answer: Answer): ClassifierAction | undefined {
    const { status, code, unreadable } = answer;
    if (gone(status)) {
        return { action: 'unsent', reason: UNSENT_GONE };
    }
    const common = commonAnswer(answer, 'POST');
    if (common !== undefined) {
        return common;
    }
    if (status === 503 && !unreadable && code !== 'draining') {
        // The server's own answer before it saved anything.
        return { action: 'retry', reason: 'unavailable' };
    }
    if ((status === 502 || status === 503 || status === 504) && code !== 'draining') {
        // A proxy's page may come after the server saved it: only the check can tell.
        return { action: 'unknown', reason: 'away' };
    }
    return undefined;
}

/** The comment an answer carries, or null for a body that isn't one. */
function commentOf(body: unknown): IssueComment | null {
    const comment = body as Partial<IssueComment> | null;
    return comment && typeof comment.id === 'string' && typeof comment.body === 'string'
        ? (comment as IssueComment)
        : null;
}

/** `detail` with `comment` in it: in place of the one with its id, else last. */
export function withComment(detail: IssueDetail, comment: IssueComment): IssueDetail {
    const at = detail.comments.findIndex((item) => item.id === comment.id);
    const comments =
        at === -1 ? [...detail.comments, comment] : detail.comments.map((item, i) => (i === at ? comment : item));
    return { ...detail, comments };
}

/** `detail` without comment `id`. */
export const withoutComment = (detail: IssueDetail, id: string): IssueDetail => ({
    ...detail,
    comments: detail.comments.filter((item) => item.id !== id),
});

function decoder<P>(check: (value: Record<string, unknown>) => boolean, what: string) {
    return (text: string): P => {
        const value = JSON.parse(text) as Record<string, unknown> | null;
        if (!value || typeof value !== 'object' || typeof value.issue !== 'string' || !check(value)) {
            throw new TypeError(`Not a ${what}.`);
        }
        return value as P;
    };
}

/** The three comment kinds, over the scope's issue details. */
export function issueCommentKinds(options: IssueCommentOptions = {}): OutboxKind<unknown>[] {
    const { issueDetails, afterWrite } = options;

    /** The issue's number, or null for one filed offline whose create never resolved. */
    const numberOf = (context: Pick<OutboxContext, 'resolve'>, issue: string) => serverIssueKey(context.resolve, issue);
    /** The comment's server id, or null for a local one whose add never resolved. */
    const serverComment = (context: Pick<OutboxContext, 'resolve'>, id: string) =>
        isLocalComment(id) ? context.resolve(COMMENT_IDS, id) : id;
    const shownComment = (scope: Pick<OutboxContext, 'resolve'>, id: string) => serverComment(scope, id) ?? id;

    /** Hands `change` to the issue's held detail, then reads it again. */
    const handOff = (number: string, change: (detail: IssueDetail) => IssueDetail) => async () => {
        const held = issueDetails?.peek(number)?.state.value;
        if (issueDetails && held != null) {
            await issueDetails.put(number, change(held));
        }
        afterWrite?.(commentsPath(number));
    };

    async function request(
        context: OutboxContext,
        write: OutboxWrite<unknown>,
        path: string,
        method: WriteMethod,
        special: (answer: Answer) => ClassifierAction | undefined,
        json?: unknown,
    ) {
        const response = await context.fetch(path, { method, ...(json === undefined ? {} : { json }) });
        const answer = await readAnswer(response, context.signal);
        return { answer, action: classify(answer, { method, ambiguous: write.ambiguous === true, special }) };
    }

    const add: OutboxKind<IssueCommentPayload> = {
        kind: ISSUE_COMMENT_KIND,
        payloadVersion: VERSION,
        repeatable: false,
        creates: COMMENT_IDS,
        decode: decoder<IssueCommentPayload>(
            (value) =>
                typeof value.body === 'string' &&
                typeof value.authorId === 'string' &&
                (value.serverAt === null || typeof value.serverAt === 'number') &&
                (value.seen === null ||
                    (Array.isArray(value.seen) && value.seen.every((id) => typeof id === 'string'))),
            'comment',
        ),
        async send(write, context) {
            const number = numberOf(context, write.payload.issue);
            if (number === null) {
                return { action: 'unsent', reason: COMMENT_REFUSALS.noIssue };
            }
            const { answer, action } = await request(context, write, commentsPath(number), 'POST', addAnswer, {
                body: write.payload.body,
            });
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            const comment = commentOf(answer.body);
            if (comment === null) {
                // A 2xx without the comment: the check finds it.
                return { action: 'unknown', reason: `http-${answer.status}` };
            }
            return { action: 'done', serverId: comment.id, handOff: handOff(number, (d) => withComment(d, comment)) };
        },
        async check({ row, payload }, context): Promise<CheckOutcome> {
            const number = numberOf(context, payload.issue);
            if (number === null) {
                return { action: 'not-sent' };
            }
            const answer = await readAnswer(await context.fetch(detailPath(number)), context.signal);
            if (gone(answer.status)) {
                // The issue is gone: sent again, its 404 moves it to Unsent.
                return { action: 'not-sent' };
            }
            const detail = answer.body as Partial<IssueDetail> | null;
            if (answer.status < 200 || answer.status >= 300 || !detail || !Array.isArray(detail.comments)) {
                // Can't tell now: the outbox asks again after the back-off.
                throw new NetworkError(detailPath(number));
            }
            const since = serverSince(payload.serverAt);
            const seen = payload.seen === null ? null : new Set(payload.seen);
            const found = (detail.comments as Partial<IssueComment>[]).filter(
                (comment) =>
                    typeof comment.id === 'string' &&
                    comment.authorKind === 'user' &&
                    comment.authorId === payload.authorId &&
                    (comment.body ?? '').trim() === payload.body &&
                    (since === null || (typeof comment.createdAt === 'number' && comment.createdAt >= since)) &&
                    !seen?.has(comment.id as string) &&
                    !context.claimed(COMMENT_IDS, comment.id),
            ) as IssueComment[];
            // With no bound, one match may be an older identical comment: the person decides.
            if (found.length === 1 && (since !== null || seen !== null)) {
                const full = detail as IssueDetail;
                const ownDetail = async () => {
                    if (issueDetails) {
                        await issueDetails.put(number, full);
                    }
                };
                return { action: 'sent', serverId: found[0]!.id, handOff: ownDetail };
            }
            if (found.length > 0) {
                return { action: 'unconfirmed', candidates: found.map((comment) => comment.id) };
            }
            return answeredWithError(row.lastError)
                ? { action: 'unconfirmed', candidates: [] }
                : { action: 'not-sent' };
        },
        overlay({ id, payload }, scope): Overlay {
            return {
                collection: ISSUE_COMMENTS,
                key: shownComment(scope, id),
                mode: 'insert',
                value: {
                    issue: shownIssueKey(scope.resolve, payload.issue),
                    body: payload.body,
                    authorId: payload.authorId,
                },
            };
        },
    };

    const edit: OutboxKind<CommentEditPayload> = {
        kind: COMMENT_EDIT_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<CommentEditPayload>(
            (value) => typeof value.commentId === 'string' && typeof value.body === 'string',
            'comment edit',
        ),
        async send(write, context) {
            const number = numberOf(context, write.payload.issue);
            if (number === null) {
                return { action: 'unsent', reason: COMMENT_REFUSALS.noIssue };
            }
            const id = serverComment(context, write.payload.commentId);
            if (id === null) {
                return { action: 'unsent', reason: COMMENT_REFUSALS.noComment };
            }
            const { answer, action } = await request(
                context,
                write,
                commentPath(number, id),
                'PATCH',
                (a) => (gone(a.status) ? { action: 'unsent', reason: UNSENT_GONE } : commonAnswer(a, 'PATCH')),
                { body: write.payload.body },
            );
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            const comment = commentOf(answer.body);
            return {
                action: 'done',
                handOff: handOff(number, (d) => (comment === null ? d : withComment(d, comment))),
            };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: ISSUE_COMMENTS,
                key: shownComment(scope, payload.commentId),
                mode: 'patch',
                value: { issue: shownIssueKey(scope.resolve, payload.issue), body: payload.body },
            };
        },
    };

    const remove: OutboxKind<CommentDeletePayload> = {
        kind: COMMENT_DELETE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<CommentDeletePayload>((value) => typeof value.commentId === 'string', 'comment delete'),
        async send(write, context) {
            const number = numberOf(context, write.payload.issue);
            const id = serverComment(context, write.payload.commentId);
            if (number === null || id === null) {
                // Never created: nothing on the server to delete.
                return { action: 'done' };
            }
            const { answer, action } = await request(context, write, commentPath(number, id), 'DELETE', (a) =>
                gone(a.status) ? { action: 'delivered' } : commonAnswer(a, 'DELETE'),
            );
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            return { action: 'done', handOff: handOff(number, (d) => withoutComment(d, id)) };
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: ISSUE_COMMENTS,
                key: shownComment(scope, payload.commentId),
                mode: 'patch',
                value: { issue: shownIssueKey(scope.resolve, payload.issue), deleted: true },
            };
        },
    };

    return [add, edit, remove] as OutboxKind<unknown>[];
}

/** How the comment kinds' rows look on screen (`overlaysOf`), without anything that sends: the issue screen lays them over the detail. */
export const ISSUE_COMMENT_VIEWS: readonly OverlayKind<unknown>[] = issueCommentKinds();
