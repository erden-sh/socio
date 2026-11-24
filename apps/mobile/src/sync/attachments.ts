import { acceptFiles, ATTACHMENT_EXTENSIONS } from '@socio/shared/issues/issue-attachment-files';
import { ISSUE_ATTACHMENT_MAX_BYTES, ISSUE_ATTACHMENTS_PER_ISSUE } from '@socio/shared/issues/issue-types';
import {
    ATTACHMENT_ID,
    type AttachmentKind,
    type AttachmentRef,
    MEDIA_LIMITS,
    type UploadResult,
} from '@socio/shared/media-types';

import { type FileSystem, joinPath, type SqlConnection, type SqlStatements, type UserDbState } from '../data';
import type { WorkspaceLayout } from '../data/layout';
import type { WorkspaceFilesDeps } from '../data/workspace-files';
import { prepareAttachmentsFolder } from '../data/workspace-files';
import { type AuthedFetch, type RawUpload, UPLOAD_PATH } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import { readJson } from '../net/read-body';

import type { Drafts } from './chat-drafts';
import type { NewOutboxWrite, OutboxRow, OutboxWrite, SendOutcome, SettleStatements } from './outbox';

// Attachments: the files a person picks for a message, on user.db's `files`
// (migration 2). No React Native: the platform
// hands in the file operations and the image processor, and tests/sync runs
// this under Node.
//
// - **Copied, then committed, then the picker's file goes.** A picked file is
//   run through the injected image processor (HEIC to JPEG, downscaled),
//   copied into `attachments/` after `prepareAttachmentsFolder` (so the copy
//   keeps the keys' unlock level and the outbox can upload while the phone is
//   locked), and its row committed; only then are the temporary files deleted.
//   A kill before the commit leaves a copy no row names, which the next open
//   deletes.
// - **Uploaded at once** through the scope's authedFetch, a raw body to
//   `/api/media/uploads?purpose=attachment`, with the chat's `threadId` only
//   when the chat exists on the server (a local-id chat, or a new chat's
//   draft, uploads pending, as the web's new-chat composer does).
//   `uploading`, then `ready` with the server's `cbatt_` id and `uploadedAt`,
//   or `failed` with a code (413 `too-large`, 415 `type`, another refusal or
//   an answer without a good id). No answer, a 5xx, a 429 or a 401 stay
//   `uploading`: the next `pump()` (the scope's start, the message's turn in
//   its lane) tries again.
// - **Messages go by reference.** A send moves the tray's files (all but failed ones) to the
//   outbox row in the insert's transaction (`enqueueWithAttachments`, through
//   `enqueueFromDraft`), so a kill never leaves them in both places. The row's
//   payload names them by their local ids; `resolve` gives the server's refs as
//   the row is sent, and `prepare` holds the row in its lane until every file
//   is uploaded, re-uploading one older than `REUPLOAD_AFTER_MS` (the server
//   drops unsent uploads after 24 h). `reuploadHook` is the "re-upload once"
//   after a 400.
// - **Limits** come from `GET /api/media/limits` (the web's defaults until
//   then), and at most `perMessage` (10) files wait in one tray.
// - **Discard** deletes the server's pending upload (best effort: the server
//   drops it after 24 h anyway), the copy and the row. A file carried by a row
//   goes when that row has left both `outbox` and `unsent` (`sweep`).
// - **Issue files never upload to media**: a file picked into an
//   issue's box (`issue:new`, `issue-comments:<key>`, `isIssueFileScope`) runs
//   through the issue processor (5 MiB, `processIssueImage`), then shared's
//   `acceptFiles`, which refuses at pick time what the server would answer 413
//   or 415 for. It is kept `ready` with no server id, and `upload` (the add
//   path and `pump()` alike) skips it by its tray or lane: each file goes as
//   its own `issue-attachment` row (issue-attachments.ts), placed there by
//   `forRows`, read by `base64` and identified by `digest`.

/** An attachment's upload state, as the tray shows it. */
export type AttachmentState = 'uploading' | 'ready' | 'failed';

/** Why an upload failed: a code, never the server's text. */
export type AttachmentFailure = 'too-large' | 'type' | 'refused' | 'bad-answer' | 'missing';

/** What a picker hands over. */
export interface PickedFile {
    /** Where it is now: a path or `file://` URI. */
    readonly uri: string;
    readonly name: string;
    readonly mime: string;
    readonly bytes: number;
    /** The picker's own temporary copy, deleted once ours is durable. */
    readonly temporary?: boolean;
}

/** HEIC to JPEG, downscaled (the app binds expo-image-manipulator); a new temporary file, or the same one. */
export type ImageProcessor = (file: PickedFile) => Promise<PickedFile>;

/** The file operations attachments need besides the store's. */
export interface AttachmentFiles extends Pick<FileSystem, 'list' | 'remove' | 'mkdir'> {
    /** Copies the file at `from` to a new file at `to`, whose directory exists. */
    copy(from: string, to: string): Promise<void>;
    /** The file's bytes for the upload body (expo-file-system's File is a Blob). */
    body(path: string): Promise<RawUpload['body']>;
    /** The file's bytes as base64, with no line breaks (an issue file's JSON body). */
    base64?(path: string): Promise<string>;
    /** The file's SHA-256 as lowercase hex (expo-crypto; an issue file's check). */
    sha256?(path: string): Promise<string>;
}

export interface Attachment {
    /** The local id: what a message's payload names. */
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly bytes: number;
    readonly kind: AttachmentKind;
    readonly state: AttachmentState;
    readonly error: AttachmentFailure | null;
    /** The server's attachment id once uploaded. */
    readonly serverId: string | null;
    readonly uploadedAt: number | null;
    /** The tray it sits in, until sent. */
    readonly draftScope: string | null;
    /** The outbox row that carries it, once sent. */
    readonly outboxId: string | null;
    readonly lane: string;
    /** The copy, absolute. */
    readonly path: string;
    readonly createdAt: number;
}

export interface MediaLimits {
    readonly fileMaxBytes: number;
    readonly perMessage: number;
    readonly imageModelMaxBytes: number;
}

/** The web's defaults, until the server says (packages/client's upload.ts). */
export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
    fileMaxBytes: 25 * 1024 * 1024,
    perMessage: MEDIA_LIMITS.perMessage,
    imageModelMaxBytes: 10 * 1024 * 1024,
};

export const MEDIA_LIMITS_PATH = '/api/media/limits';

/** An upload this old is sent again before its message goes: the server keeps unsent ones 24 h. */
export const REUPLOAD_AFTER_MS = 23 * 60 * 60_000;

/** A picked file the tray didn't take. */
export interface AddProblem {
    readonly name: string;
    readonly reason: 'empty' | 'too-large' | 'too-many' | 'type' | 'copy-failed' | 'read-only';
    /** An issue file's refusal in shared's words (`acceptFiles`), for the screen to show as it is. */
    readonly message?: string;
}

/** Whether files in this tray or lane are an issue's: they never upload to media. */
export const isIssueFileScope = (scope: string | null) =>
    scope !== null && (scope.startsWith('issue:') || scope.startsWith('issue-comments:'));

/** Why an issue file can't go, from what shared's `acceptFiles` checks (an extension the server takes, 5 MiB, not empty). */
function issueProblem(file: PickedFile): AddProblem['reason'] {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!(extension in ATTACHMENT_EXTENSIONS)) {
        return 'type';
    }
    return file.bytes > ISSUE_ATTACHMENT_MAX_BYTES ? 'too-large' : file.bytes <= 0 ? 'empty' : 'too-many';
}

/** A tray file as a send of one row per file takes it (`forRows`). */
export interface RowFile {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly bytes: number;
}

export interface AttachmentsOptions {
    /** user.db, open; the scope closes it after `close()`. */
    readonly db: SqlConnection;
    readonly state: UserDbState;
    readonly layout: WorkspaceLayout;
    readonly files: AttachmentFiles;
    /** socio-device's `setFileProtection` (a no-op on Android and in tests). */
    readonly setFileProtection: WorkspaceFilesDeps['setFileProtection'];
    /** The scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** A fresh id (expo-crypto): each file's local id. */
    readonly newId: () => string;
    /** The server's id of a chat, or null while it is a local id not created yet. */
    readonly serverThread?: (threadId: string) => string | null;
    readonly processImage?: ImageProcessor;
    /** The issue profile: 5 MiB, for files picked into an issue's box. */
    readonly processIssueImage?: ImageProcessor;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

export interface Attachments {
    /** A tray's files, oldest first. */
    list(draftScope: string): readonly Attachment[];
    /** The files an outbox row carries, in the order they were picked. */
    carried(outboxId: string): readonly Attachment[];
    /** Any change to any file. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The server's limits, asked once per scope (the defaults when it can't say). */
    limits(): Promise<MediaLimits>;
    /**
     * Copies picked files into the tray and starts their uploads. An issue's
     * tray uploads nothing; `existing` is how many files its issue already
     * has, which counts toward the server's 10.
     */
    add(
        draftScope: string,
        picked: readonly PickedFile[],
        options?: { readonly existing?: number },
    ): Promise<{ added: readonly Attachment[]; problems: readonly AddProblem[] }>;
    /** The draft scopes that hold files. */
    trays(): string[];
    /** Moves a tray's files to another draft scope (a new chat's local id to its server id). */
    rekey(from: string, to: string): void;
    /** Uploads a failed file again. */
    retry(id: string): void;
    /** Takes a file out of its tray: the server's pending upload, the copy and the row go. */
    discard(id: string): Promise<void>;
    /**
     * For a send from `draftScope`: the tray's refs by local id (the
     * payload's), the statements that move those files to outbox row `id()`
     * in the insert's transaction, and `committed()` for memory once it has.
     * Until `committed()` or `released()`, those files can't be discarded or
     * re-keyed, and no later send takes them.
     */
    forSend(draftScope: string): {
        refs: readonly AttachmentRef[];
        statements: (outboxId: () => string, lane: () => string) => SettleStatements;
        committed: (outboxId: string, lane: string) => void;
        /** The send is over (committed, nothing sent, or failed): Discard and `rekey` may take its files again. */
        released: () => void;
    };
    /**
     * For a send of one outbox row per file (an issue's files): the tray's
     * files, the statements that move each to the row `place` gives in the
     * insert's transaction, and `committed()` for memory once it has. Until
     * `committed()` or `released()`, those files can't be discarded or re-keyed.
     */
    forRows(draftScope: string): {
        files: readonly RowFile[];
        statements: (place: (fileId: string) => { outboxId: string; lane: string } | null) => SettleStatements;
        committed: (place: (fileId: string) => { outboxId: string; lane: string } | null) => void;
        released: () => void;
    };
    /** A file's bytes as base64 (an issue file's body), or null when its copy is gone. */
    base64(id: string): Promise<string | null>;
    /** A file's SHA-256 as lowercase hex, as the server records it (an issue file's check), or null when its copy is gone. */
    digest(id: string): Promise<string | null>;
    /** The server's refs for a payload's local ones, or null while any isn't uploaded. Server ids pass as they are. */
    resolve(refs: readonly AttachmentRef[]): AttachmentRef[] | null;
    /**
     * A row's pre-send step: null once its files are uploaded and fresh;
     * `retry` while any uploads (stale ones are uploaded again first);
     * `unsent` when one failed for good, or when `refs` (the row's payload)
     * names a local id this device has no file for.
     */
    prepare(outboxId: string, refs?: readonly AttachmentRef[]): Promise<SendOutcome | null>;
    /** Uploads every file of a row again (after a 400); `prepare` waits for them. */
    reupload(outboxId: string): void;
    /**
     * Uploads again the row's failed files that can be (not `missing`), for
     * Retry on a row refused for a file; `prepare` then waits for them.
     */
    rearm(outboxId: string): void;
    /**
     * Edit on a pending message: its files go back to the tray `draftScope`,
     * in one transaction, before the row is discarded (so `sweep` never
     * takes them). Files a send is moving stay where they are.
     */
    restore(outboxId: string, draftScope: string): Promise<void>;
    /** Starts every `uploading` file not already in flight. */
    pump(): void;
    /** Deletes files whose row has left `outbox` and `unsent`. */
    sweep(): Promise<void>;
    /** Stops uploads and waits for writes. Never rejects. */
    close(): Promise<void>;
}

interface StoredFile {
    readonly id: string;
    readonly path: string;
    readonly mime: string;
    readonly bytes: number;
    readonly lane: string;
    readonly name: string;
    readonly state: string;
    readonly serverId: string | null;
    readonly uploadedAt: number | null;
    readonly draftScope: string | null;
    readonly outboxId: string | null;
    readonly error: string | null;
    readonly createdAt: number;
}

const STATES: ReadonlySet<string> = new Set(['uploading', 'ready', 'failed']);

/**
 * The lane prefix of `files` rows that are uploads to the person's Files
 * (upload-file.ts), not attachments: attachments never read, upload,
 * discard or sweep them, but their copies in `attachments/` are named.
 */
export const FILE_UPLOAD_LANE = 'upload:';

export const kindOf = (mime: string): AttachmentKind =>
    mime.startsWith('image/') ? 'image' : mime.startsWith('text/') ? 'text' : 'file';

/** A safe extension from a file name, with its dot, or ''. */
function extensionOf(name: string): string {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    return match ? `.${match[1]!.toLowerCase()}` : '';
}

/** The lane a tray's files go in: a chat's, else the draft scope itself. */
const laneOf = (draftScope: string) => draftScope;

/** The chat a lane or draft scope names (`chat:<id>`), or null. */
const chatOf = (scope: string): string | null => (scope.startsWith('chat:') ? scope.slice(5) : null);

/** What an upload's answer means for its file. */
type UploadAnswer =
    | { readonly kind: 'ready'; readonly serverId: string }
    | { readonly kind: 'failed'; readonly error: AttachmentFailure }
    | { readonly kind: 'later' };

async function readUpload(response: Response, signal: AbortSignal): Promise<UploadAnswer> {
    if (response.status === 201) {
        const body = (await readJson(response, signal).catch(() => null)) as Partial<UploadResult> | null;
        const id = body?.attachment?.id;
        return typeof id === 'string' && ATTACHMENT_ID.test(id)
            ? { kind: 'ready', serverId: id }
            : { kind: 'failed', error: 'bad-answer' };
    }
    if (response.status === 413) {
        return { kind: 'failed', error: 'too-large' };
    }
    if (response.status === 415) {
        return { kind: 'failed', error: 'type' };
    }
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 408) {
        return { kind: 'later' };
    }
    return { kind: 'failed', error: 'refused' };
}

/** Opens the workspace's attachments: reads `files`, deletes copies no row names. */
export async function openAttachments(options: AttachmentsOptions): Promise<Attachments> {
    const { db, state, layout, files, setFileProtection, fetch, newId } = options;
    const { serverThread = (id) => id, processImage, processIssueImage, onError = () => {}, now = Date.now } = options;
    const writable = state.writable;

    const stored = await db.all<StoredFile>(
        `SELECT * FROM files WHERE substr(lane, 1, ${FILE_UPLOAD_LANE.length}) != ? ORDER BY createdAt, rowid`,
        [FILE_UPLOAD_LANE],
    );
    const records = new Map<string, Attachment>();
    for (const row of stored) {
        records.set(row.id, {
            id: row.id,
            name: row.name || row.path.slice(row.path.lastIndexOf('/') + 1),
            mime: row.mime,
            bytes: row.bytes,
            kind: kindOf(row.mime),
            state: (STATES.has(row.state) ? row.state : 'failed') as AttachmentState,
            error: (row.error as AttachmentFailure | null) ?? null,
            serverId: row.serverId,
            uploadedAt: row.uploadedAt,
            draftScope: row.draftScope,
            outboxId: row.outboxId,
            lane: row.lane,
            path: joinPath(layout.directory, row.path),
            createdAt: row.createdAt,
        });
    }
    if (writable) {
        // A copy a kill left before its row committed.
        // Every row's, Files uploads' too (upload-file.ts).
        const all = await db.all<{ path: string }>('SELECT path FROM files');
        const named = new Set(all.map((row) => joinPath(layout.directory, row.path)));
        for (const entry of await files.list(layout.attachments).catch(() => [])) {
            const path = joinPath(layout.attachments, entry);
            if (!named.has(path)) {
                await files.remove(path).catch(onError);
            }
        }
    }

    const listeners = new Set<() => void>();
    const emit = () => {
        for (const listener of listeners) {
            listener();
        }
    };
    const controller = new AbortController();
    const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>();
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;
    let limits: Promise<MediaLimits> | undefined;

    /** Runs a write after the ones before it; a failure goes to `onError` and to the caller. */
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task);
        queue = next.catch(() => {});
        return next;
    };

    /**
     * Writes a file's upload columns only, never where it sits: a send's
     * transaction moves it to its row while memory still names the tray, and
     * a write queued meanwhile runs after the commit, so placement written
     * from memory would put the file back in the tray.
     */
    const persist = (record: Attachment) =>
        serialize(async () => {
            if (!writable) {
                return;
            }
            await db.run('UPDATE files SET state = ?, serverId = ?, uploadedAt = ?, error = ? WHERE id = ?', [
                record.state,
                record.serverId,
                record.uploadedAt,
                record.error,
                record.id,
            ]);
        });

    /** Files a send in progress is moving to its row: Discard and `rekey` leave them. */
    const sending = new Set<string>();

    const set = (record: Attachment): Attachment => {
        if (!records.has(record.id)) {
            return record;
        }
        records.set(record.id, record);
        emit();
        persist(record).catch(onError);
        return record;
    };

    const ordered = (filter: (file: Attachment) => boolean) => [...records.values()].filter(filter);

    function threadFor(file: Attachment): string | null {
        const chat = chatOf(file.outboxId === null && file.draftScope !== null ? file.draftScope : file.lane);
        return chat === null ? null : serverThread(chat);
    }

    /** Whether `file` is an issue's: by its tray while in one, else by the lane its row went in. */
    const isIssueFile = (file: Attachment) =>
        isIssueFileScope(file.outboxId === null && file.draftScope !== null ? file.draftScope : file.lane);

    /** Uploads one file, unless it is already going; resolves when it settles. */
    function upload(id: string): Promise<void> {
        const going = inflight.get(id);
        if (going) {
            return going.done;
        }
        const file = records.get(id);
        // An issue's file goes as its own row's body, never to media.
        if (!file || closed || !writable || isIssueFile(file)) {
            return Promise.resolve();
        }
        const own = new AbortController();
        const signal = AbortSignal.any([own.signal, controller.signal]);
        const done = (async () => {
            if (file.state !== 'uploading') {
                set({ ...file, state: 'uploading', error: null });
            }
            const query = new URLSearchParams({ purpose: 'attachment' });
            const thread = threadFor(file);
            if (thread !== null) {
                query.set('threadId', thread);
            }
            let answer: UploadAnswer;
            try {
                const body = await files.body(file.path).catch(() => null);
                if (body === null) {
                    answer = { kind: 'failed', error: 'missing' };
                } else {
                    const response = await fetch(`${UPLOAD_PATH}?${query}`, {
                        upload: { body, name: file.name, type: file.mime },
                        signal,
                    });
                    answer = await readUpload(response, signal);
                }
            } catch (error) {
                if (!(error instanceof AbortedError) && !signal.aborted) {
                    onError(error);
                }
                answer = { kind: 'later' };
            }
            const current = records.get(id);
            if (!current || signal.aborted) {
                return;
            }
            if (answer.kind === 'ready') {
                set({ ...current, state: 'ready', serverId: answer.serverId, uploadedAt: now(), error: null });
            } else if (answer.kind === 'failed') {
                set({ ...current, state: 'failed', error: answer.error });
            }
        })().finally(() => inflight.delete(id));
        inflight.set(id, { controller: own, done });
        return done;
    }

    async function removeFile(file: Attachment): Promise<void> {
        inflight.get(file.id)?.controller.abort();
        records.delete(file.id);
        emit();
        await serialize(async () => {
            if (writable) {
                await db.run('DELETE FROM files WHERE id = ?', [file.id]);
                await files.remove(file.path);
            }
        });
    }

    const fresh = (file: Attachment) =>
        file.state === 'ready' && file.uploadedAt !== null && now() - file.uploadedAt <= REUPLOAD_AFTER_MS;

    const attachments: Attachments = {
        list: (draftScope) => ordered((file) => file.draftScope === draftScope),
        carried: (outboxId) => ordered((file) => file.outboxId === outboxId),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        limits() {
            limits ??= (async () => {
                const response = await fetch(MEDIA_LIMITS_PATH, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`limits: ${response.status}`);
                }
                const body = (await readJson(response, controller.signal)) as Partial<MediaLimits> | null;
                const number = (value: unknown, fallback: number) =>
                    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
                return {
                    fileMaxBytes: number(body?.fileMaxBytes, DEFAULT_MEDIA_LIMITS.fileMaxBytes),
                    perMessage: Math.min(number(body?.perMessage, MEDIA_LIMITS.perMessage), MEDIA_LIMITS.perMessage),
                    imageModelMaxBytes: number(body?.imageModelMaxBytes, DEFAULT_MEDIA_LIMITS.imageModelMaxBytes),
                };
            })().catch(() => {
                limits = undefined;
                return DEFAULT_MEDIA_LIMITS;
            });
            return limits;
        },
        async add(draftScope, picked, addOptions = {}) {
            const problems: AddProblem[] = [];
            const added: Attachment[] = [];
            if (!writable || closed) {
                return { added, problems: picked.map((file) => ({ name: file.name, reason: 'read-only' as const })) };
            }
            const issue = isIssueFileScope(draftScope);
            // An issue's limits are shared's, not media's: nothing is asked.
            const max = issue
                ? { fileMaxBytes: ISSUE_ATTACHMENT_MAX_BYTES, perMessage: ISSUE_ATTACHMENTS_PER_ISSUE }
                : await attachments.limits();
            const process = issue ? processIssueImage : processImage;
            await prepareAttachmentsFolder({ fs: files, setFileProtection }, layout);
            for (const original of picked) {
                const temporaries = new Set<string>(original.temporary ? [original.uri] : []);
                let file = original;
                let keepOriginal = false;
                try {
                    if (process && original.mime.startsWith('image/')) {
                        file = await process(original);
                        if (file.uri !== original.uri) {
                            temporaries.add(file.uri);
                        }
                    }
                    const count = attachments.list(draftScope).length;
                    if (issue) {
                        // After the processor: a GIF over 5 MiB (never scaled), an unconverted HEIC, a result still too large.
                        const candidate = { name: file.name, size: file.bytes, mediaType: file.mime };
                        const { refused } = acceptFiles([candidate], count + (addOptions.existing ?? 0));
                        if (refused.length > 0) {
                            problems.push({ name: original.name, reason: issueProblem(file), message: refused[0] });
                            continue;
                        }
                    }
                    const reason: AddProblem['reason'] | null =
                        file.bytes <= 0
                            ? 'empty'
                            : file.bytes > max.fileMaxBytes
                              ? 'too-large'
                              : count >= max.perMessage
                                ? 'too-many'
                                : null;
                    if (reason !== null) {
                        problems.push({ name: original.name, reason });
                        continue;
                    }
                    const id = newId();
                    const relative = `attachments/${id}${extensionOf(file.name)}`;
                    const path = joinPath(layout.directory, relative);
                    const record: Attachment = {
                        id,
                        name: file.name,
                        mime: file.mime,
                        bytes: file.bytes,
                        kind: kindOf(file.mime),
                        // An issue's file is whole on the phone: it goes with its row.
                        state: issue ? 'ready' : 'uploading',
                        error: null,
                        serverId: null,
                        uploadedAt: null,
                        draftScope,
                        outboxId: null,
                        lane: laneOf(draftScope),
                        path,
                        createdAt: now(),
                    };
                    await serialize(async () => {
                        await files.copy(file.uri, path);
                        try {
                            await db.run(
                                `INSERT INTO files (id, path, mime, bytes, lane, name, state, draftScope, createdAt)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                [
                                    id,
                                    relative,
                                    file.mime,
                                    file.bytes,
                                    record.lane,
                                    file.name,
                                    record.state,
                                    draftScope,
                                    record.createdAt,
                                ],
                            );
                        } catch (error) {
                            await files.remove(path).catch(() => {});
                            throw error;
                        }
                    });
                    records.set(id, record);
                    added.push(record);
                    emit();
                    void upload(id);
                } catch (error) {
                    onError(error);
                    problems.push({ name: original.name, reason: 'copy-failed' });
                    // Nothing durable: the picker's own file stays, so a retry can read it.
                    keepOriginal = true;
                } finally {
                    // Durable or refused: the picker's files are no longer needed.
                    for (const temporary of temporaries) {
                        if (!(keepOriginal && temporary === original.uri)) {
                            await files.remove(temporary).catch(onError);
                        }
                    }
                }
            }
            return { added, problems };
        },
        trays: () => [...new Set(ordered((file) => file.draftScope !== null).map((file) => file.draftScope!))],
        rekey(from, to) {
            const moving = attachments.list(from).filter((file) => !sending.has(file.id));
            if (moving.length === 0) {
                return;
            }
            for (const file of moving) {
                records.set(file.id, { ...file, draftScope: to, lane: laneOf(to) });
            }
            emit();
            serialize(async () => {
                if (!writable) {
                    return;
                }
                for (const file of moving) {
                    // Only while still in a tray: a send may have moved it to its row since.
                    await db.run('UPDATE files SET draftScope = ?, lane = ? WHERE id = ? AND outboxId IS NULL', [
                        to,
                        laneOf(to),
                        file.id,
                    ]);
                }
            }).catch(onError);
        },
        retry(id) {
            const file = records.get(id);
            if (file && file.state === 'failed' && file.error !== 'missing') {
                set({ ...file, state: 'uploading', error: null });
                void upload(id);
            }
        },
        async discard(id) {
            const file = records.get(id);
            if (!file || file.outboxId !== null || sending.has(id)) {
                return;
            }
            const serverId = file.serverId;
            await removeFile(file);
            if (serverId !== null) {
                try {
                    const response = await fetch(`/api/media/attachments/${encodeURIComponent(serverId)}`, {
                        method: 'DELETE',
                        signal: controller.signal,
                    });
                    await response.body?.cancel().catch(() => {});
                } catch {
                    // Best effort: the server drops an unsent upload after 24 h.
                }
            }
        },
        forSend(draftScope) {
            // Uploading ones go too: the row waits in its lane for them (`prepare`).
            const ready = attachments
                .list(draftScope)
                .filter((file) => file.state !== 'failed' && !sending.has(file.id));
            for (const file of ready) {
                sending.add(file.id);
            }
            const released = () => {
                for (const file of ready) {
                    sending.delete(file.id);
                }
            };
            const refs = ready.map((file) => ({
                id: file.id,
                name: file.name,
                mediaType: file.mime,
                size: file.bytes,
                kind: file.kind,
            }));
            const statements =
                (outboxId: () => string, lane: () => string): SettleStatements =>
                async (tx: SqlStatements) => {
                    for (const file of ready) {
                        await tx.run('UPDATE files SET draftScope = NULL, outboxId = ?, lane = ? WHERE id = ?', [
                            outboxId(),
                            lane(),
                            file.id,
                        ]);
                    }
                };
            const committed = (outboxId: string, lane: string) => {
                released();
                for (const file of ready) {
                    const current = records.get(file.id);
                    if (current) {
                        records.set(file.id, { ...current, draftScope: null, outboxId, lane });
                    }
                }
                emit();
            };
            return { refs, statements, committed, released };
        },
        forRows(draftScope) {
            const taken = attachments
                .list(draftScope)
                .filter((file) => file.state !== 'failed' && !sending.has(file.id));
            for (const file of taken) {
                sending.add(file.id);
            }
            const released = () => {
                for (const file of taken) {
                    sending.delete(file.id);
                }
            };
            return {
                files: taken.map(({ id, name, mime, bytes }) => ({ id, name, mime, bytes })),
                statements: (place) => async (tx: SqlStatements) => {
                    for (const file of taken) {
                        const at = place(file.id);
                        if (at !== null) {
                            await tx.run('UPDATE files SET draftScope = NULL, outboxId = ?, lane = ? WHERE id = ?', [
                                at.outboxId,
                                at.lane,
                                file.id,
                            ]);
                        }
                    }
                },
                committed: (place) => {
                    released();
                    for (const file of taken) {
                        const at = place(file.id);
                        const current = records.get(file.id);
                        if (at !== null && current) {
                            records.set(file.id, {
                                ...current,
                                draftScope: null,
                                outboxId: at.outboxId,
                                lane: at.lane,
                            });
                        }
                    }
                    emit();
                },
                released,
            };
        },
        async base64(id) {
            const file = records.get(id);
            if (!file || !files.base64) {
                return null;
            }
            return files.base64(file.path).catch(() => null);
        },
        async digest(id) {
            const file = records.get(id);
            if (!file || !files.sha256) {
                return null;
            }
            return files.sha256(file.path).catch(() => null);
        },
        resolve(refs) {
            const resolved: AttachmentRef[] = [];
            for (const ref of refs) {
                if (ATTACHMENT_ID.test(ref.id)) {
                    resolved.push(ref);
                    continue;
                }
                const file = records.get(ref.id);
                if (!file || file.state !== 'ready' || file.serverId === null) {
                    return null;
                }
                resolved.push({ ...ref, id: file.serverId });
            }
            return resolved;
        },
        async prepare(outboxId, refs = []) {
            if (refs.some((ref) => !ATTACHMENT_ID.test(ref.id) && !records.has(ref.id))) {
                // Its file is gone: waiting would hold the lane forever.
                return { action: 'unsent', reason: 'attachment-failed' };
            }
            const carried = attachments.carried(outboxId);
            for (const file of carried) {
                if (file.state === 'ready' && !fresh(file)) {
                    set({ ...file, state: 'uploading', serverId: null, uploadedAt: null });
                }
            }
            await Promise.all(
                attachments
                    .carried(outboxId)
                    .filter((file) => file.state === 'uploading')
                    .map((file) => upload(file.id)),
            );
            const settled = attachments.carried(outboxId);
            if (settled.some((file) => file.state === 'failed')) {
                return { action: 'unsent', reason: 'attachment-failed' };
            }
            return settled.every(fresh) ? null : { action: 'retry', reason: 'uploading' };
        },
        reupload(outboxId) {
            for (const file of attachments.carried(outboxId)) {
                inflight.get(file.id)?.controller.abort();
                set({ ...file, state: 'uploading', serverId: null, uploadedAt: null, error: null });
            }
        },
        rearm(outboxId) {
            for (const file of attachments.carried(outboxId)) {
                attachments.retry(file.id);
            }
        },
        async restore(outboxId, draftScope) {
            const moving = attachments.carried(outboxId).filter((file) => !sending.has(file.id));
            if (moving.length === 0 || !writable || closed) {
                return;
            }
            await serialize(() =>
                db.transaction(async (tx) => {
                    for (const file of moving) {
                        await tx.run(
                            'UPDATE files SET draftScope = ?, outboxId = NULL, lane = ? WHERE id = ? AND outboxId = ?',
                            [draftScope, laneOf(draftScope), file.id, outboxId],
                        );
                    }
                }),
            );
            for (const file of moving) {
                const current = records.get(file.id);
                if (current?.outboxId === outboxId) {
                    records.set(file.id, { ...current, draftScope, outboxId: null, lane: laneOf(draftScope) });
                }
            }
            emit();
        },
        pump() {
            for (const file of records.values()) {
                if (file.state === 'uploading') {
                    void upload(file.id);
                }
            }
        },
        async sweep() {
            if (!writable || closed) {
                return;
            }
            const gone = await db.all<{ id: string }>(
                `SELECT id FROM files WHERE outboxId IS NOT NULL
                 AND outboxId NOT IN (SELECT id FROM outbox) AND outboxId NOT IN (SELECT id FROM unsent)`,
            );
            for (const { id } of gone) {
                const file = records.get(id);
                // Not one an Edit put back in a tray since the query.
                if (file && file.outboxId !== null) {
                    await removeFile(file);
                }
            }
        },
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            controller.abort();
            await Promise.all([...inflight.values()].map((going) => going.done.catch(() => {})));
            await queue;
            listeners.clear();
        },
    };
    return attachments;
}

/** A chat message's payload, as far as attachments go (chat-send.ts's `ChatMessagePayload`). */
interface WithAttachments {
    readonly attachments?: readonly AttachmentRef[];
    readonly reuploaded?: true;
}

/**
 * The "re-upload once" for a message kind (its `reupload` option): the
 * row's files go up again, and the row is rewritten with `reuploaded` under a
 * fresh key. Its payload names the files by local id, so it needs no new refs:
 * `prepare` holds the row until they are uploaded, `resolve` gives the new ids.
 */
export function reuploadHook<Payload extends WithAttachments = WithAttachments>(
    attachments: Pick<Attachments, 'reupload'>,
    newId: () => string,
    payloadVersion: number,
): (write: OutboxWrite<Payload>) => Promise<SendOutcome> {
    return async (write) => {
        attachments.reupload(write.row.id);
        return {
            action: 'rewrite',
            // The stored payload, by local ids: the write in hand may carry server ids.
            payload: JSON.stringify({ ...(JSON.parse(write.row.payload) as object), reuploaded: true }),
            payloadVersion,
            idempotencyKey: newId(),
            reason: 'reuploaded',
        };
    };
}

/**
 * A send from a composer with files: the draft's text and the tray's
 * files go to one outbox row in one transaction;
 * `build` gets the text and the refs by local id. A box with files and no
 * text sends too. Resolves with the row once durable, or null for nothing to send.
 */
export async function enqueueWithAttachments(
    drafts: Pick<Drafts, 'enqueueFromDraft'>,
    attachments: Pick<Attachments, 'forSend'>,
    draftScope: string,
    build: (text: string, refs: readonly AttachmentRef[]) => NewOutboxWrite | readonly NewOutboxWrite[],
): Promise<OutboxRow | null> {
    const send = attachments.forSend(draftScope);
    /** The message: the last write (a new chat's create comes first). */
    let message: NewOutboxWrite | null = null;
    try {
        const row = await drafts.enqueueFromDraft(
            draftScope,
            (text) => {
                const built = build(text, send.refs);
                message = Array.isArray(built)
                    ? ((built as readonly NewOutboxWrite[]).at(-1) ?? null)
                    : (built as NewOutboxWrite);
                return built;
            },
            {
                also: send.statements(
                    () => message!.id,
                    () => message!.lane,
                ),
                allowBlank: send.refs.length > 0,
            },
        );
        if (row !== null) {
            send.committed(row.id, row.lane);
        }
        return row;
    } finally {
        send.released();
    }
}
