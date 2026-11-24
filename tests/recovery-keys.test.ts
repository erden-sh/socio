import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { dataKeyIds, keyIdFromText } from '@socio/foundation/keys/data-keys';
import { dataKeyId, SecretBox, type DataKeyring, type SealPurpose } from '@socio/foundation/keys/secret-box';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { sampleContinuousCopy } from '../src/server/backup/backup-ltx.js';
import { BackupService, backupFailure } from '../src/server/backup/backup-service.js';
import { checkRecoveryKey, RestoreDrill } from '../src/server/backup/restore-drill.js';
import { backupSealedValues } from '../src/server/composition/backup.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';
import { FEED_TOKEN_SETTING } from '../src/server/updates/contract.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Recovery keys (CB-322): the legacy-sealed count and the admin's re-seal,
// the data keys' ids (in the app and offline), and the restore drill's
// check of a key supplied from escrow. A fake `litestream` "restores" by
// copying a database; the real one never runs here.

const SECRET = 'recovery-key-test-secret-0123456789';
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const alice = { kind: 'user' as const, userId: 'alice' };
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

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

const config = (dir: string, dataKeys?: { current?: Buffer; previous?: Buffer }) => ({
    baseUrl: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: SECRET,
    data: { userDataDir: dir },
    ...(dataKeys ? { dataKeys } : {}),
});

/**
 * One sealed value in each store the app API doesn't make easy to fill:
 * push keys, the GitHub App, both secret settings, an MCP credential and a
 * workspace secret (Socio Secrets), sealed as their stores seal them.
 */
function seedSeals(store: Store, workspace: WorkspaceStore, ring: DataKeyring | string) {
    const box = (purpose: SealPurpose) => new SecretBox(ring, purpose);
    workspace.db
        .prepare("INSERT OR REPLACE INTO notification_settings(key, value) VALUES('vapid', ?)")
        .run(box('push-keys').seal({ publicKey: 'pub', privateKey: 'priv' }));
    workspace.db
        .prepare("INSERT OR REPLACE INTO dispatch_settings(key, value) VALUES('github.app', ?)")
        .run(box('dispatch-credentials').seal({ appId: 1, privateKey: 'pem' }));
    for (const name of [TRANSCRIPTION_KEY_SETTING, FEED_TOKEN_SETTING]) {
        store.connection
            .prepare('INSERT OR REPLACE INTO secret_settings(name, value, url) VALUES (?, ?, ?)')
            .run(name, box('settings-secrets').seal({ key: 'k', url: 'https://t.invalid' }), 'https://t.invalid');
    }
    workspace.db
        .prepare(
            'INSERT INTO mcp_connections(id, userId, name, url, authentication, state, generation, secret, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
            'm1',
            'alice',
            'Tools',
            'https://mcp.invalid',
            'oauth',
            'connected',
            1,
            box('mcp-credentials').seal({ userId: 'alice', connectionId: 'm1', generation: 1 }),
            1,
            1,
        );
    workspace.db
        .prepare(
            "INSERT INTO workspace_secrets(id, name, scope, createdBy, createdAt, updatedAt) VALUES ('s1', 'STRIPE_API_KEY', 'workspace', 'alice', 1, 1)",
        )
        .run();
    workspace.db
        .prepare(
            "INSERT INTO workspace_secret_versions(secretId, version, sealed, state, setBy, setAt) VALUES ('s1', 1, ?, 'current', 'alice', 1)",
        )
        .run(box('workspace-secrets').seal({ secretId: 's1', version: 1, value: 'sk_test_value' }));
}

/** A file and an inference backend (with its env seed), through the app. */
async function seedThroughApp(platform: TestPlatform) {
    await platform.data.putFile(alice, 'a.txt', Buffer.from('a'));
    await platform.inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid:8016/v1',
        model: 'qwen',
        apiKey: 'sk-a',
    });
}

it('counts legacy-sealed values in every purpose, and re-seals them all when an admin asks', async () => {
    const dir = scratch('cb322-count-');
    // The data outlives the first runtime: the second starts over the same connections.
    const database = { store: testDatabase(), workspace: testDatabase() };
    cleanup.push(() => {
        database.store.close();
        database.workspace.close();
    });
    const first = await makeTestRuntime({ database, config: config(dir) });
    cleanup.push(first.dispose);
    const { platform: before, store, workspace } = first;
    await seedThroughApp(before);
    seedSeals(store, workspace, SECRET);
    const legacyByPurpose = {
        'inference-credentials': 2,
        'data-files': 1,
        'push-keys': 1,
        'dispatch-credentials': 1,
        'settings-secrets': 2,
        'mcp-credentials': 1,
        'workspace-secrets': 1,
    };
    // Without a data key everything is legacy-sealed, and the re-seal is refused.
    expect((await before.adminSetup()).dataKey).toEqual({
        configured: false,
        legacy: 9,
        previous: 0,
        unknown: 0,
        legacyByPurpose,
    });
    expect(await before.health()).toMatchObject({ dataKey: 'not_set', legacySealed: 9 });
    expect(await before.health()).not.toHaveProperty('dataKeyId');
    expect(() => before.resealNow('alice')).toThrow(/Set DATA_ENCRYPTION_KEY first/);
    await first.dispose();

    const second = await makeTestRuntime({ database, config: config(dir, { current: KEY_A }) });
    cleanup.push(second.dispose);
    const after = second.platform;
    after.context.log = () => {};
    const kid = dataKeyId(KEY_A);
    expect((await after.adminSetup()).dataKey).toEqual({
        configured: true,
        legacy: 9,
        previous: 0,
        unknown: 0,
        keyId: kid,
        legacyByPurpose,
    });
    expect(await after.health()).toMatchObject({ dataKey: 'resealing', dataKeyId: kid, legacySealed: 9 });

    await after.resealNow('alice');
    const status = (await after.adminSetup()).dataKey!;
    expect(status).toMatchObject({ legacy: 0, previous: 0, unknown: 0, reseal: { running: false } });
    expect(status).not.toHaveProperty('legacyByPurpose');
    expect(status.reseal?.last).toMatchObject({ resealed: 9, unreadable: 0, left: 0 });
    expect(await after.health()).toMatchObject({ dataKey: 'ok', legacySealed: 0 });
    // Audited when asked and when done, by key id and counts only.
    await vi.waitFor(() =>
        expect(workspace.auditOf('data_key', kid).map(({ actor, action, detail }) => [actor, action, detail])).toEqual([
            ['alice', 'reseal', 'started'],
            ['alice', 'reseal', 'done: 9 re-sealed, 0 unreadable, 0 left; 0 legacy-sealed remain'],
        ]),
    );
    // Idempotent: nothing left to move.
    await after.resealNow('alice');
    expect((await after.adminSetup()).dataKey?.reseal?.last).toMatchObject({ resealed: 0 });
    // Everything still opens under the data key.

    expect((await after.data.getFile(alice, 'a.txt')).data.toString()).toBe('a');
});

it('runs one re-seal at a time, yielding to the event loop between stores', async () => {
    const dir = scratch('cb322-yield-');
    const { platform, store, workspace, dispose } = await makeTestRuntime({ config: config(dir, { current: KEY_A }) });
    cleanup.push(dispose);
    platform.context.log = () => {};
    seedSeals(store, workspace, SECRET);
    const first = platform.resealData();
    expect(platform.resealData()).toBe(first);
    // A timer set now fires before the run ends: the run gave the loop a turn.
    let ticked = false;
    setImmediate(() => {
        ticked = true;
    });
    const tickedBeforeDone = await first.then(() => ticked);
    expect(tickedBeforeDone).toBe(true);
    expect((await platform.dataKeyStatus()).legacy).toBe(0);
});

it('shows the current and previous key ids, never the keys', async () => {
    const dir = scratch('cb322-ids-');
    const { platform, dispose } = await makeTestRuntime({ config: config(dir, { current: KEY_B, previous: KEY_A }) });
    cleanup.push(dispose);
    const status = (await platform.adminSetup()).dataKey!;
    expect(status).toMatchObject({ keyId: dataKeyId(KEY_B), previousKeyId: dataKeyId(KEY_A) });
    const health = await platform.health();
    expect(health).toMatchObject({ dataKeyId: dataKeyId(KEY_B), dataKeyPreviousId: dataKeyId(KEY_A) });
    const shown = JSON.stringify([status, health]);
    for (const key of [KEY_A, KEY_B]) {
        expect(shown).not.toContain(key.toString('hex'));
        expect(shown).not.toContain(key.toString('base64url'));
    }
    expect(dataKeyIds({ current: KEY_B })).toEqual({ current: dataKeyId(KEY_B) });
});

// The two command-line tests start Node processes that load the CLI and its
// modules through tsx: seconds of CPU and disk each, and many times that on
// a loaded machine. Nothing in them is timed; the limit only stops a hang.
const CLI_TIMEOUT = { timeout: 120_000 };

it('prints a key’s id offline from stdin, as the app shows it, and never echoes a bad key', CLI_TIMEOUT, () => {
    const run = (input: string) =>
        spawnSync(process.execPath, ['--import', 'tsx', 'src/server/keys/key-id-cli.ts'], {
            input,
            encoding: 'utf8',
            // Nothing of the environment: the id comes from the key alone.
            env: { PATH: process.env.PATH ?? '' },
        });
    const hex = run(`${KEY_A.toString('hex')}\n`);
    expect(hex.status).toBe(0);
    expect(hex.stdout.trim()).toBe(dataKeyId(KEY_A));
    const base64 = run(`\n  ${KEY_A.toString('base64')}  \n`);
    expect(base64.stdout.trim()).toBe(dataKeyId(KEY_A));
    expect(keyIdFromText(KEY_A.toString('base64url'))).toBe(dataKeyId(KEY_A));
    const bad = run('not-a-key-but-a-secret-anyway\n');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('must be 32 random bytes');
    expect(bad.stderr + bad.stdout).not.toContain('not-a-key-but-a-secret-anyway');
    expect(run('').stderr).toContain('No key given');
    // Offline: the CLI imports only these modules (and types), none of which
    // opens a connection; node:crypto is the one built-in.
    const imports = Object.fromEntries(
        [
            'src/server/keys/key-id-cli.ts',
            'packages/foundation/src/keys/key-input.ts',
            'packages/foundation/src/keys/data-keys.ts',
            'packages/foundation/src/keys/secret-box.ts',
        ].map((file) => [file, [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1])]),
    );
    expect(imports).toEqual({
        'src/server/keys/key-id-cli.ts': ['@socio/foundation/keys/data-keys', '@socio/foundation/keys/key-input'],
        'packages/foundation/src/keys/key-input.ts': [],
        'packages/foundation/src/keys/data-keys.ts': ['@socio/shared/operator', './secret-box.js'],
        'packages/foundation/src/keys/secret-box.ts': ['node:crypto', '@socio/shared/types'],
    });
});

it('checks a recovery key from the command line, reading it from stdin', CLI_TIMEOUT, async () => {
    const app = await liveApp();
    const run = (input: string) =>
        spawnSync(process.execPath, ['--import', 'tsx', 'src/server/backup/backup-cli.ts', 'verify-key'], {
            input,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH ?? '',
                DATABASE_PATH: app.databasePath,
                USER_DATA_DIR: join(app.dir, 'userdata'),
                BACKUP_DIR: join(app.dir, 'backups'),
                LITESTREAM_REPLICA_DIR: app.replica,
                LITESTREAM_BIN: fakeLitestream(app.dir, app.restored),
            },
        });
    const passed = run(`${KEY_A.toString('hex')}\n`);
    expect(passed.stderr).toBe('');
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(`Key ${dataKeyId(KEY_A)}: not a key this environment uses.`);
    expect(passed.stdout).toContain('  data-files: 1 of 1 opened');
    expect(passed.stdout).toContain('  settings-secrets: 2 of 2 opened');
    expect(passed.stdout).toContain('  backups: nothing under this key to try');
    expect(passed.stdout.trim().endsWith('Passed.')).toBe(true);
    expect(passed.stdout).not.toContain(KEY_A.toString('hex'));
    const wrong = run(`${KEY_B.toString('hex')}\n`);
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('  settings-secrets: nothing under this key to try (2 under another key)');
    expect(wrong.stdout.trim().endsWith('Failed.')).toBe(true);
    expect(existsSync(join(app.dir, 'backups', '.restore-drill-key-cli'))).toBe(false);
});

/** A stand-in `litestream` that "restores" by copying `source` to `-o`. */
function fakeLitestream(dir: string, source: string) {
    const bin = join(dir, 'litestream');
    writeFileSync(
        bin,
        `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cp '${source}' "$out"
`,
    );
    chmodSync(bin, 0o755);
    return bin;
}

/** A replica directory with one snapshot, enough for the drill to be ready. */
function replicaDir(dir: string) {
    const replica = join(dir, 'backups', 'litestream', 'company-brain');
    const level = join(replica, 'ltx', '9');
    mkdirSync(level, { recursive: true });
    const body = Buffer.alloc(180);
    body.write('LTX1', 0, 'ascii');
    body.writeBigUInt64BE(1n, 16);
    body.writeBigUInt64BE(1n, 24);
    body.writeBigInt64BE(BigInt(NOW - 60_000), 32);
    writeFileSync(join(level, '0000000000000001-0000000000000001.ltx'), body);
    return replica;
}

/**
 * A live app on a database file, with something sealed under KEY_A in
 * every purpose, and a "restored" copy of it for the fake litestream.
 */
async function liveApp() {
    const dir = scratch('cb322-drill-');
    const databasePath = testDatabaseFile(join(dir, 'live.sqlite'));
    const { db, store, workspace, platform, makeApp, dispose } = await makeTestRuntime({
        database: databasePath,
        config: config(join(dir, 'userdata'), { current: KEY_A }),
    });
    platform.context.log = () => {};
    cleanup.push(dispose);
    await seedThroughApp(platform);
    seedSeals(store, workspace, { current: KEY_A, legacy: SECRET });
    const restored = join(dir, 'restored.sqlite');
    db.exec(`VACUUM INTO '${restored}'`);
    return { dir, databasePath, db, store, workspace, platform, makeApp, restored, replica: replicaDir(dir) };
}

it('opens a sample of every purpose from the latest restore with a key from escrow, then wipes it', async () => {
    const app = await liveApp();
    const fake = await startFakeS3();
    cleanup.push(() => fake.close());
    const target = new S3ObjectStore(fake.settings({ bucket: 'offsite' }), { backoffMs: 1, retries: 0 });
    const lines: string[] = [];
    const service = new BackupService({
        databasePath: app.databasePath,
        userDataDir: join(app.dir, 'userdata'),
        settings: {
            directory: join(app.dir, 'backups'),
            keep: 3,
            intervalHours: 24,
            continuous: app.replica,
            litestream: fakeLitestream(app.dir, app.restored),
            offsite: { ...fake.settings({ bucket: 'offsite' }), prefix: 'company-brain/' },
        },
        offsiteStore: target,
        keys: { current: KEY_A, legacy: SECRET },
        sealed: backupSealedValues,
        log: (line) => lines.push(line),
    });
    expect(await service.shipContinuous()).toBe(true);
    expect((await sampleContinuousCopy(target, 'company-brain/', 3)).length).toBe(1);
    app.platform.useBackups(service);
    // The sent file counts under the backups purpose, under the current key.
    expect(service.sealStates()).toEqual({ current: 1, previous: 0, legacy: 0, unknown: 0 });

    const key = Buffer.from(KEY_A);
    const result = await app.platform.verifyRecoveryKey(key, 'alice');
    expect(key.every((byte) => byte === 0)).toBe(true);
    expect(result).toMatchObject({ ok: true, keyId: dataKeyId(KEY_A), matches: 'current' });
    expect(Object.fromEntries(result.purposes.map((p) => [p.purpose, [p.opened, p.sampled, p.ok]]))).toEqual({
        'inference-credentials': [2, 2, true],
        'data-files': [1, 1, true],
        backups: [1, 1, true],
        'push-keys': [1, 1, true],
        'dispatch-credentials': [1, 1, true],
        'settings-secrets': [2, 2, true],
        'mcp-credentials': [1, 1, true],
        'workspace-secrets': [1, 1, true],
        // CB-326 step 6: the gateway-log purpose exists (exchange bodies) but
        // has no seals in this fixture, so it opens none and is `ok: null`.
        'gateway-log': [0, 0, null],
    });
    // Service setup shows it; the scheduled drill's own record is untouched.
    expect(service.drill!.status()).toMatchObject({ running: false, keyCheck: { running: false, last: { ok: true } } });
    expect(service.drill!.last()).toBeUndefined();
    expect(existsSync(join(app.dir, 'backups', '.restore-drill-key'))).toBe(false);
    // Logged and audited by key id; the key itself appears nowhere.
    await vi.waitFor(() => expect(app.workspace.auditOf('data_key', dataKeyId(KEY_A))).toHaveLength(2));
    const audit = app.workspace.auditOf('data_key', dataKeyId(KEY_A));
    expect(audit.map((entry) => entry.action)).toEqual(['verify', 'verify']);
    expect(audit[1]!.detail).toMatch(/^passed \(current\): inference-credentials 2\/2, data-files 1\/1/);
    const everything = JSON.stringify([lines, audit, service.drill!.status()]);
    expect(everything).not.toContain(KEY_A.toString('hex'));
    expect(everything).not.toContain(KEY_A.toString('base64'));
    expect(lines.at(-1)).toBe(
        `Recovery key check: key ${dataKeyId(KEY_A)} (current) passed; opened 10 of 10 sampled seal(s).`,
    );

    // Another key opens nothing it could try: the check fails, saying so.
    const wrong = await app.platform.verifyRecoveryKey(Buffer.from(KEY_B), 'alice');
    expect(wrong).toMatchObject({ ok: false, matches: 'neither' });
    expect(wrong.purposes.every((p) => p.ok === null && p.sampled === 0)).toBe(true);
    expect(wrong.purposes.find((p) => p.purpose === 'settings-secrets')).toMatchObject({ otherKey: 2 });
});

it('fails a purpose whose seal doesn’t open, counts legacy seals apart, and reports a failed restore', async () => {
    const app = await liveApp();
    // The restored copy: one secret setting damaged, one push key still legacy.
    const restored = new DatabaseSync(app.restored);
    const [first] = restored.prepare('SELECT name, value FROM secret_settings ORDER BY name').all() as Array<{
        name: string;
        value: string;
    }>;
    const flipped = first!.value.slice(0, -2) + (first!.value.endsWith('A') ? 'BB' : 'AA');
    restored.prepare('UPDATE secret_settings SET value=? WHERE name=?').run(flipped, first!.name);
    restored
        .prepare("UPDATE notification_settings SET value=? WHERE key='vapid'")
        .run(new SecretBox(SECRET, 'push-keys').seal({ publicKey: 'p' }));
    restored.close();
    const run = {
        replica: app.replica,
        scratch: join(app.dir, 'scratch'),
        litestream: fakeLitestream(app.dir, app.restored),
        reason: backupFailure,
        sealed: backupSealedValues,
        serverKeys: dataKeyIds({ current: KEY_A }),
    };
    const result = await checkRecoveryKey({ ...run, key: KEY_A });
    expect(result.ok).toBe(false);
    expect(result.purposes.find((p) => p.purpose === 'settings-secrets')).toMatchObject({
        sampled: 2,
        opened: 1,
        failed: 1,
        ok: false,
    });
    expect(result.purposes.find((p) => p.purpose === 'push-keys')).toMatchObject({ sampled: 0, legacy: 1, ok: null });
    // Files without a source to read them, backups without an off-site copy: nothing tried.
    expect(result.purposes.find((p) => p.purpose === 'data-files')).toMatchObject({ sampled: 0, ok: null });
    expect(result.purposes.find((p) => p.purpose === 'backups')).toMatchObject({ sampled: 0, ok: null });
    expect(existsSync(run.scratch)).toBe(false);

    const broken = join(app.dir, 'broken');
    writeFileSync(broken, '#!/bin/sh\necho "Error: no snapshots" >&2\nexit 1\n');
    chmodSync(broken, 0o755);
    const failed = await checkRecoveryKey({ ...run, litestream: broken, key: KEY_A });
    expect(failed).toMatchObject({ ok: false, purposes: [] });
    expect(failed.error).toContain('litestream restore failed');
    expect(existsSync(run.scratch)).toBe(false);
});

it('samples every table the stores seal into', async () => {
    const app = await liveApp();
    // Each source names a table the app has, so the check never skips one by mistake.
    for (const [, sql] of backupSealedValues) {
        expect(() => app.db.prepare(sql).all(), sql).not.toThrow();
    }
    // And the restored copy's counts match the live store's, purpose by purpose.
    const live = await app.platform.dataKeyStatus();
    expect(live.legacy).toBe(0);
    const result = await checkRecoveryKey({
        replica: app.replica,
        scratch: join(app.dir, 'scratch'),
        litestream: fakeLitestream(app.dir, app.restored),
        reason: backupFailure,
        sealed: backupSealedValues,
        serverKeys: {},
        key: KEY_B,
    });
    const otherKey = Object.fromEntries(result.purposes.map((p) => [p.purpose, p.otherKey]));
    expect(otherKey).toMatchObject({
        'inference-credentials': 2,
        'data-files': 1,
        'push-keys': 1,
        'dispatch-credentials': 1,
        'settings-secrets': 2,
        'mcp-credentials': 1,
        'workspace-secrets': 1,
    });
});

it('runs one key check at a time, apart from the scheduled drill', async () => {
    const app = await liveApp();
    const drill = new RestoreDrill({
        directory: join(app.dir, 'backups'),
        replica: app.replica,
        databasePath: app.databasePath,
        litestream: fakeLitestream(app.dir, app.restored),
        intervalDays: () => 30,
        ready: () => true,
        reason: backupFailure,
        sealed: backupSealedValues,
        log: () => {},
    });
    const running = drill.verifyKey(Buffer.from(KEY_A), {});
    const second = Buffer.from(KEY_A);
    expect(() => drill.verifyKey(second, {})).toThrow('A recovery key check is already running.');
    expect(second.every((byte) => byte === 0)).toBe(true);
    expect(drill.status().keyCheck).toEqual({ running: true });
    await running;
    expect(drill.status()).toMatchObject({
        running: false,
        keyCheck: { running: false, last: { matches: 'neither' } },
    });
});

it('lets admins re-seal and verify a key over HTTP; members can’t, and the key is never echoed', async () => {
    const app = await liveApp();
    const runnerConfig = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const server = app.makeApp({
        config: runnerConfig,
        auth: {
            provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'recovery-secret-0123456789abcdef0'),
            secureCookies: false,
        },
    });
    const as = async (userId: string) => {
        const login = await server.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string, body?: unknown) =>
            server.request(path, {
                method: 'POST',
                headers: { cookie, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const admin = await as('alice');
    const member = await as('bob');
    expect((await member('/api/data-key/reseal')).status).toBe(403);
    const resealed = await admin('/api/data-key/reseal');
    expect(resealed.status).toBe(202);
    expect(await resealed.json()).toMatchObject({ configured: true, keyId: dataKeyId(KEY_A) });

    // No continuous copy yet.
    expect((await admin('/api/backups/verify-key', { key: KEY_A.toString('hex') })).status).toBe(404);
    const service = new BackupService({
        databasePath: app.databasePath,
        userDataDir: join(app.dir, 'userdata'),
        settings: {
            directory: join(app.dir, 'backups'),
            keep: 3,
            intervalHours: 24,
            continuous: app.replica,
            litestream: fakeLitestream(app.dir, app.restored),
        },
        keys: { current: KEY_A, legacy: SECRET },
        sealed: backupSealedValues,
        log: () => {},
    });
    app.platform.useBackups(service);
    expect((await member('/api/backups/verify-key', { key: KEY_A.toString('hex') })).status).toBe(403);
    const bad = await admin('/api/backups/verify-key', { key: 'secret-but-malformed-key-text' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('secret-but-malformed-key-text');
    expect((await admin('/api/backups/verify-key', {})).status).toBe(400);
    const started = await admin('/api/backups/verify-key', { key: KEY_A.toString('hex') });
    expect(started.status).toBe(202);
    const body = await started.text();
    expect(body).not.toContain(KEY_A.toString('hex'));
    expect(JSON.parse(body)).toMatchObject({ keyCheck: { running: true } });
    await vi.waitFor(() => expect(service.drill!.status().keyCheck?.last?.ok).toBe(true), { timeout: 20_000 });
});

it('refuses the re-seal over HTTP without a data key', async () => {
    const dir = scratch('cb322-http-');
    const { app: server, dispose } = await makeTestRuntime({
        config: config(dir),
        app: {
            config: { mode: 'live', baseUrl: 'https://model.invalid/v1' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'recovery-secret-0123456789abcdef0'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const login = await server.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const response = await server.request('/api/data-key/reseal', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Set DATA_ENCRYPTION_KEY first/);
});
