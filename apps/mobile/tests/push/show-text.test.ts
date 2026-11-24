import { describe, expect, it, vi } from 'vitest';

import {
    createShowTextSetting,
    HAND_OVER_RETRIES_MS,
    ShowTextHandOverError,
    type ShowTextStore,
} from '../../src/push/show-text';

// "Show message text in notifications", the phone's own setting,
// kept in the registry and then handed to the native side.

function store(initial: boolean, refuse = false) {
    let kept = initial;
    const writes: boolean[] = [];
    const value: ShowTextStore = {
        pushDevice: async () => ({ showText: kept }),
        setPushDevice: async ({ showText }) => {
            if (refuse) {
                throw new Error('read-only');
            }
            writes.push(showText);
            kept = showText;
        },
    };
    return { value, writes, kept: () => kept };
}

describe('the show-text setting', () => {
    it('is null until loaded, then what the registry keeps', async () => {
        const setting = createShowTextSetting(async () => {});
        expect(setting.get()).toBeNull();
        await expect(setting.set(false)).rejects.toThrow();
        await setting.load(store(true).value);
        expect(setting.get()).toBe(true);
    });

    it('shows a change at once, keeps it, then hands it over', async () => {
        const order: string[] = [];
        const kept = store(true);
        const setting = createShowTextSetting(async () => {
            order.push(`hand over ${kept.kept()}`);
        });
        await setting.load(kept.value);
        const listener = vi.fn(() => order.push(`shown ${setting.get()}`));
        setting.subscribe(listener);
        await setting.set(false);
        expect(order).toEqual(['shown false', 'hand over false']);
        expect(kept.writes).toEqual([false]);
    });

    it('goes back, and hands nothing over, when the registry refuses', async () => {
        const handOver = vi.fn(async () => {});
        const setting = createShowTextSetting(handOver);
        await setting.load(store(true, true).value);
        await expect(setting.set(false)).rejects.toThrow('read-only');
        expect(setting.get()).toBe(true);
        expect(handOver).not.toHaveBeenCalled();
    });

    it('tries a failed hand-over again', async () => {
        const kept = store(true);
        let fails = 1;
        const handOver = vi.fn(async () => {
            if (fails > 0) {
                fails -= 1;
                throw new Error('native busy');
            }
        });
        const waits: number[] = [];
        const setting = createShowTextSetting(handOver, async (ms) => {
            waits.push(ms);
        });
        await setting.load(kept.value);
        await setting.set(false);
        expect(handOver).toHaveBeenCalledTimes(2);
        expect(waits).toEqual([HAND_OVER_RETRIES_MS[0]]);
        expect(setting.get()).toBe(false);
    });

    it('stays kept and shown when every hand-over fails, and says which failed', async () => {
        const kept = store(true);
        const handOver = vi.fn(async () => {
            throw new Error('no module');
        });
        const setting = createShowTextSetting(handOver, async () => {});
        await setting.load(kept.value);
        const failure = await setting.set(false).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ShowTextHandOverError);
        expect((failure as Error).cause).toEqual(new Error('no module'));
        expect(handOver).toHaveBeenCalledTimes(1 + HAND_OVER_RETRIES_MS.length);
        expect(setting.get()).toBe(false);
        expect(kept.kept()).toBe(false);
    });

    it('ignores a late hand-over failure once a newer toggle has synced', async () => {
        const kept = store(true);
        // The native side refuses all but the second set's hand-over.
        let failing = true;
        const handOver = vi.fn(async () => {
            if (failing) {
                throw new Error('native busy');
            }
        });
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let waits = 0;
        const setting = createShowTextSetting(handOver, async () => {
            waits += 1;
            if (waits === 1) {
                await held;
            }
        });
        await setting.load(kept.value);
        const first = setting.set(false).catch((error: unknown) => error);
        await vi.waitFor(() => expect(waits).toBe(1));
        failing = false;
        await setting.set(true);
        failing = true;
        release();
        expect(await first).toBeUndefined();
        expect(setting.get()).toBe(true);
        expect(kept.kept()).toBe(true);
    });

    it('never goes back over a newer toggle when the registry refuses an older one', async () => {
        let refuseNext = true;
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let kept = true;
        const setting = createShowTextSetting(async () => {});
        await setting.load({
            pushDevice: async () => ({ showText: kept }),
            setPushDevice: async ({ showText }) => {
                if (refuseNext) {
                    refuseNext = false;
                    await held;
                    throw new Error('read-only');
                }
                kept = showText;
            },
        });
        const first = setting.set(false).catch((error: unknown) => error);
        await setting.set(false);
        release();
        expect(await first).toBeUndefined();
        expect(setting.get()).toBe(false);
    });
});
