import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import {
    type AppVariant,
    codeRequestAnswerSchema,
    DEVICE_AUTH_PATH,
    type DevicePlatform,
    normalizeCode,
    parseAppLink,
    SIGN_IN_CODE_LENGTH,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import { createAuthedFetch } from './authed-fetch';
import { memoryJarStore, openCookieJar } from './cookie-jar';
import { AbortedError, NetworkError } from './errors';
import type { FetchFunction } from './fetch-function';
import { readJson, readText } from './read-body';
import type { SignInProblem } from './sign-in';
import { INVALID_EMAIL, SERVER_ERROR, signInCopy, UNREACHABLE, waitText } from './sign-in-copy';

// Sign-in codes by email or Telegram, the parts with no React Native: the request for a code, the
// code's link read back, and the view models the SignInCode screen draws from. src/data/code-flow.ts
// keeps the pending request; src/net/sign-in.ts's `redeemSignInCode` redeems it.
//
// - `POST /api/auth/device/code {email, challenge, platform, variant}` always answers `{requestId}`,
//   whether or not the email has an account or a channel, so nothing here or on the screen may
//   say whether it has: the words are "if … has an account here".
// - Every request has a fresh verifier and challenge (the server uses a challenge once).
// - The code is 8 symbols of @socio/shared's alphabet, typed or pasted with or without its dash
//   and in any case (`normalizeCode`), and lasts 15 minutes.
// - Its link is the server's `https://<link host>/<variant path>/c#code=…&ws=<host>`, read with
//   `parseAppLink` on this build's link host and taken only for this build's variant.
// - Nothing here logs, and no problem holds the email, the code, the verifier or the request id.

/** The server's code request. */
export const CODE_REQUEST_PATH = `${DEVICE_AUTH_PATH}/code`;
/** How long a code lasts (the server's SIGN_IN_CODE_MS). */
export const SIGN_IN_CODE_MS = 15 * 60_000;
/** How long after a code is sent "Send again" waits. */
export const SEND_AGAIN_MS = 60_000;

/** How a workspace sends its codes (the manifest's `methods.signInCodes`). */
export type CodeChannel = 'email' | 'telegram';

/**
 * The channel this workspace's codes go by, or null when it sends none. The manifest says one
 * channel at most: email while the workspace's "Sign-in links by email" is in force, else Telegram
 * while its bot runs. No manifest (an older server) sends none.
 */
export function codeChannel(manifest: WorkspaceManifest | null): CodeChannel | null {
    const channel = manifest?.methods.signInCodes;
    return channel === 'email' || channel === 'telegram' ? channel : null;
}

/** The SignIn screen's button for a channel. */
export const codeButtonLabel = (channel: CodeChannel) =>
    channel === 'email' ? 'Email me a code' : 'Send a code to my Telegram';

/** The email step's line under the field. */
export const codeEmailHint = (channel: CodeChannel) =>
    channel === 'email'
        ? 'Enter the email you use for this workspace. We’ll send a code to it.'
        : 'Enter the email you use for this workspace. We’ll send a code to the Telegram linked to it.';

/** The code step's title. */
export const codeStepTitle = (channel: CodeChannel) =>
    channel === 'email' ? 'Enter the code we sent to your email' : 'Enter the code we sent to your Telegram';

/**
 * The code step's line: never whether the email has an account (the server answers the same either way),
 * only that a code went if it does.
 */
export function codeSentLine(channel: CodeChannel, email: string): string {
    return channel === 'email'
        ? `If ${email} has an account here, a code is on its way to it. It works for 15 minutes.`
        : `If ${email} has an account here with Telegram linked, a code is on its way to your Telegram. It works for 15 minutes.`;
}

/** Whole seconds before "Send again" may be pressed, 0 once it may. A clock that went back waits the full minute. */
export function sendAgainSeconds(sentAt: number, now: number): number {
    const since = now - sentAt;
    if (since < 0) {
        return Math.ceil(SEND_AGAIN_MS / 1000);
    }
    return Math.max(0, Math.ceil((SEND_AGAIN_MS - since) / 1000));
}

/** "Send again", or "Send again in 42 s" while it waits. */
export const sendAgainLabel = (seconds: number) => (seconds > 0 ? `Send again in ${seconds} s` : 'Send again');

/** What the code field holds: the code in its canonical form once it is one, and a hint when it can't be. */
export interface CodeField {
    readonly code: string | null;
    readonly hint: string | null;
}

/** Symbols the codes never use, because they look like others. */
const LOOK_ALIKES = /[01ILOU]/i;

/** The code field read: with or without the dash or spaces, any case, pasted or typed. */
export function readCodeField(text: string): CodeField {
    const code = normalizeCode(text, SIGN_IN_CODE_LENGTH);
    if (code !== null) {
        return { code, hint: null };
    }
    const bare = text.replace(/[\s-]/g, '');
    if (bare.length >= SIGN_IN_CODE_LENGTH && LOOK_ALIKES.test(bare)) {
        return { code: null, hint: 'Codes never use 0, 1, I, L, O or U. Check the code and try again.' };
    }
    if (bare.length > SIGN_IN_CODE_LENGTH) {
        return { code: null, hint: `A code has ${SIGN_IN_CODE_LENGTH} letters and digits.` };
    }
    return { code: null, hint: null };
}

/** What the screen does with a refused redeem: its line, and whether the request is dead (start over). */
export interface CodeRefusal {
    readonly line: string;
    /** The request can't sign in any more: the screen goes back to the email, which asks for a new code. */
    readonly startOver: boolean;
}

export const CODE_WRONG = 'That code isn’t right. Check it and try again.';
export const CODE_EXPIRED = 'That code has expired. Ask for a new one.';
export const CODE_WRONG_APP = 'That code was asked for by another Socio app on this device. Ask for a new one here.';
export const CODE_UNREACHED = 'That code can’t sign you in any more. Ask for a new one.';
export const CODE_METHOD_OFF =
    'Signing in with a code is turned off for this workspace now. Go back and sign in another way, or ask your admin.';
/** The pending request is gone (used, past its 15 minutes, or never on this device). */
export const CODE_REQUEST_GONE = 'That sign-in has expired. Ask for a new code.';
export const CODE_TOO_MANY_REQUESTS = (seconds: number | null) =>
    `Too many codes asked for. Wait ${seconds === null ? 'a few minutes' : waitText(seconds)}, then try again.`;

/**
 * The line for a refused redeem, and whether it starts over. A wrong code keeps the request (it has
 * 5 tries); a dead one (expired, its tries used, another build's, its channel changed, the method
 * off, the person deactivated) starts over. Anything else is the sign-in table's words, kept.
 */
export function codeRefusal(problem: SignInProblem): CodeRefusal {
    switch (problem.kind) {
        case 'code-invalid':
            return { line: CODE_WRONG, startOver: false };
        case 'code-expired':
            return { line: CODE_EXPIRED, startOver: true };
        case 'too-many-tries':
            return { line: signInCopy(problem).message, startOver: true };
        case 'wrong-variant':
            return { line: CODE_WRONG_APP, startOver: true };
        case 'not-authorized':
            return { line: CODE_UNREACHED, startOver: true };
        case 'sheet-off':
            return { line: CODE_METHOD_OFF, startOver: true };
        case 'deactivated':
            return { line: DEACTIVATED_MESSAGE, startOver: true };
        default:
            return { line: signInCopy(problem).message, startOver: false };
    }
}

/** Why a code wasn't sent. Only kinds and the server's code, never the email. */
export type CodeRequestProblem =
    | { readonly kind: 'invalid-email'; readonly status: number }
    /** 429: 5 requests per 15 minutes from this address. */
    | { readonly kind: 'rate-limited'; readonly status: number; readonly retryAfterSeconds: number | null }
    | { readonly kind: 'unreachable'; readonly status: null }
    | { readonly kind: 'server-error'; readonly status: number }
    | { readonly kind: 'unknown'; readonly status: number | null };

export type CodeRequestResult =
    | { readonly ok: true; readonly requestId: string }
    | { readonly ok: false; readonly problem: CodeRequestProblem };

/** The line for a code that wasn't sent. */
export function codeRequestLine(problem: CodeRequestProblem): string {
    switch (problem.kind) {
        case 'invalid-email':
            return INVALID_EMAIL;
        case 'rate-limited':
            return CODE_TOO_MANY_REQUESTS(problem.retryAfterSeconds);
        case 'unreachable':
            return UNREACHABLE;
        case 'server-error':
            return SERVER_ERROR;
        case 'unknown':
            return signInCopy({ kind: 'unknown', status: problem.status, code: null }).message;
    }
}

export interface CodeRequestOptions {
    readonly origin: string;
    readonly email: string;
    readonly challenge: string;
    readonly platform: DevicePlatform;
    readonly variant: AppVariant;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    readonly signal?: AbortSignal;
}

const SECONDS = /^\d{1,9}$/;

/**
 * Asks the workspace at `origin` to send a code. No cookie goes or is kept: a fresh jar in
 * memory, discarded after. Resolves with the request id, or why not; rejects only with AbortedError.
 */
export async function requestSignInCode(options: CodeRequestOptions): Promise<CodeRequestResult> {
    const { origin, fetch, userAgent, signal } = options;
    const jar = await openCookieJar({ origin, store: memoryJarStore() });
    const scope = new AbortController();
    const stop = () => scope.abort(signal?.reason);
    if (signal?.aborted) {
        stop();
    } else {
        signal?.addEventListener('abort', stop, { once: true });
    }
    try {
        const request = createAuthedFetch({ origin, jar, fetch, userAgent, signal: scope.signal });
        let answer: Response;
        try {
            answer = await request(CODE_REQUEST_PATH, {
                method: 'POST',
                json: {
                    email: options.email.trim(),
                    challenge: options.challenge,
                    platform: options.platform,
                    variant: options.variant,
                },
            });
        } catch (error) {
            if (error instanceof AbortedError) {
                throw error;
            }
            return {
                ok: false,
                problem: error instanceof NetworkError ? { kind: 'unreachable', status: null } : unknown(null),
            };
        }
        const { status } = answer;
        if (answer.ok) {
            let body: unknown;
            try {
                body = await readJson(answer, scope.signal);
            } catch (error) {
                onlyAbort(error);
                return { ok: false, problem: unknown(status) };
            }
            const parsed = codeRequestAnswerSchema.safeParse(body);
            return parsed.success
                ? { ok: true, requestId: parsed.data.requestId }
                : { ok: false, problem: unknown(status) };
        }
        await readText(answer, scope.signal).catch(onlyAbort);
        if (status === 429) {
            const wait = ['x-retry-after', 'retry-after']
                .map((name) => answer.headers.get(name)?.trim())
                .find((value) => value !== undefined && SECONDS.test(value));
            return {
                ok: false,
                problem: { kind: 'rate-limited', status, retryAfterSeconds: wait === undefined ? null : Number(wait) },
            };
        }
        if (status === 400) {
            // The server answers 400 `code_invalid` only for a body it can't read: with a challenge made here, the email.
            return { ok: false, problem: { kind: 'invalid-email', status } };
        }
        return { ok: false, problem: status >= 500 ? { kind: 'server-error', status } : unknown(status) };
    } finally {
        signal?.removeEventListener('abort', stop);
        scope.abort();
        await jar.close().catch(() => undefined);
    }
}

const unknown = (status: number | null): CodeRequestProblem => ({ kind: 'unknown', status });

function onlyAbort(error: unknown): void {
    if (error instanceof AbortedError) {
        throw error;
    }
}

/** What this build reads code links with: its variant and the link host from its config. */
export interface CodeLinkConfig {
    readonly variant: AppVariant;
    readonly linkHost: string;
}

/** The link host from the build's embedded config (`extra.linkHost`), or null without one. */
export function codeLinkConfig(
    extra: { readonly [key: string]: unknown } | null | undefined,
    variant: AppVariant,
): CodeLinkConfig | null {
    const linkHost = extra?.linkHost;
    return typeof linkHost === 'string' && linkHost !== '' ? { variant, linkHost } : null;
}

/** A code link read back: the code (canonical) and the workspace host it is for. */
export interface CodeLinkFields {
    readonly code: string;
    /** `URL.host` of the workspace that sent it (a port kept). */
    readonly host: string;
}

/**
 * The sign-in code in `url`, or null when it isn't this build's code link: another host, kind or
 * variant, a query, a missing or extra field, or a value that isn't a code.
 */
export function readCodeLink(url: string, config: CodeLinkConfig): CodeLinkFields | null {
    const link = parseAppLink(url, config.linkHost);
    if (link === null || link.kind !== 'c' || link.variant !== config.variant) {
        return null;
    }
    const code = normalizeCode((link.fields as { code: string }).code, SIGN_IN_CODE_LENGTH);
    return code === null ? null : { code, host: link.host };
}
