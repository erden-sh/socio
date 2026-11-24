import type { SocioAccessCard } from './socio-access.js';

/**
 * The approval framework's shared vocabulary. Actions with
 * side effects that a Dot takes on its user's behalf need that user's
 * approval, unless they set the policy for that Dot and capability to
 * `bypass`, or to `auto`: a decision model decides in their place and
 * passes anything it is unsure about, or that exceeds the capability's
 * threshold, back to them.
 */
export const APPROVAL_POLICIES = ['manual', 'bypass', 'auto'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** How risky the decision model judges a request. */
export const AUTO_RISKS = ['low', 'medium', 'high'] as const;
export type AutoRisk = (typeof AUTO_RISKS)[number];

/**
 * Why an auto review ended as it did: `model` (the model's own verdict),
 * or the guard that passed it to the user instead.
 */
export type AutoCause =
    | 'model'
    | 'risk'
    | 'rule'
    | 'rate_limit'
    | 'no_inference'
    | 'timeout'
    | 'malformed'
    | 'error'
    | 'not_allowed';

/** The longest standing guidance a user may give their auto reviewer. */
export const AUTO_GUIDANCE_MAX = 1000;

/**
 * Approval capability ids. The data space registers handlers for the
 * `data.*` and `grant.change` ids; the others are reserved for the features
 * that bring them (schedules and jobs, owner messages, apps) and are listed
 * only once a module registers a handler.
 */
export const APPROVAL_CAPABILITIES = {
    createDataset: 'data.create_dataset',
    writeShared: 'data.write_shared',
    grantChange: 'grant.change',
    scheduleCreate: 'schedule.create',
    goalSet: 'goal.set',
    jobSave: 'job.save',
    messageOwner: 'message.owner',
    appRegister: 'app.register',
    spaceCreate: 'space.create',
    unfurlRecursive: 'unfurl.recursive',
    spaceMediaUpload: 'media.space_upload',
} as const;
export type ApprovalCapabilityId = (typeof APPROVAL_CAPABILITIES)[keyof typeof APPROVAL_CAPABILITIES];

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'failed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A capability that can be approved, as the policies UI lists it. */
export interface ApprovalCapabilityView {
    id: string;
    label: string;
    description: string;
    manualOnly?: boolean;
    /**
     * How `auto` treats it: whether it may be decided automatically at
     * all, the highest risk approved without the user, the hard rules that
     * always pass a request to the user, and whether an auto approval can be
     * undone.
     */
    auto?: {
        allowed: boolean;
        maxRisk: Exclude<AutoRisk, 'high'>;
        rules: string[];
        undo: boolean;
    };
}

/** The auto review of one request, as its user sees it. */
export interface ApprovalAutoView {
    verdict: 'approved' | 'denied' | 'escalated';
    /** The model's risk, when it answered. */
    risk: AutoRisk | null;
    /** The model's reason, or the guard's. Never secrets or email addresses. */
    reason: string;
    cause: AutoCause;
    /** The model id and its source kind (`shared`, `byo-chatgpt`); never credentials. */
    model: string | null;
    backend: string | null;
    latencyMs: number | null;
    at: number;
    undoneAt: number | null;
    undoOutcome: string | null;
    /** Whether the user can undo it now (the capability supports undo). */
    undoable: boolean;
}

/** One approval request, as its user sees it (card, page, list). */
export interface ApprovalView {
    id: string;
    dotId: string;
    dotName: string;
    capability: string;
    capabilityLabel: string;
    /** One line, written by the module that asked ("Create dataset “Prices”"). */
    summary: string;
    /** Short, human-readable detail lines (never secrets). */
    details: string[];
    /**
     * The chat it was asked in, or null when it came from no chat (an app,
     * a schedule). Clients use it to mark that chat as waiting on the person.
     */
    threadId?: string | null;
    status: ApprovalStatus;
    /** How it was decided: by the user, a bypass policy, auto review, or expiry. */
    decidedVia?: 'user' | 'bypass' | 'auto' | 'expiry' | null;
    createdAt: number;
    expiresAt: number;
    decidedAt?: number | null;
    /** What the approved action produced, in a line, or why it failed. */
    outcome?: string | null;
    /** The auto review, when the policy was `auto`. */
    auto?: ApprovalAutoView | null;
    /**
     * The Dot carrying on after the user's decision (CB-58), when the request
     * came from a conversation and the user decided it; null otherwise.
     */
    continuation?: ApprovalContinuationView | null;
    /**
     * A structured card its capability shows instead of the summary and
     * details (CB-232): platform facts first, the socio's and the app's
     * words last, as theirs.
     */
    card?: SocioAccessCard | null;
    /**
     * Details too long to show inline: Approve stays
     * off until the person has opened them all (`opened`), on every
     * surface, and the server refuses it before that.
     */
    review?: { mustOpen: boolean; opened: boolean } | null;
    /** A consumable approval (CB-232): when it was used, once. */
    consumedAt?: number | null;
}

/**
 * How the Dot carries on after a decision (CB-58): `waiting` for the other
 * requests of the same turn (`waitingFor`) or for a turn in progress,
 * `running`, `done`, `failed` (the turn failed), or `skipped` (it could not
 * run: paused, the Dot or the conversation gone), with why in `detail`.
 */
export interface ApprovalContinuationView {
    status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
    /** The continuation's id (its hidden note's message id), once it started. */
    id: string | null;
    detail: string | null;
    /** Requests of the same turn still waiting for the user. */
    waitingFor: number;
}

/**
 * The hidden note a continuation turn starts with (CB-58): a user message
 * the server writes, marked by its id prefix and metadata like voice
 * receipts. The markers only control rendering; the server checks that a
 * note a client sends back is one it wrote.
 */
export const approvalNoteSource = 'approval_decided';
export const approvalNoteMessagePrefix = 'socio:approval_decided:';
export function isApprovalNote(message: { id?: unknown; role?: unknown; metadata?: unknown }): boolean {
    const metadata = message.metadata;
    return (
        (typeof message.id === 'string' && message.id.startsWith(approvalNoteMessagePrefix)) ||
        (!!metadata &&
            typeof metadata === 'object' &&
            (metadata as { socioSource?: unknown }).socioSource === approvalNoteSource)
    );
}

/** The marker a tool result carries when it waits for approval. */
export interface PendingApprovalResult {
    status: 'pending_approval';
    approval: { id: string; summary: string; url: string };
    message: string;
}

export interface ApprovalPolicyView {
    dotId: string;
    capability: string;
    policy: ApprovalPolicy;
    updatedAt?: number | null;
}

export interface ApprovalAuditEntry {
    id: string;
    dotId: string;
    capability: string;
    requestId: string | null;
    event:
        | 'requested'
        | 'approved'
        | 'denied'
        | 'expired'
        | 'bypassed'
        | 'executed'
        | 'failed'
        | 'policy_changed'
        | 'auto_approved'
        | 'auto_denied'
        | 'auto_escalated'
        | 'undone'
        | 'undo_failed'
        | 'guidance_changed'
        // CB-232: the person opened a request's full details, and a
        // consumable approval was used.
        | 'opened'
        | 'consumed';
    actor: string;
    detail: string | null;
    createdAt: number;
}

export interface ApprovalsState {
    capabilities: ApprovalCapabilityView[];
    pending: ApprovalView[];
    recent: ApprovalView[];
    policies: ApprovalPolicyView[];
    audit: ApprovalAuditEntry[];
    /** The user's standing guidance for auto approvals; '' when none. */
    guidance?: string;
}

/**
 * A tool result as an object: parsed when it is JSON text, and unwrapped
 * when a tool returned its approval outcome under `outcome` beside other
 * fields (`goal_set` did, so no card showed, CB-131; chats saved since
 * keep that shape).
 */
function approvalResult(result: unknown): Record<string, unknown> | undefined {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    const object = (item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
    const top = object(value);
    const inner = object(top?.outcome);
    return top && typeof top.status !== 'string' && inner ? inner : top;
}

/** Whether a tool result is waiting for approval (the in-chat card). */
export function pendingApproval(result: unknown): PendingApprovalResult | undefined {
    const value = approvalResult(result);
    if (value?.status === 'pending_approval') {
        const approval = value.approval as { id?: unknown } | undefined;
        if (approval && typeof approval.id === 'string') {
            return value as unknown as PendingApprovalResult;
        }
    }
    return undefined;
}

/**
 * The auto review in a line, for the card, the list and the Telegram
 * notice: the reason, prefixed when a guard (not the model's own verdict)
 * passed the request to the user.
 */
export function autoReasonLine(auto: Pick<ApprovalAutoView, 'verdict' | 'cause' | 'risk' | 'reason'>): string {
    const reason = auto.reason.trim().replace(/[.!]?$/, '.');
    if (auto.cause === 'risk' && auto.risk) {
        return `Risk ${auto.risk} is above what is approved automatically for this capability. ${reason}`;
    }
    if (auto.cause === 'rule') {
        return `A hard rule applies: ${reason}`;
    }
    return auto.risk && auto.cause === 'model' ? `${reason} (risk ${auto.risk})` : reason;
}

/**
 * The approval card a tool result shows in the chat: one waiting for the
 * user, or one an auto review decided, so the decision and its reason
 * are visible where the Dot acted.
 */
export function approvalCardId(result: unknown): string | undefined {
    const pending = pendingApproval(result);
    if (pending) {
        return pending.approval.id;
    }
    const decided = approvalResult(result);
    return decided &&
        decided.via === 'auto' &&
        (decided.status === 'approved' || decided.status === 'denied') &&
        typeof decided.id === 'string'
        ? decided.id
        : undefined;
}
