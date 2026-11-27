/**
 * What the issuer signs, checked (protocol §2.5, §2.9): a compact JWS made
 * with one of the issuer's Ed25519 keys, of exactly the type the caller
 * expects. The type is never optional, so a statement of one kind (a
 * social sign-in's `social+jwt`, CB-570) can't pass as another (an access
 * token's `at+jwt`), nor the other way round. With `node:crypto` only.
 *
 * Only the signature and the header are checked here: the claims are each
 * caller's, which knows what they must say.
 */
import { verify, type KeyObject } from 'node:crypto';

/** Why a JWS was refused: the check that failed, for logs. Never the token or its claims. */
export type JwsCheck = 'format' | 'alg' | 'typ' | 'kid' | 'key' | 'signature' | 'claims';

export type JwsResult = { ok: true; claims: Record<string, unknown> } | { ok: false; check: JwsCheck };

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN = 16 * 1024;

function decode(segment: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Checks a compact JWS the issuer signed: `alg: EdDSA`, `typ` exactly
 * `typ`, no `crit`, a `kid` the issuer publishes (`key` finds it; it may
 * throw when the keys can't be read, which the caller handles), and the
 * signature over the first two segments.
 */
export async function verifyIssuerJws(
    token: string,
    expected: { typ: string; key: (kid: string) => Promise<KeyObject | undefined> },
): Promise<JwsResult> {
    if (token.length > MAX_TOKEN) {
        return { ok: false, check: 'format' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) {
        return { ok: false, check: 'format' };
    }
    const [h, p, s] = parts as [string, string, string];
    const header = decode(h);
    if (!header) {
        return { ok: false, check: 'format' };
    }
    if (header.alg !== 'EdDSA') {
        return { ok: false, check: 'alg' };
    }
    if (header.typ !== expected.typ || header.crit !== undefined) {
        return { ok: false, check: 'typ' };
    }
    if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) {
        return { ok: false, check: 'kid' };
    }
    const key = await expected.key(header.kid);
    if (!key) {
        return { ok: false, check: 'key' };
    }
    let valid = false;
    try {
        valid = verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    } catch {
        valid = false;
    }
    if (!valid) {
        return { ok: false, check: 'signature' };
    }
    const claims = decode(p);
    return claims ? { ok: true, claims } : { ok: false, check: 'claims' };
}
