/**
 * The shapes of socio-actor reference tokens (CB-232):
 * `cbsa_` (an app browser context's), `cbgw_` (a coding prompt run's) and
 * continuations (`cbob_`): 32 random bytes, base64url, behind their
 * prefix. Moved from `src/server/actors/credentials.ts`, which re-exports
 * the prefixes; nothing here reads the database.
 */

export const ACTOR_CREDENTIAL_PREFIX = 'cbsa_';
export const GATEWAY_CREDENTIAL_PREFIX = 'cbgw_';
export const OBO_PREFIX = 'cbob_';

/** A reference token: its prefix and 43 base64url characters. */
export const REFERENCE_TOKEN = /^(cbsa_|cbgw_|cbob_)[A-Za-z0-9_-]{43}$/;

/**
 * Whether `token` is shaped as a continuation: a `cbob_` reference token
 * (no dot), not a sealed request `cbob_v1.<sealed>`.
 */
export function isContinuationToken(token: string | undefined) {
    return !!token && REFERENCE_TOKEN.test(token) && token.startsWith(OBO_PREFIX);
}
