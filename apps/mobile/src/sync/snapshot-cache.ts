import type { SqlConnection, SqlStatements } from '../data';

import { type Confirmation, mergeSnapshot, type SnapshotItem } from './merge';
import {
    type CachedRow,
    readMeta,
    readRows,
    type RowRemove,
    type RowScope,
    type RowUpsert,
    type RowVersion,
    type SyncMeta,
    type WriteBatch,
    writeBatch,
} from './rows';
import { staleFor, type ServerVersions } from './versions';
import { createWriteQueue } from './write-queue';

// The snapshot kinds' copy of cache.db in memory: their rows, read at open,
// and each source's meta. A pull's answer is diffed against these rows
// (merge.ts) and applied here at once, then reaches cache.db through the write
// queue: every row it changed and the meta that describes them, in one
// transaction. So the file holds a source's ETag only with the rows it was
// given for, whatever a crash interrupts. A source loses its ETag when the
// device's rows stop being the body it names: a confirmed write changes one of
// its rows, or a confirmation holds a row against its answer. A 304 can't then
// vouch for the old body, and the next pull is a full one, which a pull that
// started after the confirmation takes.
//
// A source's meta row is keyed by its name (`state`, `workspace`) and the
// scope it pulled, since one source can fill several collections:
// `/api/workspace` gives the shell, conversations, spaces and socios under one
// ETag, committed together.
//
// A scoped kind (`scopedPath`: a Space's pages) keeps one copy per
// scope, read from cache.db as the scope is first asked (`load` with the
// scope), and dropped whole with `dropScope`: its rows and meta leave memory
// at once (told as removes), and cache.db in one transaction, which may carry
// the caller's statements too (the Space's page bodies). An answer to a pull
// begun before the drop is superseded.
//
// The server's build keys the rows too (versions.ts). The source that
// reports it (`/api/state`) hands each answer's version and Date header to the
// workspace's ServerVersions, in the order answers apply: a 200's version from
// its body, a 304's from the stored row it vouches for. Each meta row is stamped
// (`serverVersion`) with the highest version as its answer applies, unless its
// pull began before that version was taken: it was asked of the build before.
// A scope stamped with another version than the highest is `stale`, due one
// pull, which sends its ETag as any pull does.
//
// Whoever shows the rows (the scope's TanStack collections, collections.ts)
// hears of each change in memory as it applies (`subscribe`): a pull's, or a
// confirmation's, which the scheduler also reads (a pull in flight runs again).

/** What a snapshot source fills in one collection. */
export interface Feed {
    readonly collection: string;
    /**
     * A singleton: the one key the feed owns in a collection other feeds share
     * (the shell's `state` and `workspace`). Unset: the feed owns the collection.
     */
    readonly key?: string;
    /**
     * Keep the rows a snapshot lacks (notices outlive the server's 24 h),
     * at most `keep` of them: past it, the lowest `order` goes first.
     */
    readonly retain?: { readonly keep: number; readonly order: (value: unknown) => number };
}

/** A snapshot source: a conditional GET whose 200 replaces what it feeds. */
export interface SnapshotDefinition {
    /** Its name, the `collection` of its meta row. */
    readonly id: string;
    /** The exact path it asks, with no query: the ETag's version part hashes the path and query. */
    readonly path: string;
    /**
     * A scoped kind's path for one scope (a Space's pages: `/api/spaces/<id>/pages`).
     * Without it the kind is whole, and only scope '' is pulled.
     */
    scopedPath?(scope: string): string;
    /** The format of its rows. A meta row of another format keeps its rows but loses its ETag, so the next pull is full. */
    readonly format: number;
    readonly feeds: readonly Feed[];
    /**
     * The path sends no ETag (`/api/learning/skills`): the source sends no
     * If-None-Match and keeps a hash of each 200's body as the source's ETag
     * (snapshot-source.ts), so a body with the hash held applies as a 304.
     */
    readonly hashBody?: boolean;
    /** A 200's body, one list of items per feed in `feeds`' order. Throws SnapshotShapeError on a body that isn't the snapshot. */
    split(body: unknown): readonly (readonly SnapshotItem[])[];
    /**
     * Where its answers say which build the server runs: `read` takes the
     * value of row `key` in feed `feed` and gives its version, or null when it
     * names none. Only the version source has one (the shell's `state` row).
     */
    readonly version?: {
        readonly feed: number;
        readonly key: string;
        readonly read: (value: unknown) => string | null;
    };
}

/** What a pull did. */
export interface PullResult {
    /**
     * `changed`: rows were set or removed; `unchanged`: a 200 that changed
     * nothing; `not-modified`: a 304; `superseded`: an answer to a pull a later
     * one overtook, dropped.
     */
    readonly outcome: 'changed' | 'unchanged' | 'not-modified' | 'superseded';
    readonly upserts: readonly RowUpsert[];
    readonly removes: readonly RowRemove[];
    /** What to send next time: the ETag as received, or null. */
    readonly cursor: string | null;
}

/** One of this device's writes the server confirmed: the row as it now is, or its delete. */
export type ConfirmedChange =
    | (RowScope & { readonly key: string; readonly value: unknown; readonly version?: RowVersion })
    | (RowScope & { readonly key: string; readonly deleted: true });

/** Rows memory's copy has just set or removed, told to the cache's listeners as they apply. */
export interface CacheChange {
    readonly upserts: readonly RowUpsert[];
    readonly removes: readonly RowRemove[];
    /** One of this device's writes the server confirmed (`confirm`), not a pull's answer. */
    readonly confirmed: boolean;
}

export interface SnapshotCache {
    /**
     * One collection's rows in a scope, by key: memory's copy, ahead of cache.db
     * until the next write. None once closed.
     */
    rows(collection: string, scope?: string): ReadonlyMap<string, CachedRow>;
    /** A source's meta, or null before its first answer. */
    meta(definition: SnapshotDefinition, scope?: string): SyncMeta | null;
    /** The ETag to send for a source: null with none, or when its rows are of another format. */
    cursor(definition: SnapshotDefinition, scope?: string): string | null;
    /**
     * Whether a source's scope was last pulled under another server version
     * than the highest (or never): it is due one pull, with its ETag. Always
     * false without `versions`.
     */
    stale(definition: SnapshotDefinition, scope?: string): boolean;
    /** Notes that a pull starts: the counter the merge rules order pulls and confirmations by. */
    beginPull(): number;
    /**
     * Applies a 200's body, split by its definition, and queues the write.
     * `date` is its Date header, the server's clock for the version rules.
     */
    applySnapshot(
        definition: SnapshotDefinition,
        scope: string,
        startedAt: number,
        parts: readonly (readonly SnapshotItem[])[],
        etag: string | null,
        date?: string | null,
    ): PullResult;
    /**
     * Applies a 304 to a pull that sent `sent`. Its own ETag, when it is a new
     * one (a restarted server names the same body anew), is kept as received:
     * it names the copy the device holds (RFC 9111, 4.3.4). The same tag
     * without its `W/` (a 304 isn't gzipped) leaves the stored one as it was.
     * `date` is its Date header, the server's clock for the version rules.
     */
    applyNotModified(
        definition: SnapshotDefinition,
        scope: string,
        startedAt: number,
        sent: string | null,
        etag: string | null,
        date?: string | null,
    ): PullResult;
    /**
     * The hand-off on success: a write of this device's that the server
     * confirmed. It applies at once, holds against pulls that started before
     * it (merge.ts), and is written straight away with whatever else is
     * pending; resolves once cache.db has it, so the outbox row goes only then.
     * A change to the row drops the ETag of the sources that feed it, in the
     * same write: the next pull of theirs is a full one.
     */
    confirm(change: ConfirmedChange): Promise<void>;
    /**
     * Calls `listener` with each change to memory's rows, once it has applied
     * and before the call that made it returns. It must not throw. Returns the
     * unsubscribe. Once closed, it hears nothing.
     */
    subscribe(listener: (change: CacheChange) => void): () => void;
    /**
     * Reads more sources' rows and meta from cache.db, those not read yet (a
     * module's kind after the first frame), and tells their rows to the
     * listeners as upserts. A row this device's confirmation set or removed
     * meanwhile keeps memory's state. Each source loads once per scope; a
     * source's pull awaits it (snapshot-source.ts). Resolves at once for those
     * loaded. `scope` is a scoped kind's (a Space's pages), '' by default.
     */
    load(definitions: readonly SnapshotDefinition[], scope?: string): Promise<void>;
    /** Whether a source's rows and meta have been read from cache.db for `scope` ('' by default). */
    loaded(definition: SnapshotDefinition, scope?: string): boolean;
    /**
     * Drops a scoped kind's copy of `scope` (a Space the person lost): its rows
     * and meta leave memory at once, told as removes, then cache.db in one
     * transaction, with `also`'s statements in it. A pull of it in flight is
     * superseded; a later `load` reads it again (empty). Resolves once written.
     */
    dropScope(
        definition: SnapshotDefinition,
        scope: string,
        also?: (tx: SqlStatements) => Promise<void>,
    ): Promise<void>;
    /** Writes whatever is pending now (a screen closing, the app going to the background). */
    flush(): Promise<void>;
    /**
     * Flushes and stops: nothing more applies, `rows` gives none, and no
     * listener hears. The connection stays open; it is the scope's.
     */
    close(): Promise<void>;
}

export interface SnapshotCacheOptions {
    /** The workspace's cache.db. */
    readonly db: SqlConnection;
    /** The sources whose rows and meta load now (the shell's, `SHELL_SNAPSHOTS`, and the kept screen's); others with `load`. */
    readonly definitions: readonly SnapshotDefinition[];
    /** The moments to write at once: the app going to the background, a disconnect (write-queue.ts). */
    readonly flushTrigger?: (flush: () => void) => () => void;
    /** A write the cadence started failed; its changes stay pending for the next. */
    readonly onWriteError?: (error: unknown) => void;
    /** The device clock, for `seenAt` and `syncedAt` (the write queue keeps to its timers' clock). */
    readonly now?: () => number;
    /**
     * The workspace's server versions (versions.ts): the version source's
     * answers go to it, and meta rows are stamped with its highest. Without it,
     * a meta row keeps the `serverVersion` it had.
     */
    readonly versions?: Pick<ServerVersions, 'observe' | 'highest'>;
}

interface PendingRow extends RowScope {
    readonly key: string;
    readonly row: CachedRow | null;
    readonly seenAt: number;
}

const WHOLE = '';
const NO_ROWS: ReadonlyMap<string, CachedRow> = new Map();
/** Two ETags compared weakly, as If-None-Match is (RFC 9110, 8.8.3.2): `W/` aside. */
const sameTag = (a: string, b: string | null) => b !== null && a.replace(/^W\//, '') === b.replace(/^W\//, '');
const scopeId = (collection: string, scope: string) => `${collection}\u0000${scope}`;
const rowId = (collection: string, scope: string, key: string) => `${collection}\u0000${scope}\u0000${key}`;

/** Reads the definitions' rows and meta from `db` (scope '') and holds them in memory. */
export async function openSnapshotCache({
    db,
    definitions: initial,
    flushTrigger,
    onWriteError,
    now = Date.now,
    versions,
}: SnapshotCacheOptions): Promise<SnapshotCache> {
    const rows = new Map<string, Map<string, CachedRow>>();
    const metas = new Map<string, SyncMeta | null>();
    /** The sources loaded (or loading), whose tags a confirmation may drop. */
    const definitions: SnapshotDefinition[] = [...initial];
    /** Each source's load, by id and scope: done for those read at open. */
    const loads = new Map<string, Promise<void>>(
        initial.map((definition) => [scopeId(definition.id, WHOLE), Promise.resolve()]),
    );
    for (const definition of definitions) {
        metas.set(scopeId(definition.id, WHOLE), await readMeta(db, { collection: definition.id, scope: WHOLE }));
        for (const { collection } of definition.feeds) {
            const id = scopeId(collection, WHOLE);
            if (!rows.has(id)) {
                rows.set(id, await readRows(db, { collection, scope: WHOLE }));
            }
        }
    }
    /** The collections read from cache.db, by collection and scope: a confirmation may make another's map before its load. */
    const loadedCollections = new Set(
        initial.flatMap((definition) => definition.feeds.map((feed) => scopeId(feed.collection, WHOLE))),
    );
    /** Sources dropped (`dropScope`) and not loaded since, by id and scope: an answer to them is superseded. */
    const dropped = new Set<string>();
    /** The collections and scopes dropped and not loaded since: a failed write never puts their rows back. */
    const droppedRows = new Set<string>();
    /** Drops per source and scope: a load that read before one applies nothing. */
    const drops = new Map<string, number>();

    const pendingRows = new Map<string, PendingRow>();
    const pendingMeta = new Set<string>();
    /** This device's confirmed writes still held, per collection and scope. */
    const confirmations = new Map<string, Map<string, Confirmation>>();
    /** The start of the last pull applied, per source and scope. */
    const lastApplied = new Map<string, number>();
    let clock = 0;
    /** The pull counter when the highest server version last moved: a pull begun by then asked the build before. */
    let adoptedAt = 0;
    /** The version each stored row of the version source names, read once per row. */
    const rowVersions = new WeakMap<CachedRow, string | null>();
    const listeners = new Set<(change: CacheChange) => void>();
    let closed = false;
    const tell = (change: CacheChange) => {
        if (change.upserts.length === 0 && change.removes.length === 0) {
            return;
        }
        for (const listener of [...listeners]) {
            listener(change);
        }
    };

    const write = async (): Promise<void> => {
        if (pendingRows.size === 0 && pendingMeta.size === 0) {
            return;
        }
        // Taken at once, with the meta as it is now: memory's rows and ETags agree at this instant.
        const batch: WriteBatch = {
            rows: [...pendingRows.values()],
            meta: [...pendingMeta].flatMap((id) => {
                const meta = metas.get(id);
                const [collection = '', scope = ''] = id.split('\u0000');
                return meta ? [{ collection, scope, ...meta }] : [];
            }),
        };
        const metaIds = [...pendingMeta];
        pendingRows.clear();
        pendingMeta.clear();
        try {
            await db.transaction((tx) => writeBatch(tx, batch));
        } catch (error) {
            // Back under whatever changed since: a newer change to a row wins.
            for (const change of batch.rows) {
                const id = rowId(change.collection, change.scope, change.key);
                if (!pendingRows.has(id) && !droppedRows.has(scopeId(change.collection, change.scope))) {
                    pendingRows.set(id, change);
                }
            }
            for (const id of metaIds) {
                if (metas.has(id)) {
                    pendingMeta.add(id);
                }
            }
            throw error;
        }
    };
    const queue = createWriteQueue({ write, flushTrigger, onError: onWriteError });

    const assertOpen = () => {
        if (closed) {
            throw new Error('The snapshot cache is closed.');
        }
    };
    const rowsOf = (collection: string, scope: string) => {
        const id = scopeId(collection, scope);
        let map = rows.get(id);
        if (map === undefined) {
            map = new Map();
            rows.set(id, map);
        }
        return map;
    };
    const loadedFor = (definition: SnapshotDefinition, scope: string) => {
        if (!metas.has(scopeId(definition.id, scope))) {
            throw new Error(`${definition.id} isn't loaded for scope "${scope}".`);
        }
    };
    const cursorOf = (definition: SnapshotDefinition, scope: string) => {
        const meta = metas.get(scopeId(definition.id, scope));
        return meta && meta.schemaVersion === definition.format ? meta.etag : null;
    };
    const set = (collection: string, scope: string, row: CachedRow, seenAt: number) => {
        rowsOf(collection, scope).set(row.key, row);
        pendingRows.set(rowId(collection, scope, row.key), { collection, scope, key: row.key, row, seenAt });
    };
    const remove = (collection: string, scope: string, key: string, seenAt: number) => {
        rowsOf(collection, scope).delete(key);
        pendingRows.set(rowId(collection, scope, key), { collection, scope, key, row: null, seenAt });
    };
    /** Drops the ETag of every source that feeds `key` in a collection and scope: their bodies no longer name it. */
    const forgetTags = (collection: string, scope: string, key: string) => {
        for (const definition of definitions) {
            const feeds = definition.feeds.some(
                (feed) => feed.collection === collection && (feed.key === undefined || feed.key === key),
            );
            const sourceId = scopeId(definition.id, scope);
            const meta = metas.get(sourceId);
            if (feeds && meta && meta.etag !== null) {
                metas.set(sourceId, { ...meta, etag: null });
                pendingMeta.add(sourceId);
            }
        }
    };
    /** Hands one answer's version and Date to `versions`, noting when the highest moves. */
    const observe = (version: string | null, date: string | null) => {
        if (versions?.observe(version, date).fresh) {
            adoptedAt = clock;
        }
    };
    /** The version a 304 reports: that of the stored row it vouches for, or undefined when there's none. */
    const storedVersion = ({ feeds, version }: SnapshotDefinition, scope: string): string | null | undefined => {
        if (version === undefined) {
            return undefined;
        }
        const collection = feeds[version.feed]?.collection;
        const row = collection === undefined ? undefined : rows.get(scopeId(collection, scope))?.get(version.key);
        if (row === undefined) {
            return undefined;
        }
        if (!rowVersions.has(row)) {
            rowVersions.set(row, version.read(JSON.parse(row.json) as unknown));
        }
        return rowVersions.get(row) ?? null;
    };
    /**
     * The server version a source's meta row is stamped with as an answer to a
     * pull begun at `startedAt` applies: the highest, unless the pull began
     * before it was taken and isn't the answer that gave it.
     */
    const stampFor = (definition: SnapshotDefinition, startedAt: number, previous: string | null): string | null => {
        if (versions === undefined) {
            return previous;
        }
        return definition.version !== undefined || startedAt > adoptedAt ? versions.highest() : previous;
    };
    /** Reads one more source's meta and rows for `scope`, memory's changes since on top, and tells its rows. */
    const loadOne = async (definition: SnapshotDefinition, scope: string): Promise<void> => {
        const sourceId = scopeId(definition.id, scope);
        const drop = drops.get(sourceId) ?? 0;
        const meta = await readMeta(db, { collection: definition.id, scope });
        const read = new Map<string, ReadonlyMap<string, CachedRow>>();
        for (const { collection } of definition.feeds) {
            if (!loadedCollections.has(scopeId(collection, scope)) && !read.has(collection)) {
                read.set(collection, await readRows(db, { collection, scope }));
            }
        }
        if (closed || (drops.get(sourceId) ?? 0) !== drop) {
            return;
        }
        dropped.delete(sourceId);
        for (const collection of read.keys()) {
            loadedCollections.add(scopeId(collection, scope));
            droppedRows.delete(scopeId(collection, scope));
        }
        const upserts: RowUpsert[] = [];
        for (const [collection, stored] of read) {
            const memory = rowsOf(collection, scope);
            for (const [key, row] of stored) {
                // A confirmation since the open set or removed it: memory's state wins.
                if (memory.has(key) || pendingRows.has(rowId(collection, scope, key))) {
                    continue;
                }
                memory.set(key, row);
                upserts.push({ collection, scope, ...row, value: JSON.parse(row.json) as unknown });
            }
        }
        if (!metas.has(sourceId)) {
            // A confirmation before the load changed rows the stored tag names: the next pull is full.
            const confirmed = definition.feeds.some(
                (feed) => (confirmations.get(scopeId(feed.collection, scope))?.size ?? 0) > 0,
            );
            if (confirmed && meta !== null && meta.etag !== null) {
                metas.set(sourceId, { ...meta, etag: null });
                pendingMeta.add(sourceId);
                queue.changed();
            } else {
                metas.set(sourceId, meta);
            }
        }
        if (!definitions.includes(definition)) {
            definitions.push(definition);
        }
        tell({ upserts, removes: [], confirmed: false });
    };
    const superseded = (definition: SnapshotDefinition, scope: string): PullResult => ({
        outcome: 'superseded',
        upserts: [],
        removes: [],
        cursor: cursorOf(definition, scope),
    });

    return {
        // Closed, it holds no rows for anyone: a reader left over (a collection started again) gets none.
        rows: (collection, scope = WHOLE) => (closed ? NO_ROWS : rowsOf(collection, scope)),
        meta: (definition, scope = WHOLE) => metas.get(scopeId(definition.id, scope)) ?? null,
        cursor: (definition, scope = WHOLE) => cursorOf(definition, scope),
        stale: (definition, scope = WHOLE) =>
            versions !== undefined &&
            staleFor(metas.get(scopeId(definition.id, scope))?.serverVersion ?? null, versions.highest()),
        beginPull: () => ++clock,

        applySnapshot(definition, scope, startedAt, parts, etag, date = null) {
            assertOpen();
            const sourceId = scopeId(definition.id, scope);
            if (dropped.has(sourceId)) {
                return superseded(definition, scope);
            }
            loadedFor(definition, scope);
            if (startedAt < (lastApplied.get(sourceId) ?? 0)) {
                return superseded(definition, scope);
            }
            if (definition.version !== undefined) {
                const { feed, key, read } = definition.version;
                const item = (parts[feed] ?? []).find((candidate) => candidate.key === key);
                if (item !== undefined) {
                    observe(read(item.value), date);
                }
            }
            const at = now();
            const upserts: RowUpsert[] = [];
            const removes: RowRemove[] = [];
            let withheld = false;
            definition.feeds.forEach((feed, index) => {
                const { collection, key: only, retain } = feed;
                const all = rowsOf(collection, scope);
                const known = only === undefined ? all : new Map([...all].filter(([key]) => key === only));
                const incoming = (parts[index] ?? []).filter((item) => only === undefined || item.key === only);
                const merged = mergeSnapshot(known, incoming, {
                    startedAt,
                    confirmed: confirmations.get(scopeId(collection, scope)),
                    retain: retain !== undefined,
                });
                withheld ||= merged.withheld.length > 0;
                let added = merged.upserts;
                const dropped = new Set(merged.removes);
                if (retain !== undefined && known.size + added.length > retain.keep) {
                    // Over the bound, the oldest go, whether held already or just come.
                    const kept = new Map<string, unknown>();
                    for (const [key, row] of known) {
                        kept.set(key, JSON.parse(row.json) as unknown);
                    }
                    for (const item of added) {
                        kept.set(item.key, item.value);
                    }
                    if (kept.size > retain.keep) {
                        const oldest = [...kept]
                            .map(([key, value]) => ({ key, order: retain.order(value) }))
                            .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1))
                            .slice(0, kept.size - retain.keep)
                            .map(({ key }) => key);
                        const gone = new Set(oldest);
                        added = added.filter((item) => !gone.has(item.key));
                        for (const key of oldest) {
                            if (known.has(key)) {
                                dropped.add(key);
                            }
                        }
                    }
                }
                for (const item of added) {
                    set(collection, scope, { key: item.key, json: item.json, version: item.version }, at);
                    upserts.push({ collection, scope, ...item });
                }
                for (const key of dropped) {
                    remove(collection, scope, key, at);
                    removes.push({ collection, scope, key });
                }
                // This pull started after them, so they hold no more: those on the rows the feed owns,
                // not another source's singleton in a collection they share.
                const held = confirmations.get(scopeId(collection, scope));
                for (const key of only === undefined ? [...(held?.keys() ?? [])] : [only]) {
                    const confirmation = held?.get(key);
                    if (confirmation !== undefined && confirmation.at < startedAt) {
                        held?.delete(key);
                    }
                }
            });
            lastApplied.set(sourceId, startedAt);
            const previous = metas.get(sourceId) ?? null;
            const changed = upserts.length > 0 || removes.length > 0;
            // A held row isn't the answer's, so its tag doesn't name what the device holds.
            const kept = withheld ? null : etag;
            const stamp = stampFor(definition, startedAt, previous?.serverVersion ?? null);
            metas.set(sourceId, {
                cursor: null,
                etag: kept,
                serverVersion: stamp,
                schemaVersion: definition.format,
                syncedAt: at,
            });
            if (
                changed ||
                previous?.etag !== kept ||
                previous.schemaVersion !== definition.format ||
                previous.serverVersion !== stamp
            ) {
                pendingMeta.add(sourceId);
                queue.changed();
            }
            tell({ upserts, removes, confirmed: false });
            return { outcome: changed ? 'changed' : 'unchanged', upserts, removes, cursor: kept };
        },

        applyNotModified(definition, scope, startedAt, sent, etag, date = null) {
            assertOpen();
            const sourceId = scopeId(definition.id, scope);
            if (dropped.has(sourceId)) {
                return superseded(definition, scope);
            }
            loadedFor(definition, scope);
            // The 304 vouches for the copy the sent tag named, which another answer may have replaced since.
            if (startedAt < (lastApplied.get(sourceId) ?? 0) || sent !== cursorOf(definition, scope)) {
                return superseded(definition, scope);
            }
            lastApplied.set(sourceId, startedAt);
            const reported = storedVersion(definition, scope);
            if (reported !== undefined) {
                observe(reported, date);
            }
            const previous = metas.get(sourceId);
            if (previous) {
                // The same tag, weak or strong (the 304 isn't gzipped), stays as the 200 gave it.
                const next = etag === null || sameTag(etag, previous.etag) ? previous.etag : etag;
                const stamp = stampFor(definition, startedAt, previous.serverVersion);
                metas.set(sourceId, { ...previous, etag: next, serverVersion: stamp, syncedAt: now() });
                if (next !== previous.etag || stamp !== previous.serverVersion) {
                    pendingMeta.add(sourceId);
                    queue.changed();
                }
            }
            return { outcome: 'not-modified', upserts: [], removes: [], cursor: cursorOf(definition, scope) };
        },

        confirm(change) {
            assertOpen();
            const { collection, scope, key } = change;
            const id = scopeId(collection, scope);
            const held = confirmations.get(id) ?? new Map<string, Confirmation>();
            confirmations.set(id, held);
            // Every pull begun so far started before this confirmation.
            held.set(key, { at: clock, deleted: 'deleted' in change });
            const at = now();
            const before = rowsOf(collection, scope).get(key)?.json ?? null;
            let json: string | null = null;
            let told: CacheChange;
            if ('deleted' in change) {
                remove(collection, scope, key, at);
                told = { upserts: [], removes: [{ collection, scope, key }], confirmed: true };
            } else {
                json = JSON.stringify(change.value);
                const version = change.version ?? null;
                set(collection, scope, { key, json, version }, at);
                told = {
                    upserts: [{ collection, scope, key, json, version, value: change.value }],
                    removes: [],
                    confirmed: true,
                };
            }
            if (before !== json) {
                // The row is no longer the one the sources that feed it last answered.
                forgetTags(collection, scope, key);
            }
            queue.changed();
            const written = queue.flush();
            if (before !== json) {
                tell(told);
            }
            return written;
        },

        subscribe(listener) {
            if (closed) {
                return () => {};
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        load(more, scope = WHOLE) {
            return Promise.all(
                more.map((definition) => {
                    const id = scopeId(definition.id, scope);
                    let loading = loads.get(id);
                    if (loading === undefined) {
                        loading = loadOne(definition, scope);
                        loads.set(id, loading);
                        // A read that failed may be tried again.
                        loading.catch(() => {
                            if (loads.get(id) === loading) {
                                loads.delete(id);
                            }
                        });
                    }
                    return loading;
                }),
            ).then(() => {});
        },

        loaded: (definition, scope = WHOLE) => metas.has(scopeId(definition.id, scope)),

        async dropScope(definition, scope, also) {
            assertOpen();
            if (scope === WHOLE || definition.scopedPath === undefined) {
                throw new TypeError(`${definition.id} is a whole kind: it has no scope to drop.`);
            }
            const sourceId = scopeId(definition.id, scope);
            const removes: RowRemove[] = [];
            for (const { collection } of definition.feeds) {
                const id = scopeId(collection, scope);
                for (const key of rows.get(id)?.keys() ?? []) {
                    removes.push({ collection, scope, key });
                }
                rows.delete(id);
                confirmations.delete(id);
                loadedCollections.delete(id);
                droppedRows.add(id);
                for (const [pendingId, change] of pendingRows) {
                    if (change.collection === collection && change.scope === scope) {
                        pendingRows.delete(pendingId);
                    }
                }
            }
            metas.delete(sourceId);
            pendingMeta.delete(sourceId);
            loads.delete(sourceId);
            dropped.add(sourceId);
            drops.set(sourceId, (drops.get(sourceId) ?? 0) + 1);
            tell({ upserts: [], removes, confirmed: false });
            // A batch the queue already took goes first, so it can't put the rows back after the delete.
            await queue.flush().catch(() => {});
            await db.transaction(async (tx) => {
                for (const { collection } of definition.feeds) {
                    await tx.run('DELETE FROM rows WHERE collection = ? AND scope = ?', [collection, scope]);
                }
                await tx.run('DELETE FROM meta WHERE collection = ? AND scope = ?', [definition.id, scope]);
                await also?.(tx);
            });
        },

        flush: () => queue.flush(),

        async close() {
            closed = true;
            listeners.clear();
            await queue.close();
        },
    };
}
