/**
 * What a bundle does to text (CB-380): issue bodies, comments and page
 * Markdown keep their words; only references to the source change, so they
 * never resolve to an unrelated record here.
 *
 * - `CB-n` of a copied issue stays as it is (numbers are kept), or takes
 *   its number here when the import renumbered it (its number here was
 *   another issue's). Of an issue that wasn't copied it becomes
 *   `CB-n (Acme)`, linked to the source's own board by its absolute URL (the
 *   source's origin, from the manifest).
 * - `/issues/CB-n` and `<origin>/issues/CB-n`: a copied issue's link is
 *   relative (here, under its number here); any other is absolute (there).
 * - `/spaces/<id>` and `/spaces/<id>/pages/<id>`, relative or absolute,
 *   the same way: a copied page (or a whole copied Space) here, with its
 *   Space id as mapped, else the absolute source URL.
 * - Code is never changed: fenced blocks (``` and ~~~, in quotes and
 *   lists too) and inline code spans. `#n` shorthand is left alone.
 *
 * Plain string scanning, no Markdown parser: linear in the text (page text
 * is untrusted, and an import must not stall the server), and when it
 * can't tell whether something is code it treats it as code.
 */

/** A [start, end) range of the text. */
export type Range = readonly [number, number];

/** A fenced code block: its whole range, its info string and its body. */
export interface FencedBlock {
    start: number;
    end: number;
    info: string;
    body: string;
}

/**
 * A line that opens a fence: indent, quote and list markers, then three or more
 * backticks or tildes, then the info string. A plain scan (a regular
 * expression with overlapping whitespace backtracks on long indents).
 */
function fenceOpen(line: string): { char: string; length: number; info: string; quoted: boolean } | undefined {
    let at = 0;
    let quoted = false;
    for (;;) {
        const char = line[at];
        if (char === ' ' || char === '\t' || char === '>') {
            quoted ||= char === '>';
            at++;
            continue;
        }
        // A list item's marker: `-`, `*` or `+`, or digits then `.` or `)`, then a space.
        if ((char === '-' || char === '*' || char === '+') && (line[at + 1] === ' ' || line[at + 1] === '\t')) {
            at++;
            continue;
        }
        let digits = at;
        while (digits < line.length && digits - at < 9 && line[digits]! >= '0' && line[digits]! <= '9') {
            digits++;
        }
        if (
            digits > at &&
            (line[digits] === '.' || line[digits] === ')') &&
            (line[digits + 1] === ' ' || line[digits + 1] === '\t')
        ) {
            at = digits + 1;
            continue;
        }
        break;
    }
    const char = line[at];
    if (char !== '`' && char !== '~') {
        return undefined;
    }
    let end = at;
    while (line[end] === char) {
        end++;
    }
    const info = line.slice(end);
    if (end - at < 3 || (char === '`' && info.includes('`'))) {
        return undefined;
    }
    return { char, length: end - at, info: info.trim(), quoted };
}
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]?)*/;

/**
 * The fenced code blocks of `text`, in order. A fence may be indented and
 * inside block quotes; one never closed runs to the end of the text, as
 * CommonMark has it. A backtick fence's info string can't hold a backtick.
 */
export function fencedBlocks(text: string): FencedBlock[] {
    const out: FencedBlock[] = [];
    let at = 0;
    let open: { start: number; char: string; length: number; info: string; quoted: boolean; bodyAt: number } | null =
        null;
    const body: string[] = [];
    while (at <= text.length) {
        const newline = text.indexOf('\n', at);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(at, lineEnd).replace(/\r$/, '');
        const next = newline === -1 ? text.length + 1 : newline + 1;
        if (!open) {
            const match = fenceOpen(line);
            if (match) {
                open = {
                    start: at,
                    char: match.char,
                    length: match.length,
                    info: match.info,
                    quoted: match.quoted,
                    bodyAt: next,
                };
                body.length = 0;
            }
        } else {
            const stripped = line.replace(QUOTE_PREFIX, '');
            const run = /^(`+|~+)[ \t]*$/.exec(stripped.trimStart());
            if (run && run[1]![0] === open.char && run[1]!.length >= open.length) {
                out.push({
                    start: open.start,
                    end: Math.min(lineEnd, text.length),
                    info: open.info,
                    body: body.join('\n'),
                });
                open = null;
            } else {
                body.push(open.quoted ? stripped : line);
            }
        }
        if (newline === -1) {
            break;
        }
        at = next;
    }
    if (open) {
        out.push({ start: open.start, end: text.length, info: open.info, body: body.join('\n') });
    }
    return out;
}

/**
 * Inline code spans in `text` between `from` and `to`: a run of backticks
 * up to the next run of the same length, never across a blank line. An
 * unmatched run is literal text.
 */
function inlineCode(text: string, from: number, to: number): Range[] {
    const out: Range[] = [];
    const part = text.slice(from, to);
    // Paragraphs, found once: a span never crosses a blank line.
    const paragraphs: Range[] = [];
    let start = 0;
    for (const blank of part.matchAll(/\n[ \t]*\n/g)) {
        paragraphs.push([start, blank.index]);
        start = blank.index + blank[0].length;
    }
    paragraphs.push([start, part.length]);
    for (const [begin, finish] of paragraphs) {
        // Each backtick run once, and per length the runs in order: an
        // opening run closes at the next run of its length (linear).
        const runs: Array<{ at: number; length: number }> = [];
        for (const run of part.slice(begin, finish).matchAll(/`+/g)) {
            runs.push({ at: begin + run.index, length: run[0].length });
        }
        const byLength = new Map<number, number[]>();
        runs.forEach((run, index) => {
            const list = byLength.get(run.length);
            if (list) {
                list.push(index);
            } else {
                byLength.set(run.length, [index]);
            }
        });
        const next = new Map<number, number>();
        for (let index = 0; index < runs.length; index++) {
            const run = runs[index]!;
            const list = byLength.get(run.length)!;
            let pointer = next.get(run.length) ?? 0;
            while (pointer < list.length && list[pointer]! <= index) {
                pointer++;
            }
            next.set(run.length, pointer);
            if (pointer === list.length) {
                // Unmatched: literal text.
                continue;
            }
            const close = runs[list[pointer]!]!;
            out.push([from + run.at, from + close.at + close.length]);
            index = list[pointer]!;
        }
    }
    return out;
}

/** Every range of `text` that is code, in order and not overlapping. */
export function codeRanges(text: string): Range[] {
    const out: Range[] = [];
    let at = 0;
    for (const block of fencedBlocks(text)) {
        out.push(...inlineCode(text, at, block.start), [block.start, block.end]);
        at = block.end;
    }
    out.push(...inlineCode(text, at, text.length));
    return out;
}

/** How a rewrite sees the bundle: what was copied, and where it went. */
export interface RewriteContext {
    /** The source's origin, `https://host`. */
    origin: string;
    /** The source's label for people ("Acme"). */
    label: string;
    /** The source's issue key prefix ("CB"). */
    prefix: string;
    /**
     * Issue `number`'s number here when it is in the bundle: the same, or
     * the one it was renumbered to. Undefined when it wasn't copied.
     */
    issue(number: number): number | undefined;
    /** A copied page's place here; undefined when it wasn't copied. */
    page(spaceId: string, pageId: string): { spaceId: string; pageId: string } | undefined;
    /** A whole copied Space's id here; undefined when it wasn't copied whole. */
    space(spaceId: string): string | undefined;
}

export interface TextChange {
    before: string;
    after: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The regular expressions for one context, made once per import. */
function patterns(context: Pick<RewriteContext, 'origin' | 'prefix' | 'label'>) {
    const origin = escape(context.origin);
    const key = `${escape(context.prefix)}-(\\d{1,9})`;
    const path = `/(?:issues/${key}|spaces/([A-Za-z0-9_-]{1,200})(?:/pages/([A-Za-z0-9_-]{1,200}))?)`;
    // Absolute (the source's origin), or relative where a link or a word starts.
    const url = `(?:(${origin})|(?<![^\\s(<"'\\[]))(${path})(?![\\w-])`;
    const link = `\\[([^\\[\\]\\n]{0,1000})\\]\\(([^()\\s]{1,2048})\\)`;
    const mention = `(?<![\\w/#=?&.:-])${key}(?![\\w-])`;
    return {
        all: new RegExp(`${link}|${url}|${mention}`, 'gu'),
        url: new RegExp(`^${url}`),
        labelAfter: new RegExp(`^ \\(${escape(context.label)}\\)`),
    };
}

/**
 * Rewrites one piece of text for the target (see the file's comment).
 * Returns the new text and each change, for the dry run's samples.
 */
export function rewriteText(text: string, context: RewriteContext): { text: string; changes: TextChange[] } {
    const changes: TextChange[] = [];
    if (!text) {
        return { text, changes };
    }
    const re = patterns(context);
    const sourceUrl = (path: string) => `${context.origin}${path}`;
    /** A path (`/issues/CB-n` or `/spaces/...`) as it should read here. */
    const pathHere = (absolute: boolean, path: string, number?: string, spaceId?: string, pageId?: string) => {
        if (number) {
            const here = context.issue(Number(number));
            return here === undefined
                ? sourceUrl(path)
                : here === Number(number)
                  ? path
                  : `/issues/${context.prefix}-${here}`;
        }
        if (spaceId && pageId) {
            const target = context.page(spaceId, pageId);
            return target ? `/spaces/${target.spaceId}/pages/${target.pageId}` : sourceUrl(path);
        }
        if (spaceId) {
            const target = context.space(spaceId);
            return target ? `/spaces/${target}` : sourceUrl(path);
        }
        return absolute ? sourceUrl(path) : path;
    };
    const mentionHere = (number: string, inLink: boolean, rest: string) => {
        const key = `${context.prefix}-${number}`;
        const here = context.issue(Number(number));
        if (re.labelAfter.test(rest)) {
            // Already names the source's issue: left as it is.
            return key;
        }
        if (here !== undefined) {
            return `${context.prefix}-${here}`;
        }
        return inLink ? `${key} (${context.label})` : `[${key} (${context.label})](${sourceUrl(`/issues/${key}`)})`;
    };
    const segment = (piece: string, inLink: boolean): string =>
        piece.replace(re.all, (match: string, ...groups: unknown[]) => {
            const [linkText, dest, origin, path, number, spaceId, pageId, mentioned] = groups as (string | undefined)[];
            const offset = groups[8] as number;
            const whole = groups[9] as string;
            let after: string;
            if (dest !== undefined) {
                const destination = re.url.exec(dest);
                const newDest = destination
                    ? pathHere(!!destination[1], destination[2]!, destination[3], destination[4], destination[5]) +
                      dest.slice(destination[0].length)
                    : dest;
                after = `[${segment(linkText ?? '', true)}](${newDest})`;
            } else if (path !== undefined) {
                after = pathHere(!!origin, path, number, spaceId, pageId);
            } else {
                after = mentionHere(mentioned!, inLink, whole.slice(offset + match.length));
            }
            if (after !== match) {
                changes.push({ before: match, after });
            }
            return after;
        });
    let out = '';
    let at = 0;
    for (const [start, end] of codeRanges(text)) {
        out += segment(text.slice(at, start), false) + text.slice(start, end);
        at = end;
    }
    out += segment(text.slice(at), false);
    return { text: out, changes };
}

const EMBED_URL = /\/api\/media\/embeds\/([A-Za-z0-9_-]{1,200})\/content/g;

/**
 * The media embeds a page's Markdown names: its pictures (```` ```image ````
 * fences), its link cards' media (```` ```embed ```` fences), and embed
 * URLs written out. Each id once, in order.
 */
export function embedIdsIn(
    content: string,
    tokens: {
        image: (token: { lang?: string; text?: string }) => { id: string } | undefined;
        card: (token: { lang?: string; text?: string }) => { media?: Array<{ id?: string }> } | undefined;
    },
): string[] {
    const ids: string[] = [];
    for (const block of fencedBlocks(content)) {
        if (!block.info) {
            continue;
        }
        const token = { lang: block.info, text: block.body };
        const image = tokens.image(token);
        if (image) {
            ids.push(image.id);
            continue;
        }
        for (const item of tokens.card(token)?.media ?? []) {
            if (item.id) {
                ids.push(item.id);
            }
        }
    }
    for (const match of content.matchAll(EMBED_URL)) {
        ids.push(match[1]!);
    }
    return [...new Set(ids)];
}

/** One possibly sensitive detail found in text, for the dry run's review list. */
export interface SensitiveHit {
    kind: 'path' | 'portainer' | 'host' | 'address' | 'email' | 'term';
    match: string;
}

const SENSITIVE: ReadonlyArray<readonly [SensitiveHit['kind'], RegExp]> = [
    ['path', /(?:\/home|\/Users|\/root)\/[\w.@-]+(?:\/[\w.@-]+)*/g],
    [
        'portainer',
        /\b(?:portainer[^\n]{0,40}?\b(?:stack|endpoint|environment)|(?:stack|endpoint)\s*(?:id)?)\s*[#=:]?\s*\d{1,6}\b|\/api\/(?:endpoints|stacks)\/\d+|\bendpointId=\d+/gi,
    ],
    ['host', /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home\.arpa|corp|intranet)\b/gi],
    [
        'address',
        /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
    ],
    ['email', /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g],
];

/**
 * Operational details in `text` an operator may want to review before the
 * copy (absolute home paths, Portainer stack and endpoint ids, internal
 * host names and addresses, emails), plus any of `terms`, matched without
 * case. Nothing is redacted: this only lists them.
 */
export function sensitiveHits(text: string, terms: readonly string[] = []): SensitiveHit[] {
    const out: SensitiveHit[] = [];
    for (const [kind, pattern] of SENSITIVE) {
        for (const match of text.matchAll(pattern)) {
            out.push({ kind, match: match[0].slice(0, 200) });
        }
    }
    const lower = text.toLowerCase();
    for (const term of terms) {
        if (term && lower.includes(term.toLowerCase())) {
            out.push({ kind: 'term', match: term });
        }
    }
    return out;
}
