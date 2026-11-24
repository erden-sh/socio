import type { SqlDriver } from './driver';
import {
    createKeys,
    type KeyStore,
    type RandomBytes,
    REGISTRY_KEY,
    workspaceKeyName,
    workspaceKeyNames,
    workspaceOfKey,
} from './keys';
import {
    type FileSystem,
    FileSystemMismatchError,
    isWorkspaceId,
    joinPath,
    REGISTRY_DB,
    registryFile,
    storeDirectory,
    workspaceDirectories,
    workspaceLayout,
} from './layout';
import { isPushRevocationKey, recordPushRevocation } from './push-revocation';
import { openRegistry } from './registry';
import {
    resumeWipes,
    type Store,
    type StorePush,
    trackConnections,
    wipeEach,
    type WipedWorkspace,
    type WipeOptions,
} from './wipe';

// Opening the store at launch, before the first frame. Three things decide what launch does:
// whether `socio/registry.db` is there (R), whether the app's keys are in
// secure storage (K: the registry's key; with no registry, any name in the
// index), and whether workspace directories are there (F).
//
// | R | K | F | What happened                                 | Cell                   | Launch                                        | Tell |
// | - | - | - | --------------------------------------------- | ---------------------- | --------------------------------------------- | ---- |
// | 0 | 0 | 0 | a first launch                                | `first-launch`         | makes the registry and its key                | no   |
// | 0 | 1 | 0 | a reinstall on iOS, whose keychain survives   | `reinstall`            | deletes every indexed key, then as first      | no   |
// | 0 | 0 | 1 | files without their keys (a restore)          | `restore`              | deletes the directories, then as first        | yes  |
// | 0 | 1 | 1 | the registry lost: no way to reach the files  | `registry-lost`        | deletes the keys and directories, then first  | yes  |
// | 1 | 0 | 0 | the registry without its key, no workspace    | `registry-without-key` | deletes the registry, then as first           | no   |
// | 1 | 0 | 1 | the registry and files without keys (restore) | `registry-without-key` | deletes the registry, keys and directories    | yes  |
// | 1 | 1 | 0 | every workspace's directory gone              | `opened`               | opens it; wipes each one ('files-missing')    | yes* |
// | 1 | 1 | 1 | a normal launch                               | `opened`               | opens it, finishes marked wipes, reconciles   | yes* |
//
// * Only when a workspace the person could see was wiped.
//
// R and F come from one listing of `socio/`. A listing can leave out what is
// there (expo-file-system's Android `list()` answers [] when it can't read,
// layout.ts), so an entry is taken as missing only when `exists` agrees:
// `exists` must find `socio/` itself, must agree with the listing about
// `registry.db`, and must not find a registered workspace's directory the
// listing left out. Any disagreement throws FileSystemMismatchError before
// anything is deleted.
//
// Reconciling an opened registry, after the marked and pending wipes finish:
// - a ready workspace whose directory is gone: wiped ('files-missing'), told;
// - a ready workspace whose directory is there but whose cache or user key
//   isn't: files without their key, wiped ('keys-missing'), told. A missing
//   jar alone is no reason: the workspace opens signed out (an empty jar), and
//   its first request's 401 says so;
// - a directory no row names: deleted with any key named from its id, told;
// - an indexed key of no workspace in the registry: deleted, not told.
//
// What launch never does:
// - **delete on a read error.** A key store that throws (an iPhone before its
//   first unlock: the platform waits for protected data before this runs), a
//   file system that throws, or a listing `exists` contradicts stops
//   the launch with that error, and nothing is deleted;
// - **delete on a wrong key.** SQLCipher answers a damaged first page as it
//   answers a wrong key (SQLITE_NOTADB, open.ts), so "files without their key"
//   means the key is missing from secure storage, never that an open failed.
//   A registry its key doesn't open throws open.ts's StoreOpenError
//   ('wrong-key', 'damaged', 'busy', 'read-failed') for the app to report, and
//   is left as it is; a workspace's files are opened later, and the
//   same holds there.
//
// Deletion order keeps a kill safe: the next launch lands in a cell that
// finishes the work. Whole-store cleanup deletes the registry first, then the
// keys, then the directories, so until the last step a relaunch still finds
// the directories and still tells the person. No cleanup deletes a push
// revocation record, and every push relay registration it can still read
// becomes one first, so the relay is told even after a reinstall.

/** Which cell of the table above a launch was in. */
export type LaunchCell = 'first-launch' | 'reinstall' | 'restore' | 'registry-lost' | 'registry-without-key' | 'opened';

/**
 * Whether a launch in this cell made the store: every cell but `opened` deletes what it found and
 * creates a new registry, so for the person it is a first launch (an iOS reinstall keeps the
 * keychain but the OS resets notification permission, for one).
 */
export function madeStore(cell: LaunchCell): boolean {
    return cell !== 'opened';
}

export interface LaunchReport {
    /** What launch found: R, K and F above. */
    readonly found: { readonly registry: boolean; readonly keys: boolean; readonly files: boolean };
    readonly cell: LaunchCell;
    /** Workspaces wiped through the registry, with why: marked and pending wipes, and the reconcile's. */
    readonly wiped: readonly WipedWorkspace[];
    /** Workspace directories deleted without a registry row: the whole-store cells and orphans. */
    readonly removedDirectories: number;
    /** Data the person could see was deleted without their asking: tell them. */
    readonly tell: boolean;
}

export interface StoreDeps {
    /** The app's document directory: the store goes in `<root>/socio`. */
    readonly root: string;
    /** The platform's SQLite driver; the store tracks its connections (wipe.ts). */
    readonly driver: SqlDriver;
    readonly fs: FileSystem;
    readonly keyStore: KeyStore;
    readonly randomBytes: RandomBytes;
    /** The device clock, for the registry's times. */
    readonly now?: () => number;
    /** The native push keys every wipe deletes (socio-push). */
    readonly push?: StorePush;
    /** Called as each wipe has deleted a workspace's files: iOS's app-switcher snapshots go too (wipe.ts). */
    readonly wiped?: () => void;
    /** For tests: passed to every wipe launch runs. */
    readonly wipeOptions?: WipeOptions;
}

export interface OpenedStore {
    readonly store: Store;
    readonly launch: LaunchReport;
}

/** Wipe reasons the person didn't choose, which they're told about, on the launch that wipes and on one that resumes it. */
const TOLD: ReadonlySet<string> = new Set(['files-missing', 'keys-missing']);

/** `exists` must answer as the listing did about `path`; otherwise neither can be trusted. */
async function confirm(fs: FileSystem, path: string, listed: boolean): Promise<void> {
    if ((await fs.exists(path)) !== listed) {
        throw new FileSystemMismatchError(path, listed);
    }
}

/**
 * Opens the store at launch, before the first frame: settles the cell above,
 * opens or makes the registry, finishes marked wipes (`resumeWipes`), wipes
 * the sign-ins a kill left pending, and reconciles the rest. The root calls it
 * once the platform has protected data and hands the store to the
 * gate.
 */
export async function openStore(deps: StoreDeps): Promise<OpenedStore> {
    const { root, fs, now = Date.now } = deps;
    const driver = trackConnections(deps.driver);
    const keys = createKeys(deps.keyStore, deps.randomBytes);
    const folder = storeDirectory(root);
    await fs.mkdir(folder);

    const entries = await fs.list(folder);
    await confirm(fs, folder, true);
    const registryPresent = entries.includes(REGISTRY_DB);
    await confirm(fs, joinPath(folder, REGISTRY_DB), registryPresent);
    const directories = entries.filter(isWorkspaceId).sort();
    const registryKey = await keys.read(REGISTRY_KEY);
    const indexed = await keys.indexed();
    const found = {
        registry: registryPresent,
        keys: registryPresent ? registryKey !== null : registryKey !== null || indexed.length > 0,
        files: directories.length > 0,
    };

    if (registryPresent && registryKey !== null) {
        const registry = await openRegistry(driver, root, registryKey, now);
        const store: Store = { root, driver, fs, keys, registry, push: deps.push, wiped: deps.wiped };
        try {
            return { store, launch: await reconcile(store, found, deps.wipeOptions) };
        } catch (error) {
            await registry.close().catch(() => {});
            throw error;
        }
    }

    const cell: LaunchCell = registryPresent
        ? 'registry-without-key'
        : found.files
          ? found.keys
              ? 'registry-lost'
              : 'restore'
          : found.keys
            ? 'reinstall'
            : 'first-launch';

    // Whole-store cleanup: the registry, then the keys, then the directories.
    const registryDb = registryFile(root);
    if (registryPresent) {
        await driver.delete(registryDb);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
        await fs.remove(joinPath(registryDb.directory, registryDb.name + suffix));
    }
    const names = new Set([...indexed, REGISTRY_KEY, ...directories.flatMap(workspaceKeyNames)]);
    // Each push registration that can still be read outlives the cleanup as a revocation record.
    const recorded = await recordRelays(keys, [...names]);
    await keys.delete([...names].filter((name) => !isPushRevocationKey(name)));
    if (recorded) {
        deps.push?.recorded?.();
    }
    for (const id of directories) {
        await fs.remove(workspaceLayout(root, id).directory);
    }

    const registry = await openRegistry(driver, root, await keys.create(REGISTRY_KEY), now);
    return {
        store: { root, driver, fs, keys, registry, push: deps.push, wiped: deps.wiped },
        launch: { found, cell, wiped: [], removedDirectories: directories.length, tell: found.files },
    };
}

/** The opened registry's launch: resumed wipes, then the reconcile above. */
async function reconcile(
    store: Store,
    found: LaunchReport['found'],
    options: WipeOptions | undefined,
): Promise<LaunchReport> {
    const { root, fs, keys, registry } = store;
    const wiped = [...(await resumeWipes(store, options))];
    // Only launch wipes a pending row: here it is a sign-in a kill interrupted, never one being committed.
    const pending = (await registry.list()).filter((row) => row.state === 'pending');
    wiped.push(
        ...(await wipeEach(
            store,
            pending.map((row) => ({ id: row.id, reason: 'unfinished' })),
            options,
        )),
    );

    // Every reason is settled before anything is deleted, so a listing `exists` contradicts deletes nothing.
    const rows = await registry.list();
    const directories = new Set(await workspaceDirectories(fs, root));
    const reconciled: WipedWorkspace[] = [];
    for (const row of rows) {
        if (!directories.has(row.id)) {
            await confirm(fs, workspaceLayout(root, row.id).directory, false);
            reconciled.push({ id: row.id, reason: 'files-missing' });
        } else if (
            (await keys.read(workspaceKeyName(row.id, 'cache'))) === null ||
            (await keys.read(workspaceKeyName(row.id, 'user'))) === null
        ) {
            reconciled.push({ id: row.id, reason: 'keys-missing' });
        }
    }
    wiped.push(...(await wipeEach(store, reconciled, options)));

    const known = new Set(rows.map((row) => row.id));
    let removedDirectories = 0;
    let recorded = false;
    for (const id of directories) {
        if (!known.has(id)) {
            await store.driver.closeAll(workspaceLayout(root, id).directory);
            recorded = (await recordRelays(keys, workspaceKeyNames(id))) || recorded;
            await keys.delete(workspaceKeyNames(id));
            await fs.remove(workspaceLayout(root, id).directory);
            removedDirectories += 1;
        }
    }

    const stray = (await keys.indexed()).filter((name) => {
        const id = workspaceOfKey(name);
        return id !== null && !known.has(id);
    });
    recorded = (await recordRelays(keys, stray)) || recorded;
    await keys.delete(stray);
    if (recorded) {
        store.push?.recorded?.();
    }

    return {
        found,
        cell: 'opened',
        wiped,
        removedDirectories,
        tell: removedDirectories > 0 || wiped.some((workspace) => TOLD.has(workspace.reason)),
    };
}

/**
 * Copies every workspace's push relay registration among `names` that can
 * still be read to its revocation record (push-revocation.ts) before launch
 * deletes them, so the relay is still told. Resolves whether it kept one.
 */
async function recordRelays(keys: Store['keys'], names: readonly string[]): Promise<boolean> {
    let recorded = false;
    for (const name of names) {
        const id = workspaceOfKey(name);
        if (id !== null && name === workspaceKeyName(id, 'relay') && (await recordPushRevocation(keys, id)) !== null) {
            recorded = true;
        }
    }
    return recorded;
}
