import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { dataKeysFromEnv, dataKeyWarning, parseDataKey } from '@socio/foundation/keys/data-keys';
import { dataKeyId, SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';
import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { fakeByoKind, FAKE_BYO_KIND } from '../src/server/inference/fake-byo.js';
import { InferenceService } from '../src/server/inference/service.js';
import { LocalObjectStore } from '../src/server/storage/local-store.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'data-key-test-secret-0123456789';
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const alice = { kind: 'user' as const, userId: 'alice' };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

it('seals new values and bytes under the data key, naming it', () => {
    const box = new SecretBox({ current: KEY_A, legacy: SECRET });
    const kid = dataKeyId(KEY_A);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    expect(box.currentKey).toBe(kid);
    const sealed = box.seal({ apiKey: 'sk-plain' });
    expect(sealed.startsWith(`v2.${kid}.`)).toBe(true);
    expect(sealed).not.toContain('sk-plain');
    expect(box.open(sealed)).toEqual({ apiKey: 'sk-plain' });
    expect(box.valueKey(sealed)).toBe(kid);
    // The key id is authenticated: naming another key fails.
    const other = dataKeyId(KEY_B);
    const both = new SecretBox({
        current: KEY_A,
        previous: KEY_B,
        legacy: SECRET,
    });
    expect(() => both.open(sealed.replace(kid, other))).toThrow();

    const bytes = box.sealBytes(Buffer.from('FILE-PLAINTEXT'), 'alice/f1');
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('CBF2');
    expect(bytes.subarray(4, 12).toString('hex')).toBe(kid);
    expect(bytes.toString('latin1')).not.toContain('FILE-PLAINTEXT');
    expect(box.bytesKey(bytes)).toBe(kid);
    expect(box.openBytes(bytes, 'alice/f1').toString()).toBe('FILE-PLAINTEXT');
    // Bound to the file: another context, or another key id, fails.
    expect(() => box.openBytes(bytes, 'alice/f2')).toThrow();
    const swapped = Buffer.from(bytes);
    Buffer.from(other, 'hex').copy(swapped, 4);
    expect(() => both.openBytes(swapped, 'alice/f1')).toThrow();
    // Purposes have keys of their own.
    expect(() => new SecretBox({ current: KEY_A, legacy: SECRET }, 'data-files').open(sealed)).toThrow();
});

it('reads the previous key and the legacy key, and says when a key is missing', () => {
    const legacy = new SecretBox(SECRET, 'data-files');
    const oldValue = legacy.seal({ token: 't' });
    const oldBytes = legacy.sealBytes(Buffer.from('old'), 'ctx');
    expect(oldValue.startsWith('v1.')).toBe(true);
    expect(oldBytes.subarray(0, 4).toString('ascii')).toBe('CBF1');
    const first = new SecretBox({ current: KEY_A, legacy: SECRET }, 'data-files');
    const midValue = first.seal({ token: 'mid' });
    const midBytes = first.sealBytes(Buffer.from('mid'), 'ctx');

    // Rotated: B is current, A previous. All three read.
    const rotated = new SecretBox({ current: KEY_B, previous: KEY_A, legacy: SECRET }, 'data-files');
    expect(rotated.open(oldValue)).toEqual({ token: 't' });
    expect(rotated.openBytes(oldBytes, 'ctx').toString()).toBe('old');
    expect(rotated.open(midValue)).toEqual({ token: 'mid' });
    expect(rotated.openBytes(midBytes, 'ctx').toString()).toBe('mid');
    expect(rotated.state(rotated.valueKey(oldValue))).toBe('legacy');
    expect(rotated.state(rotated.valueKey(midValue))).toBe('previous');
    expect(rotated.reseal(midValue)).toMatch(new RegExp(`^v2\\.${dataKeyId(KEY_B)}\\.`));
    const current = rotated.seal({ token: 'new' });
    expect(rotated.reseal(current)).toBeUndefined();
    expect(rotated.resealBytes(rotated.sealBytes(Buffer.from('x'), 'c'), 'c')).toBeUndefined();

    // The previous key dropped too early: its seals can't be read.
    const dropped = new SecretBox({ current: KEY_B, legacy: SECRET }, 'data-files');
    expect(dropped.state(dropped.valueKey(midValue))).toBe('unknown');
    expect(() => dropped.open(midValue)).toThrow('Sealed under a data key this server doesn’t have.');
    // Without a data key, nothing changes: legacy seals, legacy reads.
    expect(legacy.currentKey).toBe('legacy');
    expect(legacy.reseal(oldValue)).toBeUndefined();
});

it('reads the key from hex or base64 and refuses anything else without echoing it', () => {
    const hex = KEY_A.toString('hex');
    expect(parseDataKey(hex, 'K').equals(KEY_A)).toBe(true);
    expect(parseDataKey(KEY_A.toString('base64'), 'K').equals(KEY_A)).toBe(true);
    expect(parseDataKey(KEY_A.toString('base64url'), 'K').equals(KEY_A)).toBe(true);
    for (const bad of ['short', hex.slice(2), randomBytes(16).toString('hex')]) {
        expect(() => parseDataKey(bad, 'DATA_ENCRYPTION_KEY')).toThrow(/^DATA_ENCRYPTION_KEY must be 32 random bytes/);
    }
    try {
        parseDataKey('not-a-key-but-secret-looking', 'K');
    } catch (error) {
        expect(String(error)).not.toContain('secret-looking');
    }
    expect(dataKeysFromEnv({})).toEqual({});
    // The stack's placeholder secret.
    expect(
        dataKeysFromEnv({
            DATA_ENCRYPTION_KEY: hex,
            DATA_ENCRYPTION_KEY_PREVIOUS: 'none',
        }),
    ).toEqual({ current: KEY_A });
    expect(
        dataKeysFromEnv({
            DATA_ENCRYPTION_KEY: hex,
            DATA_ENCRYPTION_KEY_PREVIOUS: KEY_B.toString('hex'),
        }),
    ).toEqual({ current: KEY_A, previous: KEY_B });
    expect(() => dataKeysFromEnv({ DATA_ENCRYPTION_KEY_PREVIOUS: hex })).toThrow(
        'DATA_ENCRYPTION_KEY_PREVIOUS is set without DATA_ENCRYPTION_KEY.',
    );
    // Swarm secrets as files.
    const env: Record<string, string | undefined> = {
        DATA_ENCRYPTION_KEY_FILE: '/run/secrets/company_brain_data_key',
    };
    loadSecretFiles(env, () => `${hex}\n`);
    expect(env.DATA_ENCRYPTION_KEY).toBe(hex);
    // Production warns without one; development stays quiet.
    expect(dataKeyWarning({}, 'production')).toMatch(/DATA_ENCRYPTION_KEY is not set/);
    expect(dataKeyWarning({}, 'development')).toBeUndefined();
    expect(dataKeyWarning({ current: KEY_A }, 'production')).toBeUndefined();
});

function inferenceOn(db: WorkspaceStore['db'], keys: DataKeyring | string) {
    const inference = new InferenceService(db, { secret: keys, log: () => {} });
    inference.register(fakeByoKind({ baseUrl: 'https://byo.invalid/v1' }));
    return inference;
}

it('re-seals the inference store’s secrets under the data key, then a rotated one', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const before = inferenceOn(workspace.db, SECRET);
    const backend = await before.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid:8016/v1',
        model: 'qwen',
        apiKey: 'sk-backend-plaintext-marker',
    });
    await before.store.setEnvSeed({ apiKey: 'sk-seed' });
    await before.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    await before.connect('bob', FAKE_BYO_KIND, {});
    await before.connect('bob', FAKE_BYO_KIND, {});
    expect(await before.store.sealStates()).toEqual({
        current: 3,
        previous: 0,
        legacy: 0,
        unknown: 0,
    });

    const keyed = inferenceOn(workspace.db, { current: KEY_A, legacy: SECRET });
    expect(await keyed.store.sealStates()).toMatchObject({
        legacy: 3,
        current: 0,
    });
    // Still readable before the re-seal.
    expect((await keyed.store.backend(backend.id))!.apiKey).toBe('sk-backend-plaintext-marker');
    expect(await keyed.store.reseal()).toEqual({ resealed: 3, unreadable: 0 });
    expect(await keyed.store.reseal()).toEqual({ resealed: 0, unreadable: 0 });
    expect(await keyed.store.sealStates()).toMatchObject({
        current: 3,
        legacy: 0,
    });
    // SESSION_SECRET no longer matters for them.
    const otherSecret = inferenceOn(workspace.db, {
        current: KEY_A,
        legacy: 'another-secret-0123456789abcdef',
    });
    expect((await otherSecret.store.backend(backend.id))!.apiKey).toBe('sk-backend-plaintext-marker');
    expect(await otherSecret.store.connection('bob', FAKE_BYO_KIND)).toBeDefined();
    expect(await otherSecret.store.envSeed()).toEqual({ apiKey: 'sk-seed' });

    // Rotation: B current, A previous.
    const rotated = inferenceOn(workspace.db, {
        current: KEY_B,
        previous: KEY_A,
        legacy: SECRET,
    });
    expect(await rotated.store.sealStates()).toMatchObject({ previous: 3 });
    expect(await rotated.store.reseal()).toEqual({ resealed: 3, unreadable: 0 });
    // A dropped: everything still reads under B alone.
    const done = inferenceOn(workspace.db, { current: KEY_B, legacy: SECRET });
    expect(await done.store.sealStates()).toMatchObject({
        current: 3,
        unknown: 0,
    });
    expect((await done.store.backend(backend.id))!.apiKey).toBe('sk-backend-plaintext-marker');
    // A key nobody has any more: counted, left alone, shown as unreadable.
    const lost = inferenceOn(workspace.db, { current: KEY_A, legacy: SECRET });
    expect(await lost.store.sealStates()).toMatchObject({ unknown: 3 });
    expect(await lost.store.reseal()).toEqual({ resealed: 0, unreadable: 3 });
    expect((await lost.operatorState()).backends[0].status).toBe('key_unreadable');
});

function dataSpace(
    workspace: WorkspaceStore,
    dir: string,
    keys: DataKeyring | string,
    objects?: ConstructorParameters<typeof DataSpace>[1]['objects'],
    legacy?: LocalObjectStore,
) {
    const space = new DataSpace(workspace.db, {
        dir,
        secret: keys,
        approvals: sqliteApprovals(workspace.db),
        workspace,
        objects,
        ...dataSpaceStorage(dir, legacy),
        tenantId: 'acme',
    });
    cleanup.push(() => space.close());
    return space;
}

it('re-seals every file in both stores, resuming after a crash midway', async () => {
    const dir = scratch('cb-reseal-');
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    for (const id of ['alice', 'bob']) {
        workspace.recordUser({ id, name: id, role: 'member' });
    }
    // Two files on the local disk, two in S3, all under the legacy key.
    const local = dataSpace(workspace, dir, SECRET);
    await local.putFile(alice, 'one.txt', Buffer.from('ONE-PLAINTEXT'));
    await local.putFile({ kind: 'user', userId: 'bob' }, 'two.txt', Buffer.from('TWO'));
    const s3 = await startFakeS3();
    cleanup.push(() => s3.close());
    const objects = () => new S3ObjectStore(s3.settings(), { backoffMs: 1 });
    const remote = dataSpace(workspace, dir, SECRET, objects());
    await remote.probeStorage();
    await remote.putFile(alice, 'three.txt', Buffer.from('THREE'));
    await remote.putFile(alice, 'four.txt', Buffer.from('FOUR'));
    const keys = { current: KEY_A, legacy: SECRET };
    expect(remote.resealDue()).toBe(false);

    // The second write, in either store, "crashes" after its put: the run
    // stops there.
    let puts = 0;
    const crash = () => {
        if (++puts === 2) {
            throw new Error('crash');
        }
    };
    class CrashingLocal extends LocalObjectStore {
        override async put(key: string, body: Uint8Array) {
            await super.put(key, body);
            crash();
        }
    }
    class CrashingS3 extends S3ObjectStore {
        override async put(key: string, body: Uint8Array) {
            await super.put(key, body);
            crash();
        }
    }
    const crashing = dataSpace(
        workspace,
        dir,
        keys,
        new CrashingS3(s3.settings(), { backoffMs: 1 }),
        new CrashingLocal(dir),
    );
    expect(crashing.sealStates()).toMatchObject({ legacy: 4, current: 0 });
    expect(crashing.resealDue()).toBe(true);
    await expect(crashing.resealFiles()).rejects.toThrow('crash');
    const states = crashing.sealStates();
    expect(states.current).toBe(1);
    expect(states.legacy).toBe(3);

    // The next run picks up where it stopped: the crashed row only needs
    // its record, the rest are re-sealed.
    const next = dataSpace(workspace, dir, keys, objects());
    const result = await next.resealFiles();
    expect(result).toMatchObject({
        resealed: 2,
        fixed: 1,
        missing: 0,
        unreadable: 0,
        unavailable: false,
    });
    expect(next.sealStates()).toEqual({
        current: 4,
        previous: 0,
        legacy: 0,
        unknown: 0,
    });
    expect(next.resealDue()).toBe(false);
    expect(await next.resealFiles()).toMatchObject({ resealed: 0, fixed: 0 });
    // Every object is CBF2 under A, and sizes match the rows.
    const kid = dataKeyId(KEY_A);
    for (const body of s3.objects.values()) {
        expect(body.subarray(0, 12)).toEqual(Buffer.concat([Buffer.from('CBF2'), Buffer.from(kid, 'hex')]));
    }
    for (const user of ['alice', 'bob']) {
        for (const name of readdirSync(join(dir, user, 'files'))) {
            expect(
                readFileSync(join(dir, user, 'files', name))
                    .subarray(0, 4)
                    .toString(),
            ).toBe('CBF2');
        }
    }
    const rows = workspace.db.prepare('SELECT id, ownerUserId, storage, storedSize FROM data_files').all() as Array<{
        id: string;
        ownerUserId: string;
        storage: string;
        storedSize: number;
    }>;
    for (const row of rows) {
        const size =
            row.storage === 's3'
                ? s3.objects.get(`company-brain/tenants/acme/users/${row.ownerUserId}/files/${row.id}`)!.length
                : readFileSync(join(dir, row.ownerUserId, 'files', `${row.id}.bin`)).length;
        expect(row.storedSize).toBe(size);
    }
    // Readable without SESSION_SECRET's key; no plaintext anywhere.
    const fresh = dataSpace(workspace, dir, { current: KEY_A, legacy: 'rotated-secret-0123456789abcdef' }, objects());
    for (const [path, text] of [
        ['one.txt', 'ONE-PLAINTEXT'],
        ['three.txt', 'THREE'],
        ['four.txt', 'FOUR'],
    ]) {
        expect((await fresh.getFile(alice, path)).data.toString()).toBe(text);
    }
    expect(s3.allBytes().toString('latin1')).not.toContain('THREE');

    // Rotation: B current, A previous; then A can go.
    const rotated = dataSpace(workspace, dir, { current: KEY_B, previous: KEY_A, legacy: SECRET }, objects());
    expect(rotated.sealStates()).toMatchObject({ previous: 4 });
    expect(await rotated.resealFiles()).toMatchObject({ resealed: 4 });
    const onlyB = dataSpace(workspace, dir, { current: KEY_B, legacy: SECRET }, objects());
    expect(onlyB.sealStates()).toMatchObject({ current: 4 });
    expect((await onlyB.getFile(alice, 'four.txt')).data.toString()).toBe('FOUR');
    // New writes name B.
    await onlyB.putFile(alice, 'five.txt', Buffer.from('FIVE'));
    expect(onlyB.sealStates()).toMatchObject({ current: 5 });
});

it('re-seals without losing writes, deletes or moves made meanwhile', async () => {
    const dir = scratch('cb-reseal-race-');
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const before = dataSpace(workspace, dir, SECRET);
    for (const name of ['a', 'b', 'c', 'd']) {
        await before.putFile(alice, `${name}.txt`, Buffer.from(`OLD-${name}`));
    }
    // A slow disk: the re-seal's reads leave room for the user's requests.
    class SlowLocal extends LocalObjectStore {
        override async get(key: string) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return super.get(key);
        }
    }
    const slow = new SlowLocal(dir);
    const space = dataSpace(workspace, dir, { current: KEY_A, legacy: SECRET }, slow, slow);
    const reseal = space.resealFiles();
    await Promise.all([
        space.putFile(alice, 'a.txt', Buffer.from('NEW-a')),
        space.deleteFile('alice', 'b.txt'),
        space.moveFile('alice', 'c.txt', 'moved/c.txt'),
        space.getFile(alice, 'd.txt'),
    ]);
    await reseal;
    const read = async (path: string) => (await space.getFile(alice, path)).data.toString();
    expect(await read('a.txt')).toBe('NEW-a');
    await expect(space.getFile(alice, 'b.txt')).rejects.toThrow('No file');
    expect(await read('moved/c.txt')).toBe('OLD-c');
    expect(await read('d.txt')).toBe('OLD-d');
    // Every row under the data key, the deleted one too (CB-64 keeps it and
    // its bytes), and only their objects on disk.
    // The overwrite of a.txt kept its old bytes as a version (17.2), sealed
    // under the data key.
    await space.resealFiles();
    expect(space.sealStates()).toEqual({
        current: 5,
        previous: 0,
        legacy: 0,
        unknown: 0,
    });
    const { id: a } = space.fileAt('alice', 'a.txt')!;
    const [version] = space.withDeletedVersions(a);
    expect((await space.withDeletedContent(version.id)).toString()).toBe('OLD-a');
    expect(readdirSync(join(dir, 'alice', 'files'))).toHaveLength(5);
});

it('leaves files it can’t open or reach, and counts them', async () => {
    const dir = scratch('cb-reseal-left-');
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const before = dataSpace(workspace, dir, 'another-secret-0123456789abcdef');
    await before.putFile(alice, 'lost-secret.txt', Buffer.from('x'));
    await before.putFile(alice, 'gone.txt', Buffer.from('y'));
    const [{ id }] = workspace.db.prepare("SELECT id FROM data_files WHERE path='gone.txt'").all() as Array<{
        id: string;
    }>;
    rmSync(join(dir, 'alice', 'files', `${id}.bin`));
    // An S3 row, with S3 not configured here.
    workspace.db
        .prepare(
            "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdAt, updatedAt, storage) VALUES ('s3-only', 'alice', 'remote.txt', 1, 33, 'text/plain', 0, 0, 's3')",
        )
        .run();
    const space = dataSpace(workspace, dir, { current: KEY_A, legacy: SECRET });
    expect(await space.resealFiles()).toMatchObject({
        resealed: 0,
        unreadable: 1,
        missing: 1,
        skipped: 1,
    });
    expect(space.sealStates()).toMatchObject({ legacy: 3 });
});

it('reports the data key in health and admin setup, and re-seals at start', async () => {
    const dir = scratch('cb-reseal-platform-');
    // The data outlives each runtime: three starts over the same connections.
    const database = { store: testDatabase(), workspace: testDatabase() };
    cleanup.push(() => {
        database.store.close();
        database.workspace.close();
    });
    const config = {
        sessionSecret: SECRET,
        data: { userDataDir: dir },
    };
    const start = async (extra: Partial<PlatformConfig> = {}) => {
        const t = await makeTestRuntime({ database, config: { ...config, ...extra } });
        cleanup.push(t.dispose);
        return t;
    };
    const first = await start();
    const before = first.platform;
    await before.data.putFile(alice, 'a.txt', Buffer.from('a'));
    await before.inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid:8016/v1',
        model: 'qwen',
        apiKey: 'sk-a',
    });
    expect(await before.health()).toMatchObject({ ok: true, dataKey: 'not_set' });
    // Without a data key, everything sealed is legacy-sealed (CB-322).
    expect((await before.adminSetup()).dataKey).toEqual({
        configured: false,
        legacy: 3,
        previous: 0,
        unknown: 0,
        legacyByPurpose: { 'inference-credentials': 2, 'data-files': 1 },
    });
    await first.dispose();

    const lines: string[] = [];
    const second = await start({ dataKeys: { current: KEY_A } });
    const after = second.platform;
    after.context.log = (line) => lines.push(line);
    expect((await after.health()).dataKey).toBe('resealing');
    // The file, the backend's key and the sealed env seed.
    expect((await after.adminSetup()).dataKey).toMatchObject({
        configured: true,
        legacy: 3,
    });
    await after.resealData();
    expect((await after.health()).dataKey).toBe('ok');
    expect((await after.adminSetup()).dataKey).toMatchObject({ legacy: 0 });
    expect(lines).toEqual(['Data key: re-sealed 2 stored credential(s); re-sealed 1 file(s).']);
    expect(lines.join()).not.toContain('a.txt');
    await second.dispose();

    // The key removed again: health says a key is missing, not just unset.
    const dropped = (await start()).platform;
    const droppedLines: string[] = [];
    dropped.context.log = (line) => droppedLines.push(line);
    expect((await dropped.health()).dataKey).toBe('key_missing');
    expect((await dropped.adminSetup()).dataKey).toEqual({
        configured: false,
        legacy: 0,
        previous: 0,
        unknown: 3,
    });
    await dropped.resealData();
    expect(droppedLines).toEqual([
        "Data key: 3 item(s) are sealed under a data key, but DATA_ENCRYPTION_KEY is not set; they can't be read until it is set again.",
    ]);
});
