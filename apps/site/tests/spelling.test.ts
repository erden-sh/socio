import { describe, expect, it } from 'vitest';

import { OG_CARDS } from '../src/build/og.ts';

import { builtPages, readBuilt, text } from './helpers.ts';

// The site is American English (en-US), in every page, its alt text, meta descriptions and form
// labels, llms.txt, llms-full.txt and the og cards. This fails on common British spellings.

const BRITISH: [RegExp, string][] = [
    [/\bcolour/i, 'color'],
    [/\bfavour/i, 'favor'],
    [/\bbehaviour/i, 'behavior'],
    [/\bhonour/i, 'honor'],
    [/\bneighbour/i, 'neighbor'],
    [/\blabour/i, 'labor'],
    [/\bflavour/i, 'flavor'],
    [/\bhumour/i, 'humor'],
    [/\bcentre/i, 'center'],
    [/\bmetre/i, 'meter'],
    [/\btheatre/i, 'theater'],
    [/\bcatalogue/i, 'catalog'],
    [/\blicence\b/i, 'license'],
    [/\bdefence/i, 'defense'],
    [/\boffence/i, 'offense'],
    [/\bpractise/i, 'practice'],
    [/\bprogramme/i, 'program'],
    [/\bgrey/i, 'gray'],
    [/\bcheque/i, 'check'],
    [/\bjudgement/i, 'judgment'],
    [/\bageing/i, 'aging'],
    [
        /\b(organis|recognis|realis|apologis|customis|prioritis|optimis|summaris|minimis|maximis|authoris|categoris|synchronis|standardis|personalis|finalis|utilis|initialis|emphasis(?:e|ing|ed))\w*/i,
        '-ize',
    ],
    [/\w+isation\b/i, '-ization'],
    [/\b(analys|paralys|catalys)(e|ed|es|ing)\b/i, '-yze'],
    [/\b(cancell|travell|labell|modell|signall|fuell|counsell|totall)(ed|ing|er)\b/i, 'one l'],
    [/\b(enrol|fulfil|instil)(s|ment)?\b/i, 'double l'],
    [/\bwhilst\b/i, 'while'],
    [/\bamongst\b/i, 'among'],
    [/\b(learnt|spelt|dreamt|burnt|spoilt)\b/i, '-ed'],
    [/\btowards\b/i, 'toward'],
    [/\bfortnight/i, 'two weeks'],
    [/\bpost ?code/i, 'ZIP code'],
    [/\bmobile phone/i, 'cell phone or phone'],
    [
        /\b\d{1,2}(st|nd|rd|th)? (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/,
        'Month D, YYYY',
    ],
];

/** Text plus what a page says outside its text: alt, title, aria-label, placeholder, and meta content. */
const attributes = (html: string) =>
    [...html.matchAll(/\s(?:alt|title|aria-label|placeholder|content)="([^"]*)"/g)].map((match) => match[1]).join(' ');

describe('American English', () => {
    const sources: [string, string][] = [
        ...builtPages().flatMap(([key, html]): [string, string][] => [
            [`${key} text`, text(html)],
            [`${key} attributes`, attributes(html)],
        ]),
        ['llms.txt', readBuilt('llms.txt')],
        ['llms-full.txt', readBuilt('llms-full.txt')],
        [
            'og cards',
            Object.values(OG_CARDS)
                .map((card) => `${card.kicker} ${card.title}`)
                .join(' '),
        ],
    ];

    it('uses no common British spelling anywhere on the site', () => {
        const found: string[] = [];
        for (const [name, content] of sources) {
            for (const [pattern, american] of BRITISH) {
                const match = pattern.exec(content);
                if (match) {
                    found.push(`${name}: "${match[0]}" (use ${american})`);
                }
            }
        }
        expect(found).toEqual([]);
    });

    it('catches what it is meant to catch', () => {
        const caught = (sample: string) => BRITISH.some(([pattern]) => pattern.test(sample));
        for (const sample of [
            'its own colour',
            'organise',
            'the licence',
            'cancelled',
            'whilst',
            'learnt',
            '16 November 2026',
            'analysed',
        ]) {
            expect(caught(sample), sample).toBe(true);
        }
        for (const sample of [
            'its own color',
            'organize',
            'the license',
            'canceled',
            'while',
            'learned',
            'November 16, 2026',
            'analyzed',
        ]) {
            expect(caught(sample), sample).toBe(false);
        }
    });
});
