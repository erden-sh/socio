import { ATTACHMENT_ID } from './media-types.js';

/**
 * Images that tools return (CB-157). A screenshot is stored as an
 * attachment of the conversation, as a photo the person sends is (CB-54),
 * and the tool's result names it under `image`, never its bytes: stored
 * history stays small, the model gets the image as an image when it can
 * see images (`context/images.ts`), and the turn's trace shows it as a
 * thumbnail to whoever can read the chat.
 */
export interface ToolImage {
    /** The attachment's id (`cbatt_…`). */
    id: string;
    mediaType: string;
    /** Bytes. */
    size: number;
    width?: number;
    height?: number;
}

/** The tools whose results may name an image of the conversation. */
export const IMAGE_TOOLS: ReadonlySet<string> = new Set(['computer_screenshot', 'attachments_view']);

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const dimension = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : undefined;

/**
 * The image a tool result names (its `image` field), from the result or
 * its JSON text; undefined for anything else.
 */
export function toolImageOf(result: unknown): ToolImage | undefined {
    let value = result;
    if (typeof value === 'string') {
        // A result naming an image is short; anything long is something else.
        if (value.length > 4_000 || !value.includes('"image"')) {
            return undefined;
        }
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const image = (value as { image?: unknown }).image;
    if (!image || typeof image !== 'object') {
        return undefined;
    }
    const { id, mediaType, size, width, height } = image as Record<string, unknown>;
    if (
        typeof id !== 'string' ||
        !ATTACHMENT_ID.test(id) ||
        typeof mediaType !== 'string' ||
        !RASTER.has(mediaType) ||
        typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size <= 0
    ) {
        return undefined;
    }
    const w = dimension(width);
    const h = dimension(height);
    return {
        id,
        mediaType,
        size,
        ...(w && h ? { width: w, height: h } : {}),
    };
}

/** The first characters of each raster format, as base64. */
const SIGNATURES: [string, string][] = [
    ['iVBORw0KGgo', 'image/png'],
    ['/9j/', 'image/jpeg'],
    ['R0lGOD', 'image/gif'],
    ['UklGR', 'image/webp'],
];

/** The image type of base64 text, by its first characters; undefined if none. */
export function inlineImageType(base64: string): string | undefined {
    const body = base64.replace(/^data:image\/[a-z+]+;base64,/, '');
    return SIGNATURES.find(([start]) => body.startsWith(start))?.[1];
}

/**
 * Base64 of an image inside text: a screenshot an older version stored
 * as text (`{"base64":"iVBORw0KGgo…"}`). It starts where base64 does (no
 * base64 character before it, so a match never starts inside a blob,
 * which keeps the search linear) and is at least 1,000 characters, so a
 * short token is never taken for one.
 */
const INLINE_IMAGE =
    /(?<![A-Za-z0-9+/])(?:data:image\/[a-z+]+;base64,)?(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/]{1000,}={0,2}/g;

/**
 * The text with each base64 image in it replaced by `note(type, bytes)`;
 * the same text when it has none.
 */
export function withoutInlineImages(text: string, note: (mediaType: string, bytes: number) => string): string {
    if (text.length < 1_000) {
        return text;
    }
    return text.replace(INLINE_IMAGE, (match) => {
        const body = match.replace(/^data:image\/[a-z+]+;base64,/, '');
        return note(inlineImageType(body) ?? 'image', Math.floor((body.replace(/=+$/, '').length * 3) / 4));
    });
}
