import { beforeEach, describe, expect, it, vi } from 'vitest';

// Based on T3 Code's apps/mobile/src/lib/protectedData.test.ts
// (https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
// root): its scenarios and mocks, for whenProtectedDataAvailable against a fake
// AppState and a fake SocioDevice module.
const mocks = vi.hoisted(() => {
    type Change = (event: { available: boolean }) => void;
    return {
        appState: 'background' as string | null,
        appStateListeners: new Set<(state: string) => void>(),
        protectedDataListeners: new Set<Change>(),
        isProtectedDataAvailable: vi.fn<() => Promise<boolean>>(),
        moduleMissing: false,
        calls: [] as string[],
    };
});

vi.mock('react-native', () => ({
    AppState: {
        get currentState() {
            return mocks.appState;
        },
        addEventListener: (_type: string, listener: (state: string) => void) => {
            mocks.appStateListeners.add(listener);
            return { remove: () => mocks.appStateListeners.delete(listener) };
        },
    },
}));

vi.mock('expo', () => ({
    requireNativeModule: () => {
        if (mocks.moduleMissing) {
            throw new Error("Cannot find native module 'SocioDevice'");
        }
        return {
            isProtectedDataAvailable: mocks.isProtectedDataAvailable,
            addListener: (_event: string, listener: (event: { available: boolean }) => void) => {
                mocks.calls.push('addListener');
                mocks.protectedDataListeners.add(listener);
                return { remove: () => mocks.protectedDataListeners.delete(listener) };
            },
        };
    },
}));

const load = async () => (await import('../../modules/socio-device')).whenProtectedDataAvailable;

const setAppState = (state: string) => {
    mocks.appState = state;
    for (const listener of mocks.appStateListeners) {
        listener(state);
    }
};

const protectedData = (available: boolean) => {
    for (const listener of mocks.protectedDataListeners) {
        listener({ available });
    }
};

/** Whether the promise has settled once pending callbacks have run. */
const settled = async (promise: Promise<void>) => {
    let done = false;
    void promise.then(() => {
        done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
};

const expectNoListeners = () => {
    expect(mocks.appStateListeners.size).toBe(0);
    expect(mocks.protectedDataListeners.size).toBe(0);
};

beforeEach(() => {
    vi.resetModules();
    mocks.appState = 'background';
    mocks.appStateListeners.clear();
    mocks.protectedDataListeners.clear();
    mocks.isProtectedDataAvailable.mockReset().mockImplementation(async () => {
        mocks.calls.push('isProtectedDataAvailable');
        return false;
    });
    mocks.moduleMissing = false;
    mocks.calls = [];
});

describe('waiting for protected data', () => {
    it('goes on at once in an active app, without asking the native side', async () => {
        mocks.appState = 'active';
        const whenProtectedDataAvailable = await load();
        expect(await settled(whenProtectedDataAvailable())).toBe(true);
        expect(mocks.isProtectedDataAvailable).not.toHaveBeenCalled();
        expectNoListeners();
    });

    it('holds a locked background launch until iOS reports protected data, then lets go of its listeners', async () => {
        const whenProtectedDataAvailable = await load();
        const wait = whenProtectedDataAvailable();
        // Subscribed first: the Swift side observes from addListener on, so an
        // unlock after the check has read false still arrives.
        expect(mocks.calls).toEqual(['addListener', 'isProtectedDataAvailable']);
        expect(await settled(wait)).toBe(false);
        protectedData(false);
        setAppState('inactive');
        expect(await settled(wait)).toBe(false);
        protectedData(true);
        expect(await settled(wait)).toBe(true);
        expectNoListeners();
    });

    it('goes on when the check finds protected data already available', async () => {
        mocks.isProtectedDataAvailable.mockResolvedValue(true);
        const whenProtectedDataAvailable = await load();
        expect(await settled(whenProtectedDataAvailable())).toBe(true);
        expectNoListeners();
    });

    it.each([
        { case: 'a failed native check', state: 'background', fails: true, missing: false },
        { case: 'no native module, and no app state yet', state: null, fails: false, missing: true },
    ])('with $case, still goes on once the app is active', async ({ state, fails, missing }) => {
        mocks.appState = state;
        mocks.moduleMissing = missing;
        if (fails) {
            mocks.isProtectedDataAvailable.mockRejectedValue(new Error('Protected data check unavailable.'));
        }
        const whenProtectedDataAvailable = await load();
        const wait = whenProtectedDataAvailable();
        expect(await settled(wait)).toBe(false);
        setAppState('inactive');
        expect(await settled(wait)).toBe(false);
        setAppState('active');
        expect(await settled(wait)).toBe(true);
        expectNoListeners();
    });

    it('answers once per launch, since after-first-unlock items stay readable until a restart', async () => {
        const whenProtectedDataAvailable = await load();
        const first = whenProtectedDataAvailable();
        expect(whenProtectedDataAvailable()).toBe(first);
        protectedData(true);
        await first;
        protectedData(false);
        setAppState('background');
        expect(await settled(whenProtectedDataAvailable())).toBe(true);
        expect(mocks.isProtectedDataAvailable).toHaveBeenCalledOnce();
    });
});
