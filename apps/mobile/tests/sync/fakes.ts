import type { PullResult } from '../../src/sync/snapshot-cache';
import type { SyncSource } from '../../src/sync/snapshot-source';
import type { AppStateSource, NetworkSource, NetworkState } from '../../src/sync/triggers';

// Fakes of what the platform injects into src/sync (triggers.ts) and of a
// source, for the scheduler's and the scope's tests: React Native's AppState
// and NetInfo, each with its listeners counted, and a source whose pulls answer
// at once or wait for the test.

export interface FakeAppState extends AppStateSource {
    /** Moves the app to `state` and tells the listeners, as AppState's 'change' does. */
    set(state: string): void;
    readonly listeners: number;
}

export function fakeAppState(initial = 'active'): FakeAppState {
    let state = initial;
    const listeners = new Set<(state: string) => void>();
    return {
        current: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set(next) {
            state = next;
            for (const listener of [...listeners]) {
                listener(next);
            }
        },
        get listeners() {
            return listeners.size;
        },
    };
}

export const WIFI: NetworkState = { connected: true, type: 'wifi' };
export const CELLULAR: NetworkState = { connected: true, type: 'cellular' };
export const OFFLINE: NetworkState = { connected: false, type: 'none' };

export interface FakeNetwork extends NetworkSource {
    /** NetInfo reports `state`. */
    set(state: NetworkState): void;
    readonly listeners: number;
}

export function fakeNetwork(initial: NetworkState = WIFI): FakeNetwork {
    let state = initial;
    const listeners = new Set<(state: NetworkState) => void>();
    return {
        current: async () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set(next) {
            state = next;
            for (const listener of [...listeners]) {
                listener(next);
            }
        },
        get listeners() {
            return listeners.size;
        },
    };
}

/** One pull a fake source was asked for. */
export interface FakePull {
    readonly cursor: string | null;
    /** When it started (the timers' clock). */
    readonly at: number;
}

export interface FakeSource extends SyncSource {
    readonly pulls: FakePull[];
    /** The most pulls in flight at once. */
    readonly maxInFlight: number;
    /** Holds every pull from now on until `release`, or answers at once (the default). */
    hold(on: boolean): void;
    /** Lets the oldest held pull go, with `answer` (an error rejects it). */
    release(answer?: Partial<PullResult> | Error): void;
    readonly held: number;
    /** Every pull from now on fails with what `fail` gives, or answers again (null). */
    failWith(fail: (() => unknown) | null): void;
    setStale(stale: boolean): void;
}

const TAG = 'W/"v1.b1"';

/** A 200 for a pull with no tag (a full poll), else a 304, unless the answer says otherwise. */
const answerFor = (cursor: string | null, answer: Partial<PullResult> = {}): PullResult => ({
    outcome: cursor === null ? 'changed' : 'not-modified',
    upserts: [],
    removes: [],
    cursor: TAG,
    ...answer,
});

export function fakeSource(id: string): FakeSource {
    const pulls: FakePull[] = [];
    const held: { cursor: string | null; resolve: (result: PullResult) => void; reject: (error: unknown) => void }[] =
        [];
    let holding = false;
    let fail: (() => unknown) | null = null;
    let tag: string | null = null;
    let stale = false;
    let inFlight = 0;
    let maxInFlight = 0;
    return {
        id,
        cursor: () => tag,
        stale: () => stale,
        async pull(_scope, cursor) {
            pulls.push({ cursor, at: Date.now() });
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                if (holding) {
                    const result = await new Promise<PullResult>((resolve, reject) => {
                        held.push({ cursor, resolve, reject });
                    });
                    tag = result.cursor;
                    return result;
                }
                if (fail !== null) {
                    throw fail();
                }
                const result = answerFor(cursor);
                tag = result.cursor;
                stale = false;
                return result;
            } finally {
                inFlight -= 1;
            }
        },
        pulls,
        get maxInFlight() {
            return maxInFlight;
        },
        hold(on) {
            holding = on;
        },
        release(answer) {
            const next = held.shift();
            if (next === undefined) {
                throw new Error(`${id} holds no pull.`);
            }
            if (answer instanceof Error) {
                next.reject(answer);
            } else {
                next.resolve(answerFor(next.cursor, answer));
            }
        },
        get held() {
            return held.length;
        },
        failWith(next) {
            fail = next;
        },
        setStale(next) {
            stale = next;
        },
    };
}
