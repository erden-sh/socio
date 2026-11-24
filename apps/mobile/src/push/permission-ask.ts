import type { Registry } from '../data/registry';

import type { PushPermission } from './subscription';

// Asking for notifications, under Node, with expo-notifications, socio-push
// and the app's state handed in by src/platform/notification-ask.ts:
//
// - **Never at first launch** (the launch that made the store), never in the
//   background, and only while the phone can still show its own prompt
//   (`undetermined`). Android answers "denied" before any prompt (POST_NOTIFICATIONS
//   isn't granted yet), so a "denied" that can still ask, on a phone the app
//   never prompted (migration 8's `askPromptedAt`), counts as `undetermined`
//   (`effectivePermission`).
// - **Two triggers for now:** the person's first room message whose turn is
//   still running (the room calls `request('room-turn')`), and accepting a
//   room invite (`request('invite')`). Approvals and private-chat replies
//   aren't pushed yet, so they don't ask.
// - **The explanation first,** with Allow and Not now; the system prompt only
//   after Allow. Not now (or closing the explanation) is kept in the registry
//   (migration 8), and no trigger asks again for `NOT_NOW_MS`.
// - **Settings** says where notifications stand (`settingsRow`): "Turn on
//   notifications" before any ask (straight to the system prompt: the person
//   asked), a row to the phone's Settings once denied, and a line in a build
//   that can't have them (a Personal Team build: `canRegister` false), which
//   never asks.
// - The Inbox shows the denied row too (src/shell/inbox.ts).

/** The words of the explanation and of Settings' row: only what arrives today. */
export const ASK_TEXT = 'Get told when someone mentions you, a socio replies in a room, or a socio sends a report.';

export const ASK_COPY = {
    title: 'Turn on notifications?',
    body: ASK_TEXT,
    allow: 'Allow',
    notNow: 'Not now',
} as const;

/** How long Not now holds the ask back. */
export const NOT_NOW_MS = 30 * 24 * 60 * 60 * 1000;

/** What asks: the first room message whose turn is still running, a room invite accepted. */
export type AskTrigger = 'room-turn' | 'invite';

/** Whether this build can have notifications: not in a Personal Team build; `unknown` until checked. */
export type NotificationAvailability = 'unknown' | 'available' | 'build';

export interface AskInput {
    /** The launch made the store: any cell but `opened` (store.ts' `madeStore`). */
    readonly firstLaunch: boolean;
    /** The app is in front (AppState `active`). */
    readonly foreground: boolean;
    readonly availability: NotificationAvailability;
    readonly permission: PushPermission | null;
    /** When the person last said Not now, device clock; null before. */
    readonly declinedAt: number | null;
    /** The explanation is already up. */
    readonly showing: boolean;
    readonly now: number;
}

export type AskSkip =
    | 'first-launch'
    | 'background'
    | 'build'
    | 'unknown'
    | 'granted'
    | 'denied'
    | 'not-now'
    | 'showing';

export type AskDecision = { readonly kind: 'ask' } | { readonly kind: 'skip'; readonly reason: AskSkip };

const skip = (reason: AskSkip): AskDecision => ({ kind: 'skip', reason });

/** Whether a trigger shows the explanation now. */
export function askDecision(input: AskInput): AskDecision {
    if (input.availability === 'build') {
        return skip('build');
    }
    if (input.availability === 'unknown' || input.permission === null) {
        return skip('unknown');
    }
    if (input.permission === 'granted') {
        return skip('granted');
    }
    if (input.permission === 'denied') {
        return skip('denied');
    }
    if (input.firstLaunch) {
        return skip('first-launch');
    }
    if (!input.foreground) {
        return skip('background');
    }
    if (input.showing) {
        return skip('showing');
    }
    // A clock set back since Not now counts from now, never forever.
    if (input.declinedAt !== null && input.now >= input.declinedAt && input.now - input.declinedAt < NOT_NOW_MS) {
        return skip('not-now');
    }
    return { kind: 'ask' };
}

export const UNAVAILABLE = 'Notifications aren’t available in this build';
export const TURN_ON = 'Turn on notifications';
export const NOTIFICATIONS_OFF = 'Notifications are off';
export const NOTIFICATIONS_OFF_HINT = 'Turn them on in your phone’s Settings to hear from your socios.';

/** Settings' notifications row: what it says, and what a tap does. */
export type SettingsNotificationRow =
    | { readonly kind: 'unavailable'; readonly title: string; readonly testID: string }
    | { readonly kind: 'turn-on'; readonly title: string; readonly subtitle: string; readonly testID: string }
    | { readonly kind: 'denied'; readonly title: string; readonly subtitle: string; readonly testID: string };

/** Settings' row, or null while it isn't known yet or notifications are on. */
export function settingsRow(
    availability: NotificationAvailability,
    permission: PushPermission | null,
): SettingsNotificationRow | null {
    if (availability === 'build') {
        return { kind: 'unavailable', title: UNAVAILABLE, testID: 'settings-notifications-unavailable' };
    }
    if (availability === 'unknown' || permission === null || permission === 'granted') {
        return null;
    }
    return permission === 'denied'
        ? {
              kind: 'denied',
              title: NOTIFICATIONS_OFF,
              subtitle: NOTIFICATIONS_OFF_HINT,
              testID: 'settings-notifications-off',
          }
        : { kind: 'turn-on', title: TURN_ON, subtitle: ASK_TEXT, testID: 'settings-notifications-turn-on' };
}

/** The phone's notifications are denied for a build that could have them: the Inbox's row. */
export function notificationsDenied(state: Pick<NotificationAskState, 'availability' | 'permission'>): boolean {
    return state.availability === 'available' && state.permission === 'denied';
}

/** The phone's answer, as expo-notifications gives it. */
export interface PhonePermission {
    readonly status: PushPermission;
    /** The system may still show its prompt (expo-notifications' `canAskAgain`). */
    readonly canAskAgain: boolean;
}

/**
 * What the ask makes of the phone's answer: a "denied" the system can still ask
 * about, before this app ever showed the prompt, is Android's state before any
 * prompt, so `undetermined`.
 */
export function effectivePermission(phone: PhonePermission, promptedAt: number | null): PushPermission {
    return phone.status === 'denied' && phone.canAskAgain && promptedAt === null ? 'undetermined' : phone.status;
}

export interface NotificationAskState {
    readonly availability: NotificationAvailability;
    /** The phone's permission for the app, or null until read. */
    readonly permission: PushPermission | null;
    /** The trigger whose explanation is up, or null. */
    readonly showing: AskTrigger | null;
}

export interface NotificationAskDeps {
    readonly registry: Pick<Registry, 'pushDevice' | 'setPushDevice'>;
    /** expo-notifications' permission. */
    permission(): Promise<PhonePermission>;
    /** The system prompt; answers the permission after it. */
    requestPermission(): Promise<PhonePermission>;
    /** Whether the build can have notifications (socio-push: false in a Personal Team build). */
    canRegister(): Promise<boolean>;
    /** The app is in front. */
    foreground(): boolean;
    readonly firstLaunch: boolean;
    /** The device clock. */
    readonly now: () => number;
    /** Permission was just granted: the push manager subscribes the open workspace. */
    readonly onGranted?: () => void;
    readonly onError?: (error: unknown) => void;
}

export interface NotificationAsk {
    get(): NotificationAskState;
    subscribe(listener: () => void): () => void;
    /** Reads the build and the permission again (launch, each return to the foreground). Never rejects. */
    refresh(): Promise<void>;
    /** A trigger: shows the explanation when `askDecision` says so. Never rejects. */
    request(trigger: AskTrigger): Promise<AskDecision>;
    /** The explanation's Allow: the system prompt. Never rejects. */
    allow(): Promise<void>;
    /** The explanation's Not now, or closing it any other way. Never rejects. */
    notNow(): Promise<void>;
    /** Settings' "Turn on notifications": the system prompt, no explanation. Never rejects. */
    turnOn(): Promise<void>;
}

const INITIAL: NotificationAskState = { availability: 'unknown', permission: null, showing: null };

export function createNotificationAsk(deps: NotificationAskDeps): NotificationAsk {
    let state = INITIAL;
    const listeners = new Set<() => void>();
    const onError = deps.onError ?? (() => {});

    const set = (change: Partial<NotificationAskState>) => {
        const next = { ...state, ...change };
        if (
            next.availability === state.availability &&
            next.permission === state.permission &&
            next.showing === state.showing
        ) {
            return;
        }
        state = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const refresh = async () => {
        try {
            if (state.availability === 'unknown') {
                set({ availability: (await deps.canRegister()) ? 'available' : 'build' });
            }
            const phone = await deps.permission();
            const { askPromptedAt } = await deps.registry.pushDevice();
            set({ permission: effectivePermission(phone, askPromptedAt) });
        } catch (error) {
            onError(error);
        }
    };

    const prompt = async () => {
        try {
            // Kept first: after any prompt, the phone's "denied" means denied.
            await deps.registry.setPushDevice({ askPromptedAt: deps.now() });
            const answer = (await deps.requestPermission()).status;
            set({ permission: answer });
            if (answer === 'granted') {
                deps.onGranted?.();
            }
        } catch (error) {
            onError(error);
        }
    };

    return {
        get: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh,
        async request(trigger) {
            await refresh();
            let declinedAt: number | null = null;
            try {
                declinedAt = (await deps.registry.pushDevice()).askDeclinedAt;
            } catch (error) {
                onError(error);
                return skip('unknown');
            }
            const decision = askDecision({
                firstLaunch: deps.firstLaunch,
                foreground: deps.foreground(),
                availability: state.availability,
                permission: state.permission,
                declinedAt,
                showing: state.showing !== null,
                now: deps.now(),
            });
            if (decision.kind === 'ask') {
                set({ showing: trigger });
            }
            return decision;
        },
        async allow() {
            if (state.showing === null) {
                return;
            }
            set({ showing: null });
            if (state.permission === 'undetermined') {
                await prompt();
            }
        },
        async notNow() {
            if (state.showing === null) {
                return;
            }
            set({ showing: null });
            try {
                await deps.registry.setPushDevice({ askDeclinedAt: deps.now() });
            } catch (error) {
                onError(error);
            }
        },
        async turnOn() {
            await refresh();
            if (state.availability === 'available' && state.permission === 'undetermined') {
                await prompt();
            }
        },
    };
}
