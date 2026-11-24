import { describe, expect, it } from 'vitest';

import {
    createKeys,
    INDEX_KEY,
    newDbKey,
    REGISTRY_KEY,
    workspaceId,
    workspaceKeyName,
    workspaceKeyNames,
    workspaceOfKey,
} from '../../src/data';
import { memoryJarStore, openCookieJar } from '../../src/net';
import { memoryKeyStore, nodeRandomBytes, sha256 } from '../helpers/store';

// The app's secrets: names from hashes,
// and an index of every name written, kept ahead of the values so a reinstall
// finds them all.

const ORIGIN = 'https://acme.example.test';
const index = (values: Map<string, string>) => JSON.parse(values.get(INDEX_KEY) ?? 'null') as unknown;

describe('the names', () => {
    it('are socio.<directory id>.<kind>, with no origin or user id in them', async () => {
        const id = await workspaceId(sha256, ORIGIN, 'ada');
        expect(workspaceKeyNames(id)).toEqual([
            `socio.${id}.cache`,
            `socio.${id}.user`,
            `socio.${id}.jar`,
            `socio.${id}.relay`,
            `socio.${id}.install`,
        ]);
        for (const name of [...workspaceKeyNames(id), REGISTRY_KEY, INDEX_KEY]) {
            // expo-secure-store's alphabet.
            expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
            expect(name).not.toMatch(/acme|example|ada/);
        }
        expect(workspaceOfKey(workspaceKeyName(id, 'jar'))).toBe(id);
        expect(workspaceOfKey(workspaceKeyName(id, 'relay'))).toBe(id);
        expect(workspaceOfKey(REGISTRY_KEY)).toBeNull();
        // A later kind, such as the pending-revocation record, isn't one of the three a wipe deletes.
        expect(workspaceOfKey(`socio.${id}.revoke`)).toBeNull();
    });

    it('refuses an id that isn’t a directory id', () => {
        expect(() => workspaceKeyName('acme.example.test', 'cache')).toThrow(TypeError);
    });
});

describe('newDbKey', () => {
    it('is 32 random bytes as 64 lowercase hex characters', () => {
        expect(newDbKey(() => new Uint8Array(32).fill(0xab))).toBe('ab'.repeat(32));
        expect(newDbKey(nodeRandomBytes)).toMatch(/^[0-9a-f]{64}$/);
        expect(newDbKey(nodeRandomBytes)).not.toBe(newDbKey(nodeRandomBytes));
    });

    it('refuses a random source that gives the wrong length', () => {
        expect(() => newDbKey(() => new Uint8Array(16))).toThrow(/16 bytes/);
    });
});

describe('the index', () => {
    it('names a key before its value is written', async () => {
        const store = memoryKeyStore();
        const keys = createKeys(store, nodeRandomBytes);
        await keys.write('socio.registry', 'x');
        expect(store.log).toEqual([`set ${INDEX_KEY}`, 'set socio.registry']);
        expect(index(store.values)).toEqual({ v: 1, keys: ['socio.registry'] });
    });

    it('keeps the name when the value’s write fails, so a cleanup still finds it', async () => {
        const store = memoryKeyStore(new Map(), {
            before: (call, name) => {
                if (call === 'set' && name === 'socio.registry') {
                    throw new Error('keychain full');
                }
            },
        });
        const keys = createKeys(store, nodeRandomBytes);
        await expect(keys.write('socio.registry', 'x')).rejects.toThrow('keychain full');
        expect(await keys.indexed()).toEqual(['socio.registry']);
    });

    it('drops a name only after its value is deleted, and the index item once it’s empty', async () => {
        const store = memoryKeyStore();
        const keys = createKeys(store, nodeRandomBytes);
        await keys.write('socio.registry', 'x');
        store.log.length = 0;
        await keys.delete(['socio.registry']);
        expect(store.log).toEqual(['delete socio.registry', `delete ${INDEX_KEY}`]);
        expect([...store.values.keys()]).toEqual([]);
    });

    it('erase keeps the names; unindex drops them', async () => {
        const keys = createKeys(memoryKeyStore(), nodeRandomBytes);
        await keys.write('socio.a', '1');
        await keys.write('socio.b', '2');
        await keys.erase(['socio.a']);
        expect(await keys.read('socio.a')).toBeNull();
        expect(await keys.indexed()).toEqual(['socio.a', 'socio.b']);
        await keys.unindex(['socio.a']);
        expect(await keys.indexed()).toEqual(['socio.b']);
    });

    it('loses no name when writes run at once', async () => {
        const store = memoryKeyStore();
        const keys = createKeys(store, nodeRandomBytes);
        const names = Array.from({ length: 20 }, (_, n) => `socio.k${n}`);
        await Promise.all(names.map((name) => keys.write(name, 'v')));
        expect(await keys.indexed()).toEqual([...names].sort());
        // A second instance, as after a relaunch, reads the same index.
        expect(await createKeys(store, nodeRandomBytes).indexed()).toEqual([...names].sort());
    });

    it('writes the index once per new name, not once per write', async () => {
        const store = memoryKeyStore();
        const keys = createKeys(store, nodeRandomBytes);
        await keys.write('socio.jar', 'a');
        await keys.write('socio.jar', 'b');
        await keys.write('socio.jar', 'c');
        expect(store.log.filter((line) => line === `set ${INDEX_KEY}`)).toHaveLength(1);
    });

    it('never reads a damaged index as empty: every name in it is kept and written back', async () => {
        const damaged = '{"v":1,"keys":["socio.a","socio.b","soc';
        const store = memoryKeyStore(new Map([[INDEX_KEY, damaged]]));
        const keys = createKeys(store, nodeRandomBytes);
        expect(await keys.indexed()).toEqual(['socio.a', 'socio.b']);
        await keys.write('socio.registry', 'x');
        expect(index(store.values)).toEqual({ v: 1, keys: ['socio.a', 'socio.b', 'socio.registry'] });
        // Contents with no name in them hold nothing to keep.
        const blank = memoryKeyStore(new Map([[INDEX_KEY, 'not json']]));
        await createKeys(blank, nodeRandomBytes).write('socio.registry', 'x');
        expect(index(blank.values)).toEqual({ v: 1, keys: ['socio.registry'] });
    });

    it('keeps a newer build’s index, its version and fields, changing only its names (an update rolled back)', async () => {
        const newer = { v: 2, keys: ['socio.a', 'socio.b'], kinds: { 'socio.a': 'jar' } };
        const store = memoryKeyStore(new Map([[INDEX_KEY, JSON.stringify(newer)]]));
        const keys = createKeys(store, nodeRandomBytes);
        expect(await keys.indexed()).toEqual(['socio.a', 'socio.b']);
        await keys.write('socio.c', 'x');
        expect(index(store.values)).toEqual({ ...newer, keys: ['socio.a', 'socio.b', 'socio.c'] });
        await keys.unindex(['socio.a']);
        expect(index(store.values)).toEqual({ ...newer, keys: ['socio.b', 'socio.c'] });
        // A second instance, as after a relaunch, reads the same names.
        expect(await createKeys(store, nodeRandomBytes).indexed()).toEqual(['socio.b', 'socio.c']);
    });

    it('a newer index that breaks the rule (no keys list) still gives up every name in it', async () => {
        const store = memoryKeyStore(new Map([[INDEX_KEY, JSON.stringify({ v: 3, entries: [{ name: 'socio.a' }] })]]));
        const keys = createKeys(store, nodeRandomBytes);
        expect(await keys.indexed()).toEqual(['socio.a']);
        await keys.write('socio.b', 'x');
        expect(index(store.values)).toEqual({ v: 1, keys: ['socio.a', 'socio.b'] });
    });

    it('never leaves a value unindexed when a write crosses an unindex (a late Set-Cookie during a wipe)', async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const values = new Map<string, string>();
        const inner = memoryKeyStore(values);
        // The jar's value write waits, as a slow keychain does, while the wipe's unindex comes in.
        const store = {
            ...inner,
            set: async (name: string, value: string) => {
                if (name === 'socio.jar' && value === 'late') {
                    await gate;
                }
                await inner.set(name, value);
            },
        };
        const keys = createKeys(store, nodeRandomBytes);
        await keys.write('socio.jar', 'first');
        await keys.erase(['socio.jar']);

        const write = keys.write('socio.jar', 'late');
        const unindex = keys.unindex(['socio.jar']);
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        await Promise.all([write, unindex]);

        expect(values.get('socio.jar')).toBe('late');
        expect(await keys.indexed()).toEqual(['socio.jar']);
        expect(await createKeys(store, nodeRandomBytes).indexed()).toEqual(['socio.jar']);
    });

    it('unindex keeps a name that has a value again, and drops one that has none', async () => {
        const keys = createKeys(memoryKeyStore(), nodeRandomBytes);
        await keys.write('socio.a', '1');
        await keys.write('socio.b', '2');
        await keys.erase(['socio.a', 'socio.b']);
        await keys.write('socio.b', '3');
        await keys.unindex(['socio.a', 'socio.b']);
        expect(await keys.indexed()).toEqual(['socio.b']);
    });

    it('reads again after a failed index write instead of trusting memory', async () => {
        let fail = true;
        const store = memoryKeyStore(new Map(), {
            before: (call, name) => {
                if (call === 'set' && name === INDEX_KEY && fail) {
                    fail = false;
                    throw new Error('keychain busy');
                }
            },
        });
        const keys = createKeys(store, nodeRandomBytes);
        await expect(keys.write('socio.a', '1')).rejects.toThrow('keychain busy');
        expect(await keys.indexed()).toEqual([]);
        expect(await keys.read('socio.a')).toBeNull();
        await keys.write('socio.a', '1');
        expect(await keys.indexed()).toEqual(['socio.a']);
    });

    it('refuses names outside secure-store’s alphabet, and the index’s own', async () => {
        const keys = createKeys(memoryKeyStore(), nodeRandomBytes);
        await expect(keys.write('socio/registry', 'x')).rejects.toThrow(TypeError);
        await expect(keys.write(INDEX_KEY, 'x')).rejects.toThrow(TypeError);
    });

    it('lets a read error through: it is not a missing key', async () => {
        const store = memoryKeyStore(new Map([['socio.registry', 'x']]), {
            before: (call) => {
                if (call === 'get') {
                    throw new Error('User interaction is not allowed.');
                }
            },
        });
        await expect(createKeys(store, nodeRandomBytes).read('socio.registry')).rejects.toThrow(/interaction/);
    });
});

describe('create', () => {
    it('writes a new 64-hex key under the name, indexed', async () => {
        const store = memoryKeyStore();
        const keys = createKeys(store, () => new Uint8Array(32).fill(7));
        expect(await keys.create('socio.registry')).toBe('07'.repeat(32));
        expect(store.values.get('socio.registry')).toBe('07'.repeat(32));
        expect(await keys.indexed()).toEqual(['socio.registry']);
    });
});

describe('a slot', () => {
    it('is a cookie jar’s store: the jar is written under its name, indexed', async () => {
        const id = await workspaceId(sha256, ORIGIN, 'ada');
        const store = memoryKeyStore();
        const keys = createKeys(store, nodeRandomBytes);
        const name = workspaceKeyName(id, 'jar');
        const jar = await openCookieJar({ origin: ORIGIN, store: keys.slot(name), now: () => 0 });
        await jar.apply(new URL(`${ORIGIN}/api/state`), ['theme=dark; Path=/; Max-Age=60; Secure'], null);
        expect(await keys.indexed()).toEqual([name]);
        const reopened = await openCookieJar({ origin: ORIGIN, store: keys.slot(name), now: () => 0 });
        expect(reopened.cookieHeader(new URL(`${ORIGIN}/`))).toBe('theme=dark');
        // The same contents a memory store would hold.
        const memory = memoryJarStore();
        const copy = await openCookieJar({ origin: ORIGIN, store: memory, now: () => 0 });
        await copy.apply(new URL(`${ORIGIN}/api/state`), ['theme=dark; Path=/; Max-Age=60; Secure'], null);
        expect(store.values.get(name)).toBe(memory.value);
    });
});
