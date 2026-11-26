import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { compareBoardOrder, type IssueFilters, NO_FILTERS } from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';

import { contrast } from '../../scripts/theme/color.mts';
import {
    BLOCKED_TONE,
    BOARD_FACETS,
    type BoardIssueRow,
    boardPrefsText,
    type BoardPrefs,
    boardView,
    DEMAND_TONE,
    labelWords,
    NO_BOARD_PREFS,
    openIssueCount,
    pendingAnnouncement,
    PRIORITY_TONE,
    readBoardPrefs,
    STATUS_TONE,
    toggleFacet,
    withIssueWrites,
} from '../../src/shell/board';
import { BOARD_LATER, homeTiles } from '../../src/shell/home';
import type { PendingIssue } from '../../src/sync/issue-create';
import { issueSearchPath, searchIssues, shownIssueMatches } from '../../src/sync/issue-search';
import type { OverlayItem } from '../../src/sync/outbox-overlay';
import { SCHEMES, theme } from '../../src/theme/theme';

// The Board's view model: shared's filters
// and order over the collection's rows with this device's writes laid over,
// one column at a time, the kept choices, and the tones it draws in.

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
    options: {
        prefs?: Partial<BoardPrefs>;
        filters?: Partial<IssueFilters>;
        query?: string;
        matches?: ReadonlySet<number>;
        overlays?: OverlayItem[];
    } = {},
) =>
    boardView({
        issues,
        users: { u1: 'Ada Lovelace' },
        overlays: options.overlays ?? [],
        prefs: {
            ...NO_BOARD_PREFS,
            ...options.prefs,
            filters: { ...NO_FILTERS, ...options.filters },
        },
        query: options.query ?? '',
        ...(options.matches === undefined ? {} : { matches: options.matches }),
    });

const numbers = (v: ReturnType<typeof boardView>) =>
    v.rows.map((row): number | string => (row.type === 'issue' ? row.number : row.key));

const overlay = (fields: Partial<OverlayItem> & Pick<OverlayItem, 'key' | 'value'>): OverlayItem => ({
    collection: 'issues',
    mode: 'patch',
    id: `row-${fields.key}-${Math.random()}`,
    state: 'queued',
    reason: null,
    createdAt: T,
    ...fields,
});

const filing = (key: string, title: string, createdAt = T): OverlayItem =>
    overlay({
        key,
        id: key,
        mode: 'insert',
        createdAt,
        value: {
            key,
            number: null,
            title,
            body: '',
            status: 'triage',
            kind: 'bug',
            priority: 'medium',
            area: null,
            components: [],
        } satisfies PendingIssue,
    });

describe('the board’s columns', () => {
    const issues = ISSUE_STATUSES.map((status) => issue({ status }));

    it('are the board’s statuses, won’t fix on request, each a tab with its count; the first is chosen', () => {
        const v = view(issues);
        expect(v.columns.map((c) => c.status)).toEqual(ISSUE_STATUSES.filter((s) => s !== 'wont_fix'));
        expect(v.column).toBe('triage');
        expect(v.columns[0]).toMatchObject({ selected: true, count: 1, accessibilityLabel: 'Triage, 1 issue' });
        expect(v.wontFix).toEqual({ count: 1, offered: true });
        const shown = view(issues, { prefs: { wontFix: true, column: 'wont_fix' } });
        expect(shown.columns.at(-1)!.status).toBe('wont_fix');
        expect(numbers(shown)).toEqual([issues.at(-1)!.number]);
    });

    it('follow a status filter, which picks them, won’t fix included, and no longer offers won’t fix', () => {
        const v = view(issues, { filters: { status: ['done', 'wont_fix'] }, prefs: { column: 'open' } });
        expect(v.columns.map((c) => c.status)).toEqual(['done', 'wont_fix']);
        // The kept column isn't shown any more: the first is.
        expect(v.column).toBe('done');
        expect(v.wontFix.offered).toBe(false);
    });

    it('say the header’s counts over every issue, whatever the filters', () => {
        const v = view(issues, { filters: { priority: ['high'] } });
        expect(v.subtitle).toBe('6 open · 1 in progress · 1 done');
        expect(v.countLine).toBe('0 of 8');
        expect(view(issues).countLine).toBe('8 issues');
        expect(openIssueCount(issues)).toBe(6);
    });
});

describe('the board’s rows', () => {
    it('are in the server’s order (priority, newest change, newest number), whatever the collection’s', () => {
        const rows = [
            issue({ priority: 'low', updatedAt: T + 5 }),
            issue({ priority: 'critical', updatedAt: T }),
            issue({ priority: 'medium', updatedAt: T + 1 }),
            issue({ priority: 'medium', updatedAt: T + 1 }),
            issue({ priority: 'medium', updatedAt: T + 9 }),
        ];
        const expected = [...rows].sort(compareBoardOrder).map((i) => i.number);
        expect(numbers(view(rows.reverse(), { prefs: { column: 'open' } }))).toEqual(expected);
        expect(expected[0]).toBe(rows.find((i) => i.priority === 'critical')!.number);
    });

    it('put most votes first with "Most votes", ties in the board’s order', () => {
        const a = issue({ votes: 1, priority: 'high' });
        const b = issue({ votes: 3, priority: 'low' });
        const c = issue({ votes: 1, priority: 'critical' });
        expect(numbers(view([a, b, c], { prefs: { byVotes: true, column: 'open' } }))).toEqual([
            b.number,
            c.number,
            a.number,
        ]);
    });

    it('carry every mark in words: priority, kind and area, labels, votes, demand, blocked and the assignee', () => {
        const i = issue({
            priority: 'critical',
            kind: 'request',
            area: 'chat',
            labels: ['dot-request', 'ux'],
            votes: 2,
            voted: true,
            demand: 3,
            openBlockers: [4],
            assigneeId: 'u1',
        });
        const shown = view([i], { prefs: { column: 'open' } }).rows[0] as BoardIssueRow;
        expect(shown).toMatchObject({
            label: `CB-${i.number}`,
            priorityLabel: 'Critical',
            priorityTone: 'rose',
            kindArea: 'Socio request · Web chat',
            tags: ['Socio request', 'ux'],
            votes: 2,
            voted: true,
            demand: '3 asks',
            blocked: 'Blocked by 1',
            assignee: { name: 'Ada Lovelace', initials: 'AL' },
            pending: null,
        });
        expect(shown.accessibilityLabel).toBe(
            `CB-${i.number}, Issue ${i.number}, Critical priority, Socio request · Web chat, Socio request, ux, 2 votes, You voted, 3 asks, Blocked by 1, Assigned to Ada Lovelace`,
        );
    });

    it('never say "dot" to a person: the socio request label is in words, in the rows and the filter sheet', () => {
        expect(labelWords('dot-request')).toBe('Socio request');
        const labels = BOARD_FACETS.find((f) => f.name === 'label')!.options.map((o) => o.label);
        expect(labels.join(' ').toLowerCase()).not.toMatch(/\bdots?\b/);
        for (const facet of BOARD_FACETS) {
            for (const option of facet.options) {
                expect(option.label.toLowerCase(), option.value).not.toMatch(/\bdots?\b/);
            }
        }
    });
});

describe('the board’s filters', () => {
    const issues = [
        issue({ status: 'open', priority: 'high', kind: 'bug', area: 'chat', labels: ['ux'], title: 'Café menu' }),
        issue({ status: 'open', priority: 'low', kind: 'feature', area: 'auth', labels: ['dot-request'], demand: 2 }),
        issue({ status: 'open', priority: 'medium', kind: 'docs', area: null, labels: [], title: 'Export CSV' }),
        issue({ status: 'done', priority: 'high', kind: 'bug', labels: ['dot-request'] }),
    ];
    const open = { prefs: { column: 'open' as const } };

    it('narrow by every value of every facet, as shared’s filterIssues does', () => {
        const values = { priority: ISSUE_PRIORITIES, kind: ISSUE_KINDS, area: ISSUE_AREAS, label: ISSUE_LABELS };
        for (const [facet, options] of Object.entries(values) as [keyof typeof values, readonly string[]][]) {
            for (const value of options) {
                const v = view(issues, { ...open, filters: { [facet]: [value] } });
                const expected = issues.filter((i) => {
                    if (i.status !== 'open') {
                        return false;
                    }
                    const field = facet === 'label' ? i.labels : [i[facet]];
                    return (field as readonly unknown[]).includes(value);
                });
                expect(numbers(v), `${facet}=${value}`).toEqual(
                    [...expected].sort(compareBoardOrder).map((i) => i.number),
                );
            }
        }
        for (const status of ISSUE_STATUSES) {
            const v = view(issues, { filters: { status: [status] } });
            expect(v.columns.map((c) => c.status)).toEqual([status]);
            expect(numbers(v)).toEqual(
                issues
                    .filter((i) => i.status === status)
                    .sort(compareBoardOrder)
                    .map((i) => i.number),
            );
        }
    });

    it('need every facet chosen and any value within one (pairs of facets)', () => {
        expect(numbers(view(issues, { ...open, filters: { priority: ['high', 'low'], kind: ['bug'] } }))).toEqual([
            issues[0]!.number,
        ]);
        expect(numbers(view(issues, { ...open, filters: { kind: ['feature'], area: ['auth'] } }))).toEqual([
            issues[1]!.number,
        ]);
        expect(numbers(view(issues, { ...open, filters: { kind: ['feature'], area: ['chat'] } }))).toEqual([]);
    });

    it('search what the phone holds until the server answers, then take the server’s matches', () => {
        // Accents folded, the key too.
        expect(numbers(view(issues, { ...open, query: 'cafe' }))).toEqual([issues[0]!.number]);
        expect(numbers(view(issues, { ...open, query: `cb-${issues[2]!.number}` }))).toEqual([issues[2]!.number]);
        // The server found the words in a description the list doesn't hold.
        const matches = new Set([issues[1]!.number]);
        const v = view(issues, { ...open, query: 'cafe', matches });
        expect(numbers(v)).toEqual([issues[1]!.number]);
        expect(v.countLine).toBe('1 of 4');
        expect(v.empty).toBe('No issues match.');
    });

    it('leave the shared empty state when a search or the filters match nothing, with what clears them (CB-552)', () => {
        expect(view(issues, open).noMatch).toBeNull();
        expect(view(issues, { ...open, query: 'nothing like it' }).noMatch).toEqual({
            title: 'No results for “nothing like it”',
            line: 'Try other words or filters.',
            accessibilityLabel: 'No results for “nothing like it”. Try other words or filters.',
            announcement: 'No results',
            clearSearch: true,
            clearFilters: false,
        });
        // The filters alone: the web's words, and Clear filters only.
        expect(view(issues, { ...open, filters: { priority: ['critical'] } }).noMatch).toMatchObject({
            title: 'No issues match',
            clearSearch: false,
            clearFilters: true,
        });
        expect(view(issues, { ...open, query: 'zzz', filters: { priority: ['critical'] } }).noMatch).toMatchObject({
            clearSearch: true,
            clearFilters: true,
        });
    });

    it('have the "Socio requests" lane, with the open ones counted', () => {
        const v = view(issues, { ...open, filters: { label: ['dot-request'] } });
        expect(v.dotRequestsOnly).toBe(true);
        expect(v.dotRequests).toBe(1);
        expect(numbers(v)).toEqual([issues[1]!.number]);
        expect(v.facetCount).toBe(1);
    });

    it('turn a value on and off', () => {
        const on = toggleFacet(NO_FILTERS, 'priority', 'high');
        expect(on.priority).toEqual(['high']);
        expect(toggleFacet(on, 'priority', 'high').priority).toEqual([]);
    });
});

describe('the board’s kept choices', () => {
    it('read back what was kept, without the search', () => {
        const prefs: BoardPrefs = {
            filters: { ...NO_FILTERS, q: 'secret words', priority: ['high'], label: ['dot-request'] },
            column: 'in_review',
            wontFix: true,
            byVotes: true,
            view: 'list',
            components: ['plugin:forms'],
        };
        const text = boardPrefsText(prefs);
        expect(text).not.toContain('secret');
        expect(readBoardPrefs(text)).toEqual({ ...prefs, filters: { ...prefs.filters, q: '' } });
    });

    it('drop what this build doesn’t know, and start afresh from nothing or text that isn’t theirs', () => {
        expect(readBoardPrefs(null)).toEqual(NO_BOARD_PREFS);
        expect(readBoardPrefs('{not json')).toEqual(NO_BOARD_PREFS);
        expect(readBoardPrefs('"text"')).toEqual(NO_BOARD_PREFS);
        expect(
            readBoardPrefs(JSON.stringify({ filters: { priority: ['high', 'urgent'], kind: 'bug' }, column: 'later' })),
        ).toEqual({ ...NO_BOARD_PREFS, filters: { ...NO_FILTERS, priority: ['high'] } });
    });
});

describe('this device’s writes on the board', () => {
    it('re-sort a row by its pending priority, marked "Waiting to send"', () => {
        const a = issue({ priority: 'high' });
        const b = issue({ priority: 'low' });
        const v = view([a, b], {
            prefs: { column: 'open' },
            overlays: [overlay({ key: String(b.number), value: { priority: 'critical' } })],
        });
        expect(numbers(v)).toEqual([b.number, a.number]);
        expect(v.rows[0]).toMatchObject({ priorityLabel: 'Critical', pending: 'Waiting to send' });
        expect(v.rows[1]).toMatchObject({ pending: null });
        expect(pendingAnnouncement(v.pendingCount)).toBe('1 change on the board waiting to send');
    });

    it('show a pending vote, and "Couldn’t confirm" over "Waiting to send"; a sent one keeps its value unmarked', () => {
        const a = issue();
        const key = String(a.number);
        const [voted] = withIssueWrites(
            [a],
            [
                overlay({ key, value: { voted: true, votes: 1 }, state: 'unconfirmed' }),
                overlay({ key, value: { priority: 'low' } }),
            ],
        );
        expect(voted).toMatchObject({ issue: { voted: true, votes: 1, priority: 'low' } });
        expect(voted!.pending).toBe('Couldn’t confirm this was sent');
        const [sent] = withIssueWrites([a], [overlay({ key, value: { votes: 4 }, state: 'sent' })]);
        expect(sent).toEqual({ issue: { ...a, votes: 4 }, pending: null });
    });

    it('lay nothing over for a refused write: the row shows the server’s values', () => {
        const a = issue({ priority: 'high' });
        expect(
            withIssueWrites([a], [overlay({ key: String(a.number), value: { priority: 'low' }, state: 'unsent' })]),
        ).toEqual([{ issue: a, pending: null }]);
    });

    it('put filings not yet numbered (CB-?) at the top of Triage, newest first, counted in its tab', () => {
        const t = issue({ status: 'triage' });
        const v = view([t], {
            overlays: [filing('pending-issue-a', 'Older', T), filing('pending-issue-b', 'Newer', T + 1)],
        });
        expect(v.column).toBe('triage');
        expect(numbers(v)).toEqual(['pending-issue-b', 'pending-issue-a', t.number]);
        expect(v.rows[0]).toMatchObject({ type: 'pending', label: 'CB-?', words: 'Waiting to send' });
        expect(v.columns[0]!.count).toBe(3);
        expect(pendingAnnouncement(v.pendingCount)).toBe('2 changes on the board waiting to send');
        expect(pendingAnnouncement(view([t]).pendingCount)).toBeUndefined();
        // The whole board's count, the same from any column, so switching back says nothing new.
        const elsewhere = view([t, issue({ status: 'open' })], {
            prefs: { column: 'open' },
            overlays: [filing('pending-issue-a', 'x'), overlay({ key: String(t.number), value: { priority: 'low' } })],
        });
        expect(elsewhere.rows.every((row) => row.type === 'issue' && row.pending === null)).toBe(true);
        expect(elsewhere.pendingCount).toBe(2);
        expect(pendingAnnouncement(elsewhere.pendingCount)).toBe('2 changes on the board waiting to send');
        // Another column holds none of them.
        expect(numbers(view([t], { prefs: { column: 'open' }, overlays: [filing('pending-issue-a', 'x')] }))).toEqual(
            [],
        );
    });
});

describe('the board’s tones', () => {
    for (const scheme of SCHEMES) {
        const { tones, colors } = theme[scheme];
        it(`keep every pill’s words readable on its tile over a row, ${scheme}`, () => {
            for (const tone of [...Object.values(PRIORITY_TONE), DEMAND_TONE, BLOCKED_TONE]) {
                expect(contrast(tones[tone].foreground, tones[tone].tiles.card), tone).toBeGreaterThanOrEqual(4.5);
            }
        });
        it(`keep each status dot visible beside its word on the screen and a selected tab, ${scheme}`, () => {
            for (const [status, tone] of Object.entries(STATUS_TONE)) {
                for (const surface of ['screen', 'accent'] as const) {
                    expect(
                        contrast(tones[tone].foreground, colors[surface]),
                        `${status} on ${surface}`,
                    ).toBeGreaterThanOrEqual(3);
                }
            }
        });
    }
});

describe('Home’s Board tile', () => {
    it('counts the open issues, and says what it is before any came', () => {
        expect(homeTiles({ spaces: 0, state: null, openIssues: 4 })[0]!.caption).toBe('4 open');
        expect(homeTiles({ spaces: 0, state: null, openIssues: null })[0]!.caption).toBe(BOARD_LATER);
    });
});

describe('the board’s search on the server', () => {
    it('asks /api/issues/search with the text, at most 200 characters, and takes its numbers', async () => {
        expect(issueSearchPath('café & co')).toBe('/api/issues/search?q=caf%C3%A9%20%26%20co');
        expect(issueSearchPath('x'.repeat(300))).toBe(`/api/issues/search?q=${'x'.repeat(200)}`);
        const asked: string[] = [];
        const fetch = async (path: string) => {
            asked.push(path);
            return new Response(JSON.stringify({ numbers: [3, 1] }), { status: 200 });
        };
        expect(await searchIssues(fetch, 'csv')).toEqual(new Set([3, 1]));
        expect(asked).toEqual(['/api/issues/search?q=csv']);
    });

    it('rejects a refusal or a body that isn’t the server’s, so the board keeps its own filter', async () => {
        await expect(searchIssues(async () => new Response('{}', { status: 400 }), 'x')).rejects.toThrow();
        await expect(searchIssues(async () => new Response('{"numbers":["1"]}'), 'x')).rejects.toThrow();
        await expect(searchIssues(async () => new Response('<html>'), 'x')).rejects.toThrow();
    });

    it('keep an answer by its folded text only, so a changed issue list doesn’t drop the matches', () => {
        const kept = { query: 'csv export', matches: new Set([3, 1]) };
        expect(shownIssueMatches(kept, '  CSV   Export ')).toBe(kept.matches);
        expect(shownIssueMatches(kept, 'csv')).toBeUndefined();
        expect(shownIssueMatches(kept, '')).toBeUndefined();
        expect(shownIssueMatches(null, 'csv export')).toBeUndefined();
        // The board's hook keeps it by text alone, asks again when the list changes, and the answer replaces it.
        const board = readFileSync(new URL('../../src/screens/board.tsx', import.meta.url), 'utf8');
        expect(board).toContain('setAnswer({ query: folded, matches });');
        expect(board).toContain('}, [folded, version, query, scope]);');
        expect(board).toContain('return shownIssueMatches(answer, query);');
    });
});
