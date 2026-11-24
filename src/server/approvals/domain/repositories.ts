import type {
    ApprovalAuditEntry,
    ApprovalAutoView,
    ApprovalContinuationView,
    ApprovalPolicy,
    ApprovalPolicyView,
    ApprovalStatus,
    ApprovalView,
    AutoCause,
    AutoRisk,
} from '@socio/shared/approvals';

/**
 * Approvals' repositories (CB-110): one per aggregate, async,
 * taking and returning plain domain types. Only `approvals/infra`
 * implements them; nothing else touches the approval tables. Every write
 * works inside or outside a unit of work: outside one it opens its own.
 */

/** Where a request stands in carrying on after its user's decision (CB-58). */
export type ContinuationState =
    /** Claimed by the user's decision, its action still running. */
    ApprovalContinuationView['status'] | 'deciding';

/** A stored request, its JSON fields read. */
export interface ApprovalRequest {
    id: string;
    userId: string;
    dotId: string;
    capability: string;
    summary: string;
    details: string[];
    payload: unknown;
    threadId: string | null;
    /** The turn that asked (CB-58). */
    runId: string | null;
    status: ApprovalStatus;
    decidedVia: ApprovalView['decidedVia'];
    outcome: string | null;
    createdAt: number;
    expiresAt: number;
    decidedAt: number | null;
    /** What a handler keeps to undo an auto-approved action; null when none. */
    undoData: unknown;
    continuation: ContinuationState | null;
    continuationId: string | null;
    continuationDetail: string | null;
    /** The work cycle it was asked in (CB-209), carried on after it. */
    cycleId: string | null;
    /** A consumable request's intent digest (CB-232). */
    digest: string | null;
    /** What a consumable request is bound to (a grant id). */
    bindingId: string | null;
    /** When it was used, once; null until then. */
    consumedAt: number | null;
    /** When its person opened its full details. */
    openedAt: number | null;
}

export type NewApprovalRequest = Pick<
    ApprovalRequest,
    | 'id'
    | 'userId'
    | 'dotId'
    | 'capability'
    | 'summary'
    | 'details'
    | 'payload'
    | 'threadId'
    | 'runId'
    | 'createdAt'
    | 'expiresAt'
> &
    Partial<Pick<ApprovalRequest, 'cycleId' | 'digest' | 'bindingId'>>;

/** Which of a person's requests a list shows. */
export interface ApprovalRequestFilter {
    status?: ApprovalStatus;
    dotId?: string;
    /** Only requests an auto review looked at. */
    auto?: boolean;
    limit: number;
}

/** Policies per person, socio and capability; `manual` when there is none. */
export interface ApprovalPolicyRepository {
    get(userId: string, dotId: string, capability: string): Promise<ApprovalPolicy | undefined>;
    /** By socio, then capability. */
    list(userId: string, dotId?: string): Promise<ApprovalPolicyView[]>;
    set(policy: {
        userId: string;
        dotId: string;
        capability: string;
        policy: ApprovalPolicy;
        updatedAt: number;
    }): Promise<void>;
    removeForDot(dotId: string): Promise<void>;
}

/** A person's standing guidance for their auto reviews. */
export interface ApprovalGuidanceRepository {
    get(userId: string): Promise<string | undefined>;
    set(userId: string, guidance: string, now: number): Promise<void>;
    clear(userId: string): Promise<void>;
}

/** Requests, with their decision, outcome and continuation. */
export interface ApprovalRequestRepository {
    byId(id: string): Promise<ApprovalRequest | undefined>;
    insert(request: NewApprovalRequest): Promise<void>;
    /** A person's pending requests of one kind from one socio, oldest first. */
    pending(userId: string, dotId: string, capability: string): Promise<ApprovalRequest[]>;
    /** The person's requests of one kind that were approved but failed as they ran, newest first. */
    failed(userId: string, dotId: string, capability: string): Promise<ApprovalRequest[]>;
    /** Pending requests past their expiry. */
    overdue(now: number): Promise<ApprovalRequest[]>;
    /** A socio's pending requests, everyone's. */
    pendingOfDot(dotId: string): Promise<ApprovalRequest[]>;
    /**
     * Requests of these capabilities still waiting at `now`, by one socio
     * or under one binding (CB-232 caps): counted inside the
     * inserting unit of work, so two runtimes can't each admit one more.
     */
    countPending(input: {
        capabilities: readonly string[];
        dotId?: string;
        bindingId?: string;
        now: number;
    }): Promise<number>;
    /**
     * The request bound to `bindingId` for `digest` that is waiting, or
     * approved and not yet used, at `now`: asking again finds it.
     */
    bound(bindingId: string, digest: string, now: number): Promise<ApprovalRequest | undefined>;
    /** Pending requests bound to any of these (a grant that ended). */
    pendingBound(bindingIds: readonly string[]): Promise<ApprovalRequest[]>;
    /**
     * Uses an approved, unused consumable request once, for its digest and
     * binding only: true when this call used it (CB-232).
     */
    consume(id: string, binding: { digest: string; bindingId: string }, at: number): Promise<boolean>;
    /** Records that its person opened the full details; the first time counts. */
    markOpened(id: string, at: number): Promise<void>;
    /** A person's requests, newest first. */
    list(userId: string, filter: ApprovalRequestFilter): Promise<ApprovalRequest[]>;
    /** The person's other decided requests of one kind, newest first. */
    recentDecided(
        userId: string,
        capability: string,
        exceptId: string,
        limit: number,
    ): Promise<Array<Pick<ApprovalRequest, 'summary' | 'status' | 'decidedVia'>>>;
    /**
     * Decides a pending request; false when it was not pending. `deciding`:
     * one from a conversation joins its turn's batch as it is claimed.
     */
    decide(
        id: string,
        decision: {
            status: 'approved' | 'denied';
            via: 'user' | 'bypass' | 'auto';
            at: number;
            deciding?: boolean;
        },
    ): Promise<boolean>;
    /** Expires a pending request; false when it was not pending. */
    expire(id: string, at: number, outcome?: string): Promise<boolean>;
    /** The approved action's line and what undoing it needs (none: undefined). */
    recordExecution(id: string, outcome: string, undoData: unknown): Promise<void>;
    recordOutcome(id: string, outcome: string): Promise<void>;
    /** The approved action failed: the request is `failed`, with why. */
    recordFailure(id: string, outcome: string): Promise<void>;
    setContinuation(
        ids: readonly string[],
        state: ContinuationState,
        options?: { continuationId?: string; detail?: string | null },
    ): Promise<void>;
    /**
     * Continuations a stopped process was running end as failed with
     * `detail`; decisions it was still carrying out wait again.
     */
    endRunning(detail: string): Promise<void>;
    /** A conversation's requests waiting to carry on, in the order made. */
    waitingIn(threadId: string): Promise<ApprovalRequest[]>;
    /** Conversations with requests waiting to carry on. */
    waitingThreads(): Promise<string[]>;
    /**
     * The turn's other requests still outstanding: waiting for their person
     * (not overdue at `now`), or claimed with their action still running.
     */
    outstandingInRun(threadId: string, runId: string, exceptId: string, now: number): Promise<number>;
    /**
     * Whether the turn left requests the socio will carry on after (CB-209):
     * waiting for their person (not overdue at `now`), or decided and not
     * yet carried on. Its work cycle waits for them rather than ending.
     */
    awaitingInRun(threadId: string, runId: string, now: number): Promise<boolean>;
    /** A conversation's pending requests, one person's when given. */
    pendingIn(threadId: string, userId?: string): Promise<ApprovalRequest[]>;
}

/** One auto review of a request, and its undo. */
export interface AutoReview {
    id: string;
    requestId: string;
    userId: string;
    dotId: string;
    capability: string;
    verdict: ApprovalAutoView['verdict'];
    cause: AutoCause;
    modelDecision: string | null;
    risk: AutoRisk | null;
    reason: string;
    model: string | null;
    backend: string | null;
    latencyMs: number | null;
    inputHash: string | null;
    undoneAt: number | null;
    undoOutcome: string | null;
    createdAt: number;
}

export interface AutoReviewRepository {
    insert(review: Omit<AutoReview, 'undoneAt' | 'undoOutcome'>): Promise<void>;
    /** The request's newest review. */
    latest(requestId: string): Promise<AutoReview | undefined>;
    /** The socio's auto approvals after `since`. */
    approvedSince(dotId: string, since: number): Promise<number>;
    /** Stamps the review undone; false when it was already. */
    claimUndo(id: string, now: number): Promise<boolean>;
    recordUndo(id: string, outcome: string): Promise<void>;
    /** The undo failed: no longer undone, with why. */
    releaseUndo(id: string, outcome: string): Promise<void>;
}

export type AuditEntry = ApprovalAuditEntry & { userId: string };

/** The audit of every request, decision and policy change: append-only. */
export interface ApprovalAuditRepository {
    append(entry: AuditEntry): Promise<void>;
    /** A person's entries, newest first. */
    forUser(userId: string, limit: number): Promise<ApprovalAuditEntry[]>;
    /** A socio's entries at or before `before`, newest first. */
    forDot(
        dotId: string,
        before: number,
        limit: number,
    ): Promise<Array<Pick<AuditEntry, 'userId' | 'capability' | 'event' | 'actor' | 'createdAt'>>>;
}

/** The hidden notes continuation turns start with (CB-58). */
export interface ApprovalNote {
    id: string;
    threadId: string;
    userId: string;
    content: string;
    createdAt: number;
}

export interface ApprovalNoteRepository {
    insert(note: ApprovalNote): Promise<void>;
    byId(id: string): Promise<ApprovalNote | undefined>;
}

/** Everything the approval service needs from storage. */
export interface ApprovalRepositories {
    policies: ApprovalPolicyRepository;
    guidance: ApprovalGuidanceRepository;
    requests: ApprovalRequestRepository;
    reviews: AutoReviewRepository;
    audit: ApprovalAuditRepository;
    notes: ApprovalNoteRepository;
}
