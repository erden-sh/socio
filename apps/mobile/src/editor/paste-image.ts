import { EMBED_MEDIA_ID } from '@socio/shared/embed-card';
import { type PageImage, pageImage } from '@socio/shared/page-image';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import type { PickedFile } from '../sync/attachments';
import { FILE_UPLOAD_COPY, type FileUploads } from '../sync/upload-file';

// Pasting a picture into a page (CB-358): the editor's DOM paste (bridge
// `socio-paste-image`) or the toolbar's Paste image (expo-clipboard's
// `getImageAsync`, on the tap only) hands over a data URI; this makes it an
// image block. No React Native: the screen binds the file writing and
// measuring, and tests/editor runs it under Node.
//
// - **Online only in v1:** offline it says PASTE_NEEDS_CONNECTION and nothing
//   is written or queued. Text keeps saving offline as before.
// - **The uploads' page image profile and upload:** the picture is written to
//   a temporary file and goes through `uploads.add(…, 'image')` (HEIC or over
//   5 MB becomes a JPEG under it; what still isn't a cover's type is refused
//   in the uploads' words), then up to the person's Files. `prepare` waits for
//   it; an upload with no answer is tried at most twice more (each lists by
//   the upload's unique name first), then given up with PASTE_FAILED.
// - **The Space's image:** `POST /api/spaces/:spaceId/images { fileId }` makes
//   it an image of the page's Space the way a cover is, and answers its
//   `embedId`.
// - **The block:** the embed's id, with the uploaded picture's own size when
//   the phone can measure it, as shared's `pageImage`. The screen sends it to
//   the WebView (`socio-insert-image`) at the cursor.
// - The upload's row and copy go once it settled either way (`forget`); the
//   file stays in the person's Files.

/** Offline (v1). */
export const PASTE_NEEDS_CONNECTION = 'Pasting images needs a connection';
/** While a pasted picture uploads. */
export const PASTE_ADDING = 'Adding the image…';
/** Anything else that stopped it: no answer, a refusal with no words of its own, a bad answer. */
export const PASTE_FAILED = 'The image couldn’t be added. Try again.';
/** The toolbar's Paste image found nothing it could read. */
export const PASTE_NOTHING = 'There’s no image to paste.';
/** The images endpoint's 403, in its words. */
export const PASTE_CANT_EDIT = 'You can’t edit pages in that Space.';

/** A picture as the paste gave it. */
export interface PastedImage {
    readonly mimeType: string;
    /** `data:<type>;base64,…`. */
    readonly dataUri: string;
}

export interface PasteImageOptions {
    /** The page's Space: the image is made one of its images. */
    readonly spaceId: string;
    /** Whether the workspace answers now (the scope's sync status). */
    readonly connected: () => boolean;
    readonly uploads: Pick<FileUploads, 'add' | 'settled' | 'prepare' | 'resolve' | 'forget' | 'get'>;
    /** The scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** Writes the picture's bytes to a new temporary file (`temporary`: the uploads delete it once copied). */
    readonly writeTemporary: (image: PastedImage, name: string) => Promise<PickedFile>;
    /** The picture's size in pixels, read from a file; null when it can't be read. */
    readonly measure?: (uri: string) => Promise<{ readonly width: number; readonly height: number } | null>;
    readonly now?: () => Date;
    readonly onError?: (error: unknown) => void;
}

export type PasteImageResult =
    | { readonly kind: 'added'; readonly image: PageImage }
    | { readonly kind: 'refused'; readonly text: string };

/** The space's images path. */
export const spaceImagesPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/images`;

const pad = (value: number) => String(value).padStart(2, '0');

/** `pasted-20261115-143205.png`: what the uploads read the type from (it names the upload itself). */
export function pastedName(mimeType: string, at: Date): string {
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    const subtype = mimeType.split('/')[1] ?? 'png';
    const extension = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/g, '');
    return `pasted-${stamp}.${extension || 'png'}`;
}

/**
 * A data URI as the bridge takes it: Android's clipboard image comes as MIME
 * base64, broken into lines, which the WebView's check refuses.
 */
export function cleanDataUri(dataUri: string): string {
    const comma = dataUri.indexOf(',');
    return comma < 0 ? dataUri : dataUri.slice(0, comma + 1) + dataUri.slice(comma + 1).replace(/\s+/g, '');
}

/** The bytes a base64 data URI holds. */
export function dataUriBytes(dataUri: string): number {
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** The images endpoint's answer as the block's id, or null. */
async function embedOf(response: Response, signal?: AbortSignal): Promise<string | null> {
    const body = (await readJson(response, signal).catch(() => null)) as { embedId?: unknown } | null;
    const id = body?.embedId;
    return typeof id === 'string' && EMBED_MEDIA_ID.test(id) ? id : null;
}

/** Uploads a pasted picture and makes it an image of the Space; the block to insert, or the words why not. */
export async function addPastedImage(options: PasteImageOptions, pasted: PastedImage): Promise<PasteImageResult> {
    const { spaceId, connected, uploads, fetch, writeTemporary, measure, onError = () => {} } = options;
    const now = options.now ?? (() => new Date());
    if (!connected()) {
        return { kind: 'refused', text: PASTE_NEEDS_CONNECTION };
    }
    let picked: PickedFile;
    try {
        picked = await writeTemporary(pasted, pastedName(pasted.mimeType, now()));
    } catch (error) {
        onError(error);
        return { kind: 'refused', text: FILE_UPLOAD_COPY['copy-failed'] };
    }
    const added = await uploads.add(picked, 'image');
    if ('problem' in added) {
        return { kind: 'refused', text: FILE_UPLOAD_COPY[added.problem] };
    }
    const { id, path } = added.upload;
    try {
        // `add` started the first try; wait for it before counting, since
        // `prepare` joins a try in flight and starts one only when none is.
        // Then uploaded, failed, or (no answer) tried twice more: each lists by its name first.
        await uploads.settled(id);
        let waiting = await uploads.prepare(id);
        if (waiting?.action === 'retry') {
            waiting = await uploads.prepare(id);
        }
        const fileId = uploads.resolve(id);
        if (waiting !== null || fileId === null) {
            const error = uploads.get(id)?.error ?? null;
            if (error !== null && error !== 'refused' && error !== 'bad-answer') {
                return { kind: 'refused', text: FILE_UPLOAD_COPY[error] };
            }
            return { kind: 'refused', text: connected() ? PASTE_FAILED : PASTE_NEEDS_CONNECTION };
        }
        const size = await (measure?.(path) ?? Promise.resolve(null)).catch((error: unknown) => {
            onError(error);
            return null;
        });
        let response: Response;
        try {
            response = await fetch(spaceImagesPath(spaceId), { method: 'POST', json: { fileId } });
        } catch (error) {
            onError(error);
            return { kind: 'refused', text: connected() ? PASTE_FAILED : PASTE_NEEDS_CONNECTION };
        }
        if (response.status !== 201) {
            await response.body?.cancel().catch(() => {});
            switch (response.status) {
                case 403:
                    return { kind: 'refused', text: PASTE_CANT_EDIT };
                case 413:
                    return { kind: 'refused', text: FILE_UPLOAD_COPY['too-large'] };
                case 415:
                    return { kind: 'refused', text: FILE_UPLOAD_COPY.type };
                default:
                    return { kind: 'refused', text: PASTE_FAILED };
            }
        }
        const embedId = await embedOf(response);
        const image =
            embedId === null
                ? undefined
                : pageImage({ id: embedId, ...(size && size.width > 0 && size.height > 0 ? size : {}) });
        return image === undefined ? { kind: 'refused', text: PASTE_FAILED } : { kind: 'added', image };
    } finally {
        // The file stays in the person's Files; the phone's copy and row go.
        await uploads.forget(id).catch(onError);
    }
}
