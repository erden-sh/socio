import { z } from 'zod';

import { EMBED_MEDIA_ID, embedMediaUrl } from './embed-card.js';

/**
 * A picture in a page (CB-358): an image made from a person's file the way
 * a page cover is, recorded as a media embed of the page's Space, so it is
 * served by this app to whoever may read that Space
 * (`/api/media/embeds/<id>/content`). The page holds only the embed's id,
 * never a URL: nothing in it loads from elsewhere, and the phone, which
 * fetches nothing a page names, draws it from its own image cache.
 *
 * In page Markdown it is a fenced code block with the `image` info string
 * and the picture as JSON, like a link card (`embed-card.ts`), so it
 * survives source mode, downloads and any Markdown tool, and plain image
 * Markdown (`![](url)`), which sends a page to source mode, is never
 * written:
 *
 * ```image
 * { "id": "cbemb_…", "alt": "The whiteboard", "width": 1600, "height": 1200 }
 * ```
 *
 * `width` and `height` are the image's own size in pixels, so a reader can
 * keep its space before it loads. A fence with that name whose JSON doesn't
 * parse stays a code block.
 */
export const PAGE_IMAGE_LANG = 'image';
/** Longest alt text, as on a link card's media. */
export const PAGE_IMAGE_ALT_MAX = 1000;

const side = z.number().int().positive().max(100_000);

export const pageImageSchema = z
    .object({
        /** The media embed's id, as `/api/media/embeds/:id/content` takes it. */
        id: z.string().regex(EMBED_MEDIA_ID),
        alt: z.string().trim().max(PAGE_IMAGE_ALT_MAX).optional(),
        width: side.optional(),
        height: side.optional(),
    })
    .strict();
export type PageImage = z.infer<typeof pageImageSchema>;

/**
 * A picture from anything (a fence's JSON, node attributes), or undefined.
 * An empty or whitespace-only alt is no alt: it is never written back, so
 * reading it as one would make the fence read differently once saved.
 */
export function pageImage(value: unknown): PageImage | undefined {
    const parsed = pageImageSchema.safeParse(value);
    if (!parsed.success) {
        return undefined;
    }
    const { alt, ...image } = parsed.data;
    return alt ? { ...image, alt } : image;
}

/** Keys in a fixed order, empty optionals left out. */
function ordered(image: PageImage): PageImage {
    const out: PageImage = { id: image.id };
    if (image.alt) {
        out.alt = image.alt;
    }
    if (image.width) {
        out.width = image.width;
    }
    if (image.height) {
        out.height = image.height;
    }
    return out;
}

/**
 * The fence's JSON. A backtick is written as ```, so no alt text can
 * close the fence early.
 */
export const pageImageBody = (image: PageImage) => JSON.stringify(ordered(image), null, 2).replace(/`/g, '\\u0060');

export const pageImageMarkdown = (image: PageImage) => `\`\`\`${PAGE_IMAGE_LANG}\n${pageImageBody(image)}\n\`\`\``;

/** Whether a fenced code token is a picture, and the picture if so. */
export function pageImageToken(token: { lang?: string; text?: string }) {
    if (token.lang?.trim().split(/\s+/)[0] !== PAGE_IMAGE_LANG) {
        return;
    }
    try {
        return pageImage(JSON.parse(token.text ?? ''));
    } catch {
        return undefined;
    }
}

/** Where a picture's image is served: the embed's content, like a cover's. */
export const pageImageUrl = (id: string) => embedMediaUrl(id);
