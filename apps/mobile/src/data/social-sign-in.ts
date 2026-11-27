import type {
    AppVariant,
    DevicePlatform,
    SocialLink,
    SocialProvider,
    WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import type { AuthedFetch } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import { redeemSocialToken } from '../net/sign-in';
import {
    linkSocial,
    providerNonce,
    type Sha256Hex,
    type SocialProblem,
    startSignInSocial,
    startSocial,
} from '../net/social-sign-in';

import { type SignInFlowDeps, type SignInOutcome, signInAndCommit } from './sign-in-flow';

// Google and Apple sign-in and linking (CB-570), under Node: the server's nonce, the phone's own
// sign-in (handed in as `obtain`: socio-google-signin, expo-apple-authentication, or a development
// build's test token), then the redeem through `signInAndCommit` (a fresh install id, the person
// check, the commit) or, signed in, the link.
//
// - A cancel in the phone's sheet is `cancelled`: the screen shows nothing, and nothing was sent
//   after the start, whose nonce simply runs out.
// - The nonce, the token and the server client id live in this call's memory only: no outcome,
//   problem, log or stored byte holds them (tests/social-sign-in.test.ts).
// - A sign-in finds only an account that linked that provider before (the server's rule): a link
//   is made only signed in, from Settings → Account.

/** What the phone's own sign-in answered. `reason` is a fixed word for test builds, never a value. */
export type ProviderToken =
    | { readonly kind: 'token'; readonly idToken: string }
    /** The person's Cancel. */
    | { readonly kind: 'cancelled' }
    /** Android: no Google account on the phone to choose. */
    | { readonly kind: 'no-account' }
    /** The phone can't do it at all (no Google Play services, an iOS without the capability). */
    | { readonly kind: 'unavailable'; readonly reason: string }
    | { readonly kind: 'failed'; readonly reason: string };

/** What the phone's sign-in is asked for: the provider's nonce (Apple's hashed) and Google's audience. */
export interface TokenRequest {
    readonly provider: SocialProvider;
    readonly nonce: string;
    readonly serverClientId: string | null;
}

export type ObtainToken = (request: TokenRequest) => Promise<ProviderToken>;

/** Why the phone's sign-in gave no token, other than a cancel. */
export type NativeFailure = Exclude<ProviderToken, { kind: 'token' } | { kind: 'cancelled' }>;

export type SocialSignInOutcome =
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'native'; readonly failure: NativeFailure }
    /** The server's start refused (the provider off, unavailable, too many tries). */
    | { readonly kind: 'start-refused'; readonly problem: SocialProblem }
    /** The redeem's outcome, as every sign-in's. */
    | { readonly kind: 'signed'; readonly outcome: SignInOutcome };

export interface SocialSignInRequest {
    readonly origin: string;
    readonly provider: SocialProvider;
    readonly logo: string | null;
    readonly manifest?: WorkspaceManifest | null;
    readonly signal?: AbortSignal;
    readonly platform: DevicePlatform;
    readonly label: string;
    readonly variant: AppVariant;
    readonly obtain: ObtainToken;
}

/** Signs in with Google or Apple and commits. Rejects only with AbortedError or a store failure. */
export async function signInWithSocial(
    request: SocialSignInRequest,
    deps: SignInFlowDeps & { readonly sha256Hex: Sha256Hex },
): Promise<SocialSignInOutcome> {
    const started = await startSignInSocial({
        origin: request.origin,
        provider: request.provider,
        fetch: deps.fetch,
        userAgent: deps.userAgent,
        signal: request.signal,
        now: deps.now,
    });
    if (!started.ok) {
        return { kind: 'start-refused', problem: started.problem };
    }
    const { nonce, serverClientId } = started.start;
    const token = await request.obtain({
        provider: request.provider,
        nonce: await providerNonce(request.provider, nonce, deps.sha256Hex),
        serverClientId,
    });
    if (token.kind === 'cancelled') {
        return { kind: 'cancelled' };
    }
    if (token.kind !== 'token') {
        return { kind: 'native', failure: token };
    }
    // Gone back while the phone's sheet was up: no redeem is sent, and the token is dropped.
    if (request.signal?.aborted) {
        throw new AbortedError(request.origin, request.signal.reason);
    }
    const { idToken } = token;
    const outcome = await signInAndCommit(
        {
            origin: request.origin,
            email: null,
            logo: request.logo,
            manifest: request.manifest,
            signal: request.signal,
            stage: (installId) =>
                redeemSocialToken({
                    origin: request.origin,
                    provider: request.provider,
                    idToken,
                    nonce,
                    installId,
                    platform: request.platform,
                    label: request.label,
                    variant: request.variant,
                    fetch: deps.fetch,
                    userAgent: deps.userAgent,
                    // Going back stops the redeem: before its answer nothing is held, so nothing is
                    // signed out; after it, signInAndCommit signs the staged session out instead of
                    // committing. The nonce is single-use, so trying again starts over.
                    signal: request.signal,
                    now: deps.now,
                }),
        },
        deps,
    );
    return { kind: 'signed', outcome };
}

export type SocialLinkOutcome =
    | { readonly kind: 'linked'; readonly link: SocialLink }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'native'; readonly failure: NativeFailure }
    | { readonly kind: 'refused'; readonly problem: SocialProblem };

/**
 * Links Google or Apple to the signed-in account through the workspace's authedFetch: a link's
 * start (bound to this session), the phone's sign-in, then `POST /api/auth/social/link`. Rejects
 * only with AbortedError.
 */
export async function linkWithSocial(request: {
    readonly fetch: AuthedFetch;
    readonly provider: SocialProvider;
    readonly obtain: ObtainToken;
    readonly sha256Hex: Sha256Hex;
    readonly signal?: AbortSignal;
}): Promise<SocialLinkOutcome> {
    const started = await startSocial(request.fetch, { provider: request.provider, purpose: 'link' }, request.signal);
    if (!started.ok) {
        return { kind: 'refused', problem: started.problem };
    }
    const { nonce, serverClientId } = started.start;
    const token = await request.obtain({
        provider: request.provider,
        nonce: await providerNonce(request.provider, nonce, request.sha256Hex),
        serverClientId,
    });
    if (token.kind === 'cancelled') {
        return { kind: 'cancelled' };
    }
    if (token.kind !== 'token') {
        return { kind: 'native', failure: token };
    }
    const linked = await linkSocial(
        request.fetch,
        { provider: request.provider, idToken: token.idToken, nonce },
        request.signal,
    );
    return linked.ok ? { kind: 'linked', link: linked.link } : { kind: 'refused', problem: linked.problem };
}

/** A fixed word from a native answer, never a message: an identifier, else `native`. */
const reasonOf = (value: unknown) => (typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : 'native');

/** socio-google-signin's answer (its `GoogleSignInResult`) as a ProviderToken. */
export function googleToken(result: {
    readonly type: string;
    readonly idToken?: string;
    readonly reason?: string;
}): ProviderToken {
    switch (result.type) {
        case 'success':
            return typeof result.idToken === 'string' && result.idToken !== ''
                ? { kind: 'token', idToken: result.idToken }
                : { kind: 'failed', reason: 'no-token' };
        case 'cancel':
            return { kind: 'cancelled' };
        case 'no-account':
            return { kind: 'no-account' };
        case 'unavailable':
            return { kind: 'unavailable', reason: reasonOf(result.reason) };
        default:
            return { kind: 'failed', reason: reasonOf(result.reason) };
    }
}

/**
 * expo-apple-authentication's `signInAsync` as a ProviderToken: its credential's identity token,
 * or its error's code (`ERR_REQUEST_CANCELED` is the person's Cancel). Never rejects.
 */
export async function appleToken(
    signIn: () => Promise<{ readonly identityToken: string | null }>,
): Promise<ProviderToken> {
    try {
        const credential = await signIn();
        return credential.identityToken
            ? { kind: 'token', idToken: credential.identityToken }
            : { kind: 'failed', reason: 'no-token' };
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'ERR_REQUEST_CANCELED') {
            return { kind: 'cancelled' };
        }
        return { kind: 'failed', reason: reasonOf(code) };
    }
}
