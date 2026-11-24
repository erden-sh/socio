import { Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { excludeFromBackup, whenProtectedDataAvailable } from '../../modules/socio-device';
import { madeStore } from '../data';
import { rootState } from '../navigation/root-gate';

import { followRootGate } from './active-scope';
import { forgetAppSnapshots } from './app-snapshots';
import { buildNotice, INSTALLED_BUILD } from './build-info';
import { markStoreOpened } from './cold-start';
import { randomBytes } from './crypto';
import { deviceSettings } from './device-settings';
import { createExpoFileSystem } from './file-system';
import { type Launched, type LaunchDeps, openDeviceStore } from './launch';
import { startNotificationAsk } from './notification-ask';
import { startPush, storePush } from './push';
import { startPushTaps } from './push-taps';
import { createSecureKeyStore } from './secure-store';
import { startLeases } from './session';
import { startRevocations } from './sign-out';
import { createExpoSqliteDriver } from './sqlite';

// The store on this phone: the platform's bindings handed to launch.ts, and
// where the app learns how the launch went. The root (src/app.tsx) starts it
// at import, before the first frame, and draws the root stack once it is open,
// the root gate has the registry's state and the active workspace's scope has
// opened (active-scope.ts); Diagnostics (development and
// preview) reads the opened store from here.

export type LaunchStatus =
    | { readonly kind: 'opening' }
    | { readonly kind: 'open'; readonly launched: Launched }
    | { readonly kind: 'failed'; readonly error: unknown };

/** The bindings: expo-sqlite, expo-file-system, expo-secure-store, socio-device. */
function deviceDeps(): LaunchDeps {
    const fs = createExpoFileSystem();
    return {
        root: Paths.document.uri,
        driver: createExpoSqliteDriver({ files: fs }),
        fs,
        keyStore: createSecureKeyStore(),
        randomBytes,
        excludeFromBackup,
        whenProtectedDataAvailable: Platform.OS === 'ios' ? whenProtectedDataAvailable : null,
        clock: () => performance.now(),
        push: storePush,
        // Every wipe (sign-out, the lease, another person, ...): iOS's app-switcher snapshots go too (CB-356).
        wiped: () => void forgetAppSnapshots('wipe'),
    };
}

let status: LaunchStatus = { kind: 'opening' };
let running = false;
const listeners = new Set<() => void>();

function settle(next: LaunchStatus) {
    status = next;
    for (const listener of [...listeners]) {
        listener();
    }
}

/** Opens the store, unless it is open or opening. After a failure it tries again (the launch screen's Try again). */
export function startLaunch(): void {
    if (running || status.kind === 'open') {
        return;
    }
    running = true;
    if (status.kind === 'failed') {
        settle({ kind: 'opening' });
    }
    openDeviceStore(deviceDeps())
        .then(async (launched) => {
            markStoreOpened(launched.openMs);
            // The lease first, so a copy past its 30 days opens on the lock screen (session.ts).
            await startLeases(launched.opened.store);
            await rootState.load(launched.opened.store.registry);
            // Advanced mode and haptics, before any screen draws with them.
            await deviceSettings.load(launched.opened.store.registry);
            // Whether this build differs from the one the app last ran: never awaited, so it holds
            // nothing up, and it only touches the registry's settings row (src/shell/build-info.ts).
            void buildNotice.check(launched.opened.store.registry, INSTALLED_BUILD);
            // The active workspace's scope opens before the first frame, filled from cache.db.
            await followRootGate(launched.opened.store);
            // Logouts that got no answer go again, after the first frame's work (sign-out.ts).
            startRevocations(launched.opened.store);
            // Push: the keepalive and the open workspace's subscription, after the first frame's work.
            startPush(launched.opened.store);
            // Notification taps (a cold start's once), the foreground and the inbox files.
            startPushTaps(launched.opened.store);
            // The notification ask: never on the launch that made the store, whichever cell made it.
            startNotificationAsk(launched.opened.store, madeStore(launched.opened.launch.cell));
            settle({ kind: 'open', launched });
        })
        .catch((error: unknown) => {
            console.warn('[store] the store did not open', error);
            settle({ kind: 'failed', error });
        })
        .finally(() => {
            running = false;
        });
}

/** The launch's state and its changes, in useSyncExternalStore's shape. */
export const launchStatus = {
    get: (): LaunchStatus => status,
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** The opened store and the launch's timings, or null while it isn't open. */
export function launchedStore(): Launched | null {
    return status.kind === 'open' ? status.launched : null;
}
