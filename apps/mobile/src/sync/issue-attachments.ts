import { ATTACHMENT_EXTENSIONS } from '@socio/shared/issues/issue-attachment-files';
import type { IssueAttachment, IssueDetail } from '@socio/shared/issues/issue-types';
import { cleanName } from '@socio/shared/media/file-types';

import { NetworkError } from '../net/errors';

import type { Attachments, RowFile } from './attachments';
import {
    COMMENT_IDS,
    COMMENT_REFUSALS,
    commentOnIssue,
    type CommentOnIssueOptions,
    commentRoute,
    issueCommentsLane,
    isLocalComment,
} from './issue-comments';
import {
    answeredWithError,
    fileIssue,
    type FileIssueOptions,
    ISSUE_CREATE_KIND,
    ISSUE_DRAFT,
    issueCommentsDraft,
    resendIssue,
    type ResendIssueOptions,
} from './issue-create';
import type { IssueDetails } from './issue-details';
import { isLocalIssue, serverIssueKey, shownIssueKey } from './local-ids';
import type {
    CheckOutcome,
    HoldGroup,
    NewOutboxWrite,
    Outbox,
    OutboxContext,
    OutboxKind,
    OutboxRow,
    SendOutcome,
} from './outbox';
import { UNSENT_GONE } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { serverSince } from './server-clock';

// Issue attachments: a
// file on an issue or on one of its comments, one outbox row per file.
//
// - **Never through media.** A file picked into an issue's box (`issue:new`,
//   `issue-comments:<key>`) is copied into `attachments/` like any, run
//   through the 5 MiB issue processor and shared's `acceptFiles` at pick time,
//   and never uploaded to `/api/media/uploads` (attachments.ts skips it).
// - **One row per file:** `issue-attachment`, `POST /api/issues/:n/attachments`
//   with `{name, mediaType, data, commentId?}` in the issue's comments lane
//   (`issue-comments:<issue>`, issue-comments.ts's), waiting on the issue's create
//   (`dependsOn` its local key) or on the comment it belongs to. Each file's
//   `files.outboxId` is its row's id, set in the transaction that queues the
//   create, the comment or the files (`forRows`), so a file stays until its
//   own row has left `outbox` and `unsent` (attachments.ts's `sweep`), however the
//   create settles.
// - **The payload** keeps the file's local id, its name `cleanName`'d as the
//   server stores it, its type (from the extension, `issueMediaType`) and
//   size, and its SHA-256 over the processed bytes (expo-crypto, `digest`),
//   which is the check's identity. The body is
//   joined as strings around the file's base64 (`attachmentBody`), never
//   `JSON.stringify` over it: both were measured on Hermes.
// - **Answers**, never the server's text: a 413 means too large or the
//   issue already has 10 (one status for both), 415 a type the server won't
//   take, 400 a body it couldn't read, 403 a comment that isn't the person's,
//   404 and 410 the issue (or its comment) gone. A readable 503 goes again; a
//   proxy's page, a plain 5xx or no answer is `unknown`, which the check settles.
// - **Not safe to repeat** (the server takes no Idempotency-Key): the outbox's
//   check reads the issue's detail and takes the attachment with the same
//   `sha256`, uploaded by the person, at or after `serverSince`, not among those
//   the screen showed as the person sent it (`seen`) and no other write's
//   (`context.claimed`), only if it is the only one. Name and size are not the
//   identity: the server cleans names.
// - **On screen** (`overlay`): rows of `issue-attachments` for the issue
//   screen, which shows the copy on the phone until the server's comes.
//
// No React Native: tests/sync runs it under Node against a fake server.

export const ISSUE_ATTACHMENT_KIND = 'issue-attachment';
const VERSION = 1;

/** The `ids` map's kind for an attachment's server id. */
export const ISSUE_ATTACHMENT_IDS = 'issue-attachment';
/** What the overlays lay over: the issue detail's attachments. */
export const ISSUE_ATTACHMENTS = 'issue-attachments';

/** Refusals' codes, which the Unsent list words. */
export const ISSUE_ATTACHMENT_REFUSALS = {
    /** 413: too large, or the issue already has 10 (the server answers both alike). */
    tooLarge: 'issue-attachment-too-large',
    type: 'issue-attachment-type',
    invalid: 'issue-attachment-invalid',
    /** The copy on the phone is gone. */
    missing: 'issue-attachment-missing',
} as const;

export interface IssueAttachmentPayload {
    /** The issue's key: its number, or its local key while filed offline. */
    readonly issue: string;
    /** The file's local id in user.db's `files`. */
    readonly fileId: string;
    /** The comment it belongs to (a local id until its add resolves), or null for the issue's own. */
    readonly commentId: string | null;
    /** `cleanName`'d, as the server stores it. */
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    /** SHA-256 of the bytes sent, lowercase hex: the check's identity. */
    readonly sha256: string;
    /** The person attaching (the scope's app user id). */
    readonly uploaderId: string;
    /** The scope's newest Date header as the person sent it, or null. */
    readonly serverAt: number | null;
    /** The ids of the attachments the issue's detail showed as the person sent it; null with no detail held. */
    readonly seen: readonly string[] | null;
}

/** The ids of the attachments `detail` shows, for a send's `seen`; null with no detail. */
export const seenAttachments = (detail: Pick<IssueDetail, 'attachments'> | null | undefined): string[] | null =>
    detail ? detail.attachments.map((attachment) => attachment.id) : null;

/**
 * The request's body, joined around the base64: one copy of a
 * 7 MB string fewer than `JSON.stringify` over an object holding it. Base64
 * needs no escaping in JSON.
 */
export function attachmentBody(
    fields: { readonly name: string; readonly mediaType: string; readonly commentId: string | null },
    base64: string,
): string {
    const comment = fields.commentId === null ? '' : `,"commentId":${JSON.stringify(fields.commentId)}`;
    return (
        '{"name":' +
        JSON.stringify(fields.name) +
        ',"mediaType":' +
        JSON.stringify(fields.mediaType) +
        comment +
        ',"data":"' +
        base64 +
        '"}'
    );
}

// ---- Queueing -------------------------------------------------------------------

type Tray = Pick<Attachments, 'forRows' | 'digest'>;

interface RowsInput {
    readonly issue: string;
    readonly lane: string;
    readonly dependsOn: string | null;
    readonly commentId: string | null;
    readonly uploaderId: string;
    readonly serverAt: number | null;
    readonly seen: readonly string[] | null;
    readonly newId: () => string;
}

interface TakenTray {
    /** The files that go, each with its hash. */
    readonly files: readonly (RowFile & { readonly sha256: string })[];
    /** Builds one row per file and remembers where each goes. */
    rows(input: RowsInput): NewOutboxWrite[];
    readonly send: ReturnType<Attachments['forRows']>;
    readonly place: (fileId: string) => { outboxId: string; lane: string } | null;
}

/**
 * The type sent with a file, from its name's extension as `acceptFiles`
 * allowed it, never the picker's MIME: the server refuses with 415 any
 * declared type that disagrees with what it detects, and pickers report
 * `.json`, `.csv` or `.log` as `application/json`, `text/csv` or
 * `application/octet-stream` where the server sees plain text.
 */
export function issueMediaType(name: string, mime: string): string {
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    return ATTACHMENT_EXTENSIONS[extension] ?? mime;
}

/** Takes a tray's files for a send and hashes them; a file whose copy is gone stays in the tray. */
async function takeTray(attachments: Tray, draftScope: string): Promise<TakenTray> {
    const send = attachments.forRows(draftScope);
    try {
        const hashed = await Promise.all(
            send.files.map(async (file) => ({ ...file, sha256: await attachments.digest(file.id) })),
        );
        const files = hashed.filter((file): file is RowFile & { sha256: string } => file.sha256 !== null);
        const placed = new Map<string, { outboxId: string; lane: string }>();
        return {
            files,
            send,
            place: (fileId) => placed.get(fileId) ?? null,
            rows(input) {
                placed.clear();
                return files.map((file) => {
                    const id = input.newId();
                    placed.set(file.id, { outboxId: id, lane: input.lane });
                    const payload: IssueAttachmentPayload = {
                        issue: input.issue,
                        fileId: file.id,
                        commentId: input.commentId,
                        name: cleanName(file.name),
                        mediaType: issueMediaType(cleanName(file.name), file.mime),
                        size: file.bytes,
                        sha256: file.sha256,
                        uploaderId: input.uploaderId,
                        serverAt: input.serverAt,
                        seen: input.seen,
                    };
                    return {
                        id,
                        lane: input.lane,
                        kind: ISSUE_ATTACHMENT_KIND,
                        payload: JSON.stringify(payload),
                        payloadVersion: VERSION,
                        idempotencyKey: input.newId(),
                        ...(input.dependsOn === null ? {} : { dependsOn: input.dependsOn }),
                    };
                });
            },
        };
    } catch (error) {
        send.released();
        throw error;
    }
}

/**
 * Files FileIssue's box with its tray: the create, one row per
 * file waiting on it, the files moved to their rows and the box cleared, in
 * one transaction. As `fileIssue` otherwise.
 */
export async function fileIssueWithFiles(
    options: Omit<FileIssueOptions, 'more' | 'also'> & { readonly attachments: Tray },
): Promise<{ readonly localKey: string; readonly row: OutboxRow } | null> {
    const { attachments, ...filing } = options;
    const tray = await takeTray(attachments, filing.draft ?? ISSUE_DRAFT);
    try {
        const filed = await fileIssue({
            ...filing,
            more: (localKey) =>
                tray.rows({
                    issue: localKey,
                    lane: issueCommentsLane(localKey),
                    dependsOn: localKey,
                    commentId: null,
                    uploaderId: filing.reporterId,
                    serverAt: filing.serverAt ?? null,
                    seen: [],
                    newId: filing.newId,
                }),
            also: tray.send.statements(tray.place),
        });
        if (filed !== null) {
            tray.send.committed(tray.place);
        }
        return filed;
    } finally {
        tray.send.released();
    }
}

/**
 * Sends an issue's comment box with its tray: the comment, one
 * row per file waiting on it (each file is the comment's), the files moved
 * and the box cleared, in one transaction. As `commentOnIssue` otherwise.
 */
export async function commentWithFiles(
    options: Omit<CommentOnIssueOptions, 'more' | 'also'> & {
        readonly attachments: Tray;
        /** `seenAttachments` of the issue's held detail (`[]` for an issue filed offline). */
        readonly seenFiles?: readonly string[] | null;
    },
): Promise<{ readonly commentId: string; readonly row: OutboxRow } | null> {
    const { attachments, seenFiles, ...comment } = options;
    const tray = await takeTray(attachments, comment.draft ?? issueCommentsDraft(comment.issue));
    const where = commentRoute(comment.outbox, comment.issue);
    try {
        const sent = await commentOnIssue({
            ...comment,
            more: (commentId) =>
                tray.rows({
                    issue: comment.issue,
                    lane: where.lane,
                    dependsOn: commentId,
                    commentId,
                    uploaderId: comment.authorId,
                    serverAt: comment.serverAt ?? null,
                    seen: seenFiles ?? (isLocalIssue(comment.issue) ? [] : null),
                    newId: comment.newId,
                }),
            also: tray.send.statements(tray.place),
        });
        if (sent !== null) {
            tray.send.committed(tray.place);
        }
        return sent;
    } finally {
        tray.send.released();
    }
}

export interface AttachToIssueOptions {
    readonly outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve' | 'enqueueAll'>;
    readonly attachments: Tray;
    readonly newId: () => string;
    /** The issue's key as its screen holds it: a number, or a local key. */
    readonly issue: string;
    readonly uploaderId: string;
    readonly serverAt?: number | null;
    /** `seenAttachments` of the issue's held detail; `[]` for an issue filed offline. */
    readonly seen?: readonly string[] | null;
    /** The tray sent: the issue's comment box's by default. */
    readonly draft?: string;
}

/** Attaches a tray's files to the issue itself, with no comment: their rows, the files moved, in one transaction. */
export async function attachToIssue(options: AttachToIssueOptions): Promise<OutboxRow[]> {
    const { outbox, attachments, newId, issue, uploaderId, serverAt = null } = options;
    const tray = await takeTray(attachments, options.draft ?? issueCommentsDraft(issue));
    try {
        const where = commentRoute(outbox, issue);
        const rows = tray.rows({
            issue,
            lane: where.lane,
            dependsOn: where.dependsOn,
            commentId: null,
            uploaderId,
            serverAt,
            seen: options.seen ?? (where.dependsOn === null ? null : []),
            newId,
        });
        if (rows.length === 0) {
            return [];
        }
        const made = await outbox.enqueueAll(rows, tray.send.statements(tray.place));
        tray.send.committed(tray.place);
        return made;
    } finally {
        tray.send.released();
    }
}

/**
 * The tray the issue's own Attach picks into: an issue's scope, so
 * nothing goes to media; each pick leaves it for rows of its own at once
 * (`attachToIssue` with this draft), the issue's files, with no comment.
 */
export const issueAttachTray = (key: string) => `issue:attach:${key}`;

// ---- A refused filing's tray ------------------------------------------------------

/**
 * The tray a refused filing's Edit picks into: an issue's scope, so
 * nothing goes to media; each file leaves it for a row of its own at once
 * (`attachToIssue` with this draft), waiting on the filing's local key.
 */
export const issueEditTray = (localKey: string) => `issue:edit:${localKey}`;

/**
 * A refused filing's Send again: first queues whatever its Edit's tray
 * still holds (`attachToIssue` with `issueEditTray`), a pick whose own queueing
 * failed or hasn't run, so every file the tray shows follows the filing; then
 * `resendIssue`. False, with nothing queued, when the filing is gone; a file
 * that can't be queued rejects before the filing goes, the file kept in the tray.
 */
export async function resendIssueWithFiles(
    options: ResendIssueOptions &
        Omit<AttachToIssueOptions, 'outbox' | 'issue' | 'draft' | 'seen'> & {
            readonly outbox: ResendIssueOptions['outbox'] & AttachToIssueOptions['outbox'];
        },
): Promise<boolean> {
    const { outbox, id } = options;
    if (!outbox.unsent().some((item) => item.id === id && item.kind === ISSUE_CREATE_KIND)) {
        return false;
    }
    await attachToIssue({
        outbox,
        attachments: options.attachments,
        newId: options.newId,
        issue: id,
        uploaderId: options.uploaderId,
        serverAt: options.serverAt ?? null,
        draft: issueEditTray(id),
    });
    return resendIssue({ outbox, id, fields: options.fields, idempotencyKey: options.idempotencyKey });
}

/** A file waiting on a refused filing: its attachment row and its copy. */
export interface HeldIssueFile {
    readonly rowId: string;
    readonly fileId: string;
    readonly name: string;
}

/**
 * The files waiting on refused filing `localKey` (its own attachment rows, held behind
 * it), oldest first: the tray its Edit restores. A comment's files aren't the
 * form's.
 */
export function heldIssueFiles(groups: readonly HoldGroup[], localKey: string): HeldIssueFile[] {
    const group = groups.find((item) => item.root.id === localKey);
    if (group === undefined) {
        return [];
    }
    return group.rows.flatMap((row) => {
        if (row.kind !== ISSUE_ATTACHMENT_KIND) {
            return [];
        }
        try {
            const payload = JSON.parse(row.payload) as Partial<IssueAttachmentPayload> | null;
            return payload &&
                typeof payload.name === 'string' &&
                typeof payload.fileId === 'string' &&
                payload.issue === localKey &&
                payload.commentId === null
                ? [{ rowId: row.id, fileId: payload.fileId, name: payload.name }]
                : [];
        } catch {
            return [];
        }
    });
}

/**
 * Remove on a refused filing's restored tray: that file's attachment row is
 * discarded, and attachments.ts's sweep deletes its copy. False when it is gone or going.
 */
export async function removeHeldFile(outbox: Pick<Outbox, 'remove'>, rowId: string): Promise<boolean> {
    return (await outbox.remove(rowId)) !== null;
}

// ---- The kind -------------------------------------------------------------------

export interface IssueAttachmentOptions {
    /** The scope's attachments: each row's file is read from its copy as it is sent. */
    readonly attachments?: Pick<Attachments, 'base64'>;
    /** The scope's issue details: an answer's attachment goes into the held detail. */
    readonly issueDetails?: Pick<IssueDetails, 'peek' | 'put'>;
    /** After a write the server took: the issue's detail is read again (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

const attachmentsPath = (number: string) => `/api/issues/${encodeURIComponent(number)}/attachments`;
const detailPath = (number: string) => `/api/issues/${encodeURIComponent(number)}`;
const gone = (status: number) => status === 404 || status === 410;

/** The add's answers before the outbox's defaults: not safe to repeat, so a proxy's page is `unknown`, never `retry`. */
function attachmentAnswer({ status, code, unreadable }: Answer): ClassifierAction | undefined {
    if (gone(status)) {
        return { action: 'unsent', reason: UNSENT_GONE };
    }
    if (status === 413) {
        return { action: 'unsent', reason: ISSUE_ATTACHMENT_REFUSALS.tooLarge };
    }
    if (status === 415) {
        return { action: 'unsent', reason: ISSUE_ATTACHMENT_REFUSALS.type };
    }
    if (status === 400) {
        return { action: 'unsent', reason: ISSUE_ATTACHMENT_REFUSALS.invalid };
    }
    if (status === 403) {
        return { action: 'unsent', reason: 'refused' };
    }
    if (status === 503 && !unreadable && code !== 'draining') {
        // The server's own answer before it stored anything.
        return { action: 'retry', reason: 'unavailable' };
    }
    if ((status === 502 || status === 503 || status === 504) && code !== 'draining') {
        // A proxy's page may come after the server stored it: only the check can tell.
        return { action: 'unknown', reason: 'away' };
    }
    return undefined;
}

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

/** The attachment an answer carries, or null for a body that isn't one. */
function attachmentOf(body: unknown): IssueAttachment | null {
    const attachment = body as Partial<IssueAttachment> | null;
    return attachment && typeof attachment.id === 'string' && typeof attachment.sha256 === 'string'
        ? (attachment as IssueAttachment)
        : null;
}

/** `detail` with `attachment` in it: in place of the one with its id, else last. */
export function withAttachment(detail: IssueDetail, attachment: IssueAttachment): IssueDetail {
    const at = detail.attachments.findIndex((item) => item.id === attachment.id);
    const attachments =
        at === -1
            ? [...detail.attachments, attachment]
            : detail.attachments.map((item, i) => (i === at ? attachment : item));
    return { ...detail, attachments };
}

function decode(text: string): IssueAttachmentPayload {
    const value = JSON.parse(text) as Partial<IssueAttachmentPayload> | null;
    if (
        !value ||
        typeof value.issue !== 'string' ||
        typeof value.fileId !== 'string' ||
        (value.commentId !== null && typeof value.commentId !== 'string') ||
        typeof value.name !== 'string' ||
        typeof value.mediaType !== 'string' ||
        typeof value.size !== 'number' ||
        typeof value.sha256 !== 'string' ||
        typeof value.uploaderId !== 'string' ||
        (value.serverAt !== null && typeof value.serverAt !== 'number') ||
        (value.seen !== null && !(Array.isArray(value.seen) && value.seen.every((id) => typeof id === 'string')))
    ) {
        throw new TypeError('Not an issue attachment.');
    }
    return value as IssueAttachmentPayload;
}

/** The issue attachment kind, over the scope's attachments and issue details. */
export function issueAttachmentKind(options: IssueAttachmentOptions = {}): OutboxKind<IssueAttachmentPayload> {
    const { attachments, issueDetails, afterWrite } = options;
    const numberOf = (context: Pick<OutboxContext, 'resolve'>, issue: string) => serverIssueKey(context.resolve, issue);
    const serverComment = (context: Pick<OutboxContext, 'resolve'>, id: string) =>
        isLocalComment(id) ? context.resolve(COMMENT_IDS, id) : id;

    return {
        kind: ISSUE_ATTACHMENT_KIND,
        payloadVersion: VERSION,
        repeatable: false,
        creates: ISSUE_ATTACHMENT_IDS,
        decode,
        async send(write, context) {
            const { payload } = write;
            const number = numberOf(context, payload.issue);
            if (number === null) {
                return { action: 'unsent', reason: COMMENT_REFUSALS.noIssue };
            }
            const commentId = payload.commentId === null ? null : serverComment(context, payload.commentId);
            if (payload.commentId !== null && commentId === null) {
                return { action: 'unsent', reason: COMMENT_REFUSALS.noComment };
            }
            const data = (await attachments?.base64(payload.fileId)) ?? null;
            if (data === null) {
                return { action: 'unsent', reason: ISSUE_ATTACHMENT_REFUSALS.missing };
            }
            const response = await context.fetch(attachmentsPath(number), {
                method: 'POST',
                jsonText: attachmentBody({ name: payload.name, mediaType: payload.mediaType, commentId }, data),
            });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, {
                method: 'POST',
                ambiguous: write.ambiguous === true,
                special: attachmentAnswer,
            });
            if (action.action !== 'delivered') {
                return outcome(action, answer);
            }
            const attachment = attachmentOf(answer.body);
            if (attachment === null) {
                // A 2xx without the attachment: the check finds it.
                return { action: 'unknown', reason: `http-${answer.status}` };
            }
            return {
                action: 'done',
                serverId: attachment.id,
                handOff: async () => {
                    const held = issueDetails?.peek(number)?.state.value;
                    if (issueDetails && held != null) {
                        await issueDetails.put(number, withAttachment(held, attachment));
                    }
                    afterWrite?.(attachmentsPath(number));
                },
            };
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
            if (answer.status < 200 || answer.status >= 300 || !detail || !Array.isArray(detail.attachments)) {
                // Can't tell now: the outbox asks again after the back-off.
                throw new NetworkError(detailPath(number));
            }
            const since = serverSince(payload.serverAt);
            const seen = payload.seen === null ? null : new Set(payload.seen);
            const found = (detail.attachments as Partial<IssueAttachment>[]).filter(
                (attachment) =>
                    typeof attachment.id === 'string' &&
                    attachment.sha256 === payload.sha256 &&
                    attachment.uploaderId === payload.uploaderId &&
                    (since === null || (typeof attachment.createdAt === 'number' && attachment.createdAt >= since)) &&
                    !seen?.has(attachment.id) &&
                    !context.claimed(ISSUE_ATTACHMENT_IDS, attachment.id),
            ) as IssueAttachment[];
            // With no bound, one match may be the same file attached before: the person decides.
            if (found.length === 1 && (since !== null || seen !== null)) {
                const full = detail as IssueDetail;
                return {
                    action: 'sent',
                    serverId: found[0]!.id,
                    handOff: async () => {
                        if (issueDetails) {
                            await issueDetails.put(number, full);
                        }
                    },
                };
            }
            if (found.length > 0) {
                return { action: 'unconfirmed', candidates: found.map((attachment) => attachment.id) };
            }
            return answeredWithError(row.lastError)
                ? { action: 'unconfirmed', candidates: [] }
                : { action: 'not-sent' };
        },
        overlay({ id, payload }, scope): Overlay {
            return {
                collection: ISSUE_ATTACHMENTS,
                key: scope.resolve(ISSUE_ATTACHMENT_IDS, id) ?? id,
                mode: 'insert',
                value: {
                    issue: shownIssueKey(scope.resolve, payload.issue),
                    commentId:
                        payload.commentId === null
                            ? null
                            : (serverComment(scope, payload.commentId) ?? payload.commentId),
                    fileId: payload.fileId,
                    name: payload.name,
                    mediaType: payload.mediaType,
                    size: payload.size,
                },
            };
        },
    };
}

/** How attachment rows look on screen (`overlaysOf`), without anything that sends: the issue screen lays them over the detail. */
export const ISSUE_ATTACHMENT_VIEWS: readonly OverlayKind<unknown>[] = [issueAttachmentKind() as OverlayKind<unknown>];
