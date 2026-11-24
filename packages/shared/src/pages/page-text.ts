/**
 * A page's Markdown as plain text, for the search index.
 * Moved from
 * `src/server/pages/page-text.ts`, which re-exports it: pure, and read by
 * the issues search too. Regexes over lines, not a Markdown parser: a
 * 100,000-character page must not block the event loop.
 *
 * Kept: the words people wrote, link text, code (fenced and inline),
 * table cells and list items. Dropped: front matter, ```dataset-view
 * blocks (JSON specs), HTML tags and the contents of <script> and
 * <style>, image alt text, link and image targets, reference definitions
 * and Markdown markers. Control characters become spaces (the snippet
 * markers are control characters), and whitespace is collapsed.
 *
 * Changing what this keeps is a new `pages` migration that rebuilds the
 * index (`PAGE_TEXT_VERSION`), so old and new rows never mix.
 */
export const PAGE_TEXT_VERSION = 1;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
};
/** A link target: up to one level of parentheses inside (Wikipedia URLs). */
const TARGET = String.raw`\((?:[^()\n]|\([^()\n]*\))*\)`;
const IMAGE = new RegExp(String.raw`!\[[^\]\n]*\]` + TARGET, 'g');
const LINK = new RegExp(String.raw`\[([^\]\n]*)\]` + TARGET, 'g');

/**
 * Markdown markers as plain text has them: emphasis and code marks at the
 * edge of a word go (`**bold**.` is `bold.`), the same characters inside
 * one stay (`snake_case`, `a*b`); heading, quote and table marks and
 * escapes separate words like spaces do.
 */
export function plainMarks(text: string) {
    return text.replace(/(?<![\p{L}\p{N}])[*_~`]+|[*_~`]+(?![\p{L}\p{N}])/gu, '').replace(/[#>|\\]/g, ' ');
}

const codePoint = (value: number) => (value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' ');

function prose(text: string) {
    return plainMarks(
        text
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
            // Images (and their alt text) first, so a badge inside a link
            // leaves the link with its own text: [![badge](img)](url).
            .replace(IMAGE, ' ')
            .replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, ' ')
            .replace(LINK, '$1')
            // Reference links and their definitions.
            .replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, ' ')
            .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
            // Autolinks are targets; tags are markup.
            .replace(/<(?:https?|mailto|ftp):[^>\s]*>/gi, ' ')
            .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, ' ')
            .replace(/&(#?\w+);/g, (entity, name: string) =>
                name in ENTITIES ? ENTITIES[name]! : /^#\d+$/.test(name) ? codePoint(Number(name.slice(1))) : entity,
            )
            // Table separator rows, rules and setext underlines.
            .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
            .replace(/^\s*([-*_=])(?:\s*\1){2,}\s*$/gm, ' ')
            // List bullets, numbers and task boxes at the start of a line.
            .replace(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, ' '),
    );
}

/** Plain text of a page's Markdown, one line, for the search index. */
export function pageText(markdown: string): string {
    const source = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
    const out: string[] = [];
    let paragraph: string[] = [];
    let fence: { marker: string; skip: boolean } | null = null;
    const flush = () => {
        if (paragraph.length) {
            out.push(prose(paragraph.join('\n')));
        }
        paragraph = [];
    };
    for (const line of source.split(/\r?\n/)) {
        if (fence) {
            const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
            if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) {
                fence = null;
            } else if (!fence.skip) {
                out.push(plainMarks(line));
            }
            continue;
        }
        const open = line.match(FENCE);
        if (open) {
            flush();
            fence = {
                marker: open[1]!,
                skip: open[2]!.toLowerCase() === 'dataset-view',
            };
            continue;
        }
        paragraph.push(line);
    }
    flush();
    return (
        out
            .join(' ')
            // oxlint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}
