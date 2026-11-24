import { areaLabel, KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import type { IssueStatus, IssueSummary } from '@socio/shared/issues/issue-types';

import { PRIORITY_TONE, STATUS_TONE } from '../shell/board';
import type { ToneName } from '../theme/theme';

// What a link in a socio's reply does when tapped. No React Native here:
// tests/chat runs it under Node.
// - Only http(s) and mailto open. An absolute link must say its scheme; a
//   relative one is a path on the workspace (`/issues/CB-12`), never `//host`
//   or a backslash trick. Anything else (javascript:, data:, file:, intent:,
//   tel:, the app's own scheme) does nothing.
// - A page of the workspace opens the app's own screen for it when a link in
//   text (`{ app: true }`) names a path the route table has (`appPathOf`,
//   CB-413: Spaces, pages, chats and rooms, schedules, approvals, memories),
//   as the web's AppLink opens it in the app. Otherwise it opens in the
//   browser (the in-app one on iOS) and, until the app can sign that
//   browser in, the app first says the person signs in there once.
// - A link to one of the workspace's issues (`/issues/CB-<n>`, no query or
//   hash, as the web's IssueLinkCard decides) opens the issue's own screen.
//   In running text it is a chip; a paragraph or list item that holds
//   issue links only is a stack of issue cards (`issueCardParts`, the web's
//   `issueLinksOnly`), drawn by screens/issue-card.tsx;
//   in a list that holds other items too, each card item keeps its bullet,
//   the cards indented under it (the web's `li`). A chip in a reply's running
//   text has its status beside it when the phone holds the issue
//   (`withIssueStatuses`, the web's "CB-3 [Ready]").
// - An issue's attachment (`/api/issue-attachments/<id>`) opens the
//   viewer, only as a root-relative path with no query or hash: issue text is
//   untrusted, so nothing else is read through the app's cookie.

export type LinkTarget =
    /** A page of the workspace's web app. */
    | { readonly kind: 'workspace'; readonly url: string }
    /** One of the workspace's issues (`CB-12`): its screen in the app. */
    | { readonly kind: 'issue'; readonly url: string; readonly key: string }
    /** An issue's attachment on the workspace: the viewer, through the image cache. */
    | { readonly kind: 'issue-attachment'; readonly url: string; readonly id: string }
    /** Another site's http(s) page, or a mailto. */
    | { readonly kind: 'external'; readonly url: string };

const ALLOWED = /^(?:https?:\/\/|mailto:|\/(?![/\\]))/i;

/** Where a tapped link goes, or null when it must not open. `origin`: the workspace's. */
export function linkTarget(href: string | null | undefined, origin: string): LinkTarget | null {
    const value = href?.trim() ?? '';
    // oxlint-disable-next-line no-control-regex -- a control character never belongs in a link
    if (!ALLOWED.test(value) || value.includes('\\') || /[\u0000-\u001f\u007f\s]/.test(value)) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value, origin);
    } catch {
        return null;
    }
    if (url.protocol === 'mailto:') {
        return /^mailto:/i.test(value) ? { kind: 'external', url: url.href } : null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    if (url.origin === origin) {
        const plain = url.search === '' && url.hash === '' && !/[?#]/.test(value);
        const issue = plain ? ISSUE_PATH.exec(url.pathname)?.[1] : undefined;
        if (issue !== undefined) {
            return { kind: 'issue', url: url.href, key: issue };
        }
        const file = ATTACHMENT_PATH.exec(value)?.[1];
        if (file !== undefined) {
            return { kind: 'issue-attachment', url: url.href, id: file };
        }
        return { kind: 'workspace', url: url.href };
    }
    return /^https?:\/\//i.test(value) ? { kind: 'external', url: url.href } : null;
}

const ISSUE_PATH = /^\/issues\/(CB-[1-9]\d{0,8})$/;

/** An old hash route (`/#/spaces/s1/pages/p1`), as the web still opens it: its path form. */
const LEGACY_HASH = /^#(\/spaces\/[^/?#]+(?:\/pages\/[^/?#]+)?)$/;

/**
 * The app path a workspace link may open in the app (CB-413, the web's
 * `openAppPath`): its path, without a fragment (`#message-9` names a turn, the
 * chat opens). Null for what only the browser shows: a query (filters the app
 * has no route params for), the API, the root. The route table decides the
 * rest (`openInApp`); a path no screen has opens in the browser.
 */
export function appPathOf(target: LinkTarget): string | null {
    if (target.kind !== 'workspace') {
        return null;
    }
    const url = new URL(target.url);
    if (url.pathname === '/' && url.search === '') {
        return LEGACY_HASH.exec(url.hash)?.[1] ?? null;
    }
    if (url.search !== '' || url.pathname === '/' || /^\/api(?:\/|$)/.test(url.pathname)) {
        return null;
    }
    return url.pathname.replace(/\/+$/, '');
}
/** Root-relative only, the whole link: no host, query, hash or dot segment. */
const ATTACHMENT_PATH = /^\/api\/issue-attachments\/([A-Za-z0-9_-]{1,64})$/;

/** The issue key (`CB-12`) a link names on this workspace, or null. */
export function issueKeyOf(href: string | null | undefined, origin: string): string | null {
    const target = linkTarget(href, origin);
    return target?.kind === 'issue' ? target.key : null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The URL pattern of issue links, as enriched-markdown's `linkVariants` takes
 * it (matched natively against the link as written; no lookbehind, which iOS lacks).
 */
export function issueLinkPattern(origin: string): string {
    return `^(?:${escapeRegExp(origin)})?/issues/CB-[1-9][0-9]{0,8}$`;
}

// ---- Issue cards ---------------------------------------------------------

/** A link to one of the workspace's issues that stands alone, drawn as its card. */
export interface IssueCardLink {
    /** `CB-12`. */
    readonly key: string;
    /** 12: the issues kind's row (`sync/issues.ts`, keyed by the number). */
    readonly number: number;
    /** The link as written, a chip when the phone doesn't hold the issue. */
    readonly source: string;
    /**
     * In a list that also holds other items (the web keeps its bullets there):
     * the item's marker ("•", "2.") and which item, so its cards sit indented
     * under one marker. A list of issue links only has none, as on the web.
     */
    readonly bullet?: { readonly marker: string; readonly item: number };
}

/** Reply Markdown cut where issue links stand alone: Markdown, then a stack of cards, then Markdown… */
export type IssueCardPart =
    | { readonly kind: 'markdown'; readonly key: string; readonly text: string }
    | { readonly kind: 'issues'; readonly key: string; readonly links: readonly IssueCardLink[] };

/** `[label](href)` or `<href>`: the links a line of issue links is made of. */
const LINK = /\[([^[\]\n]*)\]\(\s*([^\s()]+)\s*\)|<([^\s<>]+)>/g;
/**
 * What may sit between and after the links of a run of them (the web's
 * SEPARATORS, CB-118): "CB-1, CB-2 and CB-3.", a "↗", emphasis marks. A letter
 * or digit makes it running text.
 */
const SEPARATORS = /^(?:[^\p{L}\p{N}]|\band\b|\bor\b)*$/iu;
const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)]) +(.*)$/;
const FENCE_LINE = /^(?: {0,3}(?:[-+*]|\d{1,9}[.)]) +)* {0,3}(`{3,}|~{3,})/;
/** A line a paragraph can't hold: a heading, a quote, a table, HTML, a rule or a setext underline. */
const BLOCK_START = /^ {0,3}(?:#|>|\||\\?<|(?:[-*_=] *){3,}$|=+ *$|-+ *$)/;

/** The issue links `text` is made of, or null when it holds anything else (words, other links, nothing). */
export function issueLinksOnly(text: string, origin: string): IssueCardLink[] | null {
    const links: IssueCardLink[] = [];
    let at = 0;
    for (const match of text.matchAll(LINK)) {
        if (!SEPARATORS.test(text.slice(at, match.index))) {
            return null;
        }
        const target = linkTarget(match[2] ?? match[3], origin);
        if (target?.kind !== 'issue') {
            return null;
        }
        links.push({ key: target.key, number: Number(target.key.slice(3)), source: match[0] });
        at = match.index + match[0].length;
    }
    return links.length > 0 && SEPARATORS.test(text.slice(at)) ? links : null;
}

/** Columns of leading whitespace, a tab to the next multiple of 4. */
function indentOf(line: string): number {
    let column = 0;
    for (const character of line) {
        if (character === ' ') {
            column++;
        } else if (character === '\t') {
            column += 4 - (column % 4);
        } else {
            break;
        }
    }
    return column;
}

/** One item of a list chunk: its marker as written, and its issue links when it is cards only. */
interface ListItem {
    readonly sign: string;
    readonly links: IssueCardLink[] | null;
}

/** A list as a whole, a loose list's chunks between blank lines included. */
interface ListInfo {
    /** Its marker without the number (`-`, `.`, `)`): items with another one start another list. */
    readonly delimiter: string;
    /** It is numbered: each item's number is the first item's plus its place (the web's `ol`). */
    readonly ordered: boolean;
    readonly start: number;
    /** An item of it isn't cards: the web keeps its bullets, beside the cards too. */
    mixed: boolean;
    /** Cards were drawn from it already (as the parts are made): a Markdown item after them says its number. */
    carded: boolean;
}

/**
 * The reply's lines between code and blank lines: a list chunk's items (every
 * line a list item, not indented as code) with the list it belongs to and its
 * first item's place there, or other lines.
 */
type Chunk =
    | {
          readonly kind: 'list';
          readonly lines: readonly string[];
          readonly items: readonly ListItem[];
          readonly list: ListInfo;
          readonly offset: number;
      }
    | { readonly kind: 'other'; readonly lines: readonly string[] };

const delimiterOf = (sign: string) => sign.replace(/\d+/, '');

/**
 * Each line of a chunk: its issue links when it stands as cards, else the line
 * as Markdown. A paragraph of issue links only is cards. In a list, an item of
 * issue links only is cards; when the list is mixed each keeps its marker, an
 * ordered list's counted from its start by place, and a Markdown item after
 * cards says its number, since it starts a list of its own (CommonMark reads
 * only the first number).
 */
function chunkLines(chunk: Chunk, origin: string, itemIds: { next: number }): (IssueCardLink[] | string)[] {
    if (chunk.kind === 'other') {
        const lines = [...chunk.lines];
        if (indentOf(lines[0]!) >= 4 || lines.some((line) => LIST_ITEM.test(line) || BLOCK_START.test(line))) {
            return lines; // Indented code, a list item's continuation, a heading, quote or table.
        }
        const links = issueLinksOnly(lines.join(' '), origin);
        return links === null ? lines : lines.map((_, index) => (index === 0 ? links : []));
    }
    const { list } = chunk;
    return chunk.items.map((item, index) => {
        const number = list.start + chunk.offset + index;
        if (item.links === null) {
            const line = chunk.lines[index]!;
            return list.ordered && list.carded ? line.replace(/\d{1,9}(?=[.)])/, String(number)) : line;
        }
        if (!list.mixed) {
            return item.links;
        }
        list.carded = true;
        const marker = list.ordered ? `${number}${list.delimiter}` : /\d/.test(item.sign) ? item.sign : '•';
        const bullet = { marker, item: itemIds.next++ };
        return item.links.map((link) => ({ ...link, bullet }));
    });
}

/**
 * A reply's Markdown (markdown.ts's safe text) cut into Markdown and stacks of
 * issue cards, as the web's ChatMarkdown shows them (CB-87, CB-104): a
 * paragraph, or a list item, that holds links to the workspace's issues only
 * (with separators) is a card per link; a link in running text stays a chip.
 * Code is never read: a fence, and an indented chunk, stay Markdown. Cards
 * only part a list where they stand; an ordered list's cards and later items
 * are numbered from its start and their place, as the web's `ol` counts
 * (CommonMark starts a list at its first number). A loose list (blank lines
 * between its items) is read whole, for its bullets and its numbers. Pure.
 */
export function issueCardParts(markdown: string, origin: string): IssueCardPart[] {
    // First the reply's lines as text (blank, code) and chunks, each list chunk tied to its whole list.
    const read: (string | Chunk)[] = [];
    let lines: string[] = [];
    /** The list the next list chunk may go on with: only blank lines since its last chunk. */
    let open: { list: ListInfo; next: number } | null = null;
    const flushLines = () => {
        if (lines.length === 0) {
            return;
        }
        const matches = lines.map((line) => LIST_ITEM.exec(line));
        if (indentOf(lines[0]!) < 4 && matches.every((match) => match !== null)) {
            const all = matches.map((match) => ({ sign: match![1]!, links: issueLinksOnly(match![2]!, origin) }));
            // A change of marker (`-` to `*`, `.` to `)`) starts another list, blank line or not (CommonMark 5.3).
            let from = 0;
            for (let at = 1; at <= all.length; at++) {
                if (at < all.length && delimiterOf(all[at]!.sign) === delimiterOf(all[from]!.sign)) {
                    continue;
                }
                const items = all.slice(from, at);
                const delimiter = delimiterOf(items[0]!.sign);
                const ordered = /\d/.test(items[0]!.sign);
                if (from > 0 || open === null || open.list.delimiter !== delimiter || open.list.ordered !== ordered) {
                    const start = ordered ? Number.parseInt(items[0]!.sign, 10) : 0;
                    open = { list: { delimiter, ordered, start, mixed: false, carded: false }, next: 0 };
                }
                open.list.mixed ||= items.some((item) => item.links === null);
                read.push({ kind: 'list', lines: lines.slice(from, at), items, list: open.list, offset: open.next });
                open.next += items.length;
                from = at;
            }
        } else {
            open = null;
            read.push({ kind: 'other', lines });
        }
        lines = [];
    };
    let fence: { readonly char: string; readonly length: number } | null = null;
    for (const line of markdown.split('\n')) {
        if (fence !== null) {
            read.push(line);
            const run = /^\s*(`+|~+)\s*$/.exec(line)?.[1];
            if (run !== undefined && run[0] === fence.char && run.length >= fence.length) {
                fence = null;
            }
            continue;
        }
        const opened = FENCE_LINE.exec(line)?.[1];
        if (opened !== undefined) {
            flushLines();
            open = null;
            read.push(line);
            fence = { char: opened[0]!, length: opened.length };
            continue;
        }
        if (line.trim() === '') {
            flushLines();
            read.push(line);
            continue;
        }
        lines.push(line);
    }
    flushLines();

    // Then the parts, once each list knows whether it is mixed.
    const parts: IssueCardPart[] = [];
    let text: string[] = [];
    let links: IssueCardLink[] = [];
    const flushText = () => {
        if (text.some((line) => line.trim() !== '')) {
            flushLinks();
            parts.push({ kind: 'markdown', key: `m${parts.length}`, text: text.join('\n') });
        }
        text = [];
    };
    const flushLinks = () => {
        if (links.length > 0) {
            parts.push({ kind: 'issues', key: `i${parts.length}`, links });
        }
        links = [];
    };
    const itemIds = { next: 0 };
    for (const entry of read) {
        if (typeof entry === 'string') {
            text.push(entry);
            continue;
        }
        for (const found of chunkLines(entry, origin, itemIds)) {
            if (typeof found === 'string') {
                text.push(found);
            } else {
                // Blank lines between cards keep one stack, as the web's stacks sit together.
                if (text.some((line) => line.trim() !== '')) {
                    flushText();
                }
                text = [];
                links.push(...found);
            }
        }
    }
    flushText();
    flushLinks();
    return parts;
}

/** A stack's links, grouped by the list item each stands in (`bullet`); links outside a list together. */
export function issueCardGroups(
    links: readonly IssueCardLink[],
): { readonly key: string; readonly marker: string | null; readonly links: IssueCardLink[] }[] {
    const groups: { key: string; marker: string | null; links: IssueCardLink[] }[] = [];
    for (const link of links) {
        const key = link.bullet === undefined ? `p${groups.length}` : `b${link.bullet.item}`;
        const last = groups.at(-1);
        if (last !== undefined && (last.key === key || (link.bullet === undefined && last.marker === null))) {
            last.links.push(link);
        } else {
            groups.push({ key, marker: link.bullet?.marker ?? null, links: [link] });
        }
    }
    return groups;
}

// ---- Status chips beside inline issue links (the web's IssueLinkCard, not alone) ----

/**
 * The scheme of a status chip's link, `socio-status:<status>/CB-<n>`: drawn as a
 * pill in its status's tone, it opens its issue, as the web's badge sits inside
 * the issue's link (CB-414).
 */
export const STATUS_LINK = 'socio-status:';

/** A status chip's link for issue `key`. */
export const statusLinkOf = (status: IssueStatus, key: string) => `${STATUS_LINK}${status}/${key}`;

/** The URL pattern of one status's chip, as enriched-markdown's `linkVariants` takes it. */
export const statusLinkPattern = (status: IssueStatus) => `^${STATUS_LINK}${status}/CB-[1-9][0-9]{0,8}$`;

/**
 * What a tapped link opens: a status chip's is its issue's path (`/issues/CB-3`), any other link
 * as it is. A malformed status link opens nothing (null).
 */
export function tappedLink(url: string): string | null {
    if (!url.startsWith(STATUS_LINK)) {
        return url;
    }
    const key = /^socio-status:[a-z_]+\/(CB-[1-9]\d{0,8})$/.exec(url)?.[1];
    return key === undefined ? null : `/issues/${key}`;
}

/** Whether `markdown` may hold a link (`[a](b)`, `<https://…>`, a bare http(s) URL or www.): its words aren't one accessible element. */
export const holdsLink = (markdown: string) =>
    /\[[^\]\n]*\]\(|<(?:https?:|mailto:)|\bhttps?:\/\/|\bwww\./i.test(markdown);

/** Whether `markdown` holds a link to one of the workspace's issues (its chips may take statuses). */
export function hasIssueLink(markdown: string, origin: string): boolean {
    for (const match of markdown.matchAll(LINK)) {
        if (linkTarget(match[2] ?? match[3], origin)?.kind === 'issue') {
            return true;
        }
    }
    return false;
}

/**
 * Reply Markdown with each issue link in running text followed by its status,
 * as the web's chip shows "CB-3 [Ready]": a link to `socio-status:<status>/CB-3`,
 * which the reply's style draws as a pill in the status's tone and which opens
 * the issue (`tappedLink`), as the web's badge is part of its link. Only issues the
 * phone holds (`statusOf`). Code is never touched (`proseSegments`): fenced
 * blocks (in quotes and list items too), indented code and code spans of any
 * length. Pure.
 */
export function withIssueStatuses(
    markdown: string,
    origin: string,
    statusOf: (number: number) => IssueStatus | undefined,
): string {
    return proseSegments(markdown)
        .map((segment) =>
            segment.code
                ? segment.text
                : segment.text.replace(LINK, (link: string, _label?: string, href?: string, bare?: string) => {
                      const target = linkTarget(href ?? bare, origin);
                      const status = target?.kind === 'issue' ? statusOf(Number(target.key.slice(3))) : undefined;
                      return status === undefined || target?.kind !== 'issue'
                          ? link
                          : `${link} [${STATUS_LABEL[status]}](${statusLinkOf(status, target.key)})`;
                  }),
        )
        .join('');
}

/** A piece of Markdown, in order: code (left as written) or prose (links may be read). */
interface Segment {
    readonly code: boolean;
    readonly text: string;
}

/** Blockquote markers before a line's content (`> > `), which code inside a quote sits behind. */
const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)*/;
/** A fence's opening, after any quote markers and list markers, at any indent. */
const FENCE_OPEN = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/;

/**
 * `markdown` cut into code and prose, erring towards code: a fenced block from
 * its opening line to its closing one (or the end), behind quote and list
 * markers too; every line indented 4 or more columns past its quote markers
 * (indented code; a deeply nested list item is skipped with it); and code spans
 * in each paragraph, which may cross its lines. Joined, the segments are
 * `markdown` again.
 */
export function proseSegments(markdown: string): Segment[] {
    const segments: Segment[] = [];
    const lines = markdown.split('\n');
    let paragraph: string[] = [];
    const flushParagraph = () => {
        if (paragraph.length > 0) {
            segments.push(...codeSpans(paragraph.join('')));
            paragraph = [];
        }
    };
    let fence: { readonly char: string; readonly length: number } | null = null;
    lines.forEach((line, index) => {
        const end = index < lines.length - 1 ? '\n' : '';
        const content = line.slice(QUOTE_PREFIX.exec(line)?.[0].length ?? 0);
        if (fence !== null) {
            const run = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(content)?.[1];
            if (run !== undefined && run[0] === fence.char && run.length >= fence.length) {
                fence = null;
            }
            segments.push({ code: true, text: line + end });
            return;
        }
        const opened = FENCE_OPEN.exec(content);
        // A backtick fence's info string has no backtick: "```a`" is a code span.
        if (opened !== null && !(opened[1]![0] === '`' && opened[2]!.includes('`'))) {
            flushParagraph();
            fence = { char: opened[1]![0]!, length: opened[1]!.length };
            segments.push({ code: true, text: line + end });
            return;
        }
        if (content.trim() !== '' && indentOf(content) >= 4) {
            flushParagraph();
            segments.push({ code: true, text: line + end });
            return;
        }
        if (content.trim() === '') {
            flushParagraph();
            segments.push({ code: false, text: line + end });
            return;
        }
        // Its newline stays with it: a code span may cross the paragraph's lines.
        paragraph.push(line + end);
    });
    flushParagraph();
    return segments;
}

/**
 * A paragraph cut at its code spans (CommonMark 6.1): a run of n backticks opens
 * one, closed by the next run of exactly n; with none, the run is plain text. A
 * backslash-escaped backtick opens nothing.
 */
function codeSpans(text: string): Segment[] {
    const segments: Segment[] = [];
    let prose = 0;
    let at = 0;
    while (at < text.length) {
        if (text[at] === '\\' && text[at + 1] === '`') {
            at += 2;
            continue;
        }
        if (text[at] !== '`') {
            at++;
            continue;
        }
        let length = 0;
        while (text[at + length] === '`') {
            length++;
        }
        let close = -1;
        for (let look = at + length; look < text.length;) {
            if (text[look] !== '`') {
                look++;
                continue;
            }
            let run = 0;
            while (text[look + run] === '`') {
                run++;
            }
            if (run === length) {
                close = look;
                break;
            }
            look += run;
        }
        if (close < 0) {
            at += length;
            continue;
        }
        if (at > prose) {
            segments.push({ code: false, text: text.slice(prose, at) });
        }
        segments.push({ code: true, text: text.slice(at, close + length) });
        at = close + length;
        prose = at;
    }
    if (prose < text.length) {
        segments.push({ code: false, text: text.slice(prose) });
    }
    return segments;
}

/** A pill on an issue card: its words, in a tone or (null) the neutral tag's look. */
export interface IssueCardPill {
    readonly label: string;
    readonly tone: ToneName | null;
}

/** What an issue's card shows (the web's IssueLinkCard): key, title, excerpt, then status, priority, kind and area. */
export interface IssueCardView {
    readonly key: string;
    readonly title: string;
    /** The description's first words ("Filed by Ben in Workspace A."), or null. */
    readonly excerpt: string | null;
    readonly pills: readonly IssueCardPill[];
    readonly accessibilityLabel: string;
}

/**
 * An issue's card from the phone's issues kind. The web's badges: the status in
 * its hue (won't fix neutral), the priority in its hue (low neutral), the kind
 * and area as neutral tags.
 */
export function issueCardView(issue: IssueSummary): IssueCardView {
    const key = `CB-${issue.number}`;
    const excerpt = issue.excerpt.trim();
    const pills: IssueCardPill[] = [
        { label: STATUS_LABEL[issue.status], tone: issue.status === 'wont_fix' ? null : STATUS_TONE[issue.status] },
        {
            label: PRIORITY_LABEL[issue.priority],
            tone: issue.priority === 'low' ? null : PRIORITY_TONE[issue.priority],
        },
        { label: KIND_LABEL[issue.kind], tone: null },
        ...(issue.area ? [{ label: areaLabel(issue.area), tone: null }] : []),
    ];
    const [status, priority, ...tags] = pills;
    return {
        key,
        title: issue.title,
        excerpt: excerpt === '' ? null : excerpt,
        pills,
        accessibilityLabel: [
            `${key}: ${issue.title}`,
            status!.label,
            `${priority!.label} priority`,
            ...tags.map((tag) => tag.label),
        ].join(', '),
    };
}

/** The scope's `kv` key set once the person has been told about signing in on the web. */
export const WEB_SIGN_IN_TOLD_KEY = 'web-sign-in-told';

export const OPENS_IN_BROWSER = 'Opens in your browser';
export const OPEN = 'Open';
export const CANCEL = 'Cancel';

/** What the app says before it first opens a page of the workspace in the browser. */
export function webSignInLine(workspace: string, ios: boolean): string {
    return ios
        ? `The first time, sign in to ${workspace} in the app’s browser. It stays signed in after that.`
        : `The first time, sign in to ${workspace} in your browser. It stays signed in after that.`;
}
