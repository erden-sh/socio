import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NO_FILTERS } from '@socio/shared/issues/issue-board';
import type { IssueSummary } from '@socio/shared/issues/issue-types';

import { type BoardPrefs, boardView, NO_BOARD_PREFS, readBoardPrefs } from '../../src/shell/board';
import {
    allSelected,
    applyBatch,
    batchEdit,
    batchGroups,
    batchResult,
    batchWords,
    selectionTitle,
    toggleSelected,
} from '../../src/shell/board-select';
import type { EditIssueInput } from '../../src/sync/issue-edit';
import type { OverlayItem } from '../../src/sync/outbox-overlay';

// The owner's call (2026-11-18): the web's board/list toggle, its Select
// mode with the BatchBar's actions, and "👍 0" on every row.

const T = 1_700_000_000_000;
let n = 0;
const issue = (fields: Partial<IssueSummary> = {}): IssueSummary => {
    n += 1;
    return {
        number: n,
        title: `Issue ${n}`,
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        assigneeId: null,
        updatedAt: T,
        excerpt: '',
        votes: 0,
        voted: false,
        ...fields,
    } as IssueSummary;
};

const view = (
    issues: readonly IssueSummary[],
    options: { prefs?: Partial<BoardPrefs>; selection?: ReadonlySet<number> } = {},
) =>
    boardView({
        issues,
        users: {},
        overlays: [],
        prefs: { ...NO_BOARD_PREFS, ...options.prefs },
        query: '',
        ...(options.selection === undefined ? {} : { selection: options.selection }),
    });

const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');

describe('the board/list toggle', () => {
    it('is kept with the board’s choices, the board unless the list was chosen', () => {
        expect(NO_BOARD_PREFS.view).toBe('board');
        expect(readBoardPrefs(JSON.stringify({ view: 'list' })).view).toBe('list');
        expect(readBoardPrefs(JSON.stringify({ view: 'grid' })).view).toBe('board');
    });

    it('lists every status as a section in the web’s order, empty ones left out, done folded at first', () => {
        const issues = [
            issue({ status: 'done' }),
            issue({ status: 'triage', excerpt: 'What broke' }),
            issue({ status: 'wont_fix' }),
        ];
        const v = view(issues, { prefs: { view: 'list' } });
        expect(v.layout).toBe('list');
        expect(v.rows.map((row) => (row.type === 'issue' ? row.number : row.key))).toEqual([
            'section:triage',
            issues[1]!.number,
            'section:done',
            'section:wont_fix',
        ]);
        const first = v.rows[0]!;
        expect(first).toMatchObject({ type: 'section', first: true, open: true, count: 1 });
        expect(v.rows[2]).toMatchObject({ first: false, open: false, accessibilityLabel: 'Done, 1 issue, folded' });
        expect(v.rows[1]).toMatchObject({ excerpt: 'What broke' });
    });

    it('opens a folded section and folds an open one', () => {
        const issues = [issue({ status: 'done' }), issue({ status: 'open' })];
        const v = boardView({
            issues,
            users: {},
            overlays: [],
            prefs: { ...NO_BOARD_PREFS, view: 'list' },
            query: '',
            collapsed: new Set(['open']),
        });
        expect(v.rows.map((row) => row.key)).toEqual(['section:open', 'section:done', String(issues[0]!.number)]);
    });

    it('follows a status filter, as the web’s list does', () => {
        const issues = [issue({ status: 'done' }), issue({ status: 'open' })];
        const v = view(issues, {
            prefs: { view: 'list', filters: { ...NO_FILTERS, status: ['open'] } },
        });
        expect(v.rows.filter((row) => row.type === 'section').map((row) => row.key)).toEqual(['section:open']);
    });
});

describe('Select', () => {
    it('marks each row picked or not only while selecting, and says it to screen readers', () => {
        const [a, b] = [issue({ status: 'triage' }), issue({ status: 'triage' })];
        expect(view([a!, b!]).rows.map((row) => (row.type === 'issue' ? row.selected : 'x'))).toEqual([null, null]);
        const picked = view([a!, b!], { selection: new Set([a!.number]) }).rows.flatMap((row) =>
            row.type === 'issue' ? [row] : [],
        );
        const rowOf = (number: number) => picked.find((row) => row.number === number)!;
        expect(rowOf(a!.number).selected).toBe(true);
        expect(rowOf(b!.number).selected).toBe(false);
        expect(rowOf(a!.number).accessibilityLabel.startsWith('Selected, ')).toBe(true);
        expect(rowOf(b!.number).accessibilityLabel.startsWith('Not selected, ')).toBe(true);
    });

    it('offers every issue the filters let through, in every column (the web’s Select all)', () => {
        const issues = [
            issue({ status: 'open' }),
            issue({ status: 'done' }),
            issue({ status: 'open', priority: 'low' }),
        ];
        const v = view(issues, { prefs: { filters: { ...NO_FILTERS, priority: ['medium'] } } });
        expect([...v.selectable].sort()).toEqual([issues[0]!.number, issues[1]!.number].sort());
        expect(allSelected(new Set(v.selectable), v.selectable)).toBe(true);
        expect(allSelected(new Set([issues[0]!.number]), v.selectable)).toBe(false);
        expect(allSelected(new Set(), [])).toBe(false);
    });

    it('picks and puts back, and titles the header by the count', () => {
        const once = toggleSelected(new Set(), 4);
        expect([...once]).toEqual([4]);
        expect([...toggleSelected(once, 4)]).toEqual([]);
        expect(selectionTitle(0)).toBe('Select issues');
        expect(selectionTitle(2)).toBe('2 selected');
    });

    it('has the web BatchBar’s menus: every status, every priority, add and remove each label', () => {
        expect(batchGroups('status')[0]!.choices.map((c) => c.label)).toContain('In progress');
        expect(batchGroups('priority')[0]!.choices).toHaveLength(4);
        const labels = batchGroups('labels');
        expect(labels.map((g) => g.title)).toEqual(['Add label', 'Remove label']);
        expect(labels[0]!.choices.map((c) => c.label)).toContain('Socio request');
    });

    it('words what it did as the web’s toasts do', () => {
        expect(batchWords({ kind: 'status', value: 'done' })).toBe('Moved to Done');
        expect(batchWords({ kind: 'priority', value: 'high' })).toBe('Priority set to High');
        expect(batchWords({ kind: 'add-label', value: 'regression' })).toBe('Added regression');
        expect(batchResult('Moved to Done', 2, 0)).toBe('Moved to Done: 2 issues');
        expect(batchResult('Moved to Done', 1, 0)).toBe('Moved to Done: 1 issue');
        expect(batchResult('Moved to Done', 0, 0)).toBe('Nothing to change');
        expect(batchResult('Moved to Done', 1, 1)).toBe('Moved to Done: 1 not changed');
    });

    it('leaves alone an issue already as chosen', () => {
        const shown = issue({ status: 'done', labels: ['regression'] });
        expect(batchEdit({ kind: 'status', value: 'done' }, shown)).toBeUndefined();
        expect(batchEdit({ kind: 'status', value: 'open' }, shown)).toEqual({ changes: { status: 'open' } });
        expect(batchEdit({ kind: 'add-label', value: 'regression' }, shown)).toBeUndefined();
        expect(batchEdit({ kind: 'remove-label', value: 'regression' }, shown)).toEqual({
            changes: {},
            toggleLabel: 'regression',
        });
        expect(batchEdit({ kind: 'remove-label', value: 'ux' }, shown)).toBeUndefined();
    });

    it('edits each picked issue through IE’s editIssue, on the server’s values, judged by what it shows', async () => {
        const a = issue({ status: 'open' });
        const b = issue({ status: 'open' });
        const c = issue({ status: 'open' });
        // b already shows Done from a queued edit: nothing to send for it.
        const overlays: OverlayItem[] = [
            {
                collection: 'issues',
                mode: 'patch',
                id: 'row-b',
                key: String(b.number),
                value: { status: 'done' },
                state: 'queued',
                reason: null,
                createdAt: T,
            },
        ];
        const sent: EditIssueInput[] = [];
        const said = await applyBatch({
            choice: { kind: 'status', value: 'done' },
            selection: new Set([a.number, b.number]),
            issues: [a, b, c],
            overlays,
            edit: async (input) => {
                sent.push(input);
                return 'queued';
            },
            newId: () => 'id',
        });
        expect(said).toBe('Moved to Done: 1 issue');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            issue: String(a.number),
            changes: { status: 'done' },
            base: { status: 'open', priority: 'medium', labels: [] },
        });
    });

    it('counts an edit refused before it is written as not changed', async () => {
        const a = issue();
        const said = await applyBatch({
            choice: { kind: 'priority', value: 'high' },
            selection: new Set([a.number]),
            issues: [a],
            overlays: [],
            edit: () => Promise.reject(new Error('no')),
            newId: () => 'id',
        });
        expect(said).toBe('Priority set to High: 1 not changed');
    });
});

describe('the Board screen', () => {
    const board = src('screens/board.tsx');

    it('shows the vote count on every row, "👍 0" included, as the web’s cards do', () => {
        expect(board).not.toMatch(/votes > 0/);
        // The card and the list row both draw the count.
        expect(board.match(/<Votes row=\{row\} \/>/g)).toHaveLength(2);
    });

    it('offers Select to admins only, as the web does, and applies batches through editIssue', () => {
        expect(board).toMatch(/const admin = user !== null && canTriage\(user\)/);
        expect(board).toMatch(
            /\.\.\.\(admin\s+\? \[\{ id: 'board-select', label: 'Select', onPress: \(\) => setSelection\(new Set\(\)\) \}\]/,
        );
        // Mail's Select mode in the bar: Done prominent, Select all, and no Back while it lasts.
        expect(board).toMatch(/title: selectionTitle\(picked\),\s+back: false,/);
        expect(board).toContain("{ id: 'board-select-done', label: 'Done', prominent: true, onPress: exitSelect },");
        expect(board).toMatch(/edit: \(input\) => editIssue\(outbox, input\)/);
    });

    it('draws the board/list toggle and keeps the choice', () => {
        expect(board).toMatch(/onLayout=\{\(layout\) => setPrefs\(\{ \.\.\.prefs, view: layout \}\)\}/);
        // The platform's segmented control: UISegmentedControl on iOS, Material's on Android.
        expect(board).toContain('<SegmentedControl');
        expect(board).toContain("testID: 'board-layout-board'");
        expect(board).toContain("testID: 'board-layout-list'");
    });
});
