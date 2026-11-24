// Based on T3 Code's apps/mobile/src/lib/protectedData.ts
// (https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
// root). Rewritten for this module: T3's version asks its own native controls
// once and otherwise waits for the app to become active; this one also listens
// for iOS's protectedDataDidBecomeAvailable, so a launch in the background goes
// on when the phone is unlocked, without being opened.
import { AppState } from 'react-native';

import { addProtectedDataListener, isProtectedDataAvailable } from './device';

let ready: Promise<void> | undefined;

/**
 * Resolves once this launch can read the keychain's after-first-unlock items
 * (the store's keys): at once if the app is active, otherwise when iOS reports
 * protected data available or the app becomes active. It never rejects.
 *
 * Call it only after a key read failed because the phone hasn't been unlocked
 * yet. iOS's check reports the complete class, which is unavailable whenever a
 * phone with a passcode is locked, even after its first unlock, when those
 * keys can be read; waiting first would hold up a locked background launch
 * that could have gone on.
 *
 * The answer is kept for the rest of the launch: after-first-unlock items stay
 * readable until the phone restarts, which ends the process. On Android the
 * native check is true whenever the app runs.
 */
export function whenProtectedDataAvailable(): Promise<void> {
    ready ??= new Promise<void>((resolve) => {
        if (AppState.currentState === 'active') {
            resolve();
            return;
        }
        const subscriptions: { remove(): void }[] = [];
        let settled = false;
        const done = () => {
            if (!settled) {
                settled = true;
                for (const subscription of subscriptions) {
                    subscription.remove();
                }
                resolve();
            }
        };
        subscriptions.push(
            AppState.addEventListener('change', (state) => {
                if (state === 'active') {
                    done();
                }
            }),
        );
        // A missing or failing native check doesn't establish readiness, and
        // doesn't fail the wait either: becoming active still ends it.
        // Subscribe before checking: the Swift side adds its observers while
        // addListener runs, so an unlock after the check still arrives.
        try {
            subscriptions.push(
                addProtectedDataListener((available) => {
                    if (available) {
                        done();
                    }
                }),
            );
            isProtectedDataAvailable().then(
                (available) => {
                    if (available) {
                        done();
                    }
                },
                () => {},
            );
        } catch {
            // The native module isn't in this build: only activation can end the wait.
        }
    });
    return ready;
}
