import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamHaptics, shouldTickStreamHaptic, STREAM_HAPTIC_THROTTLE_MS } from '../../src/chat/stream-haptics';

// Stream haptics: T3 Code's rule, with its
// cases, and the tracker that seeds on its first observation.

const mark = (id: string, textLength: number) => ({ id, textLength });

describe('shouldTickStreamHaptic', () => {
    // Upstream's cases (threadStreamHaptics.test.ts).
    it('ticks for a new stream even inside the throttle window', () => {
        expect(shouldTickStreamHaptic({ previous: mark('a', 40), latest: mark('b', 1), lastTickAt: 0, now: 10 })).toBe(
            true,
        );
        expect(shouldTickStreamHaptic({ previous: null, latest: mark('a', 1), lastTickAt: 0, now: 10 })).toBe(true);
    });

    it('throttles growth of the same stream', () => {
        const growth = { previous: mark('a', 10), latest: mark('a', 20), lastTickAt: 1_000 };
        expect(shouldTickStreamHaptic({ ...growth, now: 1_200 })).toBe(false);
        expect(shouldTickStreamHaptic({ ...growth, now: 1_000 + STREAM_HAPTIC_THROTTLE_MS })).toBe(true);
    });

    it('stays quiet when nothing streams or the text did not grow', () => {
        expect(shouldTickStreamHaptic({ previous: mark('a', 10), latest: null, lastTickAt: 0, now: 5_000 })).toBe(
            false,
        );
        expect(
            shouldTickStreamHaptic({ previous: mark('a', 10), latest: mark('a', 10), lastTickAt: 0, now: 5_000 }),
        ).toBe(false);
    });
});

describe('createStreamHaptics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is silent when the chat opens mid-stream, then ticks on growth at most every 320 ms', () => {
        const ticks: number[] = [];
        const start = Date.now();
        const haptics = createStreamHaptics(() => ticks.push(Date.now() - start));
        haptics.observe(mark('a', 100));
        expect(ticks).toEqual([]);
        for (let step = 1; step <= 10; step += 1) {
            vi.advanceTimersByTime(100);
            haptics.observe(mark('a', 100 + step * 10));
        }
        expect(ticks).toEqual([100, 500, 900]);
    });

    it('ticks at once when a new reply starts streaming', () => {
        const ticks: number[] = [];
        const haptics = createStreamHaptics(() => ticks.push(Date.now()));
        haptics.observe(null);
        haptics.observe(mark('a', 1));
        haptics.observe(mark('a', 2));
        haptics.observe(null);
        haptics.observe(mark('b', 1));
        expect(ticks).toHaveLength(2);
    });
});
