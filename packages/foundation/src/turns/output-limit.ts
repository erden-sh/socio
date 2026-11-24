import type { AnyTextAdapter } from '@tanstack/ai';

import { TurnFailureError, reportFailure } from '../observability/failures.js';

/**
 * Rounds the model's output limit cut off (CB-126). A model writing a large
 * file in one tool call can run out of output tokens halfway through its
 * arguments: Chat Completions ends with `finish_reason: "length"`, the
 * Responses API (the ChatGPT plan) with `response.incomplete` for
 * `max_output_tokens`. Here the cut-off call never runs; the model is told
 * why and how to write in parts, and the turn goes on (the round counts
 * toward its cap). A second cut-off call, or a round cut off before it wrote
 * anything, ends the turn as `output_limit`, with a message that says so.
 */

/** What the model gets instead of the result of a call that was cut off. */
export const OUTPUT_LIMIT_NOTE =
    'Your output hit the model’s length limit and this call was cut off, so the tool did not run. Write large content in parts: computer_files_write with append, or several smaller calls.';
/** The result the model gets for a call that was cut off. */
export const OUTPUT_LIMIT_RESULT = JSON.stringify({ error: OUTPUT_LIMIT_NOTE });

type Step = (stream: AsyncIterable<unknown>, ...rest: unknown[]) => unknown;

/**
 * The Chat Completions adapter with a `length` finish kept on RUN_FINISHED.
 * The library reports a round that ended inside a tool call as `tool_calls`
 * (it closes the call), and so would run the call with its cut-off
 * arguments. Patched in `processStreamChunks`, as `withNumberedToolCalls`.
 */
export function withLengthFinish<T extends object>(adapter: T): T {
    const target = adapter as unknown as { processStreamChunks: Step };
    const step = target.processStreamChunks;
    target.processStreamChunks = async function* (stream, ...rest) {
        let length = false;
        async function* noted() {
            for await (const chunk of stream) {
                const { choices } = chunk as {
                    choices?: Array<{ finish_reason?: string | null }>;
                };
                if (choices?.[0]?.finish_reason === 'length') {
                    length = true;
                }
                yield chunk;
            }
        }
        const chunks = step.call(this, noted(), ...rest) as AsyncIterable<{
            type: string;
        }>;
        for await (const chunk of chunks) {
            yield length && chunk.type === 'RUN_FINISHED' ? { ...chunk, finishReason: 'length' } : chunk;
        }
    };
    return adapter;
}

/**
 * Whether a call's arguments are a whole JSON object. None at all, in a
 * round the limit ended, is a call cut off right after its name.
 */
function whole(args: string) {
    try {
        const value: unknown = JSON.parse(args);
        return !!value && typeof value === 'object' && !Array.isArray(value);
    } catch {
        return false;
    }
}

/** The Responses adapter's RUN_ERROR for `response.incomplete` at the output limit. */
export const incompleteAtLimit = (chunk: { code?: unknown; message?: unknown }) =>
    chunk.code === 'incomplete' && chunk.message === 'max_output_tokens';

/**
 * The adapter, for one turn, with rounds the output limit cut off handled
 * as above. `onStop` gets the `output_limit` failure before it is thrown
 * (the stream passes on only its message); `onCutOff` hears of a round that
 * ended at the limit with only text, which the turn ends with.
 */
export function limitedOutput(
    adapter: AnyTextAdapter,
    onStop: (error: TurnFailureError) => void,
    onCutOff?: () => void,
): AnyTextAdapter {
    let cutOff = 0;
    const stop = (message: string): never => {
        const error = new TurnFailureError('output_limit', message);
        onStop(error);
        throw error;
    };
    const limited = Object.create(adapter) as AnyTextAdapter;
    limited.chatStream = async function* (options) {
        // The round's calls by ID, in the order they started: name and arguments.
        const calls = new Map<string, { name: string; args: string }>();
        // Ended calls wait for the round's end, which says whether it was cut.
        const ended: Array<{ toolCallId: string }> = [];
        let wrote = false;
        let run: { runId?: string; threadId?: string } = {};
        for await (const chunk of adapter.chatStream(options)) {
            if (chunk.type === 'RUN_STARTED') {
                run = chunk;
            }
            if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
                wrote = true;
            }
            if (chunk.type === 'TOOL_CALL_START') {
                calls.set(chunk.toolCallId, {
                    name: chunk.toolCallName ?? chunk.toolName ?? 'unknown',
                    args: '',
                });
            }
            if (chunk.type === 'TOOL_CALL_ARGS') {
                const call = calls.get(chunk.toolCallId);
                const { args } = chunk as { args?: unknown };
                if (call) {
                    call.args = typeof args === 'string' && args ? args : call.args + chunk.delta;
                }
            }
            if (chunk.type === 'TOOL_CALL_END') {
                ended.push(chunk);
                continue;
            }
            const atLimit =
                (chunk.type === 'RUN_FINISHED' && chunk.finishReason === 'length') ||
                (chunk.type === 'RUN_ERROR' && incompleteAtLimit(chunk));
            if (!atLimit) {
                if (chunk.type === 'RUN_FINISHED' || chunk.type === 'RUN_ERROR') {
                    yield* ended.splice(0) as never[];
                }
                yield chunk;
                continue;
            }
            const finished = {
                type: 'RUN_FINISHED',
                runId: run.runId,
                threadId: run.threadId,
                ...(chunk.type === 'RUN_FINISHED' ? chunk : {}),
                timestamp: Date.now(),
            };
            if (!calls.size) {
                if (!wrote) {
                    stop('The model’s output limit ended a round before it wrote anything.');
                }
                // Cut-off text is still the answer.
                onCutOff?.();
                yield { ...finished, finishReason: 'length' } as never;
                continue;
            }
            // Calls stream one after another, so only the last can be cut off:
            // when its arguments are whole, the calls run as usual.
            const [id, last] = [...calls].at(-1)!;
            if (whole(last.args)) {
                yield* ended.splice(0) as never[];
                yield { ...finished, finishReason: 'tool_calls' } as never;
                continue;
            }
            cutOff += 1;
            const name = last.name.slice(0, 64);
            reportFailure(`Model tool call ${name} (${id.slice(0, 64)})`, [
                cutOff > 1
                    ? 'cut off by the output limit again; turn stopped'
                    : 'cut off by the output limit; asked the model to write in parts',
            ]);
            if (cutOff > 1) {
                stop(`The model’s output limit cut off its tool calls twice (${name}).`);
            }
            yield* ended.splice(0).filter((end) => end.toolCallId !== id) as never[];
            // The library's own form of a call that failed before it ran: the
            // tool is skipped and the model gets this result.
            yield {
                type: 'TOOL_CALL_END',
                toolCallId: id,
                toolCallName: last.name,
                toolName: last.name,
                timestamp: Date.now(),
                input: {},
                state: 'output-error',
                result: OUTPUT_LIMIT_RESULT,
            } as never;
            yield { ...finished, finishReason: 'tool_calls' } as never;
        }
        yield* ended.splice(0) as never[];
    };
    return limited;
}
