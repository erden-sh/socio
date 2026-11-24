import { foldText } from '../pages/page-search.js';
import { isAdmin } from '../roles.js';
import type { User } from '../types.js';

/**
 * The board's logic, for the web and the native app alike: the words for
 * statuses, priorities, kinds and areas, the columns, the filters and the
 * "Socio requests" lane, the sorts and counts, history rows in words, and
 * which controls a person sees. Moved from the web's
 * `modules/issues/issue-meta.ts`; the server decides every change,
 * these only hide controls and lay the list out.
 */
import {
    CLOSED_ISSUE_STATUSES,
    DOT_REQUEST_LABEL,
    ISSUE_STATUSES,
    issueKey,
    type Issue,
    type IssueArea,
    type IssueComment,
    type IssueEvent,
    type IssueKind,
    type IssueLabel,
    type IssuePriority,
    type IssueStatus,
    type IssueSummary,
} from './issue-types.js';

/** `CB-12` (or `12`) as an issue number. */
export const issueNumber = (key: string | undefined) => {
    const match = key?.match(/^(?:CB-)?(\d+)$/i);
    return match ? Number(match[1]) : undefined;
};

/** An issue's path in the app: `/issues/CB-12`. */
export const issuePath = (number: number) => `/issues/${issueKey(number)}`;

export const STATUS_LABEL: Record<IssueStatus, string> = {
    triage: 'Triage',
    open: 'Open',
    ready: 'Ready',
    in_progress: 'In progress',
    in_review: 'In review',
    blocked: 'Blocked',
    done: 'Done',
    wont_fix: 'Won’t fix',
};
export const PRIORITY_LABEL: Record<IssuePriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
};
export const KIND_LABEL: Record<IssueKind, string> = {
    bug: 'Bug',
    feature: 'Feature',
    improvement: 'Improvement',
    docs: 'Docs',
    chore: 'Chore',
    request: 'Socio request',
};
export const AREA_LABEL: Record<IssueArea, string> = {
    server: 'Server',
    client: 'Client',
    chat: 'Web chat',
    homepage: 'Homepage',
    schedules: 'Schedules',
    telegram: 'Telegram',
    model: 'Model',
    runs: 'Runs',
    spaces: 'Spaces',
    learning: 'Learning',
    computers: 'Computers',
    auth: 'Auth',
    deploy: 'Deploy',
    docs: 'Docs',
    tests: 'Tests',
};
export const areaLabel = (area: IssueArea) => AREA_LABEL[area] ?? area;

/** The board's columns; won't fix is shown on request. */
export const BOARD_STATUSES: readonly IssueStatus[] = ISSUE_STATUSES.filter((status) => status !== 'wont_fix');

// --- Order -----------------------------------------------------------------------

const PRIORITY_RANK: Record<IssuePriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};
/** A priority's place on the board, critical first (an unknown one sorts as low, as the server's SQL does). */
export const priorityRank = (priority: IssuePriority) => PRIORITY_RANK[priority] ?? PRIORITY_RANK.low;

/**
 * The server's board order (`boardOrder`, `src/server/issues/infra/sqlite/issues.ts`)
 * as a comparator: priority, then most recently updated, then the newest
 * number. A client that keeps rows by key (the app's snapshot cache) sorts
 * with it to show them in the order `GET /api/issues` answers.
 */
export const compareBoardOrder = (
    a: Pick<IssueSummary, 'priority' | 'updatedAt' | 'number'>,
    b: Pick<IssueSummary, 'priority' | 'updatedAt' | 'number'>,
) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt - a.updatedAt || b.number - a.number;

// --- Filters ---------------------------------------------------------------------

export interface IssueFilters {
    q: string;
    status: IssueStatus[];
    priority: IssuePriority[];
    kind: IssueKind[];
    area: IssueArea[];
    label: IssueLabel[];
}
export type FacetName = Exclude<keyof IssueFilters, 'q'>;
export const NO_FILTERS: IssueFilters = {
    q: '',
    status: [],
    priority: [],
    kind: [],
    area: [],
    label: [],
};
/**
 * The "Socio requests" lane: the saved filter for capability requests
 * socios filed, by their label. On when that is the only label chosen.
 */
export const dotRequestsOnly = (filters: IssueFilters) =>
    filters.label.length === 1 && filters.label[0] === DOT_REQUEST_LABEL;
export const toggleDotRequests = (filters: IssueFilters): IssueFilters => ({
    ...filters,
    label: dotRequestsOnly(filters) ? [] : [DOT_REQUEST_LABEL],
});
export const isDotRequest = (issue: Pick<Issue, 'labels'>) => issue.labels.includes(DOT_REQUEST_LABEL);

export const filtersActive = (filters: IssueFilters) =>
    !!filters.q.trim() ||
    (['status', 'priority', 'kind', 'area', 'label'] as const).some((facet) => filters[facet].length > 0);

/**
 * The issues matching the search and the facets (any selected value
 * within a facet, every facet). Keeps the order it is given. The search is
 * the server's `matches` when it has answered (every word in the key,
 * title or description, anywhere in a word; case and accents folded);
 * until then the same over the key, title and excerpt, the list having no
 * descriptions (CB-71).
 */
export function filterIssues(issues: readonly IssueSummary[], filters: IssueFilters, matches?: ReadonlySet<number>) {
    const words = foldText(filters.q).split(' ').filter(Boolean);
    const any = <T>(chosen: readonly T[], value: T) => !chosen.length || chosen.includes(value);
    return issues.filter((issue) => {
        if (!any(filters.status, issue.status)) {
            return false;
        }
        if (!any(filters.priority, issue.priority)) {
            return false;
        }
        if (!any(filters.kind, issue.kind)) {
            return false;
        }
        if (filters.area.length && !(issue.area && filters.area.includes(issue.area))) {
            return false;
        }
        if (filters.label.length && !filters.label.some((label) => issue.labels.includes(label))) {
            return false;
        }
        if (!words.length) {
            return true;
        }
        if (matches) {
            return matches.has(issue.number);
        }
        const text = foldText(`${issueKey(issue.number)} ${issue.title} ${issue.excerpt}`);
        return words.every((word) => text.includes(word));
    });
}

/** Most votes first (CB-83); ties keep the order given. */
export const byVotes = (issues: readonly IssueSummary[]) => [...issues].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));

/** Issues per status, every status present (empty when none). */
export function groupByStatus(issues: readonly IssueSummary[]) {
    const groups = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, [] as IssueSummary[]])) as Record<
        IssueStatus,
        IssueSummary[]
    >;
    for (const issue of issues) {
        groups[issue.status].push(issue);
    }
    return groups;
}

/** The header's counts: open (not closed), in progress, done. */
export function issueCounts(issues: readonly IssueSummary[]) {
    return {
        open: issues.filter((issue) => !CLOSED_ISSUE_STATUSES.includes(issue.status)).length,
        inProgress: issues.filter((issue) => issue.status === 'in_progress').length,
        done: issues.filter((issue) => issue.status === 'done').length,
    };
}

// --- Who may do what (the server enforces the same; this hides controls) ---------

/** Admins change every field; members none (they file and comment). */
export const canTriage = (user: User) => isAdmin(user);
/** Title and description: admins always; members their own, in triage. */
export const canEditText = (issue: Pick<Issue, 'reporterId' | 'status'>, user: User) =>
    isAdmin(user) || (issue.reporterId === user.id && issue.status === 'triage');
export const canEditComment = (comment: Pick<IssueComment, 'authorKind' | 'authorId'>, user: User) =>
    comment.authorKind === 'user' && comment.authorId === user.id;
/** Authors and admins; a socio's comment also the person it was for. */
export const canDeleteComment = (comment: Pick<IssueComment, 'authorId' | 'dot'>, user: User) =>
    isAdmin(user) || comment.authorId === user.id || comment.dot?.userId === user.id;
export const canDeleteAttachment = (attachment: { uploaderId: string }, user: User) =>
    isAdmin(user) || attachment.uploaderId === user.id;

// --- History ---------------------------------------------------------------------

/** A history row in words: "changed status from Triage to Open". */
export function eventText(event: IssueEvent, users: Record<string, string> = {}): string {
    const from = event.fromValue;
    const to = event.toValue;
    const value = (raw: string | null) => {
        if (raw === null || raw === '') {
            return 'none';
        }
        if (event.kind === 'status') {
            return STATUS_LABEL[raw as IssueStatus] ?? raw;
        }
        if (event.kind === 'assignee') {
            return users[raw] ?? raw;
        }
        if (event.kind === 'priority') {
            return PRIORITY_LABEL[raw as IssuePriority] ?? raw;
        }
        if (event.kind === 'kind') {
            return KIND_LABEL[raw as IssueKind] ?? raw;
        }
        if (event.kind === 'area') {
            return areaLabel(raw as IssueArea);
        }
        return raw;
    };
    switch (event.kind) {
        case 'created':
            return 'filed the issue';
        case 'imported':
            return 'imported the issue';
        case 'title':
            return `renamed the issue to “${to ?? ''}”`;
        case 'assignee':
            return to ? `assigned ${value(to)}` : 'removed the assignee';
        case 'body':
            return 'edited the description';
        case 'comment_added':
            return 'commented';
        case 'comment_edited':
            return 'edited a comment';
        case 'comment_deleted':
            return 'deleted a comment';
        case 'attachment_added':
            return `attached ${to ?? 'a file'}`;
        case 'attachment_deleted':
            return `removed ${from ?? 'a file'}`;
        case 'deleted':
            return 'deleted the issue';
        case 'labels':
            return `changed labels from ${value(from)} to ${value(to)}`;
        case 'resolution':
            return to ? `set the resolution: ${to}` : 'cleared the resolution';
        case 'blocked_by':
            return to ? `made it wait for ${to}` : `lifted the wait for ${from}`;
        case 'blocks':
            return to ? `made ${to} wait for it` : `lifted ${from}’s wait for it`;
        case 'related':
            return to ? `linked it to ${to} as related` : `unlinked ${from}`;
        case 'triage':
            return to === 'proposed'
                ? 'proposed a triage'
                : to === 'applied'
                  ? 'applied the triage proposal'
                  : 'ignored the triage proposal';
        default:
            return `changed ${event.kind} from ${value(from)} to ${value(to)}`;
    }
}
