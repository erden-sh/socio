import type { MediaItem, MediaListing, UploadResult } from '@socio/shared/media-types';

import { joinPath, type SqlConnection, type UserDbState } from '../data';
import type { WorkspaceLayout } from '../data/layout';
import type { WorkspaceFilesDeps } from '../data/workspace-files';
import { prepareAttachmentsFolder } from '../data/workspace-files';
import { type AuthedFetch, UPLOAD_PATH } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import { readJson } from '../net/read-body';

import { type AttachmentFiles, FILE_UPLOAD_LANE, type ImageProcessor, type PickedFile } from './attachments';
import { pageImageProblem } from './image-processing';
import type { SendOutcome } from './outbox';
import type { ViewState } from './view-state';

// Uploads to the person's Files: a page's cover and, later, a pasted image go
// up as `purpose=file`, which answers `{ item }` (a file in their Files, kept
// for good), never an attachment. So this isn't attachments.ts: it has its own
// state and never runs attachments' Discard, sweep or 23 h re-upload. It shares
// attachments' copy-then-commit (`prepareAttachmentsFolder`, a copy into
// `attachments/`, the row in user.db's `files` under the lane `upload:<id>`,
// then the picker's files go) and attachments' open, which deletes a copy no
// row names. No React Native: tests/sync runs it under Node.
//
// - **The page image profile first:** the injected processor (the platform's
//   `processPageImage`) makes HEIC and anything over 5 MB a JPEG under it, and
//   `pageImageProblem` refuses what still isn't a cover's type or size before
//   a row is written, so nothing the server would answer 413 or 415 is queued.
// - **A unique name:** `cover-<localId>.jpg` (or `image-…`, with the file's own
//   extension). The server keeps the name and only suffixes the path, so an
//   outcome it can't tell is settled by `GET /api/media` for exactly that
//   name: found is uploaded, absent goes again. No duplicate on a retry.
// - **Unknown before the request:** the row is written `unknown` before the
//   POST; no answer, a 5xx or a kill leaves it so, and the next `pump()`
//   lists before it uploads again. 401, 408 and 429 were refused before
//   anything was stored: they upload again on the next pump. 413 and 415 are
//   `too-large` and `type`, other refusals `refused`, with words, never the
//   server's text.
// - **Used by reference:** a write (page-manage.ts's `page-cover`) names the upload's
//   local id; `prepare` holds it while it uploads and refuses it when the
//   upload failed, `resolve` gives the file's id, and `forget` drops the row
//   and the copy once the write settled.
// - **"Saved to your Files"** once per workspace (`takeSavedNote`), kept in
//   cache.db's view state: every cover and pasted image lands there.

/** What an upload is for: it names the file. */
export type FileUploadPurpose = 'cover' | 'image';

export type FileUploadState = 'uploading' | 'ready' | 'failed';

/** Why an upload failed: a code, never the server's text. */
export type FileUploadFailure = 'too-large' | 'type' | 'refused' | 'bad-answer' | 'missing';

/** Why a picked image wasn't taken. */
export type FileUploadProblem = 'empty' | 'too-large' | 'type' | 'copy-failed' | 'read-only';

/** The words for each failure and problem. */
export const FILE_UPLOAD_COPY: Readonly<Record<FileUploadFailure | FileUploadProblem, string>> = {
    'too-large': 'Images can be at most 5 MB.',
    type: 'Use a PNG, JPEG or WebP image.',
    refused: 'The image couldn’t be uploaded.',
    'bad-answer': 'The image couldn’t be uploaded.',
    missing: 'The image is no longer on this phone.',
    empty: 'The image is empty.',
    'copy-failed': 'The image couldn’t be saved on this phone.',
    'read-only': 'Update Socio to add images here.',
};

export const SAVED_TO_FILES_NOTE = 'Saved to your Files';
/** The view state key that says the note was shown in this workspace. */
export const SAVED_TO_FILES_KEY = 'note:saved-to-files';

export const MEDIA_LIST_PATH = '/api/media';

export interface FileUpload {
    /** The local id: what a write names. */
    readonly id: string;
    /** The unique name the server keeps (`cover-<id>.jpg`). */
    readonly name: string;
    readonly mime: string;
    readonly bytes: number;
    readonly purpose: FileUploadPurpose;
    readonly state: FileUploadState;
    readonly error: FileUploadFailure | null;
    /** The file's id in the person's Files (`MediaItem.id`) once uploaded. */
    readonly serverId: string | null;
    /** The copy, absolute. */
    readonly path: string;
    readonly createdAt: number;
}

export interface FileUploadsOptions {
    /** user.db, open; the scope closes it after `close()`. */
    readonly db: SqlConnection;
    readonly state: UserDbState;
    readonly layout: WorkspaceLayout;
    readonly files: AttachmentFiles;
    readonly setFileProtection: WorkspaceFilesDeps['setFileProtection'];
    /** The scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** A fresh id (expo-crypto): each upload's local id and name. */
    readonly newId: () => string;
    /** The page image profile (the platform's `processPageImage`). Without it, the file is only checked. */
    readonly processImage?: ImageProcessor;
    /** cache.db's view state, for the note once per workspace. */
    readonly viewState?: Pick<ViewState, 'get' | 'set'>;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

export interface FileUploads {
    get(id: string): FileUpload | null;
    /** Every upload, oldest first. */
    list(): readonly FileUpload[];
    /** Any change to any upload. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Runs the profile, copies the image, commits its row and starts its upload. */
    add(
        picked: PickedFile,
        purpose: FileUploadPurpose,
    ): Promise<{ readonly upload: FileUpload } | { readonly problem: FileUploadProblem }>;
    /**
     * A write's pre-send step: null once uploaded; `retry` while it uploads
     * (started here if it waits); `unsent` when it failed for good or this
     * device has no such upload.
     */
    prepare(id: string): Promise<SendOutcome | null>;
    /** Resolves once the try in flight (if any) settles; starts none. */
    settled(id: string): Promise<void>;
    /** The file's id in the person's Files, or null while it isn't uploaded. */
    resolve(id: string): string | null;
    /** Uploads a failed one again (not one whose copy is gone). */
    retry(id: string): void;
    /** The write that used it has settled: the row and the copy go. The file stays in the person's Files. */
    forget(id: string): Promise<void>;
    /** Starts every upload that waits, listing first for one whose outcome is unknown. */
    pump(): void;
    /** "Saved to your Files" the first time in this workspace, then null. */
    takeSavedNote(): typeof SAVED_TO_FILES_NOTE | null;
    /** Stops uploads and waits for writes. Never rejects. */
    close(): Promise<void>;
}

interface StoredUpload {
    readonly id: string;
    readonly path: string;
    readonly mime: string;
    readonly bytes: number;
    readonly lane: string;
    readonly name: string;
    readonly state: string;
    readonly serverId: string | null;
    readonly error: string | null;
    readonly createdAt: number;
}

/** The `files.state` of an upload whose request went and whose outcome isn't known. */
const UNKNOWN = 'unknown';
const FAILURES: ReadonlySet<string> = new Set(['too-large', 'type', 'refused', 'bad-answer', 'missing']);

const EXTENSIONS: Readonly<Record<string, string>> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

/** `cover-<id>.jpg`: unique, so the listing can find exactly this upload. */
export const uploadName = (purpose: FileUploadPurpose, id: string, mime: string) =>
    `${purpose}-${id}${EXTENSIONS[mime] ?? ''}`;

const purposeOf = (name: string): FileUploadPurpose => (name.startsWith('image-') ? 'image' : 'cover');

/** What an answer means for the upload. */
type Answer =
    | { readonly kind: 'ready'; readonly serverId: string }
    | { readonly kind: 'failed'; readonly error: FileUploadFailure }
    /** Refused before anything was stored: upload again later. */
    | { readonly kind: 'later' }
    /** It may be stored: list before uploading again. */
    | { readonly kind: 'unknown' };

async function readUpload(response: Response, signal: AbortSignal): Promise<Answer> {
    if (response.status === 201) {
        const body = (await readJson(response, signal).catch(() => null)) as Partial<UploadResult> | null;
        const id = body?.item?.id;
        return typeof id === 'string' && id !== '' ? { kind: 'ready', serverId: id } : { kind: 'unknown' };
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 413) {
        return { kind: 'failed', error: 'too-large' };
    }
    if (response.status === 415) {
        return { kind: 'failed', error: 'type' };
    }
    if (response.status === 401 || response.status === 408 || response.status === 429) {
        return { kind: 'later' };
    }
    if (response.status >= 500) {
        // A proxy's 502 or 504 may follow a stored file.
        return { kind: 'unknown' };
    }
    return { kind: 'failed', error: 'refused' };
}

/** Opens the workspace's Files uploads: reads their rows from `files`. */
export async function openFileUploads(options: FileUploadsOptions): Promise<FileUploads> {
    const { db, state, layout, files, setFileProtection, fetch, newId, processImage, viewState } = options;
    const { onError = () => {}, now = Date.now } = options;
    const writable = state.writable;

    const records = new Map<string, FileUpload>();
    /** Uploads whose last request may have reached the server. */
    const unknown = new Set<string>();
    const stored = await db.all<StoredUpload>(
        `SELECT id, path, mime, bytes, lane, name, state, serverId, error, createdAt FROM files
         WHERE substr(lane, 1, ${FILE_UPLOAD_LANE.length}) = ? ORDER BY createdAt, rowid`,
        [FILE_UPLOAD_LANE],
    );
    for (const row of stored) {
        const ready = row.state === 'ready' && row.serverId !== null;
        const failed = row.state === 'failed';
        if (row.state === UNKNOWN) {
            unknown.add(row.id);
        }
        records.set(row.id, {
            id: row.id,
            name: row.name,
            mime: row.mime,
            bytes: row.bytes,
            purpose: purposeOf(row.name),
            state: ready ? 'ready' : failed ? 'failed' : 'uploading',
            error: failed ? ((FAILURES.has(row.error ?? '') ? row.error : 'refused') as FileUploadFailure) : null,
            serverId: ready ? row.serverId : null,
            path: joinPath(layout.directory, row.path),
            createdAt: row.createdAt,
        });
    }

    const listeners = new Set<() => void>();
    const emit = () => {
        for (const listener of listeners) {
            listener();
        }
    };
    const controller = new AbortController();
    const inflight = new Map<string, Promise<void>>();
    let queue: Promise<unknown> = Promise.resolve();
    let closed = false;

    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task);
        queue = next.catch(() => {});
        return next;
    };

    /** Writes the upload's state, `unknown` while its outcome can't be told. */
    const persist = (record: FileUpload) =>
        serialize(async () => {
            if (!writable) {
                return;
            }
            const column = record.state === 'uploading' && unknown.has(record.id) ? UNKNOWN : record.state;
            await db.run('UPDATE files SET state = ?, serverId = ?, uploadedAt = ?, error = ? WHERE id = ?', [
                column,
                record.serverId,
                record.state === 'ready' ? now() : null,
                record.error,
                record.id,
            ]);
        });

    const set = (record: FileUpload) => {
        if (!records.has(record.id)) {
            return;
        }
        records.set(record.id, record);
        emit();
        persist(record).catch(onError);
    };

    /** The file named `name` in the person's Files, null when absent, undefined when the listing can't say. */
    async function find(name: string, signal: AbortSignal): Promise<MediaItem | null | undefined> {
        const query = new URLSearchParams({ q: name, limit: '200' });
        try {
            const response = await fetch(`${MEDIA_LIST_PATH}?${query}`, { signal });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                return undefined;
            }
            const listing = (await readJson(response, signal)) as Partial<MediaListing> | null;
            if (!Array.isArray(listing?.items) || listing.nextCursor !== undefined) {
                return undefined;
            }
            return listing.items.find((item) => item?.name === name && typeof item.id === 'string') ?? null;
        } catch (error) {
            if (!(error instanceof AbortedError) && !signal.aborted) {
                onError(error);
            }
            return undefined;
        }
    }

    /** Uploads one, unless it is already going; resolves when it settles. */
    function upload(id: string): Promise<void> {
        const going = inflight.get(id);
        if (going) {
            return going;
        }
        const start = records.get(id);
        if (!start || start.state !== 'uploading' || closed || !writable) {
            return Promise.resolve();
        }
        const signal = controller.signal;
        const done = (async () => {
            if (unknown.has(id)) {
                const found = await find(start.name, signal);
                if (found === undefined || signal.aborted) {
                    return;
                }
                if (found !== null) {
                    unknown.delete(id);
                    set({ ...records.get(id)!, state: 'ready', serverId: found.id, error: null });
                    return;
                }
            }
            const body = await files.body(start.path).catch(() => null);
            if (body === null) {
                unknown.delete(id);
                set({ ...start, state: 'failed', error: 'missing' });
                return;
            }
            // On disk before the request: a kill from here on lists first.
            unknown.add(id);
            await persist(start);
            let answer: Answer;
            try {
                const response = await fetch(`${UPLOAD_PATH}?${new URLSearchParams({ purpose: 'file' })}`, {
                    upload: { body, name: start.name, type: start.mime },
                    signal,
                });
                answer = await readUpload(response, signal);
            } catch (error) {
                if (!(error instanceof AbortedError) && !signal.aborted) {
                    onError(error);
                }
                answer = { kind: 'unknown' };
            }
            const current = records.get(id);
            if (!current || signal.aborted || answer.kind === 'unknown') {
                return;
            }
            unknown.delete(id);
            if (answer.kind === 'ready') {
                set({ ...current, state: 'ready', serverId: answer.serverId, error: null });
            } else if (answer.kind === 'failed') {
                set({ ...current, state: 'failed', error: answer.error });
            } else {
                await persist(current);
            }
        })()
            .catch(onError)
            .finally(() => inflight.delete(id));
        inflight.set(id, done);
        return done;
    }

    const uploads: FileUploads = {
        get: (id) => records.get(id) ?? null,
        list: () => [...records.values()],
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async add(original, purpose) {
            if (!writable || closed) {
                return { problem: 'read-only' };
            }
            const temporaries = new Set<string>(original.temporary ? [original.uri] : []);
            let keepOriginal = false;
            try {
                let file = original;
                if (processImage) {
                    file = await processImage(original);
                    if (file.uri !== original.uri) {
                        temporaries.add(file.uri);
                    }
                }
                const problem = pageImageProblem(file);
                if (problem !== null) {
                    return { problem };
                }
                await prepareAttachmentsFolder({ fs: files, setFileProtection }, layout);
                const id = newId();
                const name = uploadName(purpose, id, file.mime);
                const relative = `attachments/${name}`;
                const record: FileUpload = {
                    id,
                    name,
                    mime: file.mime,
                    bytes: file.bytes,
                    purpose,
                    state: 'uploading',
                    error: null,
                    serverId: null,
                    path: joinPath(layout.directory, relative),
                    createdAt: now(),
                };
                await serialize(async () => {
                    await files.copy(file.uri, record.path);
                    try {
                        await db.run(
                            `INSERT INTO files (id, path, mime, bytes, lane, name, state, createdAt)
                             VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?)`,
                            [id, relative, file.mime, file.bytes, `${FILE_UPLOAD_LANE}${id}`, name, record.createdAt],
                        );
                    } catch (error) {
                        await files.remove(record.path).catch(() => {});
                        throw error;
                    }
                });
                records.set(id, record);
                emit();
                void upload(id);
                return { upload: record };
            } catch (error) {
                onError(error);
                // Nothing durable: the picker's own file stays, so a retry can read it.
                keepOriginal = true;
                return { problem: 'copy-failed' };
            } finally {
                for (const temporary of temporaries) {
                    if (!(keepOriginal && temporary === original.uri)) {
                        await files.remove(temporary).catch(onError);
                    }
                }
            }
        },
        async prepare(id) {
            if (!records.has(id)) {
                return { action: 'unsent', reason: 'upload-missing' };
            }
            await upload(id);
            const settled = records.get(id);
            if (!settled) {
                return { action: 'unsent', reason: 'upload-missing' };
            }
            if (settled.state === 'failed') {
                return { action: 'unsent', reason: 'upload-failed' };
            }
            return settled.state === 'ready' ? null : { action: 'retry', reason: 'uploading' };
        },
        settled: (id) => inflight.get(id) ?? Promise.resolve(),
        resolve: (id) => {
            const record = records.get(id);
            return record?.state === 'ready' ? record.serverId : null;
        },
        retry(id) {
            const record = records.get(id);
            if (record?.state === 'failed' && record.error !== 'missing') {
                set({ ...record, state: 'uploading', error: null });
                void upload(id);
            }
        },
        async forget(id) {
            const record = records.get(id);
            if (!record) {
                return;
            }
            records.delete(id);
            unknown.delete(id);
            emit();
            await serialize(async () => {
                if (writable) {
                    await db.run('DELETE FROM files WHERE id = ?', [id]);
                    await files.remove(record.path);
                }
            });
        },
        pump() {
            for (const record of records.values()) {
                if (record.state === 'uploading') {
                    void upload(record.id);
                }
            }
        },
        takeSavedNote() {
            if (!viewState || viewState.get(SAVED_TO_FILES_KEY) !== null) {
                return null;
            }
            viewState.set(SAVED_TO_FILES_KEY, '1');
            return SAVED_TO_FILES_NOTE;
        },
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            controller.abort();
            await Promise.all([...inflight.values()]);
            await queue;
            listeners.clear();
        },
    };
    return uploads;
}
