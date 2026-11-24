import { Image } from 'expo-image';

import { clearWebViewData } from '../../modules/socio-device';
import type { Store, WorkspaceRow } from '../data';
import { enforceLeases } from '../data/lease';
import { createRevokedWipes } from '../data/revoked';
import { rootState } from '../navigation/root-gate';
import { type SignInAgainParams, signInAgainParams } from '../shell/session';

import { copyRevoked, holdScope, releaseScope, startAdding } from './active-scope';
import { appState } from './app-state';

// The session states on the phone (src/data/lease.ts,
// src/sync/session.ts, src/shell/session.ts):
// - the lease runs at launch, before the root gate first reads the registry,
//   so a copy past its 30 days opens on the lock screen, and on each
//   return to the foreground. A lock reads the gate again at once (its scope
//   closes); a wipe at day 60 holds the scope first, clears expo-image's memory
//   cache, and the most recently used workspace left opens;
// - an Ended 401 locks the copy in the registry (scope.ts), and active-scope.ts
//   reads the gate again, which closes the scope and shows the lock;
// - Sign in again (the Expired banner, the lock screen) adds the workspace
//   again over the gate, opening on SignIn with the workspace filled in; the
//   same person's commit unlocks it (commit.ts) and the gate shows the shell;
// - a 401 that says `device_revoked` or `deactivated` locks the
//   copy as an Ended one does, then wipes it in silence (data/revoked.ts),
//   after any lease pass running, and the most recently used workspace left opens.

let opened: Store | null = null;
let running: Promise<void> | null = null;

/** One pass of the lease, unless one is running. Never rejects. */
function runLeases(): Promise<void> {
    const store = opened;
    if (store === null) {
        return Promise.resolve();
    }
    running ??= (async () => {
        /** The scopes this pass held, each released once at its end. */
        const held: string[] = [];
        try {
            const result = await enforceLeases(store, {
                now: Date.now,
                afterLock: () => rootState.refresh(),
                beforeWipe: (id) => {
                    held.push(id);
                    return holdScope(id);
                },
            });
            for (const { error } of result.failed) {
                console.warn('[lease] a wipe did not finish', error);
            }
            if (result.wiped.length > 0) {
                Image.clearMemoryCache().catch(() => {});
                await rootState.refresh();
            }
        } catch (error) {
            console.warn('[lease] the lease check failed', error);
        } finally {
            for (const id of held) {
                await releaseScope(id).catch(() => undefined);
            }
            running = null;
        }
    })();
    return running;
}

/** The silent wipes a 401 asks for (data/revoked.ts): one per workspace, after the lease pass. */
const wipeRevokedCopy = createRevokedWipes({
    store: () => opened,
    leasePass: () => running,
    holdScope,
    releaseScope,
    refresh: () => rootState.refresh(),
    clearImageMemory: () => Image.clearMemoryCache(),
    clearWebViewData: () => clearWebViewData(),
    onError: (error) => console.warn('[session] the revoked copy was not wiped', error),
});

/**
 * Takes the store launch opened (device-store.ts) and runs the lease before
 * the root gate reads the registry; then again on each return to the foreground.
 */
export async function startLeases(launched: Store): Promise<void> {
    if (opened === null) {
        opened = launched;
        copyRevoked.add((id, end) => void wipeRevokedCopy(id, end));
        let last = appState.current();
        appState.subscribe((next) => {
            if (next === 'active' && last !== 'active') {
                void runLeases();
            }
            last = next;
        });
    }
    await runLeases();
}

let again: SignInAgainParams | null = null;

/** Sign in again to workspace `row`: Add workspace opens over the gate, then SignIn for it (`takeSignInAgain`). */
export function signInAgain(row: Pick<WorkspaceRow, 'origin' | 'name'>): void {
    again = signInAgainParams(row);
    startAdding();
}

/** The sign-in asked for by `signInAgain`, once: Add workspace opens SignIn with it. */
export function takeSignInAgain(): SignInAgainParams | null {
    const params = again;
    again = null;
    return params;
}
