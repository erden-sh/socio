import type { AnyTextAdapter } from '@tanstack/ai';

import { estimateRequestTokens, reportedCost } from '@socio/foundation/cycles/estimates';
import { OUTPUT_LIMIT_RESULT, incompleteAtLimit } from '@socio/foundation/turns/output-limit';
import { REACTIONS } from '@socio/shared/chat/reactions';
import { LOOP_END_REASONS, type LoopEnd } from '@socio/shared/loop-end';
import { ATTACHMENT_ID } from '@socio/shared/media-types';
import type { ReasoningOutput, ReasoningOutputAdapter } from '@socio/shared/reasoning-output';
import {
    loopRound,
    traceTotals,
    type BusyReason,
    type ReasoningKind,
    type RetryCause,
    type RoundStop,
    type RunActor,
    type RunTrace,
    type RunTraceSummary,
    type TraceCompaction,
    type TraceEntry,
    type TraceFallback,
    type TraceNotes,
    type TraceReactions,
    type TraceRetry,
    type TraceRound,
    type TraceInputIssue,
    type TraceInputPath,
    type TraceInputRepair,
    type TraceTool,
    type TraceToolInput,
    type TraceTurn,
    type TraceWait,
    type ToolOutcome,
    REASONING_KINDS,
    RUN_ACTOR_KINDS,
    TRACE_INPUT_TYPES,
} from '@socio/shared/runs/run-trace';
import { count, isObject, roundTokens } from '@socio/shared/runs/token-usage';
import { toolImageOf } from '@socio/shared/tool-images';
import type { AgentRunStatus as RunStatus } from '@socio/shared/types';

import type { CycleLedger } from '../cycles/contract.js';

import type { FitTrace } from './contract.js';
import { CALL_ID, EXPECTED_TYPES, ISSUE_CODES, isRepairText } from './tool-input-repair.js';

/**
 * A turn's trace (CB-128), in two halves. Inside a Dot turn, `TurnTracer`
 * times each model round at the adapter (so every inference backend is
 * covered) and each tool call at its executor, and hands each entry to the
 * turn as a `RUN_TRACE_EVENT`. The runner's `TraceRecorder` collects them
 * with the loop-end event into the run's stored trace. Entries hold names,
 * times, token counts and short codes: never prompts, answers, arguments
 * or results. Fitting the context (CB-129) sits between the two adapter
 * wrappers and says which requests are a retry or for the chat's notes,
 * and what each compaction did (`fit`); the turn's retries of a busy model
 * and its switch to the shared one (CB-140) say theirs (`retries`).
 *
 * The same places keep the turn's work cycle to its budget (CB-211): a
 * `ledger` gets each request to the model before it is sent, which it may
 * refuse, and its tokens and cost once it ends; and each tool's run.
 */

/** Chunks that end a round's wait: the model's first visible output. */
const VISIBLE = new Set([
    'TOOL_CALL_START',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'REASONING_START',
    'REASONING_MESSAGE_CONTENT',
]);
/** Chunks that carry reasoning text the model showed. */
const REASONING_TEXT = 'REASONING_MESSAGE_CONTENT';
/** A self-hosted model's thinking inline, at the start of its text. */
const INLINE_THINKING = /^\s*<think>/;
const THINK_TAG = '<think>';
/** The most entries a trace keeps; later ones are counted as dropped. */
export const TRACE_MAX_ENTRIES = 400;
/** A code or identifier short enough for a trace or a log line. */
const CODE = /^[A-Za-z_][\w.:-]{0,47}$/;
/** `ok: false` reasons and error codes that are a refusal rather than a failure. */
const REFUSALS = new Set([
    'http_401',
    'http_403',
    'blocked',
    'rate_limited',
    'host_stopped',
    'browser_identity',
    'denied',
    'forbidden',
    'not_allowed',
    'permission',
]);
/** Tool results longer than this are not read for their outcome. */
const RESULT_READ_MAX = 64 * 1024;

const codeOf = (value: unknown) => (typeof value === 'string' && CODE.test(value) ? value : undefined);

/**
 * An error's class for a trace: its code ("chatgpt_usage_limit",
 * "incomplete-stream"), its HTTP status ("http_503"), or its name
 * ("TimeoutError"). Never its message.
 */
export function errorClass(error: unknown): string {
    if (!isObject(error) && !(error instanceof Error)) {
        return 'Error';
    }
    const record = error as Record<string, unknown>;
    const code = codeOf(record.code) ?? codeOf(record.kind);
    if (code) {
        return code;
    }
    const nested = isObject(record.error) ? codeOf(record.error.code) : undefined;
    if (nested) {
        return nested;
    }
    const status = record.status;
    if (typeof status === 'number' && Number.isInteger(status)) {
        return `http_${status}`;
    }
    // A model stream's RUN_ERROR keeps only the message, which the OpenAI
    // SDK starts with the HTTP status ("400 image input …"): just the status.
    const leading = typeof record.message === 'string' ? record.message.match(/^([1-5]\d\d)\b/) : null;
    if (leading) {
        return `http_${leading[1]}`;
    }
    const name = error instanceof Error ? (error.name !== 'Error' ? error.name : error.constructor.name) : undefined;
    return codeOf(name) ?? 'Error';
}

/** A thrown tool error's outcome. */
function thrownOutcome(error: unknown): {
    outcome: ToolOutcome;
    error: string;
} {
    const name = errorClass(error);
    if (/timeout|timed_?out/i.test(name)) {
        return { outcome: 'timeout', error: name };
    }
    if (name === 'http_403' || /denied|forbidden|permission/i.test(name)) {
        return { outcome: 'refused', error: name };
    }
    return { outcome: 'error', error: name };
}

/**
 * A tool result's outcome, read the way the chat reads it (`toolOutcome`
 * in the client): `ok: false` with its reason, an `error`, a nonzero exit
 * code, a denial, a site that refused (`notice`) or an approval request
 * now waiting for its person. Only codes are kept.
 */
export function resultOutcome(result: unknown): {
    outcome: ToolOutcome;
    error?: string;
    wait?: 'approval';
} {
    let data = result;
    if (typeof result === 'string' && result.length <= RESULT_READ_MAX) {
        try {
            data = JSON.parse(result);
        } catch {
            data = undefined;
        }
    }
    if (!isObject(data)) {
        return { outcome: 'ok' };
    }
    if (data.status === 'pending_approval') {
        return { outcome: 'ok', wait: 'approval' };
    }
    if (data.status === 'denied') {
        return { outcome: 'refused', error: 'denied' };
    }
    if (data.ok === false) {
        const reason = codeOf(data.reason) ?? codeOf(data.code);
        if (reason === 'timeout') {
            return { outcome: 'timeout', error: reason };
        }
        if (reason && REFUSALS.has(reason)) {
            return { outcome: 'refused', error: reason };
        }
        return { outcome: 'error', error: reason ?? 'not_ok' };
    }
    if (typeof data.notice === 'string') {
        return { outcome: 'refused', error: 'site_refused' };
    }
    if (data.error !== undefined && data.error !== null && data.error !== false) {
        const code = codeOf(data.code);
        if (code && REFUSALS.has(code)) {
            return { outcome: 'refused', error: code };
        }
        return { outcome: 'error', error: code ?? 'tool_error' };
    }
    if (typeof data.exitCode === 'number' && data.exitCode !== 0) {
        return { outcome: 'error', error: 'exit_code' };
    }
    if (data.status === 'error' || data.status === 'failed') {
        return { outcome: 'error', error: 'failed' };
    }
    return { outcome: 'ok' };
}

/**
 * A round's reasoning kind: what its adapter shows when the round showed
 * reasoning, else `hidden` when the model counted reasoning tokens.
 */
export function reasoningKindOf(
    output: ReasoningOutput | undefined,
    shown: boolean,
    reasoningTokens: number | undefined,
): ReasoningKind {
    if (shown) {
        return output === 'summary' ? 'summary' : 'raw';
    }
    return reasoningTokens ? 'hidden' : 'none';
}

const STOPS: Record<string, RoundStop> = {
    stop: 'stop',
    tool_calls: 'tool_calls',
    length: 'length',
    max_output_tokens: 'length',
    max_tokens: 'length',
    content_filter: 'content_filter',
};

/**
 * What the retries of a busy model tell the trace (CB-140): each wait, and
 * that the next request repeats the round's.
 */
export interface RetryTrace {
    retry(entry: Omit<TraceRetry, 'kind' | 'round' | 'at'> & { at?: number }): void;
    again(kind: { retry: number; cause: RetryCause }): void;
}

/** A TanStack tool as `chat()` takes it: server tools have `execute`. */
interface ChatTool {
    name: string;
    execute?: (input: never, context?: never) => unknown;
}

/**
 * One Dot turn's tracing: entries go to `emit` (the turn's side events).
 * Tracing never touches the turn: a failure to trace is dropped.
 */
export class TurnTracer {
    /** The current model round (0 before the first). */
    private round = 0;
    /** Whether the current round's own request went to the model yet. */
    private sent = true;
    /** What the next request to the model is, when fitting said so. */
    private next: { summary: true } | { retry: number } | undefined;
    /**
     * The round's own request again, after a busy model or the switch to the
     * shared one (CB-140): kept past a notes' request made first.
     */
    private repeat: { retry: number; cause: RetryCause } | undefined;
    constructor(
        private emit: (entry: TraceEntry) => void,
        private now: () => number = Date.now,
        /** The turn's work cycle budget (CB-211); none outside a cycle. */
        private ledger?: CycleLedger,
    ) {}
    /**
     * The context fitting's side of the trace (CB-129): a retry is traced
     * as a request of the same round, a notes' summary as one marked
     * `summary`, and each compaction as an entry of its round.
     */
    readonly fit: FitTrace = {
        request: (kind) => {
            this.next = kind;
        },
        compaction: (info) =>
            this.send({
                kind: 'compaction',
                round: this.round,
                at: this.now(),
                ...info,
            }),
        notes: (update) => this.send({ kind: 'notes', round: this.round, ...update }),
    };
    /**
     * The round a request to the model belongs to, and what it is when not
     * the round's own. `toolCalls` opens each round; without it (an adapter
     * traced on its own), each request is a round.
     */
    private request() {
        const kind = this.next;
        this.next = undefined;
        if (kind && 'summary' in kind) {
            return { round: this.round, ...kind };
        }
        const again = kind ?? this.repeat;
        this.repeat = undefined;
        if (!again) {
            if (this.sent) {
                this.round += 1;
            }
            this.sent = true;
        }
        return { round: this.round, ...again };
    }
    /** A round of the agent loop starts. */
    private open() {
        this.round += 1;
        this.sent = false;
    }
    private send(entry: TraceEntry) {
        try {
            this.emit(entry);
        } catch {
            // Tracing must never affect the turn.
        }
    }
    /** The retries of a busy model (CB-140): each wait, and the request after it. */
    readonly retries: RetryTrace = {
        retry: (entry) => this.send({ kind: 'retry', round: this.round, at: this.now(), ...entry }),
        again: (kind) => {
            this.repeat = kind;
        },
    };
    /**
     * The switch to the shared model (CB-140): its entry, and the round's
     * request on the shared model marked as a repeat of the round.
     */
    fallback(entry: Omit<TraceFallback, 'kind' | 'round' | 'at'>) {
        this.ledger?.fallback();
        this.send({
            kind: 'fallback',
            round: this.round,
            at: this.now(),
            ...entry,
        });
        this.repeat = { retry: 1, cause: 'fallback' };
    }
    /**
     * A server tool's input that failed its schema, repaired or not
     * (`toolInputRepair`): an entry of the round whose output called it.
     */
    toolInput(entry: Omit<TraceToolInput, 'kind' | 'round' | 'at'>) {
        this.send({ kind: 'tool_input', round: this.round, at: this.now(), ...entry });
    }
    /** An entry from outside the model loop: what a module told the Dot (CB-133). */
    note(entry: TraceEntry) {
        this.send(entry);
    }
    /** The turn's model and round cap, as it starts. */
    start(turn: Omit<TraceTurn, 'kind'>) {
        this.ledger?.billing(turn.source);
        this.send({ kind: 'turn', ...turn });
    }
    /**
     * The model's adapter with each `chatStream` call (one request to the
     * model) timed: its start, first visible output, end, tokens and stop
     * reason. It wraps the model's own stream, under the turn's checks, so a
     * round the output limit cut off is recorded as `length` even when the
     * turn goes on as if it ended in tool calls.
     */
    adapter(adapter: AnyTextAdapter) {
        const tracer = {
            request: () => this.request(),
            now: () => this.now(),
            send: (entry: TraceEntry) => this.send(entry),
            output: (adapter as ReasoningOutputAdapter).reasoningOutput,
            ledger: this.ledger,
        };
        const stream = async function* (
            options: Parameters<AnyTextAdapter['chatStream']>[0],
            request: ReturnType<TurnTracer['request']>,
        ) {
            const startedAt = tracer.now();
            let firstOutputMs: number | undefined;
            let end: Pick<TraceRound, 'stop' | 'error'> | undefined;
            let tokens: ReturnType<typeof roundTokens> = {};
            let failure: unknown;
            // Whether the round showed reasoning (CB-185): reasoning chunks, or
            // a self-hosted model's `<think>` opening its text.
            let reasoned = false;
            // The text so far, until it shows whether it opens with `<think>`:
            // a server may split the tag across chunks.
            let head: string | undefined = '';
            // Its tokens reserved from the work cycle first (CB-211): a request
            // the cycle can't afford is never sent (`CycleLimitError`).
            const hold = tracer.ledger?.reserve(
                estimateRequestTokens(options as Parameters<typeof estimateRequestTokens>[0]),
            );
            let cost: number | undefined;
            try {
                for await (const chunk of adapter.chatStream(options)) {
                    try {
                        if (firstOutputMs === undefined && VISIBLE.has(chunk.type)) {
                            firstOutputMs = tracer.now() - startedAt;
                        }
                        if (chunk.type === REASONING_TEXT) {
                            reasoned = true;
                        } else if (chunk.type === 'TEXT_MESSAGE_CONTENT' && head !== undefined) {
                            const { delta } = chunk as { delta?: unknown };
                            head += typeof delta === 'string' ? delta : '';
                            if (INLINE_THINKING.test(head)) {
                                reasoned = true;
                            }
                            if (reasoned || head.trimStart().length >= THINK_TAG.length) {
                                head = undefined;
                            }
                        }
                        if (chunk.type === 'RUN_FINISHED') {
                            const { finishReason, usage } = chunk as {
                                finishReason?: unknown;
                                usage?: unknown;
                            };
                            end = {
                                stop: (typeof finishReason === 'string' && STOPS[finishReason]) || 'stop',
                            };
                            tokens = roundTokens(usage);
                            cost = reportedCost(usage);
                        } else if (chunk.type === 'RUN_ERROR')
                        // A ChatGPT plan's `response.incomplete` at the output limit
                        // is a cut-off round, not a failure (CB-126).
                        {
                            end = incompleteAtLimit(chunk)
                                ? { stop: 'length' }
                                : { stop: 'error', error: errorClass(chunk) };
                        }
                    } catch {
                        // Tracing must never affect the turn.
                    }
                    yield chunk;
                }
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                // Reconciled once, from what the provider reported.
                try {
                    const reported =
                        tokens.inputTokens !== undefined || tokens.outputTokens !== undefined
                            ? (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0)
                            : undefined;
                    hold?.settle({
                        ...(reported !== undefined ? { tokens: reported } : {}),
                        ...(cost !== undefined ? { costUsd: cost } : {}),
                        output: firstOutputMs !== undefined,
                    });
                } catch {
                    // The budget's bookkeeping must never fail the request.
                }
                const aborted =
                    !end && (failure === undefined || (failure instanceof Error && failure.name === 'AbortError'));
                tracer.send({
                    kind: 'round',
                    ...request,
                    startedAt,
                    endedAt: tracer.now(),
                    ...(firstOutputMs !== undefined ? { firstOutputMs } : {}),
                    ...tokens,
                    reasoningKind: reasoningKindOf(tracer.output, reasoned, tokens.reasoningTokens),
                    ...(end ??
                        (aborted
                            ? { stop: 'cancelled' as const }
                            : { stop: 'error' as const, error: errorClass(failure) })),
                });
            }
        };
        const traced = Object.create(adapter) as AnyTextAdapter;
        // When the request is made, not when its stream is first read.
        traced.chatStream = (options) => stream(options, tracer.request());
        return traced;
    }
    /**
     * The turn's checked adapter with its tool calls noted as the agent loop
     * gets them: a call the checks failed before it ran (unreadable
     * arguments, or cut off by the output limit) is a tool entry, and a call
     * to one of `clientTools` (the browser runs it, for the person) is a wait.
     */
    toolCalls(adapter: AnyTextAdapter, clientTools: ReadonlySet<string>) {
        const tracer = {
            open: () => this.open(),
            round: () => this.round,
            now: () => this.now(),
            send: (entry: TraceEntry) => this.send(entry),
        };
        const traced = Object.create(adapter) as AnyTextAdapter;
        traced.chatStream = async function* (options) {
            // The agent loop asks once a round, whatever the requests beneath.
            tracer.open();
            for await (const chunk of adapter.chatStream(options)) {
                try {
                    if (chunk.type === 'TOOL_CALL_END') {
                        const call = chunk as {
                            toolCallId?: string;
                            toolCallName?: string;
                            toolName?: string;
                            state?: unknown;
                            result?: unknown;
                        };
                        const name = String(call.toolCallName ?? call.toolName ?? 'unknown').slice(0, 64);
                        const round = tracer.round();
                        const at = tracer.now();
                        // The tool never ran.
                        if (call.state === 'output-error') {
                            tracer.send({
                                kind: 'tool',
                                round,
                                name,
                                ...(call.toolCallId ? { callId: call.toolCallId.slice(0, 64) } : {}),
                                startedAt: at,
                                endedAt: at,
                                outcome: 'error',
                                error: call.result === OUTPUT_LIMIT_RESULT ? 'output_limit' : 'unreadable_arguments',
                            });
                        } else if (clientTools.has(name)) {
                            tracer.send({ kind: 'wait', for: 'person', name, round, at });
                        }
                    }
                } catch {
                    // Tracing must never affect the turn.
                }
                yield chunk;
            }
        };
        return traced;
    }
    /** The tools with each server tool's run timed, and its outcome kept. */
    tools<T extends ChatTool>(tools: T[]): T[] {
        return tools.map((tool) => {
            const execute = tool.execute;
            if (typeof execute !== 'function') {
                return tool;
            }
            return {
                ...tool,
                execute: async (input: never, context?: never) => {
                    const round = this.round;
                    const startedAt = this.now();
                    // Running, for a stop that can't wait for it (CB-211).
                    const settled = this.ledger?.tool(tool.name.slice(0, 64));
                    const callId = (context as { toolCallId?: unknown } | undefined)?.toolCallId;
                    const entry = (outcome: Pick<TraceTool, 'outcome' | 'error' | 'image'>) =>
                        this.send({
                            kind: 'tool',
                            round,
                            name: tool.name.slice(0, 64),
                            ...(typeof callId === 'string' ? { callId: callId.slice(0, 64) } : {}),
                            startedAt,
                            endedAt: this.now(),
                            ...outcome,
                        });
                    let result: unknown;
                    try {
                        result = await execute(input, context);
                    } catch (error) {
                        entry(thrownOutcome(error));
                        throw error;
                    } finally {
                        settled?.();
                    }
                    try {
                        const { wait, ...outcome } = resultOutcome(result);
                        const image = toolImageOf(result)?.id;
                        entry({ ...outcome, ...(image ? { image } : {}) });
                        if (wait) {
                            this.send({
                                kind: 'wait',
                                for: wait,
                                name: tool.name.slice(0, 64),
                                round,
                                at: this.now(),
                            });
                        }
                    } catch {
                        // Tracing must never affect the turn.
                    }
                    return result;
                },
            };
        });
    }
}

const time = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown, max = 64) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const shortCode = (value: unknown) => (typeof value === 'string' ? (codeOf(value) ?? 'Error') : undefined);
const SELECTIONS = ['age', 'relevance', 'pointer'];
const CAUSES: RetryCause[] = ['rate_limited', 'unavailable', 'fallback'];
const BUSY: BusyReason[] = ['rate_limited', 'unavailable', 'usage_limit'];
const FALLBACKS = ['error', 'empty', 'cap'];
const drop = <T extends object>(entry: T) =>
    Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as T;

/** A tool input's path in a trace: declared names, indexes and `*`. */
function inputPath(value: unknown): TraceInputPath | undefined {
    if (!Array.isArray(value) || value.length > 8) {
        return undefined;
    }
    const path = value.map((segment) =>
        (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) ||
        (typeof segment === 'string' && segment.length <= 64)
            ? segment
            : undefined,
    );
    return path.every((segment) => segment !== undefined) ? (path as TraceInputPath) : undefined;
}

function inputIssue(value: unknown): TraceInputIssue | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const path = inputPath(value.path);
    const code =
        typeof value.code === 'string' && (value.code === 'invalid' || ISSUE_CODES.has(value.code))
            ? value.code
            : undefined;
    const expected =
        typeof value.expected === 'string' && EXPECTED_TYPES.has(value.expected) ? value.expected : undefined;
    if (!path || !code || !TRACE_INPUT_TYPES.includes(value.received as never)) {
        return undefined;
    }
    return drop<TraceInputIssue>({ path, code, expected, received: value.received as TraceInputIssue['received'] });
}

/** A repair: only number or boolean text, and the value it was read as. */
function inputRepair(value: unknown): TraceInputRepair | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const path = inputPath(value.path);
    const { from, to } = value;
    if (
        !path ||
        typeof from !== 'string' ||
        !isRepairText(from) ||
        to !== (from === 'true' || from === 'false' ? from === 'true' : Number(from))
    ) {
        return undefined;
    }
    return { path, from, to: to as number | boolean };
}

/** An entry from a turn's stream, checked field by field; undefined when it isn't one. */
export function traceEntry(value: unknown): TraceEntry | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    switch (value.kind) {
        case 'turn': {
            const cap = count(value.cap);
            const label = text(value.label, 120);
            if (cap === undefined || label === undefined) {
                return undefined;
            }
            return {
                kind: 'turn',
                label,
                model: text(value.model, 120) ?? null,
                source: text(value.source) ?? 'unknown',
                ...(text(value.backendId, 64) ? { backendId: text(value.backendId, 64) } : {}),
                cap,
            };
        }
        case 'round': {
            const round = count(value.round);
            const startedAt = time(value.startedAt);
            const endedAt = time(value.endedAt);
            const stop = value.stop as RoundStop;
            if (
                round === undefined ||
                startedAt === undefined ||
                endedAt === undefined ||
                ![...Object.values(STOPS), 'error', 'cancelled'].includes(stop)
            ) {
                return undefined;
            }
            return drop<TraceRound>({
                kind: 'round',
                round,
                startedAt,
                endedAt,
                firstOutputMs: time(value.firstOutputMs),
                inputTokens: count(value.inputTokens),
                outputTokens: count(value.outputTokens),
                reasoningTokens: count(value.reasoningTokens),
                cachedTokens: count(value.cachedTokens),
                stop,
                error: shortCode(value.error),
                retry: count(value.retry) || undefined,
                summary: value.summary === true ? true : undefined,
                cause: CAUSES.includes(value.cause as never) ? (value.cause as RetryCause) : undefined,
                reasoningKind: REASONING_KINDS.includes(value.reasoningKind as never)
                    ? (value.reasoningKind as ReasoningKind)
                    : undefined,
            });
        }
        case 'retry': {
            const round = count(value.round);
            const at = time(value.at);
            const waitMs = time(value.waitMs);
            const attempt = count(value.attempt);
            if (
                round === undefined ||
                at === undefined ||
                waitMs === undefined ||
                !attempt ||
                (value.reason !== 'rate_limited' && value.reason !== 'unavailable')
            ) {
                return undefined;
            }
            return drop<TraceRetry>({
                kind: 'retry',
                round,
                at,
                reason: value.reason,
                waitMs,
                attempt,
                error: shortCode(value.error),
            });
        }
        case 'fallback': {
            const round = count(value.round);
            const at = time(value.at);
            const from = text(value.from, 120);
            const to = text(value.to, 120);
            if (
                round === undefined ||
                at === undefined ||
                from === undefined ||
                to === undefined ||
                !BUSY.includes(value.reason as never)
            ) {
                return undefined;
            }
            return {
                kind: 'fallback',
                round,
                at,
                from,
                to,
                reason: value.reason as BusyReason,
            };
        }
        case 'compaction': {
            const fields = {
                round: count(value.round),
                at: time(value.at),
                beforeTokens: count(value.beforeTokens),
                afterTokens: count(value.afterTokens),
                window: count(value.window),
                stubbed: count(value.stubbed),
                summarised: count(value.summarised),
                retried: count(value.retried),
            };
            if (Object.values(fields).some((field) => field === undefined)) {
                return undefined;
            }
            return drop({
                kind: 'compaction',
                ...fields,
                selection: SELECTIONS.includes(value.selection as never)
                    ? (value.selection as TraceCompaction['selection'])
                    : undefined,
                pinnedShown: count(value.pinnedShown),
                pinnedStored: count(value.pinnedStored),
                notesTokens: count(value.notesTokens),
                selectMs: time(value.selectMs),
            }) as TraceCompaction;
        }
        case 'notes': {
            const round = count(value.round);
            const startedAt = time(value.startedAt);
            const endedAt = time(value.endedAt);
            const turns = count(value.turns);
            if (
                round === undefined ||
                startedAt === undefined ||
                endedAt === undefined ||
                turns === undefined ||
                (value.by !== 'shared' && value.by !== 'chat')
            ) {
                return undefined;
            }
            return drop<TraceNotes>({
                kind: 'notes',
                round,
                startedAt,
                endedAt,
                by: value.by,
                model: text(value.model, 120) ?? null,
                turns,
                inputTokens: count(value.inputTokens),
                outputTokens: count(value.outputTokens),
                fallback: FALLBACKS.includes(value.fallback as never)
                    ? (value.fallback as TraceNotes['fallback'])
                    : undefined,
            });
        }
        case 'reactions': {
            const at = time(value.at);
            if (at === undefined || !isObject(value.counts)) {
                return undefined;
            }
            const counts: TraceReactions['counts'] = {};
            for (const kind of REACTIONS) {
                const n = count(value.counts[kind]);
                if (n) {
                    counts[kind] = n;
                }
            }
            return Object.keys(counts).length ? { kind: 'reactions', at, counts } : undefined;
        }
        case 'tool': {
            const round = count(value.round);
            const name = text(value.name);
            const startedAt = time(value.startedAt);
            const endedAt = time(value.endedAt);
            const outcome = value.outcome as ToolOutcome;
            if (
                round === undefined ||
                !name ||
                startedAt === undefined ||
                endedAt === undefined ||
                !['ok', 'error', 'refused', 'timeout'].includes(outcome)
            ) {
                return undefined;
            }
            return drop<TraceTool>({
                kind: 'tool',
                round,
                name,
                callId: text(value.callId),
                startedAt,
                endedAt,
                outcome,
                error: shortCode(value.error),
                image: typeof value.image === 'string' && ATTACHMENT_ID.test(value.image) ? value.image : undefined,
            });
        }
        case 'tool_input': {
            const round = count(value.round);
            const name = text(value.name);
            const at = time(value.at);
            const issues = Array.isArray(value.issues)
                ? value.issues
                      .slice(0, 10)
                      .map(inputIssue)
                      .filter((issue) => issue !== undefined)
                : [];
            const repairs = Array.isArray(value.repairs)
                ? value.repairs
                      .slice(0, 10)
                      .map(inputRepair)
                      .filter((repair) => repair !== undefined)
                : [];
            if (round === undefined || !name || at === undefined || !issues.length) {
                return undefined;
            }
            const repaired = value.repaired === true && repairs.length > 0;
            return drop<TraceToolInput>({
                kind: 'tool_input',
                round,
                at,
                name,
                callId: typeof value.callId === 'string' && CALL_ID.test(value.callId) ? value.callId : undefined,
                issues,
                more: count(value.more) || undefined,
                repaired,
                repairs: repaired ? repairs : undefined,
            });
        }
        case 'wait': {
            const round = count(value.round);
            const name = text(value.name);
            const at = time(value.at);
            if (
                round === undefined ||
                !name ||
                at === undefined ||
                (value.for !== 'approval' && value.for !== 'person')
            ) {
                return undefined;
            }
            return { kind: 'wait', for: value.for, name, round, at };
        }
        default:
            return undefined;
    }
}

/** A loop-end event's value, checked; undefined when it isn't one. */
export function loopEndOf(value: unknown): LoopEnd | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const reason = value.reason as LoopEnd['reason'];
    const rounds = count(value.rounds);
    const cap = count(value.cap);
    if (!LOOP_END_REASONS.includes(reason) || rounds === undefined || cap === undefined) {
        return undefined;
    }
    const fallback = isObject(value.fallback)
        ? { from: text(value.fallback.from, 120), to: text(value.fallback.to, 120) }
        : undefined;
    return {
        reason,
        rounds,
        cap,
        ...(fallback?.from !== undefined && fallback.to !== undefined
            ? { fallback: { from: fallback.from, to: fallback.to } }
            : {}),
    };
}

/** The RUN_ERROR codes of a work cycle stopped at a limit (CB-211). */
export const CYCLE_LIMIT_CODES = new Set(['cycle_tokens', 'cycle_spend', 'cycle_handoffs']);

/**
 * Why a turn's loop ended, when the turn didn't say: from how the run
 * ended (its status and RUN_ERROR code) and its last round.
 */
export function inferLoopEnd(trace: RunTrace, status: RunStatus, errorCode?: string): LoopEnd {
    const rounds = trace.rounds.filter(loopRound).length;
    const cap = trace.turn?.cap ?? 0;
    const last = trace.rounds.filter((round) => !round.summary).at(-1);
    const reason: LoopEnd['reason'] =
        status === 'interrupted'
            ? 'interrupted'
            : status === 'stopped' || errorCode === 'stopped'
              ? 'stopped'
              : errorCode === 'time_limit'
                ? 'time_limit'
                : CYCLE_LIMIT_CODES.has(errorCode ?? '')
                  ? 'cycle_limit'
                  : status === 'failed'
                    ? 'error'
                    : last?.stop === 'length'
                      ? 'output_limit'
                      : cap > 0 && rounds >= cap && last?.stop === 'tool_calls'
                        ? 'round_cap'
                        : 'completed';
    return { reason, rounds, cap };
}

/** The most messages a trace names; a turn adds a few. */
export const TRACE_MAX_MESSAGES = 100;

/** An actor as the runner records it, checked; undefined when it isn't one. */
export function runActor(value: unknown): RunActor | undefined {
    if (!isObject(value) || !RUN_ACTOR_KINDS.includes(value.kind as never)) {
        return undefined;
    }
    const id = text(value.id, 120);
    return { kind: value.kind as RunActor['kind'], ...(id ? { id } : {}) };
}

/** A run's trace as it is collected, entry by entry, then closed. */
export class TraceRecorder {
    readonly trace: RunTrace = { rounds: [], tools: [], waits: [] };
    private entries = 0;
    constructor(stored?: RunTrace) {
        if (stored) {
            this.trace = stored;
        }
    }
    /**
     * What the runner knows of the turn as it starts (CB-185): when its
     * request came, never after the run started, and who started it.
     */
    start(startedAt: number, signals: { receivedAt?: number; trigger?: RunActor; news?: boolean } = {}) {
        const received = time(signals.receivedAt);
        if (received !== undefined) {
            this.trace.receivedAt = Math.min(received, startedAt);
        }
        const trigger = runActor(signals.trigger);
        if (trigger) {
            this.trace.trigger = trigger;
        }
        if (signals.news) {
            this.trace.news = true;
        }
    }
    /** A message the turn added, and its author (CB-185). */
    message(id: string, author: RunActor, at: number) {
        const messages = (this.trace.messages ??= []);
        if (messages.length >= TRACE_MAX_MESSAGES) {
            this.trace.dropped = (this.trace.dropped ?? 0) + 1;
            return;
        }
        messages.push({ id: id.slice(0, 120), author, at });
    }
    add(value: unknown) {
        const entry = traceEntry(value);
        if (!entry) {
            return;
        }
        if (entry.kind === 'turn') {
            const { label, model, source, cap } = entry;
            this.trace.turn = { label, model, source, cap };
            return;
        }
        if (this.entries >= TRACE_MAX_ENTRIES) {
            this.trace.dropped = (this.trace.dropped ?? 0) + 1;
            return;
        }
        this.entries += 1;
        if (entry.kind === 'reactions') {
            this.trace.reactions = entry;
        } else if (entry.kind === 'round') {
            this.trace.rounds.push(entry);
        } else if (entry.kind === 'compaction') {
            (this.trace.compactions ??= []).push(entry);
        } else if (entry.kind === 'notes') {
            (this.trace.notes ??= []).push(entry);
        } else if (entry.kind === 'retry') {
            (this.trace.retries ??= []).push(entry);
        } else if (entry.kind === 'fallback') {
            this.trace.fallback = entry;
        } else if (entry.kind === 'tool') {
            this.trace.tools.push(entry);
        } else if (entry.kind === 'tool_input') {
            (this.trace.toolInputs ??= []).push(entry);
        } else {
            this.trace.waits.push(entry satisfies TraceWait);
        }
    }
    /** The turn's own loop-end event. */
    loopEnd(value: unknown) {
        const end = loopEndOf(value);
        if (end) {
            this.trace.end = end;
        }
    }
    /** Closes the trace as the run ends: its end reason (inferred if need be) and totals. */
    finish(status: RunStatus, errorCode?: string): RunTrace {
        // A stop or restart ends the loop whatever the turn last said.
        if (!this.trace.end || (status === 'interrupted' && this.trace.end.reason !== 'interrupted')) {
            this.trace.end = {
                ...inferLoopEnd(this.trace, status, errorCode),
                inferred: true,
            };
        }
        this.trace.totals = traceTotals(this.trace.rounds);
        return this.trace;
    }
}

/** What the Runs list and the log line show of a trace. */
export function traceSummary(
    trace: Pick<RunTrace, 'end' | 'totals'> & { rounds?: TraceRound[] },
): RunTraceSummary | undefined {
    if (!trace.end) {
        return undefined;
    }
    const totals = trace.totals ?? traceTotals(trace.rounds ?? []);
    return {
        reason: trace.end.reason,
        rounds: trace.end.rounds,
        ...(totals.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
        ...(totals.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
        ...(totals.cachedTokens !== undefined ? { cachedTokens: totals.cachedTokens } : {}),
    };
}
