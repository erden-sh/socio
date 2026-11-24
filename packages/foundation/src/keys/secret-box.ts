import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import type { SealPurposeName } from '@socio/shared/types';

/**
 * The keys a `SecretBox` seals and opens with (CB-62). New seals use
 * `current` (DATA_ENCRYPTION_KEY) when it is set, else the legacy key
 * derived from SESSION_SECRET. Reads take any of the three.
 */
export interface DataKeyring {
    /** DATA_ENCRYPTION_KEY: 32 random bytes. */
    current?: Uint8Array;
    /** DATA_ENCRYPTION_KEY_PREVIOUS: read only, while a rotation re-seals. */
    previous?: Uint8Array;
    /** SESSION_SECRET (or the process's own): the legacy key derives from it. */
    legacy: string;
}

/** What a seal is for: each purpose has keys of its own. */
export type SealPurpose = SealPurposeName;

/** Every seal purpose, in the order Service setup and the key check list them (CB-322). */
export const SEAL_PURPOSES: readonly SealPurpose[] = [
    'inference-credentials',
    'data-files',
    'backups',
    'push-keys',
    // The GitHub App's stored key (src/server/github/settings.ts). It keeps
    // dispatch's old name (CB-325): the purpose derives the keys, so a new
    // name would leave every saved App unreadable.
    'dispatch-credentials',
    'settings-secrets',
    'mcp-credentials',
    // Socio Secrets: every version of
    // every workload secret, deleted ones too, until retention ends.
    'workspace-secrets',
    // CB-326 step 6: coding session gateway exchange bodies, sealed in the
    // object store, soft-deleted with the session.
    'gateway-log',
];

/**
 * A re-seal yields to the event loop after this many values (CB-322,
 * CB-318): opening and sealing is synchronous, so a long run in one go
 * would stall every request.
 */
export const RESEAL_BATCH = 25;

/** The key name of seals under the SESSION_SECRET-derived key. */
export const LEGACY_KEY = 'legacy';

/** Which key sealed something, as this server sees it. */
export type SealState = 'current' | 'previous' | 'legacy' | 'unknown';

const V1 = 'v1.';
const V2 = /^v2\.([0-9a-f]{16})\./;
const CBF1 = Buffer.from('CBF1', 'ascii');
const CBF2 = Buffer.from('CBF2', 'ascii');
const KID = 8;
/** `CBF2` | key id: also authenticated, as the AAD's start. */
const HEADER = 4 + KID;
/** The GCM tag's length. */
const TAG = 16;
/** The most a seal's start (header, IV and tag) takes: what `beginOpen` needs. */
export const SEALED_START = HEADER + 12 + TAG;

/**
 * A data key's id: 16 hex characters from an HMAC of the key, so seals can
 * name their key without revealing anything about it.
 */
export function dataKeyId(key: Uint8Array) {
    return createHmac('sha256', key)
        .update('company-brain data key id')
        .digest('hex')
        .slice(0, KID * 2);
}

const derive = (secret: string | Uint8Array, info: string) =>
    Buffer.from(hkdfSync('sha256', secret, 'company-brain', info, 32));

/**
 * Encrypts secrets at rest with AES-256-GCM: inference secrets (backend API
 * keys, users' subscription tokens), the data space's files and off-site
 * backups. Keys come from HKDF, per purpose.
 *
 * Formats: `v2.<key id>.<base64url iv|tag|ciphertext>` for values and
 * `CBF2` | key id | iv | tag | ciphertext for bytes, under a data key; the
 * legacy `v1.` and `CBF1` (no key id) under the key from SESSION_SECRET.
 * Without a data key, new seals stay legacy, so rotating SESSION_SECRET
 * then still makes them unreadable.
 */
export class SecretBox {
    private legacyKey: Buffer;
    private keys = new Map<string, Buffer>();
    /** The id new seals name, or `legacy`. */
    readonly currentKey: string;
    readonly previousKey?: string;
    constructor(keys: DataKeyring | string, purpose: SealPurpose = 'inference-credentials') {
        const ring = typeof keys === 'string' ? { legacy: keys } : keys;
        if (!ring.legacy) {
            throw new Error('SecretBox needs a secret.');
        }
        this.legacyKey = derive(ring.legacy, `${purpose} v1`);
        for (const key of [ring.previous, ring.current]) {
            if (key) {
                this.keys.set(dataKeyId(key), derive(key, `${purpose} v2`));
            }
        }
        this.currentKey = ring.current ? dataKeyId(ring.current) : LEGACY_KEY;
        const previous = ring.previous && dataKeyId(ring.previous);
        if (previous && previous !== this.currentKey) {
            this.previousKey = previous;
        }
    }
    /**
     * Overwrites the derived keys with zeros (CB-322): a box made for a
     * one-off check (a recovery key from escrow) is useless after this.
     */
    dispose() {
        this.legacyKey.fill(0);
        for (const key of this.keys.values()) {
            key.fill(0);
        }
        this.keys.clear();
    }
    /** Whether a key (an id, or `legacy`) is the current one, the previous one, … */
    state(key: string | undefined): SealState {
        if (key === this.currentKey) {
            return 'current';
        }
        if (key === LEGACY_KEY) {
            return 'legacy';
        }
        if (key && key === this.previousKey) {
            return 'previous';
        }
        return 'unknown';
    }
    private key(id: string) {
        const key = id === LEGACY_KEY ? this.legacyKey : this.keys.get(id);
        if (!key) {
            throw new Error('Sealed under a data key this server doesn’t have.');
        }
        return key;
    }

    /**
     * Encrypts bytes (the data space's files), bound to `context` (the
     * file's owner and id), so a file can't be swapped for another.
     */
    sealBytes(data: Uint8Array, context: string): Buffer {
        const { start, cipher } = this.beginSeal(context);
        const body = Buffer.concat([cipher.update(data), cipher.final()]);
        return Buffer.concat([start, cipher.getAuthTag(), body]);
    }
    /**
     * A seal a chunk at a time (`sealed-files.ts`, CB-378): what it starts
     * with (the header and the IV), then the tag once `cipher` is final,
     * then the ciphertext. `sealBytes` in one go.
     */
    beginSeal(context: string) {
        const iv = randomBytes(12);
        const legacy = this.currentKey === LEGACY_KEY;
        const header = legacy ? CBF1 : Buffer.concat([CBF2, Buffer.from(this.currentKey, 'hex')]);
        const cipher = createCipheriv('aes-256-gcm', this.key(this.currentKey), iv);
        cipher.setAAD(legacy ? Buffer.from(context, 'utf8') : Buffer.concat([header, Buffer.from(context, 'utf8')]));
        return { start: Buffer.concat([header, iv]), cipher };
    }
    /** The key sealed bytes name (`legacy` for `CBF1`); undefined for other bytes. */
    bytesKey(sealed: Uint8Array): string | undefined {
        const raw = Buffer.from(sealed);
        if (raw.length >= 32 && raw.subarray(0, 4).equals(CBF1)) {
            return LEGACY_KEY;
        }
        if (raw.length >= HEADER + 28 && raw.subarray(0, 4).equals(CBF2)) {
            return raw.subarray(4, HEADER).toString('hex');
        }
        return undefined;
    }
    /** The sealed bytes; throws when sealed under another key or context. */
    openBytes(sealed: Uint8Array, context: string): Buffer {
        const raw = Buffer.from(sealed);
        const { decipher, body } = this.beginOpen(raw, context);
        return Buffer.concat([decipher.update(raw.subarray(body)), decipher.final()]);
    }
    /**
     * The decipher for sealed bytes that start with `head` (their first
     * SEALED_START bytes, or all of them), and where their ciphertext
     * starts: an open a chunk at a time (`sealed-files.ts`, CB-378).
     */
    beginOpen(head: Buffer, context: string) {
        const id = this.bytesKey(head);
        if (!id) {
            throw new Error('Unknown sealed file format.');
        }
        const start = id === LEGACY_KEY ? 4 : HEADER;
        const decipher = createDecipheriv('aes-256-gcm', this.key(id), head.subarray(start, start + 12));
        decipher.setAAD(
            id === LEGACY_KEY
                ? Buffer.from(context, 'utf8')
                : Buffer.concat([head.subarray(0, HEADER), Buffer.from(context, 'utf8')]),
        );
        decipher.setAuthTag(head.subarray(start + 12, start + 12 + TAG));
        return { decipher, body: start + 12 + TAG };
    }
    /** Sealed again under the current key; undefined when it already is. */
    resealBytes(sealed: Uint8Array, context: string): Buffer | undefined {
        if (this.bytesKey(sealed) === this.currentKey) {
            return undefined;
        }
        return this.sealBytes(this.openBytes(sealed, context), context);
    }

    /** JSON-encodes and encrypts a value. */
    seal(value: unknown): string {
        const iv = randomBytes(12);
        const legacy = this.currentKey === LEGACY_KEY;
        const prefix = legacy ? V1 : `v2.${this.currentKey}.`;
        const cipher = createCipheriv('aes-256-gcm', this.key(this.currentKey), iv);
        if (!legacy) {
            cipher.setAAD(Buffer.from(prefix, 'ascii'));
        }
        const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    }
    /** The key a sealed value names (`legacy` for `v1.`); undefined for other text. */
    valueKey(sealed: string): string | undefined {
        if (sealed.startsWith(V1)) {
            return LEGACY_KEY;
        }
        return sealed.match(V2)?.[1];
    }
    /** The sealed value; throws when it was sealed under another key. */
    open(sealed: string): unknown {
        const id = this.valueKey(sealed);
        if (!id) {
            throw new Error('Unknown sealed value format.');
        }
        const prefix = id === LEGACY_KEY ? V1 : `v2.${id}.`;
        const raw = Buffer.from(sealed.slice(prefix.length), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.key(id), raw.subarray(0, 12));
        if (id !== LEGACY_KEY) {
            decipher.setAAD(Buffer.from(prefix, 'ascii'));
        }
        decipher.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    }
    /** Sealed again under the current key; undefined when it already is. */
    reseal(sealed: string): string | undefined {
        if (this.valueKey(sealed) === this.currentKey) {
            return undefined;
        }
        return this.seal(this.open(sealed));
    }
}
