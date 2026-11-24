import { expect, it } from 'vitest';

import { acceptFiles, ATTACHMENT_EXTENSIONS, fileProblem } from '@socio/shared/issues/issue-attachment-files';
import {
    BOARD_STATUSES,
    byVotes,
    canDeleteAttachment,
    canDeleteComment,
    canEditComment,
    canEditText,
    canTriage,
    compareBoardOrder,
    dotRequestsOnly,
    eventText,
    filterIssues,
    filtersActive,
    groupByStatus,
    isDotRequest,
    issueCounts,
    issueNumber,
    issuePath,
    NO_FILTERS,
    priorityRank,
    toggleDotRequests,
} from '@socio/shared/issues/issue-board';
import {
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_ATTACHMENTS_PER_ISSUE,
    issueSummary,
    type Issue,
    type IssueComment,
} from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

// The board's logic the web and the app share. Most of these moved with the
// code from the client's issues-ui.test.tsx.

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

let next = 1;
function issue(fields: Partial<Issue> = {}): Issue {
    const number = fields.number ?? next++;
    return {
        id: `i${number}`,
        number,
        title: `Issue ${number}`,
        body: '',
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        reporterId: 'bob',
        assigneeId: null,
        resolution: null,
        source: 'web',
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        ...fields,
    };
}

/** The issue as the board's list has it (CB-71). */
const row = (fields: Partial<Issue> = {}) => issueSummary(issue(fields));

it('filters by search words and by any value within each facet', () => {
    const issues = [
        row({ number: 1, title: 'Login fails on Safari', priority: 'high' }),
        row({
            number: 2,
            title: 'Dark mode',
            body: 'The **sidebar** is too bright',
            kind: 'improvement',
            area: 'client',
            labels: ['ux'],
        }),
        row({ number: 3, title: 'Docs typo', kind: 'docs', status: 'done' }),
    ];
    const numbers = (filters: Partial<typeof NO_FILTERS>) =>
        filterIssues(issues, { ...NO_FILTERS, ...filters }).map((i) => i.number);
    expect(numbers({})).toEqual([1, 2, 3]);
    expect(numbers({ q: 'safari login' })).toEqual([1]);
    expect(numbers({ q: 'sidebar' })).toEqual([2]);
    expect(numbers({ q: 'cb-3' })).toEqual([3]);
    expect(numbers({ q: 'safari dark' })).toEqual([]);
    expect(numbers({ kind: ['docs', 'improvement'] })).toEqual([2, 3]);
    expect(numbers({ kind: ['docs', 'improvement'], status: ['done'] })).toEqual([3]);
    expect(numbers({ priority: ['high'] })).toEqual([1]);
    expect(numbers({ area: ['client'] })).toEqual([2]);
    expect(numbers({ label: ['ux', 'security'] })).toEqual([2]);
    expect(numbers({ label: ['security'] })).toEqual([]);
});

it('groups issues by status and counts open, in progress and done', () => {
    const issues = [
        row({ status: 'triage' }),
        row({ status: 'open' }),
        row({ status: 'in_progress' }),
        row({ status: 'done' }),
        row({ status: 'done' }),
        row({ status: 'wont_fix' }),
    ];
    const groups = groupByStatus(issues);
    expect(groups.triage).toHaveLength(1);
    expect(groups.ready).toEqual([]);
    expect(groups.done).toHaveLength(2);
    expect(issueCounts(issues)).toEqual({ open: 3, inProgress: 1, done: 2 });
    // The board leaves won't fix out until asked.
    expect(BOARD_STATUSES).not.toContain('wont_fix');
    expect(BOARD_STATUSES).toHaveLength(7);
});

it('describes history rows, with names for assignees', () => {
    const event = (kind: string, fromValue: string | null, toValue: string) =>
        ({
            id: 'e',
            issueId: 'i',
            actorId: 'alice',
            kind,
            fromValue,
            toValue,
            createdAt: 1,
        }) as Parameters<typeof eventText>[0];
    expect(eventText(event('status', 'triage', 'in_progress'))).toBe('changed status from Triage to In progress');
    expect(eventText(event('assignee', null, 'bob'), { bob: 'Bob' })).toBe('assigned Bob');
    expect(eventText(event('attachment_added', null, 'shot.png'))).toBe('attached shot.png');
    expect(eventText(event('area', 'client', 'chat'))).toBe('changed area from Client to Web chat');
});

it('lets members edit only their own issues’ text while in triage', () => {
    const own = issue({ reporterId: 'bob', status: 'triage' });
    expect(canEditText(own, bob)).toBe(true);
    expect(canEditText({ ...own, status: 'open' }, bob)).toBe(false);
    expect(canEditText({ ...own, reporterId: 'carol' }, bob)).toBe(false);
    expect(canEditText({ ...own, status: 'done' }, alice)).toBe(true);
});

it('sorts by votes keeping ties in order, and searches with accents and case folded', () => {
    const issues = [
        row({ number: 1, title: 'Café menu' }),
        row({ number: 2, votes: 3 }),
        row({ number: 3, votes: 1 }),
        row({ number: 4 }),
    ];
    expect(byVotes(issues).map((i) => i.number)).toEqual([2, 3, 1, 4]);
    expect(filterIssues(issues, { ...NO_FILTERS, q: 'CAFE' }).map((i) => i.number)).toEqual([1]);
});

it('writes the link rows of the history in words', () => {
    const at = (kind: 'blocked_by' | 'blocks' | 'related', from: string | null, to: string | null) =>
        eventText(
            {
                id: 'e',
                issueId: 'i',
                actorId: 'alice',
                kind,
                fromValue: from,
                toValue: to,
                createdAt: 1,
            },
            {},
        );
    expect(at('blocked_by', null, 'CB-4')).toBe('made it wait for CB-4');
    expect(at('blocked_by', 'CB-4', null)).toBe('lifted the wait for CB-4');
    expect(at('blocks', null, 'CB-9')).toBe('made CB-9 wait for it');
    expect(at('blocks', 'CB-9', null)).toBe('lifted CB-9’s wait for it');
    expect(at('related', null, 'CB-30')).toBe('linked it to CB-30 as related');
    expect(at('related', 'CB-30', null)).toBe('unlinked CB-30');
});

it('words the triage rows of the history', () => {
    const event = (to: string) =>
        eventText(
            {
                id: 'e',
                issueId: 'i',
                actorId: 'triage',
                kind: 'triage',
                fromValue: null,
                toValue: to,
                createdAt: 1,
            },
            {},
        );
    expect(event('proposed')).toBe('proposed a triage');
    expect(event('applied')).toBe('applied the triage proposal');
    expect(event('ignored')).toBe('ignored the triage proposal');
});

it('sorts as the server does: priority, then most recently updated, then the newest number', () => {
    expect((['low', 'critical', 'medium', 'high'] as const).map(priorityRank)).toEqual([3, 0, 2, 1]);
    const issues = [
        row({ number: 1, priority: 'low', updatedAt: 50 }),
        row({ number: 2, priority: 'critical', updatedAt: 10 }),
        row({ number: 3, priority: 'medium', updatedAt: 20 }),
        row({ number: 4, priority: 'medium', updatedAt: 30 }),
        row({ number: 5, priority: 'medium', updatedAt: 20 }),
        row({ number: 6, priority: 'high', updatedAt: 1 }),
    ];
    expect([...issues].sort(compareBoardOrder).map((i) => i.number)).toEqual([2, 6, 4, 5, 3, 1]);
    // Sorted rows stay put, and the sort doesn't depend on where it starts.
    expect(
        [...issues]
            .reverse()
            .sort(compareBoardOrder)
            .map((i) => i.number),
    ).toEqual([2, 6, 4, 5, 3, 1]);
});

it('keeps the socios requests lane, the active filters and the issue keys', () => {
    expect(isDotRequest({ labels: ['dot-request'] })).toBe(true);
    expect(isDotRequest({ labels: ['ux'] })).toBe(false);
    expect(dotRequestsOnly(toggleDotRequests(NO_FILTERS))).toBe(true);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, q: '  ' })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, q: 'x' })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, area: ['client'] })).toBe(true);
    expect(issueNumber('CB-12')).toBe(12);
    expect(issueNumber('cb-7')).toBe(7);
    expect(issueNumber('12')).toBe(12);
    expect(issueNumber('CB-x')).toBeUndefined();
    expect(issueNumber(undefined)).toBeUndefined();
    expect(issuePath(12)).toBe('/issues/CB-12');
    expect(BOARD_STATUSES).not.toContain('wont_fix');
});

it('shows comment and attachment controls to authors and admins only', () => {
    const comment = (fields: Partial<IssueComment>) =>
        ({ authorKind: 'user', authorId: 'bob', ...fields }) as Pick<IssueComment, 'authorKind' | 'authorId' | 'dot'>;
    expect(canTriage(alice)).toBe(true);
    expect(canTriage(bob)).toBe(false);
    expect(canEditComment(comment({}), bob)).toBe(true);
    expect(canEditComment(comment({}), alice)).toBe(false);
    expect(canEditComment(comment({ authorKind: 'agent' }), bob)).toBe(false);
    expect(canDeleteComment(comment({}), bob)).toBe(true);
    expect(canDeleteComment(comment({ authorId: 'carol' }), alice)).toBe(true);
    expect(canDeleteComment(comment({ authorId: 'carol' }), bob)).toBe(false);
    expect(
        canDeleteComment(comment({ authorId: 'dot:helper', dot: { userId: 'bob' } as IssueComment['dot'] }), bob),
    ).toBe(true);
    expect(canDeleteAttachment({ uploaderId: 'bob' }, bob)).toBe(true);
    expect(canDeleteAttachment({ uploaderId: 'carol' }, bob)).toBe(false);
    expect(canDeleteAttachment({ uploaderId: 'carol' }, alice)).toBe(true);
});

it('checks plain file descriptions against the server’s types, size and count caps', () => {
    const file = (name: string, size: number, mediaType?: string) => ({
        name,
        size,
        ...(mediaType ? { mediaType } : {}),
    });
    expect(fileProblem(file('shot.PNG', 10))).toBeUndefined();
    expect(fileProblem(file('page.html', 10, 'text/html'))).toBe(
        'page.html: only images, PDFs and plain text can be attached.',
    );
    expect(fileProblem(file('photo.heic', 10, 'image/heic'))).toMatch(/only images/);
    expect(fileProblem(file('huge.gif', ISSUE_ATTACHMENT_MAX_BYTES + 1))).toBe('huge.gif is larger than 5 MB.');
    expect(fileProblem(file('max.gif', ISSUE_ATTACHMENT_MAX_BYTES))).toBeUndefined();
    expect(fileProblem(file('empty.txt', 0))).toBe('empty.txt is empty.');
    expect(Object.keys(ATTACHMENT_EXTENSIONS)).toContain('webp');

    const picked = [file('a.png', 1, 'image/png'), file('b.exe', 1), file('c.pdf', 1), file('d.md', 1)];
    const { accepted, refused } = acceptFiles(picked, ISSUE_ATTACHMENTS_PER_ISSUE - 2);
    // The same objects come back, so a caller keeps its own fields (a URI).
    expect(accepted).toEqual([picked[0], picked[2]]);
    expect(accepted[0]).toBe(picked[0]);
    expect(refused).toEqual([
        'b.exe: only images, PDFs and plain text can be attached.',
        `d.md: an issue can have at most ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments.`,
    ]);
});
