// Stream haptics: a light tick when a
// reply starts streaming, then at most every 320 ms while it grows, so a fast
// stream reads as texture rather than a buzz. Opening a chat mid-stream is
// silent. No React Native here: the caller fires the haptic (expo-haptics'
// selection) and checks the Haptics setting.
//
// Based on T3 Code (https://github.com/pingdotgg/t3code) at commit 240446e2d9,
// Copyright (c) 2026 T3 Tools Inc., MIT (THIRD_PARTY_NOTICES, entry 12):
// - `shouldTickStreamHaptic` is upstream's, from
//   apps/mobile/src/features/threads/threadStreamHaptics.ts, unchanged but for
//   formatting;
// - `createStreamHaptics` is that file's `streamHapticsFamily` atom without
//   Effect: the first observation only seeds the mark, and each later one asks
//   `shouldTickStreamHaptic`.

/** The reply streaming now: its message id and how much text it has. */
export interface StreamingMessageMark {
    readonly id: string;
    readonly textLength: number;
}

/** The shortest time between two ticks for the same streaming reply. */
export const STREAM_HAPTIC_THROTTLE_MS = 320;

/**
 * A new stream always ticks; growth of the same stream ticks at most once per
 * throttle window, so a fast stream reads as texture rather than a buzz.
 */
export function shouldTickStreamHaptic(input: {
    readonly previous: StreamingMessageMark | null;
    readonly latest: StreamingMessageMark | null;
    readonly lastTickAt: number;
    readonly now: number;
}): boolean {
    const { previous, latest } = input;
    if (latest === null) {
        return false;
    }
    if (previous?.id !== latest.id) {
        return true;
    }
    if (latest.textLength <= previous.textLength) {
        return false;
    }
    return input.now - input.lastTickAt >= STREAM_HAPTIC_THROTTLE_MS;
}

/** One open chat's stream haptics. */
export interface StreamHaptics {
    /** Hands in the chat's streaming reply after each change (null when none streams). */
    observe(latest: StreamingMessageMark | null): void;
}

/** Calls `tick` when the chat's streaming reply should tick. The first observation only seeds. */
export function createStreamHaptics(tick: () => void): StreamHaptics {
    let seeded = false;
    let previous: StreamingMessageMark | null = null;
    let lastTickAt = 0;
    return {
        observe(latest) {
            const now = Date.now();
            const ticks = seeded && shouldTickStreamHaptic({ previous, latest, lastTickAt, now });
            seeded = true;
            previous = latest;
            if (!ticks) {
                return;
            }
            lastTickAt = now;
            tick();
        },
    };
}
