/** Where the data space's sealed file bytes live (CB-54). */
export type StorageDriver = 'local' | 's3';

/**
 * A flat key-value store for sealed bytes: the local disk (dev, tests,
 * installs without S3) or any S3-compatible object store (SeaweedFS in the
 * bundled stack). Keys are opaque ids under a user's prefix (`keys.ts`), never file
 * names, and the bytes are already encrypted, so a store learns sizes only.
 */
export interface ObjectStore {
    readonly driver: StorageDriver;
    put(key: string, body: Uint8Array): Promise<void>;
    /** `undefined` when there is no such object. */
    get(key: string): Promise<Uint8Array | undefined>;
    /**
     * `put` of the file at `path`, streamed (CB-378): the backups send
     * files of any size with flat memory. Returns the bytes sent. A store
     * without it gets `put` with the whole file.
     */
    putFile?(key: string, path: string): Promise<number>;
    /**
     * `get` into the file at `path` (created 0600, replaced), streamed
     * (CB-378). Returns the bytes written, or `undefined` (nothing written)
     * when there is no such object. A store without it gets `get`.
     */
    getFile?(key: string, path: string): Promise<number | undefined>;
    head(key: string): Promise<{ size: number; etag?: string } | undefined>;
    /** Idempotent: deleting a missing object is fine. */
    delete(key: string): Promise<void>;
    /** Keys under `prefix`, in key order, a page at a time. */
    list(prefix: string, cursor?: string): Promise<{ keys: ListedObject[]; next?: string }>;
    /** The bucket exists (created if missing) or the directory is writable. */
    ensureReady(): Promise<void>;
}

/** A listed object: S3 gives its ETag and LastModified, the disk its mtime. */
export interface ListedObject {
    key: string;
    size: number;
    etag?: string;
    /** Milliseconds since the epoch. */
    modified?: number;
}

/** The store can't be reached or refused the request; the caller may retry later. */
export class StorageUnavailableError extends Error {
    readonly status = 503;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;

/**
 * Keys are built from ids (`keys.ts`), so anything else is a bug: refused
 * before it can name a path outside the store's root.
 */
export function checkKey(key: string) {
    if (!KEY.test(key) || key.includes('..') || key.split('/').some((segment) => !segment || segment === '.')) {
        throw new Error('Invalid object key.');
    }
    return key;
}

/** A list prefix: empty, or a key's start (it may end in `/`). */
export function checkPrefix(prefix: string) {
    if (prefix) {
        checkKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
    }
    return prefix;
}
