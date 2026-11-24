import { requireOptionalNativeModule } from 'expo';
import {
    addNotificationReceivedListener,
    addNotificationResponseReceivedListener,
    clearLastNotificationResponse,
    DEFAULT_ACTION_IDENTIFIER,
    getLastNotificationResponse,
    type NotificationResponse,
    setNotificationHandler,
} from 'expo-notifications';
import { Platform } from 'react-native';

import { addTapListener, deleteInbox, readInbox, setScreen, takeLaunchTap } from '../../modules/socio-push';
import type { Store } from '../data';
import { screenPath } from '../navigation/presence-path';
import { rootState } from '../navigation/root-gate';
import {
    applyInboxPulls,
    chatOnScreen,
    createInboxDrain,
    createPushTaps,
    followLaunchTaps,
    isOnScreen,
    notificationTarget,
    type PushTarget,
} from '../push';
import { workspaceName } from '../shell/account';
import { ROOM_INVITES_SNAPSHOT } from '../sync/room-invites';

import { activeScope, switchTo } from './active-scope';
import { appState } from './app-state';

// Notification taps, the foreground and the inbox files on the phone
// (src/push/taps.ts and inbox.ts):
// - iOS: expo-notifications' response (the tap that launched the app once,
//   through `getLastNotificationResponse`, then the listener), its target in
//   `userInfo.socio`, which the extension writes; its foreground handler
//   hides a notification for the chat on screen and shows the rest.
// - Android: socio-push's tap (`takeLaunchTap` at start and on each return to
//   'active', then `onTap`), the messaging service's target under its token;
//   the service hides the chat on screen itself, told which it is through
//   `setScreen`.
// - Both: the inbox files are read once launch has opened the first scope, on
//   each return, as another workspace's scope opens, and (iOS) as a
//   notification comes while the app is in front.
// Launch starts it after push (device-store.ts); src/app.tsx hands in how a
// path opens (links.ts) at import, before any tap can come.

const warn = (error: unknown) => console.warn('[push taps]', error);

/** How long the tap's notice shows. */
export const TAP_NOTICE_MS = 4_000;

let notice: { readonly id: number; readonly text: string } | null = null;
let noticeIds = 0;
const noticeListeners = new Set<() => void>();
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function setNotice(next: typeof notice) {
    notice = next;
    for (const listener of [...noticeListeners]) {
        listener();
    }
}

/** "Switched to Acme", or why a tap opened nothing: over every screen for a few seconds (screens/tap-notice.tsx). */
export const tapNotice = {
    get: () => notice,
    subscribe(listener: () => void) {
        noticeListeners.add(listener);
        return () => {
            noticeListeners.delete(listener);
        };
    },
    say(text: string) {
        clearTimeout(noticeTimer);
        noticeIds += 1;
        setNotice({ id: noticeIds, text });
        noticeTimer = setTimeout(() => setNotice(null), TAP_NOTICE_MS);
    },
    dismiss() {
        clearTimeout(noticeTimer);
        setNotice(null);
    },
};

let opener: ((path: string) => void) | null = null;
const waitingPaths: string[] = [];

/** How an app path opens (links.ts' `open`), handed in by src/app.tsx. */
export function setTapOpener(open: (path: string) => void): void {
    opener = open;
    for (const path of waitingPaths.splice(0)) {
        open(path);
    }
}

const openPath = (path: string) => {
    if (opener === null) {
        waitingPaths.splice(0, waitingPaths.length, path);
    } else {
        opener(path);
    }
};

/** The open workspace's id, or null. */
function openWorkspace(): string | null {
    const state = activeScope.get();
    return state.kind === 'open' ? state.scope.workspace.id : null;
}

/** The chat on screen in the open workspace, or null. */
const shownChat = () => chatOnScreen(openWorkspace(), screenPath.get());

const hasSocioPush = () => requireOptionalNativeModule('SocioPush') !== null;

// iOS's foreground: the chat on screen's notification is hidden; the rest show,
// with no badge from the push (the app sets its own, src/push/badge.ts). Set at
// import, before any notification can come.
if (Platform.OS === 'ios') {
    setNotificationHandler({
        handleNotification: async (notification) => {
            const show = !isOnScreen(notificationTarget(notification.request), shownChat());
            return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
        },
    });
}

let started = false;

/** Starts taps and the inbox on the store launch opened. Never throws. */
export function startPushTaps(store: Store): void {
    if (started) {
        return;
    }
    started = true;

    const taps = createPushTaps({
        active: () => rootState.get().active?.id ?? null,
        workspace: async (id) => {
            const row = await store.registry.get(id);
            return row === null || row.state !== 'ready' ? null : { name: workspaceName(null, row) };
        },
        switchTo,
        open: openPath,
        say: tapNotice.say,
        generic: () => {
            const state = activeScope.get();
            if (state.kind === 'open') {
                state.scope.scheduler.poke();
            }
        },
        onError: warn,
    });

    const inbox = createInboxDrain({
        read: async () => (hasSocioPush() ? readInbox() : { entries: [], unreadable: [] }),
        remove: (ids) => deleteInbox(ids),
        open: openWorkspace,
        known: async (id) => (await store.registry.get(id)) !== null,
        pull: (workspaceId, pulls) => {
            const state = activeScope.get();
            if (state.kind === 'open' && state.scope.workspace.id === workspaceId) {
                applyInboxPulls(state.scope, pulls, ROOM_INVITES_SNAPSHOT.id, warn);
            }
        },
        onError: warn,
    });

    if (Platform.OS === 'ios') {
        const respond = (response: NotificationResponse | null) => {
            if (response === null || response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) {
                return;
            }
            const { request } = response.notification;
            void taps.tap(notificationTarget(request), request.identifier);
        };
        // The tap that launched the app, once: cleared, so a remount or a reload doesn't take it again.
        const launch = getLastNotificationResponse();
        if (launch !== null) {
            clearLastNotificationResponse();
            respond(launch);
        }
        addNotificationResponseReceivedListener(respond);
        addNotificationReceivedListener(() => void inbox.drain());
    } else if (hasSocioPush()) {
        const tapped = (tap: PushTarget) => void taps.tap(tap);
        addTapListener(tapped);
        // The launch's tap, then one on the intent at each return (a recreated activity, a tap before the listener).
        followLaunchTaps({ take: takeLaunchTap, tapped, appState, onError: warn });
        // The service holds back a push for the chat on screen while the app is resumed.
        let told: string | null = null;
        const tell = () => {
            const screen = shownChat();
            const key = screen === null ? null : `${screen.workspaceId}\n${screen.path}`;
            if (key !== told) {
                told = key;
                setScreen(screen?.workspaceId ?? null, screen?.path ?? null);
            }
        };
        screenPath.subscribe(tell);
        activeScope.subscribe(tell);
        tell();
    }

    let last = appState.current();
    appState.subscribe((next) => {
        if (next === 'active' && last !== 'active') {
            void inbox.drain();
        }
        last = next;
    });
    let lastScope: string | null = openWorkspace();
    activeScope.subscribe(() => {
        const id = openWorkspace();
        if (id !== null && id !== lastScope) {
            void inbox.drain();
        }
        lastScope = id;
    });
    void inbox.drain();
}
