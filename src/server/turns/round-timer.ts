import type { InferenceTimingsShape, RoundKind } from '@socio/foundation/inference/timings';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import type { RunWaitInfo } from '@socio/shared/runs/run-phase';

/** Chunks that end a round's wait: the model's first visible output. */
const VISIBLE = new Set([
    'TOOL_CALL_START',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'REASONING_START',
    'REASONING_MESSAGE_CONTENT',
]);
/** Tool results are counted at about four characters a token. */
const TOKENS_PER_CHAR = 0.25;

interface Usage {
    promptTokens?: number;
    completionTokens?: number;
    promptTokensDetails?: { cachedTokens?: number };
}
/** A round's own usage (the first entry when the library lists several). */
const usageOf = (chunk: unknown): Usage | undefined => {
    const usage = (chunk as { usage?: Usage | Usage[] }).usage;
    return Array.isArray(usage) ? usage[0] : usage;
};

/**
 * Passes a Dot turn's model stream on as it is, timing each model round:
 * from its request (the turn's start, or the last tool result) to its first
 * visible output. Each round's time and prompt size (from its usage) go to
 * `timings`; as each round starts, `emit` gets the expected wait, when the
 * model has enough history. Timing failures never touch the turn.
 */
export async function* timedRounds<T extends { type: string }>(
    stream: AsyncIterable<T>,
    options: {
        key: string;
        /** The first round's messages and system prompts, in characters. */
        promptChars: number;
        timings?: InferenceTimingsShape;
        /** Include the prompt size (self-hosted models, where it drives the wait). */
        showTokens: boolean;
        emit: (wait: RunWaitInfo) => void;
        now?: () => number;
    },
): AsyncGenerator<T> {
    const now = options.now ?? Date.now;
    const safely = async (operation: string, fn: () => unknown) => {
        try {
            await fn();
        } catch (error) {
            reportFailure(`Response times (${operation})`, [safeFailure(error)]);
        }
    };
    let round: RoundKind = 'first';
    let started = now();
    let ttft: number | undefined;
    let lastPrompt = 0;
    let lastCompletion = 0;
    let resultChars = 0;
    const announce = (size: { promptChars?: number; promptTokens?: number }) =>
        safely('estimate', async () => {
            const estimate = await options.timings?.estimate(options.key, round, size);
            if (estimate) {
                options.emit({
                    expectedMs: estimate.ms,
                    ...(options.showTokens ? { tokens: estimate.tokens } : {}),
                });
            }
        });
    await announce({ promptChars: options.promptChars });
    for await (const chunk of stream) {
        if (ttft === undefined && VISIBLE.has(chunk.type)) {
            ttft = now() - started;
        }
        const usage = chunk.type === 'RUN_FINISHED' ? usageOf(chunk) : undefined;
        if (usage?.promptTokens) {
            const { promptTokens, completionTokens = 0 } = usage;
            const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
            if (ttft !== undefined) {
                const sample = {
                    key: options.key,
                    round,
                    ...(round === 'first' ? { promptChars: options.promptChars } : {}),
                    promptTokens,
                    uncachedTokens: Math.max(0, promptTokens - cached),
                    ttftMs: ttft,
                };
                // Not awaited: the stream goes on while the sample is stored.
                void safely('record', () => options.timings?.record(sample));
            }
            lastPrompt = promptTokens;
            lastCompletion = completionTokens;
            resultChars = 0;
        }
        if (chunk.type === 'TOOL_CALL_RESULT') {
            // The next request goes out with this result: a new wait begins.
            const { content, result } = chunk as {
                content?: unknown;
                result?: unknown;
            };
            const payload = content ?? result;
            resultChars +=
                typeof payload === 'string' ? payload.length : (JSON.stringify(payload ?? null)?.length ?? 0);
            round = 'next';
            started = now();
            ttft = undefined;
            await announce({
                promptTokens: lastPrompt + lastCompletion + resultChars * TOKENS_PER_CHAR,
            });
        }
        yield chunk;
    }
}
