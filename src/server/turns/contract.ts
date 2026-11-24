/**
 * What other features may know of the turn engine: its tags, the slices of
 * its services they call, its error and constants, and plain types. It
 * imports only `effect`, `@socio/*`, and types from `@ag-ui/client` and
 * `@copilotkit/runtime/v2`, and holds no logic.
 *
 * Two services:
 * - `Runner`: the stored AG-UI runs (`LocalAgentRunner`, local-runner.ts),
 *   as the methods other folders and the platform call. The runner is
 *   built before the graph, in `index.ts`.
 * - `TaskRunner`: the background runner of claimed tasks (`Runner`,
 *   runner.ts), as the force stop and the task routes use it.
 *
 * The classes implement these shapes. The graph's root provides `Runner`
 * (the runner `index.ts` built); the task runner is made after the graph
 * (`composition/lifecycle/turns.ts`), so no layer provides `TaskRunner` yet.
 *
 * The ports below (`RuntimeScopeWorkspace`, `TaskRunnerStore`, `FitTrace`)
 * name what turns reads of features above it, or gives them, so turns
 * imports none of them.
 *
 * The contract also declares what `layer.ts` needs to report each finished
 * turn:
 * - `TurnSubjects`: who and what a finished turn was about, as the
 *   composition reads them from the workspace, the settings and
 *   `RunSource`. A port turns declares, so it names no feature
 *   above it.
 * - `TurnsConfig`: the config turns reads (`OTEL_EXPORTER_OTLP_*`,
 *   `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`).
 *
 * Not here, on purpose:
 * - `CycleGate` and `setCycleGate`: wiring done once at construction, with
 *   the work cycles' types (cycles/service.ts).
 * - The runner's `runtime` (a `RuntimeSession`, `@socio/data/runtime-ownership`):
 *   the runtime's service, not the runner's; callers get it from runtime's
 *   contract.
 * - `close`, `isRunning`, `recoverOrphans`, `forgetReplay`: lifecycle, the
 *   CopilotKit runtime's own protocol, or the runner's internals.
 * - `messageText`, `modelReadableMessages`, `DEFAULT_MAX_IMAGES`
 *   (media-parts.ts): moved to `@socio/foundation/turns/*`.
 */
import type { BaseEvent, Message } from '@ag-ui/client';
import type {
    AgentRunner as CopilotAgentRunner,
    AgentRunnerConnectRequest,
    AgentRunnerRunRequest,
    AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { OtlpSettings } from '@socio/foundation/observability/otel-export';
import type { TurnCause } from '@socio/foundation/turns/turn';
import { THREAD_RUNNING_CODE, THREAD_RUNNING_MESSAGE } from '@socio/shared/chat/thread-running';
import type { RoomAction, TurnContext } from '@socio/shared/rooms/rooms';
import type { ContextCompactionInfo } from '@socio/shared/runs/run-phase';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type { RunActor, RunTrace, RunTraceSummary, TraceNotes } from '@socio/shared/runs/run-trace';
import type { AgentRunSource, AgentRunStatus, Memory, Result, Settings, Task } from '@socio/shared/types';

// ── Constants ────────────────────────────────────────────────────────────

/**
 * The cap when `DOT_MAX_MODEL_ROUNDS` and Settings set none. Computer and
 * browser work takes a round for every step (snapshot, click, type, read),
 * so real tasks need tens of rounds; at the usual 5 to 10 seconds a round, 30
 * fill about the default 5 minute time limit, which stays the main bound.
 * The cap still ends a fast loop (a cheap call repeated) long before then.
 */
export const DEFAULT_DOT_MODEL_ROUNDS = 30;

/** Rounds added when the Dot has learned skills: loading one and reading its files. */
export const LEARNED_SKILL_ROUNDS = 5;

/** A busy model's retries in one turn (CB-140); `modelRetry` in config overrides it. */
export interface RetryPolicy {
    /** Requests for one round at most, the first included. */
    attempts: number;
    /** The first backoff, doubled for each next one, with jitter. */
    baseMs: number;
    /** The longest single wait: a longer hint from the backend isn't waited out. */
    maxWaitMs: number;
    /** All the waits of one turn together. */
    maxTotalWaitMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
    attempts: 4,
    baseMs: 1_000,
    maxWaitMs: 30_000,
    maxTotalWaitMs: 60_000,
};

/** What a server-side turn ends with when the model said nothing (headless.ts). */
export const NO_ASSISTANT_RESPONSE = 'The current compute turn returned no assistant response.';

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A turn that ended with its RUN_ERROR; the message is the user's to see.
 * Thrown and caught (`instanceof`) in promise code, so it stays an `Error`
 * until the turn engine runs on Effect.
 */
export class TurnRunError extends Error {}

/**
 * A run refused because its conversation's turn is still running, here or
 * on another live runtime (CB-357): nothing was stored. Callers match its
 * `code` (shared's `threadRunning`), never its text.
 */
export class ThreadRunningError extends Error {
    readonly code = THREAD_RUNNING_CODE;
    constructor(options?: ErrorOptions) {
        super(THREAD_RUNNING_MESSAGE, options);
        this.name = 'ThreadRunningError';
    }
}

// ── Plain types ──────────────────────────────────────────────────────────

export type RunStatus = AgentRunStatus;

/**
 * What the server knows of a turn before it runs (CB-185), kept in its
 * trace: when its request came and who or what started it. Set by the
 * server, never from request input: on the run request, or by the agent
 * (`turnSignals`) for the browser's turns, which the runtime starts.
 */
export interface TurnSignals {
    receivedAt?: number;
    trigger?: RunActor;
    /**
     * The work cycle the turn is a step of, when it carries one on (an
     * approval decided, a handoff: CB-211), and its hop; else the turn
     * starts its own, or carries on the one its message started.
     */
    cycleId?: string;
    hop?: number;
    /** Its messages come from the steering queue: counted when queued. */
    queued?: boolean;
    /**
     * It brings news to whoever it is for, its trigger included (a long
     * run's report, CB-215): unread for every member of a room.
     */
    news?: boolean;
}

/** What a run stopped by stopAll tells its user (a RUN_ERROR). */
export interface RunNotice {
    message: string;
    code: string;
}

/** A finished run with its replayable, compacted events (CB-136). */
export interface HistoryRow {
    seq: number;
    runId: string;
    status: RunStatus;
    startedAt: number;
    finishedAt: number | null;
    events: BaseEvent[];
}

/** A stored run as the admin Runs view lists it: no events or content. */
export interface StoredRun {
    runId: string;
    threadId: string;
    status: RunStatus;
    /** Null for runs stored before sources were recorded. */
    source: AgentRunSource | null;
    startedAt: number;
    finishedAt: number | null;
    /** The RUN_ERROR message of a failed or interrupted run. */
    error: string | null;
    /** The sanitized operator detail of a failed run. */
    errorDetail: string | null;
    /** How its loop ended, with its rounds and tokens; null while it runs or for older runs. */
    trace: RunTraceSummary | null;
    /**
     * Who started it (CB-185), as its trace says once it is first written;
     * absent before, or for older runs. Only `recentRuns` reads it.
     */
    trigger?: RunActor;
}

export interface FinishedRun {
    runId: string;
    /** Set by scheduled and voice turns; unset for browser and Telegram. */
    source?: AgentRunSource;
    startedAt: number;
    finishedAt: number;
    /**
     * A short label for a failed run (the RUN_ERROR code, or "run_error") or
     * for one interrupted by stopAll (its notice's code).
     */
    error?: string;
    /** Its trace (CB-128), closed: the end reason is always set. */
    trace: RunTrace;
}

export type RunFinishedListener = (threadId: string, status: RunStatus, run: FinishedRun) => void;

/** Token counts from the turn's RUN_FINISHED, when the model reported them. */
export interface TurnUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface TurnOutcome {
    text: string;
    runId: string;
    usage: TurnUsage | null;
}

/** More for one server-side turn: its prompt's id, and a hook once it runs. */
export interface TurnOptions {
    /** The prompt message's id (a hidden note's carries its marker). */
    messageId?: string;
    /** Called once the run is in progress in the runner (others can join it). */
    onStarted?: (runId: string) => void;
    /** When the turn was asked for and who or what asked (CB-185). */
    signals?: TurnSignals;
}

/** What `AppTurns.turnOutcome` takes beyond the turn itself. */
export type PlatformTurnOptions = {
    metadata?: Record<string, unknown>;
    source?: AgentRunSource;
    textOnly?: boolean;
    actingUserId?: string;
    /** A scheduled turn's task, for its tools (`DotTurn.cause`). */
    cause?: TurnCause;
    /**
     * Who or what asked for the turn (CB-185), when not the default: the
     * task of a scheduled turn, the person a channel turn acts for or a
     * voice turn's caller (the chat's owner), else the server itself.
     */
    trigger?: RunActor;
    /** When it was asked for (CB-185): a scheduled run's due time; else now. */
    receivedAt?: number;
    /**
     * It brings news to its trigger too (a long run's report, CB-215):
     * unread for every member of a room, the job's starter included.
     */
    news?: boolean;
    /** The work cycle this turn is a step of, and its context (CB-211). */
    context?: TurnContext;
    /**
     * The prompt is what the chat's owner said in a self-hosted voice
     * call (CB-265): theirs, as a typed message is, and answered aloud.
     */
    spoken?: boolean;
} & Omit<TurnOptions, 'signals'>;

/** What a runtime request does to its conversation, once it is allowed. */
export interface RuntimeScope {
    threadId?: string;
    /** `run` sends, `connect` reads, `stop` stops. */
    action?: RoomAction;
    /** A room: `stop` is the cycle's initiator's or an admin's (`mayStop`). */
    room?: boolean;
}

/**
 * What `validateRuntimeScope` (runtime-scope.ts) reads of the workspace: the
 * socio a request names, and the conversation it acts in with the person's
 * access to it. The workspace's `Socios` and `Conversations` satisfy it.
 */
export interface RuntimeScopeWorkspace {
    /** The socio, if it exists. */
    dot(id: string): unknown;
    /** The conversation, if it exists: a room or not. */
    thread(id: string): { readonly kind?: string } | undefined;
    /** Throws unless `userId` owns the private chat (with `dotId`, that socio's). */
    requireOwnedThread(userId: string, id: string, dotId?: string): unknown;
    /** Throws unless `userId` may take `action` in the room. */
    requireAccess(userId: string, id: string, action: RoomAction, dotId?: string): unknown;
}

/**
 * The turn's trace as context fitting (`context/fit.ts`) writes to it: each
 * request after the round's first, each compaction, and each update of the
 * notes. The turn's `TraceRecorder` (turn-trace.ts) implements it; the
 * context's contract re-exports it.
 */
export interface FitTrace {
    request(kind: { summary: true } | { retry: number }): void;
    compaction(info: ContextCompactionInfo): void;
    /** Each update of the notes, by the model or not (CB-137). */
    notes(update: Omit<TraceNotes, 'kind' | 'round'>): void;
}

/** A run the runner starts: CopilotKit's request, with what the server knows of it. */
export type RunRequest = AgentRunnerRunRequest & {
    source?: AgentRunSource;
    signals?: TurnSignals;
};

/** A run's events as they stream (an rxjs `Observable`, as CopilotKit's runner returns). */
export type RunEvents = ReturnType<CopilotAgentRunner['connect']>;

/** One run's trace (CB-128) with the thread it belongs to; never its events. */
export interface RunTraceRow {
    runId: string;
    threadId: string;
    status: RunStatus;
    startedAt: number;
    finishedAt: number | null;
    trace: RunTrace | null;
}

/** Options for `recentRuns`. */
export interface RecentRunsOptions {
    status?: RunStatus;
    limit?: number;
    /** Threads left out: deleted conversations (CB-64). */
    exclude?: readonly string[];
    /** Only these threads' runs (a member's own). */
    only?: readonly string[];
    /**
     * And, with `only`, these threads' runs that `personId` started
     * (their trace's trigger): a room member's own cycles (CB-213).
     */
    initiatedIn?: { threadIds: readonly string[]; personId: string };
}

/** A run of `runsOfThreads`: no events or content. */
export interface ThreadRun {
    runId: string;
    threadId: string;
    status: string;
    source: string | null;
    startedAt: number;
    finishedAt: number | null;
}

/** A run of `turnsBetween`, with the id of the user message it began with. */
export interface ThreadTurn {
    runId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    messageId: string | null;
}

/** A run `stopAll` stopped. */
export interface StoppedRun {
    threadId: string;
    runId: string;
    source?: AgentRunSource;
}

// ── Services ─────────────────────────────────────────────────────────────

/**
 * The stored AG-UI runs (`LocalAgentRunner`), as other folders and the
 * platform call them. The signatures are today's; the class implements it.
 */
export interface RunnerShape {
    /** Starts a run on a thread with none in progress; its events as they stream. */
    run(request: RunRequest): RunEvents;
    /** A tab joining a thread: its stored runs, then the one in progress. */
    connect(request: AgentRunnerConnectRequest): RunEvents;
    /**
     * A thread's stored runs after `after`, then each later one; `cursor`
     * gets each finished run's sequence number once all of it went out.
     */
    watch(threadId: string, after: number, cursor?: (seq: number) => void): RunEvents;
    /** Stops the thread's turn (only `runId`, when given), here or on another live runtime. */
    stop(request: AgentRunnerStopRequest): Promise<boolean | undefined>;
    /** Ends every run in progress as interrupted, with `notice`; returns the runs it stopped. */
    stopAll(notice: RunNotice): StoppedRun[];
    /** Called after each run on any thread has been stored. */
    onRunFinished(listener: RunFinishedListener): void;
    /** Runs in progress, on any thread. */
    readonly running: number;
    /** The id of the run in progress on a thread, if any. */
    activeRunId(threadId: string): string | undefined;
    /** Whether a turn's run is held by a live runtime, this one or another (CB-108). */
    turnAlive(runId: string): boolean;
    /** The thread's messages, rebuilt from its stored runs (completed runs only). */
    messages(threadId: string): Promise<Message[]>;
    /** Compacted events of every completed run on the thread. */
    events(threadId: string): BaseEvent[];
    /** Whether the thread has any stored run. */
    hasHistory(threadId: string): boolean;
    /** A conversation's finished runs for its history (CB-136), oldest first. */
    historyRows(threadId: string, range: { after?: number; before?: number; limit: number }): HistoryRow[];
    /** The conversation's last finished run before `seq`, if any. */
    runBefore(threadId: string, seq: number): number | null;
    /** The conversation's last finished run, 0 before any (CB-215). */
    lastFinished(threadId: string): number;
    /**
     * How many of the conversation's turns are new to `reader` (CB-215):
     * after their cursor (`after`), ended since they joined (`since`), started
     * by someone else or bringing news. At most `cap`.
     */
    unreadRuns(threadId: string, options: { after: number; since: number; reader: string; cap: number }): number;
    /** The stored runs that mention `text` (a tool call's id), oldest first. */
    rowsMentioning(threadId: string, text: string): HistoryRow[];
    /** Exact server-stamped ingress evidence, bounded to the provider retry window. */
    hasTelegramIngress(
        threadId: string,
        conversationKey: string,
        messageId: string,
        actorId: string,
        botId: string,
        since: number,
        verify: (messageId: string, signature: unknown) => boolean,
    ): boolean;
    /** The ids of the messages the thread's stored runs hold. */
    knownMessageIds(threadId: string): Set<string>;
    /** The ids of the messages the thread's running turn holds so far (CB-225). */
    activeMessageIds(threadId: string): Set<string>;
    /** The person messages the thread's running turn has taken so far (CB-212). */
    runningPersonMessageIds(threadId: string): string[];
    /** The person a run acted for (CB-185), or ''. */
    runActor(runId: string): string;
    /** Whose turn produced each of the thread's stored tool results (CB-210), by tool call id. */
    toolActors(threadId: string): Map<string, string>;
    /** Recent runs across all threads, newest first; never their events. */
    recentRuns(options?: RecentRunsOptions): StoredRun[];
    /** Where a turn records what grounded it (CB-194). */
    refRecorder(runId: string, threadId: string): RunRefRecorder;
    /** One run's trace (CB-128), with its thread for the caller's access check. */
    runTrace(runId: string): RunTraceRow | undefined;
    /** A finished run's stored events, for exporting its content (CB-128). */
    runEvents(runId: string): BaseEvent[];
    /** Runs of the given threads, newest first, at or before `before` (ms). */
    runsOfThreads(threadIds: readonly string[], options?: { before?: number; limit?: number }): ThreadRun[];
    /** A thread's runs that started in [from, to], oldest first. */
    turnsBetween(threadId: string, from: number, to: number): ThreadTurn[];
}

export class Runner extends Context.Service<Runner, RunnerShape>()('socio/turns/Runner') {}

/**
 * The background runner of claimed tasks (research and scheduled turns;
 * runner.ts), as the force stop and the task routes use it.
 */
export interface TaskRunnerShape {
    /** Tasks in progress. */
    readonly running: number;
    /** Stops claiming tasks; a task in progress finishes (shutdown drain). */
    drain(): void;
    /** Ends the tasks in progress at once as interrupted, with `reason`; returns how many there were. */
    interruptAll(reason: string): number;
    /** Stops one task in progress. */
    abort(id: string): void;
    /** Stops every task in progress (settings changed). */
    abortAll(): void;
}

export class TaskRunner extends Context.Service<TaskRunner, TaskRunnerShape>()('socio/turns/TaskRunner') {}

/** A due task the task runner claimed under a lease: schedules' `Claim` is one. */
export type TaskClaim = Task & { lease: string; dueAt?: number | null };

/**
 * What the task runner (runner.ts) reads and writes in the store: the task
 * claims (schedules' `TaskClaims`), the settings and a person's memories.
 * The composition hands it the store, which has them all.
 */
export interface TaskRunnerStore {
    /** How long a claimed task is held before another claim may take it over. */
    leaseMs: number;
    /** The next due task, claimed; null when none is due or `admitted` says no. */
    claim(now?: number, admitted?: () => boolean): Promise<TaskClaim | null>;
    /** Whether this claim still holds its task's lease. */
    owns(claim: TaskClaim): Promise<boolean>;
    /** Records the run's result; whether the claim still held. */
    finish(claim: TaskClaim, result: Result): Promise<boolean>;
    /** Records the run's failure. */
    fail(claim: TaskClaim, error: string): Promise<void>;
    /** Ends the claimed run as interrupted, with `reason`, while the claim still holds. */
    interrupt(claim: TaskClaim, reason: string): Promise<void>;
    /** Adds a line to a task's events (a run's progress). */
    event(taskId: string, runId: string | null, text: string): Promise<void>;
    /** The workspace's settings (whether memory is allowed). */
    settings(): Settings;
    /** A person's memories in use. */
    readonly memoryItems: { active(userId: string): Promise<Memory[]> };
}

/**
 * Who and what a finished turn was about, for its log line and its trace
 * (`layer.ts`). The composition implements it over the workspace, the
 * settings and `RunSource`.
 */
export interface TurnSubjectsShape {
    /** The conversation's owner, if any. */
    owner(threadId: string): string | undefined;
    /** The socio the conversation is with, if any. */
    socio(threadId: string): { readonly id: string; readonly name: string } | undefined;
    /** The workspace's settings (their tracing part). */
    settings(): Settings;
    /**
     * A run's source as recorded by its server-side caller; browser and
     * Telegram runs take the conversation's channel.
     */
    source(threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource>;
}

export class TurnSubjects extends Context.Service<TurnSubjects, TurnSubjectsShape>()('socio/turns/TurnSubjects') {}

// ── TurnsConfig ──────────────────────────────────────────────────────────

/** The config turns reads: where turn traces go, and whether they carry content. */
export interface TurnsConfigShape {
    /** `OTEL_EXPORTER_OTLP_*` (`otlpFromEnv`, CB-128): no export when unset. */
    readonly otlp?: OtlpSettings;
    /**
     * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
     * (`traceContentFromEnv`): exported spans carry content, until an admin
     * sets it in Settings; off when unset.
     */
    readonly traceContent?: boolean;
}

export class TurnsConfig extends Context.Service<TurnsConfig, TurnsConfigShape>()('socio/turns/TurnsConfig') {}
