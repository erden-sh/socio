import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { SocialProvider, WorkspaceManifest } from '@socio/shared/device-sign-in';

import { googleSignIn } from '../../modules/socio-google-signin';
import type { StagedLogo } from '../data/logo';
import {
    appleToken,
    googleToken,
    linkWithSocial,
    type ObtainToken,
    type ProviderToken,
    type SocialLinkOutcome,
    type SocialSignInOutcome,
    signInWithSocial,
} from '../data/social-sign-in';
import type { AuthedFetch } from '../net/authed-fetch';
import { deviceLabel } from '../net/sheet-sign-in';
import type { SocialBuild } from '../net/social-sign-in';
import { TEST_ACCOUNT, testAccountsIn, testIdToken } from '../net/social-test-token';

import { randomBytes, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { finish } from './sign-in';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// Google and Apple sign-in, bound (CB-570): src/data/social-sign-in.ts with the phone's own
// sign-ins: socio-google-signin (Google's SDK on iOS, Credential Manager on Android) and
// expo-apple-authentication (iOS only). A development build may stand a made-up test account in for
// either (`TEST_ACCOUNTS`), for emulators, simulators and the fake servers (e2e/fake-cloud.mjs);
// preview and production never do.

const os = Platform.OS === 'ios' ? 'ios' : 'android';
const label = deviceLabel(os, Platform.OS === 'ios' && Platform.isPad);
const extra = (Constants.expoConfig?.extra ?? {}) as { googleIosClientId?: unknown; appleSignIn?: unknown };
const GOOGLE_IOS_CLIENT_ID = typeof extra.googleIosClientId === 'string' ? extra.googleIosClientId : null;

/** What this build can carry out of Google and Apple, on this platform. */
export const SOCIAL_BUILD: SocialBuild = {
    platform: os,
    googleIos: GOOGLE_IOS_CLIENT_ID !== null,
    apple: os === 'ios' && extra.appleSignIn === true,
};

/** Whether this build may stand a test account in for Google and Apple: development only. */
export const TEST_ACCOUNTS = testAccountsIn(BUILD_VARIANT);

/**
 * What this build can carry out, with a development build's test account typed: it stands in for the
 * phone's sign-in, so Google and Apple show where the manifest offers them (Apple still iOS only),
 * even without the iOS client id or the entitlement development builds lack.
 */
export function socialBuildWith(testAccount: string | null): SocialBuild {
    return testAccount !== null && TEST_ACCOUNTS
        ? { ...SOCIAL_BUILD, googleIos: true, apple: os === 'ios' }
        : SOCIAL_BUILD;
}

/** Whether a development build shows its test account field: the manifest offers Google or Apple. */
export function showsTestAccount(
    manifest: { readonly methods: { readonly social: readonly string[] } } | null,
): boolean {
    return TEST_ACCOUNTS && (manifest?.methods.social.length ?? 0) > 0;
}

/** A test account's name as typed, or null when there is none (or this build takes none). */
export function testAccountOf(typed: string): string | null {
    const account = typed.trim().toLowerCase();
    return TEST_ACCOUNTS && TEST_ACCOUNT.test(account) ? account : null;
}

/** The phone's sign-in for `provider`, or the test account's token in a development build. */
function obtainWith(testAccount: string | null): ObtainToken {
    return async ({ provider, nonce, serverClientId }): Promise<ProviderToken> => {
        if (testAccount !== null && TEST_ACCOUNTS) {
            return {
                kind: 'token',
                idToken: testIdToken({ variant: BUILD_VARIANT, provider, account: testAccount, nonce }),
            };
        }
        if (provider === 'apple') {
            if (os !== 'ios' || !(await AppleAuthentication.isAvailableAsync().catch(() => false))) {
                return { kind: 'unavailable', reason: 'apple' };
            }
            return appleToken(() =>
                AppleAuthentication.signInAsync({
                    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
                    nonce,
                }),
            );
        }
        if (serverClientId === null) {
            return { kind: 'failed', reason: 'no-server-client-id' };
        }
        return googleToken(await googleSignIn({ clientId: GOOGLE_IOS_CLIENT_ID, serverClientId, nonce }));
    };
}

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

export interface SocialSignInInput {
    readonly provider: SocialProvider;
    readonly origin: string;
    readonly logo: StagedLogo;
    readonly manifest: WorkspaceManifest | null;
    readonly signal: AbortSignal;
    /** A development build's test account, or null for the phone's own sign-in. */
    readonly testAccount: string | null;
}

/** Signs in with Google or Apple and commits; a committed outcome has moved the logo and refreshed the gate. */
export async function socialSignIn(input: SocialSignInInput): Promise<SocialSignInOutcome> {
    const outcome = await signInWithSocial(
        {
            origin: input.origin,
            provider: input.provider,
            logo: input.logo.kind === 'file' ? `logo.${input.logo.extension}` : null,
            manifest: input.manifest,
            signal: input.signal,
            platform: os,
            label,
            variant: BUILD_VARIANT,
            obtain: obtainWith(input.testAccount),
        },
        { store: store(), hash: sha256Hex, sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
    );
    return outcome.kind === 'signed' ? { kind: 'signed', outcome: await finish(outcome.outcome, input.logo) } : outcome;
}

/** Links Google or Apple to the open workspace's account, through its scope's authedFetch. */
export function socialLink(
    fetch: AuthedFetch,
    provider: SocialProvider,
    testAccount: string | null,
    signal?: AbortSignal,
): Promise<SocialLinkOutcome> {
    return linkWithSocial({ fetch, provider, obtain: obtainWith(testAccount), sha256Hex, signal });
}
