/**
 * What other features may know of the issue tracker (the Board): its tags,
 * the slices of its services they call, its typed failures, and plain
 * types and constants. It imports only `effect`, `@socio/*` and other
 * features' contracts, and holds no logic. `issues/layer.ts` implements
 * it; only the composition root (`main.ts`) and tests import that.
 */
import { Context, Data, type Effect, type Scope } from 'effect';

import type { AgentActor } from '@socio/foundation/agents/actor';
import type { GoalOfTask } from '@socio/foundation/issues/filing-cause';
import type { FilingDependencies } from '@socio/foundation/issues/filing-dependencies';
import type { DotRequestLimits } from '@socio/foundation/issues/settings';
import type { IssueComponentLabel, IssueComponentOption } from '@socio/shared/issues/issue-components';
import type { IssueWatchView } from '@socio/shared/issues/issue-subscriptions';
import type {
    AgentAttribution,
    AgentBoardActivity,
    DotFiling,
    DotFilingTrigger,
    DotRequester,
    Issue,
    IssueArea,
    IssueAttachment,
    IssueComment,
    IssueDetail,
    IssueEvent,
    IssueEventKind,
    IssueKind,
    IssueLabel,
    IssueLinkRef,
    IssueList,
    IssuePriority,
    IssueSearch,
    IssueSource,
    IssueStatus,
    IssueTitle,
    TriageProposal,
} from '@socio/shared/issues/issue-types';
import type { AutoTriageSettings } from '@socio/shared/types';

// ── Plain types and constants ─────────────────────────────────────────────

/** The Dots' capability-request limits; the helpers are in `@socio/foundation/issues/settings`. */
export type { DotRequestLimits };
/** The links a filing asks for; the helpers are in `@socio/foundation/issues/filing-dependencies`. */
export type { FilingDependencies };
/** A goal by its schedule's task; `filingCause` is in `@socio/foundation/issues/filing-cause`. */
export type { GoalOfTask };

/** The identity automatic triage's proposal comment and its history rows carry (CB-30). */
export const TRIAGE_AUTHOR = 'triage';

/** Which statuses a search covers: not closed, closed, or every one. */
export const BOARD_SEARCH_STATUSES = ['open', 'closed', 'all'] as const;
export type BoardSearchStatus = (typeof BOARD_SEARCH_STATUSES)[number];

/** How an agent's board list is ordered. */
export const LIST_SORTS = ['priority', 'updated', 'newest', 'votes'] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** Which issues a list shows; all of it live issues. */
export interface IssueFilter {
    /** A component ref as the reader sees it (CB-442): exact match. */
    component?: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    kind?: IssueKind;
    area?: IssueArea;
    label?: IssueLabel;
    assigneeId?: string;
    q?: string;
}

/** A new issue's fields, as `issueInput` (issues/store.ts) parses them. */
export interface IssueInput {
    title: string;
    body?: string;
    status?: IssueStatus;
    priority?: IssuePriority;
    kind?: IssueKind;
    area?: IssueArea | null;
    labels?: IssueLabel[];
    assigneeId?: string | null;
    resolution?: string | null;
    /** Component refs (CB-442), set through `BoardComponents.set`. */
    components?: string[];
}

/** A change to an issue, as `issuePatch` (issues/store.ts) parses it. */
export type IssuePatch = Partial<IssueInput>;

/** An attachment with its bytes. */
export type StoredAttachment = IssueAttachment & { data: Uint8Array };

/** A Dot's board action (CB-31, CB-83, CB-84). */
export interface DotActionRow {
    id: string;
    issueId: string;
    action: 'create' | 'comment' | 'vote' | 'unvote' | 'update';
    targetId: string | null;
    dotId: string;
    dotOwnerId: string | null;
    userId: string;
    trigger: DotFilingTrigger;
    causeId: string | null;
    threadId: string | null;
    createdAt: number;
}

/** What a connected agent did on the board, by kind (CB-90). */
export type AgentBoardAction = AgentBoardActivity['action'];

/** Who asked for a status watch, and from where. */
export interface IssueWatchSource {
    sourceKind: 'person' | 'socio' | 'agent';
    sourceId: string;
    threadId: string | null;
    causeId: string | null;
}

/** A new status watch, before defaults (`issueWatchInput`, issues/subscriptions.ts). */
export interface IssueWatchInput {
    issues: string[];
    targetStatus?: IssueStatus;
}

export type IssueWatchCreated = {
    outcome: 'already_watching' | 'subscribed';
    watch: IssueWatchView;
    alreadyMatched: boolean;
    futureTransitionsOnly: true;
};

export type IssueWatchCancelled =
    | { outcome: 'cancelled'; watch: IssueWatchView; message?: undefined }
    | { outcome: 'already_triggered'; watch: IssueWatchView; message: string };

/** A live item close to a search or a new filing, best first. */
export interface BoardMatch {
    issue: string;
    title: string;
    status: IssueStatus;
    kind: IssueKind;
    votes: number;
    url: string;
    /** About 160 characters of the description, around the first match. */
    excerpt: string;
}

/** An attachment as `read_improvement` lists it: text only. */
export interface BoardAttachment {
    name: string;
    type: string;
    size: string;
    /** The item's page, where it can be opened. */
    url: string;
}

/** The other end of a blocked-by (CB-29) or related link (CB-274), as an agent reads it. */
export interface BoardLink {
    issue: string;
    title: string;
    status: IssueStatus;
}

/**
 * A component as agents and socios read it (CB-442): only the ones the
 * person they act for may see; no owner names, as with authors.
 */
export interface BoardComponentTag {
    ref: string;
    name: string;
    /** Set when the plugin is off or uninstalled, or the app deleted. */
    state?: 'disabled' | 'uninstalled' | 'deleted';
}

/** One item as `read_improvement` gives it; text is the board's, no emails. */
export interface BoardItem {
    outcome: 'found';
    issue: string;
    url: string;
    title: string;
    status: IssueStatus;
    kind: IssueKind;
    priority: IssuePriority;
    area: IssueArea | null;
    /** The plugins and apps it is about, that the person may see (CB-442). */
    components: BoardComponentTag[];
    resolution: string | null;
    votes: number;
    /** Whether the person the Dot acts for has voted for it. */
    personVoted: boolean;
    filedAt: string;
    updatedAt: string;
    description: string;
    statusHistory: {
        events: Array<{
            sequence: number;
            at: string;
            kind: 'created' | 'imported' | 'status';
            from: string | null;
            to: string | null;
        }>;
        next: number | null;
        complete: boolean;
        coverage: 'recorded-only';
        order: 'sequence';
    };
    /** Items this one waits for (CB-29); satisfied once they are done or won't fix. */
    blockedBy: BoardLink[];
    /** Items waiting for this one (CB-29). */
    blocks: BoardLink[];
    /** Items related to this one, with no blocking either way (CB-274). */
    related: BoardLink[];
    /** Files on the item itself; a comment's are listed with it. */
    attachments: BoardAttachment[];
    comments: {
        total: number;
        /** The newest few, oldest first. */
        recent: Array<{
            author: string;
            at: string;
            text: string;
            attachments: BoardAttachment[];
        }>;
    };
}

/** No live item by that reference. */
export type BoardNotFound = { outcome: 'not_found'; message: string };

/** One page of an agent's board list; pages are live views, not snapshots. */
export interface BoardListPage {
    total: number;
    offset: number;
    next: number | null;
    complete: boolean;
    enumeration: 'live';
    items: Array<{
        issue: string;
        title: string;
        status: IssueStatus;
        kind: IssueKind;
        priority: IssuePriority;
        area: IssueArea | null;
        labels: IssueLabel[];
        components: BoardComponentTag[];
        votes: number;
        personVoted: boolean;
        filedAt: string;
        updatedAt: string;
        url: string;
    }>;
}

/** A request one Dot made for one user, as the Dot is told about it. */
export interface DotRequestSummary {
    issue: string;
    capability: string;
    status: IssueStatus;
    resolution: string | null;
    demand: number;
    requestedAt: number;
    closedAt: number | null;
}

/**
 * A file the turn asked to attach, read by the caller: its bytes when the
 * turn may use it, or why not, in words the Dot can pass on.
 */
export type TurnFile = { id: string; name: string; data: Uint8Array } | { id: string; name?: string; reason: string };

/** A notice just recorded, for the channels that deliver it (Telegram). */
export interface RecordedNotice {
    userId: string;
    issue: Issue;
    capability: string;
    status: 'done' | 'wont_fix';
    dots: string[];
}

// ── The Board's services, as other features use them ─────────────────────

/** Issues, their comments, history, links and attachments. */
export interface BoardIssues {
    list(filter?: IssueFilter): Promise<Issue[]>;
    titles(options?: { open?: boolean }): Promise<IssueTitle[]>;
    titlesById(ids: readonly string[], options?: { deleted?: boolean }): Promise<Map<string, IssueTitle>>;
    get(number: number): Promise<Issue | undefined>;
    byId(id: string): Promise<Issue | undefined>;
    require(number: number): Promise<Issue>;
    create(input: IssueInput, actorId: string, now?: number, source?: IssueSource, number?: number): Promise<Issue>;
    update(number: number, patch: IssuePatch, actorId: string, now?: number): Promise<Issue>;
    openBlockerNumbers(): Promise<Map<string, number[]>>;
    addBlocker(number: number, blockerNumber: number, actorId: string, now?: number): Promise<unknown>;
    addRelated(number: number, otherNumber: number, actorId: string, now?: number): Promise<unknown>;
    blockedBy(issueId: string): Promise<IssueLinkRef[]>;
    blocks(issueId: string): Promise<IssueLinkRef[]>;
    related(issueId: string): Promise<IssueLinkRef[]>;
    comments(issueId: string): Promise<IssueComment[]>;
    comment(number: number, id: string): Promise<IssueComment>;
    addComment(number: number, text: string, actorId: string, now?: number): Promise<IssueComment>;
    events(issueId: string): Promise<IssueEvent[]>;
    historyCursor(): Promise<number>;
    historySince(
        cursor: number,
        filter: { issueId: string; kind?: IssueEventKind; actorId?: string },
    ): Promise<{ id: string; kind: IssueEventKind }[]>;
    attachments(issueId: string): Promise<IssueAttachment[]>;
    attachment(id: string): Promise<StoredAttachment | undefined>;
    addAttachment(
        number: number,
        file: { name: string; mediaType?: string; data: Uint8Array; commentId?: string },
        uploaderId: string,
        now?: number,
    ): Promise<IssueAttachment>;
    /** Called after a status change commits; returns the unsubscribe. */
    onStatusChange(listener: (issue: Issue, from: IssueStatus) => void): () => void;
}

/** One-shot future status watches (issue subscriptions). */
export interface BoardWatches {
    create(userId: string, input: IssueWatchInput, source: IssueWatchSource, now?: number): Promise<IssueWatchCreated>;
    list(
        userId: string,
        input?: { limit?: number; offset?: number },
    ): Promise<{ items: IssueWatchView[]; next: number | null }>;
    cancel(userId: string, id: string, source?: IssueWatchSource, now?: number): Promise<IssueWatchCancelled>;
    /** Advances watches over the recorded status events (the recovery journal). */
    replay(now?: number): Promise<void>;
    /** Claims ready notices and queues them; external sends happen after commit. */
    flush(notifications: Pick<DeliveriesShape, 'queueFromApp'>, now?: number): Promise<void>;
}

/** Capability requests from Dots, filed as issues. */
export interface BoardRequests {
    demand(): Promise<Map<string, number>>;
    isRequest(issueId: string): Promise<boolean>;
    requesters(issueId: string): Promise<DotRequester[]>;
    pendingRequestsFor(dotId: string, userId: string): Promise<DotRequestSummary[]>;
    resolvedRequestsFor(
        dotId: string,
        userId: string,
        options?: { unannounced?: boolean },
    ): Promise<DotRequestSummary[]>;
    /** Called after a request's notice is recorded; returns the unsubscribe. */
    onNotice(listener: (notice: RecordedNotice) => void | Promise<void>): () => void;
}

/** One upvote per person per board item (CB-83). */
export interface BoardVotes {
    cast(issueId: string, userId: string, dotId?: string | null, now?: number): Promise<string | undefined>;
    withdraw(issueId: string, userId: string, now?: number): Promise<string | undefined>;
    count(issueId: string): Promise<number>;
    counts(): Promise<Map<string, number>>;
    mine(userId: string): Promise<Set<string>>;
}

/** Items Dots file on the board for the person they act for (CB-31). */
export interface BoardFilings {
    search(
        query: string,
        options?: { status?: BoardSearchStatus; limit?: number; origin?: string },
    ): Promise<BoardMatch[]>;
    item(
        ref: string,
        options: { userId: string; origin?: string; historyAfter?: number; historyLimit?: number },
    ): Promise<BoardItem | BoardNotFound>;
    list(
        filter: IssueFilter,
        options: { userId: string; sort?: ListSort; limit?: number; offset?: number; origin?: string },
    ): Promise<BoardListPage>;
    duplicates(title: string, problem: string, origin?: string): Promise<BoardMatch[]>;
    filing(issueId: string): Promise<DotFiling | undefined>;
    commentAttributions(issueId: string): Promise<Map<string, DotFiling>>;
    eventAttributions(issueId: string): Promise<Map<string, DotFiling>>;
    byCause(
        userId: string,
        causeIds: readonly string[],
        from: number,
        to: number,
    ): Promise<{ issueId: string; action: DotActionRow['action']; createdAt: number }[]>;
    activity(dotId: string, before: number, limit: number): Promise<DotActionRow[]>;
    filedCount(dotId: string): Promise<number>;
}

/** What connected agents did on the board for their person (CB-90). */
export interface BoardAgentActions {
    record(
        actor: AgentActor,
        action: AgentBoardAction,
        issueId: string,
        targetId: string | null,
        now?: number,
    ): Promise<void>;
    filing(issueId: string): Promise<AgentAttribution | undefined>;
    commentAttributions(issueId: string): Promise<Map<string, AgentAttribution>>;
    eventAttributions(issueId: string, events: readonly IssueEvent[]): Promise<Map<string, AgentAttribution>>;
}

/** Automatic triage proposals for new issues (CB-30). */
/** A proposal as stored: `reasonAudience` 'admins' keeps its reason from others (CB-442). */
export type StoredTriageProposal = TriageProposal & { reasonAudience: 'admins' | null };

export interface BoardTriage {
    get(issueId: string): Promise<StoredTriageProposal | undefined>;
}

// ── Components (CB-442) ───────────────────────────────────────────────────

/** An installed plugin, as issue components see it. */
export interface ComponentPlugin {
    id: string;
    /** Its manifest's name. */
    name: string;
    enabled: boolean;
    audience: 'admins' | 'members';
}

/** A live app, as issue components see it. */
export interface ComponentApp {
    /** Its address label. */
    id: string;
    name: string;
    ownerUserId: string;
    /** Tells it apart from an earlier app at the same address. */
    createdAt: number;
}

/**
 * What issue components read of the plugins, the apps, the people and the
 * socio grants, bound by the composition once those exist
 * (`IssueComponents.useSources`). The issues feature never reads their
 * tables itself.
 */
export interface IssueComponentSourcesShape {
    plugins(): readonly ComponentPlugin[];
    /** `PluginService.mayUse`: enabled, and an admin or a `members` audience. */
    mayUsePlugin(pluginId: string, userId: string): boolean;
    apps(): readonly ComponentApp[];
    /** `AppsService.access`: the owner, or a reader of the Space it is shared with. */
    mayOpenApp(appId: string, userId: string): boolean;
    /** A deleted app that had this address and `createdAt`. */
    retiredApp(appId: string, generation: number): { name: string; ownerUserId: string } | undefined;
    isAdmin(userId: string): boolean;
    userName(userId: string): string | undefined;
    /** The `app:` and `plugin:` audiences of a socio's live grants in one conversation. */
    conversationAudiences(turn: { personId: string; socioId: string; conversationId: string }): readonly string[];
}

/** Component refs as one reader sees them: per issue, and how each reads. */
export interface ComponentView {
    byIssue: Map<string, string[]>;
    labels: Record<string, IssueComponentLabel>;
}

/** Issue components (CB-442), as the routes, the agents and the views use them. */
export interface BoardComponents {
    /** What `userId` may pick: wildcards, then plugins, then apps. */
    options(userId: string): IssueComponentOption[];
    /** Every issue's components (or these issues'), as `userId` may see them. */
    view(userId: string, issueIds?: readonly string[]): Promise<ComponentView>;
    /** Throws "Unknown component" unless `userId` may see `ref`. */
    checkFilter(userId: string, ref: string): Promise<void>;
    /**
     * Replaces the refs `viewerId` may see on an issue with `refs`; the
     * others stay. New refs must be options for `viewerId`. Records a
     * `components` history row by `actorId` when they change, unless
     * `initial` (a new issue). Returns whether anything changed.
     */
    set(
        issueId: string,
        refs: readonly string[],
        who: { actorId: string; viewerId: string; now?: number; initial?: boolean },
    ): Promise<boolean>;
    /**
     * The one plugin or app a socio's turn is working in, from the live
     * grants on its conversation, if `personId` may see it; else none.
     */
    prefill(turn: { personId: string; socioId: string; conversationId: string | null }): string[];
    /** Whether the person is an admin, who sees every plugin and app. */
    isAdmin(userId: string): boolean;
    /** Every option, whoever asks: automatic triage's model only. */
    everyOption(): IssueComponentOption[];
    /** An option's ref as stored: a live app's with its generation. */
    canonical(ref: string): string | undefined;
    /** Stored refs (a proposal's) a reader may see, with how each reads. */
    visibleRefs(
        userId: string,
        refs: readonly string[],
        rows?: readonly ComponentTagRow[],
    ): { keys: string[]; labels: Record<string, IssueComponentLabel> };
    /** History with the component refs a reader can't see taken out. */
    visibleEvents(
        userId: string,
        issueId: string,
        events: readonly IssueEvent[],
    ): Promise<{ events: IssueEvent[]; labels: Record<string, IssueComponentLabel> }>;
    /** One issue's stored tags. */
    rowsOf(issueId: string): Promise<ComponentTagRow[]>;
}

/** A stored tag's parts the views read. */
export interface ComponentTagRow {
    ref: string;
    label: string;
    audience: 'admins' | 'members' | null;
}

/**
 * The Board (CB-110): its services on the shared connection, built once by
 * `BoardLive`. Promise-based in the pilot; `IssueBoard` is the Effect API.
 */
export interface BoardShape {
    readonly issues: BoardIssues;
    readonly watches: BoardWatches;
    readonly requests: BoardRequests;
    readonly votes: BoardVotes;
    readonly filings: BoardFilings;
    readonly agentActions: BoardAgentActions;
    readonly triage: BoardTriage;
    readonly components: BoardComponents;
}

export class Board extends Context.Service<Board, BoardShape>()('socio/issues/Board') {}

// ── Typed failures ─────────────────────────────────────────────────────────

/**
 * A tracker error with the HTTP status the routes answer with. A plain
 * `Error` (callers in other folders check it with `instanceof` and read
 * its message); `issueFailure` (issues/errors.ts) maps it to the tags
 * below.
 */
export class IssueError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 413 | 415 = 400,
    ) {
        super(message);
    }
}

/** 400: the request is malformed or breaks a rule of the board. */
export class IssueInvalid extends Data.TaggedError('IssueInvalid')<{ readonly message: string }> {}
/** 403: the caller may not do this. */
export class IssueForbidden extends Data.TaggedError('IssueForbidden')<{ readonly message: string }> {}
/** 404: no such issue, comment or attachment. */
export class IssueNotFound extends Data.TaggedError('IssueNotFound')<{ readonly message: string }> {}
/** 409: it conflicts with the board's state. */
export class IssueConflict extends Data.TaggedError('IssueConflict')<{ readonly message: string }> {}
/** 413: too large. */
export class IssueTooLarge extends Data.TaggedError('IssueTooLarge')<{ readonly message: string }> {}
/** 415: a file type the board doesn't take. */
export class IssueUnsupportedType extends Data.TaggedError('IssueUnsupportedType')<{ readonly message: string }> {}

export type IssueFailure =
    | IssueInvalid
    | IssueForbidden
    | IssueNotFound
    | IssueConflict
    | IssueTooLarge
    | IssueUnsupportedType;

const ISSUE_FAILURE_TAGS: ReadonlySet<string> = new Set<IssueFailure['_tag']>([
    'IssueInvalid',
    'IssueForbidden',
    'IssueNotFound',
    'IssueConflict',
    'IssueTooLarge',
    'IssueUnsupportedType',
]);

/** Whether `error` is one of the six typed failures above. */
export const isIssueFailure = (error: unknown): error is IssueFailure =>
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    typeof error._tag === 'string' &&
    ISSUE_FAILURE_TAGS.has(error._tag);

// ── Effect services ────────────────────────────────────────────────────────

/** The Board as Effects, for new code: failures are the typed ones above. */
export interface IssueBoardShape {
    readonly get: (number: number) => Effect.Effect<Issue, IssueNotFound>;
    readonly list: (filter?: IssueFilter) => Effect.Effect<Issue[]>;
    readonly titles: (options?: { open?: boolean }) => Effect.Effect<IssueTitle[]>;
    readonly create: (input: IssueInput, actorId: string) => Effect.Effect<Issue, IssueFailure>;
    readonly update: (number: number, patch: IssuePatch, actorId: string) => Effect.Effect<Issue, IssueFailure>;
    readonly comment: (number: number, text: string, actorId: string) => Effect.Effect<IssueComment, IssueFailure>;
}

export class IssueBoard extends Context.Service<IssueBoard, IssueBoardShape>()('socio/issues/IssueBoard') {}

/** Automatic triage (CB-30), as the issues module starts and stops it. */
export interface AutoTriageControlShape {
    readonly start: (options: { recover?: boolean }) => Promise<void>;
    readonly stop: () => void;
    readonly recover: () => Promise<void>;
}

export class AutoTriageControl extends Context.Service<AutoTriageControl, AutoTriageControlShape>()(
    'socio/issues/AutoTriageControl',
) {}

/**
 * The issue tracker's leader work: `lead` runs today's start steps in the scope
 * it is given, after registering one cleanup that runs today's stop steps for
 * what started; `process` is the single-flight subscription run (the module's
 * tick and its triggers).
 */
export interface IssuesBackgroundShape {
    /**
     * Runs one leadership term in the scope it is given; its cleanup records
     * in `stopped` which of auto-triage and app deliveries it stopped. A
     * term's scope still open when the runtime is disposed is closed then.
     */
    readonly lead: (stopped: LeadStopped) => Effect.Effect<void, unknown, Scope.Scope>;
    readonly process: () => Promise<void>;
}

/** What one term's cleanup stopped, of what `stop` always stops. */
export interface LeadStopped {
    autoTriage: boolean;
    deliveries: boolean;
    /** The cleanup has run (the scope closed, or the runtime was disposed). */
    cleaned: boolean;
}

export class IssuesBackground extends Context.Service<IssuesBackground, IssuesBackgroundShape>()(
    'socio/issues/IssuesBackground',
) {}

/**
 * Starts and stops the leader work through the runtime (the module's
 * `start`, `stop` and `tick`). `stop` reports which of the always-run stop
 * steps the cleanup already ran, so the module runs the others as today.
 */
export interface IssuesLeadership {
    start(): Promise<void>;
    stop(): Promise<{ autoTriageStopped: boolean; deliveriesStopped: boolean }>;
    tick(): Promise<void>;
}

/** The leader work's start, stop and tick, under the graph's `Leadership` tag (`issuesLeadership`). */
export class Leadership extends Context.Service<Leadership, IssuesLeadership>()('socio/issues/Leadership') {}

/**
 * The issue views the board's routes, the live state and the web reads
 * serve, over the Board and the people and socios they name (moved from
 * `live/views/issues.ts`, the list's version from `live/view-versions.ts`).
 * `issues/views.ts` implements it.
 */
export interface IssuesViewsShape {
    /** `GET /api/issues`: the board's list, with votes, demand and the names it mentions. */
    listView(filter?: IssueFilter, userId?: string): Promise<IssueList>;
    /** The list's version for this user, for its conditional answers. */
    listVersion(userId: string): string;
    /** `GET /api/issues/search?q=`: the numbers of the live issues that match. */
    searchView(q: string): Promise<IssueSearch>;
    /** `GET /api/issues/titles`: every live issue's number, title and status. */
    titlesView(options?: { open?: boolean }): Promise<IssueTitle[]>;
    /** `GET /api/issues/:number`: one issue with its comments, history, votes and names. */
    detailView(found: Issue, userId?: string): Promise<IssueDetail>;
}

export class IssuesViews extends Context.Service<IssuesViews, IssuesViewsShape>()('socio/issues/IssuesViews') {}

// ── Config ─────────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `issues/` reads. `PlatformConfig` has each of
 * them with this type, so the composition root can provide the tag from it.
 */
export interface IssuesConfigShape {
    /** `DOT_REQUESTS_PER_*_DAILY`: the server's `request_capability` limits, under Settings. */
    readonly dotRequestLimits?: DotRequestLimits;
    /** `AUTO_TRIAGE` and `AUTO_TRIAGE_DAILY` (CB-30): the server's switch and cap, under Settings. */
    readonly autoTriage?: AutoTriageSettings;
    /** The app's public origin, for links in what the Dots read of the board. */
    readonly appOrigin?: string;
}

export class IssuesConfig extends Context.Service<IssuesConfig, IssuesConfigShape>()('socio/issues/IssuesConfig') {}

// ── What issues needs from the platform: bridges during the migration ─────
// Each replaces a field of the module's old platform view; the composition
// root builds them over the graph's services, and the module's hooks read
// them.

/** App notifications' external delivery queue (notifications). */
export interface DeliveriesShape {
    readonly resume: () => void;
    readonly stop: () => Promise<unknown>;
    readonly queueFromApp: (input: {
        id: string;
        userId: string;
        trigger: string;
        title: string;
        message: string;
        path: string;
    }) => Promise<void>;
}

export class Deliveries extends Context.Service<Deliveries, DeliveriesShape>()('socio/issues/Deliveries') {}

/** A goal by its schedule's task (schedules). */
export interface GoalsShape {
    readonly byTask: (taskId: string) => Promise<{ id: string; userId: string; dotId: string } | undefined>;
}

export class Goals extends Context.Service<Goals, GoalsShape>()('socio/issues/Goals') {}

/**
 * A run's trace as Runs opens it to its viewer, or null, for a filing from
 * a run: `runs/`' `RunsViewsShape.runTraceView`, by its shape (runs is
 * above issues in the folder order, so the port is declared here and the
 * composition provides it from `RunsViews`).
 */
export interface IssueRunTracesShape {
    runTraceView(viewer: { id: string; admin: boolean }, runId: string): { view: { runId: string } } | null;
}

export class IssueRunTraces extends Context.Service<IssueRunTraces, IssueRunTracesShape>()(
    'socio/issues/IssueRunTraces',
) {}

/** The local agent runner, as the routes read a run (turns). */
export interface AgentRunnerShape {
    readonly runTrace: (runId: string) => { threadId: string } | undefined;
}

export class AgentRunner extends Context.Service<AgentRunner, AgentRunnerShape>()('socio/issues/AgentRunner') {}

/** The files a turn shared, read for a board action (media, `turnFiles`). */
export interface MediaFilesShape {
    readonly turnFiles: (turn: { userId: string; threadId: string }, ids: readonly string[]) => Promise<TurnFile[]>;
}

export class MediaFiles extends Context.Service<MediaFiles, MediaFilesShape>()('socio/issues/MediaFiles') {}

/**
 * A direct Telegram message to a person's linked account (telegram), read
 * at each use: the bot may come online later. Not configured by default.
 */
export interface TelegramDirectShape {
    readonly online: () => boolean;
    readonly linkFor: (userId: string) => Promise<{ telegramUserId: string } | undefined>;
    readonly sendDirect: (telegramUserId: string, text: string) => Promise<unknown>;
}

export const TelegramDirect = Context.Reference<TelegramDirectShape>('socio/issues/TelegramDirect', {
    defaultValue: () => ({
        online: () => false,
        linkFor: async () => undefined,
        sendDirect: () => Promise.reject(new Error('Telegram is not configured.')),
    }),
});
