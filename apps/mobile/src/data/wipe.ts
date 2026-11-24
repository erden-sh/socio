import type { DbFile, SqlConnection, SqlDriver, SqlParams, SqlStatements } from './driver';
import { workspaceKeyName, workspaceKeyNames, type Keys } from './keys';
import { type FileSystem, joinPath, workspaceLayout } from './layout';
import { type CacheDb, openCacheDb } from './open';
import { recordPushRevocation } from './push-revocation';
import type { Registry, WipeReason } from './registry';

// Wiping a workspace, and Clear cache. A wipe runs in these steps:
//
// 1. mark the registry row 'wiping', with why (and it stops being active);
// 1a. revoke its push (for every reason): copy its relay registration
//    to a push revocation record (push-revocation.ts), which outlives the
//    wipe until the relay answers, then delete its Web Push keys, flags and
//    registration index entries on the native side (socio-push's
//    `deleteKeys`, `store.push`), so the phone can't read a push for it.
//    The platform's deleteKeys first waits for a push run still going (an
//    ensure waiting on the relay: src/push's `forgetWorkspace`), at most
//    10 s, and that run writes nothing for the workspace after it; the
//    record is copied again after it, with whatever that run registered;
// 2. close every connection to the workspace's files;
// 3. delete its directory: the two databases through the driver, which
//    refuses while a connection is open (as expo-sqlite's deleteDatabase
//    does), then everything left, recursively (`-wal`, `-shm`, `images/`,
//    `attachments/`), and tell the platform (`store.wiped`), which deletes
//    iOS's app-switcher snapshots, best effort (CB-356);
// 4. delete its database keys and its cookie jar, then check that the
//    directory and the keys' values are gone;
// 5. delete the registry row and the keys' index entries;
// 6. check that nothing is left.
//
// Every step can run again, so a kill anywhere is finished by the next launch:
// the mark from step 1 stays until step 5, and `resumeWipes` runs every marked
// wipe again before the first frame (store.ts calls it). A pending row (a
// sign-in a kill interrupted) is wiped the same way, by launch alone.
//
// The caller stops everything that writes to the workspace first: its scope
// (its connections and timers) and its cookie jar, whose late Set-Cookie would
// write the jar again. If something still writes, the check after step 4 fails
// the wipe with the mark and its reason still on the row, so the next launch
// finishes it as the person asked, without telling them; and a value written
// after that check stays indexed (keys.ts), so the next launch deletes it.
//
// Step 1a comes after the mark, so `resumeWipes` redoes it after a kill, and
// before the relay key goes in step 4. Neither revocation record (sign-out's
// logout, the wipe's push) is a workspace key, so both stay.

/** The native side of a workspace's push (socio-push), as the platform binds it. */
export interface StorePush {
    /**
     * Deletes the workspace's Web Push keys, its flags and the registrations
     * that point at it, once any push run already going has ended (waiting
     * 10 s at most), and keeps that run and any later one from writing for the
     * workspace (src/push's `forgetWorkspace`).
     */
    deleteKeys(workspaceId: string): Promise<void>;
    /** Called after a wipe kept a push revocation record, so it is tried at once (src/platform/push.ts). */
    recorded?(): void;
}

/** The store a launch opened (store.ts): what the wipe and Clear cache work on. */
export interface Store {
    /** The app's document directory: the store is in `<root>/socio`. */
    readonly root: string;
    /** The driver every database of the store is opened through, so a wipe can close them all. */
    readonly driver: TrackedDriver;
    readonly fs: FileSystem;
    readonly keys: Keys;
    readonly registry: Registry;
    /** The native push keys; absent in tests that have none, and then step 1a only keeps the record. */
    readonly push?: StorePush;
    /**
     * Called once a wipe has deleted the workspace's files (step 3), so the
     * platform deletes iOS's app-switcher snapshots too (CB-356,
     * src/platform/app-snapshots.ts). Best effort: it never throws, and nothing
     * waits for it.
     */
    readonly wiped?: () => void;
}

/** A driver that knows its open connections, so a wipe closes every one. */
export interface TrackedDriver extends SqlDriver {
    /** Closes every connection this driver opened to a file in `directory`. */
    closeAll(directory: string): Promise<void>;
    /** Closes every connection this driver opened to `file`. */
    closeFile(file: DbFile): Promise<void>;
    /** The files with a connection open, one entry per connection. */
    openFiles(): DbFile[];
}

const sameDirectory = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * `driver`, keeping a list of the connections it opens until they close. The
 * store opens every database through one (store.ts), so step 2 of a wipe
 * reaches connections whoever opened them.
 */
export function trackConnections(driver: SqlDriver): TrackedDriver {
    const open = new Map<SqlConnection, DbFile>();
    const closeWhere = async (matches: (file: DbFile) => boolean) => {
        const closing = [...open].filter(([, file]) => matches(file)).map(([connection]) => connection.close());
        await Promise.all(closing);
    };
    return {
        open: async (file) => {
            const connection = await driver.open(file);
            const tracked: SqlConnection = {
                exec: (sql: string) => connection.exec(sql),
                run: (sql: string, params?: SqlParams) => connection.run(sql, params),
                get: <Row>(sql: string, params?: SqlParams) => connection.get<Row>(sql, params),
                all: <Row>(sql: string, params?: SqlParams) => connection.all<Row>(sql, params),
                transaction: <T>(task: (tx: SqlStatements) => Promise<T>) => connection.transaction(task),
                close: async () => {
                    await connection.close();
                    open.delete(tracked);
                },
            };
            open.set(tracked, file);
            return tracked;
        },
        delete: (file) => driver.delete(file),
        closeAll: (directory) => closeWhere((file) => sameDirectory(file.directory, directory)),
        closeFile: (target) =>
            closeWhere((file) => sameDirectory(file.directory, target.directory) && file.name === target.name),
        openFiles: () => [...open.values()],
    };
}

/** The wipe's steps, as each ends. */
export type WipeStep =
    | 'marked'
    | 'push-revoked'
    | 'closed'
    | 'files-deleted'
    | 'keys-deleted'
    | 'row-deleted'
    | 'verified';

export interface WipeOptions {
    /** Called as each step ends, for diagnostics; the tests throw from it to kill the wipe there. */
    afterStep?: (step: WipeStep) => void | Promise<void>;
}

/** Step 6 found something of the workspace left. */
export class WipeIncompleteError extends Error {
    override readonly name = 'WipeIncompleteError';
    readonly id: string;
    /** What is left: the directory, a secret's name, the registry row or an index entry. */
    readonly left: readonly string[];

    constructor(id: string, left: readonly string[]) {
        super(`The wipe of workspace ${id} left ${left.join(', ')}.`);
        this.id = id;
        this.left = left;
    }
}

/** A workspace a launch wiped, and why. */
export interface WipedWorkspace {
    readonly id: string;
    /** A WipeReason, or a newer build's. */
    readonly reason: string;
}

/**
 * Wipes workspace `id`: its files, its keys and jar, and its registry row, in
 * the steps above. Safe to run again after a kill at any point, and on a
 * workspace partly gone or never finished. Resolves once step 6 finds nothing
 * left; throws WipeIncompleteError when a check finds something. After step
 * 4's check the row is still marked, and the next launch's `resumeWipes`
 * finishes it; after step 6's, what is left is a value still indexed, which
 * the next launch's reconcile deletes (store.ts).
 */
export async function wipe(store: Store, id: string, reason: WipeReason, options: WipeOptions = {}): Promise<void> {
    const { driver, fs, keys, registry } = store;
    const layout = workspaceLayout(store.root, id);
    const names = workspaceKeyNames(id);
    const after = async (step: WipeStep) => {
        await options.afterStep?.(step);
    };

    await registry.markWiping(id, reason);
    await after('marked');

    const recorded = await recordPushRevocation(keys, id);
    await store.push?.deleteKeys(id);
    // Again: deleteKeys waited for a push run still going (src/push), which may have
    // registered with new credentials meanwhile. Same credentials, same record.
    const again = store.push === undefined ? recorded : await recordPushRevocation(keys, id);
    if (recorded !== null || again !== null) {
        store.push?.recorded?.();
    }
    await after('push-revoked');

    await driver.closeAll(layout.directory);
    await after('closed');

    await deleteDirectory(store, layout.directory, [layout.cache, layout.user]);
    store.wiped?.();
    await after('files-deleted');

    await keys.erase(names);
    await after('keys-deleted');
    // The row and its reason stay until the files and keys are found gone.
    const back = await leftOf(fs, keys, layout.directory, names);
    if (back.length > 0) {
        throw new WipeIncompleteError(id, back);
    }

    await registry.remove(id);
    await keys.unindex(names);
    await after('row-deleted');

    const left = await leftOf(fs, keys, layout.directory, names);
    const indexed = new Set(await keys.indexed());
    for (const name of names) {
        if (indexed.has(name)) {
            left.push(`index: ${name}`);
        }
    }
    if ((await registry.get(id)) !== null) {
        left.push('registry row');
    }
    if (left.length > 0) {
        throw new WipeIncompleteError(id, left);
    }
    await after('verified');
}

/** What of a workspace's files and secrets is there: its directory and each name with a value. */
async function leftOf(fs: FileSystem, keys: Keys, directory: string, names: readonly string[]): Promise<string[]> {
    const left: string[] = [];
    if (await fs.exists(directory)) {
        left.push(directory);
    }
    for (const name of names) {
        if ((await keys.read(name)) !== null) {
            left.push(name);
        }
    }
    return left;
}

/**
 * Deletes `directory`: each of `databases` there through the driver first, so
 * a connection still open fails the delete instead of writing to a deleted
 * file, then the directory and all in it. A database file that isn't there is
 * skipped: expo-sqlite's delete throws for one, and makes its directory again.
 */
async function deleteDirectory(store: Store, directory: string, databases: readonly DbFile[]): Promise<void> {
    if (!(await store.fs.exists(directory))) {
        return;
    }
    for (const file of databases) {
        if (await store.fs.exists(joinPath(file.directory, file.name))) {
            await store.driver.delete(file);
        }
    }
    await store.fs.remove(directory);
}

/**
 * Finishes every wipe a kill interrupted: each row marked 'wiping', with its
 * reason. Launch runs it before the first frame (store.ts), then wipes the
 * 'pending' rows a kill left, which only launch may do: at any other time a
 * pending row is a sign-in being committed. Never run it while a
 * `wipe` runs. Tries every one, then throws the first failure.
 */
export async function resumeWipes(store: Store, options: WipeOptions = {}): Promise<WipedWorkspace[]> {
    const marked = (await store.registry.list()).filter((row) => row.state === 'wiping');
    // A newer build's reason is kept as it is: the mark keeps the first one.
    return wipeEach(
        store,
        marked.map((row) => ({ id: row.id, reason: row.wipeReason ?? 'unfinished' })),
        options,
    );
}

/** Wipes each workspace with its reason (a WipeReason, or a newer build's). Tries every one, then throws the first failure. */
export async function wipeEach(
    store: Store,
    workspaces: readonly WipedWorkspace[],
    options: WipeOptions = {},
): Promise<WipedWorkspace[]> {
    const wiped: WipedWorkspace[] = [];
    let failure: unknown = null;
    for (const workspace of workspaces) {
        try {
            await wipe(store, workspace.id, workspace.reason as WipeReason, options);
            wiped.push(workspace);
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure !== null) {
        throw failure;
    }
    return wiped;
}

/** Clear cache found no key for the workspace's cache.db. */
export class CacheKeyMissingError extends Error {
    override readonly name = 'CacheKeyMissingError';

    constructor(id: string) {
        super(`Workspace ${id} has no cache key.`);
    }
}

/**
 * Clear cache: closes cache.db, deletes it with its `-wal` and `-shm`,
 * deletes the app's image cache (`images/`), and builds an empty cache.db
 * again with the same key, which it resolves for the caller to use. user.db,
 * picked attachments, the keys and the registry (where the session, lease and
 * lock state live) are untouched. Throws CacheKeyMissingError when the key is
 * gone, and the driver's error when a connection to cache.db it didn't open
 * is still open.
 */
export async function clearCache(store: Store, id: string): Promise<CacheDb> {
    const layout = workspaceLayout(store.root, id);
    const key = await store.keys.read(workspaceKeyName(id, 'cache'));
    if (key === null) {
        throw new CacheKeyMissingError(id);
    }
    await store.driver.closeFile(layout.cache);
    if (await store.fs.exists(joinPath(layout.cache.directory, layout.cache.name))) {
        await store.driver.delete(layout.cache);
    }
    await store.fs.remove(layout.images);
    return openCacheDb(store.driver, layout.directory, key);
}
