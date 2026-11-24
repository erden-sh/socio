import type { ReactionKind } from '../chat/reactions.js';
/**
 * A turn's trace (CB-128): what each model round and tool call did, how
 * long it took and how it ended, and why the turn's loop stopped. The
 * server records it with the run (`agent_runs.trace`) and shows it in Runs;
 * it holds names, times, counts and short codes, never content.
 */
import type { LoopEnd, LoopEndReason } from '../loop-end.js';

import type { ContextCompactionInfo } from './run-phase.js';

/**
 * A trace entry from inside a Dot turn: a CUSTOM event the runner takes
 * out of the stream into the run's trace, so clients never get it.
 */
export const RUN_TRACE_EVENT = 'company-brain.trace';
/** Why a model round's output ended. */
export type RoundStop =
    | 'stop'
    | 'tool_calls'
    | 'length'
    | 'content_filter'
    | 'error'
    /** The turn was stopped or timed out while the round streamed. */
    | 'cancelled';
/** How a tool call ended: `refused` when a permission, a site or a person declined. */
export type ToolOutcome = 'ok' | 'error' | 'refused' | 'timeout';

/** The turn's model and round cap, once, as it starts. */
export interface TraceTurn {
    kind: 'turn';
    /** "ChatGPT (Pro)", "Homelab". */
    label: string;
    model: string | null;
    /** `shared` or `byo:<kind>`. */
    source: string;
    /** The shared backend's id (CB-195: what its turns cost). */
    backendId?: string;
    cap: number;
}
export interface TraceRound {
    kind: 'round';
    /** 1 for the first. */
    round: number;
    startedAt: number;
    endedAt: number;
    /** To the first visible output (text, reasoning or a tool call). */
    firstOutputMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    stop: RoundStop;
    /** A short error class ("chatgpt_usage_limit", "TypeError"). */
    error?: string;
    /**
     * The round's prompt again, compacted harder, after the model refused it
     * as too long (CB-129): 1 for the first retry. Part of the same round.
     */
    retry?: number;
    /**
     * A request for the chat's running notes, made while the round's prompt
     * was fitted (CB-129): not a round of the loop.
     */
    summary?: true;
    /**
     * Why the round's prompt went again, when not for its length (CB-140):
     * the model was busy or out of reach, or the turn moved to the shared
     * model. `retry` numbers it.
     */
    cause?: RetryCause;
    /**
     * What the round showed of the model's reasoning (CB-185). Absent in
     * traces stored before.
     */
    reasoningKind?: ReasoningKind;
}
/**
 * What a round showed of the model's reasoning (CB-185): a provider's
 * `summary` of it (ChatGPT plans), the `raw` reasoning (self-hosted models
 * that stream their thinking), none shown though the model reported
 * reasoning tokens (`hidden`), or `none` at all. Reasoning lengths and
 * tokens are only compared within one kind.
 */
export type ReasoningKind = 'summary' | 'raw' | 'hidden' | 'none';
export const REASONING_KINDS: readonly ReasoningKind[] = ['summary', 'raw', 'hidden', 'none'];
/** A turn's reasoning kind: its rounds' one kind, or `mixed` (after a fallback). */
export type TurnReasoningKind = ReasoningKind | 'mixed';
/**
 * Who or what a turn or a message is from (CB-185): a person, a socio, a
 * schedule (its task), an external agent, or the server itself (a job's
 * report). Chats can have several of each.
 */
export type RunActorKind = 'person' | 'socio' | 'schedule' | 'agent' | 'system';
export const RUN_ACTOR_KINDS: readonly RunActorKind[] = ['person', 'socio', 'schedule', 'agent', 'system'];
export interface RunActor {
    kind: RunActorKind;
    /** The person's, socio's or task's id, when there is one. */
    id?: string;
}
/** One message a turn added, and who wrote it (CB-185). Never its content. */
export interface TraceMessage {
    id: string;
    author: RunActor;
    at: number;
}
/** Why a round's request is sent again (CB-140). */
export type RetryCause = 'rate_limited' | 'unavailable' | 'fallback';
/** Why a model can't serve now: busy, out of reach, or at its plan's limit. */
export type BusyReason = 'rate_limited' | 'unavailable' | 'usage_limit';
/**
 * A request the model turned away before any output (a rate limit, a 5xx,
 * a dropped connection), sent again after a wait (CB-140).
 */
export interface TraceRetry {
    kind: 'retry';
    round: number;
    /** When the wait began. */
    at: number;
    reason: Exclude<BusyReason, 'usage_limit'>;
    /**
     * The wait before the next request: the backend's hint, else a backoff;
     * what was waited when Stop or the time limit cut it short.
     */
    waitMs: number;
    /** Stop or the turn's time limit ended the wait: nothing was sent again. */
    cutShort?: boolean;
    /** The attempt that failed: 1 for the round's first request. */
    attempt: number;
    /** Its short error class ("chatgpt_rate_limited", "http_503"). */
    error?: string;
}
/**
 * The person's own model stayed busy, so the rest of the turn ran on the
 * shared model (CB-140): once a turn at most.
 */
export interface TraceFallback {
    kind: 'fallback';
    round: number;
    at: number;
    /** The models' labels. */
    from: string;
    to: string;
    reason: BusyReason;
}
/**
 * A round's prompt fitted to the model's context (CB-129): the
 * `company-brain.context-compaction` event, with the round it was for.
 */
export interface TraceCompaction extends ContextCompactionInfo {
    kind: 'compaction';
    round: number;
    at: number;
}
/**
 * One update of the chat's running notes (CB-137): the summarizer's request
 * (the round entry marked `summary` times it too) or, when it failed or the
 * turn had had its summaries, the plain built-in summary kept instead.
 */
export interface TraceNotes {
    kind: 'notes';
    /** The round whose prompt needed them. */
    round: number;
    startedAt: number;
    endedAt: number;
    /** Whose model was asked: the shared one or the chat's own. */
    by: 'shared' | 'chat';
    model: string | null;
    /** Turns folded in by this update. */
    turns: number;
    inputTokens?: number;
    outputTokens?: number;
    /**
     * The plain summary was kept: the request failed (`error`), its answer
     * had no summary (`empty`), or the turn had had its summaries (`cap`, no
     * request).
     */
    fallback?: 'error' | 'empty' | 'cap';
}
export interface TraceTool {
    kind: 'tool';
    /** The round whose output called it. */
    round: number;
    name: string;
    callId?: string;
    startedAt: number;
    endedAt: number;
    outcome: ToolOutcome;
    /** A short error class ("TimeoutError", "rate_limited"), never the message. */
    error?: string;
    /**
     * The image its result named (CB-157, a screenshot): the attachment's
     * id, which the run view shows to whoever can read the chat.
     */
    image?: string;
}
/** The turn handed over to a person: an approval request, or a tool the browser runs. */
export interface TraceWait {
    kind: 'wait';
    for: 'approval' | 'person';
    /** The tool that asked. */
    name: string;
    round: number;
    at: number;
}
/**
 * The reactions the turn's note told the Dot about (CB-133): how many of
 * each, never whose or on which message.
 */
export interface TraceReactions {
    kind: 'reactions';
    at: number;
    counts: Partial<Record<ReactionKind, number>>;
}
export type TraceEntry =
    | TraceTurn
    | TraceRound
    | TraceTool
    | TraceWait
    | TraceCompaction
    | TraceNotes
    | TraceReactions
    | TraceRetry
    | TraceFallback;

/** A turn's trace as stored and served. */
export interface RunTrace {
    turn?: Omit<TraceTurn, 'kind'>;
    rounds: TraceRound[];
    tools: TraceTool[];
    waits: TraceWait[];
    /** Absent in traces stored before CB-129. */
    compactions?: TraceCompaction[];
    /** Absent in traces stored before CB-137. */
    notes?: TraceNotes[];
    /** The reactions the Dot was told about at the start of the turn (CB-133). */
    reactions?: TraceReactions;
    /** Requests sent again after the model turned them away (CB-140). */
    retries?: TraceRetry[];
    /** The switch to the shared model, when the turn made it (CB-140). */
    fallback?: TraceFallback;
    /** Set once the turn ends; `inferred` when no loop-end event came. */
    end?: LoopEnd & { inferred?: boolean };
    /** The rounds' token counts added up, where the model reported them. */
    totals?: TraceTotals;
    /** Entries left out past the trace's size cap. */
    dropped?: number;
    /**
     * When the server got the turn's request (CB-185): the message posted,
     * the Telegram update handed over, or the schedule due. Its queue time
     * is the run's start less this. Absent in traces stored before.
     */
    receivedAt?: number;
    /**
     * Who or what started the turn (CB-185), set by the server, never from
     * request input. Absent in traces stored before.
     */
    trigger?: RunActor;
    /**
     * The turn brings news to everyone it reaches, its trigger included (a
     * long run's report, CB-215): a room counts it unread for every member.
     * Set by the server; absent for every other turn.
     */
    news?: true;
    /** The messages the turn added, with their authors (CB-185). */
    messages?: TraceMessage[];
    /**
     * The work cycle the turn was a step of and the context it ran under
     * (CB-211): ids and kinds only. Absent in traces stored
     * before, and for turns outside a conversation's cycles.
     */
    cycle?: TraceCycle;
}
/** Why a work cycle stopped at a limit (`cycleExhausted`, CB-211). */
export type TraceCycleStop = 'deadline' | 'tokens' | 'handoffs' | 'spend';
export const TRACE_CYCLE_STOPS: readonly TraceCycleStop[] = ['deadline', 'tokens', 'handoffs', 'spend'];
/** A run's work cycle and turn context, as its trace keeps them (CB-211). */
export interface TraceCycle {
    id: string;
    /** `private` or `room`. */
    kind: 'private' | 'room';
    /** 0 for the step a message started; one more per handoff. */
    hop: number;
    /** Whose access, data and subscription the step used. */
    actingUserId: string;
    /** The socio that ran the step. */
    dotId: string;
    /** Who paid for its model use, once the turn's model was known. */
    billing?: 'person' | 'workspace';
    /** The cycle's tokens when the step ended, its earlier steps included. */
    tokens?: number;
    /** Its spend in USD when every model request reported one; else absent. */
    costUsd?: number;
    /** The limit that stopped the cycle in this step, if one did. */
    stop?: TraceCycleStop;
    /** Tools still running when the step was stopped: they may finish anyway. */
    unstopped?: string[];
}
export interface TraceTotals {
    rounds: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    /** Of the input, what the model read from its prompt cache (CB-139). */
    cachedTokens?: number;
    /** The rounds' reasoning kind (CB-185), when they said. */
    reasoningKind?: TurnReasoningKind;
}

/** What the Runs list shows of a turn's trace. */
export interface RunTraceSummary {
    reason: LoopEndReason;
    rounds: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
}

/** `GET /api/runs/:runId/trace`. */
export interface RunTraceView {
    runId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    /** Null for turns stored before traces were recorded. */
    trace: RunTrace | null;
}

/**
 * Whether a round entry is a round of the loop: not a retry of one, nor a
 * request for the chat's notes (CB-129).
 */
export const loopRound = (round: TraceRound) => !round.retry && !round.summary;

/**
 * The rounds' tokens added up, retries and notes' requests included (the
 * model ran them all); a count is left out when no round had it. `rounds`
 * counts the loop's rounds only.
 */
export function traceTotals(rounds: readonly TraceRound[]): TraceTotals {
    const sum = (key: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cachedTokens') => {
        const known = rounds.filter((round) => round[key] !== undefined);
        return known.length ? { [key]: known.reduce((total, round) => total + round[key]!, 0) } : {};
    };
    const reasoning = turnReasoningKind(rounds);
    return {
        rounds: rounds.filter(loopRound).length,
        ...sum('inputTokens'),
        ...sum('outputTokens'),
        ...sum('reasoningTokens'),
        ...sum('cachedTokens'),
        ...(reasoning ? { reasoningKind: reasoning } : {}),
    };
}

/**
 * A turn's reasoning kind from its rounds' (CB-185), the notes' requests
 * left out (another model may write them): their one kind, `mixed` when
 * they differ, undefined when none said. A round with no reasoning at all
 * (a short tool step) says nothing of the model's kind, so it only counts
 * when every round is one.
 */
export function turnReasoningKind(rounds: readonly TraceRound[]): TurnReasoningKind | undefined {
    const kinds = new Set(
        rounds.filter((round) => !round.summary && round.reasoningKind).map((round) => round.reasoningKind!),
    );
    if (kinds.size > 1) {
        kinds.delete('none');
    }
    if (kinds.size > 1) {
        return 'mixed';
    }
    return kinds.values().next().value;
}

/**
 * The share of the input the model read from its prompt cache, in percent
 * (CB-139); undefined when it reported none.
 */
export function cachedPercent(counts: { inputTokens?: number; cachedTokens?: number }) {
    return counts.cachedTokens !== undefined && counts.inputTokens
        ? Math.round((Math.min(counts.cachedTokens, counts.inputTokens) / counts.inputTokens) * 100)
        : undefined;
}

/** What people read for each reason. */
export const LOOP_END_LABELS: Record<LoopEndReason, string> = {
    completed: 'Completed',
    round_cap: 'Hit the round cap',
    time_limit: 'Hit the time limit',
    cycle_limit: 'Hit its message’s limit',
    output_limit: 'Hit the output limit',
    error: 'Error',
    model_unavailable: 'Model unavailable',
    stopped: 'Stopped',
    interrupted: 'Interrupted',
};
