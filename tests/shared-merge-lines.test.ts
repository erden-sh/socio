import { describe, expect, it } from 'vitest';

import {
    lineChanges,
    MERGE_DIFF_MAX_EDITS,
    mergeLines,
    mergeTitle,
    mergeTitledText,
    mergeUnits,
} from '@socio/shared/pages/merge-lines';

// The three-way line merge pages (and issue edits) share.

// A small seeded generator, so a failure always replays.
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = ['alpha', 'beta', 'gamma', '', '# Heading', '- item', 'delta'];
const FENCE = '```embed\n{ "url": "https://example.com/a" }\n```\n';

function document(next: () => number) {
    const count = Math.floor(next() * 12);
    let text = '';
    for (let index = 0; index < count; index += 1) {
        text += next() < 0.1 ? FENCE : `${WORDS[Math.floor(next() * WORDS.length)]}${next() < 0.15 ? '\r\n' : '\n'}`;
    }
    return next() < 0.2 && !text.endsWith(FENCE) ? text.replace(/\r?\n$/, '') : text;
}

// An edit of a document: lines dropped, changed and added.
function edit(text: string, next: () => number) {
    const units = mergeUnits(text);
    const out: string[] = [];
    for (const unit of units) {
        const roll = next();
        if (roll < 0.15) {
            continue;
        }
        out.push(roll < 0.3 ? `${WORDS[Math.floor(next() * WORDS.length)]} edited\n` : unit);
        if (next() < 0.1) {
            out.push('added line\n');
        }
    }
    return out.join('');
}

const cases = Array.from({ length: 300 }, (_, seed) => {
    const next = random(seed + 1);
    const base = document(next);
    return { base, ours: edit(base, next), theirs: edit(base, next) };
});

describe('mergeLines, properties', () => {
    it('takes theirs when ours is the base, ours when theirs is, and either when both are alike', () => {
        for (const { base, ours, theirs } of cases) {
            expect(mergeLines(base, base, theirs)).toMatchObject({ clean: true, text: theirs });
            expect(mergeLines(base, ours, base)).toMatchObject({ clean: true, text: ours });
            expect(mergeLines(base, ours, ours)).toMatchObject({ clean: true, text: ours });
        }
    });

    it('is symmetric when clean, and an unclean result is ours untouched with a conflict hunk', () => {
        let unclean = 0;
        for (const { base, ours, theirs } of cases) {
            const one = mergeLines(base, ours, theirs);
            const other = mergeLines(base, theirs, ours);
            expect(one.clean).toBe(other.clean);
            if (one.clean) {
                expect(one.text).toBe(other.text);
                expect(one.hunks.every((hunk) => hunk.kind !== 'conflict')).toBe(true);
            } else {
                unclean += 1;
                expect(one.text).toBe(ours);
                expect(one.hunks.some((hunk) => hunk.kind === 'conflict')).toBe(true);
            }
        }
        expect(unclean).toBeGreaterThan(0);
    });

    it('keeps every change of a clean merge, from both sides', () => {
        for (const { base, ours, theirs } of cases) {
            const merged = mergeLines(base, ours, theirs);
            if (!merged.clean) {
                continue;
            }
            for (const hunk of merged.hunks) {
                const taken = hunk.kind === 'theirs' ? hunk.theirs : hunk.ours;
                expect(merged.text).toContain(taken);
            }
        }
    });

    it('never splits a fence: every fence in a merge is whole', () => {
        for (const { base, ours, theirs } of cases) {
            const { text } = mergeLines(base, ours, theirs);
            const fences = text.split(FENCE).join('');
            expect(fences).not.toContain('```');
        }
    });
});

describe('mergeLines, cases', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';

    it('merges changes to different lines', () => {
        const merged = mergeLines(base, 'ONE\ntwo\nthree\nfour\nfive\n', 'one\ntwo\nthree\nfour\nFIVE\nsix\n');
        expect(merged).toMatchObject({ clean: true, text: 'ONE\ntwo\nthree\nfour\nFIVE\nsix\n' });
        expect(merged.hunks.map((hunk) => hunk.kind)).toEqual(['ours', 'theirs']);
    });

    it('takes the same change on both sides once', () => {
        const same = 'one\nTWO\nthree\nfour\nfive\n';
        const merged = mergeLines(base, `${same}more\n`, same.replace('four', 'FOUR'));
        expect(merged).toMatchObject({ clean: true, text: 'one\nTWO\nthree\nFOUR\nfive\nmore\n' });
        expect(merged.hunks.map((hunk) => hunk.kind)).toEqual(['both', 'theirs', 'ours']);
    });

    it('refuses different changes to one line, and adjacent lines, and keeps ours', () => {
        const ours = 'one\nTWO\nthree\nfour\nfive\n';
        const conflict = mergeLines(base, ours, 'one\n2\nthree\nfour\nfive\n');
        expect(conflict.clean).toBe(false);
        expect(conflict.text).toBe(ours);
        expect(conflict.hunks).toEqual([{ kind: 'conflict', base: 'two\n', ours: 'TWO\n', theirs: '2\n' }]);
        expect(mergeLines(base, ours, 'one\ntwo\nTHREE\nfour\nfive\n').clean).toBe(false);
    });

    it('refuses two different insertions at one place', () => {
        expect(mergeLines(base, `${base}ours\n`, `${base}theirs\n`).clean).toBe(false);
    });

    it('keeps CRLF endings and a missing final newline as written', () => {
        const crlf = 'one\r\ntwo\r\nthree';
        const merged = mergeLines(crlf, 'ONE\r\ntwo\r\nthree', 'one\r\ntwo\r\nTHREE');
        expect(merged).toMatchObject({ clean: true, text: 'ONE\r\ntwo\r\nTHREE' });
        expect(mergeLines('a\nx\nb', 'A\nx\nb', 'a\nx\nb\nc').text).toBe('A\nx\nb\nc');
        expect(mergeLines('a\nx\nb\n', 'a\nx\nb', 'A\nx\nb\n')).toMatchObject({ clean: true, text: 'A\nx\nb' });
    });

    it('treats a dataset-view, embed or image fence as one unit, whichever edit touched it', () => {
        const view = '```dataset-view\n{\n  "dataset": "d1",\n  "query": "a"\n}\n```\n';
        const doc = `intro\n${view}middle\noutro\n`;
        expect(mergeUnits(doc)).toEqual(['intro\n', view, 'middle\n', 'outro\n']);
        // Two edits to different lines of one fence aren't stitched together.
        const ours = doc.replace('"d1"', '"d2"');
        const theirs = doc.replace('"a"', '"b"');
        const merged = mergeLines(doc, ours, theirs);
        expect(merged.clean).toBe(false);
        expect(merged.hunks).toEqual([
            { kind: 'conflict', base: view, ours: ours.slice(6, -13), theirs: theirs.slice(6, -13) },
        ]);
        // Beside an edit elsewhere, the fence moves whole.
        expect(mergeLines(doc, ours, doc.replace('outro', 'OUTRO')).text).toBe(ours.replace('outro', 'OUTRO'));
        const image = '~~~~image\n{"id":"x"}\n~~~\n~~~~\n';
        expect(mergeUnits(`${image}after`)).toEqual([image, 'after']);
        expect(mergeUnits('```embed\nopen to the end\n')).toEqual(['```embed\nopen to the end\n']);
    });

    // A dataset view whose dataset and query two edits change apart, with an unchanged line between them.
    const VIEW_LINES = [
        '```dataset-view',
        '{',
        '  "datasetId": "d1",',
        '  "display": "table",',
        '  "query": "a"',
        '}',
        '```',
    ];
    const competing = (doc: string) => [doc.replace('"d1"', '"d2"'), doc.replace('"a"', '"b"')] as const;
    const contained = (first: string, rest: string) =>
        VIEW_LINES.map((line, index) => `${index ? rest : first}${line}\n`).join('');

    it('refuses competing edits to one fence inside a blockquote', () => {
        const view = contained('> ', '> ');
        const doc = `> Sales\n>\n${view}after\n`;
        expect(mergeUnits(doc)).toEqual(['> Sales\n', '>\n', view, 'after\n']);
        const [ours, theirs] = competing(doc);
        const merged = mergeLines(doc, ours, theirs);
        expect(merged).toMatchObject({ clean: false, text: ours });
        expect(merged.hunks).toEqual([
            { kind: 'conflict', base: view, ours: competing(view)[0], theirs: competing(view)[1] },
        ]);
    });

    it('refuses competing edits to one fence inside a nested blockquote, however its markers are spaced', () => {
        for (const [first, rest] of [
            ['> > ', '> > '],
            ['>> ', '>>'],
            ['> > ', '>>   '],
        ]) {
            const view = contained(first, rest);
            const doc = `> outer\n${view}`;
            expect(mergeUnits(doc)).toEqual(['> outer\n', view]);
            const [ours, theirs] = competing(doc);
            expect(mergeLines(doc, ours, theirs)).toMatchObject({ clean: false, text: ours });
        }
    });

    it('refuses competing edits to one fence inside a list item', () => {
        const shapes = [
            ['- Sales\n', contained('  ', '  ')],
            ['', contained('- ', '  ')],
            ['10. Sales\n', contained('    ', '    ')],
            ['- outer\n  - inner\n', contained('    ', '    ')],
            ['- Sales\n', contained('  > ', '  > ')],
        ];
        for (const [item, view] of shapes) {
            const doc = `${item}${view}- next\n`;
            expect(mergeUnits(doc)).toContain(view);
            const [ours, theirs] = competing(doc);
            expect(mergeLines(doc, ours, theirs)).toMatchObject({ clean: false, text: ours });
        }
        // A blank line inside the item doesn't end the block.
        const spaced = contained('  ', '  ').replace('  }\n', '\n  }\n');
        expect(mergeUnits(`- Sales\n${spaced}`)).toEqual(['- Sales\n', spaced]);
    });

    it('merges an edit outside a contained fence beside one inside it', () => {
        const view = contained('> ', '> ');
        const doc = `> intro\n${view}>\n> outro\n`;
        const [ours] = competing(doc);
        const theirs = doc.replace('outro', 'OUTRO');
        expect(mergeLines(doc, ours, theirs)).toMatchObject({ clean: true, text: ours.replace('outro', 'OUTRO') });
        expect(mergeLines(doc, theirs, ours)).toMatchObject({ clean: true, text: ours.replace('outro', 'OUTRO') });
    });

    it('refuses competing edits to a fence opened on a list continuation line, under a blockquote', () => {
        // Sol's case: the opener has two spaces before `>`, the lines after it four.
        const view = contained('  > ', '    > ');
        const doc = `- item\n${view}- next\n`;
        expect(mergeUnits(doc)).toEqual(['- item\n', view, '- next\n']);
        const [ours, theirs] = competing(doc);
        const merged = mergeLines(doc, ours, theirs);
        expect(merged).toMatchObject({ clean: false, text: ours });
        expect(merged.hunks.map((hunk) => hunk.kind)).toEqual(['conflict']);
    });

    it('runs an unterminated contained fence to the end of the text, past its container', () => {
        expect(mergeUnits('> ```embed\n> {"url":"u"}\nafter\n')).toEqual(['> ```embed\n> {"url":"u"}\nafter\n']);
        expect(mergeUnits('- ```image\n  {"id":"x"}\n- next\n')).toEqual(['- ```image\n  {"id":"x"}\n- next\n']);
        expect(mergeUnits('> > ```image\n> > {"id":"x"}')).toEqual(['> > ```image\n> > {"id":"x"}']);
    });

    it('refuses competing edits around an indented fence-like line, which is content, not a close', () => {
        // Sol's case: four spaces past the opener, `~~~` is content and the block runs on.
        const doc = '~~~embed\nfirst\n    ~~~\nspacer\nlast\n~~~\n';
        expect(mergeUnits(doc)).toEqual([doc]);
        const merged = mergeLines(doc, doc.replace('first', 'FIRST'), doc.replace('last', 'LAST'));
        expect(merged).toMatchObject({ clean: false, text: doc.replace('first', 'FIRST') });
        expect(merged.hunks.map((hunk) => hunk.kind)).toEqual(['conflict']);
        // Sol's next case: five columns is content too, though the opener sits at two.
        const indented = '  ~~~embed\nfirst\n     ~~~\nspacer\nlast\n  ~~~\n';
        expect(mergeUnits(indented)).toEqual([indented]);
        const both = mergeLines(indented, indented.replace('first', 'FIRST'), indented.replace('last', 'LAST'));
        expect(both).toMatchObject({ clean: false, text: indented.replace('first', 'FIRST') });
        expect(both.hunks.map((hunk) => hunk.kind)).toEqual(['conflict']);
        // A close indented from the opener's column up to 3 closes.
        expect(mergeUnits('  ~~~embed\nfirst\n   ~~~\nafter\n')).toEqual(['  ~~~embed\nfirst\n   ~~~\n', 'after\n']);
    });

    it('takes no close less indented than an opener that may sit on a list continuation line', () => {
        // At column 0 the fence ends the item and opens another; it doesn't close this block.
        const doc = '- a\n  ```embed\n  y\n```\nz\n';
        expect(mergeUnits(doc)).toEqual(['- a\n', '  ```embed\n  y\n```\nz\n']);
        expect(mergeUnits('- a\n  ```embed\n  y\n  ```\nz\n')).toEqual(['- a\n', '  ```embed\n  y\n  ```\n', 'z\n']);
        // Indented 4 or more, or after a list marker, only the opener's exact column closes.
        expect(mergeUnits('    ```embed\n   ```\n     ```\n    ```\n')).toEqual([
            '    ```embed\n   ```\n     ```\n    ```\n',
        ]);
        expect(mergeUnits('- ```embed\n ```\n   ```\n  ```\nz\n')).toEqual([
            '- ```embed\n ```\n   ```\n  ```\n',
            'z\n',
        ]);
    });

    it('closes a contained fence only when it surely does: same character, a run as long, the same > count, no marker', () => {
        const longer = '> ````embed\n> ```\n> ~~~~\n> ````` \n';
        expect(mergeUnits(`${longer}> after\n`)).toEqual([longer, '> after\n']);
        // A different number of `>` markers isn't a close, so the block runs to the end.
        expect(mergeUnits('> ```embed\n> {}\n```\nafter\n')).toEqual(['> ```embed\n> {}\n```\nafter\n']);
        expect(mergeUnits('> > ```embed\n> ```\n> > ```\n')).toEqual(['> > ```embed\n> ```\n> > ```\n']);
        // Indented four past the item's content is code; the close comes after it.
        const item = '- ```embed\n      ```\n  ```\n';
        expect(mergeUnits(item)).toEqual([item]);
        // A line starting a new list item isn't a close.
        expect(mergeUnits('- ```embed\n- ```\n  ```\n')).toEqual(['- ```embed\n- ```\n  ```\n']);
        // Anything after the run isn't a close.
        expect(mergeUnits('> ```embed\n> ``` x\n> ```\n')).toEqual(['> ```embed\n> ``` x\n> ```\n']);
        // Tabs and CRLF are kept as written.
        const tabbed = '> ```embed\r\n>\t{}\r\n> ```\r\n';
        expect(mergeUnits(`${tabbed}after\r\n`)).toEqual([tabbed, 'after\r\n']);
        // A tab is doubtful in a close (4 columns), so this one isn't taken and the block runs on.
        const tabClose = '>\t```embed\n> {}\n>\t```\nafter\n';
        expect(mergeUnits(tabClose)).toEqual([tabClose]);
        // A backtick info string can't hold a backtick, so this isn't a fence.
        expect(mergeUnits('> ```embed `x`\n> {}\n')).toEqual(['> ```embed `x`\n', '> {}\n']);
    });

    it('splits any other fenced code by line', () => {
        expect(mergeUnits('```ts\nconst a = 1;\n```\n')).toEqual(['```ts\n', 'const a = 1;\n', '```\n']);
    });

    it('stays bounded on a large rewrite', () => {
        const big = Array.from({ length: MERGE_DIFF_MAX_EDITS * 2 }, (_, index) => `line ${index}\n`).join('');
        const other = Array.from({ length: MERGE_DIFF_MAX_EDITS * 2 }, (_, index) => `other ${index}\n`).join('');
        expect(mergeLines(big, other, big)).toMatchObject({ clean: true, text: other });
        expect(mergeLines(big, other, `${big}end\n`).clean).toBe(false);
        expect(lineChanges(big, other)).toEqual([
            { kind: 'removed', text: big },
            { kind: 'added', text: other },
        ]);
    });
});

describe('lineChanges', () => {
    it('lists what stayed, went and came, and rebuilds both texts', () => {
        expect(lineChanges('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
            { kind: 'same', text: 'a\n' },
            { kind: 'removed', text: 'b\n' },
            { kind: 'added', text: 'B\n' },
            { kind: 'same', text: 'c\n' },
            { kind: 'added', text: 'd\n' },
        ]);
        expect(lineChanges('', '')).toEqual([]);
        for (const { base, ours } of cases) {
            const changes = lineChanges(base, ours);
            const join = (kind: string) =>
                changes
                    .filter((change) => change.kind !== kind)
                    .map((change) => change.text)
                    .join('');
            expect(join('added')).toBe(base);
            expect(join('removed')).toBe(ours);
        }
    });

    it('finds a shortest line diff', () => {
        const changes = lineChanges('a\nb\nc\na\nb\nb\na\n', 'c\nb\na\nb\na\nc\n');
        const edits = changes.filter((change) => change.kind !== 'same');
        const count = edits.reduce((sum, change) => sum + mergeUnits(change.text).length, 0);
        expect(count).toBe(5);
    });
});

describe('titles', () => {
    it('take one side’s change, the same change, and refuse two different ones', () => {
        expect(mergeTitle('T', 'T', 'Theirs')).toEqual({ clean: true, title: 'Theirs' });
        expect(mergeTitle('T', 'Ours', 'T')).toEqual({ clean: true, title: 'Ours' });
        expect(mergeTitle('T', 'Same', 'Same')).toEqual({ clean: true, title: 'Same' });
        expect(mergeTitle('T', 'Ours', 'Theirs')).toEqual({ clean: false, title: 'Ours' });
    });

    it('merge apart from the body', () => {
        const base = { title: 'T', body: 'a\nb\n' };
        const merged = mergeTitledText(base, { title: 'Ours', body: 'A\nb\n' }, { title: 'T', body: 'a\nB\n' });
        expect(merged).toMatchObject({ clean: false, title: 'Ours', titleClean: true, body: { clean: false } });
        const clean = mergeTitledText(base, { title: 'Ours', body: 'A\nb\n' }, { title: 'T', body: 'a\nb\nc\n' });
        expect(clean).toMatchObject({ clean: true, title: 'Ours', body: { clean: true, text: 'A\nb\nc\n' } });
        const titleOnly = mergeTitledText(
            base,
            { title: 'Ours', body: base.body },
            { title: 'Theirs', body: 'a\nb\nc\n' },
        );
        expect(titleOnly).toMatchObject({ clean: false, titleClean: false, title: 'Ours', body: { clean: true } });
    });
});
