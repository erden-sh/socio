import { withoutFragment } from '../navigation/linking';

// Notification taps, under Node. A tap carries the workspace's id beside the
// web path it opens, in-process: on iOS in the notification's
// `userInfo.socio` (the extension's) through expo-notifications' response, on
// Android as the messaging service's target kept under a random token
// (`takeLaunchTap` and `onTap`). Never a URL, so no other app can switch the
// workspace; a public link
// opens within the open workspace only (links.ts).
//
// - The open workspace's tap opens its path (links.ts holds it until the gate
//   shows the screen).
// - Another workspace on this phone is switched to first, its scope opened,
//   then "Switched to Acme" is said and the path opens.
// - A workspace that isn't on this phone (removed since) opens nothing and
//   says so.
// - A tap with no target (the relay's generic text, or a notification without
//   ours) opens the app as it is, and pulls the shell's notices.
// - Each tap is handled once: iOS hands the response that launched the app
//   both to `getLastNotificationResponse` and, on some launches, to the
//   listener (after T3 Code's notificationNavigation.ts), so taps with a key
//   are remembered for the process.
//
// The chat on screen and the foreground's rules are here too: which chat the
// screen shows, and whether a notification for it is hidden.

/** Where a notification points: the workspace beside a web path, and the conversation it is about. */
export interface PushTarget {
    readonly workspaceId: string;
    /** A web path (`/chats/<id>`, `/`, `/settings/notifications`). */
    readonly link: string;
    /** The conversation (the payload's `tag`), or null. */
    readonly tag: string | null;
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A target from outside JavaScript (a notification's `socio` entry, a native tap), or null when it isn't one. */
export function parsePushTarget(value: unknown): PushTarget | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const { workspaceId, link, tag } = value as Record<string, unknown>;
    if (
        typeof workspaceId !== 'string' ||
        !WORKSPACE_ID.test(workspaceId) ||
        typeof link !== 'string' ||
        !link.startsWith('/') ||
        link.startsWith('//') ||
        (tag !== undefined && tag !== null && typeof tag !== 'string')
    ) {
        return null;
    }
    return { workspaceId, link, tag: typeof tag === 'string' && tag !== '' ? tag : null };
}

/** The slice of an expo-notifications request a target is read from. */
export interface NotificationRequestLike {
    readonly content?: { readonly data?: unknown } | null;
    readonly trigger?: unknown;
}

/** The `userInfo` key the iOS extension puts the target under (socio-push's `PushContentMapper.userInfoKey`). */
export const USER_INFO_KEY = 'socio';

/**
 * A notification's target: a remote one's whole `userInfo` is the trigger's
 * payload (expo-notifications gives `content.data` only its `body`), a local
 * one's is `content.data` (a debug notification).
 */
export function notificationTarget(request: NotificationRequestLike | null | undefined): PushTarget | null {
    const trigger = request?.trigger as { readonly type?: unknown; readonly payload?: unknown } | null | undefined;
    const info = trigger?.type === 'push' ? trigger.payload : request?.content?.data;
    if (typeof info !== 'object' || info === null) {
        return null;
    }
    return parsePushTarget((info as Record<string, unknown>)[USER_INFO_KEY]);
}

/**
 * The chat the screen shows, as the server links to it (`/chats/<id>`), or
 * null on any other screen: only a chat's or room's notifications are held
 * back while it shows (an invite links to `/`, which Home must not swallow).
 */
export function chatOnScreen(workspaceId: string | null, path: string): { workspaceId: string; path: string } | null {
    return workspaceId !== null && path.startsWith('/chats/') ? { workspaceId, path } : null;
}

/** Whether a notification is for the chat on screen, so the foreground hides it. */
export function isOnScreen(target: PushTarget | null, screen: { workspaceId: string; path: string } | null): boolean {
    return (
        target !== null &&
        screen !== null &&
        target.workspaceId === screen.workspaceId &&
        withoutFragment(target.link) === screen.path
    );
}

/** What the tap's notice says. */
export const switchedText = (name: string) => `Switched to ${name}`;
export const UNKNOWN_WORKSPACE_TEXT = 'That notification is for a workspace that’s no longer on this phone.';

export interface PushTapDeps {
    /** The workspace the app shows (the registry's active one), or null. */
    readonly active: () => string | null;
    /** A ready workspace on this phone and its name as people see it, or null. */
    readonly workspace: (id: string) => Promise<{ readonly name: string } | null>;
    /** Makes it the active workspace; resolves once its scope has opened (or failed to). */
    readonly switchTo: (id: string) => Promise<void>;
    /** Opens an app path in the open workspace (links.ts). */
    readonly open: (path: string) => void;
    /** Says something for a few seconds, over every screen. */
    readonly say: (text: string) => void;
    /** A tap with no target: the shell's notices are pulled. */
    readonly generic: () => void;
    readonly onError?: (error: unknown) => void;
}

export interface PushTaps {
    /**
     * Handles a tap, once per `key` (a notification response's id) for the
     * process. Taps run one at a time, in order. Never rejects.
     */
    tap(target: PushTarget | null, key?: string): Promise<void>;
}

/** How many tap keys are remembered: far more than a launch can hand over twice. */
const KEYS_KEPT = 64;

export function createPushTaps(deps: PushTapDeps): PushTaps {
    const { onError = () => {} } = deps;
    const seen: string[] = [];
    let queue: Promise<void> = Promise.resolve();

    const handle = async (target: PushTarget | null) => {
        if (target === null) {
            deps.generic();
            return;
        }
        if (deps.active() !== target.workspaceId) {
            const workspace = await deps.workspace(target.workspaceId);
            if (workspace === null) {
                deps.say(UNKNOWN_WORKSPACE_TEXT);
                return;
            }
            await deps.switchTo(target.workspaceId);
            if (deps.active() !== target.workspaceId) {
                // Another switch won meanwhile: the path belongs to the workspace it left.
                return;
            }
            deps.say(switchedText(workspace.name));
        }
        deps.open(target.link);
    };

    return {
        tap(target, key) {
            if (key !== undefined) {
                if (seen.includes(key)) {
                    return queue;
                }
                seen.push(key);
                if (seen.length > KEYS_KEPT) {
                    seen.shift();
                }
            }
            queue = queue
                .then(() => handle(target))
                .catch((error: unknown) => {
                    onError(error);
                });
            return queue;
        },
    };
}

/** The app's state as `followLaunchTaps` reads it (src/platform/app-state.ts). */
export interface TapAppState {
    current(): string;
    subscribe(listener: (state: string) => void): () => void;
}

export interface LaunchTapDeps {
    /** socio-push's `takeLaunchTap`: the tap on the activity's intent, taken once, or null. */
    readonly take: () => Promise<PushTarget | null>;
    readonly tapped: (target: PushTarget) => void;
    readonly appState: TapAppState;
    readonly onError?: (error: unknown) => void;
}

/**
 * Android's taps that come on the activity's intent rather than to `onTap`:
 * the one that started the app, one that recreated the activity in a live
 * process, and one that came on a new intent before JavaScript listened (native
 * holds that one for `takeLaunchTap`, socio-push's TapRelay.kt). Taken now and
 * on each return to 'active'; native hands each token over once, so a tap
 * `onTap` already delivered isn't taken again. Returns the unsubscribe.
 */
export function followLaunchTaps(deps: LaunchTapDeps): () => void {
    const { onError = () => {} } = deps;
    const take = () => {
        deps.take().then((tap) => {
            if (tap !== null) {
                deps.tapped(tap);
            }
        }, onError);
    };
    let last = deps.appState.current();
    const unsubscribe = deps.appState.subscribe((next) => {
        if (next === 'active' && last !== 'active') {
            take();
        }
        last = next;
    });
    take();
    return unsubscribe;
}
