import { PROSE_CHARS } from '@socio/shared/context-settings';
import type { InferenceCapabilities } from '@socio/shared/inference';

/**
 * A model's context budget and the cheap estimate of a text's tokens
 * (CB-129). Moved from `src/server/context/budget.ts`, which keeps the
 * per-message estimates and their calibration.
 */

/** A model whose window nobody set: a conservative guess. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
/** The answer's room when neither the reserve nor the completion cap is set. */
const DEFAULT_OUTPUT_RESERVE = 4_096;
/** The share of the window a round's prompt aims for. */
export const TARGET_SHARE = 0.7;

/** Of base64 (screenshots and files inside a result). */
const BASE64_CHARS = 2.5;

const BASE64 = /[A-Za-z0-9+/=]{400,}/g;

export interface ContextBudget {
    /** The model's window, in tokens. */
    window: number;
    /** Kept free for the answer. */
    reserve: number;
    /** What a round's prompt (system prompts, tools and messages) aims for. */
    target: number;
}

export function contextBudget(capabilities: InferenceCapabilities): ContextBudget {
    const window = capabilities.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const reserve = Math.min(
        capabilities.outputReserve ?? capabilities.maxCompletionTokens ?? DEFAULT_OUTPUT_RESERVE,
        Math.floor(window / 4),
    );
    return {
        window,
        reserve,
        target: Math.floor(Math.min(window * TARGET_SHARE, window - reserve)),
    };
}

/**
 * A prompt's characters as sent once fitted: at most about the budget's
 * target, so a huge thread's first-round wait and timing samples are of
 * the prompt the model gets, not of the stored history.
 */
export const fittedChars = (capabilities: InferenceCapabilities, chars: number) =>
    Math.min(chars, contextBudget(capabilities).target * PROSE_CHARS);

/** Tokens of text, at `chars` characters a token; base64 runs cost more. */
export function textTokens(text: string, chars = PROSE_CHARS) {
    if (!text) {
        return 0;
    }
    let encoded = 0;
    if (text.length >= 400) {
        for (const match of text.matchAll(BASE64)) {
            encoded += match[0].length;
        }
    }
    return Math.ceil((text.length - encoded) / chars + encoded / BASE64_CHARS);
}
