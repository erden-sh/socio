/**
 * What a model's adapter shows of its reasoning when it shows any
 * (CB-185): ChatGPT plans stream a provider's summary, and
 * OpenAI-compatible servers the raw thinking. Set on the adapter;
 * undefined reads as `raw`.
 */
export type ReasoningOutput = 'summary' | 'raw';
export interface ReasoningOutputAdapter {
    reasoningOutput?: ReasoningOutput;
}
/** `adapter`, saying what it shows of its reasoning. */
export function withReasoningOutput<T extends object>(adapter: T, output: ReasoningOutput): T {
    (adapter as ReasoningOutputAdapter).reasoningOutput = output;
    return adapter;
}
