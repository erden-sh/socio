// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import type { NameTrigger } from './contract.js';
import { keywordsOf, nameOverlap, UNTITLED } from './keywords.js';

/**
 * After how many messages an unnamed chat (still "Untitled"/empty) gets its
 * first suggestion (CB-292: N=6).
 */
export const UNNAMED_AFTER_MESSAGES = 6;

/**
 * How many recent messages the drift heuristic looks at (CB-292: M=12).
 */
export const DRIFT_WINDOW_MESSAGES = 12;

/**
 * Below this overlap ratio between the current name's keywords and the recent
 * window, the topic is taken to have drifted (CB-292: <20%).
 */
export const DRIFT_RATIO = 0.2;

/**
 * A rejected suggestion suppresses a new one for this many messages
 * (CB-292: K=30). Accept/customize resets it too.
 */
export const REJECT_COOLDOWN_MESSAGES = 30;

export interface TriggerInput {
    /** The chat's current title (or '' when none). */
    title: string;
    /** Total messages in the chat so far. */
    messageCount: number;
    /** The texts of the most recent messages, oldest-first within the window. */
    recentTexts: readonly string[];
    /**
     * The message index at which the last suggestion was rejected, or -1/none
     * when there has been no rejection (or it was accepted/customized).
     */
    lastRejectedAt: number;
    /** Whether a suggestion is already pending (one card per chat). */
    pending: boolean;
}

/**
 * Whether a name suggestion is eligible, and why. Cheap: no model call. The
 * naming itself is a model call made only when this returns a trigger
 * (CB-292: the drift check is keyword counting).
 *
 * Rules:
 * - one pending card per chat at a time;
 * - within K=30 messages of a reject, no re-suggest;
 * - unnamed: still "Untitled"/empty, with >= N=6 messages, fires once (until
 *   the chat is named);
 * - drift: already named, but the name's keywords appear in <20% of the
 *   recent M=12 messages.
 */
export function evaluateNameTrigger(input: TriggerInput): { trigger: NameTrigger } | undefined {
    if (input.pending) {
        return undefined;
    }
    if (input.lastRejectedAt >= 0 && input.messageCount - input.lastRejectedAt < REJECT_COOLDOWN_MESSAGES) {
        return undefined;
    }
    const title = input.title.trim();
    if (UNTITLED.has(title.toLowerCase())) {
        if (input.messageCount >= UNNAMED_AFTER_MESSAGES) {
            return { trigger: 'unnamed' };
        }
        return undefined;
    }
    const window = input.recentTexts.slice(-DRIFT_WINDOW_MESSAGES);
    if (window.length < DRIFT_WINDOW_MESSAGES) {
        return undefined;
    }
    const overlap = nameOverlap(keywordsOf(title), window);
    if (overlap < DRIFT_RATIO) {
        return { trigger: 'drift' };
    }
    return undefined;
}
