/**
 * What other features may know of media (chat attachments, the Media page's
 * files, link card images and page covers): its tags, the slice of
 * `MediaService` they call, its errors, and plain types and constants. It
 * imports only `effect`, `@socio/*` and, with `import type`, the
 * allowlisted modules, and holds no logic.
 *
 * The types, errors and constants here moved from the files that defined
 * them, whose re-exports were later dropped.
 *
 * Moved into packages: `sniffType`, `detectType`, `textOf`, `hasMarkup`,
 * `cleanName` and `SniffedType` to `@socio/shared/media/file-types`;
 * `isAttachmentPart`, `attachmentIds`, `displayContent`,
 * `checkNewUserContent`, `ContentError` and `AttachmentPart` to
 * `@socio/shared/media/refs` (`ContentError` and `AttachmentPart` are
 * re-exported here, as media's error and part type). `formatSize` and
 * `TURN_IMAGE_BYTES` were already in `@socio/shared`.
 *
 * What media reads of the folders above it (the data space, the
 * workspace) it declares here as its own ports, `MediaData` and
 * `MediaWorkspace`; the composition root provides them.
 *
 * Not here, on purpose:
 * - `MediaService` itself and `mediaSettingsFromEnv`: the media layer
 *   (`layer.ts`) builds the service, and the composition (`composition/
 *   media.ts`) `MediaConfig` from the startup configuration. Other folders get the
 *   `Media` and `MediaViews` tags below.
 * - `mediaRoutes`, `attachmentTools`, `mediaSchema` and `mediaModule`: the
 *   module registry mounts and registers them.
 * - What only `media/` calls on the service (uploads, the Media page's
 *   moves and folders, binding one attachment, the hourly clean-up, the
 *   attachment tools' reads).
 */
import type { Message } from '@ag-ui/client';
import { Context } from 'effect';

import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import type { MessageTurn } from '@socio/foundation/turns/turn';
import type { TransferParties, TransferTally } from '@socio/shared/auth';
import type { DataFileView, DataLimitsView, DataUsageView } from '@socio/shared/data-types';
import type {
    AttachmentKind,
    AttachmentRef,
    AttachmentSource,
    MediaKind,
    MediaListing,
} from '@socio/shared/media-types';
import { ContentError, type AttachmentPart } from '@socio/shared/media/refs';
import type { CoverImage, PageCover } from '@socio/shared/pages/page-library';
import type { ToolImage } from '@socio/shared/tool-images';
import type { Conversation, Dot } from '@socio/shared/types';

export { ContentError, type AttachmentPart };

// ── Settings and constants ───────────────────────────────────────────────

/** `MEDIA_IMAGE_MODEL_MAX_MB` (10): larger images are kept but not sent to the model. */
export interface MediaSettings {
    imageModelMaxBytes?: number;
}

/** The raster formats both inference paths send to a model. */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Raw uploads (the file's bytes, not base64 JSON) come only here: app.ts
 * lets this one path past the 1 MB limit and the JSON-only rule, when the
 * request carries `X-CB-Upload: 1`.
 */
export const MEDIA_UPLOAD_PATH = /^\/api\/media\/uploads$/;

/**
 * Space uploads (CB-524): what `space_media_upload` takes. Images (PNG,
 * JPEG, GIF, WebP) up to the size of a page picture, PDFs up to 25 MB (and
 * never past the data space's own per-file limit), recognized by their
 * bytes only. An upload no page names is cleaned up once it has gone
 * `graceMs` without being uploaded again; the clean-up looks again at one
 * that is named at most every `recheckMs`.
 */
export const SPACE_UPLOAD_LIMITS = {
    imageMaxBytes: 5 * 1048576,
    pdfMaxBytes: 25 * 1048576,
    filesPerCall: 20,
    graceMs: 7 * 24 * 60 * 60_000,
    recheckMs: 24 * 60 * 60_000,
    sweepBatch: 200,
} as const;

/** The types a Space upload may be: the model images and PDFs, by their bytes. */
export const SPACE_UPLOAD_TYPES: ReadonlySet<string> = new Set([...MODEL_IMAGE_TYPES, 'application/pdf']);

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A refusal with the status the route answers. A plain `Error`: five
 * folders test it with `instanceof` and show its message, and the service
 * that throws it is promise code. It stays plain for now, as a tagged
 * error would change its `name` and how it prints; it becomes tagged when
 * the service's methods return Effects.
 */
export class MediaError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409 | 413 | 415 | 429 | 503 = 400,
    ) {
        super(message);
    }
}

// ── Rows ─────────────────────────────────────────────────────────────────

/**
 * A chat attachment (CB-54): a data space file linked to the conversation
 * it was attached in. `threadId` is null while it waits in the new-chat
 * composer; `boundAt` is set when a message first carries it to the model.
 */
export interface Attachment {
    id: string;
    fileId: string;
    ownerUserId: string;
    threadId: string | null;
    dotId: string | null;
    messageId: string | null;
    name: string;
    mediaType: string;
    kind: AttachmentKind;
    size: number;
    source: AttachmentSource;
    createdAt: number;
    boundAt: number | null;
    /** CB-64: set once deleted; the row is kept. */
    deletedAt?: number | null;
    deletedBy?: string | null;
    deletedWith?: string | null;
}

/** A chat attachment, as the service names it. */
export type AttachmentRow = Attachment;

/**
 * A file in a person's data space with its id and display name: the data
 * space's `DataFileRecord`, spelled out here until dataspace has a
 * contract.
 */
export type MediaFile = DataFileView & { id: string; name: string };

/** The turn a resolution is for (`DotExtensions.messages`); tests may omit the signal. */
export type ResolveTurn = Omit<MessageTurn, 'signal'> & {
    signal?: AbortSignal;
};

/** The thread, Dot and user an attachment is bound for. */
export type BindTurn = Pick<ResolveTurn, 'userId' | 'dotId' | 'threadId'>;

// ── The service ──────────────────────────────────────────────────────────

/** Attachments as other features read them: a turn's files, the steering queue, notifications. */
export interface MediaAttachmentsShape {
    /** A live attachment; a deleted one is missing (CB-64). */
    attachment(id: string): Promise<Attachment | undefined>;
    /** An attachment, deleted or not, with its stamp. */
    withDeletedAttachment(id: string): Promise<Attachment | undefined>;
    /** An attachment `userId` may see; anything else is missing, never refused. */
    readable(userId: string, id: string): Promise<Attachment | undefined>;
    /** The attachment's file, or undefined once it was deleted. */
    file(row: Attachment): MediaFile | undefined;
    /** The attachment's bytes, read for its owner. */
    content(row: Attachment): Promise<{ file: DataFileView; data: Buffer }>;
    ref(row: Attachment): AttachmentRef;
    /** Binds the attachments new user messages carry to the turn (the run endpoint, steering). */
    bindNew(turn: BindTurn, messages: unknown, known: ReadonlySet<string>): Promise<void>;
}

/** What a Dot turn reads and writes through media. */
export interface MediaTurnsShape {
    /** `DotExtensions.messages`: references become what the model can take. */
    resolveForModel(turn: ResolveTurn, messages: Message[]): Promise<Message[]>;
    /** The images a tool may show the model in a thread. */
    toolImageSource(threadId: string, userId?: string): ToolImageSource;
    /** Telegram (CB-54): inline files of new messages become attachment references. */
    ingest(turn: { userId: string; threadId: string; dotId: string }, messages: Message[]): Promise<Message[]>;
    /** An image a tool returned in a turn (CB-157), stored as the acting user's attachment. */
    saveToolImage(
        turn: BindTurn,
        image: { name: string; bytes: Uint8Array; width?: number; height?: number },
    ): Promise<ToolImage>;
}

/** The Media page's files, as the live views and notifications read them. */
export interface MediaLibraryShape {
    list(userId: string, query?: MediaViewQuery): Promise<MediaListing>;
    /** One of `userId`'s own files with its bytes. */
    itemContent(userId: string, id: string): Promise<{ file: MediaFile; data: Buffer }>;
}

/** Link card images (CB-230) and page covers (CB-308). */
export interface MediaEmbedsShape {
    /** A link card's image, copied into `userId`'s Files; the card names the returned id. */
    saveEmbedMedia(
        userId: string,
        input: {
            name: string;
            bytes: Uint8Array;
            folder: string;
            spaceId: string;
            dotId: string | null;
            sourceUrl: string;
        },
    ): Promise<{ id: string; path: string; mediaType: string; size: number }>;
    /** One of `userId`'s own image files as a page cover in `spaceId`; the embed's id. */
    coverFromFile(userId: string, cover: { fileId: string; spaceId: string }): Promise<string>;
    /**
     * An image already in `spaceId` as a cover there; the embed's id. With
     * `files` (a page move, CB-524), a PDF uploaded into the Space too.
     */
    coverFromEmbed(viewer: string, embedId: string, spaceId: string, options?: { files?: boolean }): Promise<string>;
    /** A moved page's cover in its new Space; undefined when the embed or its file is gone. */
    copyEmbedToSpace(embedId: string, spaceId: string): Promise<string | undefined>;
    /** The images of a Space `viewer` may see, newest first (the cover picker). */
    spaceImages(viewer: string, spaceId: string, limit?: number): Promise<CoverImage[]>;
    /** `Pages.useCovers`: a cover as pages show it, or null once its image file was deleted. */
    coverView(id: string): PageCover | null;
}

/** What other features and the composition call on `MediaService`, which implements it. */
export interface MediaShape extends MediaAttachmentsShape, MediaTurnsShape, MediaLibraryShape, MediaEmbedsShape {}

export class Media extends Context.Service<Media, MediaShape>()('socio/media/Media') {}

/**
 * A person's media rows (attachments, library folders, embeds in Spaces),
 * which name files in their data space: they move with it, in the same
 * transaction (CB-360's transfer). `infra/sqlite/ownership.ts` implements it.
 */
export interface MediaOwnershipShape {
    /** How many rows of each the person has. */
    counts(userId: string): Record<string, number>;
    transfer(parties: TransferParties): TransferTally;
}

// ── Views ────────────────────────────────────────────────────────────────

/** What `GET /api/media` takes: a folder, a search, a kind, a page. */
export interface MediaViewQuery {
    folder?: string;
    q?: string;
    kind?: MediaKind;
    limit?: number;
    cursor?: string;
}

/**
 * Media's views, as the pages read them. `media/view.ts` implements it, over
 * `Media`; `live/views/media.ts`, its old copy, was deleted.
 */
export interface MediaViewsShape {
    /**
     * `GET /api/media`: a folder of the user's own files (never anyone
     * else's), newest first, with the folder tree, their usage and limits.
     */
    mediaView(userId: string, query: MediaViewQuery): Promise<MediaListing>;
}

export class MediaViews extends Context.Service<MediaViews, MediaViewsShape>()('socio/media/MediaViews') {}

// ── What media reads of other features ───────────────────────────────────

/**
 * The slice of the data space media calls (its files, usage, limits and
 * the two listeners it registers), spelled out here so media names no
 * folder above it: dataspace's `DataSpaceShape` satisfies it, and the
 * composition root (`composition/media.ts`) provides `MediaData` from
 * dataspace's `Data`.
 */
export interface MediaDataShape {
    /** The data space's limits in force; media reads `fileMaxBytes` and lists them all. */
    readonly limits: DataLimitsView;
    endFolderGrants(userId: string, rawFolder: string): Promise<number>;
    getFileById(actor: { kind: 'user'; userId: string }, fileId: string): Promise<{ file: DataFileView; data: Buffer }>;
    /**
     * A file as a socio reads it for a person (CB-524): its own folder, a
     * folder granted to it, or a file attached in this conversation; the
     * data space checks and audits the read, as for `files_get`.
     */
    getFile(
        actor: { kind: 'dot'; userId: string; dotId: string; threadId: string },
        rawPath: string,
    ): Promise<{ file: DataFileView; data: Buffer }>;
    putFile(
        actor: { kind: 'user'; userId: string },
        rawPath: string,
        data: Uint8Array,
        mediaType?: string,
        options?: { name?: string; create?: boolean },
    ): Promise<DataFileView>;
    moveFile(userId: string, rawFrom: string, rawTo: string): Promise<DataFileView>;
    moveFolder(userId: string, rawFrom: string, rawTo: string, also?: () => void | Promise<void>): Promise<number>;
    /** `stamp`: who deleted it (a user id, `system`) and what it went with (`<kind>:<id>`). */
    deleteFile(userId: string, rawPath: string, stamp?: { by?: string; with?: string }): Promise<void>;
    fileAt(userId: string, rawPath: string): MediaFile | undefined;
    fileRecord(userId: string, fileId: string): MediaFile | undefined;
    fileRecords(userId: string): MediaFile[];
    /** Told when a file is deleted: who did it and when, for its attachments. */
    onFileDeleted(
        listener: (userId: string, fileId: string, stamp: { at: number; by: string }) => void | Promise<void>,
    ): void;
    usage(userId: string): DataUsageView;
    /** The Dot of a conversation reads what the user attached there. */
    useConversationReads(check: (userId: string, path: string, threadId: string) => Promise<boolean>): void;
}

export class MediaData extends Context.Service<MediaData, MediaDataShape>()('socio/media/MediaData') {}

/**
 * The workspace reads media makes: socios, conversations and their access
 * rule, and who reads a Space. The composition root provides it over the
 * workspace's `Socios`, `Conversations` and `Spaces` slices, each read at
 * the moment of use.
 */
export interface MediaWorkspaceShape {
    dot(id: string): Dot | undefined;
    thread(id: string): Conversation | undefined;
    readableThread(userId: string, id: string): Promise<Conversation | undefined>;
    /** The one access rule (CB-208); without it no room takes uploads. */
    allows?(userId: string, id: string, action: 'send'): boolean;
    /**
     * The one Space access rule (CB-181): a link card's image is read by
     * those who may read its Space. Without it, nobody but its person.
     */
    readsSpace?(userId: string, spaceId: string): boolean;
    /** A Space's name, for an approval card (CB-524). */
    spaceName?(spaceId: string): string | undefined;
    /** Whether a person may edit a Space now (CB-524: who may add to its media). Without it, nobody. */
    editsSpace?(userId: string, spaceId: string): boolean;
    /** Whether the socio of a chat may use a Space now (`socioReads`, CB-181). Without it, none. */
    socioReads?(threadId: string, spaceId: string, dotId: string): boolean;
    /** Whether a live page `pageId` is in `spaceId`. Without it, none is. */
    livePage?(spaceId: string, pageId: string): boolean;
    /**
     * Of `ids`, the embeds some page names (CB-524): live or deleted, in
     * its text, its kept revisions or as its cover. Without it, all of
     * them, so nothing is ever cleaned up.
     */
    embedsNamed?(ids: readonly string[], options?: { revisions?: boolean }): Set<string>;
}

export class MediaWorkspace extends Context.Service<MediaWorkspace, MediaWorkspaceShape>()(
    'socio/media/MediaWorkspace',
) {}

// ── Config ───────────────────────────────────────────────────────────────

/** The `PlatformConfig` field media reads. */
export interface MediaConfigShape {
    readonly media?: MediaSettings;
}

export class MediaConfig extends Context.Service<MediaConfig, MediaConfigShape>()('socio/media/MediaConfig') {}
