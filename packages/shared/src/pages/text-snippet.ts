/**
 * Search snippets from a page's own text (moved from
 * `src/server/pages/page-search.ts`, which re-exports `textSnippet` and
 * keeps `PageSearch.markdownSnippet`): pure, and the issues search builds
 * its snippets the same way.
 */
import type { SnippetPart } from './page-search.js';

/**
 * Text around the first place a word occurs, with every word that
 * contains one of them marked: the trigram hits' snippets (FTS5's own
 * count trigrams and cut words in half). Matching folds case and accents
 * as the index does; the text shown is the page's own.
 */
export function textSnippet(body: string, words: readonly string[], size = 160): SnippetPart[] {
    const chars = [...body];
    let folded = '';
    const at: number[] = [];
    // oxlint-disable-next-line no-control-regex
    if (/^[\u0000-\u007f]*$/.test(body)) {
        // ASCII: one character each, folded by lowercasing (most pages).
        folded = body.toLowerCase();
        for (let index = 0; index < chars.length; index++) {
            at.push(index);
        }
    } else {
        chars.forEach((ch, index) => {
            const fold =
                ch.charCodeAt(0) < 128 ? ch.toLowerCase() : ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
            folded += fold;
            for (let unit = 0; unit < fold.length; unit++) {
                at.push(index);
            }
        });
    }
    const ranges: Array<[number, number]> = [];
    const isWord = (index: number) => index >= 0 && index < chars.length && /[\p{L}\p{N}]/u.test(chars[index]!);
    for (const word of words.filter(Boolean)) {
        for (let found = folded.indexOf(word); found >= 0; found = folded.indexOf(word, found + word.length)) {
            let start = at[found]!;
            let end = at[found + word.length - 1]! + 1;
            while (isWord(start - 1)) {
                start--;
            }
            while (isWord(end)) {
                end++;
            }
            ranges.push([start, end]);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const first = ranges[0]?.[0] ?? 0;
    let from = Math.max(0, first - Math.floor(size / 3));
    if (from > 0) {
        const space = chars.indexOf(' ', from);
        from = space >= 0 && space < first ? space + 1 : first;
    }
    let to = Math.min(chars.length, from + size);
    if (to < chars.length) {
        const space = chars.lastIndexOf(' ', to);
        if (space > first) {
            to = space;
        }
    }
    const parts: SnippetPart[] = [];
    const push = (text: string, match: boolean) => {
        if (!text) {
            return;
        }
        const last = parts.at(-1);
        if (last && last.match === match) {
            last.text += text;
        } else {
            parts.push({ text, match });
        }
    };
    if (from > 0) {
        push('…', false);
    }
    let cursor = from;
    for (const [start, end] of ranges) {
        if (end <= cursor || start >= to) {
            continue;
        }
        push(chars.slice(cursor, Math.max(cursor, start)).join(''), false);
        push(chars.slice(Math.max(cursor, start), Math.min(end, to)).join(''), true);
        cursor = Math.min(end, to);
    }
    push(chars.slice(cursor, to).join(''), false);
    if (to < chars.length) {
        push('…', false);
    }
    return parts;
}

/** A snippet as Markdown: the matched words bold. */
export function markdownSnippet(parts: readonly SnippetPart[]) {
    return parts.map((part) => (part.match ? `**${part.text}**` : part.text)).join('');
}
