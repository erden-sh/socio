// What the scheduler hears from the phone:
// the app's state and the network's. src/sync loads no React Native, so the
// platform injects both (src/platform/app-state.ts binds AppState,
// src/platform/network.ts binds NetInfo), and the tests hand in fakes.
//
// Based on T3 Code (https://github.com/pingdotgg/t3code) at commit 240446e2d9,
// Copyright (c) 2026 T3 Tools Inc., MIT (THIRD_PARTY_NOTICES, entry 12):
// - `isForeground` is isAppForeground of apps/mobile/src/lib/appState.ts:
//   anything but 'background' is the foreground, so 'inactive' (Control
//   Center, the app switcher, a system prompt) counts;
// - `returnsFromBackground` is mobileApplicationActiveWakeup of
//   apps/mobile/src/connection/app-state-wakeups.ts: back after less than
//   10 s in the background (MOBILE_LONG_BACKGROUND_AFTER_MS) is a probe, not a
//   return, which is how an Android picker or share sheet, which sends the app
//   to the background, doesn't count as leaving;
// - `createNetworkWatch` is networkPathChanges of
//   apps/mobile/src/connection/platform.ts: the type is seeded from the
//   current state, since a listener may report only changes, and a change of
//   type while connected is a trigger, which online/offline misses (Wi-Fi to
//   cellular). Changed here: one watch also reports the network coming back
//   and going, which T3 Code reads from its connectivity stream, and NetInfo's
//   state comes in as `NetworkState`.

/** React Native's AppState: 'active', 'inactive', 'background', or what a platform adds ('unknown', 'extension'). */
export type AppStateStatus = string;

/** The app's state, as the platform hands it to src/sync. */
export interface AppStateSource {
    /** The state now (AppState.currentState). */
    current(): AppStateStatus;
    /** Calls `listener` with each new state. Returns the unsubscribe. */
    subscribe(listener: (state: AppStateStatus) => void): () => void;
}

/** The network as NetInfo reports it. */
export interface NetworkState {
    /** Whether the phone has a network link: null while NetInfo doesn't know yet. */
    readonly connected: boolean | null;
    /** NetInfo's type: 'wifi', 'cellular', 'none', 'unknown', … */
    readonly type: string;
}

/** The network, as the platform hands it to src/sync. */
export interface NetworkSource {
    /** The state now (NetInfo.fetch). */
    current(): Promise<NetworkState>;
    /** Calls `listener` with each state NetInfo reports. Returns the unsubscribe. */
    subscribe(listener: (state: NetworkState) => void): () => void;
}

/** How long in the background makes coming back a return, not a picker or a share sheet. */
export const LONG_BACKGROUND_MS = 10_000;

/** Whether the app is in the foreground in `state`: 'inactive' counts. */
export const isForeground = (state: AppStateStatus): boolean => state !== 'background';

/**
 * Whether coming to the foreground at `activeAt`, having gone to the
 * background at `backgroundedAt` (null: it never did), is a return, as
 * opposed to a brief leave such as a picker.
 */
export function returnsFromBackground(backgroundedAt: number | null, activeAt: number): boolean {
    return backgroundedAt !== null && activeAt - backgroundedAt >= LONG_BACKGROUND_MS;
}

/** What one network report changed: `back` (offline to online), `changed` (another type, online), `lost`. */
export type NetworkChange = 'back' | 'changed' | 'lost';

export interface NetworkWatch {
    /** The change `state` makes, if any, and keeps it as the last known state. */
    report(state: NetworkState): NetworkChange | null;
    /** Takes `state` as the last known one if nothing has been reported yet: the seed. */
    seed(state: NetworkState): void;
}

/**
 * Follows the network's reports. A state NetInfo doesn't know yet
 * (`connected: null`) changes nothing and is not kept; the first known state
 * is a seed, not a change.
 */
export function createNetworkWatch(): NetworkWatch {
    let previous: NetworkState | null = null;
    return {
        report(state) {
            if (state.connected === null) {
                return null;
            }
            const before = previous;
            previous = state;
            if (before === null) {
                return null;
            }
            if (!state.connected) {
                return before.connected ? 'lost' : null;
            }
            if (!before.connected) {
                return 'back';
            }
            return state.type !== before.type ? 'changed' : null;
        },
        seed(state) {
            if (previous === null && state.connected !== null) {
                previous = state;
            }
        },
    };
}
