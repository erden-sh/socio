import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    FileSystemMismatchError,
    INDEX_KEY,
    type LaunchCell,
    madeStore,
    pushRevocationName,
    REGISTRY_KEY,
    StoreOpenError,
    USER_DB,
    workspaceId,
    workspaceKeyName,
    workspaceKeyNames,
    wipe,
} from '../../src/data';
import { addWorkspace, type AddedWorkspace, kill, launch, phone, type Phone, sha256 } from '../helpers/store';

// Launch's reinstall and restore matrix (src/data/store.ts): the registry
// present or not (R) × the app's keys present or not (K) × workspace files
// present or not (F), each cell decided and tested, then the reconcile of an
// opened registry.

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-store-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});

const socio = () => join(device.root, 'socio');
const dir = (id: string) => join(socio(), id);
/** What's in socio/, the registry's files left out. */
const workspaceDirs = () => readdirSync(socio()).filter((name) => /^[0-9a-f]{64}$/.test(name));
const removeRegistry = () => {
    for (const suffix of ['', '-wal', '-shm']) {
        rmSync(join(socio(), `registry.db${suffix}`), { force: true });
    }
};

/** A phone that has been used: two workspaces, ada's active, then the app quit. */
async function used(): Promise<{ ada: AddedWorkspace; bob: AddedWorkspace }> {
    const { store } = await launch(device);
    const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
    const bob = await addWorkspace(store, 'http://localhost:4352', 'u-bob');
    await store.registry.setActive(ada.id);
    await store.registry.close();
    return { ada, bob };
}

/** The keychain's names other than the new registry key and the index. */
const oldKeys = () => [...device.keychain.keys()].filter((name) => name !== REGISTRY_KEY && name !== INDEX_KEY);
/** Each workspace's push revocation record, as its kept relay registration makes it. */
const recordsOf = (...workspaces: AddedWorkspace[]) =>
    workspaces.map((workspace) => pushRevocationName(workspace.id.slice(0, 22))!).sort();

describe('the matrix', () => {
    it('R0 K0 F0, a first launch: makes the registry and its key, and tells nothing', async () => {
        const { store, launch: report } = await launch(device);
        expect(report).toEqual({
            found: { registry: false, keys: false, files: false },
            cell: 'first-launch',
            wiped: [],
            removedDirectories: 0,
            tell: false,
        });
        expect(readdirSync(socio()).sort()).toEqual(['registry.db', 'registry.db-shm', 'registry.db-wal']);
        expect(device.keychain.get(REGISTRY_KEY)).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.parse(device.keychain.get(INDEX_KEY) ?? '')).toEqual({ v: 1, keys: [REGISTRY_KEY] });
        expect(await store.registry.list()).toEqual([]);
        await store.registry.close();
    });

    it('R0 K1 F0, a reinstall on iOS: deletes every key the old install left, silently', async () => {
        const { ada, bob } = await used();
        const oldRegistryKey = device.keychain.get(REGISTRY_KEY);
        // The app's files go with the app; the keychain stays.
        rmSync(socio(), { recursive: true });

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({
            found: { registry: false, keys: true, files: false },
            cell: 'reinstall',
            tell: false,
        });
        // Only each push registration, now a revocation record, so the relay is still told.
        expect(oldKeys().sort()).toEqual(recordsOf(ada, bob));
        expect(device.keychain.get(REGISTRY_KEY)).not.toBe(oldRegistryKey);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'jar'))).toBe(false);
        expect(await store.registry.list()).toEqual([]);
        await store.registry.close();
    });

    it('R0 K1 F0 with a damaged index: the reinstall still finds every name in it', async () => {
        const { ada, bob } = await used();
        rmSync(socio(), { recursive: true });
        // Cut short, so it isn't JSON any more; the names in it are still the old install's.
        const index = device.keychain.get(INDEX_KEY)!;
        device.keychain.set(INDEX_KEY, index.slice(0, index.lastIndexOf('"')));

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ cell: 'reinstall', tell: false });
        expect(oldKeys().sort()).toEqual(recordsOf(ada, bob));
        expect(device.keychain.has(workspaceKeyName(ada.id, 'cache'))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(bob.id, 'jar'))).toBe(false);
        await store.registry.close();
    });

    it('R0 K0 F1, files without their keys (a restore): deletes them and tells the person', async () => {
        await used();
        removeRegistry();
        device.keychain.clear();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({
            found: { registry: false, keys: false, files: true },
            cell: 'restore',
            removedDirectories: 2,
            tell: true,
        });
        expect(workspaceDirs()).toEqual([]);
        await store.registry.close();
    });

    it('R0 K1 F1, the registry lost: deletes the keys and the unreachable files, and tells', async () => {
        const { ada, bob } = await used();
        removeRegistry();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({
            found: { registry: false, keys: true, files: true },
            cell: 'registry-lost',
            removedDirectories: 2,
            tell: true,
        });
        expect(workspaceDirs()).toEqual([]);
        expect(oldKeys().sort()).toEqual(recordsOf(ada, bob));
        await store.registry.close();
    });

    it('R1 K0 F0, the registry without its key and no workspace: makes a new one, silently', async () => {
        const first = await launch(device);
        await first.store.registry.close();
        device.keychain.clear();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({
            found: { registry: true, keys: false, files: false },
            cell: 'registry-without-key',
            tell: false,
        });
        expect(await store.registry.list()).toEqual([]);
        await store.registry.close();
    });

    it('R1 K0 F1, the registry and files without their keys (a restore): deletes all and tells', async () => {
        await used();
        device.keychain.clear();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({
            found: { registry: true, keys: false, files: true },
            cell: 'registry-without-key',
            removedDirectories: 2,
            tell: true,
        });
        expect(workspaceDirs()).toEqual([]);
        expect(await store.registry.list()).toEqual([]);
        await store.registry.close();
    });

    it('R1 K1 F0, every workspace’s directory gone: wipes each one and tells', async () => {
        const { ada, bob } = await used();
        rmSync(dir(ada.id), { recursive: true });
        rmSync(dir(bob.id), { recursive: true });

        const { store, launch: report } = await launch(device);
        expect(report).toEqual({
            found: { registry: true, keys: true, files: false },
            cell: 'opened',
            wiped: [
                { id: ada.id, reason: 'files-missing' },
                { id: bob.id, reason: 'files-missing' },
            ],
            removedDirectories: 0,
            tell: true,
        });
        expect(await store.registry.list()).toEqual([]);
        expect(await store.registry.active()).toBeNull();
        // Only each workspace's push revocation record is left, for the relay.
        expect(oldKeys().sort()).toEqual(
            [ada, bob].map((workspace) => pushRevocationName(workspace.id.slice(0, 22))).sort(),
        );
        await store.registry.close();
    });

    it('R1 K1 F1, a normal launch: opens everything as it was and tells nothing', async () => {
        const { ada, bob } = await used();
        const userBefore = readFileSync(join(dir(ada.id), USER_DB));

        const { store, launch: report } = await launch(device);
        expect(report).toEqual({
            found: { registry: true, keys: true, files: true },
            cell: 'opened',
            wiped: [],
            removedDirectories: 0,
            tell: false,
        });
        expect((await store.registry.list()).map((row) => [row.id, row.state])).toEqual([
            [ada.id, 'ready'],
            [bob.id, 'ready'],
        ]);
        expect(await store.registry.active()).toBe(ada.id);
        expect(readFileSync(join(dir(ada.id), USER_DB)).equals(userBefore)).toBe(true);
        expect(oldKeys().sort()).toEqual([...workspaceKeyNames(ada.id), ...workspaceKeyNames(bob.id)].sort());
        await store.registry.close();
    });
});

describe('push revocation records through whole-store cleanup', () => {
    it('keeps the records a wipe left and turns each readable registration into one, then tells push', async () => {
        const { ada, bob } = await used();
        // A sign-out of ada before the reinstall kept her record; bob's registration is still kept.
        const first = await launch(device);
        await wipe(first.store, ada.id, 'sign-out');
        await first.store.registry.close();
        rmSync(socio(), { recursive: true });

        let recorded = 0;
        const { store } = await launch(device, {
            push: { deleteKeys: async () => {}, recorded: () => (recorded += 1) },
        });
        expect(oldKeys().sort()).toEqual(recordsOf(ada, bob));
        expect(JSON.parse(device.keychain.get(recordsOf(bob)[0]!)!)).toEqual({
            v: 1,
            id: bob.id.slice(0, 22),
            secret: bob.id.slice(0, 43),
        });
        expect((await store.keys.indexed()).filter((name) => name.startsWith('socio.revoke-push.')).sort()).toEqual(
            recordsOf(ada, bob),
        );
        expect(recorded).toBe(1);
        await store.registry.close();
    });

    it('records the registration of a directory no row names, and of an indexed name of no workspace', async () => {
        const { ada } = await used();
        const orphan = await workspaceId(sha256, 'https://old.example.test', 'u-old');
        const stray = await workspaceId(sha256, 'https://older.example.test', 'u-older');
        mkdirSync(dir(orphan), { recursive: true });
        const relayOf = (id: string) => JSON.stringify({ v: 1, id: id.slice(0, 22), secret: id.slice(0, 43) });
        device.keychain.set(workspaceKeyName(orphan, 'relay'), relayOf(orphan));
        const first = await launch(device);
        await first.store.keys.write(workspaceKeyName(stray, 'relay'), relayOf(stray));
        await first.store.registry.close();

        const { store } = await launch(device);
        expect(device.keychain.has(workspaceKeyName(orphan, 'relay'))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(stray, 'relay'))).toBe(false);
        const records = [orphan, stray].map((id) => pushRevocationName(id.slice(0, 22))!);
        for (const name of records) {
            expect(device.keychain.has(name)).toBe(true);
        }
        expect(device.keychain.has(workspaceKeyName(ada.id, 'relay'))).toBe(true);
        await store.registry.close();
    });
});

describe('reconciling an opened registry', () => {
    it('wipes a workspace whose files are there without a database key, and tells', async () => {
        const { ada, bob } = await used();
        device.keychain.delete(workspaceKeyName(ada.id, 'user'));

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ wiped: [{ id: ada.id, reason: 'keys-missing' }], tell: true });
        expect(workspaceDirs()).toEqual([bob.id]);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'cache'))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'jar'))).toBe(false);
        expect((await store.registry.list()).map((row) => row.id)).toEqual([bob.id]);
        await store.registry.close();
    });

    it('keeps a workspace that lost only its jar: it opens signed out', async () => {
        const { ada } = await used();
        device.keychain.delete(workspaceKeyName(ada.id, 'jar'));

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ wiped: [], tell: false });
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'ready' });
        await store.registry.close();
    });

    it('deletes a directory no row names, with any key named from it, and tells', async () => {
        await used();
        const orphan = await workspaceId(sha256, 'https://old.example.test', 'u-old');
        mkdirSync(join(dir(orphan), 'images'), { recursive: true });
        writeFileSync(join(dir(orphan), 'user.db'), 'old');
        device.keychain.set(workspaceKeyName(orphan, 'user'), 'ff'.repeat(32));

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ wiped: [], removedDirectories: 1, tell: true });
        expect(existsSync(dir(orphan))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(orphan, 'user'))).toBe(false);
        await store.registry.close();
    });

    it('deletes an indexed key of no workspace, silently', async () => {
        const { ada } = await used();
        const gone = await workspaceId(sha256, 'https://old.example.test', 'u-old');
        const first = await launch(device);
        await first.store.keys.write(workspaceKeyName(gone, 'jar'), '{}');
        await first.store.registry.close();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ wiped: [], removedDirectories: 0, tell: false });
        expect(device.keychain.has(workspaceKeyName(gone, 'jar'))).toBe(false);
        expect(await store.keys.indexed()).not.toContain(workspaceKeyName(gone, 'jar'));
        expect(device.keychain.has(workspaceKeyName(ada.id, 'jar'))).toBe(true);
        await store.registry.close();
    });

    it('leaves an indexed name of a later kind, which must outlive its workspace', async () => {
        const { ada } = await used();
        const first = await launch(device);
        await first.store.keys.write(`socio.${ada.id}.revoke`, '{}');
        await first.store.registry.markWiping(ada.id, 'sign-out');
        await first.store.registry.close();

        const { store, launch: report } = await launch(device);
        expect(report.wiped).toEqual([{ id: ada.id, reason: 'sign-out' }]);
        expect(device.keychain.has(`socio.${ada.id}.revoke`)).toBe(true);
        expect(await store.keys.indexed()).toContain(`socio.${ada.id}.revoke`);
        await store.registry.close();
    });

    it('wipes a sign-in a kill left pending, silently', async () => {
        const { ada } = await used();
        const first = await launch(device);
        const id = await workspaceId(sha256, 'https://new.example.test', 'u-new');
        await first.store.registry.add({ id, origin: 'https://new.example.test', appUserId: 'u-new', name: 'New' });
        await first.store.fs.mkdir(dir(id));
        await first.store.keys.create(workspaceKeyName(id, 'cache'));
        await kill(first.store);
        await first.store.registry.close();

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ wiped: [{ id, reason: 'unfinished' }], tell: false });
        expect(existsSync(dir(id))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(id, 'cache'))).toBe(false);
        expect((await store.registry.list()).map((row) => row.id)).toContain(ada.id);
        await store.registry.close();
    });
});

describe('madeStore', () => {
    // The notification ask never shows on the launch that made the store: every cell but
    // opened makes a new registry, an iOS reinstall included.
    it.each<[LaunchCell, boolean]>([
        ['first-launch', true],
        ['reinstall', true],
        ['restore', true],
        ['registry-lost', true],
        ['registry-without-key', true],
        ['opened', false],
    ])('%s made the store: %s', (cell, made) => {
        expect(madeStore(cell)).toBe(made);
    });
});

describe('what launch never does', () => {
    it('never deletes on a wrong key: the registry’s key present but not reading it is reported', async () => {
        const { ada } = await used();
        device.keychain.set(REGISTRY_KEY, '00'.repeat(32));
        const keychainBefore = new Map(device.keychain);

        const error = await launch(device).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(StoreOpenError);
        expect(error).toMatchObject({ failure: 'wrong-key' });
        expect(existsSync(join(socio(), 'registry.db'))).toBe(true);
        expect(workspaceDirs()).toContain(ada.id);
        expect(device.keychain).toEqual(keychainBefore);
    });

    it('never deletes on a keychain read error (an iPhone before its first unlock)', async () => {
        await used();
        const keychainBefore = new Map(device.keychain);
        const failing = {
            keyStore: {
                before: (call: string) => {
                    if (call === 'get') {
                        throw new Error('User interaction is not allowed.');
                    }
                },
            },
        };

        await expect(launch(device, failing)).rejects.toThrow(/interaction/);
        expect(workspaceDirs()).toHaveLength(2);
        expect(existsSync(join(socio(), 'registry.db'))).toBe(true);
        expect(device.keychain).toEqual(keychainBefore);
    });

    it('never deletes on a file-system error', async () => {
        await used();
        device.keychain.clear();
        const failing = {
            fs: {
                before: (call: string) => {
                    if (call === 'list') {
                        throw new Error('EIO');
                    }
                },
            },
        };

        await expect(launch(device, failing)).rejects.toThrow('EIO');
        expect(workspaceDirs()).toHaveLength(2);
        expect(existsSync(join(socio(), 'registry.db'))).toBe(true);
    });

    it('never deletes on a listing that leaves out what is there (expo-file-system’s Android list() answers [] on an I/O error)', async () => {
        const { ada, bob } = await used();
        const userBefore = readFileSync(join(dir(ada.id), USER_DB));
        const keychainBefore = new Map(device.keychain);
        const blind = { fs: { list: (path: string, entries: string[]) => (path === socio() ? [] : entries) } };

        const error = await launch(device, blind).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FileSystemMismatchError);
        expect(error).toMatchObject({ path: join(socio(), 'registry.db'), listed: false });
        expect(readFileSync(join(dir(ada.id), USER_DB)).equals(userBefore)).toBe(true);
        expect(workspaceDirs().sort()).toEqual([ada.id, bob.id].sort());
        expect(device.keychain).toEqual(keychainBefore);

        // The next launch, with a listing that works, opens everything as it was.
        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ cell: 'opened', wiped: [], tell: false });
        await store.registry.close();
    });

    it('never wipes a workspace as files-missing when exists finds the directory the listing left out', async () => {
        const { ada, bob } = await used();
        const keychainBefore = new Map(device.keychain);
        const blind = {
            fs: {
                list: (path: string, entries: string[]) =>
                    path === socio() ? entries.filter((name) => name !== ada.id) : entries,
            },
        };

        const error = await launch(device, blind).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FileSystemMismatchError);
        expect(error).toMatchObject({ path: dir(ada.id), listed: false });
        // Nothing is deleted, the other workspace included: every reason is settled first.
        expect(workspaceDirs().sort()).toEqual([ada.id, bob.id].sort());
        expect(existsSync(join(dir(ada.id), USER_DB))).toBe(true);
        expect(device.keychain).toEqual(keychainBefore);
        const { store } = await launch(device);
        expect((await store.registry.list()).map((row) => row.state)).toEqual(['ready', 'ready']);
        await store.registry.close();
    });

    it('stops, deleting nothing, on an exists bound to directories only (expo’s Directory.exists)', async () => {
        const { ada } = await used();
        const keychainBefore = new Map(device.keychain);
        // Without the check this read the registry as gone, so the launch took it as lost and deleted everything.
        const directoriesOnly = { fs: { exists: (_path: string, kind: string | null) => kind === 'directory' } };

        const error = await launch(device, directoriesOnly).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FileSystemMismatchError);
        expect(error).toMatchObject({ path: join(socio(), 'registry.db'), listed: true });
        expect(existsSync(join(socio(), 'registry.db'))).toBe(true);
        expect(existsSync(join(dir(ada.id), USER_DB))).toBe(true);
        expect(device.keychain).toEqual(keychainBefore);
    });

    it('stops, deleting nothing, on an exists bound to files only (expo’s File.exists)', async () => {
        const { ada } = await used();
        const keychainBefore = new Map(device.keychain);
        // Such a binding would let a wipe skip the directory and still pass its check.
        const filesOnly = { fs: { exists: (_path: string, kind: string | null) => kind === 'file' } };

        const error = await launch(device, filesOnly).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FileSystemMismatchError);
        expect(error).toMatchObject({ path: socio(), listed: true });
        expect(existsSync(join(dir(ada.id), USER_DB))).toBe(true);
        expect(device.keychain).toEqual(keychainBefore);
    });

    it('still tells after a kill in the middle of a restore’s cleanup', async () => {
        await used();
        device.keychain.clear();
        // Killed as the first workspace directory is removed: the registry and keys are already gone.
        let removes = 0;
        const killing = {
            fs: {
                before: (call: string, path: string) => {
                    if (call === 'remove' && /[0-9a-f]{64}$/.test(path) && removes++ === 0) {
                        throw new Error('killed');
                    }
                },
            },
        };
        await expect(launch(device, killing)).rejects.toThrow('killed');
        expect(existsSync(join(socio(), 'registry.db'))).toBe(false);

        const { store, launch: report } = await launch(device);
        expect(report).toMatchObject({ cell: 'restore', removedDirectories: 2, tell: true });
        expect(workspaceDirs()).toEqual([]);
        await store.registry.close();
    });
});
