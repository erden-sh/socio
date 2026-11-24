import { capabilityKey, STOPWORDS, stem } from '@socio/foundation/issues/capability-key';
import { foldText } from '@socio/shared/pages/page-search';
import { pageText } from '@socio/shared/pages/page-text';
import { textSnippet } from '@socio/shared/pages/text-snippet';

/**
 * Matching board items for the Dots' board tools (CB-83): a query's words
 * against an item's title and description, scored in memory. The board is
 * a few hundred items, read whole for every search already, so it needs no
 * index of its own (the pages' FTS5 indexes are for Spaces of thousands of
 * long pages, and would need their shadow tables, triggers and checks).
 *
 * Text is folded as page search folds it (case and accents). A word matches
 * whole (its stem too: "digests" finds "digest"), at the start of a word
 * ("expo" finds "export"), or, from 3 characters, inside one ("port" finds
 * "export"). Scripts written without spaces (Chinese, Japanese, Korean)
 * have no word starts to go by, so a match inside their text counts as a
 * word start. A title match counts twice a description match.
 */

// The board list's excerpts and search box live in
// `@socio/foundation/issues/board-matches`.

/** Text a Dot's filing adds around what the person said: never matched. */
export const DOT_FILING_HEADINGS = [
    'Problem and impact',
    'Expected outcome',
    'Observed (as reported)',
    'Suspected cause (not confirmed)',
    'Proposal',
    'Workaround',
    'References',
] as const;
export const DOT_FILING_FOOTER =
    '_Filed by a socio with `file_improvement`. The socio and the person it acted for are recorded on this item._';
/** The footer filings carried before the rename: old bodies keep it. */
export const LEGACY_DOT_FILING_FOOTER =
    '_Filed by a Dot with `file_improvement`. The Dot and the person it acted for are recorded on this item._';
const BOILERPLATE = new Set([
    ...DOT_FILING_HEADINGS.map((heading) => `**${heading}**`),
    DOT_FILING_FOOTER,
    LEGACY_DOT_FILING_FOOTER,
]);

/** A description as matched and quoted: plain text, no filing headings. */
export function boardText(body: string) {
    return pageText(
        body
            .split('\n')
            .filter((line) => !BOILERPLATE.has(line.trim()))
            .join('\n'),
    );
}

/** One word of a query: as typed (folded), and its stems and synonyms. */
export interface Term {
    word: string;
    forms: string[];
}

const WORD = /[\p{L}\p{N}]+/gu;
const MAX_WORDS = 8;
const length = (text: string) => [...text].length;

/**
 * A query's words: folded, at most 8, stopwords out (unless that leaves
 * none), one-character words out when longer ones remain. Words in the
 * Latin alphabet also match by their capability-key stems.
 */
export function queryTerms(query: string): Term[] {
    const all = [...new Set(foldText(query.slice(0, 200)).match(WORD) ?? [])];
    let words = all.filter((word) => !STOPWORDS.has(word));
    if (!words.length) {
        words = all;
    }
    if (words.some((word) => length(word) > 1)) {
        words = words.filter((word) => length(word) > 1);
    }
    return words.slice(0, MAX_WORDS).map((word) => ({
        word,
        forms: [
            ...new Set([word, ...(/^[a-z0-9]+$/.test(word) ? capabilityKey(word).split(' ').filter(Boolean) : [])]),
        ],
    }));
}

const isWordChar = (text: string, at: number) => at >= 0 && at < text.length && /[\p{L}\p{N}]/u.test(text[at]!);
/** Before `at`: a whole code point, so a surrogate pair counts as one. */
const startsWord = (text: string, at: number) => {
    if (at === 0) {
        return true;
    }
    const before = [...text.slice(Math.max(0, at - 2), at)].at(-1) ?? '';
    return !/[\p{L}\p{N}]/u.test(before);
};
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * How well `form` occurs in folded `text`: 3 a whole word (or its stem),
 * 2 a word's start, 1 inside a word, 0 not at all.
 */
export function matchLevel(text: string, form: string): 0 | 1 | 2 | 3 {
    if (!form) {
        return 0;
    }
    const inside = UNSPACED.test(form) ? 2 : length(form) >= 3 ? 1 : 0;
    let best: 0 | 1 | 2 | 3 = 0;
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
        if (!startsWord(text, at)) {
            if (inside > best) {
                best = inside as 1 | 2;
            }
            continue;
        }
        let end = at + form.length;
        while (isWordChar(text, end)) {
            end++;
        }
        const whole = text.slice(at, end);
        if (whole === form || stem(whole) === form) {
            return 3;
        }
        best = 2;
    }
    return best;
}

const TITLE_WEIGHT = [0, 1, 2, 3] as const;
const BODY_WEIGHT = [0, 0.5, 1, 1.5] as const;

/** An item's title and description, folded once for matching. */
export interface MatchText {
    title: string;
    body: string;
}
export const matchText = (title: string, body: string): MatchText => ({
    title: foldText(title),
    body: foldText(boardText(body)),
});

export interface Score {
    /** 0 to 1: every word a whole word of the title is 1. */
    score: number;
    /** Words found at least at a word's start, in the title or description. */
    strong: number;
    /** Words found anywhere. */
    found: number;
}

export function scoreText(terms: readonly Term[], text: MatchText): Score {
    let total = 0;
    let strong = 0;
    let found = 0;
    for (const term of terms) {
        let title = 0;
        let body = 0;
        for (const form of term.forms) {
            title = Math.max(title, matchLevel(text.title, form));
            body = Math.max(body, matchLevel(text.body, form));
        }
        const best = Math.max(TITLE_WEIGHT[title], BODY_WEIGHT[body]);
        total += best;
        if (best) {
            found += 1;
        }
        if (title >= 2 || body >= 2) {
            strong += 1;
        }
    }
    return {
        score: terms.length ? total / (3 * terms.length) : 0,
        strong,
        found,
    };
}

/**
 * Of `terms`, the share found at a word's start or better: 0 for fewer
 * than two (one shared word says little about two items being the same).
 */
export function coverage(terms: readonly Term[], text: MatchText) {
    if (terms.length < 2) {
        return 0;
    }
    return scoreText(terms, text).strong / terms.length;
}

const EXCERPT = 160;

/**
 * About 160 characters of the description: around the first match, or its
 * start when only the title matched. Plain text.
 */
export function excerptOf(body: string, terms: readonly Term[]) {
    const plain = boardText(body);
    if (!plain) {
        return '';
    }
    const forms = terms.flatMap((term) => term.forms);
    const folded = foldText(plain);
    if (forms.some((form) => matchLevel(folded, form))) {
        return textSnippet(plain, forms, EXCERPT)
            .map((part) => part.text)
            .join('');
    }
    const chars = [...plain];
    return chars.length > EXCERPT
        ? `${chars
              .slice(0, EXCERPT - 1)
              .join('')
              .trimEnd()}…`
        : plain;
}
