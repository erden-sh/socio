/**
 * A model round's token usage, read from what its provider reported. The
 * server's turn trace and its context fitting both read it.
 */

/** A plain object (not an array or null). */
export const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** A non-negative count, rounded; undefined when `value` is not one. */
export const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * A round's tokens from its RUN_FINISHED usage: TanStack's own shape
 * (OpenAI-compatible Chat Completions, and the Responses API's
 * `response.completed`, which ChatGPT plans use) or AG-UI's `usage[]`.
 */
export function roundTokens(usage: unknown) {
    const entry = Array.isArray(usage) ? usage[0] : usage;
    if (!isObject(entry)) {
        return {};
    }
    const prompt = isObject(entry.promptTokensDetails) ? entry.promptTokensDetails : {};
    const completion = isObject(entry.completionTokensDetails) ? entry.completionTokensDetails : {};
    const tokens = {
        inputTokens: count(entry.promptTokens ?? entry.inputTokens),
        outputTokens: count(entry.completionTokens ?? entry.outputTokens),
        reasoningTokens: count(completion.reasoningTokens ?? entry.reasoningTokens),
        cachedTokens: count(prompt.cachedTokens ?? entry.cachedInputTokens),
    };
    return Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined)) as Partial<
        typeof tokens
    >;
}
