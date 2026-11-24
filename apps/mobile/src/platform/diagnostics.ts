import { File, FileMode, Paths } from 'expo-file-system';
import { readDirectoryAsync } from 'expo-file-system/legacy';

import { getFileProtection, setFileProtection } from '../../modules/socio-device';
import {
    createKeys,
    decrypt,
    deleteKeys,
    getKeys,
    type PushKeys,
    type PushStorage,
    pushStorage,
    readInbox,
} from '../../modules/socio-push';
import type { DbFile, SqlConnection } from '../data/driver';
import { newDbKey, REGISTRY_KEY, workspaceKeyName, type RandomBytes } from '../data/keys';
import { joinPath, registryFile, storeDirectory, workspaceLayout } from '../data/layout';
import { openCacheDb, openEncrypted, openUserDb } from '../data/open';
import type { Store } from '../data/wipe';
import { prepareAttachmentsFolder, prepareImagesFolder } from '../data/workspace-files';

import { fileUri } from './file-system';

// What the Diagnostics screen checks (development and preview builds only,
// routes.ts): that the store's files are SQLCipher files on this phone,
// how long they take to open, what the
// app's container holds, and test files for the sign-out wipe to delete. It
// reads only metadata: no row of any file, and no key, leaves this module. The
// one exception is the push check's scratch key, made for the made-up
// workspace id `diagnostics` alone: its public half and auth secret are shown,
// so a body can be encrypted to it off the phone.

/** The first 16 bytes of a plain SQLite file. An encrypted one starts with its salt instead. */
const PLAIN_HEADER = 'SQLite format 3\0';

/** What the first 16 bytes say: 'encrypted' when they aren't SQLite's header (the check passes). */
export type HeaderCheck = 'encrypted' | 'plain' | 'short' | 'unreadable';

/** One database file, opened fail-closed (open.ts) and asked about its cipher. */
export interface FileCheck {
    /** Where it is under `socio/`, with a workspace's id cut to 8 characters. */
    readonly label: string;
    readonly cipherStatus: string | null;
    readonly cipherVersion: string | null;
    readonly header: HeaderCheck;
    /** How long openEncrypted took on it, in milliseconds. */
    readonly openMs: number | null;
    /** Why it couldn't be checked, if it couldn't. */
    readonly problem: string | null;
}

/** A check that couldn't run, as a line. */
function problemOf(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Whether the first 16 bytes of the file at `path` are SQLite's plain header. */
export async function checkHeader(path: string): Promise<HeaderCheck> {
    try {
        const handle = new File(fileUri(path)).open(FileMode.ReadOnly);
        try {
            const bytes = await handle.readBytes(PLAIN_HEADER.length);
            if (bytes.length < PLAIN_HEADER.length) {
                return 'short';
            }
            const plain = [...PLAIN_HEADER].every((char, at) => bytes[at] === char.charCodeAt(0));
            return plain ? 'plain' : 'encrypted';
        } finally {
            handle.close();
        }
    } catch {
        return 'unreadable';
    }
}

/** `PRAGMA cipher_status` and `cipher_version` on an open, keyed connection. */
async function cipherOf(db: SqlConnection): Promise<{ status: string | null; version: string | null }> {
    const status = await db.get<{ cipher_status: unknown }>('PRAGMA cipher_status');
    const version = await db.get<{ cipher_version: unknown }>('PRAGMA cipher_version');
    return {
        status: status?.cipher_status == null ? null : String(status.cipher_status),
        version: version?.cipher_version == null ? null : String(version.cipher_version),
    };
}

const pathOf = (file: DbFile) => joinPath(file.directory, file.name);

/** Opens `file` with `key` on a connection of its own, times it, reads its cipher, closes it, and checks its header. */
async function checkFile(
    store: Store,
    file: DbFile,
    key: string | null,
    label: string,
    clock: () => number,
): Promise<FileCheck> {
    const header = await checkHeader(pathOf(file));
    if (key === null) {
        return { label, cipherStatus: null, cipherVersion: null, header, openMs: null, problem: 'its key is missing' };
    }
    try {
        const started = clock();
        const { db } = await openEncrypted(store.driver, file, key);
        const openMs = clock() - started;
        try {
            const cipher = await cipherOf(db);
            return { label, cipherStatus: cipher.status, cipherVersion: cipher.version, header, openMs, problem: null };
        } finally {
            await db.close();
        }
    } catch (error) {
        return { label, cipherStatus: null, cipherVersion: null, header, openMs: null, problem: problemOf(error) };
    }
}

/** The registry and every workspace's two files, each opened again on a connection of its own. */
export async function checkStoreFiles(store: Store, clock: () => number): Promise<FileCheck[]> {
    const checks = [
        await checkFile(store, registryFile(store.root), await store.keys.read(REGISTRY_KEY), 'registry.db', clock),
    ];
    for (const row of await store.registry.list()) {
        const layout = workspaceLayout(store.root, row.id);
        const short = `${row.id.slice(0, 8)}…/`;
        for (const [file, kind] of [
            [layout.cache, 'cache'],
            [layout.user, 'user'],
        ] as const) {
            const key = await store.keys.read(workspaceKeyName(row.id, kind));
            checks.push(await checkFile(store, file, key, short + file.name, clock));
        }
    }
    return checks;
}

/** Milliseconds for cache.db and user.db. */
export interface OpenTimes {
    readonly cache: number;
    readonly user: number;
}

export interface ScratchRun {
    /** The first open of each new file: the key, auto_vacuum, WAL, and the schema or migrations. */
    readonly created: OpenTimes;
    /** Each file opened again, closed in between: what a launch does. */
    readonly reopened: OpenTimes;
    /** Both files as they were before the delete. */
    readonly files: readonly FileCheck[];
    /** `socio/diagnostics/` is gone afterwards. */
    readonly deleted: boolean;
}

/** `socio/diagnostics/`, the scratch store's folder: not a workspace id, so launch's reconcile leaves it alone. */
export const scratchDirectory = (root: string) => joinPath(storeDirectory(root), 'diagnostics');

/**
 * A scratch store under `socio/diagnostics/`: made with keys that live only in
 * memory, closed, opened again, checked, and deleted. It needs no workspace and
 * no sign-in, so it shows that SQLCipher works and how long both files take.
 */
export async function runScratchStore(
    store: Store,
    randomBytes: RandomBytes,
    clock: () => number,
): Promise<ScratchRun> {
    const { driver, fs } = store;
    const directory = scratchDirectory(store.root);
    await fs.remove(directory);
    await fs.mkdir(directory);
    const cacheKey = newDbKey(randomBytes);
    const userKey = newDbKey(randomBytes);
    const timed = async <T>(open: () => Promise<T>): Promise<[T, number]> => {
        const started = clock();
        const opened = await open();
        return [opened, clock() - started];
    };
    try {
        const [cache, cacheCreated] = await timed(() => openCacheDb(driver, directory, cacheKey));
        await cache.db.close();
        const [user, userCreated] = await timed(() => openUserDb(driver, directory, userKey));
        await user.db.close();

        const [cacheAgain, cacheReopened] = await timed(() => openCacheDb(driver, directory, cacheKey));
        const [userAgain, userReopened] = await timed(() => openUserDb(driver, directory, userKey));
        const files: FileCheck[] = [];
        for (const [opened, name, openMs] of [
            [cacheAgain.db, 'cache.db', cacheReopened],
            [userAgain.db, 'user.db', userReopened],
        ] as const) {
            const cipher = await cipherOf(opened);
            await opened.close();
            files.push({
                label: `diagnostics/${name}`,
                cipherStatus: cipher.status,
                cipherVersion: cipher.version,
                header: await checkHeader(joinPath(directory, name)),
                openMs,
                problem: null,
            });
        }
        return {
            created: { cache: cacheCreated, user: userCreated },
            reopened: { cache: cacheReopened, user: userReopened },
            files,
            deleted: await removeScratch(store, directory),
        };
    } catch (error) {
        await removeScratch(store, directory).catch(() => false);
        throw error;
    }
}

/** Closes and deletes the scratch store's files, then its folder; resolves whether the folder is gone. */
async function removeScratch(store: Store, directory: string): Promise<boolean> {
    await store.driver.closeAll(directory);
    for (const name of ['cache.db', 'user.db']) {
        await store.driver.delete({ directory, name });
    }
    await store.fs.remove(directory);
    return !(await store.fs.exists(directory));
}

/** Test files for the sign-out wipe to delete, in the active workspace's images/ and attachments/. */
export const TEST_FILES = ['images/diagnostics-test.png', 'attachments/diagnostics-test.txt'] as const;

/** A test file written, with the protection class iOS reports for it (null on Android and in the simulator). */
export interface PlantedFile {
    readonly path: string;
    readonly protection: string | null;
}

/**
 * Writes TEST_FILES into the active workspace's directory, each folder
 * prepared with its protection class first (src/data/workspace-files.ts), and
 * resolves what was written, or null with no active workspace.
 */
export async function plantTestFiles(store: Store): Promise<PlantedFile[] | null> {
    const active = await store.registry.active();
    if (active === null) {
        return null;
    }
    const layout = workspaceLayout(store.root, active);
    const deps = { fs: store.fs, setFileProtection };
    const written: PlantedFile[] = [];
    for (const [prepare, directory, name] of [
        [prepareImagesFolder, layout.images, 'diagnostics-test.png'],
        [prepareAttachmentsFolder, layout.attachments, 'diagnostics-test.txt'],
    ] as const) {
        await prepare(deps, layout);
        const path = joinPath(directory, name);
        await new File(fileUri(path)).write(`Socio diagnostics test file, ${name}\n`);
        written.push({ path, protection: await getFileProtection(path) });
    }
    return written;
}

/** One entry of the container's listing. */
export interface ContainerEntry {
    /** Its path under the container, with `/` after a directory's name. */
    readonly path: string;
    /** A file's size in bytes; null for a directory or one that couldn't be read. */
    readonly size: number | null;
    /** Set when a directory couldn't be listed. */
    readonly unreadable?: true;
}

/** The listing stops after this many entries. */
export const LISTING_LIMIT = 1500;

/**
 * Everything in the app's container, recursively: the parent of the document
 * directory, so on Android the data directory (files, cache, databases,
 * shared_prefs, no_backup, app_*) and on iOS the whole sandbox (Documents,
 * Library, its Caches, tmp). A directory that can't be listed says so; it is
 * never read as empty.
 */
export async function listContainer(limit = LISTING_LIMIT): Promise<{ entries: ContainerEntry[]; complete: boolean }> {
    const entries: ContainerEntry[] = [];
    const walk = async (uri: string, prefix: string): Promise<void> => {
        let names: string[];
        try {
            names = (await readDirectoryAsync(uri)).sort();
        } catch {
            entries.push({ path: prefix || '/', size: null, unreadable: true });
            return;
        }
        for (const name of names) {
            if (entries.length >= limit) {
                return;
            }
            const child = `${uri.replace(/\/*$/, '')}/${encodeURIComponent(name)}`;
            if (Paths.info(child).isDirectory === true) {
                entries.push({ path: `${prefix}${name}/`, size: null });
                await walk(child, `${prefix}${name}/`);
            } else {
                let size: number | null = null;
                try {
                    size = new File(child).size;
                } catch {
                    size = null;
                }
                entries.push({ path: prefix + name, size });
            }
        }
    };
    await walk(Paths.document.parentDirectory.uri, '');
    return { entries, complete: entries.length < limit };
}

/** The push check's made-up workspace id: never a workspace's (those are 64 hex characters). */
export const PUSH_CHECK_ID = 'diagnostics';

/** A body to decrypt, written into the documents folder from outside (socio-push's README, Checks). */
export const PUSH_CHECK_FILE = 'diagnostics-push.txt';

export interface PushCheck {
    readonly storage: PushStorage;
    /** The scratch key's public half and auth secret. */
    readonly keys: PushKeys;
    /** Made now, rather than kept from before (which is the round trip through the keychain). */
    readonly created: boolean;
    /** PUSH_CHECK_FILE's plaintext, why it didn't decrypt, or null with no file. */
    readonly decrypted: { readonly text: string } | { readonly problem: string } | null;
    readonly inboxFiles: number;
}

/**
 * socio-push on this phone: where its items go, the scratch key read back from
 * the keychain (made on the first run), and PUSH_CHECK_FILE decrypted with it,
 * then deleted.
 */
export async function checkPush(): Promise<PushCheck> {
    const storage = await pushStorage();
    const kept = await getKeys(PUSH_CHECK_ID);
    const keys = kept ?? (await createKeys(PUSH_CHECK_ID));
    const file = new File(Paths.document, PUSH_CHECK_FILE);
    let decrypted: PushCheck['decrypted'] = null;
    if (file.exists) {
        try {
            decrypted = { text: await decrypt(PUSH_CHECK_ID, (await file.text()).trim()) };
        } catch (error) {
            decrypted = { problem: error instanceof Error ? error.message : String(error) };
        }
        file.delete();
    }
    const inbox = await readInbox();
    return {
        storage,
        keys,
        created: kept === null,
        decrypted,
        inboxFiles: inbox.entries.length + inbox.unreadable.length,
    };
}

/** Deletes the push check's scratch key. */
export async function deletePushCheckKey(): Promise<void> {
    await deleteKeys(PUSH_CHECK_ID);
}
