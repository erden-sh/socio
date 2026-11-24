import { expect, it } from 'vitest';

import { rankByWords, terms } from '@socio/shared/text/rank-words';

// Ranking by shared words (CB-134): pinned facts, names and memories.

it('ranks facts by the request’s words, newer first on a tie', () => {
    const facts = [
        'Decision: the churn report goes out weekly',
        'Name: dataset ds_churn_q3_v1',
        'Result: Q2 revenue grew 4%',
        'Decision: use dataset ds_churn_q3_v2 for churn from now on',
    ];
    // Both dataset facts first (the shorter, more to the point, ahead), then
    // the one that only shares "churn".
    const ranked = rankByWords('Which dataset holds the churn data?', facts);
    expect(ranked.slice(0, 2).sort()).toEqual([1, 3]);
    expect(ranked.slice(2)).toEqual([0]);
    expect(rankByWords('ds_churn_q3_v1', facts)[0]).toBe(1);
    expect(rankByWords('the', facts)).toEqual([]);
});

it('reads ids and snake_case whole and in parts, without common words', () => {
    expect(terms('The ds_churn_q3_v1 dataset, at https://x.test/a.')).toEqual([
        'ds_churn_q3_v1',
        'ds',
        'churn',
        'q3',
        'v1',
        'dataset',
        'https://x.test/a',
        'https',
        'test',
    ]);
    expect(terms('a I to')).toEqual([]);
});

it('leaves out items with no word in common, and ranks nothing for an empty query', () => {
    expect(rankByWords('budget', ['the weather', 'next week'])).toEqual([]);
    expect(rankByWords('', ['budget'])).toEqual([]);
    expect(rankByWords('budget', [])).toEqual([]);
});
