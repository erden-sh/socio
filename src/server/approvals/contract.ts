/**
 * What other features may know of approvals: their tags, the slices of the
 * services they call, the error, and the plain types a module needs to
 * register a capability and file a request. It imports only `effect` and
 * `@socio/*`, and holds no logic.
 *
 * The types here moved from `service.ts` and `domain/ports.ts`, and those
 * old paths were later dropped.
 *
 * Not here, on purpose:
 * - `ApprovalOptions` and `AutoDecider` (`auto.ts`): what the service is
 *   built with, which only the composition root hands it.
 * - `approvalNotices` and `approvalRoutes`: the notices are a listener
 *   the layer registers (`layer.ts`), and the routes stay the module's,
 *   mounted in the registry's order.
 *
 * `layer.ts` implements the tags.
 */
import { Context } from 'effect';

import type {
    ApprovalAuditEntry,
    ApprovalCapabilityView,
    ApprovalPolicy,
    ApprovalPolicyView,
    ApprovalsState,
    ApprovalStatus,
    ApprovalView,
    PendingApprovalResult,
} from '@socio/shared/approvals';
import type { RoomAction } from '@socio/shared/rooms/rooms';
import type { Conversation, Dot } from '@socio/shared/types';

// ── Plain types ──────────────────────────────────────────────────────────

/** A stored request, as its handler gets it on approval. */
export interface ApprovalRecord<P = unknown> {
    id: string;
    userId: string;
    dotId: string;
    capability: string;
    summary: string;
    payload: P;
    threadId: string | null;
    /** A consumable request's binding (CB-232); null otherwise. */
    binding?: { digest: string; bindingId: string } | null;
}

/** A change of a request's state, as `onDecision` hears of it. */
export interface ApprovalDecisionEvent {
    status: 'approved' | 'denied' | 'expired' | 'consumed';
    /** The person, `policy` (bypass), `auto` or `platform` (expiry). */
    by: string;
    at: number;
}

/**
 * What `execute` may return instead of a line: the line, plus what `undo`
 * needs to reverse the action later (an id it created, the previous value).
 */
export interface ApprovalExecution {
    outcome: string;
    undoData?: unknown;
}

/**
 * A hard rule for auto approvals: return a reason (one line for the user)
 * to pass the request to the user whatever the decision model would say,
 * e.g. "never auto-approve sharing outside the user" or a numeric limit.
 */
export interface AutoRule<P = unknown> {
    /** Shown in the policies UI and given to the decision model. */
    description: string;
    check: (request: ApprovalRecord<P>) => string | false | null | undefined;
}

/** How a capability is treated under the `auto` policy. */
export interface ApprovalAutoSettings<P = unknown> {
    /** False: never decided automatically (Auto can't be chosen). Default true. */
    allowed?: boolean;
    /** The highest risk the model may approve without the user. Default `low`. */
    maxRiskForAuto?: 'low' | 'medium';
    /** What could go wrong, for the decision model (one or two sentences). */
    riskNotes?: string;
    /** Checked before the model; any that fires sends the request to the user. */
    rules?: AutoRule<P>[];
    /** The payload as the decision model sees it (default: all of it, sanitized). */
    describe?: (payload: P) => unknown;
}

/**
 * What a module registers for one approval capability. `execute` runs the
 * approved action from the stored payload, as the requesting Dot acting for
 * the request's user: it must check access again (a grant may be gone) and
 * returns its outcome in a line. It runs at most once per request.
 * Optional: `auto` settings for the `auto` policy, and `undo`, which
 * reverses an automatically approved action when its user asks.
 *
 * A `consumable` capability (CB-232) has no `execute`: approving runs
 * nothing. Each request is bound to an intent digest and a binding (a
 * grant) and is used once, by whoever holds that binding, through
 * `consume`; the action runs there, outside Socio.
 */
export interface ApprovalHandler<P = unknown> {
    /** Every action must be explicitly decided by its person; no bypass or model review. */
    manualOnly?: boolean;
    capability: string;
    label: string;
    description: string;
    /** Required, unless the capability is `consumable`, which has none. */
    execute?: (request: ApprovalRecord<P>) => string | ApprovalExecution | Promise<string | ApprovalExecution>;
    /** Approved requests are used once through `consume` (see above). */
    consumable?: boolean;
    /**
     * How long a request waits for its person; the service's `ttlMs` (7
     * days) when unset. CB-232's capabilities wait 15 minutes.
     */
    ttlMs?: number;
    /** A structured card for the request (CB-232); built per view. */
    card?: (request: ApprovalRecord<P>) => ApprovalView['card'];
    /**
     * Details too long to show inline: when `mustOpen`, the person must
     * fetch `full` (`ApprovalService.open`) before approving.
     */
    review?: {
        mustOpen: (payload: P) => boolean;
        full: (payload: P) => string;
    };
    /**
     * Called inside the unit of work that changes a request's state, so a
     * module's own record of it commits with the change or not at all
     * (CB-232). Synchronous; database work only.
     */
    onDecision?: (request: ApprovalRecord<P>, event: ApprovalDecisionEvent) => void;
    auto?: ApprovalAutoSettings<P>;
    undo?: (request: ApprovalRecord<P> & { outcome: string | null; undoData: unknown }) => string | Promise<string>;
}

export interface ApprovalInput<P = unknown> {
    userId: string;
    dotId: string;
    capability: string;
    /** One line the user decides on; no secrets. */
    summary: string;
    /** Reviewable details under the summary, including complete instructions. */
    details?: string[];
    payload: P;
    /** The conversation it came from (Telegram turns get a direct message). */
    threadId?: string;
    /**
     * The turn that asked; by default the run in progress in `threadId`. The
     * Dot carries on once every request of that turn is decided (CB-58).
     */
    runId?: string;
    /**
     * The work cycle that asked (CB-209); by default the one running in
     * `threadId`. The Dot carries on in it, within what is left of it.
     */
    cycleId?: string;
    /**
     * Always the person's card for this request, whatever their policy
     * says: no bypass, no auto review (an app's `alwaysAsk`, CB-232).
     */
    alwaysAsk?: boolean;
    /** A consumable capability's binding (required for those, else refused). */
    binding?: { digest: string; bindingId: string };
    /**
     * At most `max` requests of `capabilities` waiting at once, by this
     * socio or under this request's binding (CB-232), counted inside
     * the inserting unit of work.
     */
    limit?: {
        max: number;
        capabilities: readonly string[];
        by: 'dot' | 'binding';
        message: string;
    };
}

/**
 * The answer to `request`: done at once under a bypass policy or an auto
 * approval, denied by auto review, or pending until the user decides.
 * Tools return `pending` and `denied` results as they are (the chat shows
 * pending ones as an approval card; `message` tells the Dot what to do).
 */
export type ApprovalOutcome =
    | {
          status: 'approved';
          id: string;
          via: 'bypass' | 'auto';
          outcome: string;
          /** The auto review's reason (via `auto`). */
          reason?: string;
      }
    | {
          status: 'denied';
          id: string;
          via: 'auto';
          /** Why, in a line (the auto review's reason). */
          outcome: string;
          message: string;
      }
    | (PendingApprovalResult & { id: string; expiresAt: number });

/** `requestBound`: the bound request that was already there. */
export interface BoundApproval {
    status: 'bound';
    id: string;
    approved: boolean;
    expiresAt: number;
}

/** A decided request, as the note of the turn that carries on reports it. */
export interface DecidedRequest {
    id: string;
    userId: string;
    dotId: string;
    summary: string;
    status: ApprovalStatus;
    outcome: string | null;
    /** The work cycle it was asked in (CB-209), when known. */
    cycleId?: string | null;
}

/** A request is waiting for its person (the chat card, a notice). */
export type PendingListener = (view: ApprovalView, origin: { userId: string; threadId: string | null }) => void;
/** A request from this conversation was decided or expired. */
export type SettledListener = (threadId: string) => void | Promise<void>;

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A request refused, with the HTTP status the routes answer it with.
 * Thrown and caught with `instanceof` in five folders; kept a plain `Error`
 * so its name, message and JSON stay what they are today.
 */
export class ApprovalError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 = 400,
    ) {
        super(message);
    }
}

// ── Approvals ────────────────────────────────────────────────────────────

/**
 * Approvals' published port for other contexts (CB-110): a
 * socio's approval activity for the admins' socio page, instead of a read
 * of the approval tables.
 */
export interface ApprovalActivity {
    /** The socio's audit entries at or before `before`, newest first. */
    dotActivity(
        dotId: string,
        before: number,
        limit: number,
    ): Promise<
        Array<
            Pick<ApprovalAuditEntry, 'capability' | 'event' | 'actor' | 'createdAt'> & {
                userId: string;
            }
        >
    >;
}

/**
 * The approval service (`LegacyApprovals`), as other folders and the
 * composition call it: modules register capabilities and file requests,
 * the views and Telegram read and decide them, and the platform ends what
 * a deleted socio or a left room can no longer decide. `ApprovalService`
 * implements it. What only `approvals/` calls (expiry, policy edits, undo,
 * the continuation bookkeeping) is not in the slice.
 */
export interface ApprovalsShape extends ApprovalActivity {
    /** Registers a module's capability; throws if it is registered twice. */
    readonly register: <P>(handler: ApprovalHandler<P>) => ApprovalsShape;
    readonly capabilities: () => ApprovalCapabilityView[];
    readonly onPending: (listener: PendingListener) => void;
    readonly onSettled: (listener: SettledListener) => void;
    readonly policies: (userId: string, dotId?: string) => Promise<ApprovalPolicyView[]>;
    readonly guidance: (userId: string) => Promise<string>;
    /** Sets the person's standing guidance for their auto reviews (the routes); the guidance kept. */
    readonly setGuidance: (userId: string, text: string) => Promise<string>;
    /** Sets the person's policy for a socio's capability (the routes). */
    readonly setPolicy: (
        userId: string,
        dotId: string,
        capability: string,
        policy: ApprovalPolicy,
    ) => Promise<ApprovalPolicyView>;
    /** A request's full details, for its person only (the routes), recorded once. */
    readonly open: (id: string, userId: string) => Promise<{ full: string }>;
    /** Reverses an automatically approved action, once, when its capability can (the routes). */
    readonly undo: (id: string, userId: string) => Promise<ApprovalView>;
    readonly request: <P>(input: ApprovalInput<P>) => Promise<ApprovalOutcome>;
    readonly requestBound: <P>(
        input: ApprovalInput<P> & { binding: { digest: string; bindingId: string } },
    ) => Promise<ApprovalOutcome | BoundApproval>;
    readonly findPending: <P>(
        userId: string,
        dotId: string,
        capability: string,
        same: (payload: P) => boolean,
    ) => Promise<(PendingApprovalResult & { id: string; expiresAt: number }) | undefined>;
    readonly pendingPayloads: <P>(
        userId: string,
        dotId: string,
        capability: string,
    ) => Promise<Array<{ id: string; payload: P }>>;
    /** A request's payload once it was approved (approved, or failed as it ran), for its person only. */
    readonly approvedPayload: <P>(
        id: string,
        userId: string,
        capability: string,
    ) => Promise<{ dotId: string; payload: P } | undefined>;
    /** The person's approved requests of one kind whose action failed, newest first. */
    readonly failedPayloads: <P>(
        userId: string,
        dotId: string,
        capability: string,
    ) => Promise<Array<{ id: string; payload: P; outcome: string | null; decidedAt: number | null }>>;
    readonly decide: (id: string, userId: string, approve: boolean, from?: 'app' | 'message') => Promise<ApprovalView>;
    readonly get: (id: string, userId: string) => Promise<ApprovalView>;
    readonly list: (
        userId: string,
        filter?: {
            status?: ApprovalStatus;
            dotId?: string;
            limit?: number;
            /** Only requests an auto review looked at. */
            auto?: boolean;
        },
    ) => Promise<ApprovalView[]>;
    readonly auditFor: (userId: string, limit?: number) => Promise<ApprovalAuditEntry[]>;
    /** Marks the requests past their time expired, with their audit (the module's tick); how many. */
    readonly expire: (now?: number) => Promise<number>;
    /** Expires a deleted socio's pending requests and drops its policies. */
    readonly forgetDot: (dotId: string) => Promise<void>;
    /** Ends what a person (or anyone) was asked in a conversation; how many. */
    readonly invalidate: (threadId: string, userId: string | undefined, detail: string) => Promise<number>;
    /** Whether a turn left requests its socio carries on after (CB-209). */
    readonly awaitingInRun: (threadId: string, runId: string, now?: number) => Promise<boolean>;
    /** Stores the hidden note a continuation turn starts with. */
    readonly recordNote: (id: string, threadId: string, userId: string, content: string) => Promise<void>;
    /** Whether the server wrote this note, in this conversation, as it reads. */
    readonly isNote: (id: string, threadId: string, content: unknown) => Promise<boolean>;
    /** Uses an approved consumable request once (CB-232); true when it did. */
    readonly consume: (
        id: string,
        binding: { capability: string; digest: string; bindingId: string },
        within?: (request: ApprovalRecord) => void,
    ) => Promise<boolean>;
    /** Expires the pending requests under these bindings; how many. */
    readonly expireBound: (bindingIds: readonly string[], outcome: string) => Promise<number>;
}

export class Approvals extends Context.Service<Approvals, ApprovalsShape>()('socio/approvals/Approvals') {}

// ── What approvals read of the workspace ─────────────────────────────────
//
// The workspace sits above approvals in the folder order, so approvals
// declare the members they call (moved from `sources.ts` and `layer.ts`, so
// the module's routes read them by tag).

/** The socios (`SociosShape`, workspace's contract): a socio by id. */
export interface ApprovalSocios {
    dot(id: string): Dot | undefined;
    /** Whether `userId` may use the Dot: a company Dot or their own, not archived. */
    canUseDot(userId: string, dotId: string): boolean;
}

/** The conversations (`ConversationsShape`, workspace's contract). */
export interface ApprovalConversations {
    thread(id: string): Conversation | undefined;
    /** Whether `userId` may do `action` in a live conversation. */
    allows(userId: string, id: string, action: RoomAction): boolean;
    /** Whether `dotId` may answer in the conversation. */
    answers(id: string, dotId: string): boolean;
}

/**
 * What approvals read of the workspace store: its socios (a socio, and
 * whether a person may use one, for the policy routes) and conversations.
 */
export interface ApprovalsWorkspaceShape {
    readonly socios: Pick<ApprovalSocios, 'dot' | 'canUseDot'>;
    readonly conversations: ApprovalConversations;
    /** Who is deactivated: their requests are neither decided nor run (CB-528). */
    readonly people: { isDeactivated(userId: string): boolean };
}

/** The workspace's socios and conversations, as approvals read them (see above). */
export class ApprovalsWorkspace extends Context.Service<ApprovalsWorkspace, ApprovalsWorkspaceShape>()(
    'socio/approvals/ApprovalsWorkspace',
) {}

// ── Continuations ────────────────────────────────────────────────────────

/**
 * The turns that carry on once a conversation's requests are decided
 * (`LegacyContinuations`, CB-58), as the platform starts and stops them.
 * `ApprovalContinuations` implements it.
 */
export interface ApprovalContinuationsShape {
    /** At start: the decisions still waiting carry on. Never fails. */
    readonly resume: () => Promise<void>;
    /** At shutdown: aborts the continuations running. */
    readonly stop: () => void;
}

export class Continuations extends Context.Service<Continuations, ApprovalContinuationsShape>()(
    'socio/approvals/Continuations',
) {}

// ── Views ────────────────────────────────────────────────────────────────

/**
 * The approvals' read models, as `live/` and `web/` serve them (moved out of
 * `live/views/approvals.ts`; the pages read them through this tag). Each is
 * for the signed-in person only: nobody, admins included, sees another's
 * requests.
 */
export interface ApprovalsViewsShape {
    /**
     * `GET /api/approvals`: the person's capabilities, pending and recent
     * requests, policies, audit and guidance. `auto`: recent decisions only
     * from requests an auto review saw (`?review=auto`).
     */
    readonly approvals: (userId: string, options?: { auto?: boolean }) => Promise<ApprovalsState>;
    /** `GET /api/approvals/:id`: one of the person's requests; null otherwise. */
    readonly approval: (id: string, userId: string) => Promise<ApprovalView | null>;
}

export class ApprovalsViews extends Context.Service<ApprovalsViews, ApprovalsViewsShape>()(
    'socio/approvals/ApprovalsViews',
) {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `approvals/` reads. `PlatformConfig` has each
 * of them with this type, so the composition root can provide the tag from
 * it.
 */
export interface ApprovalsConfigShape {
    /** Where the approval page links in a notice point (`/approvals/<id>`). */
    readonly appOrigin?: string;
}

export class ApprovalsConfig extends Context.Service<ApprovalsConfig, ApprovalsConfigShape>()(
    'socio/approvals/ApprovalsConfig',
) {}
