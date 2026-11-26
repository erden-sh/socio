// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    AbstractAgent,
    EventType,
    compactEvents,
    type BaseEvent,
    type Message,
    type RunAgentInput,
    type RunStartedEvent,
} from '@ag-ui/client';
import {
    AgentRunner,
    finalizeRunEvents,
    type AgentRunnerConnectRequest,
    type AgentRunnerIsRunningRequest,
    type AgentRunnerRunRequest,
    type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import { Observable, ReplaySubject, type Subscription } from 'rxjs';

import {
    RuntimeSession,
    OwnershipError,
    type RuntimeOwnershipShape,
    type WorkLease,
} from '@socio/data/runtime-ownership';
import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { withToolActors } from '@socio/foundation/context/room-context';
import { TURN_FAILURE_MESSAGES, failureDetail, turnError } from '@socio/foundation/observability/failures';
import { replayableEvents } from '@socio/foundation/replay/replayable-events';
import { runRefRecorder } from '@socio/foundation/runs/run-refs';
import { openReviewCalls, skippedReview } from '@socio/foundation/workspace/client-messages';
import { approvalNoteMessagePrefix, approvalNoteSource } from '@socio/shared/approvals';
import { HISTORY_AFTER_HEADER } from '@socio/shared/chat/chat-history';
import { LOOP_END_EVENT } from '@socio/shared/loop-end';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import {
    RUN_TRACE_EVENT,
    type RunActor,
    type RunTrace,
    type RunTraceSummary,
    type TraceCycle,
} from '@socio/shared/runs/run-trace';
import { socioField, withoutSocioFields } from '@socio/shared/runs/socio-fields';
import { SENDER_METADATA, SOCIO_METADATA, type AgentRunSource, type AgentRunStatus } from '@socio/shared/types';

import type { CycleAdmission, CycleRequest, CycleStepShape } from '../cycles/contract.js';
import type { ReplayerShape, StoredRunRow } from '../replay/contract.js';

import {
    ThreadRunningError,
    type FinishedRun,
    type HistoryRow,
    type RunFinishedListener,
    type RunNotice,
    type RunnerShape,
    type RunStatus,
    type StoredRun,
    type TurnSignals,
} from './contract.js';
import { runAgentLean } from './lean-apply.js';
import { TraceRecorder, traceSummary } from './turn-trace.js';

// Durable AG-UI run storage on node:sqlite. Adapted from CopilotKit's MIT
// SqliteAgentRunner (@copilotkit/sqlite-runner 1.75.0), with these changes:
// events are flushed while a run streams, so a crash keeps the user's message
// and any partial answer; runs left open by a crash are closed on startup;
// stop honors a specific runId; and messages are rebuilt from stored events.
// A failed run keeps its operator detail (the RUN_ERROR's `errorDetail`) in
// the errorDetail column, never in the events that clients receive. Its
// trace (CB-128) goes to the trace column the same way: the agent's trace
// events are taken out of the stream, so clients never get them.

interface ActiveRun {
    lease: WorkLease;
    /** The lease as last checked (every OWNERSHIP_CHECK_MS): events stream while it holds. */
    owned: boolean;
    ownershipTimer?: ReturnType<typeof setInterval>;
    runId: string;
    agent: AbstractAgent;
    subject: ReplaySubject<BaseEvent>;
    events: BaseEvent[];
    source?: AgentRunSource;
    stopRequested: boolean;
    abortDelivered: boolean;
    errorDetail?: string;
    /** Set by stopAll: the run ends with this RUN_ERROR, as interrupted. */
    notice?: RunNotice;
    trace: TraceRecorder;
}
const signalsOf = (agent: AbstractAgent): TurnSignals | undefined =>
    (agent as { turnSignals?: TurnSignals }).turnSignals;

/**
 * The work cycles (CB-211, `WorkCycles`): asked as each run starts, for
 * the cycle it runs in or why it may not run, and as it ends.
 */
export interface CycleGate {
    begin(request: CycleRequest): Promise<CycleAdmission>;
    end(step: CycleStepShape, outcome: { status: AgentRunStatus; trace: RunTrace }): Promise<TraceCycle>;
}
/**
 * What an agent tells the gate and gets from it: whose access its turn
 * uses (a channel turn's linked person), and the step it runs as, which
 * the runner sets before it runs (`DotAgent`).
 */
interface CycleAgent {
    turnActingUserId?: string;
    cycle?: CycleStepShape;
}
export const INTERRUPTED_RUN_MESSAGE = 'The server restarted during this run. Send your message again to continue.';

/** The sync cursor a chat's connection sent (CB-136), if any. */
function historyAfter(headers: Record<string, string> | undefined) {
    const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === HISTORY_AFTER_HEADER)?.[1];
    return value && /^\d{1,15}$/.test(value) ? Number(value) : 0;
}

/** The person the server stamped as a message's sender, if any (CB-228). */
function senderActor(message: object): RunActor | undefined {
    const metadata = (message as { metadata?: unknown }).metadata;
    const id =
        metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[SENDER_METADATA] : undefined;
    return typeof id === 'string' && id ? { kind: 'person', id } : undefined;
}

/** The ids of the messages `events` hold: their own and their runs' input. */
function messageIdsOf(events: readonly BaseEvent[]): Set<string> {
    const ids = new Set<string>();
    for (const event of events) {
        if ('messageId' in event && typeof event.messageId === 'string') {
            ids.add(event.messageId);
        }
        if (event.type === EventType.RUN_STARTED) {
            for (const message of (event as RunStartedEvent).input?.messages ?? []) {
                ids.add(message.id);
            }
        }
    }
    return ids;
}

/**
 * `input` with a result closing each page review `stored` left open
 * (`skippedReview`), before its first new message from anyone, when it
 * brings one and not the review's own result. Unchanged otherwise.
 */
function withReviewsClosed(
    input: RunAgentInput,
    known: ReadonlySet<string>,
    stored: readonly BaseEvent[],
): RunAgentInput {
    const messages = input.messages ?? [];
    const first = messages.findIndex((message) => message.role === 'user' && !known.has(message.id));
    if (first === -1) {
        return input;
    }
    const open = openReviewCalls(stored);
    for (const message of messages) {
        if (message.role === 'tool') {
            open.delete(message.toolCallId);
        }
    }
    if (!open.size) {
        return input;
    }
    return {
        ...input,
        messages: [...messages.slice(0, first), ...[...open].map(skippedReview), ...messages.slice(first)],
    };
}

const logValue = (value: string) => value.replace(/[^\w.:@-]/g, '_').slice(0, 80) || '-';

/**
 * One log line per finished turn: identifiers, source, duration, why its
 * loop ended, its model rounds and tokens in and out (when the model said),
 * and a short error label. In a work cycle (CB-211) also the cycle, who
 * started it and, when not the owner, whose access it used, by id. Never
 * message content, prompts or tool arguments.
 */
export function turnLogLine(turn: {
    status: RunStatus;
    runId: string;
    threadId: string;
    ownerId?: string;
    source: AgentRunSource;
    ms: number;
    error?: string;
    trace?: RunTraceSummary;
    initiator?: RunActor;
    cycle?: TraceCycle;
}) {
    const { trace, cycle, initiator } = turn;
    const loop = trace
        ? ` reason=${trace.reason} rounds=${trace.rounds}${trace.inputTokens !== undefined ? ` tokens_in=${trace.inputTokens}` : ''}${trace.outputTokens !== undefined ? ` tokens_out=${trace.outputTokens}` : ''}`
        : '';
    const work = cycle
        ? ` cycle=${logValue(cycle.id)} hop=${cycle.hop}${initiator ? ` initiator=${logValue(`${initiator.kind}${initiator.id ? `:${initiator.id}` : ''}`)}` : ''}${cycle.actingUserId !== turn.ownerId ? ` acting=${logValue(cycle.actingUserId)}` : ''}${cycle.stop ? ` limit=${cycle.stop}` : ''}`
        : '';
    return `Turn: ${turn.status} run=${logValue(turn.runId)} thread=${logValue(turn.threadId)} user=${logValue(turn.ownerId ?? 'unknown')} source=${turn.source} ms=${Math.max(0, Math.round(turn.ms))}${work}${loop}${turn.error ? ` error=${logValue(turn.error)}` : ''}`;
}

const parseTrace = (text: string | null | undefined): RunTrace | null => {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text) as RunTrace;
    } catch {
        return null;
    }
};

/** A stored trace's trigger (CB-185), when it is a well-formed one. */
const runActorOf = (text: string | null): RunActor | null => {
    if (!text) {
        return null;
    }
    try {
        const actor = JSON.parse(text) as Partial<RunActor>;
        return typeof actor?.kind === 'string'
            ? {
                  kind: actor.kind,
                  ...(typeof actor.id === 'string' ? { id: actor.id } : {}),
              }
            : null;
    } catch {
        return null;
    }
};

/** How often a run rechecks its lease and looks for a stop from another runtime. */
const OWNERSHIP_CHECK_MS = 250;
/** How often a stream of another runtime's turn reads what it stored. */
const FOLLOW_MS = 250;
/**
 * How often a conversation's long-lived stream (`watch`) looks for a turn
 * it was not told of: one another runtime started (CB-108).
 */
const WATCH_IDLE_MS = 1_000;

const UNIT = /^(TEXT_MESSAGE|TOOL_CALL|REASONING_MESSAGE|THINKING_TEXT_MESSAGE)_(START|CONTENT|ARGS|END)$/;
/** The message or tool call an event belongs to, for those streamed in parts. */
const unitOf = (event: BaseEvent) => {
    if (!UNIT.test(event.type)) {
        return undefined;
    }
    const { messageId, toolCallId } = event as {
        messageId?: unknown;
        toolCallId?: unknown;
    };
    return event.type.startsWith('TOOL_CALL')
        ? typeof toolCallId === 'string'
            ? `tool:${toolCallId}`
            : undefined
        : typeof messageId === 'string'
          ? `message:${messageId}`
          : undefined;
};

/**
 * The part of a running turn's stored events that is settled (CB-108):
 * compacted, up to the first message or tool call that hasn't ended. A
 * stream that follows another runtime's turn sends it whole messages, so
 * nothing it sent changes when the next flush or the final row compacts.
 */
export function settledEvents(events: BaseEvent[], done: boolean) {
    const compacted = compactEvents(events);
    if (done) {
        return compacted;
    }
    const ended = new Set<string>();
    for (const event of compacted) {
        if (event.type.endsWith('_END')) {
            const unit = unitOf(event);
            if (unit) {
                ended.add(unit);
            }
        }
    }
    const settled: BaseEvent[] = [];
    for (const event of compacted) {
        const unit = unitOf(event);
        if (unit && !ended.has(unit)) {
            break;
        }
        settled.push(event);
    }
    return settled;
}

export class LocalAgentRunner extends AgentRunner implements RunnerShape {
    private db: DatabaseSync;
    readonly runtime: RuntimeSession;
    private ownership: RuntimeOwnershipShape;
    private active = new Map<string, ActiveRun>();
    private finishedListeners: RunFinishedListener[] = [];
    private startedListeners = new Set<(threadId: string) => void>();
    private recoveryTimer?: ReturnType<typeof setTimeout>;
    private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private cycles?: CycleGate;
    private readonly replayer: ReplayerShape;
    /** This runner's prefix of its threads' keys in the replayer, which may serve several runners. */
    private readonly replayKey = `${randomUUID()}:`;

    /**
     * A path opens a connection of its own, which the server does; a test may
     * hand it a connection instead, which it then owns. Either way boot has
     * migrated the database.
     */
    constructor(
        database: string | DatabaseSync,
        private options: {
            flushIntervalMs?: number;
            runtime?: RuntimeSession;
            /**
             * Where `messages` replays (CB-318): the process's replay worker,
             * which the boot step hands in (`index.ts`, `sharedReplayer()`);
             * tests may replay inline (`InlineReplayer`).
             */
            replayer: ReplayerShape;
        },
    ) {
        super();
        this.replayer = options.replayer;
        if (typeof database === 'string') {
            if (database !== ':memory:') {
                mkdirSync(dirname(database), { recursive: true });
            }
            this.db = new DatabaseSync(database);
            applyConnectionPragmas(this.db);
        } else {
            this.db = database;
        }
        this.runtime = options.runtime ?? new RuntimeSession();
        this.ownership = this.runtime.attach(this.db);
        this.recoverOrphans();
    }

    /** Only released/expired owners are orphans; a candidate must not touch live work. */
    recoverOrphans() {
        clearTimeout(this.recoveryTimer);
        if (!this.db.isOpen) {
            return;
        }
        const open = this.db.prepare("SELECT runId FROM agent_runs WHERE status='running'").all() as {
            runId: string;
        }[];
        let protectedWork = false;
        for (const { runId } of open) {
            if (this.ownership.workAlive('turn', runId)) {
                protectedWork = true;
                continue;
            }
            this.ownership.recoverOrphan('turn', runId, () => {
                const row = this.db
                    .prepare("SELECT events, trace FROM agent_runs WHERE runId=? AND status='running'")
                    .get(runId) as { events: string; trace: string | null } | undefined;
                if (!row) {
                    return false;
                }
                const events = JSON.parse(row.events) as BaseEvent[];
                finalizeRunEvents(events, {
                    interruptionMessage: INTERRUPTED_RUN_MESSAGE,
                });
                const trace = new TraceRecorder(parseTrace(row.trace) ?? undefined);
                return this.finishRow(
                    runId,
                    'interrupted',
                    compactEvents(events),
                    undefined,
                    undefined,
                    trace.finish('interrupted'),
                );
            });
            // The owner may have renewed between the fast read and guarded recovery.
            protectedWork ||= this.ownership.workAlive('turn', runId);
        }
        if (protectedWork) {
            this.retryRecovery();
        }
    }
    private retryRecovery() {
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(
            () => {
                try {
                    this.recoverOrphans();
                } catch {
                    console.error('Runtime turn recovery failed; retrying without claiming live work.');
                    if (this.db.isOpen) {
                        this.retryRecovery();
                    }
                }
            },
            Math.min(1000, Math.floor(this.runtime.leaseMs / 3)),
        );
        this.recoveryTimer.unref();
    }

    private finishRow(
        runId: string,
        status: RunStatus,
        events: BaseEvent[],
        finishedAt = Date.now(),
        errorDetail?: string,
        trace?: RunTrace,
        lease?: WorkLease,
    ): boolean {
        // A run can outlive close(); its row is then closed by recoverOrphans() on the
        // next start, exactly like a crash.
        if (!this.db.isOpen) {
            return false;
        }
        const write = () =>
            this.db
                .prepare(
                    "UPDATE agent_runs SET status=?, events=?, finishedAt=?, errorDetail=?, trace=? WHERE runId=? AND status='running'",
                )
                .run(
                    status,
                    JSON.stringify(events),
                    finishedAt,
                    errorDetail ?? null,
                    trace ? JSON.stringify(trace) : null,
                    runId,
                );
        if (!lease) {
            return Number(write().changes) > 0;
        }
        const result = this.ownership.guarded(lease, () => {
            const changed = Number(write().changes) > 0;
            this.ownership.release(lease);
            return changed;
        });
        return result.owned && result.value;
    }

    private scheduleFlush(run: ActiveRun) {
        if (this.flushTimers.has(run.runId)) {
            return;
        }
        this.flushTimers.set(
            run.runId,
            setTimeout(() => this.flush(run), this.options.flushIntervalMs ?? 250),
        );
    }

    private flush(run: ActiveRun) {
        clearTimeout(this.flushTimers.get(run.runId));
        this.flushTimers.delete(run.runId);
        if (!this.db.isOpen) {
            return;
        }
        this.ownership.guarded(run.lease, () =>
            this.db
                .prepare("UPDATE agent_runs SET events=?, trace=? WHERE runId=? AND status='running'")
                .run(JSON.stringify(run.events), JSON.stringify(run.trace.trace), run.runId),
        );
    }

    /** Completed (or closed) runs for a thread, oldest first. */
    private storedEvents(threadId: string, after = 0): BaseEvent[] {
        const rows = this.db
            .prepare(
                "SELECT runId, events FROM agent_runs WHERE threadId=? AND status!='running' AND seq>? ORDER BY seq",
            )
            .all(threadId, after) as { runId: string; events: string }[];
        return rows.flatMap((row) => replayableEvents(threadId, row));
    }

    /**
     * A conversation's finished runs for its history (CB-136), each with
     * its events made replayable as `storedEvents` makes them, oldest first.
     * `after`: those after that run, up to the run in progress (a later one
     * is never history before it). Otherwise the newest before `before`.
     * At most `limit`.
     */
    historyRows(threadId: string, range: { after?: number; before?: number; limit: number }): HistoryRow[] {
        const open = (
            this.db
                .prepare("SELECT MIN(seq) AS seq FROM agent_runs WHERE threadId=? AND status='running'")
                .get(threadId) as { seq: number | null }
        ).seq;
        const below = Math.min(range.before ?? Number.MAX_SAFE_INTEGER, open ?? Number.MAX_SAFE_INTEGER);
        const rows = (range.after !== undefined
            ? this.db
                  .prepare(
                      `SELECT seq, runId, status, events, startedAt, finishedAt FROM agent_runs
               WHERE threadId=? AND status!='running' AND seq>? AND seq<? ORDER BY seq LIMIT ?`,
                  )
                  .all(threadId, range.after, below, range.limit)
            : this.db
                  .prepare(
                      `SELECT seq, runId, status, events, startedAt, finishedAt FROM agent_runs
               WHERE threadId=? AND status!='running' AND seq<? ORDER BY seq DESC LIMIT ?`,
                  )
                  .all(threadId, below, range.limit)
                  .reverse()) as unknown as (Omit<HistoryRow, 'events'> & {
            events: string;
        })[];
        return rows.map((row) => ({
            ...row,
            events: compactEvents(replayableEvents(threadId, row)),
        }));
    }

    /** The conversation's last finished run before `seq`, if any. */
    runBefore(threadId: string, seq: number): number | null {
        return (
            this.db
                .prepare("SELECT MAX(seq) AS seq FROM agent_runs WHERE threadId=? AND status!='running' AND seq<?")
                .get(threadId, seq) as { seq: number | null }
        ).seq;
    }

    /** The conversation's last finished run, 0 before any (CB-215). */
    lastFinished(threadId: string): number {
        if (!this.db.isOpen) {
            return 0;
        }
        return (
            (
                this.db
                    .prepare("SELECT MAX(seq) AS seq FROM agent_runs WHERE threadId=? AND status!='running'")
                    .get(threadId) as { seq: number | null }
            ).seq ?? 0
        );
    }

    /**
     * How many of the conversation's turns are new to `reader` (CB-215):
     * those after their cursor (`after`, a run's `seq`) that ended since
     * they joined (`since`), that someone else started (a run's trigger,
     * CB-185: a turn of their own is never new to them, but a long run's
     * report, `news` in its trace, is new to everyone) and that show in
     * the transcript (finished, stopped or cut short; a failed turn's
     * messages go back to its sender's queue). At most `cap`. Turns, not
     * tool results: nobody's private results are counted or looked at.
     */
    unreadRuns(
        threadId: string,
        {
            after,
            since,
            reader,
            cap,
        }: {
            after: number;
            since: number;
            reader: string;
            cap: number;
        },
    ): number {
        if (!this.db.isOpen) {
            return 0;
        }
        return (
            this.db
                .prepare(
                    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM agent_runs
             WHERE threadId=? AND seq>? AND status IN ('finished', 'stopped', 'interrupted')
               AND COALESCE(finishedAt, startedAt)>=?
               AND (json_extract(trace, '$.news')=1
                 OR COALESCE(json_extract(trace, '$.trigger.kind')='person' AND json_extract(trace, '$.trigger.id')=?, 0)=0)
             LIMIT ?)`,
                )
                .get(threadId, after, since, reader, cap) as { n: number }
        ).n;
    }

    /**
     * The stored runs that mention `text` (a tool call's id), oldest first,
     * as `historyRows` gives them.
     */
    rowsMentioning(threadId: string, text: string): HistoryRow[] {
        const rows = this.db
            .prepare(
                `SELECT seq, runId, status, events, startedAt, finishedAt FROM agent_runs
         WHERE threadId=? AND status!='running' AND instr(events, ?)>0 ORDER BY seq`,
            )
            .all(threadId, JSON.stringify(text)) as unknown as (Omit<HistoryRow, 'events'> & { events: string })[];
        return rows.map((row) => ({
            ...row,
            events: compactEvents(replayableEvents(threadId, row)),
        }));
    }

    /** Exact server-stamped ingress evidence, bounded to the provider retry window. */
    hasTelegramIngress(
        threadId: string,
        conversationKey: string,
        messageId: string,
        actorId: string,
        botId: string,
        since: number,
        verify: (messageId: string, signature: unknown) => boolean,
    ): boolean {
        const rows = this.db
            .prepare(
                `SELECT json_extract(m.value,'$.id') AS id,
        json_extract(m.value,'$.metadata.socioTelegramIngress.signature') AS signature
      FROM agent_runs AS r INDEXED BY agent_runs_thread_time,
        json_each(r.events) AS e,
        json_each(json_extract(e.value, '$.input.messages')) AS m
      WHERE r.threadId=? AND r.startedAt>=?
        AND json_extract(e.value, '$.type')='RUN_STARTED'
        AND json_extract(m.value, '$.role')='user'
        AND json_extract(m.value, '$.metadata.socioTelegramIngress.conversationKey')=?
        AND json_extract(m.value, '$.metadata.socioTelegramIngress.messageId')=?
        AND json_extract(m.value, '$.metadata.socioTelegramIngress.actorId')=?
        AND json_extract(m.value, '$.metadata.socioTelegramIngress.botId')=?
        AND length(json_extract(m.value, '$.id')) BETWEEN 1 AND 200
        AND json_type(m.value, '$.metadata.socioTelegramIngress.signature')='text'
        AND length(json_extract(m.value, '$.metadata.socioTelegramIngress.signature'))=64
      ORDER BY r.startedAt DESC, r.seq DESC
      LIMIT 100`,
            )
            .all(threadId, since, conversationKey, messageId, actorId, botId) as Array<{
            id: string;
            signature: unknown;
        }>;
        return rows.some((row) => verify(row.id, row.signature));
    }

    /**
     * The ids of the messages the thread's stored runs hold: what a new run's
     * input repeats from history rather than introduces.
     */
    knownMessageIds(threadId: string): Set<string> {
        return messageIdsOf(this.storedEvents(threadId));
    }

    /**
     * The ids of the messages the thread's running turn holds so far, if one
     * runs (CB-225): a server turn's prompt (a voice call's receipt, say)
     * that a client saw and sends back while it runs.
     */
    activeMessageIds(threadId: string): Set<string> {
        return messageIdsOf(this.active.get(threadId)?.events ?? []);
    }

    /**
     * The person messages the thread's running turn has taken so far, here
     * or on another live runtime (CB-212): its input's and those delivered
     * to it as it runs. A room's reader tells by them a queued message a
     * turn took from one a room admin canceled (CB-215).
     */
    runningPersonMessageIds(threadId: string): string[] {
        let events = this.active.get(threadId)?.events;
        const remote = events ? undefined : this.remoteRunId(threadId);
        if (remote) {
            const row = this.db.prepare('SELECT events FROM agent_runs WHERE runId=?').get(remote) as
                | { events: string }
                | undefined;
            events = row ? (JSON.parse(row.events) as BaseEvent[]) : undefined;
        }
        const ids: string[] = [];
        for (const event of events ?? []) {
            if (event.type === EventType.RUN_STARTED) {
                for (const message of (event as RunStartedEvent).input?.messages ?? []) {
                    if (message.role === 'user') {
                        ids.push(message.id);
                    }
                }
            }
            const { messageId, role } = event as {
                messageId?: unknown;
                role?: unknown;
            };
            if (event.type === EventType.TEXT_MESSAGE_START && role === 'user' && typeof messageId === 'string') {
                ids.push(messageId);
            }
        }
        return ids;
    }

    run(
        request: AgentRunnerRunRequest & {
            source?: AgentRunSource;
            signals?: TurnSignals;
        },
    ): Observable<BaseEvent> {
        const { threadId, source } = request;
        if (this.active.has(threadId)) {
            throw new ThreadRunningError();
        }

        // RUN_STARTED carries only the messages this run introduced, so replays
        // do not repeat history (same rule as the upstream SQLite runner).
        const stored = this.storedEvents(threadId);
        const known = messageIdsOf(stored);
        // A page review left open is closed before anything else is added
        // (CB-228), on every path a message comes by: a call is followed by
        // its result, as strict providers require.
        const input = withReviewsClosed(request.input, known, stored);
        // The agent runs on them (the runtime set it to the request's).
        if (input !== request.input) {
            request.agent.setMessages(input.messages);
        }
        // A chat that shows its history from its store (CB-136) holds only the
        // turns since it opened, and long tool results cut, and a web request
        // reaches the runner with its new messages only (CB-225): the model
        // still gets the whole conversation, as stored, then what the run brings.
        const sent = new Set((input.messages ?? []).map((message) => message.id));
        const partial = [...known].some((id) => !sent.has(id));

        const draft: Omit<ActiveRun, 'lease' | 'owned'> = {
            runId: input.runId,
            agent: request.agent,
            source,
            subject: new ReplaySubject<BaseEvent>(Infinity),
            events: [],
            stopRequested: false,
            abortDelivered: false,
            trace: new TraceRecorder(),
        };
        const startedAt = Date.now();
        // Who started the turn and wrote its new messages, and when it came
        // (CB-185): with its trace, flushed with the run's first events.
        const signals = request.signals ?? signalsOf(request.agent) ?? {};
        draft.trace.start(startedAt, signals);
        // Each new message is its sender's (CB-228: a queued one in a team
        // topic may be another person's), else the trigger's.
        const trigger = draft.trace.trace.trigger;
        for (const message of input.messages ?? []) {
            const author = senderActor(message) ?? trigger;
            if (author && message.role === 'user' && !known.has(message.id)) {
                draft.trace.message(message.id, author, draft.trace.trace.receivedAt ?? startedAt);
            }
        }
        const socio: RunActor = {
            kind: 'socio',
            ...(request.agent.agentId ? { id: request.agent.agentId } : {}),
        };
        let lease: WorkLease;
        try {
            lease = this.ownership.claim('turn', input.runId, `thread:${threadId}`, (lease) => {
                this.db
                    .prepare(
                        "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, source) VALUES (?, ?, 'running', '[]', ?, ?)",
                    )
                    .run(threadId, input.runId, startedAt, source ?? null);
                return lease;
            });
        } catch (error) {
            // The thread runs on another runtime (CB-108): as busy as here.
            if (error instanceof OwnershipError) {
                throw new ThreadRunningError({ cause: error });
            }
            throw error;
        }
        const run: ActiveRun = { ...draft, lease, owned: true };
        run.ownershipTimer = setInterval(() => {
            if (!this.db.isOpen) {
                return;
            }
            run.owned = this.ownership.owns(run.lease);
            if (!run.owned) {
                run.stopRequested = true;
                try {
                    run.agent.abortRun();
                } catch {
                    /* The durable fence remains authoritative. */
                }
                return;
            }
            // Stop pressed in a tab the other runtime serves (CB-108).
            if (this.ownership.hasSignal('turn', run.runId, 'stop')) {
                this.ownership.takeSignalSync('turn', run.runId, 'stop');
                this.abort(run);
            }
        }, OWNERSHIP_CHECK_MS);
        run.ownershipTimer.unref();
        this.active.set(threadId, run);
        for (const listener of this.startedListeners) {
            try {
                listener(threadId);
            } catch {
                // A listener must never affect the run or other listeners.
            }
        }
        const runSubject = new ReplaySubject<BaseEvent>(Infinity);

        // Every event is stored and sent with the time the runner saw it
        // (CB-72): the chat shows message times and how long each step took.
        const emit = (event: BaseEvent) => {
            if (!run.owned) {
                return;
            }
            const stamped = { ...event, timestamp: Date.now() };
            runSubject.next(stamped);
            run.subject.next(stamped);
            run.events.push(stamped);
        };
        // The run's new messages from people (CB-185 authors): the first
        // names the run's dispatch for its work cycle (CB-211), and a person's
        // counts for the conversation's rate.
        const fresh = (input.messages ?? []).filter((message) => message.role === 'user' && !known.has(message.id));
        let step: CycleStepShape | undefined;
        const execute = async () => {
            let threw = false;
            let terminated = false;
            try {
                // The work cycle the run is a step of (CB-211): opened, or carried
                // on, before the agent runs, or the run ends at once with why.
                const admission: CycleAdmission = this.cycles
                    ? await this.cycles
                          .begin({
                              conversationId: threadId,
                              runId: input.runId,
                              dotId: request.agent.agentId ?? '',
                              actingUserId: (request.agent as CycleAgent).turnActingUserId,
                              trigger,
                              ...(signals.cycleId ? { cycleId: signals.cycleId } : {}),
                              ...(signals.hop !== undefined ? { hop: signals.hop } : {}),
                              ...(fresh[0] ? { dispatchKey: fresh[0].id } : {}),
                              personMessage: fresh.some((message) => senderActor(message)?.kind === 'person'),
                              queued: !!signals.queued,
                          })
                          .catch((error: unknown) => {
                              run.errorDetail = failureDetail(error);
                              return { ok: false as const, failure: 'failed' as const };
                          })
                    : { ok: true };
                if (admission.ok) {
                    step = admission.step;
                    if (step) {
                        (request.agent as CycleAgent).cycle = step;
                    }
                }
                // The agent runs on its messages (the runtime set them to the
                // request's).
                if (admission.ok && partial) {
                    request.agent.setMessages([
                        ...(await this.messages(threadId)),
                        ...(input.messages ?? []).filter((message) => !known.has(message.id)),
                    ]);
                }
                // Whose turn each stored tool result was (CB-210), for a chat with
                // other people in it, where only that person's turns see it: set
                // here, never taken from what a message brought.
                const current = request.agent.messages;
                const stamped = withToolActors(current, this.toolActors(threadId));
                if (stamped.some((message, at) => message !== current[at])) {
                    request.agent.setMessages(stamped);
                }
                const onEvent = ({ event }: { event: BaseEvent }) => {
                    // Keep stored runs valid for replay: ignore anything an agent
                    // emits after its terminal event.
                    if (terminated) {
                        return;
                    }
                    // The turn's trace entries go to its trace, not to clients.
                    if (event.type === EventType.CUSTOM && (event as { name?: unknown }).name === RUN_TRACE_EVENT) {
                        run.trace.add((event as { value?: unknown }).value);
                        this.scheduleFlush(run);
                        return;
                    }
                    if (event.type === EventType.CUSTOM && (event as { name?: unknown }).name === LOOP_END_EVENT) {
                        run.trace.loopEnd((event as { value?: unknown }).value);
                    }
                    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
                        terminated = true;
                    }
                    let processed = event;
                    // The operator detail: in `metadata`, as AG-UI 1.0's client (which
                    // `runAgent` ran the event through) keeps it, or at the top level.
                    const errorDetail =
                        event.type === EventType.RUN_ERROR ? socioField(event, 'errorDetail') : undefined;
                    if (errorDetail !== undefined) {
                        run.errorDetail = String(errorDetail);
                    }
                    if (event.type === EventType.RUN_ERROR) {
                        processed = withoutSocioFields(event, ['errorDetail']);
                    }
                    if (event.type === EventType.RUN_STARTED && !(event as RunStartedEvent).input) {
                        processed = {
                            ...event,
                            input: {
                                ...input,
                                messages: (input.messages ?? []).filter((message) => !known.has(message.id)),
                            } satisfies RunAgentInput,
                        } as RunStartedEvent;
                    }
                    // Which socio writes a reply (CB-212): the one this run (or a
                    // handoff's step) runs as, on the stored message's metadata.
                    if (
                        processed.type === EventType.TEXT_MESSAGE_START &&
                        socio.id &&
                        ((processed as { role?: unknown }).role ?? 'assistant') === 'assistant'
                    ) {
                        processed = {
                            ...processed,
                            metadata: {
                                ...(processed as { metadata?: object }).metadata,
                                [SOCIO_METADATA]: socio.id,
                            },
                        } as BaseEvent;
                    }
                    emit(processed);
                    if (processed.type === EventType.TEXT_MESSAGE_START) {
                        const { messageId, role } = processed as {
                            messageId?: unknown;
                            role?: unknown;
                        };
                        // A person's message delivered mid-turn (CB-151) is its
                        // sender's (CB-228).
                        const author =
                            role === undefined || role === 'assistant'
                                ? socio
                                : role === 'user'
                                  ? senderActor(processed)
                                  : undefined;
                        if (typeof messageId === 'string' && author) {
                            run.trace.message(messageId, author, Date.now());
                        }
                    }
                    // Persist the user's message as soon as the run starts.
                    if (processed.type === EventType.RUN_STARTED) {
                        this.flush(run);
                    } else {
                        this.scheduleFlush(run);
                    }
                    // Agents create their abort controller when their stream starts,
                    // so a stop that arrived earlier is re-sent on the first event.
                    if (run.stopRequested && !run.abortDelivered) {
                        run.abortDelivered = true;
                        request.agent.abortRun();
                    }
                };
                // Without the client's per-event copies of the history (CB-318):
                // the runner keeps its own events.
                if (admission.ok) {
                    await runAgentLean(request.agent, input, { onEvent });
                } else {
                    // Refused: the person's message is kept, with why it did not run.
                    const refusal = turnError(admission.failure);
                    onEvent({
                        event: {
                            type: EventType.RUN_STARTED,
                            threadId,
                            runId: input.runId,
                        } as BaseEvent,
                    });
                    onEvent({ event: refusal as BaseEvent });
                }
            } catch (error) {
                threw = true;
                run.errorDetail ??= failureDetail(error);
            }
            // finalizeRunEvents appends the closers to run.events itself, so only
            // forward them to subscribers here. A run that ended without a terminal
            // event, and was not stopped, failed: it gets the generic message. One
            // stopped by stopAll ends with its notice instead of RUN_FINISHED, and
            // its open tool calls say the same.
            const closers = finalizeRunEvents(run.events, {
                stopRequested: run.stopRequested,
                ...(run.notice
                    ? { interruptionMessage: run.notice.message }
                    : run.stopRequested
                      ? {}
                      : { interruptionMessage: TURN_FAILURE_MESSAGES.failed }),
            });
            const closedAt = Date.now();
            for (const event of closers) {
                event.timestamp = closedAt;
                // A stop's RUN_FINISHED comes without ids (finalizeRunEvents).
                if (event.type === EventType.RUN_FINISHED) {
                    Object.assign(event, { threadId, runId: run.runId });
                }
            }
            const noticed = !!run.notice && closers.at(-1)?.type === EventType.RUN_FINISHED;
            if (noticed) {
                const notice = {
                    type: EventType.RUN_ERROR,
                    message: run.notice!.message,
                    code: run.notice!.code,
                    timestamp: closedAt,
                } as BaseEvent;
                closers[closers.length - 1] = notice;
                run.events[run.events.length - 1] = notice;
            }
            run.owned &&= this.db.isOpen && this.ownership.owns(run.lease);
            for (const event of run.owned ? closers : []) {
                runSubject.next(event);
                run.subject.next(event);
            }
            clearTimeout(this.flushTimers.get(run.runId));
            this.flushTimers.delete(run.runId);
            const runError = run.events.find((event) => event.type === EventType.RUN_ERROR) as
                | { code?: unknown }
                | undefined;
            const failed = threw || !!runError;
            const status: RunStatus = noticed
                ? 'interrupted'
                : run.stopRequested
                  ? 'stopped'
                  : failed
                    ? 'failed'
                    : 'finished';
            const trace = run.trace.finish(status, typeof runError?.code === 'string' ? runError.code : undefined);
            // The step's use goes to its cycle, which waits or ends, before the
            // conversation is free: a next step never sees this one's lease.
            if (step && this.cycles) {
                try {
                    trace.cycle = await this.cycles.end(step, { status, trace });
                } catch {
                    // Stored as it ran; the next start reconciles a cycle left open.
                }
            }
            clearInterval(run.ownershipTimer);
            const finishedAt = Date.now();
            const saved = this.finishRow(
                run.runId,
                status,
                compactEvents(run.events),
                finishedAt,
                failed && !noticed ? run.errorDetail : undefined,
                trace,
                run.lease,
            );
            const finished: FinishedRun = {
                runId: run.runId,
                source,
                startedAt,
                finishedAt,
                trace,
                ...(status === 'failed'
                    ? {
                          error:
                              typeof runError?.code === 'string' && /^[\w.-]{1,40}$/.test(runError.code)
                                  ? runError.code
                                  : 'run_error',
                      }
                    : noticed
                      ? { error: run.notice!.code }
                      : {}),
            };
            this.active.delete(threadId);
            if (!saved && this.db.isOpen) {
                this.retryRecovery();
            }
            runSubject.complete();
            run.subject.complete();
            for (const listener of saved ? this.finishedListeners : []) {
                try {
                    listener(threadId, status, finished);
                } catch {
                    // A listener must never affect the run or other listeners.
                }
            }
        };
        void execute();
        return runSubject.asObservable();
    }

    connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
        const connection = new ReplaySubject<BaseEvent>(Infinity);
        const emitted = new Set<string>();
        // A chat that shows its history from its store (CB-136) asks only for
        // the runs after the ones it has, then the one in progress.
        const after = historyAfter(request.headers);
        for (const event of compactEvents(this.storedEvents(request.threadId, after))) {
            connection.next(event);
            if ('messageId' in event && typeof event.messageId === 'string') {
                emitted.add(event.messageId);
            }
        }
        const active = this.active.get(request.threadId);
        if (!active) {
            const remote = this.remoteRunId(request.threadId);
            if (remote) {
                return this.follow(remote, connection, emitted);
            }
            connection.complete();
            return connection.asObservable();
        }
        active.subject.subscribe({
            next: (event) => {
                if ('messageId' in event && typeof event.messageId === 'string' && emitted.has(event.messageId)) {
                    return;
                }
                connection.next(event);
            },
            complete: () => connection.complete(),
            error: (error) => connection.error(error),
        });
        return connection.asObservable();
    }

    /**
     * A conversation's events after its run `after`, then every turn as it
     * happens, until unsubscribed (CB-212: a room's live stream, which stays
     * open across turns): the finished runs since, as `connect` replays
     * them, then the turn in progress here or on another live runtime
     * (CB-108), then each later one. A turn sent as it ran is not sent again
     * once stored. `cursor` gets each finished run's sequence number once
     * all of it went out, so a reader resumes after it.
     */
    watch(threadId: string, after: number, cursor?: (seq: number) => void): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            let last = after;
            let closed = false;
            let following: Subscription | undefined;
            let busy = false;
            /** Turns sent as they ran: skipped once stored. */
            const live = new Set<string>();
            /** Messages the replay sent: a turn in progress doesn't repeat them. */
            const emitted = new Set<string>();
            const pump = () => {
                if (closed || busy) {
                    return;
                }
                // The server is stopping: the reader connects to the next one.
                if (!this.db.isOpen) {
                    return subscriber.complete();
                }
                const rows = this.db
                    .prepare(
                        "SELECT seq, runId, events FROM agent_runs WHERE threadId=? AND status!='running' AND seq>? ORDER BY seq",
                    )
                    .all(threadId, last) as {
                    seq: number;
                    runId: string;
                    events: string;
                }[];
                for (const row of rows) {
                    last = row.seq;
                    if (!live.delete(row.runId)) {
                        for (const event of compactEvents(replayableEvents(threadId, row))) {
                            subscriber.next(event);
                            if ('messageId' in event && typeof event.messageId === 'string') {
                                emitted.add(event.messageId);
                            }
                        }
                    }
                    cursor?.(row.seq);
                    if (closed) {
                        return;
                    }
                }
                const active = this.active.get(threadId);
                const runId = active?.runId ?? this.remoteRunId(threadId);
                if (!runId || live.has(runId)) {
                    return;
                }
                live.add(runId);
                busy = true;
                let ended = false;
                const next = () => {
                    ended = true;
                    following = undefined;
                    busy = false;
                    pump();
                };
                const source = active
                    ? active.subject.asObservable()
                    : this.follow(runId, new ReplaySubject<BaseEvent>(Infinity), emitted);
                const subscription = source.subscribe({
                    next: (event) => {
                        if (
                            'messageId' in event &&
                            typeof event.messageId === 'string' &&
                            emitted.has(event.messageId)
                        ) {
                            return;
                        }
                        subscriber.next(event);
                    },
                    complete: next,
                    // A read that failed (the database closing): the next look goes on.
                    error: next,
                });
                if (!ended) {
                    following = subscription;
                }
            };
            const started = (id: string) => {
                if (id === threadId) {
                    pump();
                }
            };
            this.startedListeners.add(started);
            const timer = setInterval(() => {
                try {
                    pump();
                } catch {
                    // The database closing: the reader connects again.
                    subscriber.complete();
                }
            }, WATCH_IDLE_MS);
            timer.unref();
            try {
                pump();
            } catch (error) {
                subscriber.error(error);
            }
            return () => {
                closed = true;
                clearInterval(timer);
                this.startedListeners.delete(started);
                following?.unsubscribe();
            };
        });
    }

    /**
     * The person a run acted for (CB-185: its trace's trigger), or '' when
     * no person started it or it was stored before traces said: as
     * `toolActors` names whose each result is (CB-210).
     */
    runActor(runId: string): string {
        for (const run of this.active.values()) {
            if (run.runId === runId) {
                const trigger = run.trace.trace.trigger;
                return trigger?.kind === 'person' && trigger.id ? trigger.id : '';
            }
        }
        if (!this.db.isOpen) {
            return '';
        }
        const row = this.db
            .prepare(
                "SELECT json_extract(trace, '$.trigger.kind') AS kind, json_extract(trace, '$.trigger.id') AS id FROM agent_runs WHERE runId=?",
            )
            .get(runId) as { kind: unknown; id: unknown } | undefined;
        return row?.kind === 'person' && typeof row.id === 'string' && row.id ? row.id : '';
    }

    /**
     * The thread's turn when another live runtime runs it (CB-108: the
     * previous or next release, during a start-first deploy).
     */
    private remoteRunId(threadId: string): string | undefined {
        if (!this.db.isOpen) {
            return undefined;
        }
        const row = this.db
            .prepare("SELECT runId FROM agent_runs WHERE threadId=? AND status='running' ORDER BY seq DESC LIMIT 1")
            .get(threadId) as { runId: string } | undefined;
        return row && this.ownership.remoteOwner('turn', row.runId) ? row.runId : undefined;
    }

    /**
     * A tab reconnecting here to a turn another runtime runs (CB-108): what
     * that runtime stores (it flushes every `flushIntervalMs`), read every
     * FOLLOW_MS, sent a whole message or tool call at a time
     * (`settledEvents`), until the run's row is final. Should that runtime
     * die, the row is final once the orphan recovery closes it.
     */
    private follow(
        runId: string,
        connection: ReplaySubject<BaseEvent>,
        history: ReadonlySet<string>,
    ): Observable<BaseEvent> {
        const sent = new Set<string>();
        let timer: ReturnType<typeof setInterval> | undefined;
        let finished = false;
        const end = () => {
            finished = true;
            clearInterval(timer);
            connection.complete();
        };
        const read = () => {
            if (!this.db.isOpen) {
                return end();
            }
            const row = this.db.prepare('SELECT status, events FROM agent_runs WHERE runId=?').get(runId) as
                | { status: string; events: string }
                | undefined;
            const done = !row || row.status !== 'running';
            for (const event of row ? settledEvents(JSON.parse(row.events) as BaseEvent[], done) : []) {
                const key = JSON.stringify(event);
                if (sent.has(key)) {
                    continue;
                }
                sent.add(key);
                if ('messageId' in event && typeof event.messageId === 'string' && history.has(event.messageId)) {
                    continue;
                }
                connection.next(event);
            }
            if (done) {
                end();
            }
        };
        read();
        if (!finished) {
            timer = setInterval(() => {
                try {
                    read();
                } catch {
                    // A read failed (the database closing): the tab reconnects.
                    end();
                }
            }, FOLLOW_MS);
            timer.unref();
        }
        return new Observable<BaseEvent>((subscriber) => {
            const subscription = connection.subscribe(subscriber);
            return () => {
                subscription.unsubscribe();
                clearInterval(timer);
            };
        });
    }

    /** Whether the thread has a turn running here or on another live runtime. */
    isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
        return Promise.resolve(this.active.has(request.threadId) || !!this.remoteRunId(request.threadId));
    }

    private abort(run: ActiveRun) {
        if (run.stopRequested) {
            return false;
        }
        run.stopRequested = true;
        try {
            run.agent.abortRun();
            if (run.events.length) {
                run.abortDelivered = true;
            }
            return true;
        } catch {
            run.stopRequested = false;
            return false;
        }
    }

    /**
     * Stops the thread's turn. One another runtime runs (CB-108) gets the
     * stop through the database; that runtime applies it within
     * OWNERSHIP_CHECK_MS.
     */
    stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
        const run = this.active.get(request.threadId);
        if (!run) {
            const remote = this.remoteRunId(request.threadId);
            return Promise.resolve(
                !!remote &&
                    (!request.runId || request.runId === remote) &&
                    this.ownership.signalSync('turn', remote, 'stop'),
            );
        }
        if (request.runId && request.runId !== run.runId) {
            return Promise.resolve(false);
        }
        return Promise.resolve(this.abort(run));
    }

    /**
     * Stops every run in progress at once (an operator's force stop). Each
     * ends with `notice` as its RUN_ERROR, which the browser and Telegram
     * show, and is stored as interrupted. Runs already stopping are left to
     * finish their stop. Returns the runs it stopped.
     */
    stopAll(notice: RunNotice) {
        const stopped: {
            threadId: string;
            runId: string;
            source?: AgentRunSource;
        }[] = [];
        for (const [threadId, run] of this.active) {
            if (run.stopRequested) {
                continue;
            }
            run.stopRequested = true;
            run.notice = notice;
            try {
                run.agent.abortRun();
                if (run.events.length) {
                    run.abortDelivered = true;
                }
            } catch {
                // Stopping the others must not fail because one agent could not abort.
            }
            stopped.push({ threadId, runId: run.runId, source: run.source });
        }
        return stopped;
    }

    /**
     * The work cycles each run is a step of (CB-211): set once, by the
     * platform. Without one (tests, stand-alone use) runs have no cycle.
     */
    setCycleGate(gate: CycleGate) {
        this.cycles = gate;
    }
    /**
     * Whether a turn's run is held by a live runtime, this one or another
     * (CB-108): its work cycle is not a dead process's to reconcile.
     */
    turnAlive(runId: string) {
        return this.db.isOpen && this.ownership.workAlive('turn', runId);
    }

    /** Called after each run on any thread has been stored. */
    onRunFinished(listener: RunFinishedListener) {
        this.finishedListeners.push(listener);
    }

    /** Runs in progress, on any thread. */
    get running() {
        return this.active.size;
    }

    /** The id of the run in progress on a thread, if any. */
    activeRunId(threadId: string): string | undefined {
        return this.active.get(threadId)?.runId;
    }

    /** Compacted events of every completed run on the thread. */
    events(threadId: string): BaseEvent[] {
        return compactEvents(this.storedEvents(threadId));
    }

    /**
     * The thread's messages, rebuilt from stored events (completed runs
     * only). The AG-UI client's replay copies the whole history on every
     * event, which on a long thread blocked the main thread for minutes
     * and failed the healthcheck: it runs in the replay
     * worker (CB-318), which keeps the thread's last replay and replays
     * only the runs stored since. The main thread only reads the rows.
     */
    async messages(threadId: string): Promise<Message[]> {
        const rows = this.db
            .prepare("SELECT seq, runId, events FROM agent_runs WHERE threadId=? AND status!='running' ORDER BY seq")
            .all(threadId) as unknown as StoredRunRow[];
        return (await this.replayer.messages(this.replayKey + threadId, threadId, rows)).messages;
    }

    /**
     * Drops the thread's kept replay (CB-318). Stored runs are only ever
     * added, and the replayer checks every row it kept against the rows it
     * is given, so this is for whatever rewrites or removes a thread's runs.
     */
    forgetReplay(threadId: string) {
        this.replayer.forget(this.replayKey + threadId);
    }

    /**
     * Whose turn produced each of the thread's stored tool results (CB-210),
     * by tool call id: the person its run's trace says started it (CB-185,
     * the person a turn acts for), or '' when no person did (a scheduled
     * turn) or its run was stored before traces said. A result a request
     * brought (a page review's answer) is that run's too, as is an
     * approval's note (keyed `message:<id>`, `noteActorKey`), which quotes
     * the approved action's result, and the model's reasoning (keyed
     * `reasoning:<id>`, `reasoningActorKey`), which can retell it.
     */
    toolActors(threadId: string): Map<string, string> {
        const rows = this.db
            .prepare(
                `SELECT json_extract(r.trace, '$.trigger.kind') AS kind,
           json_extract(r.trace, '$.trigger.id') AS id,
           CASE json_extract(e.value, '$.type')
             WHEN 'TOOL_CALL_RESULT' THEN json_extract(e.value, '$.toolCallId')
             ELSE 'reasoning:' || json_extract(e.value, '$.messageId')
           END AS call
         FROM agent_runs AS r, json_each(r.events) AS e
         WHERE r.threadId=? AND r.status!='running'
           AND json_extract(e.value, '$.type')
             IN ('TOOL_CALL_RESULT', 'REASONING_MESSAGE_START')
         UNION ALL
         SELECT json_extract(r.trace, '$.trigger.kind'),
           json_extract(r.trace, '$.trigger.id'),
           json_extract(m.value, '$.toolCallId')
         FROM agent_runs AS r, json_each(r.events) AS e,
           json_each(json_extract(e.value, '$.input.messages')) AS m
         WHERE r.threadId=? AND r.status!='running'
           AND json_extract(e.value, '$.type')='RUN_STARTED'
           AND json_extract(m.value, '$.role')='tool'
         UNION ALL
         SELECT json_extract(r.trace, '$.trigger.kind'),
           json_extract(r.trace, '$.trigger.id'),
           'message:' || json_extract(m.value, '$.id')
         FROM agent_runs AS r, json_each(r.events) AS e,
           json_each(json_extract(e.value, '$.input.messages')) AS m
         WHERE r.threadId=? AND r.status!='running'
           AND json_extract(e.value, '$.type')='RUN_STARTED'
           AND json_extract(m.value, '$.role')='user'
           AND (json_extract(m.value, '$.metadata.socioSource')=?
             OR substr(json_extract(m.value, '$.id'), 1, ?)=?)`,
            )
            .all(
                threadId,
                threadId,
                threadId,
                approvalNoteSource,
                approvalNoteMessagePrefix.length,
                approvalNoteMessagePrefix,
            ) as {
            kind: unknown;
            id: unknown;
            call: unknown;
        }[];
        const actors = new Map<string, string>();
        for (const { kind, id, call } of rows) {
            if (typeof call === 'string' && call) {
                actors.set(call, kind === 'person' && typeof id === 'string' ? id : '');
            }
        }
        return actors;
    }

    /**
     * Recent runs across all threads, newest first, with the error message of
     * failed and interrupted runs. Event payloads never leave this method.
     */
    recentRuns(
        options: {
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
        } = {},
    ): StoredRun[] {
        const status = options.status ?? null;
        const scoped = options.only || options.initiatedIn;
        const rows = this.db
            .prepare(
                `SELECT runId, threadId, status, source, startedAt, finishedAt, errorDetail,
           CASE WHEN status IN ('failed', 'interrupted') THEN (
             SELECT json_extract(value, '$.message') FROM json_each(events)
             WHERE json_extract(value, '$.type')='RUN_ERROR' LIMIT 1
           ) END AS error,
           json_object('end', json_extract(trace, '$.end'),
             'totals', json_extract(trace, '$.totals')) AS trace,
           json_extract(trace, '$.trigger') AS trigger
         FROM agent_runs WHERE (? IS NULL OR status=?)
           AND threadId NOT IN (SELECT value FROM json_each(?))
           AND (? IS NULL OR threadId IN (SELECT value FROM json_each(?))
             OR (threadId IN (SELECT value FROM json_each(?))
               AND json_extract(trace, '$.trigger.kind')='person'
               AND json_extract(trace, '$.trigger.id')=?))
         ORDER BY seq DESC LIMIT ?`,
            )
            .all(
                status,
                status,
                JSON.stringify(options.exclude ?? []),
                scoped ? 1 : null,
                JSON.stringify(options.only ?? []),
                JSON.stringify(options.initiatedIn?.threadIds ?? []),
                options.initiatedIn?.personId ?? null,
                options.limit ?? 200,
            ) as unknown as Array<
            Omit<StoredRun, 'trace' | 'trigger'> & {
                trace: string;
                trigger: string | null;
            }
        >;
        return rows.map(({ trigger: stored, ...row }) => {
            const trace = parseTrace(row.trace);
            const trigger = runActorOf(stored);
            return {
                ...row,
                trace: (trace && traceSummary(trace)) ?? null,
                ...(trigger ? { trigger } : {}),
            };
        });
    }

    /** Where a turn records what grounded it (CB-194), in `run_refs`. */
    refRecorder(runId: string, threadId: string): RunRefRecorder {
        return runRefRecorder(this.db, runId, threadId);
    }

    /**
     * One run's trace (CB-128), with the thread it belongs to for the
     * caller's access check. Never its events.
     */
    runTrace(runId: string) {
        const row = this.db
            .prepare('SELECT runId, threadId, status, startedAt, finishedAt, trace FROM agent_runs WHERE runId=?')
            .get(runId) as
            | {
                  runId: string;
                  threadId: string;
                  status: RunStatus;
                  startedAt: number;
                  finishedAt: number | null;
                  trace: string | null;
              }
            | undefined;
        return row && { ...row, trace: parseTrace(row.trace) };
    }

    /**
     * A finished run's stored events: only for exporting its content, when
     * an admin turned on "Include content in traces" (CB-128).
     */
    runEvents(runId: string): BaseEvent[] {
        const row = this.db.prepare('SELECT events FROM agent_runs WHERE runId=?').get(runId) as
            | { events: string }
            | undefined;
        return row ? (JSON.parse(row.events) as BaseEvent[]) : [];
    }

    /** Runs of the given threads, newest first, at or before `before` (ms). */
    runsOfThreads(threadIds: readonly string[], { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
        return this.db
            .prepare(
                `SELECT runId, threadId, status, source, startedAt, finishedAt FROM agent_runs
         WHERE threadId IN (SELECT value FROM json_each(?)) AND startedAt <= ?
         ORDER BY startedAt DESC LIMIT ?`,
            )
            .all(JSON.stringify(threadIds), before, limit) as unknown as Array<{
            runId: string;
            threadId: string;
            status: string;
            source: string | null;
            startedAt: number;
            finishedAt: number | null;
        }>;
    }

    /**
     * A thread's runs that started in [from, to], oldest first, each with
     * the id of the user message it began with (what a link to the turn
     * scrolls to). Event payloads never leave this method.
     */
    turnsBetween(threadId: string, from: number, to: number) {
        return this.db
            .prepare(
                `SELECT runId, status, startedAt, finishedAt, (
           SELECT json_extract(message.value, '$.id')
           FROM json_each(events) AS event,
             json_each(json_extract(event.value, '$.input.messages')) AS message
           WHERE json_extract(event.value, '$.type')='RUN_STARTED'
             AND json_extract(message.value, '$.role')='user'
           LIMIT 1
         ) AS messageId
         FROM agent_runs WHERE threadId=? AND startedAt BETWEEN ? AND ?
         ORDER BY startedAt, seq`,
            )
            .all(threadId, from, to) as unknown as Array<{
            runId: string;
            status: string;
            startedAt: number;
            finishedAt: number | null;
            messageId: string | null;
        }>;
    }

    hasHistory(threadId: string): boolean {
        return !!this.db.prepare('SELECT 1 FROM agent_runs WHERE threadId=? LIMIT 1').get(threadId);
    }

    /** Aborts runs in progress; their rows are closed on the next start. */
    close() {
        clearTimeout(this.recoveryTimer);
        this.replayer.forgetPrefix(this.replayKey);
        if (!this.db.isOpen) {
            return;
        }
        for (const run of this.active.values()) {
            clearInterval(run.ownershipTimer);
            this.ownership.release(run.lease);
            run.stopRequested = true;
            try {
                run.agent.abortRun();
            } catch {
                // Closing must not fail because one agent could not abort.
            }
        }
        for (const timer of this.flushTimers.values()) {
            clearTimeout(timer);
        }
        this.flushTimers.clear();
        if (this.db.isOpen) {
            this.runtime.detachSync(this.db);
            this.db.close();
        }
    }
}
