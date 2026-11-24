/**
 * A work cycle's request estimates and reported costs (CB-211): the pure
 * helpers the cycle ledger and `turns/turn-trace.ts` share. Moved from
 * `cycles/ledger.ts`, which re-exports them.
 */

/** Output a reservation allows for when a request names no maximum. */
export const OUTPUT_RESERVE_TOKENS = 4_000;
/** What an image counts as in an estimate (it is not its base64 length). */
const IMAGE_CHARS = 1_000;
/** About this many characters make a token, for estimates. */
const CHARS_PER_TOKEN = 4;

/**
 * About how many tokens a request to the model takes, its output included:
 * the characters of its messages and system prompts (an image at a fixed
 * weight), plus room for the answer. An estimate, made to reserve: the
 * provider's count replaces it once the request ends.
 */
export function estimateRequestTokens(options: {
    messages?: unknown;
    systemPrompts?: unknown;
    tools?: unknown;
    maxTokens?: unknown;
}): number {
    let images = 0;
    let chars: number;
    try {
        const json = JSON.stringify([options.messages ?? [], options.systemPrompts ?? []], (_key, value: unknown) => {
            if (
                value &&
                typeof value === 'object' &&
                ((value as { type?: unknown }).type === 'image' || (value as { type?: unknown }).type === 'image_url')
            ) {
                images += 1;
                return undefined;
            }
            return value;
        });
        chars = json?.length ?? 0;
    } catch {
        chars = 0;
    }
    const tools = Array.isArray(options.tools) ? options.tools.length * 200 : 0;
    const output =
        typeof options.maxTokens === 'number' && options.maxTokens > 0 ? options.maxTokens : OUTPUT_RESERVE_TOKENS;
    return Math.ceil((chars + tools + images * IMAGE_CHARS) / CHARS_PER_TOKEN) + output;
}

/** The cost a provider reported with a request's usage, in USD, if any. */
export function reportedCost(usage: unknown): number | undefined {
    const entry = Array.isArray(usage) ? usage[0] : usage;
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }
    const record = entry as Record<string, unknown>;
    for (const key of ['costUsd', 'cost', 'totalCost', 'total_cost']) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return value;
        }
    }
    return undefined;
}
