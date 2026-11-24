import type { InferenceTimingsShape, RoundKind, TimingSample, WaitEstimate } from './contract.js';
import type { InferenceTimingRepository } from './domain/repositories.js';

/**
 * Response times per model (the phase line's "usually ~7 s"): for each
 * model round of a Dot turn, how long it took from the request to the first
 * visible output (reasoning, text or a tool call), and the prompt's size.
 * Numbers only, never content. The estimate learns from the latest
 * samples; prefill-progress events from a server would replace it later.
 */

/** Samples kept per model; the estimate reads the latest `WINDOW`. */
const KEEP = 200;
const WINDOW = 50;
const MIN_SAMPLES = 5;
/** A fit needs this many samples spread over this many uncached tokens. */
const FIT_SAMPLES = 8;
const FIT_SPREAD = 2_000;
/** Before any first round with a size: about four characters a token. */
const DEFAULT_TOKENS_PER_CHAR = 0.25;

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Least squares `y = a + b·x`, both kept at zero or more. */
function fit(points: { x: number; y: number }[]) {
    const n = points.length;
    const mx = points.reduce((sum, p) => sum + p.x, 0) / n;
    const my = points.reduce((sum, p) => sum + p.y, 0) / n;
    const sxx = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
    const sxy = points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0);
    const b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
    const a = Math.max(0, my - b * mx);
    return (x: number) => a + b * x;
}

class SqliteInferenceTimings implements InferenceTimingsShape {
    constructor(private repo: InferenceTimingRepository) {}

    /** Stores a sample (its own unit of work, queued behind any open one). */
    async record(sample: TimingSample, at = Date.now()) {
        if (!(sample.ttftMs >= 0) || !(sample.promptTokens > 0) || sample.ttftMs > 3_600_000) {
            return;
        }
        await this.repo.add(
            {
                key: sample.key,
                round: sample.round,
                at,
                promptChars: sample.promptChars ?? null,
                promptTokens: Math.round(sample.promptTokens),
                uncachedTokens: Math.round(Math.min(sample.uncachedTokens, sample.promptTokens)),
                ttftMs: Math.round(sample.ttftMs),
            },
            KEEP,
        );
    }

    /**
     * The expected wait for a round's first output: from the prompt's size
     * (first rounds: `promptChars`, converted with the model's own
     * tokens-per-character; later rounds: `promptTokens`), the share its
     * prefix cache usually serves, and the time per uncached token (a fit
     * once the samples spread enough; else the median wait). Undefined until
     * the model has a few samples.
     */
    async estimate(
        key: string,
        round: RoundKind,
        size: { promptChars?: number; promptTokens?: number },
    ): Promise<WaitEstimate | undefined> {
        const all = await this.repo.latest(key, WINDOW * 2);
        const same = all.filter((sample) => sample.round === round);
        const samples = (same.length >= MIN_SAMPLES ? same : all).slice(0, WINDOW);
        if (samples.length < MIN_SAMPLES) {
            return undefined;
        }
        let tokens = size.promptTokens;
        if (tokens === undefined) {
            const sized = all.filter((sample) => sample.promptChars);
            const perChar = sized.length
                ? median(sized.map((s) => s.promptTokens / s.promptChars!))
                : DEFAULT_TOKENS_PER_CHAR;
            tokens = (size.promptChars ?? 0) * perChar;
        }
        const uncachedShare = median(samples.map((sample) => sample.uncachedTokens / sample.promptTokens));
        const points = samples.map((sample) => ({
            x: sample.uncachedTokens,
            y: sample.ttftMs,
        }));
        const xs = points.map((point) => point.x);
        const ms =
            points.length >= FIT_SAMPLES && Math.max(...xs) - Math.min(...xs) >= FIT_SPREAD
                ? fit(points)(tokens * uncachedShare)
                : median(points.map((point) => point.y));
        return {
            ms: Math.round(ms),
            tokens: Math.round(tokens),
            samples: samples.length,
        };
    }
}

/**
 * The response times over their repository. The type is the contract's
 * slice, not the class: `InferenceResolver.timings` (in the contract) is
 * that slice, and code that takes `InferenceTimings` (turns/round-timer.ts)
 * is handed it. A class type would also require its private repository.
 */
export type InferenceTimings = InferenceTimingsShape;
export const InferenceTimings: new (repo: InferenceTimingRepository) => InferenceTimingsShape = SqliteInferenceTimings;
