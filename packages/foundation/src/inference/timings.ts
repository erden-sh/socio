/**
 * Response times per model (the phase line's "usually ~7 s"), as the
 * server's inference feature stores them and a turn's round timer reads
 * them. Moved from the inference contract, which re-exports them, so
 * turns imports nothing of inference.
 */

/** A turn's first model round, or one after tool results. */
export type RoundKind = 'first' | 'next';

export interface TimingSample {
    /** `timingKey(model)`. */
    key: string;
    /** A turn's first model round, or one after tool results. */
    round: RoundKind;
    /** First rounds: the characters of the messages and system prompts sent. */
    promptChars?: number;
    promptTokens: number;
    /** Prompt tokens not served from the server's prefix cache. */
    uncachedTokens: number;
    ttftMs: number;
}

export interface WaitEstimate {
    /** The expected wait for the first output. */
    ms: number;
    /** The expected prompt size, tokens. */
    tokens: number;
    /** How many samples it rests on. */
    samples: number;
}

/**
 * Response times per model (the phase line's "usually ~7 s"); numbers
 * only, never content. `inference/timings.ts`'s `InferenceTimings`
 * implements it.
 */
export interface InferenceTimingsShape {
    /** Stores a sample (its own unit of work, queued behind any open one). */
    record(sample: TimingSample, at?: number): Promise<void>;
    /** The expected wait for a round's first output; undefined until the model has a few samples. */
    estimate(
        key: string,
        round: RoundKind,
        size: { promptChars?: number; promptTokens?: number },
    ): Promise<WaitEstimate | undefined>;
}
