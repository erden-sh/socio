/**
 * Fenced blocks in page Markdown, read from lines and regexes, not a
 * Markdown parser, so a long page doesn't block anyone. One reader for the
 * merge's units (`merge-lines.ts`) and a move's picture copies
 * (`src/server/pages/page-images.ts`). No dependency, nothing Hermes lacks.
 *
 * Detection fails closed. It doesn't model blockquotes and list items: it
 * is lenient in finding an opening fence and strict in accepting a closing
 * one. Anything doubtful is not a close, so a block only ever grows: a
 * misread can make a fence look longer than it is, never shorter.
 *
 * A line is read past its prefix: any leading mix of whitespace, `>`
 * markers and list markers (`-`, `+`, `*`, `N.`, `N)`). It opens a block
 * when what follows is a fence (three or more backticks or tildes; a
 * backtick fence's info string has no backticks) whose info string the
 * caller accepts. Columns count from the innermost blockquote: after the
 * last `>` and the one optional space after it (from the line's start when
 * there is no `>`). A tab counts 1 column in the opener and 4 in a close,
 * so its doubt goes one way. A line closes the block only if all of these
 * hold:
 * - its prefix has as many `>` markers as the opener's, and no list marker;
 * - it uses the opener's fence character, with a run at least as long,
 *   and only whitespace follows the run;
 * - when the opener's prefix has a list marker, or the opener is indented
 *   4 or more columns (so it can only be list content), its fence starts at
 *   exactly the opener's fence column;
 * - otherwise its indent is at least the opener's and at most 3. An opener
 *   indented 1 to 3 columns may sit on a list continuation line, where a
 *   less indented fence would end the item rather than close the block.
 * Unclosed, a block runs to the end of the text.
 */
const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/s;
const CLOSING = /^(`{3,}|~{3,})[ \t]*\r?\n?$/;

/**
 * The length of the prefix token at `at` (0 when there is none): a space
 * or tab, `>`, a `-`, `+` or `*` before a space or tab, or 1 to 9 digits
 * and `.` or `)` before one. A plain character loop, linear in the line
 * (page text is untrusted).
 */
function prefixToken(line: string, at: number): number {
    const blank = (code: number) => code === 0x20 || code === 0x09;
    const code = line.charCodeAt(at);
    if (blank(code) || code === 0x3e) {
        return 1;
    }
    if (code === 0x2d || code === 0x2b || code === 0x2a) {
        return blank(line.charCodeAt(at + 1)) ? 1 : 0;
    }
    let end = at;
    while (end - at < 10 && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) {
        end += 1;
    }
    const digits = end - at;
    const mark = line.charCodeAt(end);
    return digits >= 1 && digits <= 9 && (mark === 0x2e || mark === 0x29) && blank(line.charCodeAt(end + 1))
        ? digits + 1
        : 0;
}

/** A line read past its prefix (the rules above). */
export interface LinePrefix {
    /** How many `>` markers the prefix has. */
    quotes: number;
    /** Whether the prefix has a list marker. */
    marker: boolean;
    /** The column the content starts at, from the innermost blockquote. */
    column: number;
    /**
     * The column, from the innermost blockquote, of its first list marker,
     * or `column` when there is none after the last `>`.
     */
    lead: number;
    /** The line past its prefix, with its ending. */
    rest: string;
}

/** A line read past its prefix, a tab counting `tab` columns. */
export function linePrefix(line: string, tab: number): LinePrefix {
    let quotes = 0;
    let column = 0;
    let marker = false;
    let lead: number | undefined;
    let afterQuote = false;
    let at = 0;
    for (let length = prefixToken(line, at); length; length = prefixToken(line, at)) {
        const text = line.slice(at, at + length);
        if (text === '>') {
            quotes += 1;
            column = 0;
            lead = undefined;
            afterQuote = true;
        } else {
            if (text === '\t') {
                column += tab;
            } else if (!(text === ' ' && afterQuote)) {
                if (text !== ' ') {
                    lead ??= column;
                }
                column += text.length;
                marker ||= text !== ' ';
            }
            afterQuote = false;
        }
        at += text.length;
    }
    return { quotes, marker, column, lead: lead ?? column, rest: line.slice(at) };
}

/** An opening fence: the fence characters and where it sits. */
interface Opening {
    fence: string;
    info: string;
    quotes: number;
    column: number;
    /** Whether a close must start at exactly `column` (the opener has a list marker or is indented 4 or more). */
    exact: boolean;
}

/** The fence a line opens, when `accepts` takes its info string. */
function opening(line: string, accepts: (info: string) => boolean): Opening | undefined {
    const { quotes, marker, column, rest } = linePrefix(line, 1);
    const match = FENCE_LINE.exec(rest);
    if (!match) {
        return undefined;
    }
    const [, fence, raw] = match;
    // A backtick fence's info string has no backticks (CommonMark).
    if (fence[0] === '`' && raw.includes('`')) {
        return undefined;
    }
    const info = raw.trim();
    if (!accepts(info)) {
        return undefined;
    }
    return { fence, info, quotes, column, exact: marker || column >= 4 };
}

/** Whether a line surely closes `open` (the rules above). */
function closes(line: string, open: Opening) {
    const { quotes, marker, column, rest } = linePrefix(line, 4);
    if (marker || quotes !== open.quotes) {
        return false;
    }
    if (open.exact ? column !== open.column : column < open.column || column > 3) {
        return false;
    }
    const match = CLOSING.exec(rest);
    return !!match && match[1][0] === open.fence[0] && match[1].length >= open.fence.length;
}

/** The text's lines, each with its ending. Joined, they are the text again. */
export function textLines(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = text.indexOf('\n', start);
        if (end < 0) {
            out.push(text.slice(start));
            break;
        }
        out.push(text.slice(start, end + 1));
        start = end + 1;
    }
    return out;
}

/** A fenced block, by `textLines` index. */
export interface Fence {
    /** The opening line's index. */
    open: number;
    /** The closing line's index, or undefined when the block runs to the end of the text. */
    close: number | undefined;
    /** The opener's info string, trimmed. */
    info: string;
    /** The opener's fence characters. */
    fence: string;
    /** The opener's text before its fence: whitespace, `>` and list markers. */
    prefix: string;
    /** The opener read past its prefix (a tab counting 1 column). */
    at: LinePrefix;
    /** The lines between the opener and the close (or the end), each with its ending. */
    body: string[];
}

/**
 * The text's fenced blocks, in order, read by the rules above; with
 * `accepts`, only those whose info string it takes (any other fence line
 * is then an ordinary line). A block's lines are never read for more
 * blocks.
 */
export function findFences(text: string, accepts: (info: string) => boolean = () => true): Fence[] {
    const all = textLines(text);
    const out: Fence[] = [];
    for (let index = 0; index < all.length; index += 1) {
        const open = opening(all[index], accepts);
        if (!open) {
            continue;
        }
        let end = index + 1;
        while (end < all.length && !closes(all[end], open)) {
            end += 1;
        }
        const at = linePrefix(all[index], 1);
        out.push({
            open: index,
            close: end < all.length ? end : undefined,
            info: open.info,
            fence: open.fence,
            prefix: all[index].slice(0, all[index].length - at.rest.length),
            at,
            body: all.slice(index + 1, end),
        });
        index = end;
    }
    return out;
}
