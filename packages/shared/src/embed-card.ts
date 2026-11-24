import { z } from 'zod';

/**
 * A link card (CB-230): a static snapshot of a linked post, video or
 * article in a page, as `/unfurl` saved it. Nothing on it loads from the
 * linked site: its text was copied when it was made, and its media are
 * copies in the Files of the person who unfurled it, served by this app
 * (`/api/media/embeds/<id>/content`). No iframe, no third-party script, no
 * remote image, so the app's Content Security Policy stays as it is.
 *
 * In page Markdown it is a fenced code block with the `embed` info string
 * and the card as JSON, like a dataset view, so it survives source mode,
 * downloads and any Markdown tool:
 *
 * ```embed
 * { "url": "https://x.com/…/status/1", "kind": "post", "provider": "X", … }
 * ```
 *
 * A fence with that name whose JSON doesn't parse stays a code block.
 */
export const EMBED_CARD_LANG = 'embed';
export const EMBED_KINDS = ['post', 'video', 'photo', 'article', 'link'] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];
export const EMBED_MEDIA_KINDS = ['image', 'video', 'gif'] as const;
/** A copied media file's id, as `/api/media/embeds/:id/content` takes it. */
export const EMBED_MEDIA_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** The card's own excerpt; the full text is in the page under it. */
export const EMBED_TEXT_MAX = 1000;
export const EMBED_MEDIA_MAX = 4;

const httpUrl = z
    .string()
    .max(2048)
    .refine((value) => {
        try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch {
            return false;
        }
    }, 'Not an http(s) URL.');
const line = (max: number) => z.string().trim().min(1).max(max);

const embedMedia = z
    .object({
        /** The local copy; absent when the media couldn't be copied. */
        id: z.string().regex(EMBED_MEDIA_ID).optional(),
        kind: z.enum(EMBED_MEDIA_KINDS),
        alt: z.string().trim().max(1000).optional(),
        width: z.number().int().positive().max(100_000).optional(),
        height: z.number().int().positive().max(100_000).optional(),
    })
    .strict();
export type EmbedMedia = z.infer<typeof embedMedia>;

export const embedCardSchema = z
    .object({
        /** The link as the person gave it: the card's "open" target. */
        url: httpUrl,
        kind: z.enum(EMBED_KINDS),
        /** "X", "YouTube", a site's name. */
        provider: line(80).optional(),
        title: line(300).optional(),
        author: line(160).optional(),
        /** `@name` on a social site. */
        handle: line(80).optional(),
        authorUrl: httpUrl.optional(),
        text: z.string().trim().min(1).max(EMBED_TEXT_MAX).optional(),
        /** When the source says it was published, as an ISO date. */
        publishedAt: z.string().datetime({ offset: true }).optional(),
        media: z.array(embedMedia).max(EMBED_MEDIA_MAX).optional(),
        /** When the snapshot was taken, as an ISO date. */
        fetchedAt: z.string().datetime({ offset: true }),
    })
    .strict();
export type EmbedCard = z.infer<typeof embedCardSchema>;

/** A card from anything (a fence's JSON, node attributes), or undefined. */
export function embedCard(value: unknown): EmbedCard | undefined {
    const parsed = embedCardSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Keys in a fixed order, empty optionals left out. */
function ordered(card: EmbedCard): EmbedCard {
    const out: EmbedCard = {
        url: card.url,
        kind: card.kind,
        fetchedAt: card.fetchedAt,
    };
    for (const key of ['provider', 'title', 'author', 'handle', 'authorUrl', 'text', 'publishedAt'] as const) {
        if (card[key]) {
            out[key] = card[key];
        }
    }
    if (card.media?.length) {
        out.media = card.media.map((item) => {
            const media: EmbedMedia = { kind: item.kind };
            if (item.id) {
                media.id = item.id;
            }
            if (item.alt) {
                media.alt = item.alt;
            }
            if (item.width) {
                media.width = item.width;
            }
            if (item.height) {
                media.height = item.height;
            }
            return media;
        });
    }
    return out;
}

/**
 * The fence's JSON. A backtick is written as ```, so no text on the
 * card can close the fence early.
 */
export const embedCardBody = (card: EmbedCard) => JSON.stringify(ordered(card), null, 2).replace(/`/g, '\\u0060');

export const embedCardMarkdown = (card: EmbedCard) => `\`\`\`${EMBED_CARD_LANG}\n${embedCardBody(card)}\n\`\`\``;

/** Whether a fenced code token is a card, and the card if so. */
export function embedToken(token: { lang?: string; text?: string }) {
    if (token.lang?.trim().split(/\s+/)[0] !== EMBED_CARD_LANG) {
        return;
    }
    try {
        return embedCard(JSON.parse(token.text ?? ''));
    } catch {
        return undefined;
    }
}

/** Where a copied media file is served. */
export const embedMediaUrl = (id: string) => `/api/media/embeds/${encodeURIComponent(id)}/content`;
