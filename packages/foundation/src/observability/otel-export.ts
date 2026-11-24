import { randomBytes } from 'node:crypto';

import type { BaseEvent } from '@ag-ui/client';

import type { RunTrace } from '@socio/shared/runs/run-trace';
import type { Settings, TraceSettings } from '@socio/shared/types';

import { reportFailure, safeFailure } from './failures.js';

/**
 * Turn traces to an OpenTelemetry collector (CB-128), over OTLP/HTTP with
 * JSON bodies: the official SDK is not a dependency, and the format is
 * small. Each finished turn becomes one trace: a turn span (`invoke_agent`)
 * with a child span per model round (`chat`) and per tool call
 * (`execute_tool`), named and attributed by the OpenTelemetry GenAI
 * semantic conventions. Off unless an operator sets an endpoint; it sends
 * only there, never to a vendor default. Prompts, answers, tool arguments
 * and results go only when an admin turns on "Include content in traces",
 * cut to `CONTENT_MAX` characters each. Export never waits on the turn's
 * path: spans are queued, a bounded queue drops on overflow (counted), one
 * request is in flight at a time and a failure is logged, never thrown.
 */

/** Where traces go: `OTEL_EXPORTER_OTLP_*` (`otlpFromEnv`). */
export interface OtlpSettings {
    /** The full traces URL: `<endpoint>/v1/traces`, or the traces endpoint as given. */
    url: string;
    /** Sent with every request; a secret, never logged. */
    headers: Record<string, string>;
    serviceName: string;
}

/** The most characters of one piece of content an exported span carries. */
export const CONTENT_MAX = 4000;

/**
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as given) or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces` appended), with
 * `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,…`, values URL-encoded) and
 * `OTEL_SERVICE_NAME`. Undefined, export off, without an endpoint or with
 * `OTEL_SDK_DISABLED=true`. Errors never quote a header.
 */
export function otlpFromEnv(env: Record<string, string | undefined>): OtlpSettings | undefined {
    if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') {
        return undefined;
    }
    const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
    const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    const raw = traces || (base ? `${base.replace(/\/+$/, '')}/v1/traces` : '');
    if (!raw) {
        return undefined;
    }
    const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)?.trim().toLowerCase();
    if (protocol === 'grpc') {
        throw new Error(
            'OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported: point the endpoint at the collector’s OTLP/HTTP port (4318).',
        );
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL.');
    }
    const headers: Record<string, string> = {};
    const list = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS;
    for (const pair of (list ?? '').split(',')) {
        if (!pair.trim()) {
            continue;
        }
        const at = pair.indexOf('=');
        const key = at > 0 ? pair.slice(0, at).trim() : '';
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
            throw new Error('OTEL_EXPORTER_OTLP_HEADERS must be key=value pairs, separated by commas.');
        }
        let value: string;
        try {
            value = decodeURIComponent(pair.slice(at + 1).trim());
        } catch {
            throw new Error('OTEL_EXPORTER_OTLP_HEADERS has a value that is not URL-encoded.');
        }
        headers[key] = value;
    }
    return {
        url: url.href,
        headers,
        serviceName: env.OTEL_SERVICE_NAME?.trim() || 'socio',
    };
}

/**
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`: the starting value
 * of "Include content in traces"; off unless `true`.
 */
export const traceContentFromEnv = (env: Record<string, string | undefined>) =>
    env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim().toLowerCase() === 'true';

/** The tracing settings in force: an admin's from Settings, over the environment's. */
export function traceSettings(settings: Settings, includeContent = false): TraceSettings {
    return { includeContent, ...settings.tracing };
}

type AnyValue =
    | { stringValue: string }
    | { intValue: string }
    | { boolValue: boolean }
    | { arrayValue: { values: AnyValue[] } };
interface KeyValue {
    key: string;
    value: AnyValue;
}
/** One span in OTLP/JSON. */
export interface OtlpSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    /** 1 internal, 3 client. */
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: KeyValue[];
    events?: { timeUnixNano: string; name: string; attributes: KeyValue[] }[];
    /** 2: error. */
    status?: { code: number; message?: string };
}

type Attribute = string | number | boolean | string[] | undefined;
function attributes(values: Record<string, Attribute>): KeyValue[] {
    const list: KeyValue[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
            continue;
        }
        list.push({
            key,
            value: Array.isArray(value)
                ? {
                      arrayValue: {
                          values: value.map((item) => ({ stringValue: item })),
                      },
                  }
                : typeof value === 'number'
                  ? { intValue: String(Math.round(value)) }
                  : typeof value === 'boolean'
                    ? { boolValue: value }
                    : { stringValue: value },
        });
    }
    return list;
}
const nano = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const cap = (text: string, max = CONTENT_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A finished turn's content, for export when an admin allows it. */
export interface TurnContent {
    /** What the person sent in this turn. */
    input: string;
    /** The Dot's answer. */
    output: string;
    /** Each tool call's arguments and result, by call id. */
    tools: Map<string, { arguments?: string; result?: string }>;
}

const partsText = (content: unknown): string =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
                .map((part) =>
                    part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '',
                )
                .filter(Boolean)
                .join('\n')
          : '';

/** A turn's content from its stored events, each piece cut to `max` characters. */
export function turnContent(events: readonly BaseEvent[], max = CONTENT_MAX): TurnContent {
    const input: string[] = [];
    let output = '';
    const tools = new Map<string, { arguments?: string; result?: string }>();
    const tool = (id: string) => {
        let entry = tools.get(id);
        if (!entry) {
            tools.set(id, (entry = {}));
        }
        return entry;
    };
    for (const event of events) {
        const value = event as unknown as Record<string, unknown>;
        if (event.type === 'RUN_STARTED') {
            const messages = (value.input as { messages?: unknown[] } | undefined)?.messages;
            for (const message of messages ?? []) {
                const { role, content } = (message ?? {}) as {
                    role?: unknown;
                    content?: unknown;
                };
                if (role === 'user') {
                    input.push(partsText(content));
                }
            }
        } else if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof value.delta === 'string' && output.length <= max) {
            output += value.delta;
        } else if (
            event.type === 'TOOL_CALL_ARGS' &&
            typeof value.toolCallId === 'string' &&
            typeof value.delta === 'string'
        ) {
            const entry = tool(value.toolCallId);
            if ((entry.arguments?.length ?? 0) <= max) {
                entry.arguments = (entry.arguments ?? '') + value.delta;
            }
        } else if (event.type === 'TOOL_CALL_RESULT' && typeof value.toolCallId === 'string') {
            tool(value.toolCallId).result =
                typeof value.content === 'string' ? value.content : JSON.stringify(value.content ?? null);
        }
    }
    for (const entry of tools.values()) {
        if (entry.arguments !== undefined) {
            entry.arguments = cap(entry.arguments, max);
        }
        if (entry.result !== undefined) {
            entry.result = cap(entry.result, max);
        }
    }
    return {
        input: cap(input.join('\n\n'), max),
        output: cap(output, max),
        tools,
    };
}

/** The turn a trace is for: identifiers and how it ended, no people. */
export interface TracedTurn {
    runId: string;
    threadId: string;
    status: string;
    source: string;
    startedAt: number;
    finishedAt: number;
    dotId?: string;
    dotName?: string;
    /** RUN_ERROR's code of a failed turn. */
    error?: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
/** The GenAI provider a model source speaks to. */
const providerOf = (source: string | undefined) => (source === 'byo:chatgpt' ? 'openai' : 'openai_compatible');

/**
 * A finished turn as OTLP spans: the turn, then one child per model round
 * and per tool call, with the waits for a person and the context's
 * compactions as the turn's events.
 * `content` (only when an admin allows it) adds the GenAI content
 * attributes, each piece already cut short.
 */
export function turnSpans(
    turn: TracedTurn,
    trace: RunTrace,
    content?: TurnContent,
    ids: { trace: () => string; span: () => string } = {
        trace: () => hex(16),
        span: () => hex(8),
    },
): OtlpSpan[] {
    const traceId = ids.trace();
    const turnId = ids.span();
    const model = trace.turn?.model ?? undefined;
    const provider = providerOf(trace.turn?.source);
    const lastStop = trace.rounds.filter((round) => !round.summary).at(-1)?.stop;
    const failed = turn.status === 'failed' || turn.status === 'interrupted';
    const spans: OtlpSpan[] = [
        {
            traceId,
            spanId: turnId,
            name: `invoke_agent ${turn.dotName ?? 'socio'}`,
            kind: 1,
            startTimeUnixNano: nano(turn.startedAt),
            endTimeUnixNano: nano(Math.max(turn.startedAt, turn.finishedAt)),
            attributes: attributes({
                'gen_ai.operation.name': 'invoke_agent',
                'gen_ai.provider.name': trace.turn ? provider : undefined,
                'gen_ai.agent.id': turn.dotId,
                'gen_ai.agent.name': turn.dotName,
                'gen_ai.conversation.id': turn.threadId,
                'gen_ai.request.model': model,
                'gen_ai.usage.input_tokens': trace.totals?.inputTokens,
                'gen_ai.usage.output_tokens': trace.totals?.outputTokens,
                'company_brain.run.id': turn.runId,
                'company_brain.run.status': turn.status,
                'company_brain.run.source': turn.source,
                'company_brain.model.label': trace.turn?.label,
                'company_brain.model.source': trace.turn?.source,
                'company_brain.loop.end_reason': trace.end?.reason,
                'company_brain.loop.rounds': trace.end?.rounds,
                'company_brain.loop.cap': trace.end?.cap,
                'company_brain.usage.reasoning_tokens': trace.totals?.reasoningTokens,
                'error.type': failed ? (turn.error ?? turn.status) : undefined,
                ...(content
                    ? {
                          'gen_ai.input.messages': JSON.stringify([
                              {
                                  role: 'user',
                                  parts: [{ type: 'text', content: content.input }],
                              },
                          ]),
                          'gen_ai.output.messages': JSON.stringify([
                              {
                                  role: 'assistant',
                                  parts: [{ type: 'text', content: content.output }],
                                  ...(lastStop ? { finish_reason: lastStop } : {}),
                              },
                          ]),
                      }
                    : {}),
            }),
            events: [
                ...trace.waits.map((wait) => ({
                    timeUnixNano: nano(wait.at),
                    name: `company_brain.wait.${wait.for}`,
                    attributes: attributes({
                        'gen_ai.tool.name': wait.name,
                        'company_brain.round': wait.round,
                    }),
                })),
                // Reactions the Dot was told of as the turn began (CB-133): counts only.
                ...(trace.reactions
                    ? [
                          {
                              timeUnixNano: nano(trace.reactions.at),
                              name: 'company_brain.reactions',
                              attributes: attributes(
                                  Object.fromEntries(
                                      Object.entries(trace.reactions.counts).map(([kind, n]) => [
                                          `company_brain.reactions.${kind.replace('-', '_')}`,
                                          n,
                                      ]),
                                  ),
                              ),
                          },
                      ]
                    : []),
                // Each round's prompt fitted to the model's context (CB-129).
                ...(trace.compactions ?? []).map((compaction) => ({
                    timeUnixNano: nano(compaction.at),
                    name: 'company_brain.context_compaction',
                    attributes: attributes({
                        'company_brain.round': compaction.round,
                        'company_brain.context.before_tokens': compaction.beforeTokens,
                        'company_brain.context.after_tokens': compaction.afterTokens,
                        'company_brain.context.window': compaction.window,
                        'company_brain.context.stubbed': compaction.stubbed,
                        'company_brain.context.summarised': compaction.summarised,
                        'company_brain.context.retried': compaction.retried,
                        // Which pinned facts the prompt carried (CB-134).
                        'company_brain.context.selection': compaction.selection,
                        'company_brain.context.pinned_shown': compaction.pinnedShown,
                        'company_brain.context.pinned_stored': compaction.pinnedStored,
                        'company_brain.context.notes_tokens': compaction.notesTokens,
                        'company_brain.context.select_ms': compaction.selectMs,
                    }),
                })),
                // Each update of the chat's notes, and whose model wrote it (CB-137).
                ...(trace.notes ?? []).map((notes) => ({
                    timeUnixNano: nano(notes.endedAt),
                    name: 'company_brain.context_notes',
                    attributes: attributes({
                        'company_brain.round': notes.round,
                        'company_brain.notes.by': notes.by,
                        'gen_ai.request.model': notes.model ?? undefined,
                        'company_brain.notes.turns': notes.turns,
                        'company_brain.notes.duration_ms': notes.endedAt - notes.startedAt,
                        'gen_ai.usage.input_tokens': notes.inputTokens,
                        'gen_ai.usage.output_tokens': notes.outputTokens,
                        'company_brain.notes.fallback': notes.fallback,
                    }),
                })),
                // A busy model's requests sent again, and the switch to the shared
                // model (CB-140).
                ...(trace.retries ?? []).map((retry) => ({
                    timeUnixNano: nano(retry.at),
                    name: 'company_brain.model_retry',
                    attributes: attributes({
                        'company_brain.round': retry.round,
                        'company_brain.retry.reason': retry.reason,
                        'company_brain.retry.wait_ms': retry.waitMs,
                        'company_brain.retry.attempt': retry.attempt,
                        'error.type': retry.error,
                    }),
                })),
                ...(trace.fallback
                    ? [
                          {
                              timeUnixNano: nano(trace.fallback.at),
                              name: 'company_brain.model_fallback',
                              attributes: attributes({
                                  'company_brain.round': trace.fallback.round,
                                  'company_brain.fallback.from': trace.fallback.from,
                                  'company_brain.fallback.to': trace.fallback.to,
                                  'company_brain.fallback.reason': trace.fallback.reason,
                              }),
                          },
                      ]
                    : []),
            ],
            ...(failed ? { status: { code: 2 } } : {}),
        },
    ];
    for (const round of trace.rounds) {
        spans.push({
            traceId,
            spanId: ids.span(),
            parentSpanId: turnId,
            name: model ? `chat ${model}` : 'chat',
            kind: 3,
            startTimeUnixNano: nano(round.startedAt),
            endTimeUnixNano: nano(Math.max(round.startedAt, round.endedAt)),
            attributes: attributes({
                'gen_ai.operation.name': 'chat',
                'gen_ai.provider.name': provider,
                'gen_ai.request.model': model,
                'gen_ai.usage.input_tokens': round.inputTokens,
                'gen_ai.usage.output_tokens': round.outputTokens,
                'gen_ai.response.finish_reasons': [round.stop],
                'company_brain.round': round.round,
                // A too-long prompt sent again, or a request for the notes (CB-129);
                // a busy model's, or the shared model's after a switch (CB-140).
                'company_brain.round.retry': round.retry,
                'company_brain.round.retry_cause': round.cause,
                'company_brain.round.purpose': round.summary ? 'context_notes' : undefined,
                'company_brain.usage.reasoning_tokens': round.reasoningTokens,
                'company_brain.usage.cached_input_tokens': round.cachedTokens,
                'company_brain.time_to_first_output_ms': round.firstOutputMs,
                'error.type': round.stop === 'error' ? (round.error ?? 'Error') : undefined,
            }),
            ...(round.stop === 'error' ? { status: { code: 2 } } : {}),
        });
    }
    for (const call of trace.tools) {
        const io = call.callId ? content?.tools.get(call.callId) : undefined;
        const failure = call.outcome === 'error' || call.outcome === 'timeout';
        spans.push({
            traceId,
            spanId: ids.span(),
            parentSpanId: turnId,
            name: `execute_tool ${call.name}`,
            kind: 1,
            startTimeUnixNano: nano(call.startedAt),
            endTimeUnixNano: nano(Math.max(call.startedAt, call.endedAt)),
            attributes: attributes({
                'gen_ai.operation.name': 'execute_tool',
                'gen_ai.tool.name': call.name,
                'gen_ai.tool.call.id': call.callId,
                'gen_ai.tool.type': 'function',
                'company_brain.round': call.round,
                'company_brain.tool.outcome': call.outcome,
                'error.type': call.outcome === 'ok' ? undefined : (call.error ?? call.outcome),
                ...(content && io
                    ? {
                          'gen_ai.tool.call.arguments': io.arguments,
                          'gen_ai.tool.call.result': io.result,
                      }
                    : {}),
            }),
            ...(failure ? { status: { code: 2 } } : {}),
        });
    }
    return spans;
}

/** An OTLP/JSON `ExportTraceServiceRequest` of these spans. */
export function otlpBody(spans: readonly OtlpSpan[], serviceName: string) {
    return {
        resourceSpans: [
            {
                resource: {
                    attributes: attributes({ 'service.name': serviceName }),
                },
                scopeSpans: [{ scope: { name: 'socio' }, spans }],
            },
        ],
    };
}

export interface ExporterOptions {
    /** The most spans waiting; more are dropped and counted. */
    maxQueue?: number;
    /** The most spans one request carries. */
    batchSize?: number;
    /** How often waiting spans are sent. */
    intervalMs?: number;
    /** How long one request may take. */
    timeoutMs?: number;
    fetch?: typeof fetch;
    log?: (line: string) => void;
    now?: () => number;
}

/** Spans queued and sent in batches, in the background; see the module comment. */
export class OtlpExporter {
    private queue: OtlpSpan[] = [];
    private sending?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private lastReport = -Infinity;
    /** Spans sent, dropped on a full queue, and lost to a failed request. */
    readonly stats = { exported: 0, dropped: 0, failed: 0 };
    private readonly options: Required<Omit<ExporterOptions, 'fetch' | 'log'>> & Pick<ExporterOptions, 'fetch' | 'log'>;
    constructor(
        private settings: OtlpSettings,
        options: ExporterOptions = {},
    ) {
        this.options = {
            maxQueue: 2048,
            batchSize: 256,
            intervalMs: 2000,
            timeoutMs: 10_000,
            now: Date.now,
            ...options,
        };
        this.timer = setInterval(() => void this.flush(), this.options.intervalMs);
        this.timer.unref?.();
    }
    /** Queues a turn's spans; returns at once. */
    export(spans: readonly OtlpSpan[]) {
        if (!this.timer) {
            return;
        }
        const room = Math.max(0, this.options.maxQueue - this.queue.length);
        if (spans.length > room) {
            this.stats.dropped += spans.length - room;
        }
        this.queue.push(...spans.slice(0, room));
        if (this.queue.length >= this.options.batchSize) {
            void this.flush();
        }
    }
    /** Sends the next batch, unless one is on its way (then waits for that one). */
    flush(): Promise<void> {
        if (this.sending) {
            return this.sending;
        }
        if (!this.queue.length) {
            return Promise.resolve();
        }
        const batch = this.queue.splice(0, this.options.batchSize);
        this.sending = this.send(batch).finally(() => {
            this.sending = undefined;
        });
        return this.sending;
    }
    private async send(batch: OtlpSpan[]) {
        try {
            const response = await (this.options.fetch ?? fetch)(this.settings.url, {
                method: 'POST',
                headers: {
                    ...this.settings.headers,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(otlpBody(batch, this.settings.serviceName)),
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
            await response.body?.cancel().catch(() => undefined);
            if (!response.ok) {
                throw Object.assign(new Error('OTLP export refused'), {
                    status: response.status,
                });
            }
            this.stats.exported += batch.length;
        } catch (error) {
            this.stats.failed += batch.length;
            this.report(error);
        }
    }
    /** At most one line a minute; never the URL or a header. */
    private report(error: unknown) {
        const now = this.options.now();
        if (now - this.lastReport < 60_000) {
            return;
        }
        this.lastReport = now;
        const line = `${safeFailure(error)}; ${this.stats.failed} spans not delivered, ${this.stats.dropped} dropped`;
        if (this.options.log) {
            this.options.log(`Trace export: ${line}`);
        } else {
            reportFailure('Trace export', [line]);
        }
    }
    /** Stops the timer and sends what is waiting, giving up after `waitMs`. */
    async shutdown(waitMs = 2000) {
        clearInterval(this.timer);
        this.timer = undefined;
        const deadline = this.options.now() + waitMs;
        const drain = async () => {
            while (this.queue.length || this.sending) {
                await this.flush();
            }
        };
        await Promise.race([
            drain(),
            new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - this.options.now())).unref?.()),
        ]);
    }
}
