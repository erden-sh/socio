import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The actor envelope (`x-cb-actor`, CB-232): what an app
 * process sees on every request through the apps proxy, for a person or a
 * socio session alike.
 *
 *   x-cb-actor: v1.<base64url(claims JSON)>.<base64url(HMAC-SHA256(appKey,
 *               "socio-actor-envelope\0v1\0" + claimsB64))>
 *
 * The apps proxy signs it (`proxy.ts`); the app SDK
 * (packages/app-sdk) verifies it. This file is the one codec both use: the
 * SDK's `envelope.ts` is a byte-identical copy (tests/app-sdk.test.ts
 * checks), so it imports nothing but `node:crypto`.
 *
 * The envelope is identity for the app's own logic. It grants nothing at
 * Socio: the app holds its key and could mint envelopes for itself, which
 * is why Socio's APIs take the `obo` token instead.
 *
 * The host envelope (CB-458) is Socio itself calling a plugin on the
 * reserved `/__cb/` prefix (backups, restores): `sub` and `acc` are `host`,
 * with no session, person, socio or token.
 * `openEnvelope` never opens one and `openHostEnvelope` opens nothing
 * else, and only for a `/__cb/` request-target, so a person's or a socio's
 * envelope never opens the host's routes and the host's never opens a
 * person's. Only Socio's server signs one; the apps proxy never does.
 */

export const ACTOR_ENVELOPE_HEADER = 'x-cb-actor';
/** How long an envelope is good for. */
export const ENVELOPE_TTL_MS = 60_000;
/** Clock skew the verifier tolerates on `iat` and `exp`. */
export const ENVELOPE_SKEW_MS = 5_000;
/** The previous key's grace after a rotation. */
export const PREVIOUS_KEY_GRACE_MS = 5 * 60_000;

const MAC_LABEL = 'socio-actor-envelope\u0000v1\u0000';
const ENVELOPE = /^v1\.([A-Za-z0-9_-]{24,8192})\.([A-Za-z0-9_-]{43})$/;
const OPAQUE = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPES = ['app:read', 'app:write', 'app:act'];

/** What an envelope says. Times are epoch milliseconds. */
export interface EnvelopeClaims {
    /** The app id, or `plugin:<id>` for a plugin. */
    aud: string;
    /** The person's opaque per-app id (today's `x-cb-user`). */
    sub: string;
    /** The person's access to the app. */
    acc: 'owner' | 'space';
    /** Socio sessions only: the socio and its grant, opaque per app. */
    act?: { typ: 'socio'; id: string; grant: string };
    /** Socio sessions only: the grant's scopes for this audience. */
    scp?: string[];
    /** An opaque session id, for the app's own logs. */
    sid: string;
    /** The request's on-behalf-of token; absent when Socio has none. */
    obo?: string;
    /** This request: its method and base64url(SHA-256(request-target)). */
    req: { m: string; p: string };
    iat: number;
    exp: number;
    jti: string;
    /** The app version the proxy routed to; null for a development app. */
    ver: number | null;
}

/** What a host envelope says (CB-458): Socio itself, for one request. */
export interface HostEnvelopeClaims {
    /** `plugin:<id>`: host envelopes go to service plugins only. */
    aud: string;
    sub: 'host';
    acc: 'host';
    req: { m: string; p: string };
    iat: number;
    exp: number;
    jti: string;
}

export type EnvelopeFailure =
    | 'missing'
    | 'malformed'
    | 'bad_mac'
    | 'wrong_audience'
    | 'expired'
    | 'wrong_request'
    /** A host envelope off `/__cb/`, or anyone else's on it. */
    | 'wrong_kind';

/** The reserved prefix the host's calls use, and nothing else's. */
export const HOST_PATH_PREFIX = '/__cb/';
const HOST_KEYS = ['acc', 'aud', 'exp', 'iat', 'jti', 'req', 'sub'].join();

/**
 * Whether a request-target is the host's: its raw path is under `/__cb/`
 * with nothing that could decode or normalize elsewhere (no `%`, no
 * backslash, no `.` or `..` segment). Only these take a host envelope.
 */
export function isHostTarget(target: string) {
    const path = target.split(/[?#]/, 1)[0];
    return path.startsWith(HOST_PATH_PREFIX) && !/%|\\/.test(path) && !/(^|\/)\.\.?(\/|$)/.test(path);
}

/**
 * Whether a request-target could reach the reserved prefix in some router:
 * its path decoded, its backslashes as slashes and its case folded is
 * `/__cb` or under it, either as written (a router that leaves dot
 * segments alone, such as `/__cb/backup/../../deals`) or with its dot
 * segments resolved. No person's or socio's envelope opens one of these
 * (CB-458, defense in depth).
 */
export function isReservedTarget(target: string) {
    let path = target.split(/[?#]/, 1)[0].replace(/\\/g, '/');
    for (let round = 0; round < 3 && path.includes('%'); round += 1) {
        try {
            path = decodeURIComponent(path).replace(/\\/g, '/');
        } catch {
            // Undecodable: judge what there is.
            break;
        }
    }
    const written = path.split('/').find((segment) => segment !== '' && segment !== '.');
    if (written?.toLowerCase() === '__cb') {
        return true;
    }
    const segments: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '..') {
            segments.pop();
        } else if (segment !== '.' && segment !== '') {
            segments.push(segment);
        }
    }
    return segments[0]?.toLowerCase() === '__cb';
}

/**
 * `req.p`: base64url(SHA-256) of the exact request-target bytes (path and
 * query, as on the request line), never a decoded or normalized form.
 */
export function requestTargetHash(target: string) {
    return createHash('sha256').update(target, 'utf8').digest('base64url');
}

/** A fresh `jti`: 16 random bytes. */
export const newJti = () => randomBytes(16).toString('base64url');

const mac = (key: Uint8Array, claimsB64: string) =>
    createHmac('sha256', key)
        .update(MAC_LABEL + claimsB64)
        .digest('base64url');

function same(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** The header value for `claims` under the app's key. */
export function signEnvelope(key: Uint8Array, claims: EnvelopeClaims | HostEnvelopeClaims) {
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `v1.${body}.${mac(key, body)}`;
}

/** The claims' shape, or undefined: a verifier trusts nothing it can't type. */
function typed(raw: unknown): EnvelopeClaims | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const c = raw as Record<string, unknown>;
    const req = c.req as Record<string, unknown> | undefined;
    const act = c.act as Record<string, unknown> | undefined;
    const ok =
        typeof c.aud === 'string' &&
        typeof c.sub === 'string' &&
        OPAQUE.test(c.sub) &&
        (c.acc === 'owner' || c.acc === 'space') &&
        typeof c.sid === 'string' &&
        OPAQUE.test(c.sid) &&
        (c.obo === undefined || typeof c.obo === 'string') &&
        !!req &&
        typeof req.m === 'string' &&
        typeof req.p === 'string' &&
        Number.isSafeInteger(c.iat) &&
        Number.isSafeInteger(c.exp) &&
        typeof c.jti === 'string' &&
        OPAQUE.test(c.jti) &&
        (c.ver === null || Number.isSafeInteger(c.ver)) &&
        (act === undefined ||
            (act.typ === 'socio' &&
                typeof act.id === 'string' &&
                OPAQUE.test(act.id) &&
                typeof act.grant === 'string' &&
                OPAQUE.test(act.grant))) &&
        // A socio session always names its scopes; a person's never has any.
        (act === undefined
            ? c.scp === undefined
            : Array.isArray(c.scp) && c.scp.every((scope) => SCOPES.includes(scope as string)));
    return ok ? (raw as EnvelopeClaims) : undefined;
}

/** A host envelope's shape, exactly (no other claim), or undefined. */
function typedHost(raw: unknown): HostEnvelopeClaims | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const c = raw as Record<string, unknown>;
    const req = c.req as Record<string, unknown> | undefined;
    const ok =
        Object.keys(c).sort().join() === HOST_KEYS &&
        typeof c.aud === 'string' &&
        c.sub === 'host' &&
        c.acc === 'host' &&
        !!req &&
        typeof req === 'object' &&
        typeof req.m === 'string' &&
        typeof req.p === 'string' &&
        Number.isSafeInteger(c.iat) &&
        Number.isSafeInteger(c.exp) &&
        typeof c.jti === 'string' &&
        OPAQUE.test(c.jti);
    return ok ? (raw as HostEnvelopeClaims) : undefined;
}

type Expect = { aud: string; method: string; target: string; now?: number };

/** The MAC, then the claims: whichever kind they are, or undefined. */
function opened(
    keys: readonly Uint8Array[],
    header: string | null | undefined,
):
    | { ok: true; person?: EnvelopeClaims; host?: HostEnvelopeClaims }
    | { ok: false; reason: 'missing' | 'malformed' | 'bad_mac' } {
    if (!header) {
        return { ok: false, reason: 'missing' };
    }
    const match = ENVELOPE.exec(header);
    if (!match) {
        return { ok: false, reason: 'malformed' };
    }
    const [, body, given] = match;
    if (!keys.some((key) => same(given, mac(key, body)))) {
        return { ok: false, reason: 'bad_mac' };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const person = typed(raw);
    const host = person ? undefined : typedHost(raw);
    return person || host ? { ok: true, person, host } : { ok: false, reason: 'malformed' };
}

/** `aud`, the minute and the exact request, for either kind. */
function bound(claims: EnvelopeClaims | HostEnvelopeClaims, expect: Expect): EnvelopeFailure | undefined {
    if (claims.aud !== expect.aud) {
        return 'wrong_audience';
    }
    const now = expect.now ?? Date.now();
    if (
        claims.exp <= now - ENVELOPE_SKEW_MS ||
        claims.iat > now + ENVELOPE_SKEW_MS ||
        claims.exp - claims.iat > ENVELOPE_TTL_MS
    ) {
        return 'expired';
    }
    if (claims.req.m !== expect.method.toUpperCase() || !same(claims.req.p, requestTargetHash(expect.target))) {
        return 'wrong_request';
    }
    return undefined;
}

/**
 * Verifies an envelope for one request: version, MAC under one of
 * `keys` (constant-time), `aud`, `iat`/`exp` within 60 s plus 5 s skew,
 * and `req` equal to this request's method and raw request-target. The
 * `jti` replay check is the caller's (it needs state). A host envelope is
 * `wrong_kind` here, and so is any envelope for a target that could reach
 * `/__cb/` (`isReservedTarget`): those are `openHostEnvelope`'s.
 */
export function openEnvelope(
    keys: readonly Uint8Array[],
    header: string | null | undefined,
    expect: Expect,
): { ok: true; claims: EnvelopeClaims } | { ok: false; reason: EnvelopeFailure } {
    const result = opened(keys, header);
    if (!result.ok) {
        return result;
    }
    if (!result.person || isReservedTarget(expect.target)) {
        return { ok: false, reason: 'wrong_kind' };
    }
    const failure = bound(result.person, expect);
    return failure ? { ok: false, reason: failure } : { ok: true, claims: result.person };
}

/**
 * Verifies a host envelope (CB-458) as `openEnvelope` does a
 * person's, for a `/__cb/` request-target only (`isHostTarget`): any
 * other envelope, or any other target, is `wrong_kind`. The `jti` replay
 * check is the caller's.
 */
export function openHostEnvelope(
    keys: readonly Uint8Array[],
    header: string | null | undefined,
    expect: Expect,
): { ok: true; claims: HostEnvelopeClaims } | { ok: false; reason: EnvelopeFailure } {
    const result = opened(keys, header);
    if (!result.ok) {
        return result;
    }
    if (!result.host || !isHostTarget(expect.target)) {
        return { ok: false, reason: 'wrong_kind' };
    }
    const failure = bound(result.host, expect);
    return failure ? { ok: false, reason: failure } : { ok: true, claims: result.host };
}

/** A base64url key from the environment (`CB_ACTOR_KEY`), or undefined. */
export function envelopeKeyFrom(value: string | undefined) {
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
        return undefined;
    }
    return Buffer.from(value, 'base64url');
}
