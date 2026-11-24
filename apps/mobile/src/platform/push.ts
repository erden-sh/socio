import { requireOptionalNativeModule } from 'expo';
import Constants from 'expo-constants';
import {
    addPushTokenListener,
    getDevicePushTokenAsync,
    getPermissionsAsync,
    setBadgeCountAsync,
} from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { apnsEnvironment } from '../../aps-environment';
import {
    createKeys,
    deleteKeys,
    deleteRegistration,
    getKeys,
    pushStorage,
    setLeaseLockAt,
    setLocked,
    setRegistration,
    setShowText,
} from '../../modules/socio-push';
import { embeddedRelayOrigin } from '../../relay-origin';
import { VARIANTS } from '../../variant';
import type { Store, StorePush } from '../data';
import type { PushRow } from '../data/registry';
import { rootState } from '../navigation/root-gate';
import { createRelayFetch } from '../net/relay-fetch';
import {
    createPushManager,
    createRelayClient,
    createShowTextSetting,
    followBadge,
    type PushApp,
    type PushNative,
    type PushNotifications,
    type PushRefresh,
    type PushScope,
    type PushStatus,
    type RelayClient,
    retryPushRevocations,
} from '../push';

import { activeScope, contactMoved } from './active-scope';
import { appState } from './app-state';
import { randomBytes } from './crypto';
import { appFetch } from './fetch';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// Push on the phone (src/push/subscription.ts): expo-notifications,
// socio-push and the relay client bound for the push manager, which follows
// the app. Launch starts it after the first scope opened (device-store.ts),
// never before the first frame:
// - at launch and each return to the foreground: the keepalive (the native
//   token, the daily refresh, a permission taken back), the open workspace's
//   check (daily), and the flags;
// - as each workspace's scope opens: its subscription, checked at once;
// - a lock or unlock (the root gate) and each kept contact: the flags;
// - a native token that changes while the app runs: the keepalive, with the
//   event's token (never asked for again: asking fires the event).
// - the app icon's badge: 0 whenever no workspace's scope is open;
// - every wipe (`storePush`): the workspace's push keys go, and its
//   registration's revocation record is tried at once, then at launch and on
//   each return to the foreground, until the relay answers.
// The relay's origin is the build's (`extra.relayOrigin`, relay-origin.ts);
// without one nothing registers. A registration made at another relay, by an
// earlier build, is deleted there: only an origin this variant could
// have been built with (`relayAt`), recorded beside the registration, never one
// from a setting or a server. Only `getDevicePushTokenAsync`: never Expo's
// push service.

const RELAY_ORIGIN = embeddedRelayOrigin(Constants.expoConfig?.extra?.relayOrigin, BUILD_VARIANT);

const APP: PushApp = {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    // The variant's own id: a Personal Team build's isn't one, and it never registers.
    bundleId: VARIANTS[BUILD_VARIANT].id,
    // The build's aps-environment (`extra.apsEnvironment`, aps-environment.ts): a development-signed
    // build's tokens are APNs sandbox tokens, whatever its variant.
    apnsEnv: Platform.OS !== 'ios' ? null : apnsEnvironment(Constants.expoConfig?.extra?.apsEnvironment, BUILD_VARIANT),
};

/** A relay client for `origin`, which must be one this variant takes as SOCIO_RELAY_ORIGIN. */
function relayClient(origin: string): RelayClient | null {
    return embeddedRelayOrigin(origin, BUILD_VARIANT) !== origin
        ? null
        : createRelayClient(createRelayFetch({ fetch: appFetch, userAgent: APP_USER_AGENT, origin }), origin);
}

const RELAY = RELAY_ORIGIN === null ? null : relayClient(RELAY_ORIGIN);

const otherRelays = new Map<string, RelayClient | null>();

/**
 * The relay at an origin an earlier build registered with, to delete
 * that registration there; null for one this variant can't have had.
 */
function relayAt(origin: string): RelayClient | null {
    if (origin === RELAY_ORIGIN) {
        return RELAY;
    }
    if (!otherRelays.has(origin)) {
        otherRelays.set(origin, relayClient(origin));
    }
    return otherRelays.get(origin) ?? null;
}

/** A revocation record's relay: its own origin's, the build's for one kept before records held it. */
const revocationRelay = (origin: string | null) => (origin === null ? RELAY : relayAt(origin));

const notifications: PushNotifications = {
    async permission() {
        const { granted, status } = await getPermissionsAsync();
        return granted ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
    },
    async nativeToken() {
        const { data } = await getDevicePushTokenAsync();
        if (typeof data !== 'string' || data === '') {
            throw new Error('The phone gave no push token.');
        }
        return data;
    },
};

/** socio-push as the manager takes it; `canRegister` also tells the notification ask whether this build can have notifications. */
export const native: PushNative = {
    canRegister: async () => (await pushStorage()).shared,
    getKeys,
    createKeys,
    // Nothing in a development client built before the module: it made no keys.
    deleteKeys: async (workspaceId) => {
        if (requireOptionalNativeModule('SocioPush') !== null) {
            await deleteKeys(workspaceId);
        }
    },
    setRegistration,
    deleteRegistration,
    setLocked,
    setLeaseLockAt,
    setShowText,
};

const warn = (error: unknown) => console.warn('[push]', error);

/**
 * "Show message text in notifications" (src/push/show-text.ts): loaded
 * as push starts, handed to the native side after each change.
 */
export const showText = createShowTextSetting(async () => {
    if (manager !== null) {
        await manager.syncShowText();
    }
});

/** The show-text setting, null until push has started. */
export function useShowText(): boolean | null {
    return useSyncExternalStore(showText.subscribe, showText.get);
}

let opened: Store | null = null;
let manager: ReturnType<typeof createPushManager> | null = null;
let recheck: (() => void) | null = null;

/** Permission was just granted: the keepalive and the open workspace's subscription, at once. */
export function pushPermissionGranted(): void {
    recheck?.();
}

/** The open workspace's scope as the manager takes it, or null. */
function openScope(): PushScope | null {
    const state = activeScope.get();
    if (state.kind !== 'open') {
        return null;
    }
    const { scope } = state;
    return { workspaceId: scope.workspace.id, name: scope.workspace.name, fetch: scope.fetch };
}

let revoking = false;
let revokeAgain = false;

/** Tries the push revocation records once (src/push/revocation.ts); one try at a time, another after it when asked meanwhile. */
function revokePush(): void {
    if (opened === null) {
        return;
    }
    if (revoking) {
        revokeAgain = true;
        return;
    }
    revoking = true;
    void retryPushRevocations(opened.keys, revocationRelay)
        .catch(warn)
        .finally(() => {
            revoking = false;
            if (revokeAgain) {
                revokeAgain = false;
                revokePush();
            }
        });
}

/**
 * The native side of push as every wipe uses it (wipe.ts' step 1a): once push
 * runs, the manager's `forgetWorkspace`, which waits for a run still going (an
 * ensure waiting on the relay, 10 s at most) before socio-push's `deleteKeys`; before that,
 * `deleteKeys` alone. Then the revocation record is tried at once.
 */
export const storePush: StorePush = {
    deleteKeys: (workspaceId) =>
        manager === null ? native.deleteKeys(workspaceId) : manager.forgetWorkspace(workspaceId),
    recorded: revokePush,
};

/** Starts push on the store launch opened (device-store.ts). Never rejects. */
export function startPush(launched: Store): void {
    if (opened !== null) {
        return;
    }
    opened = launched;
    const push = createPushManager({
        store: launched,
        native,
        notifications,
        relay: RELAY,
        relayOrigin: RELAY_ORIGIN,
        relayAt,
        app: APP,
        randomBytes,
        now: Date.now,
        onError: warn,
    });
    manager = push;
    for (const listener of [...listeners]) {
        listener();
    }
    push.subscribe(() => {
        for (const listener of [...listeners]) {
            listener();
        }
    });

    const check = (force: boolean) => {
        const open = openScope();
        void push
            .keepalive(open)
            .then(() => (open === null ? undefined : push.ensure(open, { force })))
            .then(() => push.syncFlags())
            .catch(warn);
    };

    recheck = () => check(true);

    let lastScope: string | null = null;
    activeScope.subscribe(() => {
        const state = activeScope.get();
        const id = state.kind === 'open' ? state.scope.id : null;
        if (id !== null && id !== lastScope) {
            const open = openScope();
            if (open !== null) {
                void push.ensure(open, { force: true }).catch(warn);
            }
        }
        lastScope = id;
    });
    let last = appState.current();
    appState.subscribe((next) => {
        if (next === 'active' && last !== 'active') {
            revokePush();
            check(false);
        }
        last = next;
    });
    rootState.subscribe(() => void push.syncFlags().catch(warn));
    contactMoved.add(() => void push.syncFlags().catch(warn));
    // expo-notifications fires this on every getDevicePushTokenAsync as well, so the
    // event's token goes in and the manager skips the one it already has.
    addPushTokenListener(({ data }) => {
        if (typeof data === 'string') {
            void push.keepalive(openScope(), { token: data }).catch(warn);
        }
    });

    // No workspace open (the last one removed, the lock screen): no badge.
    followBadge(activeScope, setPushBadge);
    // Records a launch's wipes kept, or a run before this one left.
    revokePush();
    void showText
        .load(launched.registry)
        .then(() => push.syncShowText())
        .catch(warn);
    const state = activeScope.get();
    lastScope = state.kind === 'open' ? state.scope.id : null;
    check(true);
}

/** Sets the app icon's badge (src/push/badge.ts); a phone that doesn't allow it shows none. */
export function setPushBadge(count: number): void {
    setBadgeCountAsync(count).catch(() => {});
}

const listeners = new Set<() => void>();
const UNKNOWN: PushStatus = { kind: 'unknown' };

/** Where workspace `id`'s push stands, for Technical details. */
export function usePushStatus(id: string): PushStatus {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => manager?.status(id) ?? UNKNOWN,
    );
}

/** The last keepalive of workspace `id` and its answer, for Technical details. */
export function usePushRefresh(id: string): PushRefresh | null {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => manager?.lastRefresh(id) ?? null,
    );
}

/** Workspace `id`'s push registration as the registry keeps it, or null before push started or with none. */
export async function pushRegistration(id: string): Promise<PushRow | null> {
    return opened === null ? null : opened.registry.push(id);
}
