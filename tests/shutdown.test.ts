import { afterEach, expect, it, vi } from 'vitest';

import { createShutdown, drainMsFromEnv, drainMsInForce } from '../src/server/runtime/shutdown.js';
import { limitsFor } from '../src/server/settings/limits.js';

import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

afterEach(() => vi.useRealTimers());
it('waits for Channels and HTTP shutdown and handles repeated signals once', async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const stopRunner = vi.fn(),
        stopPlatform = vi.fn(() => wait),
        closeServer = vi.fn(async () => {}),
        exit = vi.fn(),
        report = vi.fn();
    const shutdown = createShutdown({
        stopRunner,
        stopPlatform,
        closeServer,
        exit,
        report,
    });
    const first = shutdown();
    const second = shutdown();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finish();
    await first;
    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(stopPlatform).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
});
it('bounds a stuck shutdown and reports operation failures without stopping other cleanup', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(),
        report = vi.fn(),
        closeServer = vi.fn(async () => {});
    const shutdown = createShutdown({
        stopRunner: () => {
            throw new Error('secret');
        },
        stopPlatform: () => new Promise(() => {}),
        closeServer,
        exit,
        report,
        timeoutMs: 100,
    });
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(report).toHaveBeenCalledTimes(2);
});
it('drains first: refuses new work, waits for work in progress, then stops and closes the database last', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let running = 2;
    const exit = vi.fn(),
        log = vi.fn();
    const shutdown = createShutdown({
        drain: () => order.push('drain'),
        inProgress: () => running,
        drainMs: 110_000,
        stopRunner: () => order.push('stopRunner'),
        stopPlatform: async () => void order.push('stopPlatform'),
        closeServer: async () => void order.push('closeServer'),
        closeDatabase: () => order.push('closeDatabase'),
        exit,
        report: vi.fn(),
        log,
    });
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(['drain']);
    running = 0;
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(order).toEqual(['drain', 'stopRunner', 'stopPlatform', 'closeServer', 'closeDatabase']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.mock.calls.flat()).toEqual([
        'Shutdown: draining, 2 in progress (up to 110 s).',
        'Shutdown: drained in 5 s.',
    ]);
});
it('stops at the drain deadline, interrupting what is still running', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(),
        log = vi.fn(),
        stopPlatform = vi.fn(async () => {});
    const shutdown = createShutdown({
        drain: () => {},
        inProgress: () => 1,
        drainMs: 1_000,
        stopRunner: () => {},
        stopPlatform,
        closeServer: async () => {},
        exit,
        report: vi.fn(),
        log,
    });
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(999);
    expect(stopPlatform).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(stopPlatform).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenLastCalledWith('Shutdown: drain deadline passed; interrupting 1 still in progress.');
});
it('reads the drain time from SHUTDOWN_DRAIN_MS', () => {
    // The 300 s turn limit plus 20 s, or the limit set plus 20 s.
    expect(drainMsFromEnv({})).toBe(320_000);
    expect(drainMsFromEnv({ TURN_TIME_LIMIT_SECONDS: '90' })).toBe(110_000);
    expect(drainMsFromEnv({ SHUTDOWN_DRAIN_MS: ' 5000 ' })).toBe(5000);
    expect(drainMsFromEnv({ SHUTDOWN_DRAIN_MS: '0' })).toBe(0);
    expect(() => drainMsFromEnv({ SHUTDOWN_DRAIN_MS: 'soon' })).toThrow();
    expect(() => drainMsFromEnv({ SHUTDOWN_DRAIN_MS: '-1' })).toThrow();
});
it('drains for the limit in force plus 20 s, read when the shutdown starts (CB-123)', async () => {
    // The stored limit, as index.ts reads it at shutdown; SHUTDOWN_DRAIN_MS wins.
    expect(drainMsFromEnv({}, 45_000)).toBe(65_000);
    expect(drainMsFromEnv({ TURN_TIME_LIMIT_SECONDS: '90' }, 45_000)).toBe(65_000);
    expect(drainMsFromEnv({ SHUTDOWN_DRAIN_MS: '5000' }, 45_000)).toBe(5000);

    const store = new Store(testDatabase());
    const config = {
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://unused.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
    };
    const drain = () => drainMsInForce({}, store.settings(), limitsFor(config));
    vi.useFakeTimers();
    const stopPlatform = vi.fn(async () => {});
    const shutdown = createShutdown({
        inProgress: () => 1,
        drainMs: drain,
        stopRunner: () => {},
        stopPlatform,
        closeServer: async () => {},
        exit: vi.fn(),
        report: vi.fn(),
    });
    expect(drain()).toBe(320_000);
    // An admin saved 30 s after the server started: the drain is 50 s, not 320 s.
    await store.updateSettings({ limits: { turnTimeLimitSeconds: 30 } });
    expect(drain()).toBe(50_000);
    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(49_000);
    expect(stopPlatform).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(stopPlatform).toHaveBeenCalledTimes(1);
    // An explicit SHUTDOWN_DRAIN_MS still wins over the stored limit.
    expect(drainMsInForce({ SHUTDOWN_DRAIN_MS: '7000' }, store.settings(), limitsFor(config))).toBe(7000);
    store.close();
});
