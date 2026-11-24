import type { AttachmentKind } from '@socio/shared/media-types';

import type { Attachment } from '../contract.js';

/**
 * Media's repositories (CB-110): one per aggregate, async,
 * taking and returning plain domain types. Only `media/infra` implements
 * them; nothing else touches the media tables. Every write works inside or
 * outside a unit of work: outside one it opens its own.
 */

/** The turn an attachment is bound to, by the message that carried it. */
export interface AttachmentBinding {
    threadId: string;
    dotId: string;
    messageId: string;
}

/** Attachment. Reads leave deleted ones out unless named `withDeleted`. */
export interface AttachmentRepository {
    byId(id: string): Promise<Attachment | undefined>;
    /** Deleted or not, with its stamp (admin, tests). */
    withDeleted(id: string): Promise<Attachment | undefined>;
    /** The ones a thread's messages have carried, oldest bound first. */
    forThread(threadId: string): Promise<Attachment[]>;
    /** The ones linking a user's file to conversations, oldest first. */
    forFile(ownerUserId: string, fileId: string): Promise<Attachment[]>;
    /** Each of a user's files' attachment kinds, newest attachment first. */
    kinds(ownerUserId: string): Promise<Array<{ fileId: string; kind: AttachmentKind }>>;
    /** Whether a message in `threadId` carried this file of the user's. */
    carried(ownerUserId: string, threadId: string, fileId: string): Promise<boolean>;
    /** Web uploads never sent, made before `before`. */
    pendingBefore(before: number): Promise<Attachment[]>;
    insert(attachment: Attachment): Promise<void>;
    /**
     * Binds a pending one (in no thread, or already in this one) to the
     * turn; false when it was bound or deleted meanwhile.
     */
    bind(id: string, binding: AttachmentBinding, now: number): Promise<boolean>;
    /** Deletes (hides) one never sent; false when it was bound or deleted meanwhile. */
    removePending(id: string, by: string, now: number): Promise<boolean>;
    /** A file was deleted: its live attachments go with it. */
    removeWithFile(ownerUserId: string, fileId: string, stamp: { at: number; by: string; with: string }): Promise<void>;
}

/** The Media page's empty folders; other folders are implied by files' paths. */
export interface MediaFolderRepository {
    /** A user's, by path. */
    paths(ownerUserId: string): Promise<string[]>;
    add(ownerUserId: string, path: string, now: number): Promise<void>;
    /** Those under `from` move under `to`; one already there stays. */
    move(ownerUserId: string, from: string, to: string, now: number): Promise<void>;
    /** Removes `folder` and those under it. */
    removeUnder(ownerUserId: string, folder: string): Promise<void>;
}

/**
 * A link card's media (CB-230): a file `/unfurl` copied into the Files of
 * the person it acted for, for a card in a page of `spaceId`. Cards name
 * the row's id, never the file's.
 */
export interface EmbedMedia {
    id: string;
    fileId: string;
    ownerUserId: string;
    dotId: string | null;
    spaceId: string;
    /** The remote media it was copied from. */
    sourceUrl: string;
    createdAt: number;
    /** CB-524: 'upload' for a file a socio uploaded into the Space; else null. */
    origin?: 'upload' | null;
    /** CB-524: the page an upload is for; null for the Space. */
    pageId?: string | null;
    /** CB-524: an upload's sha256, hex, for reusing it on a retry. */
    contentHash?: string | null;
    /** CB-524: the last time the upload tool returned it. */
    uploadedAt?: number | null;
    /** CB-524: the last time the clean-up looked for pages naming it. */
    checkedAt?: number | null;
}

export interface EmbedMediaRepository {
    byId(id: string): Promise<EmbedMedia | undefined>;
    /**
     * `byId` at once, for a caller that can't wait: a page's cover is shown
     * as its row is read (CB-308).
     */
    byIdNow(id: string): EmbedMedia | undefined;
    /** A Space's media, newest first, at most `limit` (CB-308's picker). */
    forSpace(spaceId: string, limit: number): Promise<EmbedMedia[]>;
    insert(row: EmbedMedia): Promise<void>;
    /** CB-524: the uploads of the same bytes for the same Space and page (null: the Space), oldest first. */
    uploads(spaceId: string, pageId: string | null, contentHash: string): Promise<EmbedMedia[]>;
    /** CB-524: an upload was returned again: its clean-up clock starts over. */
    touch(id: string, now: number): Promise<void>;
    /**
     * CB-524: uploads last returned before `before` and not looked at since
     * `checkedBefore`, oldest first, at most `limit`.
     */
    staleUploads(before: number, checkedBefore: number, limit: number): Promise<EmbedMedia[]>;
    /** CB-524: the clean-up looked at these uploads at `now`. */
    checked(ids: readonly string[], now: number): Promise<void>;
    /** How many embeds name this file of the person's, in any Space. */
    countForFile(ownerUserId: string, fileId: string): Promise<number>;
    /** Removes one embed row; false when it was gone. */
    remove(id: string): Promise<boolean>;
}

export interface MediaRepositories {
    attachments: AttachmentRepository;
    folders: MediaFolderRepository;
    embeds: EmbedMediaRepository;
}
