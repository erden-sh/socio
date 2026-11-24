import { isWorkspaceId } from './layout';

// The app's secrets in secure storage: the registry's database key,
// each workspace's two database keys and its cookie jar. The platform
// binds expo-secure-store with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` in
// the app's own keychain group; tests bind a Map.
//
// - **Names come from hashes.** A workspace's names are `socio.<id>.<kind>`,
//   where `<id>` is its directory id (layout.ts), so no origin or user id is in
//   any name. Secure-store names allow only `[A-Za-z0-9._-]`.
// - **An index of every name the app writes.** expo-secure-store can't list
//   its items, and the iOS keychain survives a reinstall, so `socio.index`
//   holds the names. A name goes into the index before its value is written,
//   and leaves it only once it has no value: writes and index changes run in
//   turn, and `unindex` keeps a name whose value came back. So the index
//   always holds at least every name that has a value, and a reinstall finds
//   them all (store.ts).
// - **The index never shrinks by accident.** Its stored form is
//   `{ v, keys }`, where `keys` lists every name. A later version may add
//   fields, never take names out of `keys`: a build keeps a newer index's
//   fields and `v` when it changes `keys`, as the registry keeps a newer
//   build's columns (registry.ts). Contents it can't read (damaged, or
//   a newer form that broke that rule) are never read as empty: every
//   `socio.` name in them is kept, and the next change writes them back.
// - **A read error is not "no key".** `get` resolves null only for a name that
//   has no value; a keychain that can't be read yet (an iPhone before its first
//   unlock) throws, and nothing is deleted on a throw.

/** Secure storage, one value per name. */
export interface KeyStore {
    /** The value, or null when the name has none. Throws when the store can't be read. */
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    /** Deletes the value. Nothing happens when the name has none. */
    delete(name: string): Promise<void>;
}

/** `length` random bytes from a secure source: the platform binds `crypto.getRandomValues`. */
export type RandomBytes = (length: number) => Uint8Array;

/** The index of every name the app writes. */
export const INDEX_KEY = 'socio.index';
/** The registry's database key. */
export const REGISTRY_KEY = 'socio.registry';

/** A workspace's secrets: its two database keys, its cookie jar, its push relay registration and its install id. */
export type WorkspaceKey = 'cache' | 'user' | 'jar' | 'relay' | 'install';
/**
 * Every one of a workspace's names, in the order a wipe deletes them. `relay`
 * is its push relay registration's id and secret (src/push), written
 * before the relay is asked, so a retry after a kill makes the same one.
 * `install` is this install's id for the workspace (`newInstallId`),
 * sent only to its origin as `X-Socio-Install`: a wipe deletes it, so a copy
 * signed in again after a wipe is a new device to the server. An older build
 * doesn't know the name: its reconcile leaves it, and this build's deletes it
 * once no row is left for it (store.ts).
 */
export const WORKSPACE_KEYS: readonly WorkspaceKey[] = ['cache', 'user', 'jar', 'relay', 'install'];

/** The bytes in a database key: SQLCipher's raw 256-bit key. */
const DB_KEY_BYTES = 32;
const NAME = /^[A-Za-z0-9._-]+$/;
/** One of WORKSPACE_KEYS' names. */
const WORKSPACE_NAME = new RegExp(`^socio\\.([0-9a-f]{64})\\.(?:${WORKSPACE_KEYS.join('|')})$`);
/** The index's stored form's version. */
const INDEX_VERSION = 1;

/** The secure-store name of one of workspace `id`'s secrets: `socio.<id>.<kind>`. */
export function workspaceKeyName(id: string, kind: WorkspaceKey): string {
    if (!isWorkspaceId(id)) {
        throw new TypeError(`A workspace id is 64 lowercase hex characters, not "${id}".`);
    }
    return `socio.${id}.${kind}`;
}

/** Every secure-store name of workspace `id`. */
export function workspaceKeyNames(id: string): string[] {
    return WORKSPACE_KEYS.map((kind) => workspaceKeyName(id, kind));
}

/**
 * The workspace id in one of a workspace's names (`socio.<id>.cache`, `.user`,
 * `.jar`, `.relay` or `.install`), or null for any other name. Another kind isn't one: sign-out's
 * pending-revocation record must outlive its workspace's wipe, so launch's
 * reconcile (store.ts) leaves it.
 */
export function workspaceOfKey(name: string): string | null {
    return WORKSPACE_NAME.exec(name)?.[1] ?? null;
}

/** A new database key: 32 random bytes as 64 lowercase hex characters. */
export function newDbKey(randomBytes: RandomBytes): string {
    const bytes = randomBytes(DB_KEY_BYTES);
    if (bytes.length !== DB_KEY_BYTES) {
        throw new Error(`The random source gave ${bytes.length} bytes, not ${DB_KEY_BYTES}.`);
    }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The bytes in an install id (@socio/shared/device-sign-in's `installIdSchema`: 43 base64url characters). */
const INSTALL_ID_BYTES = 32;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A new install id for one workspace: 32 random bytes in unpadded
 * base64url. Each workspace gets its own, so no two workspaces (or anything
 * else) can tell they share a device.
 */
export function newInstallId(randomBytes: RandomBytes): string {
    const bytes = randomBytes(INSTALL_ID_BYTES);
    if (bytes.length !== INSTALL_ID_BYTES) {
        throw new Error(`The random source gave ${bytes.length} bytes, not ${INSTALL_ID_BYTES}.`);
    }
    let text = '';
    let held = 0;
    let bits = 0;
    for (const byte of bytes) {
        held = (held << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            text += BASE64URL[(held >> bits) & 63];
        }
        held &= (1 << bits) - 1;
    }
    return bits > 0 ? text + BASE64URL[(held << (6 - bits)) & 63] : text;
}

/** One secret's slot, the shape of a cookie jar's store (src/net's JarStore). */
export interface KeySlot {
    read(): Promise<string | null>;
    write(value: string): Promise<void>;
}

/** The app's secrets, each name indexed. */
export interface Keys {
    read(name: string): Promise<string | null>;
    /** Indexes the name, then writes the value, in turn with the index's changes, so no `unindex` passes it. */
    write(name: string, value: string): Promise<void>;
    /**
     * Makes a new database key and writes it under `name`, replacing any value
     * there: use it only for a file that doesn't exist yet. Resolves the key.
     */
    create(name: string): Promise<string>;
    /** Deletes the values; the index keeps the names (a wipe's step 4). */
    erase(names: readonly string[]): Promise<void>;
    /**
     * Takes each of the names that has no value out of the index (a wipe's
     * step 5). One written again since its erase stays, so a later cleanup
     * finds it. The index item goes once it is empty.
     */
    unindex(names: readonly string[]): Promise<void>;
    /** `erase`, then `unindex`. */
    delete(names: readonly string[]): Promise<void>;
    /** Every name in the index, sorted. */
    indexed(): Promise<string[]>;
    /** One name as a slot, for a workspace's cookie jar: writes go through `write`, so the name is indexed. */
    slot(name: string): KeySlot;
}

function checkName(name: string): string {
    if (!NAME.test(name) || name === INDEX_KEY) {
        throw new TypeError(`"${name}" isn't a name the app's secrets can have.`);
    }
    return name;
}

/** The index as last read: its names, and a newer build's version and fields, kept as they are. */
interface IndexState {
    readonly names: ReadonlySet<string>;
    /** Set when a newer build wrote the index: its `v` and the fields this build doesn't know. */
    readonly newer: { readonly v: number; readonly fields: Readonly<Record<string, unknown>> } | null;
}

/** Every `socio.` name in `text`: what a damaged or unknown index still says. */
function salvage(text: string): Set<string> {
    const found = text.match(/socio\.[A-Za-z0-9._-]+/g) ?? [];
    return new Set(found.filter((name) => NAME.test(name) && name !== INDEX_KEY));
}

/** The index's stored form, read. Contents it can't read keep every name in them (the header). */
function parseIndex(text: string | null): IndexState {
    if (text === null) {
        return { names: new Set(), newer: null };
    }
    let stored: unknown = null;
    try {
        stored = JSON.parse(text);
    } catch {
        // Damaged: salvaged below.
    }
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        const { v, keys, ...fields } = stored as Record<string, unknown>;
        const names = Array.isArray(keys) ? keys : null;
        if (
            typeof v === 'number' &&
            Number.isInteger(v) &&
            v >= 1 &&
            names?.every((name) => typeof name === 'string')
        ) {
            return { names: new Set(names as string[]), newer: v > INDEX_VERSION ? { v, fields } : null };
        }
    }
    return { names: salvage(text), newer: null };
}

/** `names` in the index's stored form, keeping a newer build's version and fields. */
function formatIndex(state: IndexState, names: ReadonlySet<string>): string {
    const keys = [...names].sort();
    return JSON.stringify(
        state.newer === null ? { v: INDEX_VERSION, keys } : { ...state.newer.fields, v: state.newer.v, keys },
    );
}

/**
 * The app's secrets on `store`. One per app: the index is kept in memory after
 * its first read, and its changes and the writes are queued, so none is lost
 * and none passes another.
 */
export function createKeys(store: KeyStore, randomBytes: RandomBytes): Keys {
    let queue: Promise<unknown> = Promise.resolve();
    /** The index as last read or written; null before the first read and after a failed write. */
    let cached: IndexState | null = null;

    const load = async (): Promise<IndexState> => {
        cached ??= parseIndex(await store.get(INDEX_KEY));
        return cached;
    };

    /** Runs after everything queued before it. */
    const queued = <T>(work: () => Promise<T>): Promise<T> => {
        const run = queue.then(work);
        queue = run.catch(() => {});
        return run;
    };

    /**
     * Changes the index, from inside the queue; `change` says whether it
     * changed anything, so there is something to write.
     */
    const changeIndex = async (change: (names: Set<string>) => boolean): Promise<void> => {
        const state = await load();
        const names = new Set(state.names);
        if (!change(names)) {
            return;
        }
        try {
            if (names.size === 0 && state.newer === null) {
                await store.delete(INDEX_KEY);
            } else {
                await store.set(INDEX_KEY, formatIndex(state, names));
            }
        } catch (error) {
            cached = null;
            throw error;
        }
        cached = { names, newer: state.newer };
    };

    const keys: Keys = {
        read: (name) => store.get(checkName(name)),
        write: async (name, value) => {
            checkName(name);
            await queued(async () => {
                await changeIndex((names) => {
                    const added = !names.has(name);
                    names.add(name);
                    return added;
                });
                await store.set(name, value);
            });
        },
        create: async (name) => {
            const key = newDbKey(randomBytes);
            await keys.write(name, key);
            return key;
        },
        erase: async (names) => {
            for (const name of names) {
                await store.delete(checkName(name));
            }
        },
        unindex: async (names) => {
            names.forEach(checkName);
            await queued(async () => {
                // A name written again since its erase keeps its entry: a value is never left unindexed.
                const empty: string[] = [];
                for (const name of names) {
                    if ((await store.get(name)) === null) {
                        empty.push(name);
                    }
                }
                await changeIndex((indexed) => {
                    const before = indexed.size;
                    for (const name of empty) {
                        indexed.delete(name);
                    }
                    return indexed.size !== before;
                });
            });
        },
        delete: async (names) => {
            await keys.erase(names);
            await keys.unindex(names);
        },
        indexed: () => queued(async () => [...(await load()).names].sort()),
        slot: (name) => {
            checkName(name);
            return { read: () => keys.read(name), write: (value) => keys.write(name, value) };
        },
    };
    return keys;
}
