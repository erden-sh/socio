import type { AnyTextAdapter } from '@tanstack/ai';

import { TurnFailureError, reportFailure } from '../observability/failures.js';

/**
 * Checks the tool calls a model streams (CB-12). The library parses a call's
 * arguments when it ends and runs the tool with `{}` when they are not a
 * JSON object, so the model is told a field is missing, repeats the same call
 * and spends the turn's rounds (and minutes) on it. Here a call whose
 * arguments are not a JSON object is repaired when the break is a known,
 * unambiguous one; otherwise the tool does not run and the model is told
 * why, once. A second unreadable call ends the turn.
 */

/** Characters of the arguments' start and end a log line may show. */
const EXCERPT = 16;

/** What a repair fixed, for the log. */
type Repair = 'double-encoded' | 'trailing text' | 'missing closing brace';

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

function parse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Where the top-level JSON object starting `text` ends (the index after its
 * closing brace), or, when the text ends first, the closers it still needs
 * and whether it ended inside a string.
 */
function scan(text: string) {
    const open: string[] = [];
    let inString = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (char === '\\') {
                index += 1;
            } else if (char === '"') {
                inString = false;
            }
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            open.push('}');
        } else if (char === '[') {
            open.push(']');
        } else if (char === '}' || char === ']') {
            if (open.pop() !== char) {
                return { invalid: true as const };
            }
            if (!open.length) {
                return { end: index + 1 };
            }
        }
    }
    return { inString, closers: open.reverse().join('') };
}

/**
 * Tool-call arguments as a JSON object, repairing only breaks that leave no
 * doubt about what the model meant: a JSON string holding the object
 * (double-encoded), text after a complete object that starts no other value
 * (`</tool_call>`, a stray brace), and closing braces or brackets missing
 * after a complete last value. A cut-off string, number or key is never
 * completed. Undefined when the arguments can't be read.
 */
export function readToolArguments(raw: string): { args: Record<string, unknown>; repair?: Repair } | undefined {
    const text = raw.trim();
    const whole = parse(text);
    if (isObject(whole)) {
        return { args: whole };
    }
    if (typeof whole === 'string') {
        const inner = parse(whole.trim());
        return isObject(inner) ? { args: inner, repair: 'double-encoded' } : undefined;
    }
    if (!text.startsWith('{')) {
        return undefined;
    }
    const shape = scan(text);
    if ('invalid' in shape) {
        return undefined;
    }
    if ('end' in shape) {
        if (/[[{"]/.test(text.slice(shape.end))) {
            return undefined;
        }
        const head = parse(text.slice(0, shape.end));
        return isObject(head) ? { args: head, repair: 'trailing text' } : undefined;
    }
    // Only after a complete string or a closed object or array: anything else
    // (a number, a key, a comma) may have been cut short.
    if (shape.inString || !/["}\]]$/.test(text)) {
        return undefined;
    }
    const closed = parse(text + shape.closers);
    return isObject(closed) ? { args: closed, repair: 'missing closing brace' } : undefined;
}

/** A log-safe description of a call's arguments: their size and a short excerpt of each end. */
export function argumentsSummary(raw: string) {
    const head = JSON.stringify(raw.slice(0, EXCERPT));
    const tail = JSON.stringify(raw.slice(-EXCERPT));
    return raw.length > EXCERPT * 2
        ? `${raw.length} characters, starting ${head}, ending ${tail}`
        : `${raw.length} characters, ${JSON.stringify(raw)}`;
}

/** What the model is told when a call's arguments can't be read. */
export const unreadableArguments = (name: string) =>
    `The arguments of this ${name} call were not valid JSON, so the tool did not run. Call it again with the arguments as one JSON object.`;

/** The part of a streamed Chat Completions chunk that tells tool calls apart. */
interface ToolCallChunk {
    choices: Array<{
        delta?: { tool_calls?: Array<{ index?: number; id?: string }> };
    }>;
}

/**
 * Chat Completions chunks with every tool-call delta numbered (CB-92). The
 * Chat Completions adapter assembles calls by `index`, so a provider that
 * streams parallel calls without one ran them all into one call, with the
 * names and arguments joined and the JSON invalid. Here a new `id` starts a
 * new call, with or without an index (the same index with a new id too); a
 * delta with only an index continues that index's call, and one with
 * neither continues the last call. Calls keep the order they started in.
 */
export async function* numberedToolCalls<T extends ToolCallChunk>(stream: AsyncIterable<T>): AsyncIterable<T> {
    const byId = new Map<string, number>();
    const byIndex = new Map<number, number>();
    // Calls that have their id.
    const named = new Set<number>();
    let last: number | undefined;
    let next = 0;
    for await (const chunk of stream) {
        const [choice, ...rest] = chunk.choices;
        const calls = choice?.delta?.tool_calls;
        if (!calls) {
            yield chunk;
            continue;
        }
        const numbered = calls.map((call) => {
            let number = call.id ? byId.get(call.id) : undefined;
            if (number === undefined) {
                const current = call.index === undefined ? last : byIndex.get(call.index);
                // A new id starts a new call, unless the current one has none yet.
                number = current !== undefined && !(call.id && named.has(current)) ? current : next++;
            }
            if (call.id) {
                byId.set(call.id, number);
                named.add(number);
            }
            if (call.index !== undefined) {
                byIndex.set(call.index, number);
            }
            last = number;
            return { ...call, index: number };
        });
        yield {
            ...chunk,
            choices: [{ ...choice, delta: { ...choice.delta, tool_calls: numbered } }, ...rest],
        };
    }
}

/**
 * The Chat Completions adapter with its tool calls numbered before it
 * assembles them (`numberedToolCalls`), in `processStreamChunks`, the step
 * the library leaves for a provider's own stream behavior. The CB-92 tests
 * fail if a new version of the library drops it.
 */
export function withNumberedToolCalls<T extends object>(adapter: T): T {
    type Step = (stream: AsyncIterable<ToolCallChunk>, ...rest: unknown[]) => unknown;
    const target = adapter as unknown as { processStreamChunks: Step };
    const step = target.processStreamChunks;
    target.processStreamChunks = function (stream, ...rest) {
        return step.call(this, numberedToolCalls(stream), ...rest);
    };
    return adapter;
}

/**
 * The adapter with its tool calls checked, for one turn: the model may send
 * one call whose arguments can't be read and try again; the second ends the
 * turn with a `tool_call` failure, which `onStop` gets first (the stream
 * passes on only its message).
 */
export function checkedToolCalls(adapter: AnyTextAdapter, onStop: (error: TurnFailureError) => void): AnyTextAdapter {
    let unreadable = 0;
    const checked = Object.create(adapter) as AnyTextAdapter;
    checked.chatStream = async function* (options) {
        // Each call's arguments as streamed, by tool call ID.
        const streamed = new Map<string, string>();
        // This round's RUN_STARTED, and whether a call in it was repaired or
        // sent back as unreadable.
        let started: { runId?: string; threadId?: string } = {};
        let recovered = false;
        for await (const chunk of adapter.chatStream(options)) {
            if (chunk.type === 'RUN_STARTED') {
                started = chunk;
            }
            // A stream cut off inside a call's arguments has no finish reason,
            // which the Chat Completions adapter (TanStack AI 1.x) reports as
            // an incomplete stream. The call is already repaired (and runs) or
            // sent back as unreadable (and the model tries again), so the
            // round ends as a tool round, as before.
            if (recovered && chunk.type === 'RUN_ERROR' && (chunk as { code?: unknown }).code === 'incomplete-stream') {
                yield {
                    type: 'RUN_FINISHED',
                    runId: started.runId ?? '',
                    threadId: started.threadId ?? '',
                    model: (chunk as { model?: string }).model,
                    timestamp: Date.now(),
                    finishReason: 'tool_calls',
                } as never;
                continue;
            }
            if (chunk.type === 'TOOL_CALL_START') {
                streamed.set(chunk.toolCallId, '');
            }
            if (chunk.type === 'TOOL_CALL_ARGS') {
                const { args } = chunk as { args?: unknown };
                streamed.set(
                    chunk.toolCallId,
                    typeof args === 'string' && args ? args : (streamed.get(chunk.toolCallId) ?? '') + chunk.delta,
                );
            }
            const raw = chunk.type === 'TOOL_CALL_END' ? streamed.get(chunk.toolCallId) : '';
            // No arguments is a call without any, as the library has it; a call
            // the adapter already failed keeps its own error.
            if (
                chunk.type !== 'TOOL_CALL_END' ||
                !raw?.trim() ||
                (chunk as { state?: unknown }).state === 'output-error'
            ) {
                yield chunk;
                continue;
            }
            const read = readToolArguments(raw);
            if (read && !read.repair) {
                yield chunk;
                continue;
            }
            const name = (chunk.toolCallName || 'unknown').slice(0, 64);
            const call = `${name} (${chunk.toolCallId.slice(0, 64)})`;
            if (read) {
                reportFailure(`Model tool call ${call}`, [
                    `repaired arguments (${read.repair})`,
                    argumentsSummary(raw),
                ]);
                // The library takes a TOOL_CALL_END's raw `args` over its
                // `input`, so both carry the repaired arguments.
                recovered = true;
                yield { ...chunk, args: JSON.stringify(read.args), input: read.args };
                continue;
            }
            unreadable += 1;
            const last = unreadable > 1;
            reportFailure(`Model tool call ${call}`, [
                last
                    ? 'arguments not valid JSON again; turn stopped'
                    : 'arguments not valid JSON; asked the model to try again',
                argumentsSummary(raw),
            ]);
            if (last) {
                const error = new TurnFailureError(
                    'tool_call',
                    `The model sent unreadable arguments for ${name} twice.`,
                );
                onStop(error);
                throw error;
            }
            recovered = true;
            // The library's own form of a call that failed before it ran: the
            // tool is skipped and the model gets this result.
            yield {
                ...chunk,
                args: '{}',
                input: {},
                state: 'output-error',
                result: JSON.stringify({ error: unreadableArguments(name) }),
            };
        }
    };
    return checked;
}
