// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import {
    CHUNK_RELOAD_KEY,
    CHUNK_RELOAD_WINDOW_MS,
    importOrReload,
    installChunkReload,
    reloadOnce,
} from '../src/shell/chunk-reload';

afterEach(() => sessionStorage.clear());

const memory = () => {
    const items = new Map<string, string>();
    return {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
    };
};
// Settles within a few ticks, or reports that it is still pending.
const settled = (promise: Promise<unknown>) =>
    Promise.race([
        promise.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        ),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
const failed = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

it('reloads once per 30 s per tab', () => {
    const storage = memory();
    const go = vi.fn();
    expect(reloadOnce(go, storage, 1000)).toBe(true);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1000');
    expect(reloadOnce(go, storage, 1000 + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);
    expect(reloadOnce(go, storage, 1000 + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
    expect(go).toHaveBeenCalledTimes(2);
    // A clock that went backwards doesn't block it for good.
    expect(reloadOnce(go, storage, 10)).toBe(true);
});

it('never reloads without storage to keep the guard in', () => {
    const go = vi.fn();
    const blocked = {
        getItem: () => {
            throw new Error('SecurityError');
        },
        setItem: () => {},
    };
    expect(reloadOnce(go, blocked)).toBe(false);
    expect(go).not.toHaveBeenCalled();
});

it('waits for the reload on a failed import, and throws the second failure', async () => {
    const go = vi.fn();
    expect(await settled(importOrReload(failed, go))).toBe('pending');
    expect(go).toHaveBeenCalledTimes(1);
    const second = await settled(importOrReload(failed, go));
    expect(second).toMatchObject({ error: expect.any(TypeError) });
    expect(go).toHaveBeenCalledTimes(1);
    // A working import is untouched, and so is an `undefined` from a
    // reload Vite's handler started: it waits.
    expect(await settled(importOrReload(async () => 'ok', go))).toEqual({
        value: 'ok',
    });
    expect(await settled(importOrReload(async () => undefined, go))).toBe('pending');
});

it('reloads once on vite:preloadError and lets a second one throw', () => {
    const go = vi.fn();
    const uninstall = installChunkReload(go);
    const fire = () => {
        const event = new Event('vite:preloadError', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    };
    expect(fire()).toBe(true);
    expect(fire()).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);
    uninstall();
    sessionStorage.clear();
    expect(fire()).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);
});
