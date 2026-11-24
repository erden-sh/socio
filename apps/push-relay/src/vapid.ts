// VAPID (RFC 8292) as a push service checks it: `Authorization: vapid t=<JWT>, k=<key>`, an ES256
// JWT signed by the key in `k`, for this relay's origin, expiring within 24 hours.

import { decode, encode } from './base64url';

/** RFC 8292 §2: `exp` no more than 24 hours ahead. A minute of slack for the sender's clock. */
const MAX_AHEAD_S = 24 * 60 * 60 + 60;

export type VapidCheck = { ok: true; key: string } | { ok: false; reason: string };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function jsonPart(part: string): Record<string, unknown> | undefined {
    const bytes = decode(part);
    if (!bytes) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(utf8.decode(bytes));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/** A raw uncompressed P-256 public key, in canonical base64url; undefined for anything else. */
export function canonicalKey(text: unknown): string | undefined {
    if (typeof text !== 'string' || text.length > 128) {
        return undefined;
    }
    const raw = decode(text);
    return raw && raw.length === 65 && raw[0] === 4 ? encode(raw) : undefined;
}

function parameters(value: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of value.split(',')) {
        const at = part.indexOf('=');
        if (at > 0) {
            out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
        }
    }
    return out;
}

/**
 * Checks a push request's Authorization header. `origin` is the relay's own origin (RELAY_ORIGIN):
 * web-push sets `aud` to the origin of the endpoint it was given, which the relay built from it.
 */
export async function checkVapid(header: string | null, origin: string, nowMs: number): Promise<VapidCheck> {
    const match = header?.match(/^vapid\s+(.+)$/i);
    if (!match) {
        return { ok: false, reason: 'no vapid authorization' };
    }
    const params = parameters(match[1]);
    const token = params.get('t');
    const key = canonicalKey(params.get('k'));
    if (!token || !key) {
        return { ok: false, reason: 'missing t or k' };
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
        return { ok: false, reason: 'malformed jwt' };
    }
    const head = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    const signature = decode(parts[2]);
    if (!head || !claims || !signature) {
        return { ok: false, reason: 'malformed jwt' };
    }
    if (head.alg !== 'ES256') {
        return { ok: false, reason: 'alg' };
    }
    let publicKey: CryptoKey;
    try {
        publicKey = await crypto.subtle.importKey(
            'raw',
            decode(key) as Uint8Array<ArrayBuffer>,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
        );
    } catch {
        return { ok: false, reason: 'bad key' };
    }
    const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature as Uint8Array<ArrayBuffer>,
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) {
        return { ok: false, reason: 'signature' };
    }
    if (claims.aud !== origin) {
        return { ok: false, reason: 'aud' };
    }
    const nowS = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowS || claims.exp > nowS + MAX_AHEAD_S) {
        return { ok: false, reason: 'exp' };
    }
    return { ok: true, key };
}
