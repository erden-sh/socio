/**
 * Keeps a Chat Completions round's reasoning events well formed. A thinking
 * model on an OpenAI-compatible server (Qwen, DeepSeek and the like, which
 * stream `delta.reasoning_content` or `delta.reasoning`) often thinks and
 * then calls a tool with no text in between. `@tanstack/openai-base` 1.1.0
 * (`processStreamChunks`) closes the reasoning only before text or when the
 * round's stream ends, so its REASONING_MESSAGE_END and REASONING_END come
 * after the tool call's events; reasoning after a close goes on under the
 * closed message's ID, with no new start. CopilotKit's TanStack converter
 * (`convertTanStackStream`, 1.90.2) closes the reasoning itself at the tool
 * call and passes the library's late end on again, so the browser's AG-UI
 * verifier rejects the run: "Cannot send 'REASONING_MESSAGE_END' event: No
 * active reasoning message found". Both are upstream bugs.
 *
 * Here, in the adapter's own stream: open reasoning is closed before text, a
 * tool call or the round's end; an end for reasoning that is not open is
 * dropped; reasoning after a close opens a new message under a new ID; and
 * empty reasoning deltas are dropped.
 */

interface Chunk {
    type: string;
    messageId?: string;
    delta?: unknown;
    model?: string;
}

/** The chunks before which open reasoning must have ended. */
const CLOSES_REASONING = new Set([
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'RUN_FINISHED',
    'RUN_ERROR',
]);

/** `stream` with its reasoning started before content and ended once, before what follows it. */
export async function* reasoningLifecycle<T extends Chunk>(stream: AsyncIterable<T>): AsyncGenerator<T> {
    // The reasoning message open now, under the ID it went out with.
    let open: { id: string; model?: string } | undefined;
    // IDs already used, and how many messages reopened after a close.
    const used = new Set<string>();
    let reopened = 0;
    const start = (id: string, model?: string) => {
        open = { id, model };
        used.add(id);
        const base = { messageId: id, ...(model ? { model } : {}), timestamp: Date.now() };
        return [
            { ...base, type: 'REASONING_START' },
            { ...base, type: 'REASONING_MESSAGE_START', role: 'reasoning' },
        ] as unknown as T[];
    };
    const close = () => {
        if (!open) {
            return [];
        }
        const base = {
            messageId: open.id,
            ...(open.model ? { model: open.model } : {}),
            timestamp: Date.now(),
        };
        open = undefined;
        return [
            { ...base, type: 'REASONING_MESSAGE_END' },
            { ...base, type: 'REASONING_END' },
        ] as unknown as T[];
    };
    for await (const chunk of stream) {
        switch (chunk.type) {
            case 'REASONING_START':
            case 'REASONING_MESSAGE_START':
                // Opened when its first content comes: the library starts a
                // message before any, and may never end it in the right place.
                continue;
            case 'REASONING_MESSAGE_CONTENT': {
                if (typeof chunk.delta !== 'string' || chunk.delta === '') {
                    continue;
                }
                if (!open) {
                    const upstream = chunk.messageId ?? 'reasoning';
                    reopened += used.has(upstream) ? 1 : 0;
                    yield* start(used.has(upstream) ? `${upstream}-${reopened}` : upstream, chunk.model);
                }
                yield { ...chunk, messageId: open!.id };
                continue;
            }
            case 'REASONING_MESSAGE_END':
            case 'REASONING_END':
                // The library's own end, wherever it comes: what is open
                // closes here, and an end for nothing open is dropped.
                yield* close();
                continue;
            default:
                if (CLOSES_REASONING.has(chunk.type)) {
                    yield* close();
                }
                yield chunk;
        }
    }
    yield* close();
}

/**
 * The Chat Completions adapter with its rounds' reasoning kept well formed,
 * as above. Patched in `processStreamChunks`, as `withNumberedToolCalls`.
 */
export function withReasoningLifecycle<T extends object>(adapter: T): T {
    type Step = (stream: AsyncIterable<unknown>, ...rest: unknown[]) => AsyncIterable<Chunk>;
    const target = adapter as unknown as { processStreamChunks: Step };
    const step = target.processStreamChunks;
    target.processStreamChunks = function (stream, ...rest) {
        return reasoningLifecycle(step.call(this, stream, ...rest));
    };
    return adapter;
}
