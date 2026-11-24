import {
    completeInlineChartFence,
    INLINE_CHART_LANGUAGE,
    INLINE_CHARTS_PER_MESSAGE,
    type InlineChartData,
    parseInlineChart,
} from '@socio/shared/inline-chart';

// A socio's reply as the native Markdown renderer gets it. No React Native
// here: tests/chat runs it under Node.
// - Nothing in a reply may make the phone fetch. The renderer (enriched-
//   markdown) loads images and `<video>` blocks by itself, so before it sees
//   the text every image becomes a link (`![alt](src)` → `[alt](src)`; an
//   empty alt reads "Image"), which opens only on a tap and by the link rules
//   (markdown-links.ts). Where the text is code, or might be, the `!` and `[`
//   are kept apart by a word joiner instead, so whichever way the renderer
//   reads that line, it holds no image. A line that starts an HTML block gets
//   its `<` escaped, so the block shows as text, as the web shows raw HTML.
// - `socio-chart` fences become charts, as the web's ChatMarkdown does: a
//   complete top-level fence whose JSON `parseInlineChart` accepts, at most
//   three per reply; anything else stays code.

/** What an image with no alt text reads as once it is a link. */
export const IMAGE_LABEL = 'Image';

/** U+2060: invisible, and keeps `!` from meeting `[` (an image) or `<` from meeting `video`. */
const JOINER = '⁠';

export type ReplyPart =
    | { readonly kind: 'markdown'; readonly key: string; readonly text: string }
    | { readonly kind: 'chart'; readonly key: string; readonly chart: InlineChartData };

interface Fence {
    readonly char: '`' | '~';
    readonly length: number;
    /** How many `>` the opening line sat in. */
    readonly depth: number;
    /** The column its marker started at, after the `>`s. */
    readonly indent: number;
}

/** The `>` markers a line starts with, and the rest. */
function quotes(line: string): { depth: number; rest: string } {
    let depth = 0;
    let rest = line;
    for (let match = /^ {0,3}> ?/.exec(rest); match; match = /^ {0,3}> ?/.exec(rest)) {
        depth++;
        rest = rest.slice(match[0].length);
    }
    return { depth, rest };
}

const FENCE_OPEN = /^((?: {0,3}(?:[-+*]|(\d{1,9})[.)]) +)*) {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: |$)/;

/** The fence a line opens, or null. `afterText`: the line before it is a paragraph's. */
function opens(line: string, afterText: boolean): Fence | null {
    const { depth, rest } = quotes(line);
    const match = FENCE_OPEN.exec(rest);
    if (!match) {
        return null;
    }
    const [, markers = '', number, run = '', info = ''] = match;
    // An ordered list item that doesn't start at 1 can't interrupt a paragraph:
    // there the line is the paragraph's text, and so is what follows.
    if (number !== undefined && Number(number) !== 1 && afterText) {
        return null;
    }
    const char = run[0] === '`' ? '`' : '~';
    if (char === '`' && info.includes('`')) {
        return null;
    }
    return { char, length: run.length, depth, indent: rest.indexOf(run, markers.length) };
}

/** Columns of leading whitespace, a tab to the next multiple of 4. */
function indentOf(text: string): number {
    let column = 0;
    for (const character of text) {
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

/**
 * What a line inside `fence` is: `code`, the fence's `close`, or `after` (the
 * fence ended before it, with its container). Errs toward ending the fence:
 * text read as prose that was code only loses its look, while text read as
 * code that was prose would keep its images.
 */
function inside(fence: Fence, line: string): 'code' | 'close' | 'after' {
    const { depth, rest } = quotes(line);
    if (depth < fence.depth || (rest.trim() !== '' && indentOf(rest) < fence.indent)) {
        return 'after';
    }
    const run = fence.char === '`' ? /^\s*(`+)\s*$/.exec(rest) : /^\s*(~+)\s*$/.exec(rest);
    return run && (run[1]?.length ?? 0) >= fence.length ? 'close' : 'code';
}

/** Code: no image and no `<video` whichever way it is read. */
function codeLine(line: string): string {
    return line.replaceAll('![', `!${JOINER}[`).replace(/<(video)/gi, `<${JOINER}$1`);
}

/** Whether the `!` at `index` is escaped (an odd run of backslashes before it). */
function escaped(line: string, index: number): boolean {
    let slashes = 0;
    for (let at = index - 1; at >= 0 && line[at] === '\\'; at--) {
        slashes++;
    }
    return slashes % 2 === 1;
}

/** Prose: images become links, code spans are kept as code. */
function proseLine(line: string): string {
    let out = '';
    let at = 0;
    while (at < line.length) {
        const character = line[at];
        if (character === '`') {
            let run = 1;
            while (line[at + run] === '`') {
                run++;
            }
            const close = closingRun(line, at + run, run);
            if (close === -1) {
                out += line.slice(at, at + run);
                at += run;
            } else {
                out += codeLine(line.slice(at, close + run));
                at = close + run;
            }
            continue;
        }
        if (character === '!' && line[at + 1] === '[' && !escaped(line, at)) {
            const empty = /^!\[\s*\]/.exec(line.slice(at));
            if (empty) {
                out += `[${IMAGE_LABEL}]`;
                at += empty[0].length;
            } else {
                out += '[';
                at += 2;
            }
            continue;
        }
        out += character;
        at++;
    }
    return htmlStartEscaped(out);
}

/** Where a run of exactly `length` backticks starts at or after `from`, or -1. */
function closingRun(line: string, from: number, length: number): number {
    for (let at = line.indexOf('`', from); at !== -1; at = line.indexOf('`', at)) {
        let run = 1;
        while (line[at + run] === '`') {
            run++;
        }
        if (run === length) {
            return at;
        }
        at += run;
    }
    return -1;
}

/**
 * A tag at the start of a line once its containers are read. Quote and list
 * markers nest in any order and a tab may follow them, so any run of their
 * characters and blanks counts: wider than CommonMark (`1.<b>` gets escaped
 * too, and still reads `<b>`), never narrower, and one character class keeps
 * the match linear.
 */
const HTML_START = /^([ \t>*+\-\d.)]*)<(?=[/!?]|[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;

/** A line that would start an HTML block shows it as text (an autolink, `<https://…>`, stays a link). */
function htmlStartEscaped(line: string): string {
    return line.replace(HTML_START, '$1\\<');
}

/** A top-level fence with a bare info string (```socio-chart, ```embed): a block a caller may draw. */
const BLOCK_OPEN = /^```([A-Za-z][\w-]*)[ \t]*$/;

/** A top-level block's fence, as a caller's `pick` gets it. */
export interface FencedBlock {
    /** The lines between the fences. */
    readonly body: string;
    /** The whole block, fences included. */
    readonly text: string;
}

/** Markdown the renderer may have, or a block a caller drew from its fence. */
export type MarkdownPart<T> =
    | { readonly kind: 'markdown'; readonly key: string; readonly text: string }
    | { readonly kind: 'block'; readonly key: string; readonly value: T };

/**
 * Text cut into Markdown the renderer may have (no image, no `<video>`) and
 * the blocks between: each top-level ```<lang> fence is offered to `pick`
 * (with its block, or null when it never closes), whose value replaces it; a
 * null keeps it as code. Line endings become `\n` (Markdown's `\r` and
 * `\r\n` too), so every line is read as the renderer reads it. A page's
 * blocks and a reply's charts both come through here.
 */
export function markdownParts<T>(source: string, pick: (lang: string, block: FencedBlock | null) => T | null) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const parts: MarkdownPart<T>[] = [];
    let text: string[] = [];
    const flush = () => {
        if (text.some((line) => line.trim() !== '')) {
            parts.push({ kind: 'markdown', key: `m${parts.length}`, text: text.join('\n') });
        }
        text = [];
    };
    let fence: Fence | null = null;
    let afterText = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (fence) {
            const where = inside(fence, line);
            if (where !== 'after') {
                text.push(codeLine(line));
                if (where === 'close') {
                    fence = null;
                    afterText = false;
                }
                continue;
            }
            fence = null;
        }
        const lang = BLOCK_OPEN.exec(line)?.[1];
        if (lang !== undefined) {
            const block = blockAt(lines, index);
            const value = pick(lang, block === null ? null : { body: block.body, text: block.text });
            if (block !== null && value !== null) {
                flush();
                parts.push({ kind: 'block', key: `b${parts.length}`, value });
                index = block.end;
                afterText = false;
                continue;
            }
        }
        const opened = opens(line, afterText);
        if (opened) {
            fence = opened;
            text.push(codeLine(line));
            continue;
        }
        text.push(proseLine(line));
        const { rest } = quotes(line);
        afterText = rest.trim() !== '' && !LIST_MARKER.test(rest);
    }
    flush();
    return parts;
}

/** A reply cut into Markdown the renderer may have, and the charts between (at most three). */
export function replyParts(source: string): ReplyPart[] {
    let charts = 0;
    return markdownParts(source, (lang, block) => {
        if (lang !== INLINE_CHART_LANGUAGE || charts >= INLINE_CHARTS_PER_MESSAGE) {
            return null;
        }
        charts++;
        return block !== null && completeInlineChartFence(block.text) ? (parseInlineChart(block.body) ?? null) : null;
    }).map((part) =>
        part.kind === 'markdown'
            ? part
            : { kind: 'chart' as const, key: part.key.replace('b', 'c'), chart: part.value },
    );
}

/** The top-level block a fence at `start` opens, and its closing line; null when it never closes. */
function blockAt(lines: readonly string[], start: number): { body: string; text: string; end: number } | null {
    const fence: Fence = { char: '`', length: 3, depth: 0, indent: 0 };
    for (let end = start + 1; end < lines.length; end++) {
        const where = inside(fence, lines[end] ?? '');
        if (where === 'after') {
            return null;
        }
        if (where === 'close') {
            return {
                body: lines.slice(start + 1, end).join('\n'),
                text: lines.slice(start, end + 1).join('\n'),
                end,
            };
        }
    }
    return null;
}

/** The reply as one Markdown text with no chart drawn (the charts' fences left as code). */
export function safeMarkdown(source: string): string {
    return replyParts(source)
        .map((part) => (part.kind === 'markdown' ? part.text : ''))
        .join('\n');
}
