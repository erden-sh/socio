import { getPermissionsAsync, type NotificationPermissionsStatus, requestPermissionsAsync } from 'expo-notifications';
import { useSyncExternalStore } from 'react';

import type { Store } from '../data';
import {
    type AskDecision,
    type AskTrigger,
    createNotificationAsk,
    type NotificationAsk,
    type NotificationAskState,
    type PhonePermission,
} from '../push';

import { appState } from './app-state';
import { native, pushPermissionGranted } from './push';

// The notification ask on the phone (src/push/permission-ask.ts):
// expo-notifications' permission and system prompt, socio-push's `canRegister`
// (false in a Personal Team build), the registry's Not now, and AppState. Launch
// starts it with the store (device-store.ts), knowing whether this is the
// launch that made the store; it reads the permission again on each return to
// the foreground, since the person may change it in the phone's Settings.
// Triggers call `askForNotifications` (a room: the first room message whose
// turn is still running; a room invite accepted); the shell's tabs show the
// explanation (screens/notification-ask.tsx) while one is up.

let ask: NotificationAsk | null = null;
const listeners = new Set<() => void>();
const NOT_STARTED: NotificationAskState = { availability: 'unknown', permission: null, showing: null };

const warn = (error: unknown) => console.warn('[notifications]', error);

function phonePermission({ granted, status, canAskAgain }: NotificationPermissionsStatus): PhonePermission {
    return {
        status: granted ? 'granted' : status === 'denied' ? 'denied' : 'undetermined',
        canAskAgain,
    };
}

/** Starts the ask on the store launch opened. `firstLaunch`: this launch made the store. */
export function startNotificationAsk(store: Store, firstLaunch: boolean): void {
    if (ask !== null) {
        return;
    }
    const started = createNotificationAsk({
        registry: store.registry,
        permission: async () => phonePermission(await getPermissionsAsync()),
        requestPermission: async () => phonePermission(await requestPermissionsAsync()),
        canRegister: () => native.canRegister(),
        foreground: () => appState.current() === 'active',
        firstLaunch,
        now: Date.now,
        onGranted: pushPermissionGranted,
        onError: warn,
    });
    ask = started;
    started.subscribe(() => {
        for (const listener of [...listeners]) {
            listener();
        }
    });
    let last = appState.current();
    appState.subscribe((next) => {
        if (next === 'active' && last !== 'active') {
            void started.refresh();
        }
        last = next;
    });
    void started.refresh();
}

/** A trigger (a room's turn, a room invite): shows the explanation when the rules say so. */
export function askForNotifications(trigger: AskTrigger): Promise<AskDecision> {
    return ask === null ? Promise.resolve({ kind: 'skip', reason: 'unknown' }) : ask.request(trigger);
}

/** The explanation's Allow, Not now, and Settings' "Turn on notifications". */
export const notificationAsk = {
    allow: () => void ask?.allow(),
    notNow: () => void ask?.notNow(),
    turnOn: () => void ask?.turnOn(),
};

/** Where notifications stand: the build, the permission and the explanation up. */
export function useNotificationAsk(): NotificationAskState {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        () => ask?.get() ?? NOT_STARTED,
    );
}
