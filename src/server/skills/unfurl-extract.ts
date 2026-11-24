/**
 * `/unfurl` (CB-230): what a link's source says, from what the web reads
 * fetched: an X post through a FixTweet-style API, a video or photo
 * through its provider's oEmbed, any other page from its HTML. Pure
 * functions over bodies already fetched, so they are tested on recorded
 * fixtures and never reach the network themselves.
 *
 * The Markdown they write is what the page's rich editor opens: headings
 * no deeper than ###, no images and no HTML (images become the card's
 * media), and every character of the source's text escaped, so a page's
 * own words can't turn into markup.
 */
import type { EmbedKind } from '@socio/shared/embed-card';

/** A remote image to copy into the person's Files for the card. */
export interface MediaCandidate {
    /** The image to fetch: a photo, or a video's or GIF's poster. */
    url: string;
    kind: 'image' | 'video' | 'gif';
    alt?: string;
    width?: number;
    height?: number;
}

/** A link's source, ready for a card and a page. */
export interface Unfurled {
    kind: EmbedKind;
    /** The page's title. */
    title: string;
    provider?: string;
    /** The card's title, when the source has one apart from its text. */
    cardTitle?: string;
    author?: string;
    handle?: string;
    authorUrl?: string;
    /** Plain text for the card's excerpt. */
    excerpt?: string;
    publishedAt?: string;
    /** The full source as Markdown, for the page under the card. */
    body: string;
    media: MediaCandidate[];
    /** Links the source points to, deduplicated. */
    links: string[];
}

// ---- URLs -----------------------------------------------------------------

const X_HOSTS = new Set([
    'x.com',
    'www.x.com',
    'mobile.x.com',
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
    'fxtwitter.com',
    'fixupx.com',
    'vxtwitter.com',
]);
const X_STATUS = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web|i)\/status(?:es)?\/(\d{1,25})/;

/** An X post's id, when the URL is one. */
export function xStatusId(url: URL) {
    if (!X_HOSTS.has(url.hostname.toLowerCase())) {
        return undefined;
    }
    return X_STATUS.exec(url.pathname)?.[1];
}

/** The FixTweet API base the tool reads X posts through. */
export const FIXTWEET_BASE = 'https://api.fxtwitter.com';

/** The API URLs for a post, the newer API first. */
export const fixTweetUrls = (id: string, base = FIXTWEET_BASE) => [`${base}/2/status/${id}`, `${base}/status/${id}`];

/** oEmbed endpoints of providers that don't advertise one on the page. */
const OEMBED_PROVIDERS: Array<{ hosts: RegExp; endpoint: string }> = [
    {
        hosts: /^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/i,
        endpoint: 'https://www.youtube.com/oembed?format=json&url=',
    },
    {
        hosts: /^(?:www\.|player\.)?vimeo\.com$/i,
        endpoint: 'https://vimeo.com/api/oembed.json?url=',
    },
];

/** A known provider's oEmbed URL for a link, if it has one. */
export function knownOembed(url: URL) {
    const provider = OEMBED_PROVIDERS.find(({ hosts }) => hosts.test(url.hostname));
    return provider ? provider.endpoint + encodeURIComponent(url.href) : undefined;
}

/** `url` against `base`, as an http(s) URL, or undefined. */
export function absolute(url: string | undefined, base: string) {
    if (!url) {
        return undefined;
    }
    try {
        const resolved = new URL(url.trim(), base);
        if (!['http:', 'https:'].includes(resolved.protocol)) {
            return undefined;
        }
        if (resolved.username || resolved.password) {
            return undefined;
        }
        resolved.hash = resolved.hash.length > 1 ? resolved.hash : '';
        return resolved.href;
    } catch {
        return undefined;
    }
}

// ---- Markdown -------------------------------------------------------------

/** Text as Markdown that reads back as the same text, never as markup. */
export function escapeText(text: string) {
    return text.replace(/[\\`*_[\]<>~|]/g, '\\$&');
}

/** U+2060 WORD JOINER: invisible, and not a space to Markdown. */
const JOINER = '\u2060';
/**
 * A line whose start Markdown would read as a block (`# `, `- `, `1. `, a
 * `===` underline) starts with an invisible word joiner instead of a
 * backslash: the editor saves a paragraph's text without its backslashes,
 * so `\# a` would come back a heading, and the page would need source mode.
 */
function escapeLineStart(line: string) {
    return /^(?:#{1,6}(?=\s|$)|[-+*](?=\s|$)|\d{1,9}[.)](?=\s|$)|=+\s*$|-+\s*$)/.test(line) ? JOINER + line : line;
}

/** A link's target as Markdown keeps it whole: no spaces or parentheses. */
const target = (url: string) =>
    url.replace(/[\s()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** A Markdown link; its text escaped. */
export const link = (text: string, url: string) => `[${escapeText(text) || escapeText(url)}](${target(url)})`;

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/**
 * The URLs in a line of text, each with where it starts. A URL takes the
 * `)` after it when it opened one (`…/Foo_(bar)`), not the one closing a
 * sentence's parenthesis.
 */
function urlMatches(line: string) {
    return [...line.matchAll(URL_IN_TEXT)].map((match) => {
        let url = match[0];
        const open = (url.match(/\(/g) ?? []).length;
        const close = (url.match(/\)/g) ?? []).length;
        if (open > close && line[match.index + url.length] === ')') {
            url += ')';
        }
        return { url, index: match.index };
    });
}

/**
 * Plain text (a post) as Markdown: URLs as links, everything else
 * escaped, single line breaks kept as hard breaks.
 */
export function plainTextMarkdown(text: string) {
    return text
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((paragraph) =>
            paragraph
                .split('\n')
                .map((line) => {
                    let out = '';
                    let at = 0;
                    for (const { url, index } of urlMatches(line)) {
                        out += escapeText(line.slice(at, index));
                        out += link(url, url);
                        at = index + url.length;
                    }
                    out += escapeText(line.slice(at));
                    return escapeLineStart(out.trim());
                })
                .filter(Boolean)
                .join('\\\n'),
        )
        .filter(Boolean)
        .join('\n\n');
}

/** URLs in plain text. */
export const urlsIn = (text: string) => text.split('\n').flatMap((line) => urlMatches(line).map(({ url }) => url));

/** Markdown as a blockquote. */
export const quoted = (markdown: string) =>
    markdown
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');

/** At most `max` characters of text on one line, cut at a word. */
export function clip(text: string, max: number) {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) {
        return flat;
    }
    const cut = flat.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const iso = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    // Twitter's "Wed Oct 22 17:00:00 +0000 2026": the year moved before the time.
    const twitter = /^\w{3} (\w{3}) (\d{1,2}) (\d\d:\d\d:\d\d) ([+-]\d{4}) (\d{4})$/.exec(value.trim());
    const time = Date.parse(
        twitter ? `${twitter[1]} ${twitter[2]} ${twitter[5]} ${twitter[3]} GMT${twitter[4]}` : value,
    );
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};
export { iso as isoDate };

const str = (value: unknown, max = 10_000) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const num = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);
const obj = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const unique = (urls: Array<string | undefined>) => [...new Set(urls.filter((url): url is string => !!url))];

// ---- X posts (FixTweet) ---------------------------------------------------

/** A post's media: photos as they are, videos and GIFs by their poster. */
function postMedia(post: Record<string, unknown>): MediaCandidate[] {
    const media = obj(post.media);
    if (!media) {
        return [];
    }
    const all = list(media.all).length ? list(media.all) : [...list(media.photos), ...list(media.videos)];
    const out: MediaCandidate[] = [];
    for (const raw of all) {
        const item = obj(raw);
        if (!item) {
            continue;
        }
        const type = str(item.type);
        const kind = type === 'video' ? 'video' : type === 'gif' ? 'gif' : 'image';
        const url = absolute(kind === 'image' ? str(item.url) : str(item.thumbnail_url), 'https://x.com/');
        if (!url) {
            continue;
        }
        out.push({
            url,
            kind,
            alt: str(item.altText ?? item.alt_text ?? item.alt, 1000),
            width: num(item.width),
            height: num(item.height),
        });
    }
    return out;
}

/** An X long-form article's blocks (Draft.js-style) as Markdown. */
function articleBlocks(article: Record<string, unknown>) {
    const content = obj(article.content);
    const out: string[] = [];
    const links: string[] = [];
    for (const raw of Object.values(obj(content?.entityMap) ?? {})) {
        const entity = obj(obj(raw)?.value) ?? obj(raw);
        const url = absolute(str(obj(entity?.data)?.url) ?? str(obj(entity?.data)?.href), 'https://x.com/');
        if (url) {
            links.push(url);
        }
    }
    let ordered = 0;
    for (const raw of list(content?.blocks)) {
        const block = obj(raw);
        const text = str(block?.text);
        const type = str(block?.type) ?? 'unstyled';
        if (type !== 'ordered-list-item') {
            ordered = 0;
        }
        if (!text) {
            continue;
        }
        const inline = plainTextMarkdown(text).replace(/\n\n/g, '\\\n');
        if (type === 'header-one' || type === 'header-two') {
            out.push(`## ${escapeText(clip(text, 300))}`);
        } else if (type.startsWith('header-')) {
            out.push(`### ${escapeText(clip(text, 300))}`);
        } else if (type === 'unordered-list-item') {
            out.push(`- ${inline}`);
        } else if (type === 'ordered-list-item') {
            out.push(`${++ordered}. ${inline}`);
        } else if (type === 'blockquote') {
            out.push(quoted(inline));
        } else if (type === 'code-block') {
            out.push(fence(text));
        } else if (type !== 'atomic') {
            out.push(inline);
        }
    }
    // Consecutive list items stay one list.
    const joined = out.reduce(
        (markdown, block, index) =>
            index === 0
                ? block
                : `${markdown}${/^(- |\d+\. )/.test(block) && /^(- |\d+\. )/.test(out[index - 1]) ? '\n' : '\n\n'}${block}`,
        '',
    );
    return { markdown: joined, links };
}

/** A code block whose fence no line of `text` can close. */
function fence(text: string) {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const marker = '`'.repeat(longest + 1);
    return `${marker}\n${text.replace(/\n+$/, '')}\n${marker}`;
}

const postLinks = (post: Record<string, unknown>) => {
    const raw = obj(post.raw_text);
    const facets = list(raw?.facets)
        .map(obj)
        .filter((facet) => facet && (facet.type === 'url' || facet.type === 'link'))
        .map((facet) => absolute(str(facet!.replacement) ?? str(facet!.original) ?? str(facet!.url), 'https://x.com/'));
    return unique([
        ...facets,
        ...urlsIn(str(post.text) ?? str(raw?.text) ?? ''),
        absolute(str(obj(obj(post.media)?.external)?.url), 'https://x.com/'),
    ]);
};

/**
 * A FixTweet-style API response (`{ tweet }` or `{ status }`) as the post:
 * its full text, author, date, media, the post it quotes, and an X
 * long-form article's whole text. Undefined when it holds no post.
 */
export function fromFixTweet(json: unknown, url: string): Unfurled | undefined {
    const root = obj(json);
    const post = obj(root?.tweet) ?? obj(root?.status);
    if (!post) {
        return undefined;
    }
    const author = obj(post.author);
    const name = str(author?.name, 160);
    const handle = str(author?.screen_name ?? author?.handle, 80);
    const text = str(post.text, 100_000) ?? str(obj(post.raw_text)?.text, 100_000);
    const article = obj(post.article);
    const articleTitle = str(article?.title, 300);
    const blocks = article ? articleBlocks(article) : undefined;
    if (!text && !blocks?.markdown && !articleTitle) {
        return undefined;
    }
    const publishedAt = iso(post.created_timestamp) ?? iso(post.created_at);
    const postUrl = absolute(str(post.url), 'https://x.com/') ?? url;
    const media = postMedia(post);
    const cover = absolute(str(obj(obj(article?.cover_media)?.media_info)?.original_img_url), 'https://x.com/');
    if (cover) {
        media.unshift({ url: cover, kind: 'image' });
    }
    const who = name ?? (handle ? `@${handle}` : 'Someone');
    const parts: string[] = [];
    const byline = [
        `**${escapeText(who)}**${handle && name ? ` (@${escapeText(handle)})` : ''} on X`,
        publishedAt ? dateText(publishedAt) : undefined,
        link('View original post', postUrl),
    ].filter(Boolean);
    parts.push(byline.join(' · '));
    const replyingTo = str(post.replying_to, 80);
    if (replyingTo) {
        parts.push(`Replying to @${escapeText(replyingTo)}`);
    }
    if (articleTitle) {
        parts.push(`## ${escapeText(articleTitle)}`);
    }
    if (blocks?.markdown) {
        parts.push(blocks.markdown);
    } else if (text) {
        parts.push(quoted(plainTextMarkdown(text)));
    }
    const videos = media.filter((item) => item.kind !== 'image').length;
    if (videos) {
        parts.push(
            `${videos === 1 ? 'This post has a video' : `This post has ${videos} videos`}: ${link('watch it on X', postUrl)}.`,
        );
    }
    const quote = obj(post.quote);
    if (quote) {
        const quoteAuthor = obj(quote.author);
        const quoteName =
            str(quoteAuthor?.name, 160) ??
            (str(quoteAuthor?.screen_name) ? `@${str(quoteAuthor?.screen_name)}` : 'a post');
        const quoteUrl = absolute(str(quote.url), 'https://x.com/');
        const quoteText = str(quote.text, 20_000);
        parts.push(
            [
                `Quoting **${escapeText(quoteName)}**${quoteUrl ? ` · ${link('original', quoteUrl)}` : ''}`,
                quoteText ? quoted(plainTextMarkdown(quoteText)) : undefined,
            ]
                .filter(Boolean)
                .join('\n\n'),
        );
    }
    const firstLine = clip(articleTitle ?? (text ?? '').split('\n').find((line) => line.trim()) ?? '', 90);
    return {
        kind: 'post',
        title: clip(`${who} on X${firstLine ? `: ${firstLine}` : ''}`, 160),
        provider: 'X',
        ...(articleTitle ? { cardTitle: articleTitle } : {}),
        ...(name ? { author: name } : {}),
        ...(handle ? { handle: `@${handle}` } : {}),
        ...(handle ? { authorUrl: `https://x.com/${handle}` } : {}),
        excerpt: clip(text ?? str(article?.preview_text) ?? articleTitle ?? '', 1000),
        ...(publishedAt ? { publishedAt } : {}),
        body: parts.join('\n\n'),
        media,
        links: unique([...postLinks(post), ...(blocks?.links ?? [])]).filter((href) => href !== postUrl),
    };
}

/** A date as the page says it: `Oct 22, 2026`, the same everywhere. */
export const dateText = (value: string) =>
    new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeZone: 'UTC',
    }).format(new Date(value));

// ---- oEmbed ---------------------------------------------------------------

/**
 * An oEmbed response (JSON) as the card's facts. Its `html` (an iframe or
 * a script) is never used: the card is static.
 */
export function fromOembed(json: unknown, base: string) {
    const data = obj(json);
    if (!data) {
        return undefined;
    }
    const type = str(data.type);
    const kind: EmbedKind = type === 'video' ? 'video' : type === 'photo' ? 'photo' : 'link';
    const image = type === 'photo' ? absolute(str(data.url), base) : absolute(str(data.thumbnail_url), base);
    return {
        kind,
        title: str(data.title, 300),
        author: str(data.author_name, 160),
        authorUrl: absolute(str(data.author_url), base),
        provider: str(data.provider_name, 80),
        image: image
            ? ({
                  url: image,
                  kind: kind === 'video' ? 'video' : 'image',
                  width: num(type === 'photo' ? data.width : data.thumbnail_width),
                  height: num(type === 'photo' ? data.height : data.thumbnail_height),
              } satisfies MediaCandidate)
            : undefined,
    };
}

// ---- HTML -----------------------------------------------------------------

interface Element {
    tag: string;
    attrs: Record<string, string>;
    children: Array<Element | string>;
}

const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
/** Elements whose content is never the page's text. */
const RAW = new Set(
    'script style noscript template svg math iframe textarea object canvas video audio select'.split(' '),
);
const SKIPPED = new Set('nav header footer aside form button input dialog menu'.split(' '));
const NOISE =
    /(?:^|[\s_-])(?:share|social|related|comments?|newsletter|promo|advert|ads?|cookie|subscribe|sidebar|breadcrumbs?|paywall|popup|modal)(?:$|[\s_-])/i;

/** A <br> while a paragraph is assembled: a private-use character. */
const BREAK = '\uE000';

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    middot: '·',
    bull: '•',
    copy: '©',
    reg: '®',
    trade: '™',
    times: '×',
    deg: '°',
    euro: '€',
    pound: '£',
    shy: '',
    zwj: '',
    zwnj: '',
};
/** HTML character references as text. */
export function decodeEntities(text: string) {
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, name: string) => {
        if (name[0] === '#') {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
            return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : ' ';
        }
        return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

const TOKEN =
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>|<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * HTML as a tree, leniently: unknown closes are ignored, open elements
 * close with their parent, and the content of scripts, styles and the
 * like is skipped whole. Regexes over the text, linear in its length.
 */
export function parseHtml(html: string): Element {
    const root: Element = { tag: '#root', attrs: {}, children: [] };
    const stack: Element[] = [root];
    let at = 0;
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(html); match; match = TOKEN.exec(html)) {
        const top = stack[stack.length - 1];
        if (match.index > at) {
            top.children.push(html.slice(at, match.index));
        }
        at = TOKEN.lastIndex;
        const [whole, closing, opening, rawAttrs] = match;
        if (closing) {
            const tag = closing.toLowerCase();
            const index = stack.findLastIndex((element) => element.tag === tag);
            if (index > 0) {
                stack.length = index;
            }
            continue;
        }
        if (!opening) {
            continue;
        }
        const tag = opening.toLowerCase();
        const attrs: Record<string, string> = {};
        for (const attr of (rawAttrs ?? '').matchAll(ATTR)) {
            attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
        }
        const element: Element = { tag, attrs, children: [] };
        // A new paragraph or list item closes the one still open.
        if (tag === 'p' || tag === 'li') {
            const open = stack.findLastIndex((item) => item.tag === tag);
            const boundary = stack.findLastIndex((item) =>
                ['ul', 'ol', 'div', 'section', 'article', 'blockquote', 'td'].includes(item.tag),
            );
            if (open > 0 && open > boundary) {
                stack.length = open;
            }
        }
        stack[stack.length - 1].children.push(element);
        if (RAW.has(tag)) {
            // Skip to its close: its text is never the page's.
            const close = new RegExp(`</${tag}\\s*>`, 'ig');
            close.lastIndex = at;
            const end = close.exec(html);
            at = end ? close.lastIndex : html.length;
            TOKEN.lastIndex = at;
            continue;
        }
        if (!VOID.has(tag) && !whole.endsWith('/>')) {
            stack.push(element);
        }
    }
    if (at < html.length) {
        stack[stack.length - 1].children.push(html.slice(at));
    }
    return root;
}

function* walk(element: Element): Generator<Element> {
    for (const child of element.children) {
        if (typeof child !== 'string') {
            yield child;
            yield* walk(child);
        }
    }
}

const textOf = (element: Element): string =>
    element.children
        .map((child) => (typeof child === 'string' ? decodeEntities(child) : RAW.has(child.tag) ? '' : textOf(child)))
        .join('');

/** A page's metadata: Open Graph, Twitter cards and plain meta tags. */
export interface PageMeta {
    title?: string;
    description?: string;
    siteName?: string;
    author?: string;
    publishedAt?: string;
    image?: string;
    imageAlt?: string;
    video?: boolean;
    canonical?: string;
    oembed?: string;
}

export function pageMeta(tree: Element, base: string): PageMeta {
    const meta = new Map<string, string>();
    let title: string | undefined;
    let canonical: string | undefined;
    let oembed: string | undefined;
    for (const element of walk(tree)) {
        if (element.tag === 'meta') {
            const key = (element.attrs.property ?? element.attrs.name ?? element.attrs.itemprop ?? '').toLowerCase();
            const content = element.attrs.content?.trim();
            if (key && content && !meta.has(key)) {
                meta.set(key, content);
            }
        } else if (element.tag === 'title' && !title) {
            title = textOf(element).trim();
        } else if (element.tag === 'link') {
            const rel = (element.attrs.rel ?? '').toLowerCase().split(/\s+/);
            if (rel.includes('canonical') && !canonical) {
                canonical = absolute(element.attrs.href, base);
            }
            if (
                rel.includes('alternate') &&
                (element.attrs.type ?? '').toLowerCase() === 'application/json+oembed' &&
                !oembed
            ) {
                oembed = absolute(element.attrs.href, base);
            }
        }
    }
    const first = (...keys: string[]) => keys.map((key) => meta.get(key)).find(Boolean);
    const author = first('author', 'article:author', 'twitter:creator');
    const time = [...walk(tree)].find((element) => element.tag === 'time' && element.attrs.datetime);
    return {
        title: first('og:title', 'twitter:title') ?? title,
        description: first('og:description', 'twitter:description', 'description'),
        siteName: first('og:site_name', 'application-name'),
        // An author given as a profile URL isn't a name.
        author: author && !/^https?:/i.test(author) ? author : undefined,
        publishedAt: iso(first('article:published_time', 'datepublished', 'date', 'pubdate') ?? time?.attrs.datetime),
        image: absolute(
            first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
            base,
        ),
        imageAlt: first('og:image:alt', 'twitter:image:alt'),
        video: (first('og:type') ?? '').startsWith('video') || !!first('og:video', 'og:video:url'),
        canonical,
        oembed,
    };
}

const words = (element: Element) => textOf(element).replace(/\s+/g, ' ').trim().length;

const noisy = (element: Element) =>
    SKIPPED.has(element.tag) ||
    'hidden' in element.attrs ||
    element.attrs['aria-hidden'] === 'true' ||
    NOISE.test(`${element.attrs.class ?? ''} ${element.attrs.id ?? ''}`) ||
    ['navigation', 'banner', 'contentinfo', 'complementary'].includes(element.attrs.role ?? '');

/** The element holding the page's main text. */
function mainOf(tree: Element) {
    const all = [...walk(tree)];
    const best = (tag: (element: Element) => boolean) =>
        all
            .filter(tag)
            .sort((a, b) => words(b) - words(a))
            .find((element) => words(element) > 0);
    return (
        best((element) => element.tag === 'article') ??
        best((element) => element.tag === 'main' || element.attrs.role === 'main') ??
        all.find((element) => element.tag === 'body') ??
        tree
    );
}

interface Rendered {
    markdown: string;
    images: MediaCandidate[];
    links: string[];
}

/**
 * An HTML page's main text as Markdown the rich editor opens: headings,
 * paragraphs, lists, quotes, code, links, bold and italic. Images are
 * collected for the card, never written inline; scripts, navigation and
 * the like are left out.
 */
export function articleMarkdown(tree: Element, base: string): Rendered {
    const images: MediaCandidate[] = [];
    const links: string[] = [];
    const inline = (element: Element): string =>
        element.children
            .map((child) => {
                if (typeof child === 'string') {
                    return escapeText(decodeEntities(child).replace(/\s+/g, ' '));
                }
                if (RAW.has(child.tag) || noisy(child)) {
                    return '';
                }
                if (child.tag === 'br') {
                    return BREAK;
                }
                if (child.tag === 'img') {
                    image(child);
                    return '';
                }
                const inner = inline(child);
                const trimmed = inner.trim();
                if (!trimmed) {
                    return inner;
                }
                const pad = (text: string) => `${/^\s/.test(inner) ? ' ' : ''}${text}${/\s$/.test(inner) ? ' ' : ''}`;
                switch (child.tag) {
                    case 'a': {
                        const href = absolute(child.attrs.href, base);
                        if (!href) {
                            return inner;
                        }
                        links.push(href);
                        // Inner text is escaped already: keep it as it is.
                        return pad(`[${trimmed.replaceAll(BREAK, ' ')}](${target(href)})`);
                    }
                    case 'strong':
                    case 'b':
                        return /[*_]$|^[*_]/.test(trimmed) ? inner : pad(`**${trimmed}**`);
                    case 'em':
                    case 'i':
                        return /[*_]$|^[*_]/.test(trimmed) ? inner : pad(`*${trimmed}*`);
                    case 'code':
                    case 'kbd':
                    case 'samp': {
                        const plain = textOf(child).replace(/\s+/g, ' ').trim();
                        const ticks = '`'.repeat(
                            Math.max(0, ...[...plain.matchAll(/`+/g)].map((m) => m[0].length)) + 1,
                        );
                        const space = /^`|`$/.test(plain) ? ' ' : '';
                        return pad(`${ticks}${space}${plain}${space}${ticks}`);
                    }
                    default:
                        return inner;
                }
            })
            .join('');
    const image = (element: Element) => {
        const source =
            element.attrs.src && !element.attrs.src.startsWith('data:')
                ? element.attrs.src
                : (element.attrs['data-src'] ?? element.attrs.srcset?.split(',')[0]?.trim().split(/\s+/)[0]);
        const url = absolute(source, base);
        if (url && images.length < 20) {
            images.push({
                url,
                kind: 'image',
                alt: element.attrs.alt?.trim() || undefined,
                width: Number(element.attrs.width) || undefined,
                height: Number(element.attrs.height) || undefined,
            });
        }
    };
    const paragraph = (text: string) =>
        text
            .split(BREAK)
            .map((line) => escapeLineStart(line.replace(/\s+/g, ' ').trim()))
            .filter(Boolean)
            .join('\\\n');
    const blocks = (element: Element, depth = 0): string[] => {
        const out: string[] = [];
        let run: Array<Element | string> = [];
        const flush = () => {
            const text = paragraph(inline({ tag: 'p', attrs: {}, children: run }));
            if (text) {
                out.push(text);
            }
            run = [];
        };
        for (const child of element.children) {
            if (typeof child === 'string' || !BLOCK.has(child.tag)) {
                run.push(child);
                continue;
            }
            flush();
            if (RAW.has(child.tag) || noisy(child)) {
                continue;
            }
            switch (child.tag) {
                case 'h1':
                case 'h2':
                case 'h3':
                case 'h4':
                case 'h5':
                case 'h6': {
                    const text = inline(child).replaceAll(BREAK, ' ').replace(/\s+/g, ' ').trim();
                    if (text) {
                        out.push(`${child.tag === 'h1' || child.tag === 'h2' ? '##' : '###'} ${text}`);
                    }
                    break;
                }
                case 'p':
                case 'figcaption': {
                    const text = paragraph(inline(child));
                    if (text) {
                        out.push(text);
                    }
                    break;
                }
                case 'blockquote': {
                    const inner = blocks(child, depth).join('\n\n');
                    if (inner) {
                        out.push(quoted(inner));
                    }
                    break;
                }
                case 'ul':
                case 'ol': {
                    const items: string[] = [];
                    let number = Number(child.attrs.start) || 1;
                    for (const item of child.children) {
                        if (typeof item === 'string' || item.tag !== 'li') {
                            continue;
                        }
                        const body = blocks(item, depth + 1);
                        if (!body.length) {
                            continue;
                        }
                        const marker = child.tag === 'ol' ? `${number++}. ` : '- ';
                        const indent = ' '.repeat(marker.length);
                        items.push(
                            marker +
                                body
                                    // A nested list goes right under its item's text.
                                    .reduce(
                                        (joined, part) =>
                                            `${joined}${/^(?:- |\d+\. )/.test(part) ? '\n' : '\n\n'}${part}`,
                                    )
                                    .split('\n')
                                    .map((line, index) => (index && line ? indent + line : line))
                                    .join('\n'),
                        );
                    }
                    if (items.length) {
                        out.push(items.join('\n'));
                    }
                    break;
                }
                case 'pre': {
                    const code = textOf(child).replace(/^\n/, '');
                    if (code.trim()) {
                        out.push(fence(code));
                    }
                    break;
                }
                case 'hr':
                    out.push('---');
                    break;
                case 'img':
                    image(child);
                    break;
                case 'table': {
                    for (const row of walk(child)) {
                        if (row.tag !== 'tr') {
                            continue;
                        }
                        const cells = row.children
                            .filter(
                                (cell): cell is Element =>
                                    typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'),
                            )
                            .map((cell) => paragraph(inline(cell)).replace(/\\\n/g, ' '))
                            .filter(Boolean);
                        if (cells.length) {
                            out.push(cells.join(' · '));
                        }
                    }
                    break;
                }
                default:
                    out.push(...blocks(child, depth));
            }
        }
        flush();
        return out;
    };
    const markdown = blocks(mainOf(tree))
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { markdown, images, links: unique(links) };
}

const BLOCK = new Set([
    ...'address article aside blockquote body center dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html img li main nav ol p pre section summary table ul'.split(
        ' ',
    ),
    ...RAW,
]);

/** An HTML page (an article, a video page, anything) as the link's source. */
export function fromHtml(html: string, url: string, site: string): { unfurled: Unfurled; meta: PageMeta } {
    const tree = parseHtml(html);
    const meta = pageMeta(tree, url);
    const article = articleMarkdown(tree, url);
    const title = clip(meta.title ?? site, 160) || site;
    const media: MediaCandidate[] = [];
    if (meta.image) {
        media.push({
            url: meta.image,
            kind: meta.video ? 'video' : 'image',
            alt: meta.imageAlt,
        });
    }
    for (const image of article.images) {
        if (!media.some((item) => item.url === image.url)) {
            media.push(image);
        }
    }
    const byline = [
        meta.author ? `**${escapeText(meta.author)}**` : undefined,
        escapeText(meta.siteName ?? site),
        meta.publishedAt ? dateText(meta.publishedAt) : undefined,
        link('Read the original', url),
    ].filter(Boolean);
    const body = [
        byline.join(' · '),
        // A video page's text is its player's chrome: its description is the
        // source's own words.
        (meta.video ? '' : article.markdown) || (meta.description ? plainTextMarkdown(meta.description) : ''),
    ]
        .filter(Boolean)
        .join('\n\n');
    return {
        meta,
        unfurled: {
            kind: meta.video ? 'video' : 'article',
            title,
            provider: clip(meta.siteName ?? site, 80),
            cardTitle: meta.title ? clip(meta.title, 300) : undefined,
            ...(meta.author ? { author: clip(meta.author, 160) } : {}),
            excerpt: clip(meta.description ?? textOf(mainOf(tree)), 1000),
            ...(meta.publishedAt ? { publishedAt: meta.publishedAt } : {}),
            body,
            media,
            links: article.links.filter((href) => href !== url),
        },
    };
}
