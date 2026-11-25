import { randomUUID } from 'node:crypto';

import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';

import type { BusyReason } from '@socio/shared/runs/run-trace';

import type { RetryPolicy } from './contract.js';
import { errorClass, resultOutcome, type RetryTrace } from './turn-trace.js';

/**
 * A busy model in a Dot turn (CB-140). A request the model turns away
 * before any output (a rate limit, a 5xx, a dropped connection) is sent
 * again after a wait, within the turn's time; when the person's own model
 * stays busy, the rest of the turn runs on the shared model where that is
 * allowed; and when no model can carry on, the turn ends with a status of
 * what it did and what is left, written here without a model, instead of
 * a bare error that hides the work of its earlier rounds.
 */

type Chunk = ReturnType<AnyTextAdapter['chatStream']> extends AsyncIterable<infer T> ? T : never;

/** The waits one turn may still spend, shared by all its requests. */
export class RetryBudget {
    private spent = 0;
    private readonly reserve: number;
    constructor(
        /** When the turn's time limit ends. */
        private readonly deadline: number,
        limitMs: number,
        private readonly policy: RetryPolicy,
        private readonly now: () => number = Date.now,
    ) {
        // The last fifth of the limit stays free, for a last round or a status.
        this.reserve = Math.floor(limitMs / 5);
    }
    /** Spends `ms` when it fits in the turn's waits and time; whether it did. */
    take(ms: number) {
        if (this.spent + ms > this.policy.maxTotalWaitMs) {
            return false;
        }
        if (this.now() + ms > this.deadline - this.reserve) {
            return false;
        }
        this.spent += ms;
        return true;
    }
    /** What the turn has waited so far. */
    get waited() {
        return this.spent;
    }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

const RATE_LIMITED = new Set([
    'chatgpt_rate_limited',
    '429',
    'rate_limit_exceeded',
    'rate_limited',
    'slow_down',
    'server_is_overloaded',
]);
const UNAVAILABLE = new Set([
    'chatgpt_unavailable',
    '408',
    'server_error',
    'service_unavailable',
    'overloaded_error',
    // An abort the turn didn't ask for (the caller checks its own signal).
    'aborted',
]);
/** Refusals that come as a 429 or 5xx but that no wait mends. */
const NEVER = new Set([
    'insufficient_quota',
    'chatgpt_quota_exceeded',
    'chatgpt_not_entitled',
    'usage_not_included',
    'billing_hard_limit_reached',
    'context_length_exceeded',
    'context_overflow',
    'chatgpt_context_too_long',
]);
/** A connection that failed or dropped, in the words of fetch and Node. */
const DROPPED =
    /^(?:terminated|fetch failed|other side closed|socket hang up|connection error\.?|request timed out\.?)$|\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)\b/i;

/**
 * Why a failed request (a RUN_ERROR chunk or a thrown error) means the
 * model can't serve now: a rate limit, out of reach (5xx, timeout, a
 * dropped connection), or the plan's usage limit. Undefined for anything
 * else (a refused prompt, a sign-in), which no wait or other model mends.
 */
export function busyReason(failure: unknown): BusyReason | undefined {
    if (!isObject(failure)) {
        return undefined;
    }
    const nested = [failure, failure.error, failure.rawEvent].filter(isObject);
    const codes = nested
        .flatMap((item) => [item.code, item.type, item.status])
        .filter((code) => typeof code === 'string' || (typeof code === 'number' && Number.isInteger(code)))
        .map(String);
    if (codes.some((code) => NEVER.has(code))) {
        return undefined;
    }
    if (codes.includes('chatgpt_usage_limit')) {
        return 'usage_limit';
    }
    if (codes.some((code) => RATE_LIMITED.has(code))) {
        return 'rate_limited';
    }
    if (codes.some((code) => UNAVAILABLE.has(code) || /^5\d\d$/.test(code))) {
        return 'unavailable';
    }
    const message = typeof failure.message === 'string' ? failure.message.trim() : '';
    // The OpenAI SDK's messages start with the HTTP status.
    const status = message.match(/^([45]\d\d)\b/)?.[1];
    if (status === '429') {
        return 'rate_limited';
    }
    if (status && (status === '408' || status.startsWith('5'))) {
        return 'unavailable';
    }
    // A coded failure is the provider's own; only an uncoded one is a drop.
    return !codes.length && DROPPED.test(message) ? 'unavailable' : undefined;
}

/** The wait a failure asked for (`ChatGptError.retryAfterMs`), if any. */
export function waitHint(failure: unknown): number | undefined {
    if (!isObject(failure)) {
        return undefined;
    }
    for (const item of [failure, failure.rawEvent].filter(isObject)) {
        const ms = item.retryAfterMs;
        if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
            return ms;
        }
    }
    return undefined;
}

/** How long to wait before attempt `attempt + 1`; undefined: don't. */
export function retryWait(
    failure: unknown,
    attempt: number,
    policy: RetryPolicy,
    random: () => number = Math.random,
): number | undefined {
    const hint = waitHint(failure);
    if (hint !== undefined) {
        if (hint > policy.maxWaitMs) {
            return undefined;
        }
        // At least what was asked, and a little more so retries don't bunch.
        return Math.ceil(hint + random() * Math.min(1_000, hint * 0.1 + 100));
    }
    const backoff = Math.min(policy.maxWaitMs, policy.baseMs * 2 ** (attempt - 1));
    return Math.ceil(backoff / 2 + (random() * backoff) / 2);
}

const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) {
            return resolve();
        }
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });

const signalOf = (options: TextOptions) => (options.request as RequestInit | undefined)?.signal ?? undefined;

export interface RetryOptions {
    budget: RetryBudget;
    policy: RetryPolicy;
    /** The turn's trace: each wait, and the request after it. */
    trace?: RetryTrace;
    /** Operational lines only (no content). */
    log?: (line: string) => void;
    random?: () => number;
}

/**
 * The adapter with each request the model turns away before any output
 * sent again (CB-140): after a rate limit or while out of reach, at most
 * `policy.attempts` times a round, waiting the backend's hint (Retry-After)
 * or an exponential backoff with jitter, while the turn's `budget` allows.
 * Only before any output: a request that streamed something and then
 * failed is passed on as it is, so nothing is said twice. The usage limit
 * of a plan is not retried (it resets in hours). Each attempt is a request
 * of the same round, and each wait an entry of the trace.
 */
export function retriedRequests(adapter: AnyTextAdapter, options: RetryOptions): AnyTextAdapter {
    const { budget, policy, trace } = options;
    const log = options.log ?? ((line: string) => console.log(line));
    const retried = Object.create(adapter) as AnyTextAdapter;
    retried.chatStream = async function* (request) {
        const signal = signalOf(request);
        for (let attempt = 1; ; attempt++) {
            // Held until the model shows it took the request: a refusal comes first.
            const held: Chunk[] = [];
            let shown = false;
            let failure: unknown;
            let thrown = false;
            try {
                for await (const chunk of adapter.chatStream(request)) {
                    if (!shown) {
                        if (chunk.type === 'RUN_STARTED') {
                            held.push(chunk);
                            continue;
                        }
                        if (chunk.type === 'RUN_ERROR') {
                            failure = chunk;
                            break;
                        }
                        shown = true;
                        yield* held.splice(0);
                    }
                    yield chunk;
                }
            } catch (error) {
                if (shown) {
                    throw error;
                }
                failure = error;
                thrown = true;
            }
            if (shown) {
                return;
            }
            const reason = signal?.aborted ? undefined : busyReason(failure);
            const wait =
                failure !== undefined &&
                (reason === 'rate_limited' || reason === 'unavailable') &&
                attempt < policy.attempts
                    ? retryWait(failure, attempt, policy, options.random)
                    : undefined;
            if (
                failure === undefined ||
                reason === undefined ||
                reason === 'usage_limit' ||
                wait === undefined ||
                !budget.take(wait)
            ) {
                // As it came: the failure, or a stream that ended without output.
                yield* held;
                if (thrown) {
                    throw failure;
                }
                if (failure !== undefined) {
                    yield failure as Chunk;
                }
                return;
            }
            const began = Date.now();
            log(
                `Model: ${reason === 'rate_limited' ? 'rate limited' : 'out of reach'} (${errorClass(failure)}); trying again in ${(wait / 1000).toFixed(1)} s (retry ${attempt} of ${policy.attempts - 1}).`,
            );
            await pause(wait, signal);
            const cutShort = !!signal?.aborted;
            trace?.retry({
                reason,
                at: began,
                waitMs: cutShort ? Math.min(wait, Date.now() - began) : wait,
                attempt,
                error: errorClass(failure),
                ...(cutShort ? { cutShort } : {}),
            });
            if (cutShort) {
                yield* held;
                if (thrown) {
                    throw failure;
                }
                yield failure as Chunk;
                return;
            }
            trace?.again({ retry: attempt, cause: reason });
        }
    };
    return retried;
}

/** The shared model a turn may carry on with: its own adapter chain. */
export interface FallbackModel {
    /** Fitted to the shared model's context, its requests retried and traced. */
    adapter: AnyTextAdapter;
    label: string;
    model: string | null;
    modelOptions: Record<string, unknown>;
    /** The most recent images it takes; 0 for a model that sees none. */
    maxImages: number;
}

export interface BusyOptions {
    /** The turn's model, as people know it ("ChatGPT"). */
    label: string;
    /**
     * The shared model, when the turn may move to it: the person's own model
     * is theirs, an admin allows it, and they didn't choose their model for
     * the conversation. Undefined when it may not; resolves to undefined
     * when there is none.
     */
    fallback?: () => Promise<FallbackModel | undefined>;
    /** The switch, as it happens (the trace, the loop end, the phase line). */
    onFallback?: (info: { from: string; to: string; reason: BusyReason }) => void;
    /** The turn ends with a status written here, without a model. */
    onUnavailable?: (reason: BusyReason) => void;
}

const IMAGE_NOTE = '[An image the shared model can’t see.]';
/**
 * The prompt with its images as notes but the most recent `maxImages`,
 * for a model that takes fewer than the turn's (none: 0).
 */
function limitImages(messages: ModelMessage[], maxImages: number): ModelMessage[] {
    let images = 0;
    return messages
        .slice()
        .reverse()
        .map((message) =>
            Array.isArray(message.content) && message.content.some((part) => part.type === 'image')
                ? {
                      ...message,
                      content: message.content
                          .slice()
                          .reverse()
                          .map((part) =>
                              part.type === 'image' && ++images > maxImages
                                  ? { type: 'text' as const, content: IMAGE_NOTE }
                                  : part,
                          )
                          .reverse(),
                  }
                : message,
        )
        .reverse();
}

const BUSY_WORDS: Record<BusyReason, string> = {
    rate_limited: 'is busy right now',
    unavailable: 'can’t be reached right now',
    usage_limit: 'has reached its usage limit for now',
};

/** What the reply says, once, when the turn moves to the shared model. */
export const fallbackNote = (from: string, to: string, reason: BusyReason) =>
    `_${from} ${BUSY_WORDS[reason]}, so I carried on with the shared model (${to})._\n\n`;

/** The tool calls of the turn so far: those after the person's message. */
export function turnToolCalls(messages: readonly ModelMessage[]) {
    const start = messages.findLastIndex((message) => message.role === 'user');
    const turn = messages.slice(start + 1);
    const results = new Map(
        turn
            .filter((message) => message.role === 'tool' && message.toolCallId)
            .map((message) => [message.toolCallId!, message.content]),
    );
    return turn.flatMap((message) =>
        message.role === 'assistant'
            ? (message.toolCalls ?? []).map((call) => ({
                  name: call.function.name.slice(0, 64),
                  failed: !results.has(call.id) || resultOutcome(results.get(call.id)).outcome !== 'ok',
              }))
            : [],
    );
}

/**
 * The status a turn ends with when no model can carry on (CB-140), as the
 * last round's would be: what was done, where it stopped and what is
 * left, so the person can ask to carry on. From the turn's tool calls.
 */
export function statusReply(label: string, reason: BusyReason, calls: ReturnType<typeof turnToolCalls>) {
    const tools = new Map<string, { runs: number; failed: number }>();
    for (const call of calls) {
        const tool = tools.get(call.name) ?? { runs: 0, failed: 0 };
        tool.runs += 1;
        if (call.failed) {
            tool.failed += 1;
        }
        tools.set(call.name, tool);
    }
    const done = [...tools].map(([name, { runs, failed }]) => {
        const notes = [
            runs > 1 && `${runs} times`,
            failed > 0 && (failed === runs && runs === 1 ? 'failed' : `${failed} failed`),
        ].filter(Boolean);
        return `\`${name}\`${notes.length ? ` (${notes.join(', ')})` : ''}`;
    });
    return [
        `${label} ${BUSY_WORDS[reason]}, so I stopped here.`,
        `**Done so far:** ${done.length ? `${done.join(', ')}.` : 'nothing yet.'}`,
        '**Left to do:** the rest of what you asked. Send a message, such as “carry on”, when you’d like me to pick up where I stopped.',
    ].join('\n\n');
}

/** A round that is only the status: a whole text message and a stop. */
function* statusChunks(
    text: string,
    run: { runId?: string; threadId?: string; model?: string },
    started: boolean,
): Generator<Chunk> {
    const messageId = `status-${randomUUID()}`;
    const at = Date.now();
    const base = { model: run.model, timestamp: at };
    const chunks: Record<string, unknown>[] = [
        ...(started ? [] : [{ type: 'RUN_STARTED', runId: run.runId, threadId: run.threadId }]),
        { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text, content: text },
        { type: 'TEXT_MESSAGE_END', messageId },
        {
            type: 'RUN_FINISHED',
            runId: run.runId,
            threadId: run.threadId,
            finishReason: 'stop',
        },
    ];
    for (const chunk of chunks) {
        yield { ...base, ...chunk } as unknown as Chunk;
    }
}

/**
 * The turn's model with a busy one handled past its retries (CB-140): when
 * a round fails busy before any output, the rest of the turn runs on the
 * shared model if `fallback` gives one (the round goes again there, and
 * the reply says so once); when it can't, and the turn did something or
 * the round wrote some text, the round ends with a status instead of the
 * error. A turn that did nothing yet keeps the error, whose message says
 * what happened; so does a round that failed part way through a tool call.
 */
export function busyModel(primary: AnyTextAdapter, options: BusyOptions): AnyTextAdapter {
    let switched: { model: FallbackModel; note: string } | undefined;
    let tried = false;
    // The note goes once, with the first text on the shared model.
    let noted: string | undefined;
    const busy = Object.create(primary) as AnyTextAdapter;
    busy.chatStream = async function* (request) {
        const signal = signalOf(request);
        for (;;) {
            const target = switched;
            const label = target ? target.model.label : options.label;
            const stream = target
                ? target.model.adapter.chatStream({
                      ...request,
                      model: target.model.model ?? request.model,
                      modelOptions: target.model.modelOptions,
                      messages: limitImages(request.messages, target.model.maxImages),
                  })
                : primary.chatStream(request);
            const held: Chunk[] = [];
            let run: { runId?: string; threadId?: string; model?: string } = {
                runId: request.runId,
                threadId: request.threadId,
                model: request.model,
            };
            let started = false;
            let shown = false;
            let calling = false;
            let open: string | undefined;
            let failure: unknown;
            let thrown = false;
            let reason: BusyReason | undefined;
            try {
                for await (const chunk of stream) {
                    if (chunk.type === 'RUN_ERROR' && !signal?.aborted) {
                        reason = busyReason(chunk);
                        if (reason) {
                            failure = chunk;
                            break;
                        }
                    }
                    if (chunk.type === 'RUN_STARTED') {
                        started = true;
                        run = { ...run, ...(chunk as typeof run) };
                    }
                    if (!shown) {
                        if (chunk.type === 'RUN_STARTED') {
                            held.push(chunk);
                            continue;
                        }
                        shown = true;
                        yield* held.splice(0);
                    }
                    if (chunk.type === 'TOOL_CALL_START') {
                        calling = true;
                    }
                    if (chunk.type === 'TEXT_MESSAGE_START') {
                        open = chunk.messageId;
                    }
                    if (chunk.type === 'TEXT_MESSAGE_END') {
                        open = undefined;
                    }
                    if (
                        target &&
                        chunk.type === 'TEXT_MESSAGE_CONTENT' &&
                        (noted === undefined || noted === chunk.messageId)
                    ) {
                        // The note leads the message: its first delta, and the whole
                        // text where the chunk carries it.
                        const first = noted === undefined;
                        noted = chunk.messageId;
                        const { content } = chunk as { content?: unknown };
                        yield {
                            ...chunk,
                            ...(first ? { delta: target.note + chunk.delta } : {}),
                            ...(typeof content === 'string' ? { content: target.note + content } : {}),
                        };
                        continue;
                    }
                    yield chunk;
                }
            } catch (error) {
                reason = signal?.aborted ? undefined : busyReason(error);
                if (!reason) {
                    throw error;
                }
                failure = error;
                thrown = true;
            }
            if (!reason) {
                yield* held;
                return;
            }
            if (!shown && !target && !tried && options.fallback) {
                tried = true;
                const model = await options.fallback().catch(() => undefined);
                if (model && !signal?.aborted) {
                    switched = {
                        model,
                        note: fallbackNote(options.label, model.label, reason),
                    };
                    options.onFallback?.({
                        from: options.label,
                        to: model.label,
                        reason,
                    });
                    continue;
                }
            }
            const calls = turnToolCalls(request.messages);
            // Nothing to report, or a tool call cut part way: the error as it came.
            if ((!shown && !calls.length) || calling) {
                yield* held;
                if (thrown) {
                    throw failure;
                }
                yield failure as Chunk;
                return;
            }
            options.onUnavailable?.(reason);
            yield* held;
            if (open) {
                yield { type: 'TEXT_MESSAGE_END', messageId: open } as Chunk;
            }
            yield* statusChunks(statusReply(label, reason, calls), run, started);
            return;
        }
    };
    return busy;
}
