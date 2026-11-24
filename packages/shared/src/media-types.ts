import type { DataLimitsView, DataUsageView } from './data-types.js';

/**
 * Chat attachments and media (CB-54). An attachment is a data space file
 * linked to the conversation it was attached in; messages carry its id
 * (an AG-UI `binary` part with `id` only), never its bytes.
 */
export type AttachmentKind = 'image' | 'text' | 'file';
/** `tool`: an image a tool returned, such as a screenshot (CB-157). */
export type AttachmentSource = 'web' | 'telegram' | 'tool';

/** What a message part refers to, and what the composer shows. */
export interface AttachmentRef {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    kind: AttachmentKind;
}

export interface AttachmentView extends AttachmentRef {
    threadId: string | null;
    dotId: string | null;
    /** Null: the file was deleted. */
    path: string | null;
    createdAt: number;
    /** When a message first carried it to the model; null until then. */
    boundAt: number | null;
    source: AttachmentSource;
}

/** One file in the user's data space, as the Media page lists it. */
export interface MediaItem {
    id: string;
    path: string;
    name: string;
    folder: string;
    size: number;
    mediaType: string;
    kind: AttachmentKind | 'pdf';
    createdAt: number;
    updatedAt: number;
    createdByDotId: string | null;
    dotName: string | null;
    attachments: Array<{
        id: string;
        threadId: string | null;
        /** Null: a deleted conversation (or not attached yet). */
        threadTitle: string | null;
        dotId: string | null;
        dotName: string | null;
        source: AttachmentSource;
        boundAt: number | null;
    }>;
}

export type MediaKind = MediaItem['kind'];

/** `GET /api/media`: one folder of the user's files (the Media page). */
export interface MediaListing {
    /** The folder listed: '' for the root, else ending in `/`. */
    folder: string;
    /** Its immediate subfolders, empty ones included. */
    folders: string[];
    /** Every folder in the space, for the folder tree. */
    tree: string[];
    /** Newest first; with `q`, matches anywhere under the folder. */
    items: MediaItem[];
    nextCursor?: string;
    usage: DataUsageView;
    limits: DataLimitsView;
}

/** `POST /api/media/uploads`. */
export interface UploadResult {
    item: MediaItem;
    attachment?: AttachmentRef;
}

/** An attachment reference id: `cbatt_` and 16 random bytes in base64url. */
export const ATTACHMENT_ID = /^cbatt_[A-Za-z0-9_-]{22}$/;

export const MEDIA_LIMITS = {
    /** References in one message. */
    perMessage: 10,
    /** Uploads a minute, per user. */
    uploadsPerMinute: 60,
    /** Unsent attachments are deleted after this long. */
    pendingMs: 24 * 60 * 60_000,
} as const;

/** Image bytes one turn may send in all. */
export const TURN_IMAGE_BYTES = 32 * 1048576;

/** The custom header raw uploads need (a CSRF guard: it forces a preflight). */
export const UPLOAD_HEADER = 'X-CB-Upload';

/** The URL of an attachment's bytes; `download` asks for a download. */
export const attachmentContentUrl = (id: string, download = false) =>
    `/api/media/attachments/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;

/** The URL of a file's bytes in the Media page; `download` asks for a download. */
export const mediaContentUrl = (id: string, download = false) =>
    `/api/media/items/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;
