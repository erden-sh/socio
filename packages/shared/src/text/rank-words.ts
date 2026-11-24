/**
 * Ranking short texts by the words they share with a query (CB-134): BM25
 * over lowercased words, with ids and snake_case read whole and in parts.
 * Pinned facts, names and memories are ranked with it.
 */

/** Words too common to tell facts apart. */
const STOP = new Set(
    'a an and are as at be by did do does for from had has have how i in is it its me my of on or our so that the their them then there these this to was we were what when where which who why will with you your'.split(
        ' ',
    ),
);

/** A text's words for matching: lowercased, ids and snake_case whole and in parts. */
export function terms(text: string): string[] {
    const out: string[] = [];
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_./:-]*/gu) ?? []) {
        const whole = word.replace(/[./:-]+$/, '');
        if (whole.length >= 2 && !STOP.has(whole)) {
            out.push(whole);
        }
        const parts = whole.split(/[_./:-]+/);
        if (parts.length > 1) {
            for (const part of parts) {
                if (part.length >= 2 && !STOP.has(part)) {
                    out.push(part);
                }
            }
        }
    }
    return out;
}

/**
 * The items that share words with `query`, best first by BM25, the newer
 * (later) first on a tie. Items with no word in common are left out.
 */
export function rankByWords(query: string, items: readonly string[]): number[] {
    const wanted = [...new Set(terms(query))];
    if (!wanted.length || !items.length) {
        return [];
    }
    const docs = items.map((item) => terms(item));
    const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
    const frequency = new Map<string, number>();
    for (const doc of docs) {
        for (const term of new Set(doc)) {
            frequency.set(term, (frequency.get(term) ?? 0) + 1);
        }
    }
    const k1 = 1.2;
    const b = 0.75;
    return docs
        .map((doc, index) => {
            let score = 0;
            for (const term of wanted) {
                const count = doc.filter((word) => word === term).length;
                if (!count) {
                    continue;
                }
                const n = frequency.get(term) ?? 0;
                const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
                score += (idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * doc.length) / (average || 1)));
            }
            return { index, score };
        })
        .filter((hit) => hit.score > 0)
        .sort((x, y) => y.score - x.score || y.index - x.index)
        .map((hit) => hit.index);
}
