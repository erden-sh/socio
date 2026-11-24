import { sniffType } from '@socio/shared/media/file-types';
import { NOTIFY_LIMITS } from '@socio/shared/notifications';

import { MODEL_IMAGE_TYPES, type MediaShape } from '../media/contract.js';

/** An attachment's or a Media item's bytes, in the brain. */
const BRAIN_IMAGE = /^\/api\/media\/(attachments|items)\/([^/?#]+)\/content$/;

/**
 * What an outside image is downloaded through: the Dot's web reads, the
 * slice of web's `WebReader` (`read`) this file calls, spelled out so
 * notifications names no folder above it. The composition root provides
 * it from `WebReader`, which satisfies it.
 */
export interface ImageReader {
    read(request: {
        dotId: string;
        userId?: string;
        url: string;
        signal?: AbortSignal;
    }): Promise<{ ok: true; status: number; body: Buffer; complete: boolean } | { ok: false; message: string }>;
}

export type ResolvedImage = { ok: true; bytes: Buffer; mediaType: string } | { ok: false; message: string };

/**
 * A notification's image (CB-114), as bytes the brain keeps: the person's
 * own media when the URL is the brain's, else downloaded once by the
 * server through the Dot's web reads (public addresses only, its limits
 * and log). Devices then load it from the brain alone: a third-party URL,
 * which could be a tracking pixel, never reaches them. PNG, JPEG, GIF or
 * WebP, 1 MB at most.
 */
export async function resolveImage(
    raw: string,
    turn: { userId: string; dotId: string; signal?: AbortSignal },
    deps: { media: MediaShape; web: ImageReader; origin: string },
): Promise<ResolvedImage> {
    let url: URL;
    try {
        url = new URL(raw, deps.origin);
    } catch {
        return { ok: false, message: 'The image is not a URL.' };
    }
    const own = url.origin === new URL(deps.origin).origin;
    const brain = own ? url.pathname.match(BRAIN_IMAGE) : null;
    let bytes: Buffer;
    if (own) {
        if (!brain) {
            return {
                ok: false,
                message: 'An image in Socio must be an attachment’s or a Media item’s content address.',
            };
        }
        try {
            bytes = await brainImage(deps.media, turn.userId, brain[1]!, brain[2]!);
        } catch {
            return {
                ok: false,
                message: 'That image is not one this person can open.',
            };
        }
    } else {
        const read = await deps.web.read({
            dotId: turn.dotId,
            userId: turn.userId,
            url: url.href,
            signal: turn.signal,
        });
        if (!read.ok) {
            return { ok: false, message: read.message };
        }
        if (read.status !== 200) {
            return {
                ok: false,
                message: `The image's site answered ${read.status}.`,
            };
        }
        if (!read.complete) {
            return { ok: false, message: 'The image is too large.' };
        }
        bytes = read.body;
    }
    if (bytes.length > NOTIFY_LIMITS.imageBytes) {
        return { ok: false, message: 'The image is larger than 1 MB.' };
    }
    const mediaType = sniffType(bytes);
    if (!mediaType || !MODEL_IMAGE_TYPES.has(mediaType)) {
        return {
            ok: false,
            message: 'The image must be a PNG, JPEG, GIF or WebP.',
        };
    }
    return { ok: true, bytes, mediaType };
}

async function brainImage(media: MediaShape, userId: string, kind: string, id: string) {
    const decoded = decodeURIComponent(id);
    if (kind === 'attachments') {
        const row = await media.readable(userId, decoded);
        if (!row) {
            throw new Error('Not found.');
        }
        return Buffer.from((await media.content(row)).data);
    }
    return Buffer.from((await media.itemContent(userId, decoded)).data);
}
