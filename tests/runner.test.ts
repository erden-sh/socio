import { afterEach, expect, it, vi } from 'vitest';

import { webSearch } from '../src/server/search/layer.js';
import { research, type Config } from '../src/server/web/research.js';

import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const config: Config = {
    mode: 'live',
    apiKey: 'test',
    model: 'test',
    baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
it('aborts research when permissions are revoked outside the runner instance', async () => {
    const store = new Store(testDatabase());
    const runner = new Runner(store, config);
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
        (_url: string, options: RequestInit) =>
            new Promise((_resolve, reject) => {
                requestSignal = options.signal ?? undefined;
                requestSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
            }),
    );
    vi.stubGlobal('fetch', request);
    await store.createTask('Read https://example.com', null, 'owner');
    const tick = runner.tick();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await store.updateSettings({ memoryAllowed: false });
    await tick;
    expect(requestSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect((await store.tasks('owner'))[0].status).toBe('interrupted');
    runner.stop();
    store.close();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
    const fetch = vi.fn().mockResolvedValue(
        Response.json({
            title: 'Source',
            text: 'Page text',
            url: 'https://example.com',
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(
        research(
            'Read https://example.com',
            [],
            config,
            controller.signal,
            (text) => {
                if (text.startsWith('Source captured')) {
                    controller.abort();
                }
            },
            webSearch,
        ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
    const store = new Store(testDatabase());
    await store.memoryItems.add({
        text: 'Sensitive preference',
        userId: 'owner',
        source: 'person',
    });
    await store.updateSettings({ memoryAllowed: false });
    const task = await store.createTask('Read this sample', null, 'owner');
    const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
    await runner.tick();
    expect((await store.detail(task.id))?.runs[0].result?.text).not.toContain('Sensitive preference');
    store.close();
});
it('holds active work for review on graceful shutdown', async () => {
    const store = new Store(testDatabase());
    const runner = new Runner(store, config);
    const fetch = vi.fn(
        (_url: string, options: RequestInit) =>
            new Promise((_resolve, reject) =>
                options.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }),
            ),
    );
    vi.stubGlobal('fetch', fetch);
    await store.createTask('Read https://example.com', null, 'owner');
    const pending = runner.tick();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    runner.stop();
    await pending;
    expect((await store.tasks('owner'))[0].status).toBe('interrupted');
    expect(await store.claim()).toBeNull();
    await store.action((await store.tasks('owner'))[0].id, 'run');
    expect(await store.claim()).toBeTruthy();
    store.close();
});
it('survives a claim failure and runs work on the next tick', async () => {
    const store = new Store(testDatabase());
    const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const claim = vi.spyOn(store, 'claim').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
    });
    const task = await store.createTask('Read this sample', null, 'owner');
    try {
        await expect(runner.tick()).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledOnce();
        await runner.tick();
        expect(claim).toHaveBeenCalledTimes(2);
        expect((await store.detail(task.id))?.runs[0].result).toBeTruthy();
    } finally {
        log.mockRestore();
        store.close();
    }
});
it('survives failure persistence errors and clears active work', async () => {
    const store = new Store(testDatabase());
    const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('Provider failure'))
        .mockResolvedValueOnce({ text: 'Recovered', sources: [], memories: [] });
    const runner = new Runner(store, config, execute);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fail = vi.spyOn(store, 'fail').mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY');
    });
    await store.createTask('First', null, 'owner');
    try {
        await expect(runner.tick()).resolves.toBeUndefined();
        expect(fail).toHaveBeenCalledOnce();
        await store.createTask('Second', null, 'owner');
        await runner.tick();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledOnce();
    } finally {
        log.mockRestore();
        store.close();
    }
});
it('aborts work instead of throwing from an ownership timer', async () => {
    const store = new Store(testDatabase());
    await store.createTask('First', null, 'owner');
    const runner = new Runner(
        store,
        config,
        (_claim, _memories, signal) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                    once: true,
                });
            }),
    );
    vi.spyOn(store, 'owns').mockImplementationOnce(() => {
        throw new Error('Database unavailable');
    });
    try {
        await expect(runner.tick()).resolves.toBeUndefined();
        expect((await store.tasks('owner'))[0].status).toBe('failed');
    } finally {
        store.close();
    }
});
it('reads a changeable time limit each time a task starts (CB-123)', async () => {
    vi.useFakeTimers();
    const store = new Store(testDatabase());
    await store.createTask('First', null, 'owner');
    let limitMs = 60_000;
    const runner = new Runner(
        store,
        config,
        (_claim, _memories, signal) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {
                    once: true,
                });
            }),
        () => limitMs,
    );
    try {
        expect(store.leaseMs).toBeGreaterThanOrEqual(120_000);
        // Raised before the task starts: the lease follows it.
        limitMs = 300_000;
        const running = runner.tick();
        await vi.advanceTimersByTimeAsync(299_000);
        expect((await store.tasks('owner'))[0].status).toBe('running');
        expect(store.leaseMs).toBeGreaterThanOrEqual(360_000);
        await vi.advanceTimersByTimeAsync(1_001);
        await running;
        expect((await store.tasks('owner'))[0]).toMatchObject({
            status: 'failed',
            error: 'Research exceeded the 300 second time limit.',
        });
    } finally {
        vi.useRealTimers();
        store.close();
    }
});
