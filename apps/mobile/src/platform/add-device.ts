import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { type AddDevice, createAddDevice, otherAccounts } from '../data/add-device';
import { signInAndCommit } from '../data/sign-in-flow';
import { rootState } from '../navigation/root-gate';
import { cancelPairing, claimPairing, type DeviceLink, deviceLinkConfig, readDeviceLink } from '../net/add-device';
import { probeWorkspace } from '../net/probe';
import { createPublicFetch } from '../net/public-fetch';
import { deviceLabel } from '../net/sheet-sign-in';
import { redeemPairing } from '../net/sign-in';
import { workspaceLogoPath } from '../shell/workspaces';
import { gateVerdict } from '../sync/versions';

import { appState } from './app-state';
import { randomBytes, sha256Base64, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { finish } from './sign-in';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// Add a device, on the new device, bound: src/data/add-device.ts on the open store, the probe,
// the server's claim and redeem through the app's fetch, `signInAndCommit` with the claim's email
// (the install id and the person check), then the gate. A QR link (root-navigation.ts) is held here
// in memory and opens AddDevice through links.ts once the gate shows it, a cold start included, over
// the shell or the lock screen as the sign-in sheet's callback does. Nothing of it is stored.

const os = Platform.OS === 'ios' ? 'ios' : 'android';
const label = deviceLabel(os, Platform.OS === 'ios' && Platform.isPad);
const LINKS = deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT);
const publicFetch = createPublicFetch({ fetch: appFetch, userAgent: APP_USER_AGENT });

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

/** The one Add a device session; the screen draws its view. */
export const addDevice: AddDevice = createAddDevice({
    variant: BUILD_VARIANT,
    platform: os,
    label,
    probe: (text, signal) =>
        probeWorkspace(text, {
            variant: BUILD_VARIANT,
            publicFetch,
            // Signing in on a device that holds the workspace is the point: never `known`.
            isKnown: () => false,
            serverVersionOk: (version) => gateVerdict(version, BUILD_VARIANT) === 'open',
            signal,
        }),
    claim: (input, signal) => claimPairing({ ...input, fetch: appFetch, userAgent: APP_USER_AGENT, signal }),
    redeem: (job, signal) => redeemPairing({ ...job, fetch: appFetch, userAgent: APP_USER_AGENT, signal }),
    signIn: async ({ origin, email, manifest, signal, stage }) =>
        finish(
            await signInAndCommit(
                { origin, email, logo: null, manifest, signal, stage },
                { store: store(), hash: sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
            ),
            { kind: 'mascot' },
        ),
    others: (origin, email) => otherAccounts(store(), origin, email),
    cancel: (origin, claimId) => cancelPairing({ origin, claimId, fetch: appFetch, userAgent: APP_USER_AGENT }),
    randomBytes,
    sha256: sha256Base64,
    foreground: {
        active: () => appState.current() !== 'background',
        subscribe: (listener) => appState.subscribe(listener),
    },
});

/**
 * The logo the device already keeps for the workspace at `host` (a copy of it on the device, anyone's),
 * or null for the bundled mascot: nothing is fetched or staged for Add a device, whose commit keeps
 * the mascot. Read-only.
 */
export async function keptLogoPath(host: string): Promise<string | null> {
    const opened = store();
    for (const row of await opened.registry.list()) {
        if (row.state === 'pending' || row.state === 'wiping' || hostOf(row.origin) !== host) {
            continue;
        }
        const path = workspaceLogoPath(opened.root, row.id, row.logo);
        if (path !== null) {
            return path;
        }
    }
    return null;
}

const hostOf = (origin: string) => {
    try {
        return new URL(origin).host;
    } catch {
        return null;
    }
};

/** A link waiting for the screen; who listens while it shows. */
let waiting: DeviceLink | null = null;
let screenShown = 0;
const listeners = new Set<() => void>();

/** The AddDevice screen takes the link waiting, once. */
export function takeDeviceLink(): DeviceLink | null {
    const link = waiting;
    waiting = null;
    return link;
}

/** The AddDevice screen listens while it shows; returns the stop. */
export function listenForDeviceLink(listener: () => void): () => void {
    listeners.add(listener);
    screenShown += 1;
    return () => {
        listeners.delete(listener);
        screenShown -= 1;
    };
}

let openScreen: () => void = () => undefined;

/** root-navigation.ts hands over how AddDevice opens (links.ts's `openRoute`). */
export function setDeviceScreenOpener(open: () => void): void {
    openScreen = open;
}

/** Whether `url` is this build's Add a device link. */
export function isDeviceLinkUrl(url: string): boolean {
    return LINKS !== null && readDeviceLink(url, LINKS) !== null;
}

/** An Add a device link from outside: held, then AddDevice opens (or takes it, if it shows). */
export function onDeviceLink(url: string): void {
    const link = LINKS === null ? null : readDeviceLink(url, LINKS);
    if (link === null) {
        return;
    }
    waiting = link;
    for (const listener of listeners) {
        listener();
    }
    if (screenShown === 0) {
        // Over the gate: a link may come while the shell or the lock screen shows.
        if (rootState.get().active !== null) {
            rootState.setAdding(true);
        }
        openScreen();
    }
}
