import Constants from 'expo-constants';

import { createInvite, type Invite, knownWorkspaces } from '../data/invite';
import { signInAndCommit } from '../data/sign-in-flow';
import { rootState } from '../navigation/root-gate';
import { createWorkspaceLinkHold } from '../navigation/workspace-link';
import { deviceLinkConfig } from '../net/add-device';
import { type InviteLink, readInviteLink, setPasswordFromInvite } from '../net/invite';
import { probeWorkspace } from '../net/probe';
import { createPublicFetch } from '../net/public-fetch';
import { gateVerdict } from '../sync/versions';

import { randomBytes, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { finish } from './sign-in';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// Invites when the app is installed first, bound: src/data/invite.ts on the open store, the
// probe, the reset-password request through the app's fetch, `signInAndCommit` with the email and
// the new password, then the gate. An invite link (root-navigation.ts) is held in memory by
// src/navigation/workspace-link.ts's hold and opens Invite through links.ts once the gate shows it,
// a cold start included, over the shell or the lock screen. Nothing of it is stored.

const LINKS = deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT);
const publicFetch = createPublicFetch({ fetch: appFetch, userAgent: APP_USER_AGENT });

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

/** The one invite session; the screen draws its view. */
export const invite: Invite = createInvite({
    variant: BUILD_VARIANT,
    probe: (text, signal) =>
        probeWorkspace(text, {
            variant: BUILD_VARIANT,
            publicFetch,
            // An invite may be for a workspace already on the device (another person, or signing in again).
            isKnown: () => false,
            serverVersionOk: (version) => gateVerdict(version, BUILD_VARIANT) === 'open',
            signal,
        }),
    known: () => knownWorkspaces(store()),
    setPassword: (input, signal) =>
        setPasswordFromInvite({ ...input, fetch: appFetch, userAgent: APP_USER_AGENT, signal }),
    signIn: async ({ origin, email, password, manifest, signal }) =>
        finish(
            await signInAndCommit(
                { origin, email, password, logo: null, manifest, signal },
                { store: store(), hash: sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
            ),
            { kind: 'mascot' },
        ),
});

let openScreen: () => void = () => undefined;

/** root-navigation.ts hands over how Invite opens (links.ts `openRoute`). */
export function setInviteScreenOpener(open: () => void): void {
    openScreen = open;
}

/** Invite links from outside: held in memory until the Invite screen takes one. */
export const inviteLinks = createWorkspaceLinkHold<InviteLink>({
    read: (url) => (LINKS === null ? null : readInviteLink(url, LINKS)),
    open: () => openScreen(),
    overGate: () => {
        if (rootState.get().active !== null) {
            rootState.setAdding(true);
        }
    },
});
