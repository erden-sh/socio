/**
 * The board's test for a duplicate title (CB-83), which goals use too
 * (CB-135). Moved from `issues/filings.ts`, which re-exports
 * `similarTitles` and uses the word overlap for its duplicate check.
 */
import { capabilityKey } from './capability-key.js';

/**
 * A title's words for matching: the capability key's (stemmed, stopwords
 * out) plus, as they are, words in other scripts, which that key drops.
 */
export const titleWords = (text: string) =>
    new Set([
        ...capabilityKey(text).split(' ').filter(Boolean),
        ...(
            text
                .normalize('NFKC')
                .toLowerCase()
                .match(/[\p{L}\p{N}]+/gu) ?? []
        ).filter(
            (word) => /[^\p{ASCII}]/u.test(word) && !/^[a-z0-9]+$/.test(word.normalize('NFKD').replace(/\p{M}/gu, '')),
        ),
    ]);
/** Shared words over all words of the two: 1 for the same key, 0 for none. */
export function wordOverlap(a: Set<string>, b: Set<string>) {
    if (!a.size || !b.size) {
        return 0;
    }
    let shared = 0;
    for (const word of a) {
        if (b.has(word)) {
            shared += 1;
        }
    }
    return shared / (a.size + b.size - shared);
}
/** An open item whose title is this close is shown before filing. */
export const DUPLICATE_OVERLAP = 0.5;
/**
 * Whether two titles are the same once case and spacing are set aside, or
 * share most of their (stemmed) words: the board's test for a duplicate
 * title, which goals use too (CB-135).
 */
export function similarTitles(a: string, b: string) {
    const plain = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    return plain(a) === plain(b) || wordOverlap(titleWords(a), titleWords(b)) >= DUPLICATE_OVERLAP;
}
