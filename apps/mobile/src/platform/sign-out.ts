import { Image } from 'expo-image';

import { clearWebViewData } from '../../modules/socio-device';
import type { Store } from '../data';
import { leaveWorkspace, type LeaveOutcome } from '../data/leave-workspace';
import { countUnsentItems } from '../data/person-check';
import { retryRevocations, signOutWorkspace } from '../data/sign-out';
import { rootState } from '../navigation/root-gate';
import type { AuthedFetch } from '../net/authed-fetch';

import { holdScope, releaseScope } from './active-scope';
import { appState } from './app-state';
import { randomBytes } from './crypto';
import { appFetch } from './fetch';
import { APP_USER_AGENT } from './user-agent';

// Signing out on the phone (src/data/sign-out.ts): the account
// sheet asks first when the workspace has unsent items (`unsentItems`), then
// `signOut` closes the workspace's scope, runs the sign-out on the launched
// store and clears expo-image's memory cache. While it runs, and when it
// fails, the app draws screens/signing-out.tsx in place of the root stack
// (src/app.tsx), so nothing navigates until the wipe is verified. Then the
// most recently used workspace left becomes active (or none: Add workspace),
// and the gate follows.
//
// Pending revocations (a logout that got no answer) are tried again once the
// store has opened at launch, and on each return to the foreground.

export type SignOutStatus =
    | { readonly kind: 'idle' }
    | { readonly kind: 'signing-out'; readonly workspaceId: string }
    | { readonly kind: 'failed'; readonly workspaceId: string; readonly error: unknown };

let status: SignOutStatus = { kind: 'idle' };
const listeners = new Set<() => void>();
let opened: Store | null = null;

function set(next: SignOutStatus) {
    status = next;
    for (const listener of [...listeners]) {
        listener();
    }
}

function store(): Store {
    if (opened === null) {
        throw new Error('The store is not open.');
    }
    return opened;
}

/** The sign-out's state and its changes, in useSyncExternalStore's shape. */
export const signOutStatus = {
    get: (): SignOutStatus => status,
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** The workspace's outbox and unsent rows, or null when they can't be counted. */
export function unsentItems(id: string): Promise<number | null> {
    return countUnsentItems(store(), id).catch(() => null);
}

/**
 * Signs out of workspace `id`. Resolves once it is wiped and the gate shows
 * what comes next; a failure leaves the status 'failed' (Try again runs it
 * again). Never rejects.
 */
export async function signOut(id: string): Promise<void> {
    if (status.kind === 'signing-out') {
        return;
    }
    set({ kind: 'signing-out', workspaceId: id });
    try {
        await signOutWorkspace(
            {
                store: store(),
                fetch: appFetch,
                userAgent: APP_USER_AGENT,
                randomBytes,
                stopScope: () => holdScope(id),
                clearImageMemory: () => Image.clearMemoryCache(),
                // A development client built before the call: nothing to clear, said in the log.
                clearWebViewData: () =>
                    clearWebViewData().catch((error: unknown) =>
                        console.warn('[sign-out] the WebView data was not cleared', error),
                    ),
            },
            id,
        );
        const next = (await store().registry.list())
            .filter((row) => row.state === 'ready')
            .sort((a, b) => b.lastUsed - a.lastUsed)[0];
        await store().registry.setActive(next?.id ?? null);
        await rootState.refresh();
        await releaseScope(id);
        set({ kind: 'idle' });
    } catch (error) {
        console.warn('[sign-out] the sign-out did not finish', error);
        set({ kind: 'failed', workspaceId: id, error });
    }
}

let retrying: Promise<unknown> | null = null;

/** Tries the pending revocations once, unless a try is running. */
function retry(): void {
    if (opened === null || retrying !== null) {
        return;
    }
    retrying = retryRevocations(opened.keys, { fetch: appFetch, userAgent: APP_USER_AGENT })
        .catch((error: unknown) => console.warn('[sign-out] pending revocations', error))
        .finally(() => {
            retrying = null;
        });
}

/** Takes the store launch opened (device-store.ts), tries the pending revocations, and again on each foreground. */
export function startRevocations(launched: Store): void {
    if (opened === null) {
        opened = launched;
        let last = appState.current();
        appState.subscribe((next) => {
            if (next === 'active' && last !== 'active') {
                retry();
            }
            last = next;
        });
    }
    retry();
}

/**
 * Leaves workspace `id` (CB-383) through its scope's `fetch`: on the server's
 * 200 alone, the sign-out's wipe runs (`signOut`: the signing-out screen, then
 * the most recently used workspace left, or Add workspace). A refusal or no
 * answer changes nothing on the phone.
 */
export function leave(id: string, fetch: AuthedFetch): Promise<LeaveOutcome> {
    return leaveWorkspace({ fetch, wipe: () => signOut(id) });
}
