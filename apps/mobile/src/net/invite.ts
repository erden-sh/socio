import { parseAppLink } from '@socio/shared/device-sign-in';

import type { DeviceLinkConfig } from './add-device';
import { createAuthedFetch } from './authed-fetch';
import { memoryJarStore, openCookieJar } from './cookie-jar';
import { AbortedError, NetworkError } from './errors';
import type { FetchFunction } from './fetch-function';
import { readJson, readText } from './read-body';
import { SERVER_ERROR, UNREACHABLE, waitText } from './sign-in-copy';

// Invites when the app is installed first, the parts
// with no React Native: the link read back, the new password checked as the web
// checks it, the password set, and the words. src/data/invite.ts runs the steps.
//
// - With the admin's "Invites open the Socio app" on, an invite or password link is
//   `https://<link host>/<variant path>/i/<workspace host>#t=<token>`, read with @socio/shared's
//   `parseAppLink` on this build's link host and taken only for this build's variant. Its workspace
//   host is checked as a typed address is (add-device.ts's `deviceLinkAddress`).
// - The token rides in the fragment, which no request carries. It goes into one request's body,
//   `POST /api/auth/reset-password {newPassword, token}` (the web's `setPasswordFromLink`,
//   packages/client/src/shell/auth-client.ts), through a fresh jar in memory that holds no cookie
//   before or after: Better Auth signs nobody in there. The password sign-in comes after, as every
//   sign-in (src/data/sign-in-flow.ts).
// - Nothing here logs, and no problem, error or view holds the token or the password.

/** Better Auth's reset-password route: it sets the password a one-time token names. */
export const RESET_PASSWORD_PATH = '/api/auth/reset-password';

/**
 * The shortest password the server takes (src/server/auth/better-auth.ts's MIN_PASSWORD, and the web's
 * set-password form's `minLength`). @socio/shared has no constant for it yet, so it is kept in step
 * here; `tests/invite.test.ts` reads the server's.
 */
export const MIN_PASSWORD_LENGTH = 10;
/** The longest (Better Auth's default `maxPasswordLength`, the web form's `maxLength`). */
export const MAX_PASSWORD_LENGTH = 128;

/** An invite link read back: the one-time token and the workspace host it is for. */
export interface InviteLink {
    /** `URL.host` of the workspace that made it (a port kept). */
    readonly host: string;
    readonly token: string;
}

/** The server's tokens are 24 random bytes in base64url (32 characters); anything near that shape is let through. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The invite link in `url`, or null when it isn't this build's: another host, kind or variant, a
 * query, a missing or extra field, or a value that isn't a token.
 */
export function readInviteLink(url: string, config: DeviceLinkConfig): InviteLink | null {
    const link = parseAppLink(url, config.linkHost);
    if (link === null || link.kind !== 'i' || link.variant !== config.variant) {
        return null;
    }
    const token = (link.fields as { t: string }).t;
    return TOKEN.test(token) ? { host: link.host, token } : null;
}

/** Why a new password can't be sent yet: the web form's rules. */
export type PasswordRule = 'too-short' | 'too-long' | 'differ';

/** The new password and its repeat, checked as the web's form checks them; null when they pass. */
export function checkNewPassword(password: string, repeat: string): PasswordRule | null {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return 'too-short';
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return 'too-long';
    }
    return password === repeat ? null : 'differ';
}

/** Why setting the password didn't work. Only kinds and the status, never the token or the password. */
export type SetPasswordProblem =
    /** 400 INVALID_TOKEN: the invite was used already, or ran out (three days); the server can't tell which. */
    | { readonly kind: 'invite-used'; readonly status: number }
    /** 400 PASSWORD_TOO_SHORT or PASSWORD_TOO_LONG: the server's own length rule. */
    | { readonly kind: 'weak-password'; readonly status: number; readonly rule: 'too-short' | 'too-long' }
    /** 400 USER_NOT_FOUND: the account the invite was for is gone. */
    | { readonly kind: 'no-account'; readonly status: number }
    /** A 429: 10 a minute from this address. */
    | { readonly kind: 'rate-limited'; readonly status: number; readonly retryAfterSeconds: number | null }
    | { readonly kind: 'unreachable'; readonly status: null }
    | { readonly kind: 'server-error'; readonly status: number }
    /** Anything else (a 404 where passwords are off, an answer that can't be read). */
    | { readonly kind: 'unknown'; readonly status: number | null };

export type SetPasswordResult = { readonly ok: true } | { readonly ok: false; readonly problem: SetPasswordProblem };

export interface SetPasswordOptions {
    readonly origin: string;
    readonly token: string;
    readonly password: string;
    readonly fetch: FetchFunction;
    readonly userAgent: string;
    readonly signal?: AbortSignal;
}

const SECONDS = /^\d{1,9}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Sets the invite's password at `origin`: one request, no cookie sent or kept (a fresh jar in memory,
 * discarded after). Resolves with whether it took; rejects only with AbortedError. The token and the
 * password go into the request's body and nowhere else.
 */
export async function setPasswordFromInvite(options: SetPasswordOptions): Promise<SetPasswordResult> {
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
            answer = await request(RESET_PASSWORD_PATH, {
                method: 'POST',
                json: { newPassword: options.password, token: options.token },
            });
        } catch (error) {
            onlyAbort(error);
            return {
                ok: false,
                problem: error instanceof NetworkError ? { kind: 'unreachable', status: null } : unknown(null),
            };
        }
        const { status } = answer;
        let body: unknown = null;
        try {
            body = await readJson(answer, scope.signal);
        } catch (error) {
            onlyAbort(error);
            await readText(answer, scope.signal).catch(onlyAbort);
        }
        if (answer.ok) {
            const done = typeof body === 'object' && body !== null && (body as { status?: unknown }).status === true;
            return done ? { ok: true } : { ok: false, problem: unknown(status) };
        }
        if (status === 429) {
            const wait = ['x-retry-after', 'retry-after']
                .map((name) => answer.headers.get(name)?.trim())
                .find((value) => value !== undefined && SECONDS.test(value));
            return {
                ok: false,
                problem: { kind: 'rate-limited', status, retryAfterSeconds: wait === undefined ? null : Number(wait) },
            };
        }
        const code =
            typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
                ? (body as { code: string }).code
                : null;
        if (code !== null && CODE.test(code)) {
            switch (code) {
                case 'INVALID_TOKEN':
                    return { ok: false, problem: { kind: 'invite-used', status } };
                case 'PASSWORD_TOO_SHORT':
                    return { ok: false, problem: { kind: 'weak-password', status, rule: 'too-short' } };
                case 'PASSWORD_TOO_LONG':
                    return { ok: false, problem: { kind: 'weak-password', status, rule: 'too-long' } };
                case 'USER_NOT_FOUND':
                    return { ok: false, problem: { kind: 'no-account', status } };
            }
        }
        return { ok: false, problem: status >= 500 ? { kind: 'server-error', status } : unknown(status) };
    } finally {
        signal?.removeEventListener('abort', stop);
        scope.abort();
        await jar.close().catch(() => undefined);
    }
}

const unknown = (status: number | null): SetPasswordProblem => ({ kind: 'unknown', status });

function onlyAbort(error: unknown): void {
    if (error instanceof AbortedError) {
        throw error;
    }
}

// ---------------------------------------------------------------------------
// The words: plain, for people who aren't technical; "device", never "phone".

/** The Join step's question, as a screen reader says it; the screen draws the host with WorkspaceHost. */
export const joinQuestion = (name: string, host: string) => `Join ${name} (${host})?`;
/** The Join step's title beside the host. */
export const joinTitle = (name: string) => `Join ${name}?`;
export const JOIN_LINE = 'You were invited to this workspace. Choose a password to finish joining.';

/**
 * A workspace of the same name is already on this device: at another host (a look-alike, or the
 * same company somewhere else), or this very one.
 */
export function sameNameWarning(name: string, otherHost: string | null): string {
    return otherHost === null
        ? `${name} is already on this device. Joining signs you in to it with this invite.`
        : `A workspace called ${name} is already on this device, at ${otherHost}. Check the address above before you join.`;
}

export const PASSWORD_TITLE = 'Choose a password';
export const PASSWORD_LINE = `At least ${MIN_PASSWORD_LENGTH} characters. This invite works once.`;
export const EMAIL_HINT = 'The email your invite was sent to.';

/** A new password the form won't send, in words. */
export function passwordRuleLine(rule: PasswordRule): string {
    switch (rule) {
        case 'too-short':
            return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        case 'too-long':
            return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
        case 'differ':
            return "The passwords don't match. Type the same one twice.";
    }
}

export const INVITE_USED = 'This invite was already used or has run out. Ask your admin for a new one.';
export const INVITE_NO_ACCOUNT = 'The account this invite was for no longer exists. Ask your admin.';
export const INVITE_PASSWORD_OFF =
    "This workspace doesn't use passwords, so this invite can't set one. Ask your admin how to sign in.";
export const INVITE_GENERIC = "Couldn't set your password. Try again, or ask your admin for a new invite.";
/** The link's workspace couldn't be checked (an error on this device, not the server's answer). */
export const CANT_CHECK_INVITE = "Couldn't check this workspace. Open the invite link again.";
/** The password is set but signing in with it didn't work: the email is asked again. */
export const PASSWORD_SET_LINE = 'Your password is set. Sign in with it to finish.';

/** The line for a password that wasn't set, and whether the invite is spent (the form goes). */
export function setPasswordLine(problem: SetPasswordProblem): { readonly line: string; readonly spent: boolean } {
    switch (problem.kind) {
        case 'invite-used':
            return { line: INVITE_USED, spent: true };
        case 'no-account':
            return { line: INVITE_NO_ACCOUNT, spent: true };
        case 'weak-password':
            return { line: passwordRuleLine(problem.rule), spent: false };
        case 'rate-limited':
            return {
                line: `Too many tries. Wait ${waitText(problem.retryAfterSeconds)}, then try again.`,
                spent: false,
            };
        case 'unreachable':
            return { line: UNREACHABLE, spent: false };
        case 'server-error':
            return { line: SERVER_ERROR, spent: false };
        case 'unknown':
            return { line: INVITE_GENERIC, spent: false };
    }
}
