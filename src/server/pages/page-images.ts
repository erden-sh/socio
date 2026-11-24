import type { Code, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { PageError } from '@socio/foundation/pages/page-error';
import { embedCardBody, embedToken, type EmbedCard } from '@socio/shared/embed-card';
import { pageImageToken } from '@socio/shared/page-image';

import { MediaError, type MediaEmbedsShape } from '../media/contract.js';

/**
 * The media embeds a page's Markdown names: its pictures (CB-358), the
 * ```` ```image ```` fences (`@socio/shared/page-image`), and its link
 * cards' media (CB-362), the `media[].id` of its ```` ```embed ```` fences
 * (`@socio/shared/embed-card`). Both are embeds of the page's Space, so a
 * move copies them all into the new one. They are found by parsing the
 * page as CommonMark with GFM, so quotes, list items and indented code are
 * read as a renderer reads them. A code block is a picture or a card by
 * shared's rules (`pageImageToken`, `embedToken`: the info string's first
 * word, and text that parses as one); anything else is never changed.
 *
 * Parsing a long page takes a while (about 300 ms for 100,000 characters
 * of pictures and code), so a page is parsed only when `mayHavePictures`
 * finds a likely opener, and a move parses before its unit of work opens
 * (`page-moves.ts`), never under the writer's lock.
 */
export const pageMarkdown = unified().use(remarkParse).use(remarkGfm);

/**
 * What may open a picture's or a link card's fence: three backticks or
 * tildes, then `image` or `embed` as a word, anywhere in the text (what
 * comes before it on its line isn't checked). Lenient on purpose: a false
 * positive only costs a parse. No nested quantifiers, so it is linear in
 * the text: page text is untrusted.
 */
const LIKELY_OPENER = /(?:`{3}|~{3})[ \t]*(?:image|embed)\b|\/api\/media\/embeds\//;

/**
 * A link to a Space's media (CB-524): an upload's URL, as
 * `space_media_upload` returns it (`embedMediaUrl`), in a Markdown link,
 * image or link definition, such as a page's link to its PDF.
 */
const MEDIA_LINK = /^\/api\/media\/embeds\/([A-Za-z0-9_-]{16,64})\/content(?:\?download=1)?$/;

/** Whether the text may hold a picture, a link card or a media link, without parsing it. */
export const mayHavePictures = (content: string) => LIKELY_OPENER.test(content);

/** Every fenced or indented code block in the tree, in document order. */
function codeBlocks(tree: Root): Code[] {
    return nodesOf(tree, (node) => node.type === 'code') as Code[];
}

interface MdNode {
    type: string;
    url?: string;
    children?: MdNode[];
    position?: { start: { offset?: number }; end: { offset?: number } };
}

function nodesOf(tree: Root, keep: (node: MdNode) => boolean): MdNode[] {
    const out: MdNode[] = [];
    const walk = (node: MdNode) => {
        if (keep(node)) {
            out.push(node);
        }
        for (const child of node.children ?? []) {
            walk(child);
        }
    };
    walk(tree as unknown as MdNode);
    return out;
}

/**
 * The media links in the tree (CB-524), each with the exact place of the
 * embed id in its URL: searched in the node's source past its text (a
 * link's children), and only where the URL is there exactly once, so a
 * link written with escapes or entities is left out (a missing copy,
 * never changed text).
 */
function mediaLinks(content: string, tree: Root): PagePicture[] {
    const out: PagePicture[] = [];
    for (const node of nodesOf(
        tree,
        (item) => ['link', 'image', 'definition'].includes(item.type) && MEDIA_LINK.test(item.url ?? ''),
    )) {
        const id = MEDIA_LINK.exec(node.url!)![1]!;
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) {
            continue;
        }
        const last = node.children?.at(-1)?.position?.end.offset;
        const from = last !== undefined && last >= start && last <= end ? last : start;
        const path = `/api/media/embeds/${id}/content`;
        const found = occurrences(content.slice(from, end), path);
        if (found.length !== 1) {
            continue;
        }
        out.push({ id, at: from + found[0]! + '/api/media/embeds/'.length, length: id.length, raw: true });
    }
    return out;
}

/** Where `needle` occurs in `text`, by index. */
function occurrences(text: string, needle: string) {
    const out: number[] = [];
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        out.push(at);
    }
    return out;
}

/** Whether two pictures are the same, key by key. */
const same = (a: object, b: object) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => (b as Record<string, unknown>)[key] === value);

/**
 * A picture, or a link card's media, in a page's text: its embed id, and
 * where its quoted id (`"cbemb_…"`) sits.
 */
export interface PagePicture {
    id: string;
    /** The offset of the quoted id in the text. */
    at: number;
    /** The quoted id's length. */
    length: number;
    /** A media link's id (CB-524): in a URL, unquoted. */
    raw?: boolean;
}

/**
 * Another valid embed id than `id`, of plain JSON-safe characters like
 * every embed id, so what holds for it in a fence holds for a copy's id.
 */
const standIn = (id: string) => (id === 'x'.repeat(16) ? 'y'.repeat(16) : 'x'.repeat(16));

/** A link card with one media item's id swapped, compared as its fence writes it. */
const sameCard = (a: EmbedCard | undefined, b: EmbedCard) => !!a && embedCardBody(a) === embedCardBody(b);

/**
 * The places in a fence's body where the quoted `id` is the embed, each as
 * its offset in `content`: every occurrence in the parsed `value` whose
 * swap for a stand-in id `swapped` accepts. `bodyAt` and `end` bound the
 * body's source; an id written with escapes, so it can't be placed
 * exactly, is left out (a missing copy, never changed text).
 */
function placeId(
    content: string,
    bodyAt: number,
    end: number,
    value: string,
    id: string,
    swapped: (text: string, stand: string) => boolean,
): number[] {
    const old = JSON.stringify(id);
    const inSource = occurrences(content.slice(bodyAt, end), old);
    const inValue = occurrences(value, old);
    if (!inValue.length || inSource.length !== inValue.length) {
        return [];
    }
    const stand = standIn(id);
    const out: number[] = [];
    inValue.forEach((at, index) => {
        if (swapped(value.slice(0, at) + JSON.stringify(stand) + value.slice(at + old.length), stand)) {
            out.push(bodyAt + inSource[index]!);
        }
    });
    return out;
}

/**
 * The pictures and link-card media in `content`, in order, each with the
 * exact place of the quoted id that is its `id` (not an alt, a title or a
 * card's text that happens to hold the same text). A picture or media item
 * whose id can't be placed exactly (written with escapes, say) is left
 * out: a missing copy, never changed text.
 */
export function findPagePictures(content: string): PagePicture[] {
    if (!mayHavePictures(content)) {
        return [];
    }
    const out: PagePicture[] = [];
    const tree = pageMarkdown.parse(content);
    for (const node of codeBlocks(tree)) {
        if (!node.lang) {
            continue;
        }
        const lang = [node.lang, node.meta].filter(Boolean).join(' ');
        const image = pageImageToken({ lang, text: node.value });
        const card = image ? undefined : embedToken({ lang, text: node.value });
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if ((!image && !card) || start === undefined || end === undefined) {
            continue;
        }
        // The body's source: past the opening line, which can't hold the
        // JSON, though its info string might hold the id.
        const bodyAt = content.indexOf('\n', start) + 1;
        if (bodyAt <= 0 || bodyAt >= end) {
            continue;
        }
        if (image) {
            // Another valid id in that place changes the id and nothing else.
            const [at] = placeId(content, bodyAt, end, node.value, image.id, (text, stand) => {
                const swapped = pageImageToken({ lang, text });
                return !!swapped && same(swapped, { ...image, id: stand });
            });
            if (at !== undefined) {
                out.push({ id: image.id, at, length: JSON.stringify(image.id).length });
            }
            continue;
        }
        // A link card (CB-362): each of its media's ids, once per id, at
        // every place where swapping it changes one media item's id and
        // nothing else on the card.
        const media = card!.media ?? [];
        const places: PagePicture[] = [];
        for (const id of new Set(media.flatMap((item) => (item.id ? [item.id] : [])))) {
            const ats = placeId(content, bodyAt, end, node.value, id, (text, stand) => {
                const swapped = embedToken({ lang, text });
                return media.some(
                    (item, index) =>
                        item.id === id &&
                        sameCard(swapped, {
                            ...card!,
                            media: media.map((other, at) => (at === index ? { ...other, id: stand } : other)),
                        }),
                );
            });
            for (const at of ats) {
                places.push({ id, at, length: JSON.stringify(id).length });
            }
        }
        out.push(...places.sort((a, b) => a.at - b.at));
    }
    // Links to the Space's media (CB-524), such as an uploaded PDF's.
    out.push(...mediaLinks(content, tree));
    return out.sort((a, b) => a.at - b.at);
}

/**
 * `content` with each picture's quoted id replaced by its copy's
 * (`copies`); one with no copy (or the same id) is left as it was, and so
 * is every other byte: quote markers, indent, line endings, key order and
 * spacing. No parse: `pictures` is `findPagePictures(content)`.
 */
export function swapPagePictures(
    content: string,
    pictures: readonly PagePicture[],
    copies: ReadonlyMap<string, string | undefined>,
): string {
    let out = content;
    // From the end, so the earlier offsets stay valid.
    for (const picture of [...pictures].reverse()) {
        const copy = copies.get(picture.id);
        const quote = (id: string) => (picture.raw ? id : JSON.stringify(id));
        const old = quote(picture.id);
        // A second guard: the planned place must still hold the quoted id.
        if (copy && copy !== picture.id && out.slice(picture.at, picture.at + picture.length) === old) {
            out = out.slice(0, picture.at) + quote(copy) + out.slice(picture.at + picture.length);
        }
    }
    return out;
}

/**
 * `content` with each picture's embed id replaced by `next(id)` (asked
 * once per id, in order); one for which `next` answers undefined (or the
 * same id) is left as it was.
 */
export async function rewritePageImages(
    content: string,
    next: (embedId: string) => Promise<string | undefined>,
): Promise<string> {
    const pictures = findPagePictures(content);
    const copies = new Map<string, string | undefined>();
    for (const { id } of pictures) {
        if (!copies.has(id)) {
            copies.set(id, await next(id));
        }
    }
    return swapPagePictures(content, pictures, copies);
}

/** A move's answer when a page it read changed before the move could write. */
export class PageChangedDuringMove extends PageError {
    readonly code = 'page_changed';
    constructor() {
        super('A page changed while it was being moved. Try the move again.', 409);
    }
}

/** What a move copies media embeds with: media's cover contract. */
export type PageMoveMedia = Pick<MediaEmbedsShape, 'coverFromEmbed' | 'copyEmbedToSpace'>;

/**
 * A move's `copyImage` (`PageMoveInput`): a picture or a link card's media
 * of the Space the page leaves, which `viewer` (the mover) may see, copied
 * into `to` through media's cover contract, the same embed rows on the
 * same file as a moved cover's. An id from anywhere else (another Space,
 * someone's private image, an embed or file that is gone) is left as it
 * was, so a fence can't carry an image into a Space it was never in.
 */
export function pageImageCopier(media: PageMoveMedia, viewer: string, from: string, to: string) {
    return async (embedId: string) => {
        try {
            // The cover picker's check: in `from`, seen by `viewer`, file there.
            // `files`: a PDF uploaded into the Space moves too (CB-524).
            await media.coverFromEmbed(viewer, embedId, from, { files: true });
        } catch (error) {
            if (error instanceof MediaError) {
                return undefined;
            }
            throw error;
        }
        return media.copyEmbedToSpace(embedId, to);
    };
}
