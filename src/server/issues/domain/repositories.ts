import type { IssueWatchState } from '@socio/shared/issues/issue-subscriptions';
import type {
    AgentAttribution,
    DotFiledItem,
    DotFiling,
    DotRequester,
    DotRequestNotice,
    Issue,
    IssueArea,
    IssueAttachment,
    IssueCard,
    IssueComment,
    IssueEvent,
    IssueEventKind,
    IssueKind,
    IssueLabel,
    IssueLinkRef,
    IssuePriority,
    IssueStatus,
    IssueTitle,
} from '@socio/shared/issues/issue-types';

import type { DotActionRow, IssueFilter, IssueWatchSource, StoredAttachment } from '../contract.js';

/**
 * The Board's repositories and read model (CB-110): one per
 * aggregate, async, taking and returning plain domain types. Only
 * `issues/infra` implements them; nothing else touches the Board's tables.
 * Every write works inside or outside a unit of work: outside one it opens
 * its own, so there is a single writer path.
 */

/** An issue's stored fields that change after it is filed. */
export interface IssueFields {
    title?: string;
    body?: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    kind?: IssueKind;
    area?: IssueArea | null;
    assigneeId?: string | null;
    resolution?: string | null;
    closedAt?: number | null;
}

/** A row as stored, soft-delete stamps included (admin views, tests). */
export type StoredRow = Record<string, unknown>;

/** Issue (labels, blocked-by and related links, the number counter). */
export interface IssueRepository {
    /** Live issues in the board's order: priority, then most recently updated. */
    list(filter?: IssueFilter): Promise<Issue[]>;
    byNumber(number: number): Promise<Issue | undefined>;
    byId(id: string): Promise<Issue | undefined>;
    /** By number, deleted or not, with its stamp. */
    withDeleted(number: number): Promise<StoredRow | undefined>;
    /** After the last number handed out, or the highest in use (CB-39). */
    nextNumber(): Promise<number>;
    /** Saves a new issue with its labels; moves the counter past its number. */
    insert(issue: Issue): Promise<void>;
    update(id: string, fields: IssueFields): Promise<void>;
    setLabels(id: string, labels: readonly IssueLabel[]): Promise<void>;
    touch(id: string, now: number): Promise<void>;
    /** Stamps the issue deleted (CB-64). */
    markDeleted(id: string, by: string | null, now: number): Promise<void>;
    /** Live issues `id` waits for (`blockedBy`) or that wait for it (`blocks`). */
    links(id: string, side: 'blockedBy' | 'blocks'): Promise<IssueLinkRef[]>;
    hasLink(fromId: string, toId: string): Promise<boolean>;
    /** Whether `fromId` already waits for `toId`, directly or through others. */
    reaches(fromId: string, toId: string): Promise<boolean>;
    addLink(link: { id: string; fromId: string; toId: string; createdBy: string; createdAt: number }): Promise<void>;
    /** Stamps the live link removed; false when there was none. */
    removeLink(fromId: string, toId: string, by: string, now: number): Promise<boolean>;
    /** Live issues related to `id` (CB-274), either way round. */
    relatedLinks(id: string): Promise<IssueLinkRef[]>;
    /** Whether the two issues have a live related link, in either order. */
    hasRelated(oneId: string, otherId: string): Promise<boolean>;
    addRelated(link: {
        id: string;
        oneId: string;
        otherId: string;
        createdBy: string;
        createdAt: number;
    }): Promise<void>;
    /** Stamps the live related link removed; false when there was none. */
    removeRelated(oneId: string, otherId: string, by: string, now: number): Promise<boolean>;
}

export interface CommentRepository {
    /** Live comments, oldest first. */
    forIssue(issueId: string): Promise<IssueComment[]>;
    insert(comment: IssueComment): Promise<void>;
    edit(id: string, body: string, now: number): Promise<void>;
    markDeleted(id: string, by: string, now: number): Promise<void>;
    /** Stamps the issue's live comments as gone with it. */
    markDeletedWith(issueId: string, by: string | null, parent: string, now: number): Promise<void>;
}

export interface AttachmentRepository {
    /** Live attachments' metadata, oldest first. */
    forIssue(issueId: string): Promise<IssueAttachment[]>;
    /** A live attachment with its bytes. */
    byId(id: string): Promise<StoredAttachment | undefined>;
    withDeleted(id: string): Promise<StoredRow | undefined>;
    liveCount(issueId: string): Promise<number>;
    insert(file: StoredAttachment): Promise<IssueAttachment>;
    markDeleted(id: string, by: string, now: number): Promise<void>;
    /** Stamps the live files of an issue, or of one comment, as gone with it. */
    markDeletedWith(
        owner: { issueId: string } | { commentId: string },
        by: string | null,
        parent: string,
        now: number,
    ): Promise<void>;
}

/** IssueHistory: append-only. */
export interface IssueHistoryRepository {
    append(event: Omit<IssueEvent, 'agent'>): Promise<void>;
    /** Oldest first. */
    forIssue(issueId: string): Promise<IssueEvent[]>;
    /** Recorded status events, by persisted sequence, never inferred from current status. */
    statusEvents(
        issueId: string,
        after: number,
        limit: number,
    ): Promise<
        Array<{
            sequence: number;
            kind: 'created' | 'imported' | 'status';
            at: number;
            from: string | null;
            to: string | null;
        }>
    >;
    /** The newest row's position, 0 when there is none (the history's cursor). */
    lastSeq(): Promise<number>;
    /** An issue's rows after `seq`, oldest first, by kind or actor. */
    after(
        seq: number,
        filter: { issueId: string; kind?: IssueEventKind; actorId?: string },
    ): Promise<Array<{ id: string; kind: IssueEventKind }>>;
}

export interface VoteRepository {
    /** The person's live vote on the item, by id. */
    live(issueId: string, userId: string): Promise<string | undefined>;
    insert(vote: {
        id: string;
        issueId: string;
        userId: string;
        dotId: string | null;
        createdAt: number;
    }): Promise<void>;
    withdraw(id: string, now: number): Promise<void>;
    count(issueId: string): Promise<number>;
    counts(): Promise<Map<string, number>>;
    mine(userId: string): Promise<Set<string>>;
}

/** A triage row as stored (CB-30). */
export interface TriageRow {
    issueId: string;
    state: 'pending' | 'proposed' | 'applied' | 'ignored' | 'failed';
    kind: IssueKind | null;
    area: IssueArea | null;
    priority: IssuePriority | null;
    labels: IssueLabel[] | null;
    /** Suggested component refs (CB-442); null on rows from before them. */
    components: string[] | null;
    reason: string | null;
    /** 'admins' when only admins may read the reason (CB-442); null on older rows. */
    reasonAudience: 'admins' | null;
    commentId: string | null;
    error: string | null;
    createdAt: number;
    decidedAt: number | null;
    decidedBy: string | null;
}

export interface TriageRepository {
    get(issueId: string): Promise<TriageRow | undefined>;
    startedSince(since: number): Promise<number>;
    insertPending(issueId: string, now: number): Promise<void>;
    propose(
        issueId: string,
        fields: {
            kind: IssueKind;
            area: IssueArea | null;
            priority: IssuePriority;
            labels: IssueLabel[];
            components: string[];
            reason: string;
            reasonAudience?: 'admins' | null;
        },
        commentId: string,
    ): Promise<void>;
    fail(issueId: string, error: string): Promise<void>;
    /** Every pending row ends failed; how many. */
    failPending(error: string): Promise<number>;
    /** From `proposed` only; false when it wasn't. */
    decide(issueId: string, state: 'applied' | 'ignored', userId: string, now: number): Promise<boolean>;
}

/** Dot request: its key, the requesters and the notices. */
export interface DotRequestRepository {
    /** The request's capability, when the issue is one. */
    capability(issueId: string): Promise<string | undefined>;
    insert(request: { issueId: string; key: string; capability: string; createdAt: number }): Promise<void>;
    hasRequester(issueId: string, dotId: string, userId: string): Promise<boolean>;
    addRequester(requester: {
        id: string;
        issueId: string;
        dotId: string;
        userId: string;
        why: string;
        example: string;
        createdAt: number;
    }): Promise<void>;
    demandOf(issueId: string): Promise<number>;
    /** Oldest first. */
    requesters(issueId: string): Promise<DotRequester[]>;
    /** Requests made after `since`, by this Dot or for this person. */
    countSince(by: { dotId: string } | { userId: string }, since: number): Promise<number>;
    markAnnounced(issueId: string, dotId: string, userId: string, now: number): Promise<void>;
    /** The Dots that asked are to be told again. */
    resetAnnounced(issueId: string): Promise<void>;
    /** The Dots (ids) that asked for the person, first asked first. */
    dotsFor(issueId: string, userId: string): Promise<string[]>;
    addNotice(notice: {
        id: string;
        issueId: string;
        userId: string;
        status: 'done' | 'wont_fix';
        resolution: string | null;
        createdAt: number;
    }): Promise<void>;
    /** Marks one of the person's notices seen; false when it wasn't theirs or new. */
    markSeen(userId: string, id: string, now: number): Promise<boolean>;
}

/** A connected agent's board action (CB-90). */
export interface AgentActionRow {
    id: string;
    issueId: string;
    action: 'create' | 'comment' | 'vote' | 'unvote' | 'update';
    targetId: string | null;
    grantId: string;
    clientId: string;
    clientName: string;
    label: string;
    userId: string;
    createdAt: number;
}

/** BoardAudit: what Dots and connected agents did on the board. */
export interface BoardAuditRepository {
    recordDot(row: DotActionRow): Promise<void>;
    recordAgent(row: AgentActionRow): Promise<void>;
    /** The Dot filing of the issue, if a Dot filed it. */
    dotFiling(issueId: string): Promise<DotFiling | undefined>;
    /** The Dot comments' attributions, by comment id, oldest first. */
    dotComments(issueId: string): Promise<Array<[string, DotFiling]>>;
    /** New, attributed history mutations, by event id; legacy events stay unattributed. */
    dotEvents(issueId: string): Promise<Array<[string, DotFiling]>>;
    /** Actions of these kinds after `since`, by this Dot or for this person. */
    dotCountSince(
        actions: readonly DotActionRow['action'][],
        by: { dotId: string } | { userId: string },
        since: number,
    ): Promise<number>;
    /** A person's actions from scheduled turns with these causes, in [from, to]. */
    dotByCause(
        userId: string,
        causeIds: readonly string[],
        from: number,
        to: number,
    ): Promise<
        Array<{
            issueId: string;
            action: DotActionRow['action'];
            createdAt: number;
        }>
    >;
    /** A Dot's actions at or before `before`, newest first (its admin page). */
    dotActivity(dotId: string, before: number, limit: number): Promise<DotActionRow[]>;
    /** How many items the Dot filed. */
    dotFilingCount(dotId: string): Promise<number>;
    /** The issue's agent actions, oldest first, with their attributions. */
    agentActions(issueId: string): Promise<
        Array<{
            action: AgentActionRow['action'];
            targetId: string | null;
            attribution: AgentAttribution;
        }>
    >;
}

/** A Dot request as its Dot is told about it, with the issue's id. */
export interface RequestSummaryRow {
    issueId: string;
    number: number;
    capability: string;
    status: IssueStatus;
    resolution: string | null;
    requestedAt: number;
    closedAt: number | null;
}

/** An agent's action with what it acted on, for the admin audit. */
export interface AgentActivityRow {
    action: AgentActionRow['action'];
    targetId: string | null;
    userId: string;
    createdAt: number;
    number: number | null;
    title: string | null;
    /** The history row's kind, for an update. */
    field: string | null;
}

/**
 * The Board's read model: views across its own tables (joins allowed
 * within the context). Other contexts ask through `IssueTitles`.
 */
export interface BoardQueries {
    /** Live issues' number, title and status in the list's order. */
    titles(options: { open: boolean }): Promise<IssueTitle[]>;
    cards(numbers: readonly number[]): Promise<IssueCard[]>;
    /** Live issues' text for board search, in the list's order. */
    texts(): Promise<Array<IssueTitle & { id: string; body: string; kind: IssueKind }>>;
    /** By issue id: the numbers of its blockers not yet closed. */
    openBlockerNumbers(): Promise<Map<string, number[]>>;
    /** By id: number, title and status; deleted ones only with `deleted`. */
    titlesById(ids: readonly string[], options?: { deleted?: boolean }): Promise<Map<string, IssueTitle>>;
    /** The open request with this key, oldest first. */
    openRequest(key: string): Promise<{ issueId: string; capability: string } | undefined>;
    /** Demand per issue id, for every live Dot request. */
    demand(): Promise<Map<string, number>>;
    /** The Dot's requests for the person, open or closed, the newest 20. */
    requestSummaries(
        dotId: string,
        userId: string,
        options: { closed: boolean; unannounced?: boolean },
    ): Promise<RequestSummaryRow[]>;
    /** The person's unseen notices, newest first, without the Dots' names. */
    notices(userId: string): Promise<Array<Omit<DotRequestNotice, 'dots'> & { issueId: string }>>;
    filedFor(dotId: string, userId: string, limit: number): Promise<DotFiledItem[]>;
    agentActivity(grantId: string, before: number, limit: number): Promise<AgentActivityRow[]>;
}

export interface IssueWatchRow extends IssueWatchSource {
    id: string;
    userId: string;
    targetStatus: IssueStatus;
    state: IssueWatchState;
    fingerprint: string;
    cursor: number;
    createdAt: number;
    triggeredAt: number | null;
    cancelledAt: number | null;
    cancelReason: 'unsubscribed' | 'issue_unavailable' | 'person_unavailable' | null;
    cancelSourceKind: IssueWatchSource['sourceKind'] | null;
    cancelSourceId: string | null;
    cancelThreadId: string | null;
    cancelCauseId: string | null;
}
export interface IssueWatchMember {
    issueId: string;
    number: number;
    status: IssueStatus;
}
export interface IssueWatchOutbox {
    id: string;
    watchId: string;
    userId: string;
    title: string;
    message: string;
    path: string;
    createdAt: number;
    claimedAt: number | null;
}
export interface IssueWatchRepository {
    insert(watch: IssueWatchRow, members: IssueWatchMember[]): Promise<void>;
    activeDuplicate(userId: string, fingerprint: string): Promise<IssueWatchRow | undefined>;
    activeCount(userId: string): Promise<number>;
    forUser(userId: string, limit: number, offset: number): Promise<IssueWatchRow[]>;
    owned(userId: string, id: string): Promise<IssueWatchRow | undefined>;
    members(id: string): Promise<IssueWatchMember[]>;
    watching(after: string | undefined, limit: number): Promise<IssueWatchRow[]>;
    statusEvents(
        ids: string[],
        after: number,
        through: number,
        limit: number,
    ): Promise<Array<{ sequence: number; issueId: string; to: string | null }>>;
    memberStatus(watchId: string, issueId: string, status: IssueStatus): Promise<void>;
    cursor(id: string, value: number): Promise<void>;
    ready(id: string, outbox: IssueWatchOutbox): Promise<void>;
    pending(limit: number): Promise<IssueWatchOutbox[]>;
    claim(id: string, now: number): Promise<IssueWatchOutbox | undefined>;
    cancel(
        id: string,
        reason: NonNullable<IssueWatchRow['cancelReason']>,
        now: number,
        source?: IssueWatchSource,
    ): Promise<void>;
}

/** Everything the Board's services need from storage. */
/**
 * How an item came from a turn (CB-194): a person's "File issue" under a
 * failed run, or a socio's filing during its turn.
 */
export const ISSUE_RUN_VIAS = ['report', 'socio'] as const;
export type IssueRunVia = (typeof ISSUE_RUN_VIAS)[number];
export interface IssueRunRow {
    issueId: string;
    runId: string;
    threadId: string;
    via: IssueRunVia;
    /** The person, or `dot:<id>`, who filed it. */
    linkedBy: string;
    createdAt: number;
}
/** Items' links to the turns they were filed from (`issue_runs`). */
export interface IssueRunRepository {
    /** Links an item to a turn; linking it again changes nothing. */
    link(row: IssueRunRow): Promise<void>;
    forIssue(issueId: string): Promise<IssueRunRow[]>;
}

/** One stored component tag (CB-442), as `issue_components` holds it. */
export interface ComponentRow {
    issueId: string;
    ref: string;
    kind: 'plugin' | 'app' | 'plugins' | 'apps';
    targetId: string | null;
    generation: number | null;
    label: string;
    audience: 'admins' | 'members' | null;
    addedBy: string;
    addedAt: number;
}

export interface ComponentRepository {
    /** One issue's tags, by ref. */
    forIssue(issueId: string): Promise<ComponentRow[]>;
    /** Every live issue's tags (the board's list). */
    all(): Promise<ComponentRow[]>;
    /** Replaces an issue's tags with `rows`, and keeps their names. */
    replace(issueId: string, rows: readonly ComponentRow[]): Promise<void>;
    /** The name and audience of every ref the issue was ever tagged with, as last tagged. */
    names(issueId: string): Promise<Array<Pick<ComponentRow, 'ref' | 'label' | 'audience'>>>;
}

export interface BoardRepositories {
    issues: IssueRepository;
    components: ComponentRepository;
    watches: IssueWatchRepository;
    comments: CommentRepository;
    attachments: AttachmentRepository;
    history: IssueHistoryRepository;
    votes: VoteRepository;
    triage: TriageRepository;
    requests: DotRequestRepository;
    audit: BoardAuditRepository;
    queries: BoardQueries;
    runs: IssueRunRepository;
}
