import { foldText } from '../pages/page-search.js';

/** Results shown per group once something is typed. */
export const PALETTE_GROUP_LIMIT = 8;

/** What the ranking reads of a search entry: the web's palette commands, the app's search rows. */
export interface RankedEntry {
    label: string;
    /** Shown at the end of the row (a key, a socio's name); found like a keyword. */
    hint?: string;
    /** Extra words it is found by (a Space's name for its pages, a status). */
    keywords?: readonly string[];
    /** The group it is listed under; each is capped at `PALETTE_GROUP_LIMIT`. */
    group: string;
    /** Listed only once something is typed (pages, issues: too many to list). */
    searchOnly?: boolean;
}

/** Lower is better; undefined when the entry doesn't match. */
function score(entry: RankedEntry, query: string, words: string[]) {
    const label = foldText(entry.label);
    const extras = [entry.hint ?? '', ...(entry.keywords ?? [])].map(foldText);
    const haystack = [label, ...extras].join(' ');
    if (!words.every((word) => haystack.includes(word))) {
        return undefined;
    }
    // An exact key or name ("CB-12", a socio's name) first.
    if (label === query || extras.includes(query)) {
        return 0;
    }
    if (label.startsWith(query)) {
        return 1;
    }
    if (label.split(/[\s/·:-]+/).some((part) => part.startsWith(words[0]!))) {
        return 2;
    }
    if (label.includes(query)) {
        return 3;
    }
    return 4;
}

/**
 * The results for a query: with nothing typed, every entry that isn't
 * `searchOnly`, in order; otherwise the entries containing every word
 * (in the label, hint or keywords, ignoring case and accents), best
 * first, at most `PALETTE_GROUP_LIMIT` per group.
 */
export function searchCommands<T extends RankedEntry>(entries: readonly T[], query: string): T[] {
    const wanted = foldText(query);
    if (!wanted) {
        return entries.filter((entry) => !entry.searchOnly);
    }
    const words = wanted.split(' ');
    const perGroup = new Map<string, number>();
    return entries
        .map((entry, index) => ({ entry, index, score: score(entry, wanted, words) }))
        .filter((ranked) => ranked.score !== undefined)
        .sort((a, b) => a.score! - b.score! || a.index - b.index)
        .filter(({ entry }) => {
            const count = perGroup.get(entry.group) ?? 0;
            perGroup.set(entry.group, count + 1);
            return count < PALETTE_GROUP_LIMIT;
        })
        .map(({ entry }) => entry);
}
