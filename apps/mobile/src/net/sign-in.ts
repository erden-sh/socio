import {
    type AppVariant,
    DEVICE_AUTH_PATH,
    type DevicePlatform,
    type SocialProvider,
} from '@socio/shared/device-sign-in';

import { createAuthedFetch, type AuthedFetch } from './authed-fetch';
import { type CookieJar, type JarStore, memoryJarStore, openCookieJar } from './cookie-jar';
import { AbortedError, NetworkError } from './errors';
import type { FetchFunction } from './fetch-function';
import { PROBE_PATH } from './probe';
import { readJson, readText } from './read-body';

// Signing in with an email and a password. Nothing is stored until the
// sign-in commits (src/data/commit.ts):
// 1. A fresh staging jar, in memory: no workspace directory and no keychain
//    entry yet. It is emptied first: no stale cookie goes with the
//    request, a leftover `dont_remember` included, which would leave the new
//    session cookie without a Max-Age.
// 2. `POST /api/auth/sign-in/email` with `{email, password}` and nothing else,
//    through authedFetch on that jar: the workspace's exact origin, `Origin`,
//    JSON, no redirects, no system cookies. A `callbackURL` would add a
//    Location; omitting `rememberMe` gives a persistent cookie.
// 3. The answer's body is never used: its `token` isn't the cookie (the cookie
//    is the token and its signature) and its `user.id` is Better Auth's id, not
//    the app user id that owns the data (@socio/shared/auth's Account: id vs userId).
// 4. `GET /api/auth/session` through the same jar gives the app user id: its
//    `user.id` is `auth_user.appUserId` (src/server/auth/better-auth.ts,
//    `appUser`). A `user: null` there means the sign-in didn't take.
// 5. A refusal becomes a SignInProblem by its status and its JSON `code`,
//    never the server's text (src/server/auth/better-auth.ts and Better Auth
//    1.7.10's sign-in route); the copy table words each (sign-in-copy.ts).
// The jar is discarded on every failure and on cancel. When it holds a session
// by then (the server accepted the password but the session check failed, or
// the commit refused or rolled back, or the person cancelled the
// another-person confirmation), that session is signed out first
// (`POST /api/auth/logout`, best effort, at most SIGN_OUT_TIMEOUT_MS), so none
// is left on the server for a week that nobody holds. A sign-in the person
// cancels with its signal stops at once instead, sending nothing more. The
// password goes into the request's body and nowhere else: no error, problem,
// log or stored value holds it.
//
// The sign-in sheet's code takes the same steps with step 2's request
// `POST /api/auth/device/redeem` `{code, verifier, installId, label, variant}`,
// whose refusals carry @socio/shared/device-sign-in's codes. Its session
// answer has no email, so Better Auth's own (`GET /api/auth/get-session`) is
// read for it, best effort.
//
// Google and Apple (CB-570) take the same steps with step 2's request
// `POST /api/auth/device/social/redeem` `{provider, idToken, nonce, installId, platform, label, variant}`,
// the token the phone's own Google or Apple sign-in made with the nonce the server's
// `social/start` gave (social-sign-in.ts). Its session answer has no email either.

/** Better Auth's email and password sign-in. */
export const SIGN_IN_PATH = '/api/auth/sign-in/email';
/** Who the jar's session belongs to: the same path the probe asks, now with the new cookie. */
export const SESSION_PATH = PROBE_PATH;
/** Ends the session the jar holds (src/server/auth/mock.ts, `sessionRoutes`). */
export const LOGOUT_PATH = '/api/auth/logout';
/** How long a best-effort sign-out may hold up what waits for it (an error on the screen, a cancel). */
export const SIGN_OUT_TIMEOUT_MS = 5000;

/** Why a sign-in didn't sign anyone in. The copy table words each (sign-in-copy.ts). */
export type SignInProblemKind =
    /** 401 INVALID_EMAIL_OR_PASSWORD: a wrong password, an unknown or uninvited email, or an account with no password yet. They can't be told apart. */
    | 'wrong-credentials'
    /** 403 BANNED_USER: the right password for a deactivated account. A copy of the workspace on the phone for that person is wiped (person-check.ts). */
    | 'deactivated'
    /** 403 METHOD_OFF: the workspace's access policy turned password sign-in off. */
    | 'method-off'
    /** 400 EMAIL_PASSWORD_DISABLED: the server runs without password sign-in (`AUTH_PASSWORD=false`). */
    | 'password-disabled'
    /** A 429: too many sign-ins from this address (30 a minute). `retryAfterSeconds` says how long to wait. */
    | 'rate-limited'
    /** 400 INVALID_EMAIL: what was typed isn't an email address. */
    | 'invalid-email'
    /** 403 EMAIL_NOT_VERIFIED: an account made through open sign-up whose email isn't confirmed yet. */
    | 'email-not-verified'
    /** No answer: offline, DNS, TLS (a certificate the phone doesn't trust), a dropped connection. */
    | 'unreachable'
    /** The sign-in was accepted, but the session check found nobody signed in. */
    | 'not-signed-in'
    /** Not sent: the origin's manifest names another workspace than the one on the phone there. */
    | 'workspace-changed'
    /** The sheet's redeem, `code_invalid`: no such code, used already, or not this sheet's verifier. */
    | 'code-invalid'
    /** The sheet's redeem, `code_expired`: the code's 5 minutes passed before the app redeemed it. */
    | 'code-expired'
    /** The sheet's redeem, `wrong_variant`: the code was made for another build of the app. */
    | 'wrong-variant'
    /** The sheet's redeem, `not_authorized`: the browser session that approved it has ended. */
    | 'not-authorized'
    /** The sheet's redeem, `method_off`: the way the person signed in on the web is turned off here. */
    | 'sheet-off'
    /**
     * The sheet's redeem, 403 `denied`: the sign-in was refused on the web while it was redeemed.
     * Add a device's redeem answers it too: "Not my device", 3 wrong tries, or the claim ran out.
     */
    | 'sheet-denied'
    /** Add a device's redeem, `not_allowed_yet`: the web hasn't typed the 6 digits yet; poll again. */
    | 'not-allowed-yet'
    /** A sign-in code's redeem, 429 `too_many`: the request's 5 tries are used up, so it is dead. */
    | 'too-many-tries'
    /** Google or Apple (CB-570), 404 `not_linked`: no account here is linked to that Google or Apple account. */
    | 'not-linked'
    /** Google or Apple, 401 `invalid_token`: the token didn't verify. */
    | 'invalid-token'
    /** Google or Apple, 401 `nonce_invalid`: the server's nonce ran out or was used. */
    | 'nonce-invalid'
    /** Google or Apple, 403 `method_off`: the access policy turned that provider off here. */
    | 'social-off'
    /** Google or Apple, 503 `provider_unavailable`: the server can't have the token verified now. */
    | 'provider-unavailable'
    /** A 5xx: the server, or a proxy in front of it, is failing. */
    | 'server-error'
    /** Anything else: another status or code, a redirect, an answer that can't be read. */
    | 'unknown';

/**
 * A sign-in that didn't work. `status` is the HTTP status of the answer it
 * came with (null with none), `code` the answer's JSON `code` when it is a
 * plain identifier (for Advanced mode): never the server's text.
 */
export type SignInProblem =
    | {
          readonly kind: Exclude<SignInProblemKind, 'rate-limited'>;
          readonly status: number | null;
          readonly code: string | null;
      }
    | {
          readonly kind: 'rate-limited';
          readonly status: number;
          readonly code: string | null;
          /** From `X-Retry-After` (Better Auth's rate limiter), else `Retry-After`, in seconds; null without one. */
          readonly retryAfterSeconds: number | null;
      };

/**
 * The staging jar's cookies, until the sign-in commits or is dropped. The
 * commit copies its stored form into the workspace's jar slot, then discards
 * it; a commit that refuses or rolls back releases it.
 */
export interface StagingJar {
    /** The jar's stored form (`CookieJar.serialize`). Throws once it is discarded. */
    serialize(): string;
    /** Drops every cookie and stops the jar, with no request. Safe to call again. */
    discard(): Promise<void>;
    /**
     * For a sign-in that won't be committed: signs its session out on the server
     * (`POST /api/auth/logout`, best effort, at most SIGN_OUT_TIMEOUT_MS; only
     * when the jar holds a session), then discards the jar. Safe to call again;
     * after a discard it sends nothing.
     */
    release(): Promise<void>;
    readonly discarded: boolean;
}

/** A sign-in the server accepted, not committed to the phone yet. */
export interface StagedSignIn {
    /** The workspace's exact origin. */
    readonly origin: string;
    /** The app user id that owns the data: `user.id` from `GET /api/auth/session`. */
    readonly appUserId: string;
    /** The person's name from the session, for the account sheet. */
    readonly personName: string | null;
    /**
     * The email as sent (trimmed): the session answer has none, and the account sheet shows it. A
     * sign-in that sends none (the sheet) reads it from Better Auth's own session answer; null when
     * that has none.
     */
    readonly personEmail: string | null;
    /** The workspace's name (`branding.name`) from the session answer. */
    readonly workspaceName: string;
    /** The install id the sign-in sent, which the commit moves into the workspace's key slot; null with none. */
    readonly installId: string | null;
    readonly jar: StagingJar;
    /**
     * For the another-person confirmation's Cancel: `jar.release()`, which signs
     * the new session out (best effort: a failure is ignored, and it gives up
     * after SIGN_OUT_TIMEOUT_MS), then discards the jar. The caller needn't wait for it.
     */
    cancel(): Promise<void>;
}

export type SignInResult =
    | { readonly ok: true; readonly signIn: StagedSignIn }
    | { readonly ok: false; readonly problem: SignInProblem };

/** What every sign-in through a staging jar needs. */
export interface StagingOptions {
    /** The workspace's exact origin, where the address probe ended (`WorkspaceAddress.origin`). */
    origin: string;
    /** The app's one fetch (src/platform/fetch.ts). */
    fetch: FetchFunction;
    /** The app's User-Agent (`userAgent`), which carries nothing about the person. */
    userAgent: string;
    /** Cancels the sign-in (the person going back): it rejects with AbortedError, and the jar is discarded. */
    signal?: AbortSignal;
    /** The device clock, for the jar. */
    now?: () => number;
    /** For tests: where the staging jar keeps itself; memory by default. It must be empty. */
    stagingStore?: JarStore;
    /**
     * This install's id for the workspace, sent as `X-Socio-Install`
     * with the sign-in, so the server ties the new session to this device. A
     * staged one: nothing stores it until the commit.
     */
    installId?: string | null;
}

export interface SignInOptions extends StagingOptions {
    email: string;
    password: string;
}

/** The sheet's one-time code redeemed (`POST /api/auth/device/redeem`). */
export interface RedeemSheetOptions extends StagingOptions {
    /** The code from the callback's fragment. */
    code: string;
    /** The PKCE verifier behind the challenge the sheet was started with. */
    verifier: string;
    /** This install's id for the workspace: the redeem's body carries it, and the header too. */
    installId: string;
    /** What the person's device list calls this device (`deviceLabel`). */
    label: string;
    /** This build's variant: a code made for another build is refused (`wrong_variant`). */
    variant: AppVariant;
}

/** A sign-in code redeemed (`POST /api/auth/device/code/redeem`). */
export interface RedeemSignInCodeOptions extends StagingOptions {
    /** The pending request's id, from `POST /api/auth/device/code`. */
    requestId: string;
    /** The code as typed or filled in from its link, in its canonical form (`normalizeCode`). */
    code: string;
    /** The PKCE verifier behind the challenge the request was made with. */
    verifier: string;
    /** This install's id for the workspace: the redeem's body carries it, and the header too. */
    installId: string;
    /** What the person's device list calls this device (`deviceLabel`). */
    label: string;
    /** This build's variant: a code asked for by another build is refused (`wrong_variant`). */
    variant: AppVariant;
    /** The email the code was asked for: the account sheet shows it. */
    email: string;
}

/** Add a device's redeem (`POST /api/auth/device/pair/redeem`), one poll of it. */
export interface RedeemPairingOptions extends StagingOptions {
    /** The claim's id, from `POST /api/auth/device/pair/claim`. */
    claimId: string;
    /** The PKCE verifier behind the challenge the claim was made with. */
    verifier: string;
    /** This install's id for the workspace: the redeem's body carries it, and the header too. */
    installId: string;
    /** The claim's account email: the account sheet shows it. */
    email: string;
}

/** Google or Apple's redeem (CB-570): the token, with the server's nonce, for a device session in `Set-Cookie`. */
export const SOCIAL_REDEEM_PATH = `${DEVICE_AUTH_PATH}/social/redeem`;

/** Google or Apple's redeem (`POST /api/auth/device/social/redeem`). */
export interface RedeemSocialOptions extends StagingOptions {
    readonly provider: SocialProvider;
    /** The ID token the phone's Google or Apple sign-in made. */
    readonly idToken: string;
    /** The nonce from the server's `social/start`, as it gave it (Apple's token carries its SHA-256). */
    readonly nonce: string;
    /** This install's id for the workspace: the redeem's body carries it, and the header too. */
    readonly installId: string;
    readonly platform: DevicePlatform;
    /** What the person's device list calls this device (`deviceLabel`). */
    readonly label: string;
    readonly variant: AppVariant;
}

/** Add a device's redeem: the claim, with the verifier, for a device session in `Set-Cookie` once the web typed the digits. */
export const PAIR_REDEEM_PATH = `${DEVICE_AUTH_PATH}/pair/redeem`;

/** The sign-in codes' redeem: a sign-in code, with the verifier, for a device session in `Set-Cookie`. */
export const CODE_REDEEM_PATH = `${DEVICE_AUTH_PATH}/code/redeem`;

/** The sheet's redeem: the sheet's code, with the verifier, for a device session in `Set-Cookie`. */
export const DEVICE_REDEEM_PATH = `${DEVICE_AUTH_PATH}/redeem`;
/** Better Auth's own session answer, which has the person's email (`/api/auth/session` has none). */
export const AUTH_SESSION_PATH = '/api/auth/get-session';

type ProblemCodes = ReadonlyMap<string, Exclude<SignInProblemKind, 'rate-limited'>>;

/** The codes the copy table words, each with its problem. A Map, so no key reaches Object's prototype. */
const CODES: ProblemCodes = new Map([
    ['INVALID_EMAIL_OR_PASSWORD', 'wrong-credentials'],
    ['BANNED_USER', 'deactivated'],
    ['METHOD_OFF', 'method-off'],
    ['EMAIL_PASSWORD_DISABLED', 'password-disabled'],
    ['INVALID_EMAIL', 'invalid-email'],
    ['EMAIL_NOT_VERIFIED', 'email-not-verified'],
]);

/** The redeem's codes (@socio/shared/device-sign-in's DEVICE_ERROR_CODES); a 429 is `rate-limited` by its status. */
const REDEEM_CODES: ProblemCodes = new Map([
    ['code_invalid', 'code-invalid'],
    ['code_expired', 'code-expired'],
    ['wrong_variant', 'wrong-variant'],
    ['not_authorized', 'not-authorized'],
    ['method_off', 'sheet-off'],
    ['denied', 'sheet-denied'],
    ['BANNED_USER', 'deactivated'],
]);

/**
 * A sign-in code's redeem: the sheet's codes, read for a code (sign-in-codes.ts words them), and
 * `too_many`, which comes with a 429 and means the request is dead, unlike the rate limiter's.
 */
const CODE_REDEEM_CODES: ProblemCodes = new Map([
    ['code_invalid', 'code-invalid'],
    ['code_expired', 'code-expired'],
    ['too_many', 'too-many-tries'],
    ['wrong_variant', 'wrong-variant'],
    ['not_authorized', 'not-authorized'],
    ['method_off', 'sheet-off'],
    ['BANNED_USER', 'deactivated'],
]);

/**
 * Add a device's redeem. `too_many` here is the 1-a-second poll limit, so it is the rate
 * limiter's `rate-limited` (by its 429), never a dead claim.
 */
const PAIR_REDEEM_CODES: ProblemCodes = new Map([
    ['not_allowed_yet', 'not-allowed-yet'],
    ['denied', 'sheet-denied'],
    ['code_invalid', 'code-invalid'],
    ['code_expired', 'code-expired'],
    ['wrong_variant', 'wrong-variant'],
    ['not_authorized', 'not-authorized'],
    ['method_off', 'sheet-off'],
    ['BANNED_USER', 'deactivated'],
]);

/**
 * Google or Apple's redeem (src/server/auth/social-sign-in.ts). `too_many` is the verifier's or
 * the limiter's 429, which asks to wait (`rate-limited`, by its status); `deactivated` is the
 * linked account's.
 */
const SOCIAL_REDEEM_CODES: ProblemCodes = new Map([
    ['not_linked', 'not-linked'],
    ['invalid_token', 'invalid-token'],
    ['nonce_invalid', 'nonce-invalid'],
    ['not_authorized', 'not-authorized'],
    ['method_off', 'social-off'],
    ['deactivated', 'deactivated'],
    ['BANNED_USER', 'deactivated'],
    ['provider_unavailable', 'provider-unavailable'],
    ['code_invalid', 'unknown'],
]);

/** A code worth keeping: an identifier, never a sentence. */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** An email as the session answer may hold one: short, one `@`, no spaces. */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
/** Whole seconds, as Better Auth writes `X-Retry-After`. */
const SECONDS = /^\d{1,9}$/;

type Exchange =
    | {
          readonly ok: true;
          readonly appUserId: string;
          readonly personName: string | null;
          readonly workspaceName: string;
      }
    | { readonly ok: false; readonly problem: SignInProblem };

/**
 * Signs in to the workspace at `origin` through a fresh staging jar.
 * Resolves with the staged sign-in, or with the problem; rejects with
 * AbortedError once `signal` cancels it. Either way but success, the jar is
 * released before it settles (a session it holds signed out, unless `signal`
 * cancelled it). Nothing is written to the phone.
 */
export function signInWithPassword(options: SignInOptions): Promise<SignInResult> {
    const email = options.email.trim();
    return stageSignIn(options, {
        path: SIGN_IN_PATH,
        body: { email, password: options.password },
        personEmail: email,
        codes: CODES,
    });
}

/**
 * Redeems the sign-in sheet's one-time code through a fresh staging jar, as
 * `signInWithPassword` signs in: the same session check, release and problems, with the redeem's
 * codes. The code and the verifier go into the request's body and nowhere else: no problem, error
 * or log holds them. The person's email comes from Better Auth's session answer, best effort.
 */
export function redeemSheetCode(options: RedeemSheetOptions): Promise<SignInResult> {
    const { code, verifier, installId, label, variant } = options;
    return stageSignIn(options, {
        path: DEVICE_REDEEM_PATH,
        body: { code, verifier, installId, label, variant },
        personEmail: null,
        codes: REDEEM_CODES,
    });
}

/**
 * Redeems a sign-in code through a fresh staging jar, as `redeemSheetCode` does, with the code
 * request's id. The code, the verifier and the request id go into the request's body and nowhere
 * else. The email is the one the code was asked for: only that account's code can sign in.
 */
export function redeemSignInCode(options: RedeemSignInCodeOptions): Promise<SignInResult> {
    const { requestId, code, verifier, installId, label, variant } = options;
    return stageSignIn(options, {
        path: CODE_REDEEM_PATH,
        body: { requestId, code, verifier, installId, label, variant },
        personEmail: options.email.trim(),
        codes: CODE_REDEEM_CODES,
    });
}

/**
 * One poll of Add a device's redeem through a fresh staging jar, as `redeemSheetCode`
 * redeems: `not-allowed-yet` until the web types the digits, then the staged sign-in. The claim id,
 * the verifier and the install id go into the request's body and nowhere else. The email is the
 * claim's account's.
 */
export function redeemPairing(options: RedeemPairingOptions): Promise<SignInResult> {
    const { claimId, verifier, installId } = options;
    return stageSignIn(options, {
        path: PAIR_REDEEM_PATH,
        body: { claimId, verifier, installId },
        personEmail: options.email.trim(),
        codes: PAIR_REDEEM_CODES,
    });
}

/**
 * Redeems a Google or Apple ID token through a fresh staging jar, as `redeemSheetCode` does. The
 * token and the nonce go into the request's body and nowhere else: no problem, error or log holds
 * them. The person's email comes from Better Auth's session answer, best effort.
 */
export function redeemSocialToken(options: RedeemSocialOptions): Promise<SignInResult> {
    const { provider, idToken, nonce, installId, platform, label, variant } = options;
    return stageSignIn(options, {
        path: SOCIAL_REDEEM_PATH,
        body: { provider, idToken, nonce, installId, platform, label, variant },
        personEmail: null,
        codes: SOCIAL_REDEEM_CODES,
    });
}

/** What a sign-in sends, and how its refusals read. */
interface SignInExchange {
    readonly path: string;
    readonly body: Record<string, string>;
    /** The email the request carried; null reads it from the session answer. */
    readonly personEmail: string | null;
    readonly codes: ProblemCodes;
}

/** Steps 1 to 5 above, for any sign-in request that answers with a session cookie. */
async function stageSignIn(options: StagingOptions, exchange: SignInExchange): Promise<SignInResult> {
    const { origin, fetch, userAgent, signal, now } = options;
    const installId = options.installId ?? null;
    const store = options.stagingStore ?? memoryJarStore();
    if ((await store.read()) !== null) {
        throw new TypeError('A sign-in needs a fresh staging jar: its store must be empty.');
    }
    const jar = await openCookieJar({ origin, store, now });
    const scope = new AbortController();
    const stop = () => scope.abort(signal?.reason);
    if (signal?.aborted) {
        stop();
    } else {
        signal?.addEventListener('abort', stop, { once: true });
    }
    const request = createAuthedFetch({ origin, jar, fetch, userAgent, signal: scope.signal, installId });
    const staging = stagingJar(jar, scope, () =>
        signOut({ origin, jar, fetch, userAgent, scope: scope.signal, installId }),
    );
    let staged = false;
    try {
        const checked = await signInAndCheck(request, exchange, scope.signal);
        if (!checked.ok) {
            return checked;
        }
        const personEmail = exchange.personEmail ?? (await sessionEmail(request, scope.signal));
        staged = true;
        return {
            ok: true,
            signIn: {
                origin,
                appUserId: checked.appUserId,
                personName: checked.personName,
                personEmail,
                workspaceName: checked.workspaceName,
                installId,
                jar: staging,
                cancel: () => staging.release(),
            },
        };
    } finally {
        // Before the person's signal lets go of the scope, so going back still cuts a sign-out short.
        if (!staged) {
            await staging.release();
        }
        signal?.removeEventListener('abort', stop);
    }
}

/**
 * The signed-in person's email from Better Auth's own session answer (`user.email`), or null:
 * any failure but the person going back is no email, never a failed sign-in.
 */
async function sessionEmail(request: AuthedFetch, signal: AbortSignal): Promise<string | null> {
    let body: unknown;
    try {
        const answer = await request(AUTH_SESSION_PATH);
        if (!answer.ok) {
            await readText(answer, signal).catch(onlyAbort);
            return null;
        }
        body = await readJson(answer, signal);
    } catch (error) {
        onlyAbort(error);
        return null;
    }
    const email = isRecord(body) && isRecord(body.user) ? body.user.email : undefined;
    return typeof email === 'string' && EMAIL.test(email) ? email : null;
}

/** Steps 2 to 5 above. Rejects only with AbortedError, or what the jar's store rejects with. */
async function signInAndCheck(request: AuthedFetch, exchange: SignInExchange, signal: AbortSignal): Promise<Exchange> {
    let answer: Response;
    try {
        answer = await request(exchange.path, { method: 'POST', json: exchange.body });
    } catch (error) {
        return { ok: false, problem: failedRequest(error) };
    }
    if (!answer.ok) {
        return { ok: false, problem: await problemOf(answer, signal, exchange.codes) };
    }
    // Read to the end so the connection is let go; nothing in it is used (step 3). Its cookie is already in the jar.
    await readText(answer, signal).catch(onlyAbort);

    let session: Response;
    try {
        session = await request(SESSION_PATH);
    } catch (error) {
        return { ok: false, problem: failedRequest(error) };
    }
    if (!session.ok) {
        return { ok: false, problem: await problemOf(session, signal, exchange.codes) };
    }
    let body: unknown;
    try {
        body = await readJson(session, signal);
    } catch (error) {
        if (error instanceof NetworkError) {
            return { ok: false, problem: { kind: 'unreachable', status: session.status, code: null } };
        }
        if (error instanceof SyntaxError) {
            return { ok: false, problem: { kind: 'unknown', status: session.status, code: null } };
        }
        throw error;
    }
    return whoSignedIn(body, session.status);
}

/** The app user id, name and workspace name in a session answer; `not-signed-in` for `user: null`. */
function whoSignedIn(body: unknown, status: number): Exchange {
    if (!isRecord(body) || typeof body.provider !== 'string' || !isRecord(body.branding)) {
        return { ok: false, problem: { kind: 'unknown', status, code: null } };
    }
    const { branding, user } = body;
    if (typeof branding.name !== 'string') {
        return { ok: false, problem: { kind: 'unknown', status, code: null } };
    }
    if (user === null || user === undefined) {
        return { ok: false, problem: { kind: 'not-signed-in', status, code: null } };
    }
    if (!isRecord(user) || typeof user.id !== 'string' || user.id === '') {
        return { ok: false, problem: { kind: 'unknown', status, code: null } };
    }
    return {
        ok: true,
        appUserId: user.id,
        personName: typeof user.name === 'string' ? user.name : null,
        workspaceName: branding.name,
    };
}

/** A request that got no answer: offline or TLS is `unreachable`, a refused redirect `unknown`. AbortedError goes on. */
function failedRequest(error: unknown): SignInProblem {
    if (error instanceof AbortedError) {
        throw error;
    }
    if (error instanceof NetworkError) {
        return { kind: 'unreachable', status: null, code: null };
    }
    // RedirectRefusedError: a sign-in never answers with one.
    return { kind: 'unknown', status: null, code: null };
}

/** What a refusal means, by its status and its JSON `code`. Reads nothing else of the body. */
async function problemOf(response: Response, signal: AbortSignal, codes: ProblemCodes): Promise<SignInProblem> {
    const { status } = response;
    const code = await errorCode(response, signal);
    // A request whose tries are used up (a code redeem's 429 `too_many`) is dead; any other 429 asks to wait.
    if (status === 429 && code !== null && codes.get(code) === 'too-many-tries') {
        return { kind: 'too-many-tries', status, code };
    }
    if (status === 429) {
        return { kind: 'rate-limited', status, code, retryAfterSeconds: retryAfter(response.headers) };
    }
    const known = code === null ? undefined : codes.get(code);
    if (known !== undefined) {
        return { kind: known, status, code };
    }
    return { kind: status >= 500 ? 'server-error' : 'unknown', status, code };
}

/** The body's `code` (the server's errors are `{error, code}`), when it is an identifier; null otherwise. */
async function errorCode(response: Response, signal: AbortSignal): Promise<string | null> {
    let body: unknown;
    try {
        body = await readJson(response, signal);
    } catch (error) {
        onlyAbort(error);
        return null;
    }
    return isRecord(body) && typeof body.code === 'string' && CODE.test(body.code) ? body.code : null;
}

/** How long a 429 asks to wait, in seconds: Better Auth's `X-Retry-After`, or a proxy's `Retry-After` in seconds. */
function retryAfter(headers: Headers): number | null {
    for (const name of ['x-retry-after', 'retry-after']) {
        const value = headers.get(name)?.trim();
        if (value !== undefined && SECONDS.test(value)) {
            return Number(value);
        }
    }
    return null;
}

/**
 * Best effort: ends the session a stored jar holds (`POST /api/auth/logout`),
 * for another person's copy before it is wiped. It never rejects:
 * no session, no answer, a refusal or SIGN_OUT_TIMEOUT_MS passing all resolve.
 * The caller closes the jar after.
 */
export function signOutJar(options: {
    readonly origin: string;
    readonly jar: CookieJar;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    /** The install id the jar's session was made with, sent beside it (a replaced session). */
    readonly installId?: string | null;
}): Promise<void> {
    return signOut({ ...options, scope: new AbortController().signal });
}

interface SignOutOptions {
    readonly origin: string;
    readonly jar: CookieJar;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    /** The sign-in's scope: once it is aborted (the person cancelled, or the jar was discarded), nothing is sent. */
    readonly scope: AbortSignal;
    /** The install id the staged sign-in sent, sent with its sign-out too. */
    readonly installId?: string | null;
}

/**
 * Best effort: ends the jar's session on the server, when the jar holds one.
 * Any failure is ignored, and it gives up after SIGN_OUT_TIMEOUT_MS or when
 * the scope aborts.
 */
async function signOut({ origin, jar, fetch, userAgent, scope, installId = null }: SignOutOptions): Promise<void> {
    if (scope.aborted || jar.session() === null) {
        return;
    }
    const stop = new AbortController();
    const abort = () => stop.abort();
    scope.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, SIGN_OUT_TIMEOUT_MS);
    try {
        const request = createAuthedFetch({ origin, jar, fetch, userAgent, signal: stop.signal, installId });
        const answer = await request(LOGOUT_PATH, { method: 'POST', json: {} });
        await readText(answer, stop.signal).catch(() => undefined);
    } catch {
        // Unanswered, refused or too slow: the session ends by itself in a week at most.
    } finally {
        clearTimeout(timer);
        scope.removeEventListener('abort', abort);
    }
}

/**
 * The jar as the commit sees it. Discarding stops its requests, empties it and
 * closes it; releasing signs its session out first.
 */
function stagingJar(jar: CookieJar, scope: AbortController, signOutJar: () => Promise<void>): StagingJar {
    let discarded = false;
    let releasing: Promise<void> | null = null;
    const discard = async () => {
        if (discarded) {
            return;
        }
        discarded = true;
        scope.abort();
        await jar.clear().catch(() => undefined);
        await jar.close();
    };
    const release = async () => {
        if (!discarded) {
            await signOutJar();
        }
        await discard();
    };
    return {
        get discarded() {
            return discarded;
        },
        serialize: () => {
            if (discarded) {
                throw new Error('The staging jar was discarded.');
            }
            return jar.serialize();
        },
        discard,
        release: () => (releasing ??= release()),
    };
}

/** Swallows a failed read, unless the sign-in was cancelled. */
function onlyAbort(error: unknown): void {
    if (error instanceof AbortedError) {
        throw error;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
