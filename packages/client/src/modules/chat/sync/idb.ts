/**
 * Where the browser keeps synced data between visits (CB-136): one
 * IndexedDB database of rows grouped by scope (one chat's history is one
 * scope), for one person at a time.
 *
 * - Opening it for a person other than the one it holds empties it first,
 *   so one person's data never shows for another (`openSyncStore`).
 * - Signing out empties it (`clearSyncStore`).
 * - It is bounded: the scopes used longest ago go first, beyond a number
 *   of scopes or a total size; the newest one keeps its newest rows.
 *
 * Without IndexedDB (a private window that refuses it, the tests' jsdom)
 * nothing is kept: the stores work from memory and the server.
 */

export const SYNC_DB = 'socio-sync';
const VERSION = 1;
const ROWS = 'rows';
const SCOPES = 'scopes';
const META = 'meta';

/** A kept row: its scope, its key in it, its value and about its size. */
export interface StoredRow<T> {
    scope: string;
    key: number;
    value: T;
    size: number;
}
/** What is known of a scope as a whole. */
export interface ScopeRecord {
    scope: string;
    /** When it was last read or written: the bound drops the oldest. */
    usedAt: number;
    /** Each row's size, by key: the bound needs no row read. */
    sizes: Record<string, number>;
}

const sizeOf = (record: ScopeRecord) => Object.values(record.sizes).reduce((sum, size) => sum + size, 0);
export interface SyncBounds {
    /** At most this many scopes… */
    scopes: number;
    /** …of at most about this many characters in all. */
    size: number;
}

const request = <T>(req: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
const done = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
    });
const inScope = (scope: string) => IDBKeyRange.bound([scope, -Infinity], [scope, Infinity]);

let opening: Promise<IDBDatabase | undefined> | undefined;
function database(): Promise<IDBDatabase | undefined> {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(undefined);
    }
    opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
        let open: IDBOpenDBRequest;
        try {
            open = indexedDB.open(SYNC_DB, VERSION);
        } catch {
            return resolve(undefined);
        }
        open.onupgradeneeded = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(ROWS)) {
                db.createObjectStore(ROWS, { keyPath: ['scope', 'key'] });
            }
            if (!db.objectStoreNames.contains(SCOPES)) {
                db.createObjectStore(SCOPES, { keyPath: 'scope' });
            }
            if (!db.objectStoreNames.contains(META)) {
                db.createObjectStore(META, { keyPath: 'name' });
            }
        };
        open.onsuccess = () => {
            const db = open.result;
            // Another tab upgrading or deleting it: let it, and open again later.
            db.onversionchange = () => {
                db.close();
                opening = undefined;
            };
            resolve(db);
        };
        // Refused (a private window, storage off): work without it.
        open.onerror = () => resolve(undefined);
        open.onblocked = () => resolve(undefined);
    });
    return opening;
}

/** The rows and records of one person (`openSyncStore`). */
export class SyncStore {
    constructor(private db: IDBDatabase) {}

    /** A scope's rows, by key; marks it used (without waiting for that). */
    async read<T>(scope: string): Promise<StoredRow<T>[]> {
        // Read-only: a read-write transaction waits for its commit to disk.
        const tx = this.db.transaction(ROWS, 'readonly');
        const found = (await request(tx.objectStore(ROWS).getAll(inScope(scope)))) as StoredRow<T>[];
        void this.touch(scope).catch(() => {});
        return found;
    }

    private async touch(scope: string) {
        const tx = this.db.transaction(SCOPES, 'readwrite');
        const scopes = tx.objectStore(SCOPES);
        const record = (await request(scopes.get(scope))) as ScopeRecord | undefined;
        if (record) {
            scopes.put({ ...record, usedAt: Date.now() });
        }
        await done(tx);
    }

    /**
     * Writes `rows` to `scope` (over any with the same keys), after
     * dropping the keys in `drop` (or all of its rows: `'all'`), then keeps
     * the store within `bounds`, `scope` first.
     */
    async write<T>(scope: string, rows: readonly StoredRow<T>[], drop: readonly number[] | 'all', bounds: SyncBounds) {
        const tx = this.db.transaction([ROWS, SCOPES], 'readwrite');
        const store = tx.objectStore(ROWS);
        const scopes = tx.objectStore(SCOPES);
        const record = (await request(scopes.get(scope))) as ScopeRecord | undefined;
        const sizes = drop === 'all' ? {} : { ...record?.sizes };
        if (drop === 'all') {
            store.delete(inScope(scope));
        } else {
            for (const key of drop) {
                store.delete([scope, key]);
                delete sizes[key];
            }
        }
        for (const row of rows) {
            store.put(row);
            sizes[row.key] = row.size;
        }
        scopes.put({ scope, usedAt: Date.now(), sizes } satisfies ScopeRecord);
        await done(tx);
        await this.bound(scope, bounds);
    }

    /** Forgets a scope (its conversation is gone). */
    async drop(scope: string) {
        const tx = this.db.transaction([ROWS, SCOPES], 'readwrite');
        tx.objectStore(ROWS).delete(inScope(scope));
        tx.objectStore(SCOPES).delete(scope);
        await done(tx);
    }

    /**
     * Keeps at most `bounds.scopes` scopes of about `bounds.size` in all:
     * the ones used longest ago go. `keep` (the one just written) stays; if
     * it alone is too big, its lowest keys (a chat's oldest runs) go.
     */
    async bound(keep: string, bounds: SyncBounds) {
        const tx = this.db.transaction([ROWS, SCOPES], 'readwrite');
        const rows = tx.objectStore(ROWS);
        const scopes = tx.objectStore(SCOPES);
        const records = ((await request(scopes.getAll())) as ScopeRecord[]).sort(
            (a, b) => Number(b.scope === keep) - Number(a.scope === keep) || b.usedAt - a.usedAt,
        );
        let total = 0;
        for (const [index, record] of records.entries()) {
            const size = sizeOf(record);
            if (index === 0 && record.scope === keep && size > bounds.size) {
                const sizes = { ...record.sizes };
                let left = size;
                for (const key of Object.keys(sizes)
                    .map(Number)
                    .sort((a, b) => a - b)) {
                    if (left <= bounds.size) {
                        break;
                    }
                    rows.delete([keep, key]);
                    left -= sizes[key];
                    delete sizes[key];
                }
                scopes.put({ ...record, sizes });
                total = left;
                continue;
            }
            if (index < bounds.scopes && total + size <= bounds.size) {
                total += size;
                continue;
            }
            rows.delete(inScope(record.scope));
            scopes.delete(record.scope);
        }
        await done(tx);
    }
}

/**
 * The store for `owner` (a user id), or undefined without IndexedDB. One
 * that holds another person's data is emptied first.
 */
export async function openSyncStore(owner: string): Promise<SyncStore | undefined> {
    const db = await database();
    if (!db) {
        return undefined;
    }
    try {
        const held = (await request(db.transaction(META, 'readonly').objectStore(META).get('owner'))) as
            | { name: string; value: string }
            | undefined;
        if (held?.value !== owner) {
            const tx = db.transaction([ROWS, SCOPES, META], 'readwrite');
            tx.objectStore(ROWS).clear();
            tx.objectStore(SCOPES).clear();
            tx.objectStore(META).put({ name: 'owner', value: owner });
            await done(tx);
        }
        return new SyncStore(db);
    } catch {
        return undefined;
    }
}

/** Empties the store (sign-out). */
export async function clearSyncStore() {
    const db = await database();
    if (!db) {
        return;
    }
    try {
        const tx = db.transaction([ROWS, SCOPES, META], 'readwrite');
        tx.objectStore(ROWS).clear();
        tx.objectStore(SCOPES).clear();
        tx.objectStore(META).clear();
        await done(tx);
    } catch {
        // A store that can't be emptied can't be read either: the next
        // person's open (`openSyncStore`) empties it.
    }
}

/** Closes the database (tests: the next use opens it again). */
export async function closeSyncStore() {
    const db = await opening;
    opening = undefined;
    db?.close();
}
