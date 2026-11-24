import type { SqlConnection, SqlStatements } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { HttpError, httpError, SnapshotShapeError } from './errors';
import type { RowVersion } from './rows';

// A bounded kind: one
// item per key, read from the server one at a time, the most recently used kept
// on disk and the few in use kept in memory. history-disk.ts's rules for chat
// histories, made generic for single items: an issue's detail (issue-details.ts),
// and later a task's, a schedule's or a job's detail, the assignee list, the
// person's own traces and a page's body (`pageBodies`).
//
// On disk: cache.db's `rows`, collection `<name>`, one scope per key
// (`<name>:<format>:<key>`, the item under the key itself); `scopes` holds each
// one's last use and size for the LRU. Opening drops the scopes of another
// format, and keeps the rest. Past the bounds (items and about how many
// characters) the least recently used goes first, never one a screen shows or
// handed out by `preload`, nor one `pinned` names (queued writes, a kept
// Space). An item longer than `itemMaxChars` (4 MB) is never kept: the screen
// shows it from memory, the old copy is deleted, and the next open asks again.
// An item `memoryOnly` names never reaches disk (another person's trace, which
// an admin's open logs), and a copy already there is deleted.
//
// In memory: at most `memory` items (8), the least recently used leaving
// first, never one a screen `use`s nor one `preload` handed out (until its first
// `use()`, or HANDOFF_MS), nor one `refreshKnown` is reading. An item that left
// memory takes nothing more, except a 404 or 410: that still drops disk's copy
// and tells `onGone`, so a gone item never outlives its read.
//
// Reads: `use()` (a screen opens it) reads the server, unless the kind's
// `fresh` says the copy held is current (a page body at its summary's
// revision), as do `refresh()` and
// `refreshKnown()` (the item's list says it changed, a write named it). Calls
// while one runs make one more after it. An answer to a request that started
// before a value was `put` (a write's own answer) is dropped, as merge.ts drops
// a pull that a confirmation overtook. A 404 or 410 (`isGone`) drops the item,
// in memory and on disk, and tells `onGone`; any other failure keeps what is
// shown, with its age (`fetchedAt`). A local key (`isLocal`: an item created on
// the phone, not on the server yet) never reads the network.
//
// `dropPrefix` drops every item whose key starts with a prefix (a Space's page
// bodies, when the person loses the Space): gone in memory at once, and from
// disk in one transaction, which may be the caller's (the Space's summaries go
// in it too).
//
// Everything lives in cache.db, so Clear cache, sign-out and every wipe take it
// with the rest of the workspace's cache.
//
// No React Native: tests/sync runs it under Node.

/** Items kept in memory at most, besides those in use (the web's OPEN_HISTORIES, as history.ts). */
export const BOUNDED_MEMORY = 8;
/** An item whose JSON is longer than this is never kept on disk. */
export const BOUNDED_ITEM_MAX_CHARS = 4 * 1024 * 1024;
/** How long an item `preload` handed out stays in memory waiting for its first `use()`. */
export const BOUNDED_HANDOFF_MS = 10_000;

/** The disk bounds: items (keys), and about how many characters in all. */
export interface BoundedDiskBounds {
    readonly items: number;
    readonly chars: number;
}

/** What a bounded kind is: its name, its format, its bounds, and how it reads one item. */
export interface BoundedKindDefinition<T> {
    /** cache.db's `collection`, and its scopes' prefix: lower-case letters, digits and dashes. */
    readonly name: string;
    /** The format of the items kept. A copy of another format is dropped when the kind opens. */
    readonly format: number;
    readonly bounds: BoundedDiskBounds;
    /** Longer items stay in memory only; BOUNDED_ITEM_MAX_CHARS by default. */
    readonly itemMaxChars?: number;
    /** The path that reads one item (`/api/issues/12`). */
    path(key: string): string;
    /** A 200's body as the item. Throws SnapshotShapeError on a body that isn't one. */
    parse(path: string, body: unknown): T;
    /** The item's version (`updatedAt`, a revision) for cache.db's `version` column, or none. */
    version?(item: T): RowVersion;
}

export interface BoundedItemState<T> {
    /** What to show: the server's last answer, or disk's copy. Null with none. */
    readonly value: T | null;
    /** When that value came from the server (device clock): its age offline. Null with none. */
    readonly fetchedAt: number | null;
    /** Disk has been read (or there was nothing there). */
    readonly loaded: boolean;
    /** Its first read is over, whatever its outcome; a local key is settled at once. */
    readonly settled: boolean;
    /** A read is in flight. */
    readonly refreshing: boolean;
    /** The last read failed (offline, the server failed): `value`, if any, is the older copy. */
    readonly failed: boolean;
    /** The server said it's gone (404 or 410): dropped. */
    readonly gone: boolean;
}

/** What one read did. */
export type BoundedRefresh =
    | { readonly outcome: 'fresh' }
    /** An answer a later `put` overtook: dropped. */
    | { readonly outcome: 'superseded' }
    | { readonly outcome: 'gone'; readonly status: number }
    | { readonly outcome: 'failed'; readonly error: unknown }
    /** A local key: there is nothing to ask. */
    | { readonly outcome: 'local' }
    /** The item left memory, or the store closed. */
    | { readonly outcome: 'closed' };

export interface BoundedItem<T> {
    readonly key: string;
    readonly state: BoundedItemState<T>;
    /** Resolves once disk's copy, if any, is in memory (no network). */
    readonly loaded: Promise<void>;
    /** Calls `listener` after each change of `state`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** A screen shows it: never evicted, from memory or disk, until released; read now. Returns the release. */
    use(): () => void;
    /** Reads it from the server now (a call while one runs makes one more after it). */
    refresh(): Promise<BoundedRefresh>;
}

export interface BoundedStoreOptions<T> {
    readonly definition: BoundedKindDefinition<T>;
    /** The workspace's cache.db. */
    readonly db: SqlConnection;
    /** The workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** The scope's signal: a body read after it aborts rejects. */
    readonly signal?: AbortSignal;
    /** Whether a key is a local one, not on the server yet: never read from the network. */
    readonly isLocal?: (key: string) => boolean;
    /** The keys that must stay on disk besides those shown: queued writes', a kept Space's. */
    readonly pinned?: () => Iterable<string>;
    /** Items that must never reach disk: `true` for all, or a test per item. */
    readonly memoryOnly?: boolean | ((key: string, item: T) => boolean);
    /**
     * Whether the copy held is current, so `use()` needn't read the server (a
     * page body at its summary's revision). Unset: `use()` always reads.
     */
    readonly fresh?: (key: string, item: T) => boolean;
    /** Which failed statuses mean the item is gone: 404 and 410 by default. */
    readonly isGone?: (status: number) => boolean;
    /** An item the server says is gone: its queued writes go to Unsent (`refuseLanes`). */
    readonly onGone?: (key: string, status: number) => void;
    /** Each value the item takes (an answer, or a `put`), after memory has it: issue-details.ts refreshes its list row. */
    readonly onValue?: (key: string, item: T) => void;
    /** A disk failure, or a body that isn't the item: memory goes on, the next open asks again. */
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
    /** Items held in memory at most, besides those in use: BOUNDED_MEMORY by default. */
    readonly memory?: number;
    /** How long a preloaded item waits for its `use()`: BOUNDED_HANDOFF_MS by default. */
    readonly handoffMs?: number;
}

export interface BoundedStore<T> {
    readonly definition: BoundedKindDefinition<T>;
    /**
     * Item `key`, most recently used now. Hold it with `use()` in the same turn:
     * an item nothing uses may leave memory at the next call.
     */
    item(key: string): BoundedItem<T>;
    /**
     * Reads `key` from disk into memory, with no network: a row press, a link,
     * a cold start. It stays in memory until its first `use()`, or the hand-off.
     */
    preload(key: string): Promise<BoundedItem<T>>;
    /** Item `key` if memory holds it, without making it the most recently used. */
    peek(key: string): BoundedItem<T> | undefined;
    /** The keys held in memory, least recently used first. */
    held(): string[];
    /** Whether disk keeps a copy of `key`. */
    stored(key: string): Promise<boolean>;
    /**
     * Reads `key` again when memory or disk holds it (its list says it changed or left);
     * resolves null, with no request, for one the phone doesn't hold. The item stays in
     * memory until its read settles, however many run at once.
     */
    refreshKnown(key: string): Promise<BoundedRefresh | null>;
    /**
     * Sets `key`'s value from elsewhere (a write's answer carries it): in
     * memory if held, and on disk unless memory-only. Reads in flight that began
     * before it are dropped. Resolves once disk has it.
     */
    put(key: string, item: T): Promise<void>;
    /**
     * Drops every item whose key starts with `prefix`: those in memory turn
     * gone and leave it, and disk's copies go in one transaction, run by
     * `within` when given (so the caller's statements share it). Resolves once
     * disk has done it.
     */
    dropPrefix(
        prefix: string,
        within?: (statements: (tx: SqlStatements) => Promise<void>) => Promise<void>,
    ): Promise<void>;
    /** Resolves once every disk step asked so far has been tried. */
    flush(): Promise<void>;
    /** Ends every item and takes no more. Waits for the disk steps asked. */
    close(): Promise<void>;
}

const INITIAL: BoundedItemState<never> = {
    value: null,
    fetchedAt: null,
    loaded: false,
    settled: false,
    refreshing: false,
    failed: false,
    gone: false,
};

const NAME = /^[a-z][a-z0-9-]*$/;
/** history-disk.ts's scopes: no bounded kind may share their prefix. */
const RESERVED = new Set(['chat']);

const defaultGone = (status: number) => status === 404 || status === 410;

/** The scope prefix of every copy of kind `name`, any format (a LIKE pattern: `name` has no `%` or `_`). */
const kindLike = (name: string) => `${name}:%`;
/** The scope prefix of kind `name` in `format`. */
const formatPrefix = (name: string, format: number) => `${name}:${format}:`;

/** The disk side of one bounded kind: reads, writes with eviction, deletes. */
function boundedDisk<T>(db: SqlConnection, definition: BoundedKindDefinition<T>) {
    const { name, format, bounds } = definition;
    const prefix = formatPrefix(name, format);
    const scopeOf = (key: string) => `${prefix}${key}`;
    const maxChars = definition.itemMaxChars ?? BOUNDED_ITEM_MAX_CHARS;

    async function dropScope(tx: SqlStatements, scope: string) {
        await tx.run('DELETE FROM rows WHERE collection = ? AND scope = ?', [name, scope]);
        await tx.run('DELETE FROM scopes WHERE scope = ?', [scope]);
    }

    /** The least recently used past the bounds, deleted; never one of `protect`. Returns their scopes. */
    async function evict(tx: SqlStatements, protect: ReadonlySet<string>): Promise<string[]> {
        const kept = await tx.all<{ scope: string; bytes: number }>(
            'SELECT scope, bytes FROM scopes WHERE scope LIKE ? ORDER BY lastUsed, scope',
            [kindLike(name)],
        );
        let count = kept.length;
        let chars = kept.reduce((sum, row) => sum + Number(row.bytes), 0);
        const evicted: string[] = [];
        for (const { scope, bytes } of kept) {
            if (count <= bounds.items && chars <= bounds.chars) {
                break;
            }
            if (protect.has(scope)) {
                continue;
            }
            await dropScope(tx, scope);
            evicted.push(scope);
            count -= 1;
            chars -= Number(bytes);
        }
        return evicted;
    }

    return {
        scopeOf,
        async read(key: string): Promise<{ value: T; fetchedAt: number } | null> {
            const row = await db.get<{ json: string; seenAt: number }>(
                'SELECT json, seenAt FROM rows WHERE collection = ? AND scope = ? AND key = ?',
                [name, scopeOf(key), key],
            );
            return row === null ? null : { value: JSON.parse(row.json) as T, fetchedAt: Number(row.seenAt) };
        },
        async has(key: string): Promise<boolean> {
            const row = await db.get<{ found: number }>('SELECT 1 AS found FROM scopes WHERE scope = ?', [
                scopeOf(key),
            ]);
            return row !== null;
        },
        /**
         * Writes `key`'s item in one transaction with its size and last use, then
         * evicts past the bounds, never a key of `protect`. An item over the
         * bound deletes the old copy instead. Returns the keys evicted.
         */
        async write(key: string, value: T, fetchedAt: number, now: number, protect: ReadonlySet<string>) {
            const json = JSON.stringify(value);
            const scope = scopeOf(key);
            if (json.length > maxChars) {
                await db.transaction((tx) => dropScope(tx, scope));
                return [];
            }
            const protectedScopes = new Set([...protect].map(scopeOf));
            protectedScopes.add(scope);
            const evicted = await db.transaction(async (tx) => {
                await tx.run('DELETE FROM rows WHERE collection = ? AND scope = ?', [name, scope]);
                await tx.run(
                    'INSERT INTO rows (collection, scope, key, json, version, seenAt) VALUES (?, ?, ?, ?, ?, ?)',
                    [name, scope, key, json, definition.version?.(value) ?? null, fetchedAt],
                );
                await tx.run(
                    `INSERT INTO scopes (scope, lastUsed, bytes) VALUES (?, ?, ?)
                     ON CONFLICT (scope) DO UPDATE SET lastUsed = excluded.lastUsed, bytes = excluded.bytes`,
                    [scope, now, json.length],
                );
                return evict(tx, protectedScopes);
            });
            if (evicted.length) {
                await db.exec('PRAGMA incremental_vacuum');
            }
            return evicted.map((dropped) => dropped.slice(prefix.length));
        },
        async remove(key: string) {
            await db.transaction((tx) => dropScope(tx, scopeOf(key)));
        },
        /** The statements that delete every copy whose key starts with `keyPrefix`, in this format. */
        dropPrefix(keyPrefix: string) {
            const start = `${prefix}${keyPrefix}`;
            return async (tx: SqlStatements) => {
                await tx.run('DELETE FROM rows WHERE collection = ? AND substr(scope, 1, ?) = ?', [
                    name,
                    start.length,
                    start,
                ]);
                await tx.run('DELETE FROM scopes WHERE substr(scope, 1, ?) = ?', [start.length, start]);
            };
        },
        async touch(key: string, now: number) {
            await db.run('UPDATE scopes SET lastUsed = ? WHERE scope = ?', [now, scopeOf(key)]);
        },
        /** Drops the copies kept in another format than the definition's; the others stay. */
        async dropOtherFormats() {
            const where = 'scope LIKE ? AND substr(scope, 1, ?) <> ?';
            const args = [kindLike(name), prefix.length, prefix];
            const old = await db.get<{ found: number }>(
                `SELECT 1 AS found FROM rows WHERE collection = ? AND substr(scope, 1, ?) <> ? LIMIT 1`,
                [name, prefix.length, prefix],
            );
            const oldScopes = await db.get<{ found: number }>(
                `SELECT 1 AS found FROM scopes WHERE ${where} LIMIT 1`,
                args,
            );
            if (old === null && oldScopes === null) {
                return;
            }
            await db.transaction(async (tx) => {
                await tx.run('DELETE FROM rows WHERE collection = ? AND substr(scope, 1, ?) <> ?', [
                    name,
                    prefix.length,
                    prefix,
                ]);
                await tx.run(`DELETE FROM scopes WHERE ${where}`, args);
            });
            await db.exec('PRAGMA incremental_vacuum');
        },
    };
}

/** Opens bounded kind `definition` on a workspace's cache.db: memory first, disk behind. */
export function createBoundedStore<T>(options: BoundedStoreOptions<T>): BoundedStore<T> {
    const { definition, db, fetch, signal } = options;
    const { isLocal = () => false, pinned = () => [], isGone = defaultGone, onGone, onValue, fresh } = options;
    const { onError = () => {} } = options;
    if (!NAME.test(definition.name) || RESERVED.has(definition.name)) {
        throw new Error(`"${definition.name}" can't name a bounded kind.`);
    }
    const now = options.now ?? Date.now;
    const memory = options.memory ?? BOUNDED_MEMORY;
    const handoffMs = options.handoffMs ?? BOUNDED_HANDOFF_MS;
    const memoryOnly =
        typeof options.memoryOnly === 'function' ? options.memoryOnly : () => options.memoryOnly === true;
    const disk = boundedDisk(db, definition);
    const open = new Map<string, Entry>();
    let closed = false;
    /** Orders reads and puts: an answer applies only over a value set before its read began. */
    let ticks = 0;
    /** Every disk step, one after another, the format check first. */
    let steps: Promise<void> = Promise.resolve();
    const onDisk = <R>(step: () => Promise<R>): Promise<R> => {
        const next = steps.then(step);
        steps = next.then(
            () => {},
            () => {},
        );
        return next;
    };
    onDisk(() => disk.dropOtherFormats()).catch(onError);

    /** Keys that must stay on disk: those shown or handed out, and those `pinned` names. */
    const protectedKeys = () => {
        const keys = new Set<string>(pinned());
        for (const entry of open.values()) {
            if (entry.kept) {
                keys.add(entry.key);
            }
        }
        return keys;
    };

    /** Writes a value to disk, or deletes the copy when it must stay in memory. */
    const store = (key: string, value: T, fetchedAt: number) =>
        onDisk(async () => {
            if (memoryOnly(key, value)) {
                await disk.remove(key);
                return;
            }
            await disk.write(key, value, fetchedAt, now(), protectedKeys());
        });

    class Entry implements BoundedItem<T> {
        readonly loaded: Promise<void>;
        users = 0;
        disposed = false;
        private handoffs = new Set<ReturnType<typeof setTimeout>>();
        private current: BoundedItemState<T> = INITIAL;
        private listeners = new Set<() => void>();
        private reading: Promise<BoundedRefresh> | undefined;
        private again = false;
        /** When the value shown was set (`ticks`); a read that began before can't replace it. */
        private setAt = 0;

        constructor(readonly key: string) {
            this.loaded = this.load();
        }

        get kept() {
            return this.users > 0 || this.handoffs.size > 0;
        }

        get state() {
            return this.current;
        }

        subscribe = (listener: () => void) => {
            this.listeners.add(listener);
            return () => void this.listeners.delete(listener);
        };

        private set(patch: Partial<BoundedItemState<T>>) {
            this.current = { ...this.current, ...patch };
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        private async load() {
            try {
                const kept = await onDisk(() => disk.read(this.key));
                if (kept !== null && memoryOnly(this.key, kept.value)) {
                    // Kept before it had to stay in memory: it goes now.
                    onDisk(() => disk.remove(this.key)).catch(onError);
                } else if (kept !== null && !this.disposed && this.current.value === null && !this.current.gone) {
                    this.set({ value: kept.value, fetchedAt: kept.fetchedAt });
                }
            } catch (error) {
                // An unreadable copy is an empty one: the server has it.
                onError(error);
            }
            if (!this.disposed) {
                this.set(isLocal(this.key) ? { loaded: true, settled: true } : { loaded: true });
            }
        }

        handOff(ms: number) {
            if (this.disposed) {
                return;
            }
            const timer = setTimeout(() => {
                this.handoffs.delete(timer);
                trim();
            }, ms);
            this.handoffs.add(timer);
        }

        private endHandoffs() {
            for (const timer of this.handoffs) {
                clearTimeout(timer);
            }
            this.handoffs.clear();
        }

        /** Holds it in memory for a read, with none of `use()`'s steps. Returns the release. */
        pin() {
            this.users += 1;
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.users -= 1;
                    trim();
                }
            };
        }

        use() {
            if (this.disposed) {
                return () => {};
            }
            this.users += 1;
            this.endHandoffs();
            onDisk(() => disk.touch(this.key, now())).catch(onError);
            void this.openRead();
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.users -= 1;
                    trim();
                }
            };
        }

        /** `use()`'s read: none when the kind's `fresh` says the copy held is current. */
        private async openRead() {
            if (fresh !== undefined && !isLocal(this.key)) {
                await this.loaded;
                const held = this.current.value;
                if (this.disposed || this.reading !== undefined) {
                    return;
                }
                if (held !== null && fresh(this.key, held)) {
                    this.set({ settled: true });
                    return;
                }
            }
            await this.refresh();
        }

        refresh(): Promise<BoundedRefresh> {
            if (this.disposed) {
                return Promise.resolve({ outcome: 'closed' });
            }
            if (isLocal(this.key)) {
                return Promise.resolve({ outcome: 'local' });
            }
            if (this.reading) {
                this.again = true;
                return this.reading;
            }
            const reading = (async () => {
                let result: BoundedRefresh = { outcome: 'closed' };
                try {
                    await this.loaded;
                    do {
                        this.again = false;
                        result = await this.readOnce();
                    } while (this.again && !this.disposed);
                    // A gone item was dropped and told, in memory or not: say so.
                    return this.disposed && result.outcome !== 'gone' ? { outcome: 'closed' as const } : result;
                } finally {
                    this.reading = undefined;
                    if (!this.disposed) {
                        this.set({ refreshing: false, settled: true });
                    }
                }
            })();
            this.reading = reading;
            return reading;
        }

        private async readOnce(): Promise<BoundedRefresh> {
            if (this.disposed) {
                return { outcome: 'closed' };
            }
            const startedAt = (ticks += 1);
            this.set({ refreshing: true });
            const path = definition.path(this.key);
            try {
                const response = await fetch(path);
                if (!response.ok) {
                    throw await httpError(response, signal);
                }
                const item = definition.parse(path, await readJson(response, signal));
                if (this.disposed) {
                    return { outcome: 'closed' };
                }
                if (startedAt < this.setAt) {
                    return { outcome: 'superseded' };
                }
                this.take(item, now(), startedAt);
                return { outcome: 'fresh' };
            } catch (error) {
                if (error instanceof HttpError && isGone(error.status) && !closed) {
                    // Gone even when it left memory meanwhile: its disk copy and its writes go too.
                    if (this.disposed) {
                        onDisk(() => disk.remove(this.key)).catch(onError);
                    } else if (startedAt < this.setAt) {
                        return { outcome: 'superseded' };
                    } else {
                        this.drop(startedAt);
                    }
                    onGone?.(this.key, error.status);
                    return { outcome: 'gone', status: error.status };
                }
                if (this.disposed) {
                    return { outcome: 'closed' };
                }
                if (startedAt < this.setAt) {
                    return { outcome: 'superseded' };
                }
                if (error instanceof SnapshotShapeError) {
                    // A body that isn't the item is ours to hear of; no answer and refusals are the screen's.
                    onError(error);
                }
                this.set({ failed: true });
                return { outcome: 'failed', error };
            }
        }

        /** Takes a value: memory now, disk behind. */
        take(item: T, fetchedAt: number, at: number) {
            this.setAt = at;
            this.set({ value: item, fetchedAt, failed: false, gone: false });
            store(this.key, item, fetchedAt).catch(onError);
            tellValue(this.key, item);
        }

        /** Gone, or never this person's: forget it, here and on disk. */
        private drop(at: number) {
            this.setAt = at;
            this.set({ value: null, fetchedAt: null, failed: false, gone: true });
            onDisk(() => disk.remove(this.key)).catch(onError);
        }

        /** Its key's copies were dropped (`dropPrefix`): gone, told, then out of memory. */
        dropped() {
            if (!this.disposed) {
                this.setAt = ticks += 1;
                this.set({ value: null, fetchedAt: null, failed: false, gone: true, refreshing: false });
            }
            this.retire();
        }

        /** Leaves memory: takes nothing more, and tells no one. */
        retire() {
            this.disposed = true;
            this.endHandoffs();
            this.listeners.clear();
        }
    }

    function tellValue(key: string, item: T) {
        if (onValue === undefined) {
            return;
        }
        try {
            onValue(key, item);
        } catch (error) {
            onError(error);
        }
    }

    /** Past `memory`, the least recently used items nothing keeps leave memory. */
    function trim(except?: Entry) {
        for (const [key, held] of open) {
            if (open.size <= memory) {
                break;
            }
            if (held.kept || held === except) {
                continue;
            }
            open.delete(key);
            held.retire();
        }
    }

    /** Reads an entry, held in memory until the read settles: many at once would trim each other first. */
    async function readHeld(entry: Entry): Promise<BoundedRefresh> {
        const release = entry.pin();
        try {
            return await entry.refresh();
        } finally {
            release();
        }
    }

    function item(key: string): Entry {
        if (closed) {
            throw new Error(`The ${definition.name} store is closed.`);
        }
        let entry = open.get(key);
        if (entry) {
            open.delete(key);
            open.set(key, entry);
            return entry;
        }
        entry = new Entry(key);
        open.set(key, entry);
        trim(entry);
        return entry;
    }

    return {
        definition,
        item,
        async preload(key) {
            const entry = item(key);
            entry.handOff(handoffMs);
            await entry.loaded;
            return entry;
        },
        peek: (key) => open.get(key),
        held: () => [...open.keys()],
        stored: (key) => onDisk(() => disk.has(key)),
        async refreshKnown(key) {
            if (closed) {
                return null;
            }
            const held = open.get(key);
            if (held !== undefined) {
                return readHeld(held);
            }
            const kept = await onDisk(() => disk.has(key)).catch((error: unknown) => {
                onError(error);
                return false;
            });
            if (!kept || closed) {
                return null;
            }
            return readHeld(item(key));
        },
        async put(key, value) {
            if (closed) {
                return;
            }
            const at = (ticks += 1);
            const held = open.get(key);
            if (held !== undefined) {
                held.take(value, now(), at);
                return onDisk(async () => {});
            }
            tellValue(key, value);
            return store(key, value, now());
        },
        dropPrefix(prefix, within) {
            if (closed) {
                return Promise.resolve();
            }
            for (const [key, entry] of [...open]) {
                if (key.startsWith(prefix)) {
                    open.delete(key);
                    entry.dropped();
                }
            }
            const statements = disk.dropPrefix(prefix);
            return onDisk(async () => {
                if (within === undefined) {
                    await db.transaction(statements);
                } else {
                    await within(statements);
                }
                await db.exec('PRAGMA incremental_vacuum');
            });
        },
        flush: () => steps,
        async close() {
            if (closed) {
                return steps;
            }
            closed = true;
            for (const entry of open.values()) {
                entry.retire();
            }
            open.clear();
            await steps;
        },
    };
}
