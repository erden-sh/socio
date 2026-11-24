import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Key derivations and MAC codecs for socio-actor access (CB-232, CB-239).
 * Everything here is stateless and depends only on a secret every runtime
 * of a deploy holds, so any runtime verifies what any other made. Nothing here touches the database.
 *
 * Shared by the server and, for the coding egress proxy (CB-239), by
 * processes that import only this file: keep it free of other imports.
 */

/** A key for one purpose: HMAC-SHA256(secret, label \0 part \0 …). */
export function deriveKey(secret: string, label: string, ...parts: string[]) {
    return createHmac('sha256', secret)
        .update([label, ...parts].join('\u0000'))
        .digest();
}

const mac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('base64url');

/** Constant-time equality of two base64url strings. */
export function sameMac(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

export const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const sha256Base64url = (value: string | Buffer) => createHash('sha256').update(value).digest('base64url');

/** How far a proof's or stamp's timestamp may be from now. */
export const PROOF_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Context proof (`x-cb-context`): the app browser's worker signs each
// request with its context's key; the apps proxy recomputes it from the
// credential's `contextId`.

/** `contextKey = HMAC(serverSecret, "actor-context\0" + contextId)`. */
export const contextKey = (secret: string, contextId: string) => deriveKey(secret, 'actor-context', contextId);

export interface ProofRequest {
    method: string;
    host: string;
    /** The exact request-target bytes (path and query), as sent. */
    requestTarget: string;
    /** SHA-256 hex of the body; '' for none. */
    bodyDigest: string;
}

const proofText = (request: ProofRequest, ts: number) =>
    [
        request.method.toUpperCase(),
        request.host.toLowerCase(),
        request.requestTarget,
        request.bodyDigest,
        String(ts),
    ].join('\n');

/** The `x-cb-context` header value for one request. */
export function signContextProof(key: Buffer, request: ProofRequest, ts = Date.now()) {
    return `${ts}.${mac(key, proofText(request, ts))}`;
}

/** Whether a context proof is valid for the request now (no replay check). */
export function verifyContextProof(key: Buffer, header: string | undefined, request: ProofRequest, now = Date.now()) {
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    if (!match) {
        return false;
    }
    const ts = Number(match[1]);
    if (Math.abs(now - ts) > PROOF_WINDOW_MS) {
        return false;
    }
    return sameMac(match[2], mac(key, proofText(request, ts)));
}

// ---------------------------------------------------------------------------
// App envelope key: `HMAC(appsSecret, "app-envelope\0" + appId + "\0" +
// epoch)`. The envelope codec itself belongs to the apps proxy and the SDK.

export const appEnvelopeKey = (appsSecret: string, appId: string, epoch: number) =>
    deriveKey(appsSecret, 'app-envelope', appId, String(epoch));

// ---------------------------------------------------------------------------
// Coding gateway stamp (`x-cb-sandbox`, CB-239): the coding
// egress proxy adds it, the gateway listener checks it. Both
// derive the key from CODING_EGRESS_SECRET.

export const gatewayStampKey = (egressSecret: string) => deriveKey(egressSecret, 'coding-gateway-stamp');
/** The key the egress proxy credentials below are MAC'd with. */
export const egressCredentialKey = (egressSecret: string) => deriveKey(egressSecret, 'coding-egress-credential');

const SANDBOX_ID = /^[A-Za-z0-9_-]{1,64}$/;

const stampText = (sandboxId: string, ts: number, method: string, path: string) =>
    [sandboxId, String(ts), method.toUpperCase(), path].join('\n');

/** `<sandboxId>.<ts>.<HMAC(stampKey, sandboxId \n ts \n method \n path)>`. */
export function signGatewayStamp(key: Buffer, sandboxId: string, method: string, path: string, ts = Date.now()) {
    if (!SANDBOX_ID.test(sandboxId)) {
        throw new Error('Invalid sandbox id.');
    }
    return `${sandboxId}.${ts}.${mac(key, stampText(sandboxId, ts, method, path))}`;
}

/** The stamped sandbox id, or undefined when the stamp is invalid now. */
export function verifyGatewayStamp(
    key: Buffer,
    header: string | undefined,
    method: string,
    path: string,
    now = Date.now(),
): string | undefined {
    const match = /^([A-Za-z0-9_-]{1,64})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    if (!match) {
        return undefined;
    }
    const [, sandboxId, rawTs, given] = match;
    const ts = Number(rawTs);
    if (Math.abs(now - ts) > PROOF_WINDOW_MS) {
        return undefined;
    }
    return sameMac(given, mac(key, stampText(sandboxId, ts, method, path))) ? sandboxId : undefined;
}

// ---------------------------------------------------------------------------
// Coding egress proxy credential (CB-239): the user name carries the
// sandbox id, its allowlist, its network's subnet and an expiry; the
// password is a MAC over the user name.

export interface EgressCredentialClaims {
    sandboxId: string;
    /** Registry hosts the sandbox may reach (read-only), lowercase. */
    allow: string[];
    /** The sandbox network's IPv4 subnet in CIDR form, e.g. 172.30.4.0/28. */
    subnet: string;
    expiresAt: number;
}

export function signEgressCredential(key: Buffer, claims: EgressCredentialClaims) {
    if (!SANDBOX_ID.test(claims.sandboxId)) {
        throw new Error('Invalid sandbox id.');
    }
    const user = Buffer.from(
        JSON.stringify({
            s: claims.sandboxId,
            a: claims.allow,
            n: claims.subnet,
            e: claims.expiresAt,
        }),
    ).toString('base64url');
    return { user, password: mac(key, `egress\n${user}`) };
}

export function verifyEgressCredential(
    key: Buffer,
    user: string,
    password: string,
    now = Date.now(),
): EgressCredentialClaims | undefined {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(user)) {
        return undefined;
    }
    if (!sameMac(password, mac(key, `egress\n${user}`))) {
        return undefined;
    }
    try {
        const raw = JSON.parse(Buffer.from(user, 'base64url').toString('utf8')) as {
            s?: unknown;
            a?: unknown;
            n?: unknown;
            e?: unknown;
        };
        if (
            typeof raw.s !== 'string' ||
            !SANDBOX_ID.test(raw.s) ||
            !Array.isArray(raw.a) ||
            !raw.a.every((host) => typeof host === 'string') ||
            typeof raw.n !== 'string' ||
            typeof raw.e !== 'number' ||
            raw.e <= now
        ) {
            return undefined;
        }
        return {
            sandboxId: raw.s,
            allow: raw.a as string[],
            subnet: raw.n,
            expiresAt: raw.e,
        };
    } catch {
        return undefined;
    }
}
