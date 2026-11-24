/**
 * Coding sessions as people see them (CB-239): the socio
 * tools, the approval capabilities a session start raises, the start card,
 * and the session card the chat shows. Shared by the server and the client.
 */

/** The socio tools of a coding session, as the flag lists them. */
export const CODING_TOOL_NAMES = [
    'coding_start',
    'coding_prompt',
    'coding_status',
    'coding_diff',
    'coding_open_pr',
    'coding_stop',
] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/**
 * The tools whose results show as the session card in the chat.
 * `coding_start` shows its approval card instead (or the session card
 * through the next `coding_status`); `coding_diff` stays a trace step.
 */
export const CODING_CARD_TOOLS: readonly string[] = ['coding_prompt', 'coding_status', 'coding_open_pr', 'coding_stop'];

/**
 * The approval capabilities: a read-only session may skip the card only
 * by the person's own opt-in for that socio; a session that may push
 * always waits for their click.
 */
export const CODING_SESSION_CAPABILITIES = {
    read: 'coding_session_read',
    push: 'coding_session_push',
} as const;

/**
 * The session host's runtime-request approval capabilities (CB-326 step 4).
 * A provider's runtime request (T3 `ProviderRequestKind`: command, file-read,
 * file-change, mcp-elicitation, permission) becomes one of these consumable
 * capabilities — the person's click decides it, and the host consumes the
 * decision via the provider's `respondToRuntimeRequest`. `coding_agent_use`
 * (step 7) is separate: a colleague asking another's agent.
 */
export const CODING_RUNTIME_CAPABILITIES = {
    command: 'coding_runtime_command',
    fileRead: 'coding_runtime_file_read',
    fileChange: 'coding_runtime_file_change',
    mcpElicitation: 'coding_runtime_mcp_elicitation',
    permission: 'coding_runtime_permission',
} as const;

/** Maps a T3 `ProviderRequestKind` to its Socio approval capability. */
export const CODING_RUNTIME_CAPABILITY_OF: Record<string, string> = {
    command: CODING_RUNTIME_CAPABILITIES.command,
    'file-read': CODING_RUNTIME_CAPABILITIES.fileRead,
    'file-change': CODING_RUNTIME_CAPABILITIES.fileChange,
    'mcp-elicitation': CODING_RUNTIME_CAPABILITIES.mcpElicitation,
    permission: CODING_RUNTIME_CAPABILITIES.permission,
};

/** Maps a Socio approval decision to a T3 `ProviderApprovalDecision`. */
export const CODING_RUNTIME_DECISION_OF: Record<'approved' | 'denied', 'accept' | 'decline'> = {
    approved: 'accept',
    denied: 'decline',
};

/** A pending start waits 15 minutes, as CB-232's cards do. */
export const CODING_APPROVAL_TTL_MS = 15 * 60_000;

/** Session lengths: default 2 hours, at most 8. */
export const CODING_SESSION_MINUTES = { min: 15, max: 480, default: 120 };
/** A session with no prompt for this long ends. */
export const CODING_IDLE_MINUTES = 30;
/**
 * How long a host-backed session's sandbox is kept after the host goes idle
 * (CB-326 step 3): T3's policy is "up to 4 hours while pinned". A new prompt
 * within this window resumes the host in the kept sandbox; past it, the
 * session ends and the sandbox is removed.
 */
export const CODING_HOST_PIN_MINUTES = 240;
/** One prompt runs for at most this long. */
export const CODING_PROMPT_MINUTES = 20;
/** The most of a diff `coding_diff` returns. */
export const CODING_DIFF_BYTES = 200 * 1024;

/**
 * A session's state. A host-backed session whose provider stopped after
 * 30 min idle keeps `state='ready'` and records the idle clock in
 * `hostIdleSince` (CB-326 step 3): the sandbox is kept up to a 4 h pin,
 * and a new prompt resumes the provider. The persisted `state` stays
 * one-shot-shaped (`starting|ready|ended`); `hostIdleSince` is the
 * host-idle marker, not a new state.
 */
export type CodingSessionState = 'starting' | 'ready' | 'ended';
export type CodingRunKind = 'setup' | 'prompt';
export type CodingRunState = 'running' | 'done' | 'failed' | 'lost' | 'stopped';

/** Why a session ended, as its card says it. */
export const CODING_END_WORDS: Record<string, string> = {
    stopped: 'Stopped',
    idle: 'Ended after 30 minutes without a prompt',
    expired: 'Reached its time limit',
    budget: 'Used its token budget',
    revoked: 'Access was ended',
    setup_failed: 'Couldn’t set up the workspace',
    branch_exists: 'Its branch already exists on GitHub',
    sandbox_lost: 'Its sandbox lost its network',
    start_failed: 'Couldn’t start',
    orphaned: 'Ended while Socio was away',
    admin_stopped: 'Stopped by an admin',
};

/**
 * One row of the Computer panel's coding list (CB-239): a
 * session and its sandbox and workspace, without anything the agent
 * wrote. A person sees their own; an admin sees everyone's on the socio.
 */
export interface CodingSandboxView {
    id: string;
    /** Whose session it is: the viewer's own, or (admins only) someone else's. */
    mine: boolean;
    personName: string;
    repository: string;
    branch: string;
    base: string;
    state: CodingSessionState;
    /** A prompt or the setup is running now. */
    working: boolean;
    endReason: string | null;
    createdAt: number;
    endsAt: number;
    endedAt: number | null;
    /** Whether the sandbox container still exists (until it is removed). */
    sandbox: boolean;
    /** The workspace volume's last measured size; null when unknown. */
    diskBytes: number | null;
    canStop: boolean;
}

export interface CodingSandboxList {
    sandboxes: CodingSandboxView[];
    /** When disk sizes were last measured (every 15 minutes), if ever. */
    diskMeasuredAt: number | null;
}

/** The start card: platform facts first, the socio's words last. */
export interface CodingSessionCard {
    kind: 'coding_session';
    socioName: string;
    repository: string;
    base: string;
    /** The branch it will push to, as a pattern: `socio/rulo/…`. */
    branchPattern: string;
    push: boolean;
    minutes: number;
    model: {
        label: string;
        /** The model's code leaves the operator's servers. */
        outsideProvider: boolean;
        /** Where it runs, as a host name; null when unknown. */
        host: string | null;
    };
    /** The session's token budget (Settings → Coding). */
    budgetTokens: number;
    /**
     * The session runs on the person's own plan, not an
     * operator's model: its name ("ChatGPT"). Absent on older cards.
     */
    plan?: { label: string } | null;
    /**
     * The coding agent it runs and how it reaches models (CB-326):
     * today's are all on Socio's gateway. Absent on older cards (OpenCode).
     */
    harness?: { id: string; label: string; route: 'gateway' | 'subscription' } | null;
    /** What it may do, one line each. */
    allows: string[];
    /** What it never may. */
    never: string;
    /** The room whose members see the answers, or null. */
    visibleTo: string | null;
    /** The socio's words, inert, quoted as theirs. */
    task: string;
}

/**
 * A runtime-request approval's card (CB-326 step 4): a provider's runtime
 * request (a command to run, a file to change) shown in the transcript,
 * modelled on T3's approvals. The exact action is shown in monospace; the
 * kind label says which approval it is.
 */
export interface CodingRuntimeCard {
    kind: 'coding_runtime';
    socioName: string;
    repository: string;
    /** "Command approval", "File change approval", … */
    kindLabel: string;
    /** The exact command or change, inert, for monospace display. */
    action: string;
}

/** A prompt run as the card shows it. */
export interface CodingRunView {
    id: string;
    kind: CodingRunKind;
    state: CodingRunState;
    startedAt: number;
    endedAt: number | null;
    /** The newest lines of OpenCode's progress, untrusted, inert. */
    progress: string[];
    /** The agent's final message (untrusted), once it ended. */
    summary: string | null;
    /** Files it changed against the base, once it ended. */
    changedFiles: string[];
    /** Tokens this run used. */
    tokens: number | null;
}

/**
 * One thread event for the live transcript (CB-326 step 4): the host's
 * `ProviderAdapterV2Event` rows the `coding_thread_events` table stores,
 * paged by `ordinal`. The `kind` is the event's `type`
 * (`provider_turn.updated`, `runtime_request.updated`, `turn.terminal`, …);
 * the `payload` is the bounded event JSON, untrusted agent output shown
 * inert. The host writes the rows; the person's card reads them here.
 * Soft-deleted with the session (CB-64).
 */
export interface CodingThreadEventView {
    id: string;
    /** The event's `type` (one of the 13 `ProviderAdapterV2Event` kinds). */
    kind: string;
    /** The event's place in the stream (ascending; page by it). */
    ordinal: number;
    /** The provider's thread id for this event, when it has one. */
    nativeThreadId: string | null;
    /** The provider's turn id for this event, when it has one. */
    nativeTurnId: string | null;
    /** The event's data, bounded and redacted, untrusted. */
    payload: string;
    createdAt: number;
}

/** A page of a session's thread events (`GET /api/gateway/sessions/:id/events`). */
export interface CodingThreadEventsPage {
    events: CodingThreadEventView[];
    /** The highest `ordinal` in this page; pass as `?after` for the next. */
    next: number | null;
}

/**
 * The host controls a person can send to their session's host (CB-326 step
 * 4): interrupt the running turn, steer it with new words, roll it back to a
 * checkpoint (a turn), or fork from one. Each maps to a `HostDriver.command`
 * op the supervisor forwards to the host, which calls the provider adapter's
 * `interruptTurn` / `steerTurn` / `rollbackThread` / `forkThread`. Resume is
 * `coding_prompt` (a new turn); stop is `coding_stop`.
 */
export type CodingHostControlOp = 'interrupt' | 'steer' | 'rollback' | 'fork';

/**
 * One gateway exchange for the coding exchange log (CB-326 step 5): a model
 * request/response the gateway served for a coding session. The bodies live
 * out-of-line in the object store (`bodyPath`, sealed); the row carries the
 * metadata, sizes and content hashes, and joins `gateway_usage` on `usageId`
 * for token counts. The viewer shows metadata + hashes; export writes one
 * JSON-Lines record per exchange (metadata only — bodies are the object
 * store's job, plugged in by the IaC handoff). Credentials never reach the
 * log (constructional). Soft-deleted with the session (CB-64).
 */
export interface GatewayExchangeView {
    id: string;
    /** The gateway API (`responses`, `chat`, …). */
    api: string;
    /** The route path the gateway forwarded to. */
    route: string;
    model: string | null;
    /** `gateway` (operator's backend) or `plan` (the person's own plan). */
    upstreamKind: string;
    requestAt: number;
    responseAt: number | null;
    status: string | null;
    /** The object-store path the bodies live at, when the store wrote them. */
    bodyPath: string | null;
    requestBytes: number | null;
    responseBytes: number | null;
    requestHash: string | null;
    responseHash: string | null;
}

/** A page of a session's exchanges (`GET /api/gateway/sessions/:id/exchanges`). */
export interface GatewayExchangesPage {
    exchanges: GatewayExchangeView[];
    /** The highest `requestAt` in this page; pass as `?after` for the next. */
    next: number | null;
}

/** The session card (`GET /api/gateway/coding/sessions/:id`). */
export interface CodingSessionView {
    id: string;
    socioName: string;
    repository: string;
    base: string;
    branch: string;
    model: string;
    modelLabel: string;
    /** The coding agent it runs (CB-326), by name. */
    harnessLabel?: string;
    push: boolean;
    state: CodingSessionState;
    endReason: string | null;
    createdAt: number;
    /** When it ends at the latest. */
    endsAt: number;
    endedAt: number | null;
    tokens: { used: number; left: number; budget: number };
    run: CodingRunView | null;
    pullRequest: { number: number; url: string } | null;
    /** Requests the sandbox's network refused, by host. */
    denials: Array<{ target: string; count: number }>;
    /**
     * The agent's words and file names are left out: the person may no
     * longer use the repository (CB-232).
     */
    resultsWithheld?: boolean;
}

/**
 * What everyone but a coding session's own person sees of its results in
 * a room (CB-239): one neutral line, nothing of the session.
 */
export const CODING_PRIVATE_LINE = 'A coding session’s result, private to the person it works for.';

/**
 * A coding agent as Settings → Coding lists it (CB-326,
 * `GET /api/gateway/harnesses`): its route, whether it may run on a
 * person's own plan, whether the kill switch turned it off, and its terms
 * record (the plan types it is built for, when its terms were last checked,
 * or null, and where they are).
 */
export interface CodingHarnessView {
    id: string;
    label: string;
    route: 'gateway' | 'subscription';
    default: boolean;
    personalPlans: boolean;
    disabled: boolean;
    terms: { plans: string; checkedAt: string | null; url: string };
}

/** How long an unused workspace volume may be kept, in days. */
export const CODING_RETENTION_DAYS = { min: 1, max: 365, default: 14 };

/**
 * Settings → Coding → Sandboxes (`GET`/`PUT /api/gateway/sandbox`): an
 * admin's values over the environment's. `registries` is `name=host`
 * entries separated by spaces (npm and PyPI by default).
 */
export interface CodingSandboxSettingsView {
    registries: string;
    registriesDefault: string;
    /** An admin's value is in force (else the default). */
    registriesSaved: boolean;
    retentionDays: number;
    retentionDaysDefault: number;
    retentionDaysSaved: boolean;
}

/** A change: a value, or `null` to go back to the server's default. */
export interface CodingSandboxSettingsInput {
    registries?: string | null;
    retentionDays?: number | null;
}
