// The workspace's Better Auth session, as the device sees it.

/**
 * Better Auth's cookie prefix, `cb` (src/server/auth/better-auth.ts, COOKIE_PREFIX):
 * over https the server names the session cookie `__Host-cb.session_token`
 * (src/server/auth/host-cookies.ts), over http (a local server) `cb.session_token`.
 */
const SESSION_TOKEN = 'cb.session_token';

/** The session cookie's name on `origin`, an exact origin (`https://brain.example.com`). */
export function sessionCookieName(origin: string): string {
    return origin.startsWith('https:') ? `__Host-${SESSION_TOKEN}` : SESSION_TOKEN;
}

/**
 * How often Better Auth renews a session: at most once a day (`updateAge`,
 * src/server/auth/better-auth.ts), each renewal moving its expiry to seven days
 * from then. So a real slide moves the expiry a day or more.
 */
export const SESSION_RENEW_MS = 24 * 60 * 60 * 1000;
/** Two expiries read from Date headers, whole seconds both, can be up to a second off each other; this allows two. */
const DATE_SLACK_MS = 2000;

/**
 * The expiry to keep when the session cookie is set again, both in server
 * time. Better Auth also sets the session cookie with the full
 * `Max-Age=604800` when it doesn't move the session's expiry: update-user does
 * (a name change; better-auth 1.7.10's setSessionCookie always
 * writes `expiresIn`), as do update-session and email verification. Taking that
 * Max-Age would put the device's expiry up to a day past the server's, and a
 * 401 in that day, once the person went idle, would read as Ended and lock the
 * copy, where it is Expired. So the same token, moved later by less than a
 * renewal can move it, keeps the expiry held. A new token, a move earlier, or a
 * day or more later (a slide) is taken as it comes.
 */
export function sessionExpiry(
    held: { readonly value: string; readonly expiresAt: number | null },
    given: { readonly value: string; readonly expiresAt: number | null },
): number | null {
    const resetOnly =
        held.value === given.value &&
        held.expiresAt !== null &&
        given.expiresAt !== null &&
        given.expiresAt > held.expiresAt &&
        given.expiresAt - held.expiresAt < SESSION_RENEW_MS - DATE_SLACK_MS;
    return resetOnly ? held.expiresAt : given.expiresAt;
}

/**
 * How a session ended, from a 401 (and the server's device codes):
 * - `expired`: it went idle past its stored expiry. Everything stays readable
 *   and writes wait for the person to sign in again;
 * - `ended`: something ended it before then (sign-out everywhere, an admin, the
 *   access policy, "Sign out this device"; on an older server a deactivated
 *   account too). The copy locks and is kept;
 * - `device-revoked`: "Sign out and erase" on the web. The copy is wiped, in silence;
 * - `deactivated`: the person's account was deactivated. The copy is wiped, in silence.
 * The last two come only from the server's code (`device_revoked`,
 * `deactivated`), which it gives only to a request with an install id.
 */
export type SessionEnd = 'expired' | 'ended' | 'device-revoked' | 'deactivated';

/** Whether a SessionEnd wipes the copy. */
export const wipesCopy = (end: SessionEnd): end is 'device-revoked' | 'deactivated' =>
    end === 'device-revoked' || end === 'deactivated';

/** The server's 401 codes (@socio/shared/device-sign-in's DEVICE_ERROR_CODES), by what each means. A Map: no prototype keys. */
const SESSION_CODES: ReadonlyMap<string, SessionEnd> = new Map<string, SessionEnd>([
    ['session_expired', 'expired'],
    ['session_ended', 'ended'],
    ['device_revoked', 'device-revoked'],
    ['deactivated', 'deactivated'],
]);

/**
 * What a 401's JSON `code` says, or null for none of those (the web's
 * `sign_in`, any other, or none): then the stored expiry decides. `withheld`
 * is a request the jar sent without the session cookie it judged expired: the
 * server never saw it, so `session_ended` there is still `expired`, as the
 * expiry rule has it; the two wipes stand, since they are about the install
 * id, not the cookie (the server refuses a revoked install id with or without
 * a session).
 */
export function sessionEndOf(code: string | null, withheld: boolean): SessionEnd | null {
    const end = code === null ? undefined : SESSION_CODES.get(code);
    if (end === undefined) {
        return null;
    }
    return withheld && end === 'ended' ? 'expired' : end;
}

/**
 * What a 401 for a request whose session cookie the server saw means, from
 * the session's last known expiry (server time) as the request went: neither
 * that 401's clearing cookie nor an earlier one may erase it first. `serverNow`
 * is the server's time for the 401, from its Date header. With no known expiry
 * it is `ended`, the state that locks the copy. A request the jar sent without
 * the session cookie, which it held but judged expired, is never `ended`: the
 * server never saw the cookie (authedFetch).
 */
export function classifyUnauthorized(expiresAt: number | null, serverNow: number): SessionEnd {
    return expiresAt !== null && serverNow >= expiresAt ? 'expired' : 'ended';
}
