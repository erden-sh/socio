import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    type KeyStore,
    openCacheDb,
    openStore,
    type OpenedStore,
    openUserDb,
    type SqlDriver,
    type Store,
    type StoreDeps,
    type StorePush,
    workspaceId,
    workspaceKeyName,
    workspaceLayout,
} from '../../src/data';

import { createNodeFileSystem, type NodeFileSystem } from './node-fs';
import { createNodeSqliteDriver, type NodeSqliteDriver, type NodeSqliteDriverOptions } from './node-sqlite-driver';

// A phone for the store's tests: a temporary document directory, a keychain in
// a Map, the files' fake-cipher keys in another (both outlive a "kill", as the
// real ones do), and helpers that add workspaces the way a sign-in will
// (a pending row, then the directory and both databases, then the jar, then
// ready).

/** SHA-256 as hex, as the platform's expo-crypto binding gives it. */
export const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const nodeRandomBytes = (length: number) => new Uint8Array(randomBytes(length));

/** A keychain in a Map, with a log of writes and deletes. Options fail its calls. */
export interface MemoryKeyStore extends KeyStore {
    readonly values: Map<string, string>;
    readonly log: string[];
}

export interface MemoryKeyStoreOptions {
    /** Runs before each call, which it may fail by throwing. */
    readonly before?: (call: 'get' | 'set' | 'delete', name: string) => void;
}

export function memoryKeyStore(
    values = new Map<string, string>(),
    options: MemoryKeyStoreOptions = {},
): MemoryKeyStore {
    const log: string[] = [];
    return {
        values,
        log,
        get: async (name) => {
            options.before?.('get', name);
            return values.get(name) ?? null;
        },
        set: async (name, value) => {
            options.before?.('set', name);
            log.push(`set ${name}`);
            values.set(name, value);
        },
        delete: async (name) => {
            options.before?.('delete', name);
            log.push(`delete ${name}`);
            values.delete(name);
        },
    };
}

/** What survives a kill of the app: the files (on disk), the keychain and the fake cipher's keys. */
export interface Phone {
    readonly root: string;
    readonly keychain: Map<string, string>;
    readonly cipherKeys: Map<string, string>;
}

export function phone(root: string): Phone {
    return { root, keychain: new Map(), cipherKeys: new Map() };
}

export interface Launch extends OpenedStore {
    readonly driver: NodeSqliteDriver;
    readonly fs: NodeFileSystem;
    readonly keyStore: MemoryKeyStore;
}

export interface LaunchOptions {
    readonly driver?: NodeSqliteDriverOptions;
    readonly keyStore?: MemoryKeyStoreOptions;
    readonly fs?: Parameters<typeof createNodeFileSystem>[0];
    readonly wipeOptions?: StoreDeps['wipeOptions'];
    readonly now?: () => number;
    /** The native push keys every wipe deletes. */
    readonly push?: StorePush;
    /** Called as each wipe has deleted a workspace's files (iOS's app-switcher snapshots, CB-356). */
    readonly wiped?: () => void;
    /** Wraps the node:sqlite driver before the store gets it. */
    readonly wrapDriver?: (driver: SqlDriver) => SqlDriver;
}

/** Launches the app on `device`: openStore with fresh fakes over what survives. */
export async function launch(device: Phone, options: LaunchOptions = {}): Promise<Launch> {
    const driver = createNodeSqliteDriver({ ...options.driver, keys: device.cipherKeys });
    const fs = createNodeFileSystem(options.fs);
    const keyStore = memoryKeyStore(device.keychain, options.keyStore);
    const opened = await openStore({
        root: device.root,
        driver: options.wrapDriver?.(driver) ?? driver,
        fs,
        keyStore,
        randomBytes: nodeRandomBytes,
        now: options.now,
        wipeOptions: options.wipeOptions,
        push: options.push,
        wiped: options.wiped,
    });
    return { ...opened, driver, fs, keyStore };
}

/** Ends the app as a kill does: the OS closes every file it had open. */
export async function kill(store: Store): Promise<void> {
    await Promise.all(store.driver.openFiles().map((file) => store.driver.closeAll(file.directory)));
}

export interface AddedWorkspace {
    readonly id: string;
    readonly origin: string;
    readonly appUserId: string;
}

/**
 * Adds a ready workspace as a sign-in will: a pending row, the directory with
 * both databases (a draft in user.db, a row in cache.db, both closed), the
 * jar, then ready, with the push relay registration push keeps for it. `plant` also writes `-wal`-holding files, images and attachments.
 */
/** The install id `addWorkspace` gives workspace `id`. */
export const installIdOf = (id: string) => id.slice(21, 64);

export async function addWorkspace(
    store: Store,
    origin: string,
    appUserId: string,
    { plant = false }: { plant?: boolean } = {},
): Promise<AddedWorkspace> {
    const id = await workspaceId(sha256, origin, appUserId);
    const layout = workspaceLayout(store.root, id);
    await store.registry.add({ id, origin, appUserId, name: 'Acme', personEmail: 'ada@example.test' });
    await store.fs.mkdir(layout.directory);
    const cacheKey = await store.keys.create(workspaceKeyName(id, 'cache'));
    const userKey = await store.keys.create(workspaceKeyName(id, 'user'));
    const cache = await openCacheDb(store.driver, layout.directory, cacheKey);
    const user = await openUserDb(store.driver, layout.directory, userKey);
    await cache.db.run('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?)', ['conversations', '', 'c1', '{}', null, 1]);
    await user.db.run('INSERT INTO drafts VALUES (?, ?, ?, ?, ?)', ['chat:c1', 'half a thought', 1, 1, null]);
    if (plant) {
        // Keep both open so their -wal and -shm files are on disk, then plant the rest.
        mkdirSync(layout.images);
        writeFileSync(join(layout.images, 'logo.png'), 'png');
        mkdirSync(layout.attachments);
        writeFileSync(join(layout.attachments, 'a1.jpg'), 'jpg');
    } else {
        await cache.db.close();
        await user.db.close();
    }
    await store.keys.write(workspaceKeyName(id, 'jar'), '{"v":1}');
    await store.registry.markReady(id);
    await store.keys.write(
        workspaceKeyName(id, 'relay'),
        JSON.stringify({ v: 1, id: id.slice(0, 22), secret: id.slice(0, 43) }),
    );
    // Its install id: 43 base64url characters, as a sign-in leaves it.
    await store.keys.write(workspaceKeyName(id, 'install'), installIdOf(id));
    await store.registry.setInstallSet(id, 1);
    return { id, origin, appUserId };
}
