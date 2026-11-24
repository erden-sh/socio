import { expect, it, vi } from 'vitest';

import { AppDeliveryTasks, APP_DELIVERY_TIMEOUT_MS } from '../src/server/notifications/delivery-tasks.js';

it('bounds unresolved attempts and queue across deadlines, shutdown and restart', async () => {
    vi.useFakeTimers();
    try {
        const log = vi.fn();
        const pool = new AppDeliveryTasks(log);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const run = vi.fn(async () => {
            await held;
        });
        for (let i = 0; i < 100; i++) {
            pool.enqueue(String(i), run);
        }
        await Promise.resolve();
        expect(run).toHaveBeenCalledTimes(4);
        expect(pool.status()).toMatchObject({
            running: 4,
            queued: 32,
            skipped: 64,
        });
        pool.enqueue('0', run);
        expect(pool.status().skipped).toBe(64);
        await vi.advanceTimersByTimeAsync(APP_DELIVERY_TIMEOUT_MS);
        expect(pool.status()).toMatchObject({
            running: 4,
            queued: 32,
            abortRequested: 4,
        });
        const stopping = pool.stop(20);
        await vi.advanceTimersByTimeAsync(20);
        expect(await stopping).toMatchObject({
            drained: false,
            running: 4,
            queued: 0,
            skipped: 96,
        });
        pool.resume();
        for (let i = 100; i < 200; i++) {
            pool.enqueue(String(i), run);
        }
        expect(run).toHaveBeenCalledTimes(4);
        expect(pool.status()).toMatchObject({ running: 4, queued: 32 });
        const cancel = new AbortController();
        const stoppingAgain = pool.stop(1000, cancel.signal);
        cancel.abort();
        expect((await stoppingAgain).drained).toBe(false);
        release();
        await vi.runAllTimersAsync();
        expect(await pool.idle()).toBe(true);
        expect(pool.status()).toMatchObject({
            running: 0,
            queued: 0,
            failedTasks: 0,
        });
    } finally {
        vi.useRealTimers();
    }
});

it('drains healthy tasks and catches failures without retrying them', async () => {
    const pool = new AppDeliveryTasks(vi.fn(), 1, 2);
    const order: number[] = [];
    pool.enqueue('a', async () => {
        order.push(1);
        throw Error('failed');
    });
    pool.enqueue('b', async () => {
        order.push(2);
    });
    expect(await pool.idle()).toBe(true);
    expect(order).toEqual([1, 2]);
    expect(pool.status()).toMatchObject({
        running: 0,
        queued: 0,
        failedTasks: 1,
    });
    expect((await pool.stop()).drained).toBe(true);
});
