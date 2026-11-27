import {
    DEVICE_AUTH_PATH,
    type DevicePlatform,
    type SocialLink,
    socialLinkSchema,
    socialLinksSchema,
    type SocialProvider,
    type SocialPurpose,
    socialStartAnswerSchema,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import { type AuthedFetch, createAuthedFetch } from './authed-fetch';
import { memoryJarStore, openCookieJar } from './cookie-jar';
import { AbortedError, NetworkError } from './errors';
import type { FetchFunction } from './fetch-function';
import { readJson, readText } from './read-body';

// Google and Apple sign-in (CB-570), the requests, under Node:
// - `POST /api/auth/device/social/start {provider, purpose}` gives a nonce, when it runs out, and
//   for Google the `serverClientId` the phone's Google sign-in asks the token for. A sign-in's start
//   carries no session (a fresh, empty jar in memory); a link's goes through the workspace's own
//   authedFetch, whose session the nonce is bound to.
// - The phone's own sign-in makes an ID token with it: Google takes the nonce as it is, Apple its
//   SHA-256 in hex (`providerNonce`), which Apple's token then carries.
// - The token goes to `POST /api/auth/device/social/redeem` (sign-in.ts' `redeemSocialToken`,
//   through `signInAndCommit`) or, signed in, `POST /api/auth/social/link`.
// - `GET /api/auth/social/links` lists the account's links; `DELETE /api/auth/social/link/:provider`
//   unlinks one, refused (409 `last_method`) while it is the account's only way in.
// Every refusal is a problem by its status and its JSON `code`, never the server's text
// (social-copy.ts words each). The nonce, the token and the server client id go only into the
// requests and the phone's sign-in: no problem, error or log here holds them.

/** A nonce for one sign-in or link. */
export const SOCIAL_START_PATH = `${DEVICE_AUTH_PATH}/social/start`;
/** Links this Google or Apple account to the signed-in account. */
export const SOCIAL_LINK_PATH = '/api/auth/social/link';
/** The account's links. */
export const SOCIAL_LINKS_PATH = '/api/auth/social/links';
/** Unlinks one provider. */
export const socialUnlinkPath = (provider: SocialProvider) => `${SOCIAL_LINK_PATH}/${provider}`;

/** What the person sees each provider called. */
export const PROVIDER_NAMES: Readonly<Record<SocialProvider, string>> = { google: 'Google', apple: 'Apple' };

/** What this build can do of each provider, on this platform. */
export interface SocialBuild {
    readonly platform: DevicePlatform;
    /**
     * Google on iOS needs the build's iOS client id (`extra.googleIosClientId`); Android's
     * Credential Manager needs only the server's client id, from the start.
     */
    readonly googleIos: boolean;
    /** Sign in with Apple: iOS, in a build with the entitlement (`extra.appleSignIn`). */
    readonly apple: boolean;
}

/** Whether this build, on this platform, can carry out `provider`'s sign-in at all. */
export function buildOffers(provider: SocialProvider, build: SocialBuild): boolean {
    if (provider === 'apple') {
        return build.platform === 'ios' && build.apple;
    }
    return build.platform === 'android' || build.googleIos;
}

/**
 * The Google and Apple buttons SignIn shows, in order (Apple first, as Apple asks its button be
 * at least as prominent): what the manifest's `methods.social` offers, that this build can carry
 * out. No manifest (an older server, or none read yet): none.
 */
export function socialWays(manifest: WorkspaceManifest | null, build: SocialBuild): SocialProvider[] {
    const offered = manifest?.methods.social ?? [];
    return (['apple', 'google'] as const).filter(
        (provider) => offered.includes(provider) && buildOffers(provider, build),
    );
}

/** Why a start, a link, an unlink or the links' read didn't work. */
export type SocialProblemKind =
    /** 401 `not_authorized`: a link's session no longer stands; a sign-in starts again. */
    | 'not-authorized'
    /** 403 `method_off`: the access policy turned that provider off here. */
    | 'method-off'
    /** 403 `deactivated`. */
    | 'deactivated'
    /** 401 `invalid_token`. */
    | 'invalid-token'
    /** 401 `nonce_invalid`. */
    | 'nonce-invalid'
    /** 404 `not_linked`: an unlink of a link that is already gone. */
    | 'not-linked'
    /** 409 `already_linked_other`: that Google or Apple account is another person's here. */
    | 'already-linked-other'
    /** 409 `last_method`: unlinking would leave no way in. */
    | 'last-method'
    /** 429, `too_many` or the limiter's. */
    | 'rate-limited'
    /** 503 `provider_unavailable`: the server can't verify a token now (or isn't connected). */
    | 'provider-unavailable'
    /** No answer. */
    | 'unreachable'
    /** Another 5xx. */
    | 'server-error'
    /** Anything else, an older server's 404 included. */
    | 'unknown';

export interface SocialProblem {
    readonly kind: SocialProblemKind;
    readonly status: number | null;
    /** The answer's JSON `code` when it is a plain identifier, for test builds' detail. */
    readonly code: string | null;
}

const CODES: ReadonlyMap<string, SocialProblemKind> = new Map([
    ['not_authorized', 'not-authorized'],
    ['method_off', 'method-off'],
    ['deactivated', 'deactivated'],
    ['BANNED_USER', 'deactivated'],
    ['invalid_token', 'invalid-token'],
    ['nonce_invalid', 'nonce-invalid'],
    ['not_linked', 'not-linked'],
    ['already_linked_other', 'already-linked-other'],
    ['last_method', 'last-method'],
    ['too_many', 'rate-limited'],
    ['provider_unavailable', 'provider-unavailable'],
]);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A refusal's problem: the 429 by its status, then the code, then the status. Reads only the body's `code`. */
async function problemOf(response: Response, signal: AbortSignal | undefined): Promise<SocialProblem> {
    let code: string | null = null;
    try {
        const body = await readJson(response, signal);
        const value = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
        code = typeof value === 'string' && CODE.test(value) ? value : null;
    } catch (error) {
        if (error instanceof AbortedError) {
            throw error;
        }
    }
    const { status } = response;
    if (status === 429) {
        return { kind: 'rate-limited', status, code };
    }
    const known = code === null ? undefined : CODES.get(code);
    return { kind: known ?? (status >= 500 ? 'server-error' : 'unknown'), status, code };
}

/** A request that got no answer. AbortedError goes on. */
function noAnswer(error: unknown): SocialProblem {
    if (error instanceof AbortedError) {
        throw error;
    }
    return { kind: error instanceof NetworkError ? 'unreachable' : 'unknown', status: null, code: null };
}

/** A start's answer, as the phone's sign-in takes it. */
export interface SocialStart {
    readonly nonce: string;
    readonly expiresAt: string;
    /** Google's server client id: the audience the token is made for. Absent for Apple. */
    readonly serverClientId: string | null;
}

export type SocialStartResult =
    | { readonly ok: true; readonly start: SocialStart }
    | { readonly ok: false; readonly problem: SocialProblem };

/**
 * `POST /api/auth/device/social/start` through `request`: the workspace's authedFetch for a link,
 * `anonymousRequest`'s for a sign-in. Rejects only with AbortedError.
 */
export async function startSocial(
    request: AuthedFetch,
    body: { readonly provider: SocialProvider; readonly purpose: SocialPurpose },
    signal?: AbortSignal,
): Promise<SocialStartResult> {
    let response: Response;
    try {
        response = await request(SOCIAL_START_PATH, {
            method: 'POST',
            json: { provider: body.provider, purpose: body.purpose },
            signal,
        });
    } catch (error) {
        return { ok: false, problem: noAnswer(error) };
    }
    if (!response.ok) {
        return { ok: false, problem: await problemOf(response, signal) };
    }
    let read: unknown;
    try {
        read = await readJson(response, signal);
    } catch (error) {
        return { ok: false, problem: { ...noAnswer(error), status: response.status } };
    }
    const parsed = socialStartAnswerSchema.safeParse(read);
    // Google's sign-in can't make a token without the server client id.
    if (!parsed.success || (body.provider === 'google' && !parsed.data.serverClientId)) {
        return { ok: false, problem: { kind: 'unknown', status: response.status, code: null } };
    }
    return {
        ok: true,
        start: {
            nonce: parsed.data.nonce,
            expiresAt: parsed.data.expiresAt,
            serverClientId: body.provider === 'google' ? (parsed.data.serverClientId ?? null) : null,
        },
    };
}

/**
 * A sign-in's start, with no session: a fresh jar in memory, emptied and closed after. The
 * answer sets no cookie; whatever it set is dropped with the jar. Rejects only with AbortedError.
 */
export async function startSignInSocial(options: {
    readonly origin: string;
    readonly provider: SocialProvider;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
}): Promise<SocialStartResult> {
    const jar = await openCookieJar({ origin: options.origin, store: memoryJarStore(), now: options.now });
    const scope = new AbortController();
    const stop = () => scope.abort(options.signal?.reason);
    if (options.signal?.aborted) {
        stop();
    }
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
        const request = createAuthedFetch({
            origin: options.origin,
            jar,
            fetch: options.fetch,
            userAgent: options.userAgent,
            signal: scope.signal,
        });
        return await startSocial(request, { provider: options.provider, purpose: 'signin' }, scope.signal);
    } finally {
        options.signal?.removeEventListener('abort', stop);
        await jar.clear().catch(() => undefined);
        await jar.close().catch(() => undefined);
    }
}

/** SHA-256 of a text, as 64 lowercase hex characters (expo-crypto's, or Node's in tests). */
export type Sha256Hex = (text: string) => Promise<string>;

/**
 * The nonce the phone's sign-in puts in its request: Google's is the server's as it is; Apple's
 * is its SHA-256 in hex, which the token Apple makes then carries (the server's contract).
 */
export async function providerNonce(provider: SocialProvider, nonce: string, sha256Hex: Sha256Hex): Promise<string> {
    return provider === 'apple' ? (await sha256Hex(nonce)).toLowerCase() : nonce;
}

export type SocialLinkResult =
    | { readonly ok: true; readonly link: SocialLink }
    | { readonly ok: false; readonly problem: SocialProblem };

/**
 * `POST /api/auth/social/link {provider, idToken, nonce}` through the workspace's authedFetch.
 * A link already there for this account answers 200 too, unchanged. Rejects only with AbortedError.
 */
export async function linkSocial(
    request: AuthedFetch,
    body: { readonly provider: SocialProvider; readonly idToken: string; readonly nonce: string },
    signal?: AbortSignal,
): Promise<SocialLinkResult> {
    let response: Response;
    try {
        response = await request(SOCIAL_LINK_PATH, {
            method: 'POST',
            json: { provider: body.provider, idToken: body.idToken, nonce: body.nonce },
            signal,
        });
    } catch (error) {
        return { ok: false, problem: noAnswer(error) };
    }
    if (!response.ok) {
        return { ok: false, problem: await problemOf(response, signal) };
    }
    let read: unknown;
    try {
        read = await readJson(response, signal);
    } catch (error) {
        return { ok: false, problem: { ...noAnswer(error), status: response.status } };
    }
    const parsed = socialLinkSchema.safeParse(read);
    if (!parsed.success || parsed.data.provider !== body.provider) {
        return { ok: false, problem: { kind: 'unknown', status: response.status, code: null } };
    }
    return { ok: true, link: parsed.data };
}

export type SocialUnlinkResult = { readonly ok: true } | { readonly ok: false; readonly problem: SocialProblem };

/**
 * `DELETE /api/auth/social/link/:provider`. A link that is already gone (404 `not_linked`) is
 * unlinked as asked. Rejects only with AbortedError.
 */
export async function unlinkSocial(
    request: AuthedFetch,
    provider: SocialProvider,
    signal?: AbortSignal,
): Promise<SocialUnlinkResult> {
    let response: Response;
    try {
        response = await request(socialUnlinkPath(provider), { method: 'DELETE', signal });
    } catch (error) {
        return { ok: false, problem: noAnswer(error) };
    }
    if (response.ok) {
        await readText(response, signal).catch((error: unknown) => {
            if (error instanceof AbortedError) {
                throw error;
            }
        });
        return { ok: true };
    }
    const problem = await problemOf(response, signal);
    return problem.kind === 'not-linked' ? { ok: true } : { ok: false, problem };
}

/** The account's links, or why they couldn't be read. */
export type SocialLinksRead =
    | { readonly kind: 'links'; readonly links: readonly SocialLink[] }
    /** An older server, without the endpoint: the section shows none of it. */
    | { readonly kind: 'unsupported' }
    | { readonly kind: 'failed'; readonly problem: SocialProblem };

/** `GET /api/auth/social/links`. Rejects only with AbortedError. */
export async function readSocialLinks(request: AuthedFetch, signal?: AbortSignal): Promise<SocialLinksRead> {
    let response: Response;
    try {
        response = await request(SOCIAL_LINKS_PATH, { signal });
    } catch (error) {
        return { kind: 'failed', problem: noAnswer(error) };
    }
    if (response.status === 404) {
        await readText(response, signal).catch(() => undefined);
        return { kind: 'unsupported' };
    }
    if (!response.ok) {
        return { kind: 'failed', problem: await problemOf(response, signal) };
    }
    let read: unknown;
    try {
        read = await readJson(response, signal);
    } catch (error) {
        return { kind: 'failed', problem: { ...noAnswer(error), status: response.status } };
    }
    const parsed = socialLinksSchema.safeParse(read);
    return parsed.success
        ? { kind: 'links', links: parsed.data }
        : { kind: 'failed', problem: { kind: 'unknown', status: response.status, code: null } };
}

/** One row of Settings → Account's Sign-in methods. */
export interface SignInMethodRow {
    readonly provider: SocialProvider;
    /** The link, when there is one. */
    readonly link: SocialLink | null;
    /** Link shows: the workspace offers it and this build can carry it out. */
    readonly canLink: boolean;
}

/**
 * The Sign-in methods rows, Apple first: each provider the workspace offers that this build can
 * carry out, and each one already linked, wherever it was linked (so Apple linked on an iPhone shows
 * on Android too, to unlink). None while neither: the section hides.
 */
export function signInMethodRows(
    manifest: WorkspaceManifest | null,
    links: readonly SocialLink[],
    build: SocialBuild,
): SignInMethodRow[] {
    const offered = socialWays(manifest, build);
    return (['apple', 'google'] as const).flatMap((provider) => {
        const link = links.find((entry) => entry.provider === provider) ?? null;
        const canLink = offered.includes(provider);
        return link === null && !canLink ? [] : [{ provider, link, canLink }];
    });
}
