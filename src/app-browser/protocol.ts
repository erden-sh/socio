import {
    createCipheriv,
    createDecipheriv,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    type KeyObject,
} from 'node:crypto';

import { z } from 'zod';

/**
 * What Socio, the app browser's router and its context workers say to
 * each other (CB-232). Imports only `node:crypto` and zod:
 * the server, the router and the workers all load it.
 *
 * The router never holds a credential. Each worker makes an X25519 key
 * pair when it starts and the router relays only its public key; Socio
 * seals the context's `cbsa_` and context key to that key
 * (`sealForWorker`), the router relays the sealed bytes, and only the
 * worker opens them (`openSealed`). A worker can't open another's.
 */

/** A context id as Socio makes them (`randomUUID`). */
export const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A grant id: the same shape. */
export const GRANT_ID = CONTEXT_ID;

/** Per-action limit: the browser service's 40 s. */
export const ACTION_TIMEOUT_MS = 40_000;
/** Contexts idle this long are closed by the router. */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** Snapshot text at most this long, as the computer tools' (30 000 chars). */
export const SNAPSHOT_CHARS = 30_000;

// ---------------------------------------------------------------------------
// Sealing: X25519 + HKDF-SHA256 + AES-256-GCM, a fresh ephemeral key per
// message, bound to the context id (as associated data and in the KDF).

const SEAL_INFO = 'socio-app-browser-seal\u0000v1\u0000';
const B64 = /^[A-Za-z0-9_-]+$/;

export interface WorkerKeys {
    /** The worker's X25519 public key, SPKI DER, base64url. */
    publicKey: string;
    privateKey: KeyObject;
}

export function workerKeyPair(): WorkerKeys {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        privateKey,
    };
}

const publicKeyOf = (spki: string) => {
    if (!B64.test(spki) || spki.length > 200) {
        throw new Error('Invalid worker key.');
    }
    const key = createPublicKey({
        key: Buffer.from(spki, 'base64url'),
        format: 'der',
        type: 'spki',
    });
    if (key.asymmetricKeyType !== 'x25519') {
        throw new Error('Invalid worker key.');
    }
    return key;
};

const sealKey = (shared: Buffer, ephemeral: string, recipient: string, contextId: string) =>
    Buffer.from(hkdfSync('sha256', shared, Buffer.from(`${ephemeral}.${recipient}`), SEAL_INFO + contextId, 32));

/** `v1.<ephemeral spki>.<nonce>.<ciphertext‖tag>`, all base64url. */
export const SEALED = /^v1\.([A-Za-z0-9_-]{40,200})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,8192})$/;

/** Seals `payload` so only the worker holding `workerKey` opens it. */
export function sealForWorker(workerKey: string, contextId: string, payload: unknown) {
    const recipient = publicKeyOf(workerKey);
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeral = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const key = sealKey(diffieHellman({ privateKey, publicKey: recipient }), ephemeral, workerKey, contextId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(contextId));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
    return `v1.${ephemeral}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

/** The sealed payload, or undefined if it isn't this worker's or context's. */
export function openSealed(keys: WorkerKeys, contextId: string, sealed: string): unknown {
    const match = SEALED.exec(sealed);
    if (!match) {
        return undefined;
    }
    try {
        const [, ephemeral, nonce, body] = match;
        const key = sealKey(
            diffieHellman({
                privateKey: keys.privateKey,
                publicKey: publicKeyOf(ephemeral),
            }),
            ephemeral,
            keys.publicKey,
            contextId,
        );
        const raw = Buffer.from(body, 'base64url');
        if (raw.length < 17) {
            return undefined;
        }
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
        decipher.setAAD(Buffer.from(contextId));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
        return JSON.parse(plain.toString('utf8'));
    } catch {
        return undefined;
    }
}

/** What Socio seals for a worker: its context's credential and key. */
export const contextSecretSchema = z
    .object({
        /** The context's `cbsa_`. */
        token: z.string().regex(/^cbsa_[A-Za-z0-9_-]{43}$/),
        /** `contextKey(secret, contextId)`, base64url. */
        key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: z.number().int().positive(),
    })
    .strict();
export type ContextSecret = z.infer<typeof contextSecretSchema>;

// ---------------------------------------------------------------------------
// Commands: what the `app_*` tools ask a context to do. The router checks
// their shape and relays them; it understands nothing else of them.

const ref = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
/**
 * A path on the context's one app origin: absolute, never protocol
 * relative, no backslashes or control characters, nothing a URL could
 * read as another origin.
 */
export const appPath = z
    .string()
    .max(2048)
    .regex(/^\/(?![/\\])[^\\\s\p{Cc}]*$/u, 'A path on the app, like /deals?stage=open.');

export const commandSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('open'), path: appPath }).strict(),
    z.object({ op: z.literal('snapshot') }).strict(),
    z
        .object({
            op: z.literal('click'),
            ref,
            snapshotId: z.number().int().nonnegative(),
        })
        .strict(),
    z
        .object({
            op: z.literal('type'),
            ref,
            snapshotId: z.number().int().nonnegative(),
            text: z.string().max(16_000),
            submit: z.boolean().optional(),
        })
        .strict(),
    z.object({ op: z.literal('screenshot') }).strict(),
    /** The start-up self-test: is the renderer sandboxed? */
    z.object({ op: z.literal('sandbox') }).strict(),
]);
export type BrowserCommand = z.infer<typeof commandSchema>;

/** What a worker answers a command with; `error` text is the worker's own. */
export type CommandResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** Router ⇄ worker: line-delimited JSON on the worker's stdin and stdout. */
export type WorkerRequest =
    | {
          id: number;
          type: 'init';
          contextId: string;
          origin: string;
          upstream: string;
      }
    | { id: number; type: 'credential'; sealed: string }
    | { id: number; type: 'command'; command: BrowserCommand };
/** A request before the router numbers it. */
export type WorkerMessage = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;
export type WorkerReply = { type: 'ready'; publicKey: string } | ({ id: number } & CommandResult);

/**
 * The app's public origin a context is locked to: `http(s)://host[:port]`
 * with no path, credentials or anything else.
 */
export function parseAppOrigin(value: string): URL | undefined {
    try {
        const url = new URL(value);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.origin !== value ||
            !url.hostname
        ) {
            return undefined;
        }
        return url;
    } catch {
        return undefined;
    }
}
