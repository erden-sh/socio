import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CACHE_DB,
    clearCache,
    INDEX_KEY,
    openEncrypted,
    openUserDb,
    parseRevocation,
    pushRevocationName,
    resumeWipes,
    retryRevocations,
    type StorePush,
    type WipeReason,
    type SqlDriver,
    type Store,
    USER_DB,
    wipe,
    WipeIncompleteError,
    type WipeStep,
    workspaceId,
    workspaceKeyName,
    workspaceKeyNames,
    workspaceLayout,
} from '../../src/data';
import { createRelayFetch } from '../../src/net/relay-fetch';
import { createRelayClient, type RelayWriteOutcome, retryPushRevocations } from '../../src/push';
import { addWorkspace, type AddedWorkspace, kill, launch, phone, type Phone, sha256 } from '../helpers/store';
import { fakeFetch } from '../net/helpers';

// The wipe (src/data/wipe.ts): mark, close, delete the
// directory, delete the keys and jar, delete the row and index entries,
// verify. A kill between any two steps is finished by the next launch. Clear
// cache rebuilds cache.db alone.

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-wipe-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});

const socio = () => join(device.root, 'socio');
const dir = (id: string) => join(socio(), id);
const listing = (path: string) => readdirSync(path, { recursive: true, encoding: 'utf8' }).sort();

/** Nothing of `workspace` is left: no directory, secret, index entry or row. */
async function gone(store: Store, workspace: AddedWorkspace): Promise<void> {
    expect(existsSync(dir(workspace.id))).toBe(false);
    for (const name of workspaceKeyNames(workspace.id)) {
        expect(device.keychain.has(name)).toBe(false);
    }
    expect((await store.keys.indexed()).filter((name) => name.includes(workspace.id))).toEqual([]);
    expect(await store.registry.get(workspace.id)).toBeNull();
}

/** `workspace` is all there: its directory, keys, row, and user.db as it was. */
async function intact(store: Store, workspace: AddedWorkspace, userDb: Buffer): Promise<void> {
    expect(readFileSync(join(dir(workspace.id), USER_DB)).equals(userDb)).toBe(true);
    for (const name of workspaceKeyNames(workspace.id)) {
        expect(device.keychain.has(name)).toBe(true);
    }
    expect(await store.registry.get(workspace.id)).toMatchObject({ state: 'ready' });
}

/** A driver that logs each connection's close and each delete, into `events`. */
const logging =
    (events: string[]) =>
    (driver: SqlDriver): SqlDriver => ({
        open: async (file) => {
            const connection = await driver.open(file);
            return {
                ...connection,
                close: async () => {
                    events.push(`close ${file.name}`);
                    await connection.close();
                },
            };
        },
        delete: async (file) => {
            events.push(`delete ${file.name}`);
            await driver.delete(file);
        },
    });

/**
 * A driver whose delete acts as expo-sqlite's: a missing file throws, after
 * making its directory again (ensureDatabasePathExists).
 */
const expoDelete = (driver: SqlDriver): SqlDriver => ({
    open: (file) => driver.open(file),
    delete: async (file) => {
        if (!existsSync(join(file.directory, file.name))) {
            mkdirSync(file.directory, { recursive: true });
            throw new Error(`Database '${file.name}' not found`);
        }
        await driver.delete(file);
    },
});

describe('wipe', () => {
    it('runs its steps in order: mark, close, delete the files, the keys, then the row and index', async () => {
        const events: string[] = [];
        const { store } = await launch(device, {
            push: {
                deleteKeys: async (id) => {
                    events.push(`push keys ${id}`);
                },
            },
            wrapDriver: logging(events),
            fs: {
                before: (call, path) => {
                    if (call === 'remove') {
                        events.push(`remove ${path.slice(socio().length + 1)}`);
                    }
                },
            },
            keyStore: {
                before: (call, name) => {
                    if (call !== 'get') {
                        events.push(`${call} ${name.replace(/[0-9a-f]{64}/, '<id>')}`);
                    }
                },
            },
            driver: {
                intercept: (sql) => {
                    if (/^\s*(UPDATE|DELETE FROM) workspaces/.test(sql)) {
                        events.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
                    }
                    return undefined;
                },
            },
        });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        events.length = 0;
        const steps: WipeStep[] = [];

        await wipe(store, ada.id, 'sign-out', {
            afterStep: (step) => {
                steps.push(step);
                events.push(`-- ${step}`);
            },
        });

        expect(steps).toEqual([
            'marked',
            'push-revoked',
            'closed',
            'files-deleted',
            'keys-deleted',
            'row-deleted',
            'verified',
        ]);
        expect(events).toEqual([
            'UPDATE workspaces SET',
            '-- marked',
            `set ${INDEX_KEY}`,
            `set ${pushRevocationName(ada.id.slice(0, 22))}`,
            `push keys ${ada.id}`,
            // Again after the push run deleteKeys waited for: the same record.
            `set ${pushRevocationName(ada.id.slice(0, 22))}`,
            '-- push-revoked',
            `close ${CACHE_DB}`,
            `close ${USER_DB}`,
            '-- closed',
            `delete ${CACHE_DB}`,
            `delete ${USER_DB}`,
            `remove ${ada.id}`,
            '-- files-deleted',
            'delete socio.<id>.cache',
            'delete socio.<id>.user',
            'delete socio.<id>.jar',
            'delete socio.<id>.relay',
            'delete socio.<id>.install',
            '-- keys-deleted',
            'DELETE FROM workspaces',
            `set ${INDEX_KEY}`,
            '-- row-deleted',
            '-- verified',
        ]);
        await gone(store, ada);
        await store.registry.close();
    });

    it('tells the platform once the files are gone, so the app-switcher snapshots go too (CB-356), and on a resumed wipe', async () => {
        const events: string[] = [];
        const wiped = () => {
            events.push(`wiped, directory ${existsSync(dir(ada.id)) ? 'left' : 'gone'}`);
        };
        const { store } = await launch(device, { wiped });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        const bo = await addWorkspace(store, 'https://bo.example.test', 'u-bo', { plant: true });

        await wipe(store, ada.id, 'sign-out', { afterStep: (step) => void events.push(step) });
        expect(events).toEqual([
            'marked',
            'push-revoked',
            'closed',
            'wiped, directory gone',
            'files-deleted',
            'keys-deleted',
            'row-deleted',
            'verified',
        ]);

        // Killed after the mark: the next launch finishes the wipe, and tells again.
        events.length = 0;
        await expect(
            wipe(store, bo.id, 'lease', {
                afterStep: (step) => {
                    if (step === 'marked') {
                        throw new Error('killed');
                    }
                },
            }),
        ).rejects.toThrow('killed');
        expect(events).toEqual([]);
        await kill(store);
        await store.registry.close();
        const relaunched = await launch(device, { wiped: () => void events.push('wiped') });
        expect(relaunched.launch.wiped).toEqual([{ id: bo.id, reason: 'lease' }]);
        expect(events).toEqual(['wiped']);
        await relaunched.store.registry.close();
    });

    it('closes every connection before it deletes, which the driver refuses while one is open', async () => {
        const { store, driver } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        const layout = workspaceLayout(device.root, ada.id);
        // The store's connections are open; deleting under them throws, as expo-sqlite's deleteDatabase does.
        await expect(driver.delete(layout.cache)).rejects.toThrow(/currently open/);
        expect(driver.openPaths()).toContain(join(dir(ada.id), CACHE_DB));

        await wipe(store, ada.id, 'sign-out');
        expect(driver.openPaths()).toEqual([join(socio(), 'registry.db')]);
        await gone(store, ada);
        await store.registry.close();
    });

    it('stops at the delete when a connection it can’t close is open, and the next launch finishes', async () => {
        const { store, driver } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const layout = workspaceLayout(device.root, ada.id);
        // Opened on the platform's driver around the store's tracking, so the wipe can't close it.
        const userKey = device.keychain.get(workspaceKeyName(ada.id, 'user'))!;
        const stray = await openEncrypted(driver, layout.user, userKey);

        await expect(wipe(store, ada.id, 'sign-out')).rejects.toThrow(/currently open/);
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'sign-out' });
        expect(existsSync(join(dir(ada.id), USER_DB))).toBe(true);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'user'))).toBe(true);

        await stray.db.close();
        await kill(store);
        await store.registry.close();
        const relaunched = await launch(device);
        expect(relaunched.launch.wiped).toEqual([{ id: ada.id, reason: 'sign-out' }]);
        expect(relaunched.launch.tell).toBe(false);
        await gone(relaunched.store, ada);
        await relaunched.store.registry.close();
    });

    it('leaves a real directory with cache.db, user.db, -wal, -shm, images/ and attachments/ empty', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        expect(listing(dir(ada.id))).toEqual([
            'attachments',
            'attachments/a1.jpg',
            'cache.db',
            'cache.db-shm',
            'cache.db-wal',
            'images',
            'images/logo.png',
            'user.db',
            'user.db-shm',
            'user.db-wal',
        ]);

        await wipe(store, ada.id, 'sign-out');

        expect(existsSync(dir(ada.id))).toBe(false);
        // Only the registry's own files are left in the store's folder.
        expect(listing(socio())).toEqual(['registry.db', 'registry.db-shm', 'registry.db-wal']);
        await gone(store, ada);
        await store.registry.close();
    });

    it('wipes one workspace and leaves the others', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const bob = await addWorkspace(store, 'http://localhost:4352', 'u-bob');
        const bobUser = readFileSync(join(dir(bob.id), USER_DB));
        await store.registry.setActive(ada.id);

        await wipe(store, ada.id, 'sign-out');

        await gone(store, ada);
        await intact(store, bob, bobUser);
        expect(await store.registry.active()).toBeNull();
        await store.registry.close();
    });

    it('can run on a workspace partly built, or already gone, with expo-sqlite’s delete', async () => {
        const { store } = await launch(device, { wrapDriver: expoDelete });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        rmSync(join(dir(ada.id), CACHE_DB));
        await wipe(store, ada.id, 'sign-out');
        await gone(store, ada);
        await wipe(store, ada.id, 'sign-out');
        await gone(store, ada);
        await store.registry.close();
    });

    it('fails its check when something comes back, still marked, and the next launch finishes it untold', async () => {
        let comeBack = true;
        const { store } = await launch(device, {
            keyStore: {
                before: (call, name) => {
                    // A late image download writes into the directory as the keys go.
                    if (call === 'delete' && name.endsWith('.jar') && comeBack) {
                        comeBack = false;
                        mkdirSync(join(socio(), name.split('.')[1]!, 'images'), { recursive: true });
                    }
                },
            },
        });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');

        const error = await wipe(store, ada.id, 'sign-out').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WipeIncompleteError);
        expect((error as WipeIncompleteError).left).toEqual([dir(ada.id)]);
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'sign-out' });

        await store.registry.close();
        const relaunched = await launch(device);
        // The person chose this wipe: finishing it isn't news to them.
        expect(relaunched.launch).toMatchObject({
            wiped: [{ id: ada.id, reason: 'sign-out' }],
            removedDirectories: 0,
            tell: false,
        });
        await gone(relaunched.store, ada);
        await relaunched.store.registry.close();
    });

    it('a late jar write after the keys go fails the wipe still marked, and the next launch deletes the jar', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const jar = workspaceKeyName(ada.id, 'jar');

        const error = await wipe(store, ada.id, 'sign-out', {
            afterStep: async (step) => {
                if (step === 'keys-deleted') {
                    // A response that was in flight applies its Set-Cookie through the jar's slot.
                    await store.keys.slot(jar).write('{"v":1,"session":"late"}');
                }
            },
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WipeIncompleteError);
        expect((error as WipeIncompleteError).left).toEqual([jar]);
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'sign-out' });
        expect(await store.keys.indexed()).toContain(jar);
        await store.registry.close();

        const relaunched = await launch(device);
        expect(relaunched.launch).toMatchObject({ wiped: [{ id: ada.id, reason: 'sign-out' }], tell: false });
        await gone(relaunched.store, ada);
        await relaunched.store.registry.close();
        // And it stays gone.
        const third = await launch(device);
        expect(third.launch).toMatchObject({ wiped: [], removedDirectories: 0, tell: false });
        expect(device.keychain.has(jar)).toBe(false);
        await third.store.registry.close();
    });

    it('a jar write after the row goes stays indexed, and the next launch deletes it silently', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const jar = workspaceKeyName(ada.id, 'jar');

        const error = await wipe(store, ada.id, 'sign-out', {
            afterStep: async (step) => {
                if (step === 'row-deleted') {
                    await store.keys.slot(jar).write('{"v":1,"session":"late"}');
                }
            },
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WipeIncompleteError);
        expect((error as WipeIncompleteError).left).toEqual([jar, `index: ${jar}`]);
        await store.registry.close();

        const relaunched = await launch(device);
        expect(relaunched.launch).toMatchObject({ wiped: [], removedDirectories: 0, tell: false });
        await gone(relaunched.store, ada);
        await relaunched.store.registry.close();
    });
});

describe('a kill between any two steps', () => {
    const KILL_AFTER: readonly WipeStep[] = [
        'marked',
        'push-revoked',
        'closed',
        'files-deleted',
        'keys-deleted',
        'row-deleted',
    ];

    it.each(KILL_AFTER)('after %s, the next launch finishes the wipe before anything else', async (killAfter) => {
        const { store } = await launch(device, { wrapDriver: expoDelete });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        const bob = await addWorkspace(store, 'http://localhost:4352', 'u-bob');
        const bobUser = readFileSync(join(dir(bob.id), USER_DB));

        await expect(
            wipe(store, ada.id, 'sign-out', {
                afterStep: (step) => {
                    if (step === killAfter) {
                        throw new Error('killed');
                    }
                },
            }),
        ).rejects.toThrow('killed');
        await kill(store);
        await store.registry.close();

        // expo-sqlite's delete, which throws for a missing file and makes its directory again.
        const relaunched = await launch(device, { wrapDriver: expoDelete });
        expect(relaunched.launch).toMatchObject({
            cell: 'opened',
            wiped: killAfter === 'row-deleted' ? [] : [{ id: ada.id, reason: 'sign-out' }],
            removedDirectories: 0,
            tell: false,
        });
        await gone(relaunched.store, ada);
        await intact(relaunched.store, bob, bobUser);
        await relaunched.store.registry.close();
    });

    it('in the middle of deleting the keys, the next launch finishes', async () => {
        let deletes = 0;
        const { store } = await launch(device, {
            keyStore: {
                before: (call, name) => {
                    if (call === 'delete' && name.endsWith('.user') && deletes++ === 0) {
                        throw new Error('killed');
                    }
                },
            },
        });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await expect(wipe(store, ada.id, 'lease')).rejects.toThrow('killed');
        expect(device.keychain.has(workspaceKeyName(ada.id, 'cache'))).toBe(false);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'user'))).toBe(true);
        await kill(store);
        await store.registry.close();

        const relaunched = await launch(device);
        expect(relaunched.launch.wiped).toEqual([{ id: ada.id, reason: 'lease' }]);
        await gone(relaunched.store, ada);
        await relaunched.store.registry.close();
    });
});

describe('revoking push', () => {
    const REASONS: readonly WipeReason[] = [
        'sign-out',
        'other-person',
        'deactivated',
        'lease',
        'files-missing',
        'keys-missing',
        'unfinished',
    ];
    // The reason takes no part in the push step, so each reason is killed around it, and one reason after every later step.
    const AROUND: readonly (WipeStep | 'none')[] = ['none', 'marked', 'push-revoked'];
    const LATER: readonly WipeStep[] = ['closed', 'files-deleted', 'keys-deleted', 'row-deleted'];
    const pushRecords = () => [...device.keychain.keys()].filter((name) => name.startsWith('socio.revoke-push.'));

    /** The native side as a fake: the workspaces whose keys it holds, and the deletes. */
    function nativePush(held: Set<string>): StorePush & { deleted: string[]; recordedCalls: number } {
        const fake = {
            deleted: [] as string[],
            recordedCalls: 0,
            deleteKeys: async (id: string) => {
                fake.deleted.push(id);
                held.delete(id);
            },
            recorded: () => {
                fake.recordedCalls += 1;
            },
        };
        return fake;
    }

    const cases = [
        ...REASONS.flatMap((reason) => AROUND.map((step) => [reason, step] as const)),
        ...LATER.map((step) => ['lease', step] as const),
    ];
    it.each(cases)('for %s, killed after %s, keeps one record and deletes the push keys', async (reason, killAfter) => {
        const held = new Set<string>();
        const first = nativePush(held);
        const { store } = await launch(device, { push: first });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const bob = await addWorkspace(store, 'http://localhost:4352', 'u-bob');
        held.add(ada.id).add(bob.id);
        const relay = JSON.parse(device.keychain.get(workspaceKeyName(ada.id, 'relay'))!) as Record<string, string>;

        const run = wipe(store, ada.id, reason, {
            afterStep: (step) => {
                if (step === killAfter) {
                    throw new Error('killed');
                }
            },
        });
        if (killAfter === 'none') {
            await run;
        } else {
            await expect(run).rejects.toThrow('killed');
            await kill(store);
        }
        await store.registry.close();

        const second = nativePush(held);
        const relaunched = await launch(device, { push: second });
        await gone(relaunched.store, ada);
        // Exactly one record, its id and secret alone, named by neither the workspace nor the person.
        const names = pushRecords();
        expect(names).toEqual([pushRevocationName(relay.id!)]);
        expect(names[0]).not.toContain(ada.id);
        expect(JSON.parse(device.keychain.get(names[0]!)!)).toEqual({ v: 1, id: relay.id, secret: relay.secret });
        expect(await relaunched.store.keys.indexed()).toContain(names[0]);
        // The push keys went, the other workspace's stayed; a resumed wipe deletes them again.
        expect([...held]).toEqual([bob.id]);
        expect([...first.deleted, ...second.deleted].every((id) => id === ada.id)).toBe(true);
        expect(first.recordedCalls + second.recordedCalls).toBeGreaterThan(0);
        expect(device.keychain.has(workspaceKeyName(bob.id, 'relay'))).toBe(true);
        await relaunched.store.registry.close();
    });

    it('keeps no record for a workspace with no registration, and still deletes its push keys', async () => {
        const push = nativePush(new Set());
        const { store } = await launch(device, { push });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await store.keys.delete([workspaceKeyName(ada.id, 'relay')]);
        await wipe(store, ada.id, 'lease');
        expect(pushRecords()).toEqual([]);
        expect(push.deleted).toEqual([ada.id]);
        expect(push.recordedCalls).toBe(0);
        await store.registry.close();
    });

    it('fails the wipe, still marked, when the push keys can’t be deleted, and the next launch finishes it', async () => {
        const { store } = await launch(device, {
            push: {
                deleteKeys: async () => {
                    throw new Error('keychain');
                },
            },
        });
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await expect(wipe(store, ada.id, 'other-person')).rejects.toThrow('keychain');
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'other-person' });
        expect(pushRecords()).toHaveLength(1);
        await store.registry.close();

        const push = nativePush(new Set([ada.id]));
        const relaunched = await launch(device, { push });
        expect(relaunched.launch.wiped).toEqual([{ id: ada.id, reason: 'other-person' }]);
        expect(push.deleted).toEqual([ada.id]);
        await gone(relaunched.store, ada);
        expect(pushRecords()).toHaveLength(1);
        await relaunched.store.registry.close();
    });

    it('an older build’s sign-out retry neither reads nor drops the push record', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await wipe(store, ada.id, 'sign-out');
        const names = pushRecords();
        expect(names).toHaveLength(1);
        // The logout record's reader on the push record's text: not one of its records.
        expect(parseRevocation(device.keychain.get(names[0]!)!)).toBeNull();
        const fetch = fakeFetch(() => Promise.reject(new Error('never sent')));
        await expect(retryRevocations(store.keys, { fetch, userAgent: 'Socio/0.1 (test)' })).resolves.toBe(0);
        expect(fetch.calls).toEqual([]);
        expect(pushRecords()).toEqual(names);
        await store.registry.close();
    });

    it('is dropped when the relay answers, kept while it doesn’t', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await wipe(store, ada.id, 'lease');
        const relay = JSON.parse(device.keychain.get(pushRecords()[0]!)!) as { id: string; secret: string };
        const calls: string[] = [];
        const answering = (...outcomes: RelayWriteOutcome[]) => {
            let index = 0;
            return {
                remove: async (id: string, secret: string) => {
                    calls.push(`${id} ${secret}`);
                    return outcomes[index++]!;
                },
            };
        };

        for (const kept of [
            { kind: 'offline' },
            { kind: 'refused', status: 503 },
            { kind: 'refused', status: 429 },
        ] as const) {
            await expect(retryPushRevocations(store.keys, answering(kept))).resolves.toBe(1);
            expect(pushRecords()).toHaveLength(1);
        }
        await expect(retryPushRevocations(store.keys, answering({ kind: 'gone' }))).resolves.toBe(0);
        expect(pushRecords()).toEqual([]);
        expect((await store.keys.indexed()).filter((name) => name.startsWith('socio.revoke-push.'))).toEqual([]);
        expect(calls).toEqual(Array.from({ length: 4 }, () => `${relay.id} ${relay.secret}`));
        await store.registry.close();
    });

    it.each([{ kind: 'done' }, { kind: 'gone' }, { kind: 'forbidden' }] as const)(
        'is dropped on %o',
        async (outcome) => {
            const { store } = await launch(device);
            const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
            await wipe(store, ada.id, 'sign-out');
            await expect(retryPushRevocations(store.keys, { remove: async () => outcome })).resolves.toBe(0);
            expect(pushRecords()).toEqual([]);
            await store.registry.close();
        },
    );
});

describe('the push revocation record against the relay’s answers', () => {
    const pushRecords = () => [...device.keychain.keys()].filter((name) => name.startsWith('socio.revoke-push.'));
    const RELAY = 'https://relay.example.test';
    /** The relay client over a fetch that answers `status` with `body`. */
    const relayAnswering = (status: number, body: unknown) =>
        createRelayClient(
            createRelayFetch({
                fetch: (async () => new Response(body === null ? null : JSON.stringify(body), { status })) as never,
                userAgent: 'Socio/0.1 (test)',
                origin: RELAY,
            }),
            RELAY,
        );

    it.each<[number, unknown]>([
        [400, { error: 'secret' }],
        [403, null],
        [403, { error: 'Forbidden by policy' }],
        [404, null],
        [408, null],
        [429, null],
        [500, null],
    ])('is kept on a %i that isn’t the relay’s own settling answer (%j)', async (status, body) => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await wipe(store, ada.id, 'sign-out');
        await expect(retryPushRevocations(store.keys, relayAnswering(status, body))).resolves.toBe(1);
        expect(pushRecords()).toHaveLength(1);
        await store.registry.close();
    });

    it.each<[number, unknown]>([
        [204, null],
        [410, null],
        [403, { error: 'secret' }],
    ])('is dropped on the relay’s %i (%j)', async (status, body) => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await wipe(store, ada.id, 'sign-out');
        await expect(retryPushRevocations(store.keys, relayAnswering(status, body))).resolves.toBe(0);
        expect(pushRecords()).toEqual([]);
        await store.registry.close();
    });
});

describe('resumeWipes', () => {
    it('finishes every marked wipe it can, then throws the first failure', async () => {
        const { store, driver } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const bob = await addWorkspace(store, 'http://localhost:4352', 'u-bob');
        await store.registry.markWiping(ada.id, 'sign-out');
        await store.registry.markWiping(bob.id, 'other-person');
        const stray = await openUserDb(driver, dir(ada.id), device.keychain.get(workspaceKeyName(ada.id, 'user'))!);

        await expect(resumeWipes(store)).rejects.toThrow(/currently open/);
        await gone(store, bob);
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping' });

        await stray.db.close();
        expect(await resumeWipes(store)).toEqual([{ id: ada.id, reason: 'sign-out' }]);
        await gone(store, ada);
        await store.registry.close();
    });

    it('leaves a sign-in being committed alone: only launch wipes a pending row', async () => {
        const { store } = await launch(device);
        const id = await workspaceId(sha256, 'https://new.example.test', 'u-new');
        // A sign-in's commit, partway: the pending row, the directory and a key.
        await store.registry.add({ id, origin: 'https://new.example.test', appUserId: 'u-new', name: 'New' });
        await store.fs.mkdir(dir(id));
        await store.keys.create(workspaceKeyName(id, 'cache'));

        expect(await resumeWipes(store)).toEqual([]);
        expect(await store.registry.get(id)).toMatchObject({ state: 'pending' });
        expect(existsSync(dir(id))).toBe(true);
        expect(device.keychain.has(workspaceKeyName(id, 'cache'))).toBe(true);
        await store.registry.close();
    });
});

describe('clearCache', () => {
    it('rebuilds cache.db and drops the images, keeping user.db byte-identical, attachments, keys and registry', async () => {
        const { store, driver } = await launch(device);
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada', { plant: true });
        await store.registry.setActive(ada.id);
        // Close the workspace's files, which checkpoints user.db's write-ahead log into the main file.
        await store.driver.closeAll(dir(ada.id));
        const layout = workspaceLayout(device.root, ada.id);
        const userBefore = readFileSync(join(dir(ada.id), USER_DB));
        const rowBefore = await store.registry.get(ada.id);
        const keychainBefore = new Map(device.keychain);
        const cacheKey = device.keychain.get(workspaceKeyName(ada.id, 'cache'))!;
        // The scope's connections, open as Clear cache runs: cache.db, and user.db (the outbox and drafts).
        const open = await openEncrypted(store.driver, layout.cache, cacheKey);
        expect(await open.db.get('SELECT count(*) AS n FROM rows')).toEqual({ n: 1 });
        const user = await openUserDb(
            store.driver,
            layout.directory,
            device.keychain.get(workspaceKeyName(ada.id, 'user'))!,
        );

        const cache = await clearCache(store, ada.id);

        expect(cache).toMatchObject({ created: true });
        expect(await cache.db.get('SELECT count(*) AS n FROM rows')).toEqual({ n: 0 });
        await cache.db.close();
        expect(driver.log).toContain('cache.db: (deleted)');
        expect(driver.log).not.toContain('user.db: (deleted)');
        expect(readFileSync(join(dir(ada.id), USER_DB)).equals(userBefore)).toBe(true);
        expect(listing(dir(ada.id)).filter((name) => !name.startsWith('cache.db'))).toEqual([
            'attachments',
            'attachments/a1.jpg',
            'user.db',
            'user.db-shm',
            'user.db-wal',
        ]);
        expect(await store.registry.get(ada.id)).toEqual(rowBefore);
        expect(await store.registry.active()).toBe(ada.id);
        expect(device.keychain).toEqual(keychainBefore);

        // user.db's connection is still open, its rows as they were, and it still writes.
        expect(store.driver.openFiles()).toContainEqual(layout.user);
        expect(await user.db.all('SELECT text FROM drafts')).toEqual([{ text: 'half a thought' }]);
        await user.db.run('INSERT INTO drafts VALUES (?, ?, ?, ?, ?)', ['chat:c2', 'a second thought', 2, 2, null]);
        expect(await user.db.all('SELECT text FROM drafts ORDER BY text')).toEqual([
            { text: 'a second thought' },
            { text: 'half a thought' },
        ]);
        await user.db.close();
        await store.registry.close();
    });
});

describe('the store’s files', () => {
    it('keep nothing outside socio/', async () => {
        const { store } = await launch(device);
        await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        await store.registry.close();
        expect(readdirSync(device.root)).toEqual(['socio']);
    });

    it('a planted file in images/ is still found by the listing', () => {
        // The helper's listing goes into folders, so the empty checks above mean empty.
        mkdirSync(join(device.root, 'a', 'b'), { recursive: true });
        writeFileSync(join(device.root, 'a', 'b', 'c'), '');
        expect(listing(join(device.root, 'a'))).toEqual(['b', 'b/c']);
    });
});
