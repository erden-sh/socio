/**
 * What other features may know of work cycles (CB-211): its tag, the slice
 * of `WorkCycles` they call, its error, and plain types and constants. It
 * imports only `effect`, `@socio/*` and `import type` from the allowlist,
 * and holds no logic.
 *
 * The types, the error and the constants here moved from the files that
 * defined them (`domain/repositories.ts`, `ledger.ts`, `service.ts`), which
 * re-export them, so every importer keeps compiling until that importer
 * switches to the contract. The pure helpers other features call moved to
 * `@socio/foundation/cycles/*` (`estimates`: `estimateRequestTokens`,
 * `reportedCost`; `stops`: `isCycleStop`).
 *
 * Not here, on purpose:
 * - `begin` and `end`: the runner's gate (`CycleGate` in
 *   `turns/local-runner.ts`), wired once at construction with
 *   `runner.setCycleGate(cycles)`. A step is `CycleStepShape` here; the
 *   class `CycleStep` stays in `service.ts`, and `CycleAdmission` takes it
 *   as a parameter so `service.ts` keeps the concrete one.
 * - `rooms` and `awaiting`: hooks the composition root sets once
 *   (`composition/rooms.ts`, `composition/approvals.ts`).
 * - `recover` and `persist`: construction (`layer.ts`) and the step's own
 *   writes. `tick` is `CycleUpkeep`, what `cycles/module.ts`'s tick calls.
 * - `sqliteCycles`, `WorkCyclesOptions` and the repositories: construction
 *   over a connection.
 * - A `CyclesConfig` tag: `cycles/` reads no `PlatformConfig` field. Its
 *   limits come from settings (`Limits.cycleLimits`, through
 *   `CycleSources`), and `cycleLimitsFromEnv` (`composition/config.ts`) only fills the
 *   config at start.
 *
 * The contract also declares what the layer (`layer.ts`) needs and offers
 * besides `Cycles`: `CycleSources`, its port onto the conversations, the
 * socios, the limits and the runner, which the composition fills from their
 * own tags (those folders rank above this one, so `cycles/` names none of
 * them); and `CycleUpkeep`, the module's tick.
 */
import { Context } from 'effect';

import { TurnFailureError, type TurnFailure } from '@socio/foundation/observability/failures';
import type {
    BillingPrincipal,
    ConversationKind,
    CycleStop,
    RoomLimits,
    RoomMember,
    RoomSocioStatus,
    TurnContext,
    TurnStart,
} from '@socio/shared/rooms/rooms';
import type { RunActor } from '@socio/shared/runs/run-trace';

// ── Rows ─────────────────────────────────────────────────────────────────

/** `running` holds the conversation's lease; `waiting` is between steps. */
export const CYCLE_STATUSES = ['running', 'waiting', 'ended'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/**
 * How a cycle ended: its step finished, failed, was stopped (Stop, a pause
 * or a changed socio) or interrupted (a restart, an operator's force
 * stop); a limit stopped it (`CycleStop`); or it waited too long for a
 * next step (`expired`).
 */
export const CYCLE_END_REASONS = [
    'completed',
    'failed',
    'stopped',
    'interrupted',
    'deadline',
    'tokens',
    'handoffs',
    'spend',
    'expired',
] as const;
export type CycleEndReason = (typeof CYCLE_END_REASONS)[number];

/** A stored work cycle (`work_cycles`). */
export interface WorkCycle {
    id: string;
    conversationId: string;
    kind: ConversationKind;
    /** The message that started it, when one did: unique per conversation. */
    dispatchKey: string | null;
    /** Who started it (CB-185's trigger of its first step). */
    initiator: RunActor;
    /** Whose access, data, approvals and subscription it uses. */
    actingUserId: string;
    /** The socio of its current or last step, and its owner (null: company). */
    dotId: string;
    dotOwnerId: string | null;
    /** Who pays, once a step's model was known. */
    billing: BillingPrincipal | null;
    status: CycleStatus;
    /** The run of its current or last step. */
    runId: string | null;
    /** Its current step's hop: 0, plus one per handoff. */
    hop: number;
    /** Steps run so far (runs of the agent). */
    steps: number;
    /** The limits in force when it started, a room's lowering applied. */
    limits: RoomLimits;
    startedAt: number;
    /**
     * Time its steps ran so far: waiting between steps (an approval) neither
     * counts nor starts the clock again.
     */
    elapsedMs: number;
    /** When its running step started, and when its time runs out. */
    stepStartedAt: number | null;
    deadlineAt: number | null;
    /** Model requests in flight: reserved, not yet reconciled. */
    tokensReserved: number;
    tokensUsed: number;
    /** Null while any request's cost is unknown (`costKnown` false). */
    costUsd: number | null;
    costKnown: boolean;
    handoffs: number;
    /** Tools still running when it was stopped. */
    unstopped: string[];
    endedAt: number | null;
    endReason: CycleEndReason | null;
    updatedAt: number;
}

// ── The ledger ───────────────────────────────────────────────────────────

/**
 * A work cycle's budget as one step's model requests and tools see it
 * (CB-211). `TurnTracer` asks it before each request to the
 * model (a round's own, a retry, a notes' summary): the request reserves
 * its estimated tokens first, and is refused when the cycle is out of
 * time, tokens or spend, or the reservation would pass its tokens. Once
 * the request ends it is reconciled, once: with the tokens the provider
 * reported; or, when it reported none, with its estimate if the model
 * produced anything and nothing if it failed or was canceled before any
 * output. Spend is added only when the provider reported a cost; one
 * request without a cost makes the cycle's spend unknown, and then only
 * tokens and time bound it.
 */
export interface CycleLedger {
    /** Reserves `estimate` tokens for a request, or throws `CycleLimitError`. */
    reserve(estimate: number): CycleHold;
    /** The step's model: `shared`, else a person's own (`byo:<kind>`). */
    billing(source: string): void;
    /** The rest of the step runs on the shared model (CB-140). */
    fallback(): void;
    /** A tool started running; call the result when it settles. */
    tool(name: string): () => void;
}

/** One request's reservation, reconciled once (later calls do nothing). */
export interface CycleHold {
    settle(result: CycleRequestResult): void;
}
export interface CycleRequestResult {
    /** The provider's count, in and out; undefined when it gave none. */
    tokens?: number;
    /** The provider's cost in USD, when it reported one. */
    costUsd?: number;
    /** Whether the model produced any output. */
    output: boolean;
}

/** The failure a cycle stopped at a limit ends its step with. */
export const CYCLE_FAILURES: Record<CycleStop, TurnFailure> = {
    deadline: 'time_limit',
    tokens: 'cycle_tokens',
    spend: 'cycle_spend',
    handoffs: 'cycle_handoffs',
};

/**
 * A request the cycle's budget refused. Its `code` keeps busy-model
 * retries and the fallback (CB-140) from taking it for a busy provider.
 * A plain error (a `TurnFailureError`), not a tagged one.
 */
export class CycleLimitError extends TurnFailureError {
    readonly code: string;
    constructor(readonly stop: CycleStop) {
        super(CYCLE_FAILURES[stop], `Work cycle limit: ${stop}`);
        this.code = CYCLE_FAILURES[stop];
        this.name = 'CycleLimitError';
    }
}

// ── Steps ────────────────────────────────────────────────────────────────

/**
 * What rooms plug in once they exist (CB-207/208): a room's own lowered
 * limits, a person's membership, a socio's place in the room and the
 * Rooms switch. Until then no conversation is a room, and these are
 * never asked.
 */
export interface CycleRoomHooks {
    limits?: (roomId: string) => Promise<Partial<RoomLimits>>;
    member?: (roomId: string, userId: string) => Promise<Pick<RoomMember, 'role' | 'status'> | undefined>;
    socio?: (roomId: string, dotId: string) => Promise<RoomSocioStatus | undefined>;
    enabled?: () => boolean;
}

/** What a step of work asks for as it starts (`LocalAgentRunner.run`). */
export interface CycleRequest {
    conversationId: string;
    runId: string;
    /** The socio that runs the step. */
    dotId: string;
    /** Whose access the step uses; the conversation's owner when unset. */
    actingUserId?: string;
    /** Who or what asked for it (CB-185). */
    trigger?: RunActor;
    /** Carry on this cycle (an approval decided, a handoff) rather than start one. */
    cycleId?: string;
    /** Its hop in the cycle, for a handoff's step. */
    hop?: number;
    /** The message that started it, if one did (its first new one). */
    dispatchKey?: string;
    /** A person's message brought it: it counts for the rate limit. */
    personMessage?: boolean;
    /** From the queue, whose messages were counted when they were queued. */
    queued?: boolean;
}

/**
 * One step of a cycle while it runs, as the turn sees it (`CycleStep` in
 * `service.ts`): its budget for the step's model requests (`CycleLedger`),
 * its context and what is left of its time.
 */
export interface CycleStepShape extends CycleLedger {
    readonly id: string;
    readonly limits: RoomLimits;
    /** The step's context. */
    readonly context: TurnContext;
    /** The limit that stopped the cycle in this step, once one did. */
    readonly stop?: CycleStop;
    /** How long the step may run: what is left of the cycle's time. */
    remainingMs(): number;
}

/** Whether a step may run, and the step it runs as (`WorkCycles.begin`). */
export type CycleAdmission<Step extends CycleStepShape = CycleStepShape> =
    | { ok: true; step?: Step }
    | { ok: false; failure: TurnFailure };

// ── Cycles ───────────────────────────────────────────────────────────────

/** A room admin's change to the room's limits, checked (`checkRoomLimits`). */
export type RoomLimitsCheck = { ok: false; raised: (keyof RoomLimits)[] } | { ok: true };

/** A conversation's cycles for its use (CB-218). */
export interface CycleUsage {
    /** The running cycle, else the newest, which may be older than `since`. */
    current: WorkCycle | undefined;
    /** Those started from `since`, newest first. */
    recent: WorkCycle[];
}

/** The next socio of a handoff (`handOff`). */
export interface CycleHandOff {
    dotId: string;
    ownerId: string | null;
    roomStatus?: RoomSocioStatus;
}

/**
 * Work cycles (CB-211): what the composition, approvals, context
 * and rooms ask of `WorkCycles`.
 */
export interface CyclesShape {
    /** The limits a conversation's cycles start with now. */
    limitsFor(conversationId: string): Promise<RoomLimits>;
    /** A room admin's change to their room's limits, checked. */
    checkRoomLimits(change: Partial<RoomLimits>): RoomLimitsCheck;
    /** Whether the conversation takes another message this minute (no record). */
    withinRate(conversationId: string): Promise<boolean>;
    /** Counts a message for the rate limit, if it fits. Whether it fit. */
    submit(conversationId: string, actorId: string | null): Promise<boolean>;
    /** A stored cycle. */
    cycle(id: string): Promise<WorkCycle | undefined>;
    /** A conversation's cycles started from `since` (at most `limit`), and its current one. */
    usage(conversationId: string, since: number, limit?: number): Promise<CycleUsage>;
    /** The conversation's running cycle, if a step runs. */
    running(conversationId: string): Promise<WorkCycle | undefined>;
    /** The context for the next socio in the cycle; refused past its handoffs. */
    handOff(cycleId: string, next: CycleHandOff): Promise<TurnStart>;
    /** Ends a waiting cycle whose next step will not come, with why. Whether it ended. */
    close(cycleId: string, reason: CycleEndReason): Promise<boolean>;
    /** The turn context a stored cycle's step runs under. */
    context(cycle: WorkCycle): TurnContext;
    /** Whether `viewerId` may stop the conversation's running cycle. */
    mayStop(conversationId: string, viewerId: string): Promise<boolean>;
    /** Whether a person's queued messages may start work now. */
    mayDispatch(conversationId: string, userId: string): Promise<boolean>;
    /** Ends the conversation's waiting cycles with nothing left to wait for. How many. */
    settleWaiting(conversationId: string): Promise<number>;
    /** The rooms with a step running now, on any runtime. */
    runningRooms(): Promise<string[]>;
}

export class Cycles extends Context.Service<Cycles, CyclesShape>()('socio/cycles/Cycles') {}

// ── What the layer needs and offers besides `Cycles` ─────────────────────

/** What the cycles need of a conversation (a `thread_bindings` row). */
export interface CycleConversation {
    id: string;
    dotId: string;
    ownerId: string;
    /** Set by the rooms schema (CB-207); a chat without it is `private`. */
    kind?: ConversationKind;
    archivedAt?: number | null;
}

/** What the cycles need of a socio: who owns it (null or none: the company). */
export interface CycleSocio {
    id: string;
    ownerId?: string | null;
}

/**
 * What the work cycles read of the rest of the server, at the moment of
 * use: a conversation and a socio by id, the workspace's cycle limits in
 * force now, and whether a run is still alive on a runtime (the start's
 * reconciliation). The composition fills it from `Conversations`,
 * `Socios`, `WorkspaceSettings` with `Limits`, and `Runner`.
 */
export interface CycleSourcesShape {
    conversation(id: string): CycleConversation | undefined;
    socio(id: string): CycleSocio | undefined;
    /** The workspace's limits in force now (`Limits.cycleLimits`). */
    limits(): RoomLimits;
    /** Whether a live runtime still runs this run (`Runner.turnAlive`). */
    alive(runId: string): boolean;
}

export class CycleSources extends Context.Service<CycleSources, CycleSourcesShape>()('socio/cycles/CycleSources') {}

/** The cycles' upkeep, the module's tick: forget old submissions, end cycles that waited too long. */
export interface CycleUpkeepShape {
    tick(): Promise<void>;
}

export class CycleUpkeep extends Context.Service<CycleUpkeep, CycleUpkeepShape>()('socio/cycles/CycleUpkeep') {}
