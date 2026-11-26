import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { Message } from '@ag-ui/client';

import { sqliteData } from '@socio/data/open';
import { SYSTEM, deletedWith } from '@socio/data/soft-delete';
import type { UnitOfWork } from '@socio/data/uow';
import { DataError } from '@socio/foundation/dataspace/data-error';
import { normalizePath } from '@socio/foundation/dataspace/paths';
import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import { compareText } from '@socio/shared/locale';
import {
    MEDIA_LIMITS,
    type AttachmentKind,
    type AttachmentRef,
    type AttachmentSource,
    type AttachmentView,
    type MediaItem,
    type MediaKind,
    type MediaListing,
    type UploadResult,
} from '@socio/shared/media-types';
import { cleanName } from '@socio/shared/media/file-types';
import { attachmentIds, attachmentPart } from '@socio/shared/media/refs';
import { COVER_MAX_BYTES, coverUrl, type CoverImage, type PageCover } from '@socio/shared/pages/page-library';
import type { ToolImage } from '@socio/shared/tool-images';

import { classify, itemKind, safeName, suffixed } from './classify.js';
import {
    MediaError,
    type AttachmentRow,
    type BindTurn,
    type MediaDataShape,
    type MediaFile,
    type MediaSettings,
    type MediaShape,
    type MediaWorkspaceShape,
    MODEL_IMAGE_TYPES,
    type ResolveTurn,
    SPACE_UPLOAD_LIMITS,
    SPACE_UPLOAD_TYPES,
} from './contract.js';
import type { EmbedMedia, MediaRepositories } from './domain/repositories.js';
import { sqliteMediaRepositories } from './infra/sqlite/index.js';
import { resolveMessages } from './resolve.js';

const MB = 1048576;

/** A Space upload as the tool reports it (CB-524). */
export interface SpaceUploadView {
    id: string;
    url: string;
    name: string;
    mediaType: string;
    kind: 'image' | 'pdf';
    size: number;
    reused: boolean;
}

export interface MediaServiceOptions {
    data: MediaDataShape;
    workspace: MediaWorkspaceShape;
    settings?: MediaSettings;
    now?: () => number;
    /**
     * Unsent attachments that are still on their way (CB-223: a queued
     * message's), which the cleanup of unsent ones keeps; once nothing holds
     * one, it is cleaned up as any other.
     */
    held?: () => Promise<ReadonlySet<string>>;
}

/** Decrypted image bytes for the model, kept a while: history is re-sent every turn. */
class ImageCache {
    private entries = new Map<string, { data: Buffer; at: number }>();
    private bytes = 0;
    constructor(
        private maxBytes = 64 * MB,
        private ttlMs = 10 * 60_000,
    ) {}
    get(key: string, now: number) {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        this.entries.delete(key);
        if (entry.at + this.ttlMs < now) {
            this.bytes -= entry.data.length;
            return undefined;
        }
        // Most recently used last.
        this.entries.set(key, entry);
        return entry.data;
    }
    set(key: string, data: Buffer, now: number) {
        if (data.length > this.maxBytes) {
            return;
        }
        const old = this.entries.get(key);
        if (old) {
            this.entries.delete(key);
            this.bytes -= old.data.length;
        }
        this.entries.set(key, { data, at: now });
        this.bytes += data.length;
        for (const [oldest, entry] of this.entries) {
            if (this.bytes <= this.maxBytes) {
                break;
            }
            this.entries.delete(oldest);
            this.bytes -= entry.data.length;
        }
    }
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const newId = () => `cbatt_${randomBytes(16).toString('base64url')}`;
const newEmbedId = () => `cbemb_${randomBytes(16).toString('base64url')}`;
/** How many of a Space's newest media the picker looks through. */
const SPACE_IMAGES_SCAN = 200;

/**
 * Chat attachments (CB-54): uploads into the user's data space, the link
 * from each file to the conversation it was attached in, reading them for
 * the people who may, and resolving message references for the model.
 */
export class MediaService implements MediaShape {
    readonly imageModelMaxBytes: number;
    private cache = new ImageCache();
    private rate = new Map<string, number[]>();
    /** Per thread: the attachments the last turn showed the model as images. */
    private shownImages = new Map<string, Set<string>>();
    private uow: UnitOfWork;
    private repos: MediaRepositories;
    constructor(
        db: DatabaseSync,
        private options: MediaServiceOptions,
    ) {
        const data = sqliteData(db);
        this.uow = data.uow;
        this.repos = sqliteMediaRepositories(data);
        this.imageModelMaxBytes = options.settings?.imageModelMaxBytes ?? 10 * MB;
        // The Dot of a conversation reads what the user attached there.
        options.data.useConversationReads((userId, path, threadId) => this.shown(userId, path, threadId));
        // A deleted file takes its attachments with it (hidden and kept, CB-64);
        // history then says so. One removed on its own before keeps its stamp.
        options.data.onFileDeleted((userId, fileId, { at, by }) =>
            this.repos.attachments.removeWithFile(userId, fileId, {
                at,
                by,
                with: deletedWith('file', fileId),
            }),
        );
    }
    private now() {
        return this.options.now?.() ?? Date.now();
    }
    get data() {
        return this.options.data;
    }
    /** What media reads of the workspace (Space access, pages), at the moment of use. */
    get workspace() {
        return this.options.workspace;
    }

    // ---- rows -------------------------------------------------------------
    /** A live attachment; a deleted one is missing (CB-64). */
    attachment(id: string) {
        return this.repos.attachments.byId(id);
    }
    /** An attachment, deleted or not, with its stamp (admin, tests). */
    withDeletedAttachment(id: string) {
        return this.repos.attachments.withDeleted(id);
    }
    ref(row: AttachmentRow): AttachmentRef {
        return {
            id: row.id,
            name: row.name,
            mediaType: row.mediaType,
            size: row.size,
            kind: row.kind,
        };
    }
    view(row: AttachmentRow): AttachmentView {
        return {
            ...this.ref(row),
            threadId: row.threadId,
            dotId: row.dotId,
            path: this.file(row)?.path ?? null,
            createdAt: row.createdAt,
            boundAt: row.boundAt,
            source: row.source,
        };
    }
    /** The attachment's file, or undefined once it was deleted. */
    file(row: AttachmentRow) {
        return this.options.data.fileRecord(row.ownerUserId, row.fileId);
    }
    /** The attachments a thread's messages have carried, oldest first. */
    forThread(threadId: string) {
        return this.repos.attachments.forThread(threadId);
    }
    /**
     * Whether `path` is an attachment of `userId` that a message in
     * `threadId` carried: that thread's Dot may read it without a grant.
     */
    private async shown(userId: string, path: string, threadId: string) {
        let file;
        try {
            file = this.options.data.fileAt(userId, path);
        } catch (error) {
            // A socio's own path can be longer than a path may be given: dots/<id>/
            // plus 12 parts. Such a path is never an attachment.
            if (error instanceof DataError) {
                return false;
            }
            throw error;
        }
        return !!file && (await this.repos.attachments.carried(userId, threadId, file.id));
    }
    /**
     * Whether an attachment is its person's alone wherever it is (CB-209):
     * what a tool made in their turn in a room (a screenshot of their
     * computer home), as its result is. A legacy Telegram
     * topic's readers see its screenshots, as before.
     */
    personal(row: Pick<AttachmentRow, 'source' | 'threadId'>) {
        return row.source === 'tool' && !!row.threadId && this.options.workspace.thread(row.threadId)?.kind === 'room';
    }
    /**
     * An attachment `userId` may see: their own, or one a person posted in a
     * conversation they can read (a team topic, a room), but what a tool
     * made in someone else's room turn (`personal`). Anything else is
     * missing, never refused, so ids can't be probed.
     */
    async readable(userId: string, id: string) {
        const row = await this.attachment(id);
        if (!row) {
            return undefined;
        }
        if (row.ownerUserId === userId) {
            return row;
        }
        if (this.personal(row)) {
            return undefined;
        }
        return row.threadId && (await this.options.workspace.readableThread(userId, row.threadId)) ? row : undefined;
    }
    /** The attachment's bytes, read for its owner. */
    async content(row: AttachmentRow) {
        return this.options.data.getFileById({ kind: 'user', userId: row.ownerUserId }, row.fileId);
    }

    // ---- uploads ------------------------------------------------------------
    private limitRate(userId: string) {
        const now = this.now();
        const recent = (this.rate.get(userId) ?? []).filter((at) => at > now - 60_000);
        if (recent.length >= MEDIA_LIMITS.uploadsPerMinute) {
            this.rate.set(userId, recent);
            throw new MediaError(
                `Too many uploads: at most ${MEDIA_LIMITS.uploadsPerMinute} a minute. Wait a moment and try again.`,
                429,
            );
        }
        recent.push(now);
        this.rate.set(userId, recent);
    }
    /**
     * Stores an upload in the user's data space: an attachment under
     * `attachments/<day>/` (pending, or in `threadId`, which must be theirs),
     * or a plain file in `folder`. The original name is kept for display; the
     * path gets a safe, free one.
     */
    async upload(
        userId: string,
        input: {
            name: string;
            declaredType?: string;
            bytes: Uint8Array;
            purpose: 'attachment' | 'file';
            threadId?: string;
            folder?: string;
        },
    ): Promise<UploadResult> {
        this.limitRate(userId);
        if (input.purpose === 'attachment' && input.threadId) {
            // The person's own chat, or a room they may send in (CB-208).
            const thread = this.options.workspace.thread(input.threadId);
            if (
                !thread ||
                (thread.kind === 'room'
                    ? !this.options.workspace.allows?.(userId, thread.id, 'send')
                    : thread.ownerId !== userId)
            ) {
                throw new MediaError('Conversation not found.', 404);
            }
        }
        const stored = await this.store(userId, input, 'web');
        return {
            item: await this.item(userId, stored.file),
            ...(stored.row ? { attachment: this.ref(stored.row) } : {}),
        };
    }
    private async store(
        userId: string,
        input: {
            name: string;
            declaredType?: string;
            bytes: Uint8Array;
            purpose: 'attachment' | 'file';
            threadId?: string;
            folder?: string;
            /**
             * Telegram: bound at once to its thread, Dot and message; a tool's
             * image (CB-157) to its thread and socio, with no message.
             */
            bound?: { dotId: string; messageId?: string };
        },
        source: AttachmentSource,
    ) {
        const { data } = this.options;
        if (!input.bytes.length) {
            throw new MediaError('The file is empty.');
        }
        if (input.bytes.length > data.limits.fileMaxBytes) {
            throw new MediaError(`Files can be at most ${Math.round(data.limits.fileMaxBytes / MB)} MB.`, 413);
        }
        const name = cleanName(input.name, 'file');
        const { mediaType, kind } = classify(name, input.declaredType, input.bytes);
        const now = this.now();
        const folder =
            input.purpose === 'attachment' ? `attachments/${day(now)}/` : normalizePath(input.folder ?? '', true);
        const base = safeName(name);
        const candidates = [
            base,
            ...Array.from({ length: 98 }, (_, index) => suffixed(base, String(index + 2))),
            suffixed(base, randomBytes(4).toString('hex')),
        ];
        let file: MediaFile | undefined;
        for (const candidate of candidates) {
            try {
                const view = await data.putFile(
                    { kind: 'user', userId },
                    `${folder}${candidate}`,
                    input.bytes,
                    mediaType,
                    { name, create: true },
                );
                file = data.fileAt(userId, view.path)!;
                break;
            } catch (error) {
                if (error instanceof DataError && error.status === 409) {
                    continue;
                }
                throw error;
            }
        }
        if (!file) {
            throw new MediaError('Could not find a free name for this file.', 409);
        }
        if (input.purpose !== 'attachment') {
            return { file };
        }
        const row: AttachmentRow = {
            id: newId(),
            fileId: file.id,
            ownerUserId: userId,
            threadId: input.threadId ?? null,
            dotId: input.bound?.dotId ?? null,
            messageId: input.bound?.messageId ?? null,
            name,
            mediaType,
            kind,
            size: input.bytes.length,
            source,
            createdAt: now,
            boundAt: input.bound ? now : null,
        };
        await this.repos.attachments.insert(row);
        return { file, row };
    }
    /**
     * A file as the Media page shows it, with the conversations it came
     * from. `names` comes from `itemNames()`, once for a whole page of items.
     */
    async item(userId: string, file: MediaFile, dotName = this.dotNames()): Promise<MediaItem> {
        const rows = await this.repos.attachments.forFile(userId, file.id);
        const { workspace } = this.options;
        return {
            id: file.id,
            path: file.path,
            name: file.name,
            folder: folderOf(file.path),
            size: file.size,
            mediaType: file.mediaType,
            kind: fileKind(file.mediaType, rows[0]?.kind),
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
            createdByDotId: file.createdByDotId,
            dotName: dotName(file.createdByDotId),
            attachments: rows.map((row) => ({
                id: row.id,
                threadId: row.threadId,
                threadTitle: row.threadId ? (workspace.thread(row.threadId)?.title ?? null) : null,
                dotId: row.dotId,
                dotName: dotName(row.dotId),
                source: row.source,
                boundAt: row.boundAt,
            })),
        };
    }

    /** Socios' names for `item()`: each asked once per listing. */
    private dotNames() {
        const { workspace } = this.options;
        const dots = new Map<string, string | null>();
        return (id: string | null) => {
            if (!id) {
                return null;
            }
            if (!dots.has(id)) {
                dots.set(id, workspace.dot(id)?.name ?? null);
            }
            return dots.get(id)!;
        };
    }

    // ---- the Media page -----------------------------------------------------
    /** One of the user's files, or a 404. */
    private ownFile(userId: string, id: string) {
        const file = this.options.data.fileRecord(userId, id);
        if (!file) {
            throw new MediaError('File not found.', 404);
        }
        return file;
    }
    private emptyFolders(userId: string) {
        return this.repos.folders.paths(userId);
    }
    /**
     * A folder of the user's files, newest first, filtered by kind and a
     * search (which looks under the whole folder, not just in it), with its
     * subfolders and every folder for the tree.
     */
    async list(
        userId: string,
        query: {
            folder?: string;
            q?: string;
            kind?: MediaKind;
            limit?: number;
            cursor?: string;
        } = {},
    ): Promise<MediaListing> {
        const { data } = this.options;
        const folder = normalizePath(query.folder ?? '', true);
        const files = data.fileRecords(userId);
        const kinds = new Map<string, AttachmentKind>();
        for (const row of await this.repos.attachments.kinds(userId)) {
            kinds.set(row.fileId, row.kind);
        }
        const tree = new Set<string>();
        for (const path of [...files.map((file) => folderOf(file.path)), ...(await this.emptyFolders(userId))]) {
            for (const ancestor of ancestors(path)) {
                tree.add(ancestor);
            }
        }
        const needle = query.q?.trim().toLowerCase();
        const matches = files
            .filter((file) =>
                needle
                    ? file.path.startsWith(folder) &&
                      (file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle))
                    : folderOf(file.path) === folder,
            )
            .filter((file) => !query.kind || fileKind(file.mediaType, kinds.get(file.id)) === query.kind)
            .sort((a, b) => b.updatedAt - a.updatedAt || compareText(a.path, b.path));
        const folders = [...tree].sort();
        const offset = Math.max(0, Number(query.cursor) || 0);
        const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
        const page = matches.slice(offset, offset + limit);
        const dotName = this.dotNames();
        const items: MediaItem[] = [];
        for (const file of page) {
            items.push(await this.item(userId, file, dotName));
        }
        return {
            folder,
            folders: folders.filter((path) => path !== folder && folderOf(path.slice(0, -1)) === folder),
            tree: folders,
            items,
            ...(offset + limit < matches.length ? { nextCursor: String(offset + limit) } : {}),
            usage: data.usage(userId),
            limits: data.limits,
        };
    }
    getItem(userId: string, id: string) {
        return this.item(userId, this.ownFile(userId, id));
    }
    async itemContent(userId: string, id: string) {
        const file = this.ownFile(userId, id);
        const { data } = await this.options.data.getFileById({ kind: 'user', userId }, file.id);
        return { file, data };
    }
    /** Moves or renames a file; its attachments follow (they point at its id). */
    async moveItem(userId: string, id: string, path: string) {
        const file = this.ownFile(userId, id);
        await this.options.data.moveFile(userId, file.path, path);
        return this.getItem(userId, id);
    }
    /** Deletes (hides) a file; its attachments go with it (onFileDeleted). */
    async deleteItem(userId: string, id: string) {
        const file = this.ownFile(userId, id);
        await this.options.data.deleteFile(userId, file.path);
    }
    /** Whether `folder` holds anything: files, or an empty folder below it. */
    private async folderExists(userId: string, folder: string) {
        return (
            this.options.data.fileRecords(userId).some((file) => file.path.startsWith(folder)) ||
            (await this.emptyFolders(userId)).some((path) => path.startsWith(folder))
        );
    }
    private folderPath(raw: string) {
        const path = normalizePath(raw, true);
        if (!path) {
            throw new MediaError('Name the folder, e.g. reports/.');
        }
        return path;
    }
    async createFolder(userId: string, raw: string) {
        const path = this.folderPath(raw);
        if (await this.folderExists(userId, path)) {
            throw new MediaError(`There is a folder ${path} already.`, 409);
        }
        await this.repos.folders.add(userId, path, this.now());
        return { path };
    }
    /**
     * Renames or moves a folder with everything in it: each file's path is
     * rewritten (metadata only), and Dots' grants on it and its subfolders
     * follow (CB-65). Files, empty-folder markers and grants move in one
     * transaction (`DataSpace.moveFolder`, follow-up 16.3c), refused before
     * anything moves when a target is taken, so a rename never stops
     * halfway.
     */
    async moveFolder(userId: string, rawFrom: string, rawTo: string) {
        const from = this.folderPath(rawFrom);
        const to = this.folderPath(rawTo);
        if (from === to) {
            return { path: to };
        }
        // A Dot's own folder is no grant: renamed, its files would leave the Dot.
        if (from === 'dots/' || /^dots\/[^/]+\/$/.test(from)) {
            throw new MediaError('A socio’s own folder keeps its place.');
        }
        if (to.startsWith(from)) {
            throw new MediaError('A folder can’t move into itself.');
        }
        // Moved in as dots/<name>/, it would pass for a socio's folder and
        // could never move again (CB-255).
        if (to === 'dots/' || /^dots\/[^/]+\/$/.test(to)) {
            throw new MediaError('Only a socio’s own folder goes straight into Socios.');
        }
        if (!(await this.folderExists(userId, from))) {
            throw new MediaError(`No folder ${from}.`, 404);
        }
        await this.options.data.moveFolder(userId, from, to, () =>
            this.repos.folders.move(userId, from, to, this.now()),
        );
        return { path: to };
    }
    /**
     * Deletes a folder: an empty one, or with `recursive` everything in it
     * (each file deleted like one by one, stamped `deletedWith folder:<path>`
     * and kept, CB-64; a failure leaves the rest listed, and the grants).
     * Once it is gone, Dots' grants on it and its subfolders end (CB-65);
     * the empty-folder markers go, as they hold nothing.
     */
    async deleteFolder(userId: string, raw: string, recursive: boolean) {
        const path = this.folderPath(raw);
        if (!(await this.folderExists(userId, path))) {
            throw new MediaError(`No folder ${path}.`, 404);
        }
        const files = this.options.data.fileRecords(userId).filter((file) => file.path.startsWith(path));
        if (files.length && !recursive) {
            throw new MediaError(`${path} isn't empty: delete its files first, or the whole folder.`, 409);
        }
        for (const file of files) {
            await this.options.data.deleteFile(userId, file.path, {
                with: deletedWith('folder', path),
            });
        }
        await this.repos.folders.removeUnder(userId, path);
        await this.options.data.endFolderGrants(userId, path);
        return { deleted: files.length };
    }

    /**
     * Removes an attachment before it is sent, with its file (unless the user
     * moved it to keep); both are hidden and kept (CB-64). Once a message
     * carried it, it stays: its file is deleted from the data space instead.
     */
    async removePending(userId: string, id: string) {
        const row = await this.attachment(id);
        if (!row || row.ownerUserId !== userId) {
            throw new MediaError('Attachment not found.', 404);
        }
        if (row.boundAt !== null) {
            throw new MediaError('This attachment was sent; delete its file from your files instead.', 409);
        }
        await this.dropWithFile(row, userId);
    }
    /**
     * The attachment is stamped first, so it keeps its own stamp; its file
     * then goes with it (`deletedWith attachment:<id>`). A file the user
     * moved out of its attachments/ folder is one they keep: only the
     * attachment goes. A bind that won the race keeps it.
     */
    /**
     * Removes an unsent attachment and its file; `kept`, checked in the same
     * unit of work as the removal, can keep it (CB-223: queued meanwhile).
     */
    private async dropWithFile(row: AttachmentRow, by: string, kept?: () => Promise<boolean>) {
        const removed = await this.uow.run(
            async () => !(await kept?.()) && (await this.repos.attachments.removePending(row.id, by, this.now())),
            { label: 'remove pending attachment' },
        );
        if (!removed) {
            return false;
        }
        const file = this.file(row);
        if (file?.path.startsWith(`attachments/${day(row.createdAt)}/`)) {
            await this.options.data.deleteFile(row.ownerUserId, file.path, {
                by,
                with: deletedWith('attachment', row.id),
            });
        }
        return true;
    }
    /** Deletes (hides) web attachments never sent within a day (the hourly tick). */
    async collectPending(now = this.now()) {
        const rows = await this.repos.attachments.pendingBefore(now - MEDIA_LIMITS.pendingMs);
        const { held } = this.options;
        let removed = 0;
        for (const row of rows) {
            try {
                // Read with each removal, in its unit: a message queued with it
                // commits before (kept) or after (the route sees it gone).
                const kept = held && (async () => (await held()).has(row.id));
                if (await this.dropWithFile(row, SYSTEM, kept)) {
                    removed += 1;
                }
            } catch {
                // The file is left listed; it is the user's to delete.
            }
        }
        return removed;
    }

    // ---- turns --------------------------------------------------------------
    /**
     * Binds an attachment to the turn's thread when it is the user's and not
     * bound elsewhere; returns the row as it now is, or undefined when this
     * thread may not use it.
     */
    async bind(row: AttachmentRow, turn: BindTurn, messageId: string): Promise<AttachmentRow | undefined> {
        if (row.threadId === turn.threadId && row.boundAt !== null) {
            return row;
        }
        if (row.ownerUserId !== turn.userId) {
            return undefined;
        }
        if (row.threadId !== null && row.threadId !== turn.threadId) {
            return undefined;
        }
        const now = this.now();
        return this.uow.run(
            async () => {
                const changed = await this.repos.attachments.bind(
                    row.id,
                    { threadId: turn.threadId, dotId: turn.dotId, messageId },
                    now,
                );
                const current = await this.attachment(row.id);
                return changed || current?.threadId === turn.threadId ? current : undefined;
            },
            { label: 'bind attachment' },
        );
    }
    /**
     * Binds what a run's new user messages (ids not in `known`) refer to, as
     * the run is accepted: the runner stores those messages before the model
     * is called, and a turn that ends sooner must not leave their attachments
     * pending, for collectPending to delete. Resolving binds them too.
     */
    async bindNew(turn: BindTurn, messages: unknown, known: ReadonlySet<string>) {
        if (!Array.isArray(messages)) {
            return;
        }
        for (const message of messages as Array<Partial<Message>>) {
            if (message?.role !== 'user' || typeof message.id !== 'string') {
                continue;
            }
            if (known.has(message.id)) {
                continue;
            }
            for (const id of attachmentIds(message.content)) {
                const row = await this.attachment(id);
                if (row) {
                    await this.bind(row, turn, message.id);
                }
            }
        }
    }
    /** An image's bytes for the model, from the cache when it has them. */
    async imageBytes(row: AttachmentRow, file: MediaFile) {
        const key = `${row.id}:${file.updatedAt}`;
        const now = this.now();
        const cached = this.cache.get(key, now);
        if (cached) {
            return cached;
        }
        const { data } = await this.content(row);
        this.cache.set(key, data, now);
        return data;
    }
    noteShown(threadId: string, ids: Set<string>) {
        this.shownImages.set(threadId, ids);
    }
    /** Whether the last turn in the thread showed this image to the model. */
    wasShown(threadId: string, id: string) {
        return this.shownImages.get(threadId)?.has(id) ?? false;
    }
    /**
     * An image a tool returned in a turn (CB-157, a computer's screenshot):
     * stored as the acting user's attachment, bound at once to the
     * conversation and the socio, so whoever can read the chat can see it and
     * the conversation's later turns can show it to the model. What the
     * tool's result names instead of the bytes.
     */
    async saveToolImage(
        turn: BindTurn,
        image: { name: string; bytes: Uint8Array; width?: number; height?: number },
    ): Promise<ToolImage> {
        const thread = this.options.workspace.thread(turn.threadId);
        if (!thread) {
            throw new MediaError('Conversation not found.', 404);
        }
        // Checked before anything is stored, so nothing is left behind.
        const sniffed = classify(cleanName(image.name, 'image'), undefined, image.bytes);
        if (sniffed.kind !== 'image' || !MODEL_IMAGE_TYPES.has(sniffed.mediaType)) {
            throw new MediaError('That is not an image.', 415);
        }
        const { row } = await this.store(
            turn.userId,
            {
                name: image.name,
                bytes: image.bytes,
                purpose: 'attachment',
                threadId: turn.threadId,
                bound: { dotId: turn.dotId },
            },
            'tool',
        );
        return {
            id: row!.id,
            mediaType: row!.mediaType,
            size: row!.size,
            ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
        };
    }
    /**
     * A link card's image (CB-230): media `/unfurl` fetched for a card in a
     * page of `spaceId`, copied into `userId`'s Files under `folder` and
     * recorded so the card can show it. Images only (never SVG): anything
     * else is refused before it is stored. The card names the returned id.
     */
    async saveEmbedMedia(
        userId: string,
        input: {
            name: string;
            bytes: Uint8Array;
            folder: string;
            spaceId: string;
            dotId: string | null;
            sourceUrl: string;
        },
    ) {
        const sniffed = classify(cleanName(input.name, 'image'), undefined, input.bytes);
        if (sniffed.kind !== 'image' || !MODEL_IMAGE_TYPES.has(sniffed.mediaType)) {
            throw new MediaError('That is not an image.', 415);
        }
        const { file } = await this.store(
            userId,
            {
                name: input.name,
                bytes: input.bytes,
                purpose: 'file',
                folder: input.folder,
            },
            'tool',
        );
        const id = newEmbedId();
        await this.repos.embeds.insert({
            id,
            fileId: file.id,
            ownerUserId: userId,
            dotId: input.dotId,
            spaceId: input.spaceId,
            sourceUrl: input.sourceUrl,
            createdAt: this.now(),
        });
        return {
            id,
            path: file.path,
            mediaType: sniffed.mediaType,
            size: file.size,
        };
    }
    /**
     * A link card's image for `viewer`: its person's, or anyone's who may
     * read the Space of the page it was made for (CB-181), while the file is
     * still in its owner's Files; else undefined, the same as an unknown id.
     * Deleting the file takes it off the card.
     */
    async embedContent(id: string, viewer: string) {
        const row = await this.repos.embeds.byId(id);
        if (!row) {
            return undefined;
        }
        // A socio's upload (CB-524) is the Space's readers' only, its uploader
        // too: removed from the Space, they keep only their own copy in Files.
        const owner = row.ownerUserId === viewer && row.origin !== 'upload';
        if (!owner && !(this.options.workspace.readsSpace?.(viewer, row.spaceId) ?? false)) {
            return undefined;
        }
        // An image, or a PDF (CB-524).
        const file = this.assetFile(row);
        if (!file) {
            return undefined;
        }
        const { data } = await this.options.data.getFileById({ kind: 'user', userId: row.ownerUserId }, file.id);
        return { file, data };
    }
    // ---- page covers (CB-308) ----------------------------------------------
    /**
     * One of `userId`'s own image files as a page cover in `spaceId`: it is
     * recorded as a media embed, so whoever may read the Space sees it while
     * the file stays in its owner's Files. Resolves the embed's id.
     */
    async coverFromFile(userId: string, { fileId, spaceId }: { fileId: string; spaceId: string }) {
        const file = this.ownFile(userId, fileId);
        // The type was sniffed when the file was stored; never SVG.
        if (!MODEL_IMAGE_TYPES.has(file.mediaType)) {
            throw new MediaError('That is not an image.', 415);
        }
        if (file.size > COVER_MAX_BYTES) {
            throw new MediaError(`Covers can be at most ${COVER_MAX_BYTES / MB} MB.`, 413);
        }
        const id = newEmbedId();
        const made = await this.namingFile(userId, file.id, async () => {
            await this.repos.embeds.insert({
                id,
                fileId: file.id,
                ownerUserId: userId,
                dotId: null,
                spaceId,
                sourceUrl: '',
                createdAt: this.now(),
            });
            return true;
        });
        // Its file is being cleaned up (CB-524): as good as gone.
        if (!made) {
            throw new MediaError('File not found.', 404);
        }
        return id;
    }
    /**
     * An image already in `spaceId` (a link card's or another page's cover)
     * as a cover there: the same embed, so nothing is copied. One from
     * another Space, one `viewer` can't see, or one whose file is gone is
     * missing, never refused, so ids can't be probed.
     */
    async coverFromEmbed(viewer: string, embedId: string, spaceId: string, options: { files?: boolean } = {}) {
        const row = await this.repos.embeds.byId(embedId);
        if (
            !row ||
            row.spaceId !== spaceId ||
            !this.seesEmbed(viewer, row) ||
            !(options.files ? this.assetFile(row) : this.embedFile(row))
        ) {
            throw new MediaError('Image not found.', 404);
        }
        return row.id;
    }
    /**
     * A moved page's cover in its new Space (CB-308): a copy of the embed
     * there, on the same file. The original stays, as other pages of the old
     * Space may show it. Undefined when the embed or its file is gone.
     */
    async copyEmbedToSpace(embedId: string, spaceId: string) {
        const row = await this.repos.embeds.byId(embedId);
        if (!row || !this.assetFile(row)) {
            return undefined;
        }
        if (row.spaceId === spaceId) {
            return row.id;
        }
        const id = `cbemb_${randomBytes(16).toString('base64url')}`;
        const now = this.now();
        return this.namingFile(row.ownerUserId, row.fileId, async () => {
            await this.repos.embeds.insert({
                ...row,
                id,
                spaceId,
                createdAt: now,
                // A moved upload's copy gets its own grace (CB-524).
                ...(row.origin === 'upload' ? { uploadedAt: now, checkedAt: null } : {}),
            });
            return id;
        });
    }
    /**
     * The images of a Space `viewer` may see, newest first: the cover
     * picker's "From this Space". Each file once, and only while it is
     * still an image in its owner's Files.
     */
    async spaceImages(viewer: string, spaceId: string, limit = 24): Promise<CoverImage[]> {
        const rows = await this.repos.embeds.forSpace(spaceId, SPACE_IMAGES_SCAN);
        const seen = new Set<string>();
        const out: CoverImage[] = [];
        for (const row of rows) {
            if (out.length >= limit) {
                break;
            }
            if (!this.seesEmbed(viewer, row)) {
                continue;
            }
            const file = this.embedFile(row);
            if (!file || seen.has(file.id)) {
                continue;
            }
            seen.add(file.id);
            out.push({
                id: row.id,
                url: coverUrl(row.id),
                name: file.name,
                mediaType: file.mediaType,
                createdAt: row.createdAt,
            });
        }
        return out;
    }
    /**
     * `Pages.useCovers`: a cover as pages show it, or null once its image
     * file was deleted (the page then shows none).
     */
    coverView(id: string): PageCover | null {
        const row = this.repos.embeds.byIdNow(id);
        return row && this.embedFile(row) ? { id, url: coverUrl(id) } : null;
    }
    /** An embed's person, or anyone who may read its Space (CB-181). */
    private seesEmbed(viewer: string, row: { ownerUserId: string; spaceId: string }) {
        return row.ownerUserId === viewer || (this.options.workspace.readsSpace?.(viewer, row.spaceId) ?? false);
    }
    /** An embed's file while it is still an image in its owner's Files. */
    private embedFile(row: { ownerUserId: string; fileId: string }) {
        const file = this.options.data.fileRecord(row.ownerUserId, row.fileId);
        return file && MODEL_IMAGE_TYPES.has(file.mediaType) ? file : undefined;
    }
    /**
     * An embed's file as the Space serves it: an image or a PDF (CB-524; a
     * socio's upload, or one a bundle import copied), while it is still in
     * its owner's Files. Its type is the one sniffed when it was stored, and
     * serving sniffs the bytes again (`servedAs`): a PDF is only ever a
     * download.
     */
    private assetFile(row: Pick<EmbedMedia, 'ownerUserId' | 'fileId'>) {
        const file = this.options.data.fileRecord(row.ownerUserId, row.fileId);
        return file && SPACE_UPLOAD_TYPES.has(file.mediaType) ? file : undefined;
    }

    // ---- Space uploads (CB-524) ----------------------------------------------
    /** Files the clean-up is deleting, by `<owner>\0<file>`: no new embed may name one. */
    private deletingFiles = new Set<string>();
    /** New embeds being written, by the file they name. */
    private namingFiles = new Map<string, number>();
    /**
     * Writes a new embed naming a file (a cover, a moved page's copy) unless
     * the clean-up is deleting that file; undefined then. The clean-up waits
     * for the ones under way before it counts the file's embeds, so it never
     * deletes a file a new embed names. No lock is held across an await of
     * the caller's unit of work (a page move writes its copies inside one).
     */
    private async namingFile<T>(owner: string, fileId: string, work: () => Promise<T>): Promise<T | undefined> {
        const key = `${owner}\0${fileId}`;
        if (this.deletingFiles.has(key)) {
            return undefined;
        }
        this.namingFiles.set(key, (this.namingFiles.get(key) ?? 0) + 1);
        try {
            return await work();
        } finally {
            const left = this.namingFiles.get(key)! - 1;
            if (left) {
                this.namingFiles.set(key, left);
            } else {
                this.namingFiles.delete(key);
            }
        }
    }
    /** Deletes a file's copy once no embed names it, shut against new ones meanwhile. */
    private async deleteUnnamedFile(owner: string, fileId: string, uploadId: string) {
        const key = `${owner}\0${fileId}`;
        if (this.deletingFiles.has(key)) {
            return;
        }
        this.deletingFiles.add(key);
        try {
            while (this.namingFiles.has(key)) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if ((await this.repos.embeds.countForFile(owner, fileId)) > 0) {
                return;
            }
            const file = this.options.data.fileRecord(owner, fileId);
            if (file) {
                await this.options.data.deleteFile(owner, file.path, {
                    by: SYSTEM,
                    with: deletedWith('embed', uploadId),
                });
            }
        } finally {
            this.deletingFiles.delete(key);
        }
    }
    /** One upload at a time per Space, page and content, so a retry can't race it. */
    private uploadLocks = new Map<string, Promise<unknown>>();
    private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
        const before = this.uploadLocks.get(key) ?? Promise.resolve();
        const run = before.then(work, work);
        const settled = run.catch(() => undefined);
        this.uploadLocks.set(key, settled);
        try {
            return await run;
        } finally {
            if (this.uploadLocks.get(key) === settled) {
                this.uploadLocks.delete(key);
            }
        }
    }
    /**
     * What bytes a socio would upload into a Space are, by the bytes alone
     * (never a name or a declared type): an image a page can show or a PDF,
     * within `SPACE_UPLOAD_LIMITS` and the data space's per-file limit, with
     * their sha256. Anything else is refused with a `MediaError` (413, 415).
     */
    checkSpaceUpload(bytes: Uint8Array) {
        if (!bytes.length) {
            throw new MediaError('The file is empty.');
        }
        const sniffed = classify('file', undefined, bytes).mediaType;
        if (!SPACE_UPLOAD_TYPES.has(sniffed)) {
            throw new MediaError('Only PNG, JPEG, GIF and WebP images and PDFs can be uploaded to a Space.', 415);
        }
        const pdf = sniffed === 'application/pdf';
        const max = Math.min(
            pdf ? SPACE_UPLOAD_LIMITS.pdfMaxBytes : SPACE_UPLOAD_LIMITS.imageMaxBytes,
            this.options.data.limits.fileMaxBytes,
        );
        if (bytes.length > max) {
            throw new MediaError(`${pdf ? 'PDFs' : 'Images'} can be at most ${Math.floor(max / MB)} MB.`, 413);
        }
        return {
            mediaType: sniffed,
            kind: pdf ? ('pdf' as const) : ('image' as const),
            contentHash: createHash('sha256').update(bytes).digest('hex'),
        };
    }
    /** The live upload of these bytes for this Space and page, if there is one. */
    async spaceUpload(spaceId: string, pageId: string | null, contentHash: string) {
        for (const row of await this.repos.embeds.uploads(spaceId, pageId, contentHash)) {
            const file = this.assetFile(row);
            if (!file) {
                continue;
            }
            // Its copy may have been replaced since (a file keeps its id when
            // its path is written again): reused only while it holds these bytes.
            const { data } = await this.options.data
                .getFileById({ kind: 'user', userId: row.ownerUserId }, file.id)
                .catch((error: unknown) => {
                    if (error instanceof DataError) {
                        return { data: undefined };
                    }
                    throw error;
                });
            if (data && createHash('sha256').update(data).digest('hex') === contentHash) {
                return { row, file };
            }
        }
        return undefined;
    }
    /**
     * Stores bytes a socio uploads into a Space's media (CB-524), as a page
     * cover is: a copy in `userId`'s Files (`space-media/<Space>/`), recorded
     * as an embed of the Space, so whoever may read the Space, and nobody
     * else, opens it at its URL. The same bytes for the same Space and page
     * are stored once: a retry gets the same asset (`reused`). The caller
     * checks who may upload there.
     */
    async saveSpaceUpload(
        userId: string,
        input: { spaceId: string; pageId: string | null; name: string; bytes: Uint8Array; dotId: string | null },
    ): Promise<SpaceUploadView>;
    /** `reuseOnly`: the existing asset, or undefined; never a new copy (one the person didn't approve). */
    async saveSpaceUpload(
        userId: string,
        input: { spaceId: string; pageId: string | null; name: string; bytes: Uint8Array; dotId: string | null },
        options: { reuseOnly: true },
    ): Promise<SpaceUploadView | undefined>;
    async saveSpaceUpload(
        userId: string,
        input: { spaceId: string; pageId: string | null; name: string; bytes: Uint8Array; dotId: string | null },
        options: { reuseOnly?: boolean } = {},
    ): Promise<SpaceUploadView | undefined> {
        const { mediaType, kind, contentHash } = this.checkSpaceUpload(input.bytes);
        return this.locked(`${input.spaceId}\0${input.pageId ?? ''}\0${contentHash}`, async () => {
            const now = this.now();
            const found = await this.spaceUpload(input.spaceId, input.pageId, contentHash);
            if (found) {
                await this.repos.embeds.touch(found.row.id, now);
                return this.uploadView(found.row.id, found.file, kind, true);
            }
            if (options.reuseOnly) {
                return undefined;
            }
            const { file } = await this.store(
                userId,
                {
                    name: input.name,
                    bytes: input.bytes,
                    purpose: 'file',
                    folder: `space-media/${safeName(input.spaceId)}/`,
                },
                'tool',
            );
            const id = newEmbedId();
            await this.repos.embeds.insert({
                id,
                fileId: file.id,
                ownerUserId: userId,
                dotId: input.dotId,
                spaceId: input.spaceId,
                sourceUrl: '',
                createdAt: now,
                origin: 'upload',
                pageId: input.pageId,
                contentHash,
                uploadedAt: now,
                checkedAt: null,
            });
            return this.uploadView(id, { ...file, mediaType }, kind, false);
        });
    }
    private uploadView(id: string, file: MediaFile, kind: 'image' | 'pdf', reused: boolean): SpaceUploadView {
        return {
            id,
            url: coverUrl(id),
            name: file.name,
            mediaType: file.mediaType,
            kind,
            size: file.size,
            reused,
        };
    }
    /**
     * The scheduled clean-up of Space uploads (CB-524): an upload no page
     * names (live or deleted, in its text, a kept revision or as its cover)
     * once it has gone `graceMs` without being uploaded again, such as a
     * failed import's leftovers, is removed, and its copy in its person's
     * Files is deleted (kept restorable, CB-64) when no other embed, in
     * any Space, names that file. One a page names is looked at again
     * after `recheckMs`. Nothing is removed without the pages' answer.
     */
    async collectSpaceUploads(now = this.now()) {
        const named = this.options.workspace.embedsNamed;
        if (!named) {
            return 0;
        }
        const rows = await this.repos.embeds.staleUploads(
            now - SPACE_UPLOAD_LIMITS.graceMs,
            now - SPACE_UPLOAD_LIMITS.recheckMs,
            SPACE_UPLOAD_LIMITS.sweepBatch,
        );
        if (!rows.length) {
            return 0;
        }
        const keep = named(rows.map((row) => row.id));
        await this.repos.embeds.checked(
            rows.filter((row) => keep.has(row.id)).map((row) => row.id),
            now,
        );
        let removed = 0;
        for (const row of rows) {
            if (keep.has(row.id)) {
                continue;
            }
            const key = `${row.spaceId}\0${row.pageId ?? ''}\0${row.contentHash ?? ''}`;
            const gone = await this.locked(key, async () => {
                // Uploaded again, or named, since it was read: kept.
                const fresh = await this.repos.embeds.byId(row.id);
                if (!fresh || (fresh.uploadedAt ?? 0) >= now - SPACE_UPLOAD_LIMITS.graceMs) {
                    return false;
                }
                // Named meanwhile (a page saved since the scan): kept. Read again
                // inside the unit that removes it, so a page save queued behind
                // it commits before (kept) or after (it names a removed id).
                // Revisions only come from pages' text, read here again.
                const removed = await this.uow.run(
                    async () =>
                        !named([row.id], { revisions: false }).has(row.id) && (await this.repos.embeds.remove(row.id)),
                    { label: 'remove unnamed space upload' },
                );
                if (!removed) {
                    return false;
                }
                await this.deleteUnnamedFile(row.ownerUserId, row.fileId, row.id);
                return true;
            });
            if (gone) {
                removed += 1;
            }
        }
        return removed;
    }
    /**
     * The images of one conversation (CB-157), for the model: an image
     * attachment bound to `threadId` and not deleted, else undefined, so a
     * result can't name another conversation's image.
     */
    async threadImage(threadId: string, id: string, userId?: string) {
        const row = await this.attachment(id);
        if (
            !row ||
            row.threadId !== threadId ||
            // A tool's image in a room is the person's whose turn made it.
            (userId !== undefined && row.ownerUserId !== userId && this.personal(row)) ||
            row.boundAt === null ||
            row.kind !== 'image' ||
            !MODEL_IMAGE_TYPES.has(row.mediaType)
        ) {
            return undefined;
        }
        const file = this.file(row);
        return file ? { row, file } : undefined;
    }
    /**
     * `DotExtensions.toolImages`: a conversation's images for the model
     * (CB-157), for a turn acting for `userId`: never an image a tool made
     * in someone else's turn (CB-209).
     */
    toolImageSource(threadId: string, userId?: string): ToolImageSource {
        return {
            maxBytes: this.imageModelMaxBytes,
            // The file's size as stored now: it can be replaced under its id.
            size: async (id) => (await this.threadImage(threadId, id, userId))?.file.size,
            load: async (id) => {
                const found = await this.threadImage(threadId, id, userId);
                if (!found) {
                    return undefined;
                }
                return {
                    data: await this.imageBytes(found.row, found.file),
                    mediaType: found.row.mediaType,
                };
            },
        };
    }
    /** `DotExtensions.messages`: references become what the model can take. */
    resolveForModel(turn: ResolveTurn, messages: Message[]) {
        return resolveMessages(this, turn, messages);
    }
    /**
     * Telegram (CB-54): stores the inline files of new messages as
     * attachments, bound to the thread, so run history keeps references
     * only. A file that can't be stored becomes a note.
     */
    async ingest(turn: { userId: string; threadId: string; dotId: string }, messages: Message[]): Promise<Message[]> {
        const out: Message[] = [];
        for (const message of messages) {
            if (message.role !== 'user' || !Array.isArray(message.content)) {
                out.push(message);
                continue;
            }
            const parts = message.content as unknown as Array<Record<string, unknown>>;
            if (!parts.some(inlineFile)) {
                out.push(message);
                continue;
            }
            const content: Array<Record<string, unknown>> = [];
            for (const part of parts) {
                const inline = inlineFile(part);
                if (!inline) {
                    content.push(part);
                    continue;
                }
                const name = telegramName(inline.mimeType, inline.filename);
                try {
                    const { row } = await this.store(
                        turn.userId,
                        {
                            name,
                            declaredType: inline.mimeType,
                            bytes: Buffer.from(inline.data, 'base64'),
                            purpose: 'attachment',
                            threadId: turn.threadId,
                            bound: { dotId: turn.dotId, messageId: message.id },
                        },
                        'telegram',
                    );
                    content.push({
                        ...attachmentPart({ id: row!.id, mimeType: row!.mediaType, filename: row!.name }),
                    });
                } catch (error) {
                    content.push({
                        type: 'text',
                        text: `[The user sent a file (${inline.mimeType}) that could not be saved: ${error instanceof MediaError || error instanceof DataError ? error.message : 'storage failed'}]`,
                    });
                }
            }
            out.push({ ...message, content } as Message);
        }
        return out;
    }
}

/** `reports/q3/` for `reports/q3/summary.md`; '' at the root. */
function folderOf(path: string) {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash + 1);
}
/** `a/`, `a/b/` for `a/b/`. */
function ancestors(folder: string) {
    const segments = folder.split('/').filter(Boolean);
    return segments.map((_, index) => `${segments.slice(0, index + 1).join('/')}/`);
}
/** A file's kind on the Media page: the attachment's, else by its type. */
function fileKind(mediaType: string, attached?: AttachmentKind): MediaKind {
    const kind: AttachmentKind =
        attached ??
        (MODEL_IMAGE_TYPES.has(mediaType) ? 'image' : /^text\/|json|yaml/.test(mediaType) ? 'text' : 'file');
    return itemKind(kind, mediaType);
}

/** An inline file part from the Telegram adapter (or an older client). */
function inlineFile(part: Record<string, unknown>) {
    if (part.type === 'binary' && typeof part.data === 'string') {
        return {
            data: part.data,
            mimeType: String(part.mimeType ?? 'application/octet-stream'),
            filename: typeof part.filename === 'string' ? part.filename : undefined,
        };
    }
    const source = part.source as { type?: unknown; value?: unknown; mimeType?: unknown } | undefined;
    if (
        ['image', 'audio', 'video', 'document'].includes(String(part.type)) &&
        source?.type === 'data' &&
        typeof source.value === 'string'
    ) {
        return {
            data: source.value,
            mimeType: String(source.mimeType ?? 'application/octet-stream'),
            filename: undefined,
        };
    }
    return undefined;
}

const EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
};
/** The adapter drops file names: a photo is `telegram-photo.jpg`. */
function telegramName(mimeType: string, filename?: string) {
    if (filename) {
        return filename;
    }
    const extension = EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()];
    const kind = mimeType.startsWith('image/') ? 'photo' : 'file';
    return `telegram-${kind}${extension ? `.${extension}` : ''}`;
}
