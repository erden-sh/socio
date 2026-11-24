import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    COMPARE_TITLE,
    COMPARE_WORDS,
    compareLines,
    compareSheet,
    conflictBanner,
    MERGE_WORDS,
    mergeChangeLines,
    MERGED_TOAST,
    SEE_WHAT_CHANGED,
    WHAT_CHANGED_TITLE,
    whatChangedSheet,
} from '../../src/shell/page-conflict';
import type { PageConflict } from '../../src/sync/page-conflicts';

// The conflict banner's words and Compare's rows, under Node.

const lines = (count: number, change: Record<number, string> = {}) =>
    `${Array.from({ length: count }, (_, at) => change[at] ?? `Line ${at}`).join('\n')}\n`;

function conflict(mine: string, theirs: string | null, titles = { mine: 'Roadmap', theirs: 'Roadmap' }): PageConflict {
    const payload = {
        spaceId: 's1',
        pageId: 'p1',
        base: { title: 'Roadmap', content: lines(10), revision: 3 },
        draft: { title: titles.mine, content: mine },
        ownRevisions: [],
    };
    return {
        id: 'save-1',
        pageId: 'p1',
        spaceId: 's1',
        mine: payload.draft,
        theirs: theirs === null ? null : { spaceId: 's1', title: titles.theirs, content: theirs, revision: 4 },
        payload,
        createdAt: 1,
    };
}

describe('the page conflict banner', () => {
    it('names nobody, and counts the versions waiting', () => {
        expect(conflictBanner([])).toBeNull();
        const one = conflictBanner([conflict('a\n', 'b\n')]);
        expect(one).toMatchObject({ heading: 'This page changed elsewhere', canCompare: true });
        expect(one?.line).toBe(
            'Someone else saved changes while yours were waiting. Your version is safe on this phone.',
        );
        const two = conflictBanner([conflict('a\n', 'b\n'), { ...conflict('c\n', null), id: 'save-2' }]);
        expect(two?.conflict.id).toBe('save-1');
        expect(two?.line).toContain('2 versions of yours are safe on this phone; this is the oldest.');
        // An older build's conflict kept no texts: nothing to compare.
        expect(conflictBanner([conflict('a\n', null)])?.canCompare).toBe(false);
        expect(MERGED_TOAST).toBe('Merged with changes made elsewhere');
    });

    it('compares theirs against yours, folding long unchanged stretches', () => {
        const rows = compareLines(conflict(lines(12, { 6: 'Mine' }), lines(12, { 6: 'Theirs' })));
        expect(rows.map((row) => [row.kind, row.text])).toEqual([
            ['same', '4 unchanged lines'],
            ['same', 'Line 4'],
            ['same', 'Line 5'],
            ['removed', 'Theirs'],
            ['added', 'Mine'],
            ['same', 'Line 7'],
            ['same', 'Line 8'],
            ['same', '3 unchanged lines'],
        ]);
        expect(rows.find((row) => row.kind === 'removed')?.label).toBe('Theirs');
        expect(rows.find((row) => row.kind === 'added')?.label).toBe('Yours');
        expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    });

    it('shows a changed title first', () => {
        const rows = compareLines(conflict('Same\n', 'Same\n', { mine: 'Plans ', theirs: 'Roadmap' }));
        expect(rows.map((row) => [row.kind, row.text, row.label])).toEqual([
            ['removed', 'Roadmap', 'Their title'],
            ['added', 'Plans', 'Your title'],
            ['same', 'Same', null],
        ]);
    });

    it("shows what a clean merge changed under the person, as Compare's rows, with its own words", () => {
        expect(SEE_WHAT_CHANGED).toBe('See what changed');
        const before = { title: 'Roadmap', content: lines(12, { 9: 'Mine' }) };
        const after = { title: 'Roadmap 2026', content: lines(12, { 2: 'Theirs', 9: 'Mine' }) };
        const rows = mergeChangeLines({ before, after });
        expect(rows.map((row) => [row.kind, row.text, row.label])).toEqual([
            ['removed', 'Roadmap', 'Title before'],
            ['added', 'Roadmap 2026', 'Title now'],
            ['same', 'Line 0', null],
            ['same', 'Line 1', null],
            ['removed', 'Line 2', 'Before'],
            ['added', 'Theirs', 'Changed elsewhere'],
            ['same', 'Line 3', null],
            ['same', 'Line 4', null],
            ['same', '7 unchanged lines', null],
        ]);
        expect(MERGE_WORDS.legend).toBe('− Before the merge · + Changed elsewhere');
        // Nothing changed: no rows but the text itself.
        expect(mergeChangeLines({ before, after: before }).every((row) => row.kind === 'same')).toBe(true);
    });
});

describe('one diff sheet for Compare and "See what changed"', () => {
    const screen = readFileSync(join(import.meta.dirname, '../../src/screens/page-conflict.tsx'), 'utf8');

    it('gives each its own title, legend and rows', () => {
        const waiting = conflict(lines(12, { 9: 'Mine' }), lines(12, { 2: 'Theirs' }));
        expect(compareSheet(waiting)).toEqual({
            title: COMPARE_TITLE,
            legend: COMPARE_WORDS.legend,
            rows: compareLines(waiting),
            testID: 'page-conflict-compare-sheet',
        });
        const change = {
            before: { title: 'Roadmap', content: lines(3) },
            after: { title: 'Roadmap', content: lines(4) },
        };
        expect(whatChangedSheet(change)).toEqual({
            title: WHAT_CHANGED_TITLE,
            legend: MERGE_WORDS.legend,
            rows: mergeChangeLines(change),
            testID: 'page-what-changed',
        });
    });

    it('opens both through the same sheet component, with no inline comparison in the banner', () => {
        // One native sheet (CB-421, screens/route-sheet.tsx), never a React Native Modal.
        expect(screen).not.toMatch(/<Modal\b/);
        expect(screen.match(/<LineDiff\b/g)).toHaveLength(1);
        expect(screen).toContain('setComparing(compareSheet(conflict))');
        expect(screen).toContain('setViewing(whatChangedSheet(change))');
        expect(screen.match(/useRouteSheet\((comparing|viewing) === null \? null : diffSheet\(/g)).toHaveLength(2);
        expect(screen).not.toContain('HIDE_COMPARE');
    });
});
