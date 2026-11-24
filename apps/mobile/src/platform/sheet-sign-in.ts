import { Platform } from 'react-native';

import { createSheetFlow, type SheetFlow } from '../data/sheet-flow';
import { createSheetSignIns, type SheetJob } from '../data/sheet-sign-ins';
import { signInAndCommit } from '../data/sign-in-flow';
import { rootState } from '../navigation/root-gate';
import { deviceLabel, readSheetCallback } from '../net/sheet-sign-in';
import { redeemSheetCode } from '../net/sign-in';

import { SHEET_CONFIG, openAuthSheet } from './auth-sheet';
import { randomBytes, sha256Base64, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { finish } from './sign-in';
import { APP_USER_AGENT } from './user-agent';

// Signing in through the system sign-in sheet, bound: src/data/sheet-sign-ins.ts on the
// pending flow (src/data/sheet-flow.ts, the store's keys), auth-sheet.ts' sheet, and the redeem and commit
// (src/net's `redeemSheetCode` through `signInAndCommit`, then the logo and the gate).

const os = Platform.OS === 'ios' ? 'ios' : 'android';
const label = deviceLabel(os, Platform.OS === 'ios' && Platform.isPad);

/** Whether this build can sign in through the sheet. */
export const HAS_SHEET = SHEET_CONFIG !== null;

let flow: SheetFlow | null = null;

/** The pending flow on the open store, or null in a build with no sheet. */
function sheetFlow(): SheetFlow | null {
    const launched = launchedStore();
    if (SHEET_CONFIG === null || launched === null) {
        return null;
    }
    flow ??= createSheetFlow({
        keys: launched.opened.store.keys,
        randomBytes,
        sha256: sha256Base64,
        config: SHEET_CONFIG,
        platform: os,
    });
    return flow;
}

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

async function redeem(job: SheetJob) {
    const { taken } = job;
    const outcome = await signInAndCommit(
        {
            origin: taken.origin,
            email: null,
            logo: job.logo.kind === 'file' ? `logo.${job.logo.extension}` : null,
            manifest: job.manifest,
            stage: (installId) =>
                redeemSheetCode({
                    origin: taken.origin,
                    code: taken.code,
                    verifier: taken.verifier,
                    installId,
                    label,
                    variant: taken.variant,
                    fetch: appFetch,
                    userAgent: APP_USER_AGENT,
                }),
        },
        { store: store(), hash: sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
    );
    return finish(outcome, job.logo);
}

/** Set by root-navigation.ts: opens SheetSignIn through links.ts once the gate shows it. */
let openScreen: () => void = () => undefined;

export const sheetSignIns = createSheetSignIns({
    flow: sheetFlow,
    openSheet: openAuthSheet,
    os,
    redeem,
    show: () => {
        // Over the gate: a callback after a kill comes while the shell or the lock screen shows.
        if (rootState.get().active !== null) {
            rootState.setAdding(true);
        }
        openScreen();
    },
});

/** root-navigation.ts hands over how SheetSignIn opens (links.ts's `openRoute`), so this file needn't import it. */
export function setSheetScreenOpener(open: () => void): void {
    openScreen = open;
}

/** Whether `url` is shaped as this build's sheet callback (whether it is the pending flow's is `onLink`'s). */
export function isSheetCallbackUrl(url: string): boolean {
    return SHEET_CONFIG !== null && readSheetCallback(url, SHEET_CONFIG) !== null;
}

/** Deletes a pending flow past its 10 minutes (launch). Best effort. */
export function sweepSheetFlow(): void {
    sheetFlow()
        ?.sweep()
        .catch((error: unknown) =>
            console.warn('[sheet] the pending sign-in was not swept', error instanceof Error ? error.name : 'unknown'),
        );
}
