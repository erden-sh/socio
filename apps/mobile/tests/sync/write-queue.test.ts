import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONVERSATIONS } from '../../src/sync/shell';
import { createWriteQueue, SETTLE_MS, WRITE_INTERVAL_MS } from '../../src/sync/write-queue';

import { metaOnDisk, rowsOnDisk, syncSetup } from './helpers';

// The cache's write cadence: 500 ms after
// changes settle, at most every 10 s, and at once on the platform's flush
// trigger (the app going to the background), with fake timers.

function queueUnderTest(options: { fail?: () => boolean; during?: () => Promise<void> } = {}) {
    const writes: number[] = [];
    const errors: unknown[] = [];
    let trigger: (() => void) | undefined;
    let unsubscribed = false;
    let running = 0;
    let most = 0;
    const queue = createWriteQueue({
        write: async () => {
            writes.push(Date.now());
            running += 1;
            most = Math.max(most, running);
            try {
                await options.during?.();
                if (options.fail?.()) {
                    throw new Error('disk full');
                }
            } finally {
                running -= 1;
            }
        },
        flushTrigger: (flush) => {
            trigger = flush;
            return () => {
                unsubscribed = true;
            };
        },
        onError: (error) => errors.push(error),
    });
    const t0 = Date.now();
    return {
        queue,
        errors,
        /** Write times, relative to the start. */
        writes: () => writes.map((at) => at - t0),
        background: () => trigger?.(),
        get unsubscribed() {
            return unsubscribed;
        },
        /** The most writes that ran at once. */
        get most() {
            return most;
        },
        at: (ms: number) => vi.advanceTimersByTimeAsync(t0 + ms - Date.now()),
    };
}

describe('the cache write queue', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date('2026-11-02T09:00:00Z') });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes 500 ms after the changes settle, once for a burst', async () => {
        const q = queueUnderTest();
        q.queue.changed();
        await q.at(200);
        q.queue.changed();
        await q.at(400);
        q.queue.changed();
        await q.at(899);
        expect(q.writes()).toEqual([]);
        await q.at(900);
        expect(q.writes()).toEqual([400 + SETTLE_MS]);
        await q.at(30_000);
        expect(q.writes()).toEqual([900]);
    });

    it('writes at most every 10 s', async () => {
        const q = queueUnderTest();
        q.queue.changed();
        await q.at(500);
        expect(q.writes()).toEqual([500]);
        await q.at(2000);
        q.queue.changed();
        await q.at(5000);
        expect(q.writes()).toEqual([500]);
        await q.at(500 + WRITE_INTERVAL_MS);
        expect(q.writes()).toEqual([500, 500 + WRITE_INTERVAL_MS]);
        // After a quiet spell, the 500 ms again.
        await q.at(40_000);
        q.queue.changed();
        await q.at(40_500);
        expect(q.writes()).toEqual([500, 10_500, 40_500]);
    });

    it('doesn’t let changes that never settle hold the write past 10 s', async () => {
        const q = queueUnderTest();
        for (let at = 0; at <= 25_000; at += 100) {
            await q.at(at);
            q.queue.changed();
        }
        expect(q.writes()).toEqual([WRITE_INTERVAL_MS, 2 * WRITE_INTERVAL_MS]);
    });

    it('writes at once when the platform says the app is going to the background', async () => {
        const q = queueUnderTest();
        q.queue.changed();
        await q.at(100);
        q.background();
        await q.at(101);
        expect(q.writes()).toEqual([100]);
        // Nothing pending: the trigger writes nothing, and no write follows.
        q.background();
        await q.at(20_000);
        expect(q.writes()).toEqual([100]);
    });

    it('flushes at once whatever the cadence', async () => {
        const q = queueUnderTest();
        q.queue.changed();
        await q.at(500);
        q.queue.changed();
        await q.queue.flush();
        expect(q.writes()).toEqual([500, 500]);
        await q.queue.flush();
        expect(q.writes()).toEqual([500, 500]);
    });

    it('flushes after the write in progress, and nothing else writes beside the flush’s', async () => {
        const gates: Array<() => void> = [];
        const q = queueUnderTest({ during: () => new Promise<void>((done) => gates.push(done)) });
        q.queue.changed();
        await q.at(500);
        expect(q.writes()).toEqual([500]);
        // A change lands while the cadence's write runs, and the app goes to the background.
        q.queue.changed();
        let flushed = false;
        const flush = q.queue.flush().then(() => {
            flushed = true;
        });
        await q.at(700);
        expect(q.writes()).toEqual([500]);
        expect(flushed).toBe(false);
        // The write in progress ends: the flush writes the change at once.
        gates.shift()?.();
        await q.at(700);
        expect(q.writes()).toEqual([500, 700]);
        // Its write is slow, past when the cadence would have written: nothing starts beside it.
        await q.at(12_000);
        expect(q.writes()).toEqual([500, 700]);
        expect(flushed).toBe(false);
        gates.shift()?.();
        await flush;
        expect(q.most).toBe(1);
        await q.at(30_000);
        expect(q.writes()).toEqual([500, 700]);
    });

    it('never runs two writes at once, with slow writes, a flush and changes during each', async () => {
        const q = queueUnderTest({ during: () => new Promise<void>((done) => setTimeout(done, 6_000)) });
        q.queue.changed();
        await q.at(500);
        q.queue.changed();
        const flush = q.queue.flush();
        await q.at(6_500);
        q.queue.changed();
        await q.at(40_000);
        await flush;
        expect(q.most).toBe(1);
        // The flush writes what came during its own write too, then the queue is quiet.
        expect(q.writes()).toEqual([500, 6_500, 12_500]);
        expect(q.errors).toEqual([]);
    });

    it('keeps the changes after a failed write and tries again 10 s on', async () => {
        let fail = true;
        const q = queueUnderTest({ fail: () => fail });
        q.queue.changed();
        await q.at(500);
        expect(q.errors).toHaveLength(1);
        fail = false;
        await q.at(10_499);
        expect(q.writes()).toEqual([500]);
        await q.at(10_500);
        expect(q.writes()).toEqual([500, 10_500]);
        await q.at(60_000);
        expect(q.writes()).toEqual([500, 10_500]);
    });

    it('rejects a flush whose write fails', async () => {
        const q = queueUnderTest({ fail: () => true });
        q.queue.changed();
        await expect(q.queue.flush()).rejects.toThrow('disk full');
    });

    it('closes after a last flush, and unsubscribes from the trigger', async () => {
        const q = queueUnderTest();
        q.queue.changed();
        await q.queue.close();
        expect(q.writes()).toEqual([0]);
        expect(q.unsubscribed).toBe(true);
        expect(() => q.queue.changed()).toThrow('closed');
        await q.at(20_000);
        expect(q.writes()).toEqual([0]);
    });
});

describe('the snapshot cache’s writes', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reach cache.db 500 ms after a pull, not before', async () => {
        const s = await syncSetup();
        try {
            vi.useFakeTimers();
            const { cursor } = await s.workspace.pull('', null);
            expect(await rowsOnDisk(s.db, CONVERSATIONS)).toEqual({});
            await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
            expect(await rowsOnDisk(s.db, CONVERSATIONS)).toEqual({});
            await vi.advanceTimersByTimeAsync(1);
            expect(Object.keys(await rowsOnDisk(s.db, CONVERSATIONS))).toEqual(['c0', 'c1', 'c2']);
            expect((await metaOnDisk(s.db, 'workspace'))?.etag).toBe(cursor);
            // A 304 with the same tag writes nothing.
            const writes = s.driver.log.filter((line) => line.endsWith('BEGIN IMMEDIATE')).length;
            await s.workspace.pull('', cursor);
            await vi.advanceTimersByTimeAsync(WRITE_INTERVAL_MS * 2);
            expect(s.driver.log.filter((line) => line.endsWith('BEGIN IMMEDIATE'))).toHaveLength(writes);
        } finally {
            vi.useRealTimers();
            await s.close();
        }
    });
});
