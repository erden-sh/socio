// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { STOPWORDS, stem } from '@socio/foundation/issues/capability-key';

/** A chat still titled this (or empty) is "unnamed" for the suggestion. */
export const UNTITLED = new Set(['untitled', '', 'a new thought', 'quick question', 'new chat', 'new conversation']);

const WORD = /[\p{L}\p{N}]+/gu;

/** Folds and stems a phrase into its keyword set (stopwords out). */
export function keywordsOf(text: string): Set<string> {
    const words = [...new Set(text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(WORD) ?? [])];
    const kept = words
        .filter((word) => !STOPWORDS.has(word))
        .map(stem)
        .filter((word) => !STOPWORDS.has(word));
    return new Set(kept.length ? kept : words.map(stem));
}

/**
 * Top keywords of a message window by term frequency (stop-worded, stemmed),
 * with how many of the window's messages each appears in.
 */
export function recentKeywordCounts(texts: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const text of texts) {
        const seen = keywordsOf(text);
        for (const word of seen) {
            counts.set(word, (counts.get(word) ?? 0) + 1);
        }
    }
    return counts;
}

/**
 * Overlap ratio: what fraction of the name's keywords appear in the recent
 * window. <1 means the name is increasingly unrelated to the recent talk.
 */
export function nameOverlap(nameKeywords: Set<string>, recentTexts: readonly string[]): number {
    if (!nameKeywords.size) {
        return 0;
    }
    const recent = new Set<string>();
    for (const text of recentTexts) {
        for (const word of keywordsOf(text)) {
            recent.add(word);
        }
    }
    let hit = 0;
    for (const word of nameKeywords) {
        if (recent.has(word)) {
            hit += 1;
        }
    }
    return hit / nameKeywords.size;
}
