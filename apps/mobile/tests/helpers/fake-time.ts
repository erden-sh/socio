import { vi } from 'vitest';

// Fake time for one test (page-drafts, page-save and active-scope
// failed under load with wrong assertions, though each passed alone). A test
// that times out is only abandoned: its body keeps running after vitest moves
// on, and its next `vi.advanceTimersByTimeAsync` drives the *next* test's fake
// clock, whose timers then fire early and whose timer count is off. So a test
// advances time only through the clock `fakeTime` gave it, which throws once
// that test's `signal` (vitest's test context) has aborted, as it does on a
// timeout; and `endFakeTime()`, in afterEach, empties the clock before the real
// timers come back, so an advance still in progress fires nothing more.

export class TestEnded extends Error {}

type FakeTimerOptions = Parameters<typeof vi.useFakeTimers>[0];

export interface FakeTime {
    /** `vi.advanceTimersByTimeAsync`, for this test only. */
    advance(ms: number): Promise<void>;
    /** `count` turns of the real event loop (setImmediate), for this test only. */
    turns(count?: number): Promise<void>;
}

/** Fakes the timers for the test whose context's `signal` this is. */
export function fakeTime(signal: AbortSignal, options?: FakeTimerOptions): FakeTime {
    vi.useFakeTimers(options);
    const live = () => {
        if (signal.aborted) {
            throw new TestEnded('This test has ended (timed out): its body must not move the next test’s clock.');
        }
    };
    return {
        async advance(ms) {
            live();
            await vi.advanceTimersByTimeAsync(ms);
            live();
        },
        async turns(count = 10) {
            for (let turn = 0; turn < count; turn += 1) {
                live();
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });
            }
            live();
        },
    };
}

/** In afterEach: the fake clock's timers go, then the real timers come back. */
export function endFakeTime() {
    vi.clearAllTimers();
    vi.useRealTimers();
}
