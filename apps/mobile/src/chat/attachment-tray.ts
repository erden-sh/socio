import type { Message } from '@ag-ui/core';

import type { AttachmentKind } from '@socio/shared/media-types';
import { isAttachmentPart } from '@socio/shared/media/refs';
import { formatSize } from '@socio/shared/text/format-size';

import type { AddProblem, Attachment, AttachmentFailure, MediaLimits, PickedFile } from '../sync/attachments';
import type { ToneName } from '../theme/theme';

// Attachments in the composer and the transcript, under Node:
// - **The tray** is T3 Code's attachment strip over the box: one tile per
//   file, a picture's own thumbnail (its copy in `attachments/`) or a file's
//   tone and extension, a thin indeterminate bar while it uploads, Retry on
//   one that failed, and a remove button on each.
// - **The pickers' answers** become `PickedFile`s: the system photo picker's
//   and the camera's assets, the document picker's, each the picker's own
//   temporary copy (attachments.ts deletes it once ours is durable).
// - **A pasted image** (CB-358) is expo-paste-input's file, taken the
//   same way as a picked photo (`pasteImages`), then deleted.
// - **What a picker's file couldn't do** is one line over the box, in plain
//   words, naming the file.
// - **A message's files** in the transcript: its AG-UI `binary` parts (by
//   the server's id), pictures as thumbnails through the image cache, the
//   rest as chips. A pending bubble shows its row's files from their copies.

/** The model's image types (the server's MODEL_IMAGE_TYPES): only these show as pictures. */
export const PICTURE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A tile's side in the tray, in points (T3 Code's 72). */
export const TRAY_TILE = 72;

export const ATTACH_LABEL = 'Add attachment';
export const PICK_PHOTOS = 'Photos';
export const PICK_CAMERA = 'Camera';
export const PICK_FILES = 'Files';
export const CAMERA_DENIED = 'Socio can’t use the camera. Allow it in Settings to take a photo.';
export const PICK_FAILED = 'That didn’t open. Try again.';

export type PickSource = 'photos' | 'camera' | 'files';

/** Each picker's tone in the attach menu: the owner likes color (sky, violet, amber). */
export const PICK_TONES: Readonly<Record<PickSource, ToneName>> = { photos: 'sky', camera: 'violet', files: 'amber' };

/** A file's tone by kind. */
export const KIND_TONES: Readonly<Record<AttachmentKind, ToneName>> = { image: 'sky', text: 'amber', file: 'indigo' };

export interface TrayItem {
    readonly id: string;
    readonly name: string;
    readonly kind: AttachmentKind;
    readonly tone: ToneName;
    /** `PDF`, `TXT`…, for a tile with no picture. */
    readonly extension: string;
    /** The copy as `file://`, for a picture's thumbnail; null for another file. */
    readonly picture: string | null;
    readonly uploading: boolean;
    readonly failed: boolean;
    /** Why it failed, in plain words, or null. */
    readonly problem: string | null;
    /** Retry: a failed upload whose copy is still there. */
    readonly retry: boolean;
    /** What a screen reader says for the tile. */
    readonly label: string;
}

/** A path or URI as `file://`. */
export const fileUrl = (path: string) => (/^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `file://${encodeURI(path)}`);

/** `report.final.PDF` → `PDF`; '' for none. */
export function extensionLabel(name: string): string {
    const match = /\.([A-Za-z0-9]{1,6})$/.exec(name);
    return match ? match[1]!.toUpperCase() : '';
}

const FAILURE_COPY: Readonly<Record<AttachmentFailure, string>> = {
    'too-large': 'Too large to attach',
    type: 'Socio can’t take this kind of file',
    refused: 'Didn’t upload',
    'bad-answer': 'Didn’t upload',
    missing: 'The file is gone from this phone',
};

export function failureCopy(error: AttachmentFailure | null): string {
    return error === null ? FAILURE_COPY.refused : (FAILURE_COPY[error] ?? FAILURE_COPY.refused);
}

export function trayItems(files: readonly Attachment[]): TrayItem[] {
    return files.map((file) => {
        const failed = file.state === 'failed';
        const problem = failed ? failureCopy(file.error) : null;
        const uploading = file.state === 'uploading';
        return {
            id: file.id,
            name: file.name,
            kind: file.kind,
            tone: KIND_TONES[file.kind],
            extension: extensionLabel(file.name),
            picture: PICTURE_TYPES.has(file.mime) ? fileUrl(file.path) : null,
            uploading,
            failed,
            problem,
            retry: failed && file.error !== 'missing',
            label: `${file.name}, ${formatSize(file.bytes)}${uploading ? ', uploading' : failed ? `, ${problem}` : ''}`,
        };
    });
}

/**
 * What a failed tile's cover does when tapped: Retry while the copy is there,
 * else Remove (a file gone from the phone can only go).
 */
export function failedTileAction(
    item: Pick<TrayItem, 'failed' | 'retry' | 'name' | 'problem'>,
): { readonly action: 'retry' | 'remove'; readonly label: string; readonly accessibilityLabel: string } | null {
    if (!item.failed) {
        return null;
    }
    return item.retry
        ? { action: 'retry', label: 'Retry', accessibilityLabel: `Retry uploading ${item.name}` }
        : {
              action: 'remove',
              label: 'Remove',
              accessibilityLabel: `Remove ${item.name}${item.problem === null ? '' : `. ${item.problem}`}`,
          };
}

/** The line over the box for files the tray didn't take, or null. */
export function addProblemsLine(
    problems: readonly AddProblem[],
    limits: Pick<MediaLimits, 'fileMaxBytes' | 'perMessage'>,
): string | null {
    if (problems.length === 0) {
        return null;
    }
    const first = problems[0]!;
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    switch (first.reason) {
        case 'too-large':
            return `${first.name}${more} is over ${formatSize(limits.fileMaxBytes)}, too large to attach.`;
        case 'too-many':
            return `A message takes at most ${limits.perMessage} files.`;
        case 'empty':
            return `${first.name}${more} is empty.`;
        case 'read-only':
            return 'Update Socio to attach files.';
        default:
            return `${first.name}${more} couldn’t be attached. Try again.`;
    }
}

/** Mime types by extension, for a picker that doesn't say. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
};

export function mimeOf(name: string, given?: string | null): string {
    if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given)) {
        return given.toLowerCase();
    }
    return MIME_BY_EXTENSION[extensionLabel(name).toLowerCase()] ?? 'application/octet-stream';
}

/** What expo-image-picker hands back for each asset (the slice used). */
export interface ImageAsset {
    readonly uri: string;
    readonly fileName?: string | null;
    readonly mimeType?: string | null;
    readonly fileSize?: number | null;
}

/** What expo-document-picker hands back for each asset (the slice used). */
export interface DocumentAsset {
    readonly uri: string;
    readonly name: string;
    readonly mimeType?: string | null;
    readonly size?: number | null;
}

/** `photo-20261108-143205.jpg`, for a camera shot with no name (`pasted-…` for a pasted image). */
function photoName(at: Date, extension: string, prefix: string): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `${prefix}-${stamp}.${extension}`;
}

/** The last path segment of a URI, decoded. */
function lastSegment(uri: string): string {
    const segment = uri.slice(uri.lastIndexOf('/') + 1).split('?')[0] ?? '';
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * The photo picker's or the camera's assets as picked files. Sizes the picker
 * doesn't give are measured (`sizeOf`); every file is the picker's own copy.
 */
export async function pickedImages(
    assets: readonly ImageAsset[],
    sizeOf: (uri: string) => Promise<number>,
    now: Date,
    prefix = 'photo',
): Promise<PickedFile[]> {
    const picked: PickedFile[] = [];
    for (const [index, asset] of assets.entries()) {
        const fromUri = lastSegment(asset.uri);
        const mime = mimeOf(asset.fileName ?? fromUri, asset.mimeType);
        const extension =
            extensionLabel(asset.fileName ?? fromUri).toLowerCase() || (mime === 'image/png' ? 'png' : 'jpg');
        // Android's photo picker names a photo by its media id (`23.jpg`): a dated name reads better.
        const given = asset.fileName?.trim() ?? '';
        const name =
            (given !== '' && !/^\d+\.[A-Za-z0-9]+$/.test(given) ? given : '') ||
            photoName(index === 0 ? now : new Date(now.getTime() + index * 1000), extension, prefix);
        const bytes = asset.fileSize && asset.fileSize > 0 ? asset.fileSize : await sizeOf(asset.uri);
        picked.push({ uri: asset.uri, name, mime, bytes, temporary: true });
    }
    return picked;
}

export const PASTE_FAILED = 'That image didn’t paste. Try again.';

/** What `pasteImages` needs of the tray and the phone (bound in screens/attachments.tsx). */
export interface PasteTarget {
    limits(): Promise<Pick<MediaLimits, 'fileMaxBytes' | 'perMessage'>>;
    /** How many files the tray holds now. */
    count(): number;
    add(files: readonly PickedFile[]): Promise<{ readonly problems: readonly AddProblem[] }>;
    sizeOf(uri: string): Promise<number>;
    /** Deletes a pasted file; one already gone is fine. */
    remove(uri: string): Promise<void>;
    onError(error: unknown): void;
}

/**
 * Images pasted into the box (CB-358): expo-paste-input writes each to
 * the app's temporary (iOS) or cache (Android) folder and hands over only
 * their `file://` URIs, so the name, type and size come from `pickedImages`,
 * as for a picked photo, and they go through `attachments.add` (the image
 * processor, then the copy) up to the tray's limit. Every pasted file is
 * deleted afterwards, whatever happened: `add` deletes the ones it copied or
 * refused, but keeps one whose copy failed for a retry a paste never makes,
 * and `clearPickerCache` doesn't reach the module's folders. Returns the line
 * over the box, or null.
 */
export async function pasteImages(uris: readonly string[], target: PasteTarget, now: Date): Promise<string | null> {
    try {
        const limits = await target.limits();
        const room = limits.perMessage - target.count();
        const tooMany = addProblemsLine([{ name: '', reason: 'too-many' }], limits);
        if (room <= 0) {
            return tooMany;
        }
        const files = await pickedImages(
            uris.slice(0, room).map((uri) => ({ uri })),
            target.sizeOf,
            now,
            'pasted',
        );
        const { problems } = await target.add(files);
        return addProblemsLine(problems, limits) ?? (uris.length > room ? tooMany : null);
    } catch (error) {
        target.onError(error);
        return PASTE_FAILED;
    } finally {
        for (const uri of uris) {
            await target.remove(uri).catch(target.onError);
        }
    }
}

export async function pickedDocuments(
    assets: readonly DocumentAsset[],
    sizeOf: (uri: string) => Promise<number>,
): Promise<PickedFile[]> {
    const picked: PickedFile[] = [];
    for (const asset of assets) {
        const name = asset.name.trim() || lastSegment(asset.uri) || 'file';
        const bytes = asset.size && asset.size > 0 ? asset.size : await sizeOf(asset.uri);
        picked.push({ uri: asset.uri, name, mime: mimeOf(name, asset.mimeType), bytes, temporary: true });
    }
    return picked;
}

/** A file a message carries, as the transcript draws it. */
export interface MessageFile {
    /** The server's attachment id, or the local id of a copy still on the phone. */
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly picture: boolean;
    /** A copy on the phone (`file://`): a pending bubble's, shown with no download. */
    readonly local: string | null;
    readonly tone: ToneName;
    readonly extension: string;
}

const kindOfMime = (mime: string): AttachmentKind =>
    mime.startsWith('image/') ? 'image' : mime.startsWith('text/') ? 'text' : 'file';

/** A stored or streamed message's files: its `binary` parts by the server's id, in order. */
export function messageFiles(message: Pick<Message, 'content'>): MessageFile[] {
    const content = message.content as unknown;
    if (!Array.isArray(content)) {
        return [];
    }
    return content.filter(isAttachmentPart).map((part) => {
        const name = part.filename ?? (part.mimeType.startsWith('image/') ? 'Image' : 'Attachment');
        return {
            id: part.id,
            name,
            mime: part.mimeType,
            picture: PICTURE_TYPES.has(part.mimeType),
            local: null,
            tone: KIND_TONES[kindOfMime(part.mimeType)],
            extension: extensionLabel(name),
        };
    });
}

/** An outbox row's files from their copies on the phone (`attachments.carried`). */
export function carriedFiles(files: readonly Attachment[]): MessageFile[] {
    return files.map((file) => ({
        id: file.id,
        name: file.name,
        mime: file.mime,
        picture: PICTURE_TYPES.has(file.mime),
        local: fileUrl(file.path),
        tone: KIND_TONES[file.kind],
        extension: extensionLabel(file.name),
    }));
}

/** The pictures of a message, for the viewer: each one's id, name and copy when the phone has one. */
export interface ViewerImage {
    readonly id: string;
    readonly name: string;
    readonly local: string | null;
    /** An issue's attachment, read from its own path; a chat's otherwise. */
    readonly kind?: 'attachment' | 'issue';
}

export const viewerImages = (files: readonly MessageFile[]): ViewerImage[] =>
    files.filter((file) => file.picture).map(({ id, name, local }) => ({ id, name, local }));
