import type { IssueComponentLabel } from './issue-components.js';

/**
 * The issue tracker's vocabulary, shared by the server and the client.
 * Issues are team-shared: everyone signed in reads them; members file into
 * `triage` and comment; admins triage, edit and delete.
 */
export const ISSUE_STATUSES = [
    'triage',
    'open',
    'ready',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'wont_fix',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
/** Statuses that close an issue (`closedAt` is set). */
export const CLOSED_ISSUE_STATUSES: readonly IssueStatus[] = ['done', 'wont_fix'];

export const ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_KINDS = [
    'bug',
    'feature',
    'improvement',
    'docs',
    'chore',
    /** A capability a Dot asked for (`request_capability`). */
    'request',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/**
 * Which part of Socio an issue is about. An id that is also a
 * client module's (`chat`, `spaces`, ...) is the default when reporting
 * from that module's pages.
 */
export const ISSUE_AREAS = [
    'server',
    'client',
    /** Dot chat in the web app. */
    'chat',
    /** The home page at `/`. */
    'homepage',
    /** Schedules, goals and jobs, and the tasks under Scheduled & activity. */
    'schedules',
    'telegram',
    'model',
    'runs',
    'spaces',
    'learning',
    'computers',
    'auth',
    'deploy',
    'docs',
    'tests',
] as const;
export type IssueArea = (typeof ISSUE_AREAS)[number];

/**
 * A fixed label set. `owner:*` marks work owned by someone who is not an app
 * user (the lead agent, or the user outside the app).
 */
export const ISSUE_LABELS = [
    'owner:lead',
    'owner:user',
    'needs-decision',
    'regression',
    'security',
    'ux',
    'performance',
    'good-first-issue',
    'dot-request',
] as const;
export type IssueLabel = (typeof ISSUE_LABELS)[number];
/** The label on every capability request a Dot files. */
export const DOT_REQUEST_LABEL = 'dot-request' satisfies IssueLabel;

/**
 * `dot`: filed by a Dot with `file_improvement` (CB-31); `agent`: by a
 * connected agent for its person, with `file_issue` (CB-90).
 */
export type IssueSource = 'web' | 'import' | 'dot' | 'agent';

export interface Issue {
    id: string;
    /** Shown as `CB-<number>`. */
    number: number;
    title: string;
    /** Markdown. */
    body: string;
    status: IssueStatus;
    priority: IssuePriority;
    kind: IssueKind;
    area: IssueArea | null;
    labels: IssueLabel[];
    /** The user who filed it, or `import`. */
    reporterId: string;
    assigneeId: string | null;
    /** How it was resolved, e.g. "Fixed in 380fb4c". */
    resolution: string | null;
    source: IssueSource;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
    /**
     * Dot requests only (kind `request`): how many Dot and user pairs asked
     * for this capability. Set by the routes; absent on other issues.
     */
    demand?: number;
    /** Live upvotes, one per person (CB-83). Set by the routes when any. */
    votes?: number;
    /** Set by the routes, when the signed-in person has voted for it. */
    voted?: boolean;
    /**
     * Blocked-by links (CB-29): the numbers of the issue's blockers that are
     * not yet done or won't-fix. Set by the routes when there are any.
     */
    openBlockers?: number[];
    /**
     * The plugins and apps it is about (CB-442): the refs the reader may
     * see, sorted. Set by the routes; hidden ones are left out entirely.
     */
    components?: string[];
}

/**
 * Blocked-by links (CB-29). "A is blocked by B" means B should be finished
 * before A is started. A blocker counts as satisfied once it is closed
 * (done or won't fix: nothing more is coming, so waiting is pointless).
 */
export const isBlockerSatisfied = (status: IssueStatus) => CLOSED_ISSUE_STATUSES.includes(status);

/**
 * Automatic triage (CB-30): what the workspace's model proposes for a new
 * issue in triage. Nothing changes until an admin applies it; the proposal
 * is also posted as a comment from Socio.
 */
export const TRIAGE_STATES = ['proposed', 'applied', 'ignored'] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];
/** Kinds and labels the model may propose: not the Dot-request ones. */
export const TRIAGE_KINDS = ISSUE_KINDS.filter((kind): kind is Exclude<IssueKind, 'request'> => kind !== 'request');
export const TRIAGE_LABELS = ISSUE_LABELS.filter(
    (label): label is Exclude<IssueLabel, 'dot-request'> => label !== 'dot-request',
);
export interface TriageProposal {
    state: TriageState;
    kind: IssueKind;
    area: IssueArea | null;
    priority: IssuePriority;
    labels: IssueLabel[];
    /**
     * Suggested components (CB-442): only the ones the reader may see; their
     * labels are in the detail's `components`. The comment never names them.
     */
    components: string[];
    /**
     * One line from the model. When it was shown plugins or apps by name,
     * only admins get its words; others, and the comment, get fixed text
     * (CB-442).
     */
    reason: string;
    /** The comment that carries the proposal. */
    commentId: string | null;
    createdAt: number;
    /** When an admin applied or ignored it, and who. */
    decidedAt: number | null;
    decidedBy: string | null;
}

/** The other end of a blocked-by or related link, as the detail lists it. */
export interface IssueLinkRef {
    number: number;
    title: string;
    status: IssueStatus;
}

/**
 * How an issue is linked to another (CB-274), from the first one's side:
 * `related` has no direction; `blocks` means the other waits for it;
 * `blocked_by` means it waits for the other (CB-29). A pair has one link.
 */
export const ISSUE_LINK_RELATIONS = ['related', 'blocks', 'blocked_by'] as const;
export type IssueLinkRelation = (typeof ISSUE_LINK_RELATIONS)[number];

export interface IssueComment {
    id: string;
    issueId: string;
    authorKind: 'user' | 'agent' | 'system';
    authorId: string | null;
    body: string;
    createdAt: number;
    editedAt: number | null;
    /**
     * A Dot's comment (`comment_on_improvement`, CB-84): the Dot and the
     * person it acted for. Set by the routes; the author is `dot:<id>`.
     */
    dot?: DotFiling;
    /**
     * A connected agent's comment (CB-90): the agent and its person, who is
     * the author. Set by the routes.
     */
    agent?: AgentAttribution;
}

/** One history row: `kind` names the field or action that changed. */
export type IssueEventKind =
    | 'created'
    | 'imported'
    | 'title'
    | 'body'
    | 'status'
    | 'priority'
    | 'kind'
    | 'area'
    | 'labels'
    /** Components (CB-442): the sorted refs before and after, as JSON arrays; refs the reader can't see are taken out. */
    | 'components'
    | 'assignee'
    | 'resolution'
    | 'comment_added'
    | 'comment_edited'
    | 'comment_deleted'
    | 'attachment_added'
    | 'attachment_deleted'
    /** Blocked-by links (CB-29): `toValue` is the blocker's key (`CB-12`) when added, `fromValue` when removed. */
    | 'blocked_by'
    /** The reverse, on the blocker: the key of the issue it now blocks, or no longer does. */
    | 'blocks'
    /** Related links (CB-274), on both issues: `toValue` is the other's key when linked, `fromValue` when unlinked. */
    | 'related'
    /** Automatic triage (CB-30): a proposal posted, applied or ignored. */
    | 'triage'
    /** The issue was deleted (CB-64: hidden and kept, for the admin view). */
    | 'deleted';
export interface IssueEvent {
    id: string;
    issueId: string;
    actorId: string | null;
    kind: IssueEventKind;
    fromValue: string | null;
    toValue: string | null;
    createdAt: number;
    /** Made by a socio for its acting person; only newly recorded mutations. */
    dot?: DotFiling;
    /** Made by a connected agent for `actorId` (CB-90). Set by the routes. */
    agent?: AgentAttribution;
}

/** Attachment types accepted, detected from the file's content. */
export const ISSUE_ATTACHMENT_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
] as const;
export type IssueAttachmentType = (typeof ISSUE_ATTACHMENT_TYPES)[number];
export const ISSUE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ISSUE_ATTACHMENTS_PER_ISSUE = 10;

/** Attachment metadata; the bytes are at `/api/issue-attachments/<id>`. */
export interface IssueAttachment {
    id: string;
    issueId: string;
    /** Set when the file belongs to a comment. */
    commentId: string | null;
    name: string;
    mediaType: IssueAttachmentType;
    size: number;
    sha256: string;
    uploaderId: string;
    createdAt: number;
}

export interface IssueDetail {
    issue: Issue;
    comments: IssueComment[];
    attachments: IssueAttachment[];
    events: IssueEvent[];
    /** Issues this one waits for (CB-29), by number. Always set by the server. */
    blockedBy?: IssueLinkRef[];
    /** Issues waiting for this one (CB-29), by number. Always set by the server. */
    blocks?: IssueLinkRef[];
    /** Issues related to this one, with no direction (CB-274). Always set by the server. */
    related?: IssueLinkRef[];
    /** The automatic triage proposal for this issue (CB-30), if one was made. */
    triage?: TriageProposal;
    /** Dot requests only: who asked, oldest first. */
    requesters?: DotRequester[];
    /** Filed by a Dot (CB-31): the Dot and the person it acted for. */
    filedBy?: DotFiling;
    /** Filed by a connected agent (CB-90) for the reporter, its person. */
    filedByAgent?: AgentAttribution;
    /** Display names for the user ids referenced above. */
    users: Record<string, string>;
    /** How each component ref on the issue, its history and its proposal reads (CB-442). Always set by this server. */
    components?: Record<string, IssueComponentLabel>;
}

/**
 * One Dot and user pair that asked for a capability. Names are in the
 * detail's `users` (`dot:<id>` for the Dot), like authors elsewhere.
 */
export interface DotRequester {
    dotId: string;
    userId: string;
    createdAt: number;
}

/**
 * What started the Dot's turn: a chat (web or voice), Telegram, a
 * schedule, or a goal the person set (a goal's own scheduled turn).
 */
export const DOT_FILING_TRIGGERS = ['chat', 'telegram', 'scheduled', 'goal'] as const;
export type DotFilingTrigger = (typeof DOT_FILING_TRIGGERS)[number];

/**
 * Who filed an issue from a Dot turn (CB-31), or added a comment (CB-84):
 * the Dot and the person it acted for, both always set. Names are in the detail's `users`
 * (`dot:<id>` for the Dot).
 */
export interface DotFiling {
    dotId: string;
    /** Set when it was the person's own Dot (then the same as `userId`). */
    dotOwnerId: string | null;
    userId: string;
    trigger: DotFilingTrigger;
    /** For `goal`: the goal's id; for `scheduled`: the task's. */
    causeId: string | null;
    createdAt: number;
}

/**
 * `GET /api/issues/filed?dot=<id>` (CB-89): an item a Dot filed on the
 * board for the person asking, as their Dot's home page lists it.
 */
export interface DotFiledItem extends IssueTitle {
    filedAt: number;
}

/**
 * A connected agent's action on the board (CB-90): the OAuth client, the
 * grant, the person's label for it ("Claude Code on laptop"), and the
 * person it acted for, who is the record's author. Shown as "‹label› for
 * ‹person›".
 */
export interface AgentAttribution {
    grantId: string;
    clientId: string;
    clientName: string;
    label: string;
    userId: string;
    createdAt: number;
}

/** One line of a grant's board audit (CB-90), newest first. */
export interface AgentBoardActivity {
    at: number;
    action: 'create' | 'comment' | 'vote' | 'unvote' | 'update';
    /** `CB-12`, or null once the item is gone. */
    issue: string | null;
    /** The comment, vote or history row it made; null for a filing. */
    targetId: string | null;
    /** The person it acted for. */
    userId: string;
    summary: string;
}

/** A Dot request that closed, told to one of the users who asked. */
export interface DotRequestNotice {
    id: string;
    number: number;
    capability: string;
    status: 'done' | 'wont_fix';
    resolution: string | null;
    /** The names of this user's Dots that asked. */
    dots: string[];
    createdAt: number;
}

/** `GET /api/dot-requests/notices`: the caller's unseen notices. */
export interface DotRequestNotices {
    notices: DotRequestNotice[];
}

/**
 * An issue as the board's cards and rows show it (`GET /api/issues`): the
 * start of its description instead of the description, and no id,
 * reporter, resolution or dates but the last update. The number is its
 * key. The detail (`GET /api/issues/:number`) has the rest.
 */
export interface IssueSummary extends Pick<
    Issue,
    | 'number'
    | 'title'
    | 'status'
    | 'priority'
    | 'kind'
    | 'area'
    | 'labels'
    | 'assigneeId'
    | 'updatedAt'
    | 'demand'
    | 'votes'
    | 'voted'
    | 'openBlockers'
> {
    /** The description as one plain line, at most 160 characters. */
    excerpt: string;
    /**
     * The component refs the reader may see (CB-442), sorted; labels in
     * `IssueList.components`. Always set by this server; optional for
     * clients of an older one.
     */
    components?: string[];
}

export interface IssueList {
    issues: IssueSummary[];
    /** Names for the assignees. */
    users: Record<string, string>;
    /** How each component ref on the list reads for this reader (CB-442). Always set by this server. */
    components?: Record<string, IssueComponentLabel>;
}

/**
 * `GET /api/issues/search?q=`: the live issues whose key, title or
 * description has every word of `q` (case and accents folded, anywhere in
 * a word), in the list's order. The board filters its list with them.
 */
export interface IssueSearch {
    numbers: number[];
}

/** A description as one plain line: markdown syntax dropped, shortened. */
export function issueExcerpt(markdown: string, max = 160) {
    const text = markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
        .replace(/[`*_~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * An issue as the board's list has it; the same on the server and client.
 * `excerpt` makes the excerpt (the server keeps them per description).
 */
export function issueSummary(issue: Issue, excerpt: (body: string) => string = issueExcerpt): IssueSummary {
    const summary: IssueSummary = {
        number: issue.number,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        kind: issue.kind,
        area: issue.area,
        labels: issue.labels,
        assigneeId: issue.assigneeId,
        updatedAt: issue.updatedAt,
        excerpt: excerpt(issue.body),
        components: issue.components ?? [],
    };
    if (issue.demand !== undefined) {
        summary.demand = issue.demand;
    }
    if (issue.votes !== undefined) {
        summary.votes = issue.votes;
    }
    if (issue.voted !== undefined) {
        summary.voted = issue.voted;
    }
    if (issue.openBlockers !== undefined) {
        summary.openBlockers = issue.openBlockers;
    }
    return summary;
}

/**
 * A live issue as the ⌘K palette's issue commands have it
 * (`GET /api/issues/titles`, `?open=true` for open ones only): no body,
 * labels or people.
 */
export interface IssueTitle {
    number: number;
    title: string;
    status: IssueStatus;
}

/**
 * A live issue as a chat message's issue cards show it
 * (`GET /api/issues/cards?numbers=85,86`): a short description, no full body,
 * labels or people.
 */
export interface IssueCard extends IssueTitle {
    /** Plain-text description, at most 160 characters. */
    excerpt: string;
    kind: IssueKind;
    priority: IssuePriority;
    area: IssueArea | null;
}
/** The most issues one `GET /api/issues/cards` asks for. */
export const ISSUE_CARDS_MAX = 50;

/**
 * `GET /api/issues/assignees` (admins): the users an issue can be assigned
 * to, and the deactivated people who can't be any more (an issue may still
 * name one).
 */
export interface IssueAssignees {
    users: Array<{ id: string; name: string }>;
    deactivated: Array<{ id: string; name: string }>;
}

export interface IssueImportResult {
    created: number[];
    skipped: number[];
}

export const issueKey = (number: number) => `CB-${number}`;

/**
 * A Markdown link to an issue's page, for messages a socio relays in chat
 * (CB-306): the inline issue card renders only for issue links, so a plain
 * `CB-N` mention shows no card. The path mirrors the client's `issuePath`.
 */
export const issueLink = (number: number) => `[${issueKey(number)}](/issues/${issueKey(number)})`;
