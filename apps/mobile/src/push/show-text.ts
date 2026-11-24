import type { PushDevice } from '../data/registry';

// "Show message text in notifications": the phone's own setting, on until set
// (registry migration 7's `showText`), for every workspace on it. Off, the
// notification extension (iOS) and the messaging service (Android) show only
// the generic text. A change shows at once, is kept in the registry, then
// handed to the native side (the push manager's `syncShowText`); one the
// registry refuses goes back. A hand-over that fails is tried again
// (`HAND_OVER_RETRIES_MS`); if it still fails the change stays kept and shown,
// and `set` rejects with a `ShowTextHandOverError` so the screen can say
// notifications follow it once Socio starts again (launch hands the registry's
// value over, src/platform/push.ts). A set that a newer one has superseded (a
// sequence number) stops trying and settles quietly: its failure would speak
// for a value the screen no longer shows. No React Native: tests/push runs it
// under Node, src/platform/push.ts binds it.

/** The registry's push device settings, as this reads and writes them. */
export interface ShowTextStore {
    pushDevice(): Promise<Pick<PushDevice, 'showText'>>;
    setPushDevice(change: { readonly showText: boolean }): Promise<unknown>;
}

/** The waits before each new try of a failed hand-over. */
export const HAND_OVER_RETRIES_MS: readonly number[] = [500, 2_000];

/** The change is kept on the phone, but the native side still has the value before it. */
export class ShowTextHandOverError extends Error {
    override name = 'ShowTextHandOverError';

    constructor(cause: unknown) {
        super('The show-text setting was kept but not handed to the native side.');
        this.cause = cause;
    }
}

export interface ShowTextSetting {
    /** The setting now: null until `load`. */
    get(): boolean | null;
    subscribe(listener: () => void): () => void;
    /** Reads it from `store`, which keeps every later change. */
    load(store: ShowTextStore): Promise<void>;
    /**
     * Shows the change at once, keeps it, then hands it to the native side.
     * Rejects, back where it was, when it can't be kept; with a
     * `ShowTextHandOverError`, still kept, when every hand-over failed.
     * Resolves without trying further once a newer `set` has started: that
     * one keeps and hands over its own value, and answers for it.
     */
    set(showText: boolean): Promise<void>;
}

export function createShowTextSetting(
    handOver: () => Promise<void>,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): ShowTextSetting {
    let current: boolean | null = null;
    let store: ShowTextStore | null = null;
    // The newest `set`'s number: an older one's failures are no longer anyone's.
    let latest = 0;
    const listeners = new Set<() => void>();
    const settle = (next: boolean | null) => {
        if (next === current) {
            return;
        }
        current = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };
    return {
        get: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async load(next) {
            store = next;
            settle((await next.pushDevice()).showText);
        },
        async set(showText) {
            if (store === null) {
                throw new Error('The push settings are not loaded.');
            }
            latest += 1;
            const mine = latest;
            const superseded = () => mine !== latest;
            const before = current;
            settle(showText);
            try {
                await store.setPushDevice({ showText });
            } catch (error) {
                if (superseded()) {
                    return;
                }
                settle(before);
                throw error;
            }
            let failure: unknown;
            for (const delay of [0, ...HAND_OVER_RETRIES_MS]) {
                if (delay > 0) {
                    await wait(delay);
                }
                if (superseded()) {
                    return;
                }
                try {
                    await handOver();
                    return;
                } catch (error) {
                    failure = error;
                }
            }
            if (superseded()) {
                return;
            }
            throw new ShowTextHandOverError(failure);
        },
    };
}
