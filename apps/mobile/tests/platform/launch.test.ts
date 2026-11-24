import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REGISTRY_KEY, storeDirectory } from '../../src/data';
import { type LaunchDeps, openDeviceStore } from '../../src/platform/launch';
import { createSecureKeyStore, isKeyStoreReadError, KeyStoreReadError } from '../../src/platform/secure-store';
import { createNodeFileSystem } from '../helpers/node-fs';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { memoryKeyStore, nodeRandomBytes, phone, type Phone } from '../helpers/store';

// Opening the store at launch (src/platform/launch.ts): socio/ kept out of
// backups before anything is in it, and on iOS a wait for protected data only
// after a key read fails (socio-device's README), then one more open. And the
// key store's binding (src/platform/secure-store.ts): a failed read throws,
// never answering null.

vi.mock('expo-secure-store', () => ({
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-launch-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});

/** iOS before its first unlock: secure storage refuses its first `refusals` reads. */
function deps(options: { refusals?: number; ios?: boolean; log?: string[] } = {}): LaunchDeps & { log: string[] } {
    const log = options.log ?? [];
    let refusals = options.refusals ?? 0;
    return {
        log,
        root: device.root,
        driver: createNodeSqliteDriver({ keys: device.cipherKeys }),
        fs: createNodeFileSystem(),
        keyStore: memoryKeyStore(device.keychain, {
            before: (call) => {
                if (call === 'get' && refusals > 0) {
                    refusals -= 1;
                    log.push('key read refused');
                    throw new KeyStoreReadError(new Error('errSecInteractionNotAllowed'));
                }
            },
        }),
        randomBytes: nodeRandomBytes,
        excludeFromBackup: async (path) => {
            log.push(`exclude ${path.slice(device.root.length)} holding [${readdirSync(path).join(', ')}]`);
        },
        whenProtectedDataAvailable:
            options.ios === false
                ? null
                : async () => {
                      log.push('waited for protected data');
                  },
        clock: () => performance.now(),
    };
}

describe('opening the store at launch', () => {
    it('makes socio/ and keeps it out of backups before anything is in it, then opens the store', async () => {
        const launch = deps();
        const launched = await openDeviceStore(launch);
        expect(launch.log).toEqual(['exclude /socio holding []']);
        expect(launched.opened.launch.cell).toBe('first-launch');
        expect(launched.waited).toBe(false);
        expect(launched.openMs).toBeGreaterThanOrEqual(0);
        expect(existsSync(join(storeDirectory(device.root), 'registry.db'))).toBe(true);
        await launched.opened.store.registry.close();
    });

    it('keeps socio/ out of backups on every launch', async () => {
        await (await openDeviceStore(deps())).opened.store.registry.close();
        const again = deps();
        const launched = await openDeviceStore(again);
        expect(again.log).toEqual([expect.stringMatching(/^exclude \/socio holding \[registry\.db/)]);
        expect(launched.opened.launch.cell).toBe('opened');
        await launched.opened.store.registry.close();
    });

    it('on iOS, waits for protected data only after a key read fails, then opens again, deleting nothing', async () => {
        await (await openDeviceStore(deps())).opened.store.registry.close();
        const key = device.keychain.get(REGISTRY_KEY);
        const locked = deps({ refusals: 1 });
        const launched = await openDeviceStore(locked);
        expect(locked.log.slice(1)).toEqual(['key read refused', 'waited for protected data']);
        expect(launched.waited).toBe(true);
        expect(launched.opened.launch.cell).toBe('opened');
        expect(device.keychain.get(REGISTRY_KEY)).toBe(key);
        await launched.opened.store.registry.close();
    });

    it('never waits when the keys read', async () => {
        const launch = deps();
        await (await openDeviceStore(launch)).opened.store.registry.close();
        expect(launch.log).not.toContain('waited for protected data');
    });

    it('on Android, where there is nothing to wait for, fails with the read error and deletes nothing', async () => {
        await (await openDeviceStore(deps())).opened.store.registry.close();
        const keychain = new Map(device.keychain);
        const failure = await openDeviceStore(deps({ refusals: 1, ios: false })).catch((error: unknown) => error);
        expect(isKeyStoreReadError(failure)).toBe(true);
        expect(device.keychain).toEqual(keychain);
        expect(existsSync(join(storeDirectory(device.root), 'registry.db'))).toBe(true);
    });

    it('doesn’t wait on any other failure', async () => {
        const launch = deps();
        const fsFailure = new Error('disk I/O error');
        const failing = {
            ...launch,
            fs: createNodeFileSystem({
                before: (call) => {
                    if (call === 'list') {
                        throw fsFailure;
                    }
                },
            }),
        };
        await expect(openDeviceStore(failing)).rejects.toBe(fsFailure);
        expect(launch.log).not.toContain('waited for protected data');
    });

    it('fails if the read still fails after the wait', async () => {
        const locked = deps({ refusals: 2 });
        await expect(openDeviceStore(locked)).rejects.toBeInstanceOf(KeyStoreReadError);
        expect(locked.log.slice(1)).toEqual(['key read refused', 'waited for protected data', 'key read refused']);
    });
});

describe('the secure-store binding', () => {
    it('reads, writes and deletes every item as after-first-unlock, this device only', async () => {
        const secure = { getItemAsync: vi.fn(async () => 'value'), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() };
        const keys = createSecureKeyStore(secure as never);
        expect(await keys.get('socio.registry')).toBe('value');
        await keys.set('socio.registry', 'x');
        await keys.delete('socio.registry');
        const options = { keychainAccessible: 6 };
        expect(secure.getItemAsync).toHaveBeenCalledWith('socio.registry', options);
        expect(secure.setItemAsync).toHaveBeenCalledWith('socio.registry', 'x', options);
        expect(secure.deleteItemAsync).toHaveBeenCalledWith('socio.registry', options);
    });

    it('answers null only for a name with no value, and throws a KeyStoreReadError when the read fails', async () => {
        const refusal = new Error('User interaction is not allowed (errSecInteractionNotAllowed)');
        const getItemAsync = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(refusal);
        const keys = createSecureKeyStore({ getItemAsync, setItemAsync: vi.fn(), deleteItemAsync: vi.fn() } as never);
        expect(await keys.get('socio.index')).toBeNull();
        const failure = await keys.get('socio.index').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(KeyStoreReadError);
        expect((failure as Error).cause).toBe(refusal);
        expect(isKeyStoreReadError(new Error('wrapped', { cause: failure }))).toBe(true);
        expect(isKeyStoreReadError(refusal)).toBe(false);
    });
});
