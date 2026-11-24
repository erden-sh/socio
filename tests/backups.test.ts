import { randomBytes } from 'node:crypto';
import {
    closeSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { backupDatabaseOnline } from '@socio/data/backup';
import { objectKey } from '@socio/data/storage/keys';
import { SecretBox } from '@socio/foundation/keys/secret-box';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { BACKUP_CONTEXT } from '../src/server/backup/backup-offsite.js';
import {
    BackupService,
    backupFailure,
    backupSettingsFromEnv,
    readBackupStatus,
    runBackup,
    STALE_LOCK_MS,
} from '../src/server/backup/backup-service.js';
import type { BackupSettings } from '../src/server/backup/contract.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { memoryTmpdir } from './helpers/memory-tmpdir.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const SECRET = 'backup-test-secret-0123456789abc';
const KEY = randomBytes(32);
const alice = { kind: 'user' as const, userId: 'alice' };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = (name: string) => {
    const dir = mkdtempSync(join(memoryTmpdir(), name));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

it('reads the backup settings, the off-site copy only with a data key', () => {
    expect(backupSettingsFromEnv({}, { dataKey: false })).toEqual({
        directory: 'data/backups',
        keep: 14,
        intervalHours: 24,
        ltxIntervalSeconds: 60,
        drillIntervalDays: 30,
        purgeBackupDays: 30,
    });
    expect(
        backupSettingsFromEnv(
            { BACKUP_DIR: '/backups', BACKUP_KEEP: '7', BACKUP_INTERVAL_HOURS: '0' },
            { dataKey: false },
        ),
    ).toEqual({
        directory: '/backups',
        keep: 7,
        intervalHours: 0,
        ltxIntervalSeconds: 60,
        drillIntervalDays: 30,
        purgeBackupDays: 30,
    });
    for (const [env, message] of [
        [{ BACKUP_KEEP: '0' }, /^BACKUP_KEEP must/],
        [{ BACKUP_INTERVAL_HOURS: '-1' }, /^BACKUP_INTERVAL_HOURS must/],
        [{ BACKUP_INTERVAL_HOURS: 'daily' }, /^BACKUP_INTERVAL_HOURS must/],
        [{ PURGE_BACKUP_DAYS: '0' }, /^PURGE_BACKUP_DAYS must/],
        [{ PURGE_BACKUP_DAYS: '1.5' }, /^PURGE_BACKUP_DAYS must/],
        [{ PURGE_BACKUP_DAYS: '366' }, /^PURGE_BACKUP_DAYS must/],
    ] as const) {
        expect(() => backupSettingsFromEnv(env, { dataKey: false })).toThrow(message);
    }
    const offsite = {
        BACKUP_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
        BACKUP_S3_BUCKET: 'acme-brain-backups',
        BACKUP_S3_REGION: 'eu-west-1',
        BACKUP_S3_FORCE_PATH_STYLE: 'false',
        BACKUP_S3_PREFIX: 'company-brain',
        BACKUP_S3_CREDENTIALS: '{"accessKeyId":"AK","secretAccessKey":"SK"}',
    };
    expect(() => backupSettingsFromEnv(offsite, { dataKey: false })).toThrow(
        'BACKUP_S3_ENDPOINT needs DATA_ENCRYPTION_KEY: the off-site copy is sealed with it.',
    );
    expect(backupSettingsFromEnv(offsite, { dataKey: true }).offsite).toMatchObject({
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        bucket: 'acme-brain-backups',
        region: 'eu-west-1',
        forcePathStyle: false,
        prefix: 'company-brain/',
        accessKeyId: 'AK',
    });
    expect(() => backupSettingsFromEnv({ ...offsite, BACKUP_S3_PREFIX: '../up' }, { dataKey: true })).toThrow(
        /^BACKUP_S3_PREFIX must/,
    );
    // Failures name no paths.
    expect(
        backupFailure(
            Object.assign(new Error("ENOSPC: no space, write '/backups/x'"), {
                code: 'ENOSPC',
            }),
        ),
    ).toBe('File system error (ENOSPC).');
    expect(backupFailure(new Error('open /data/secret/thing failed'))).toBe('open … failed');
});

/** A file database and a data space over a fake S3, with files in it. */
async function workspaceOverS3() {
    const dir = scratch('cb-backups-');
    const database = testDatabaseFile(join(dir, 'brain.sqlite'));
    const userData = join(dir, 'userdata');
    const workspace = new WorkspaceStore(database);
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const s3 = await startFakeS3();
    cleanup.push(() => s3.close());
    const store = new S3ObjectStore(s3.settings(), { backoffMs: 1 });
    const space = new DataSpace(workspace.db, {
        dir: userData,
        ...dataSpaceStorage(userData),
        secret: { current: KEY, legacy: SECRET },
        approvals: sqliteApprovals(workspace.db),
        workspace,
        objects: store,
        tenantId: 'acme',
    });
    cleanup.push(() => space.close());
    await space.probeStorage();
    return { dir, database, userData, workspace, s3, store, space };
}
const objectFiles = (root: string) =>
    existsSync(root)
        ? readdirSync(root, { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => join(entry.parentPath, entry.name))
        : [];

it('mirrors objects incrementally, keeps each backup’s own view, and copies off-site sealed', async () => {
    const w = await workspaceOverS3();
    for (const name of ['a', 'b', 'c']) {
        await w.space.putFile(alice, `${name}.txt`, Buffer.from(`FILE-${name}`));
    }
    const backups = join(w.dir, 'backups');
    const offsiteFake = await startFakeS3({ region: 'eu-west-1' });
    cleanup.push(() => offsiteFake.close());
    const settings: BackupSettings = {
        directory: backups,
        keep: 2,
        intervalHours: 24,
        offsite: {
            ...offsiteFake.settings({ bucket: 'brain-offsite' }),
            prefix: 'cb/',
        },
    };
    const offsiteStore = new S3ObjectStore(settings.offsite!, { backoffMs: 1 });
    const run = (at: number) =>
        runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings,
            objects: { store: w.store, tenantId: 'acme' },
            offsiteStore,
            keys: { current: KEY, legacy: SECRET },
            now: new Date(Date.UTC(2026, 9, 9, 12, 0, at)),
        });

    const first = await run(0);
    expect(first.objects).toMatchObject({ objects: 3, fetched: 3, removed: 0 });
    expect(first.offsiteError).toBeUndefined();
    expect(first.offsite).toMatchObject({ objects: 3, objectsSent: 3 });
    expect(first.sizeBytes).toBeGreaterThan(0);
    // The bucket was created in its region.
    expect(offsiteFake.buckets.has('brain-offsite')).toBe(true);

    // Nothing changed: nothing fetched, nothing sent but the snapshot.
    w.s3.requests.length = 0;
    const second = await run(1);
    expect(second.objects).toMatchObject({ objects: 3, fetched: 0 });
    expect(second.offsite).toMatchObject({ objectsSent: 0, objectsRemoved: 0 });
    expect(w.s3.requests.filter((request) => request.method === 'GET' && !request.query['list-type'])).toEqual([]);
    // Unchanged objects are links to the mirror: no extra space.
    const [firstFile] = objectFiles(join(first.userdata, 'objects'));
    const sameInSecond = firstFile.replace(first.userdata, second.userdata);
    expect(statSync(firstFile).ino).toBe(statSync(sameInSecond).ino);

    // One replaced, one gone from the bucket. A deleted file keeps its
    // object (CB-64), so the object is removed under it, as only a purge
    // from the future admin view would.
    await w.space.putFile(alice, 'a.txt', Buffer.from('FILE-a, changed'));
    const { id: gone } = w.workspace.db.prepare("SELECT id FROM data_files WHERE path='b.txt'").get() as { id: string };
    await w.store.delete(objectKey('s3', 'acme', 'alice', gone));
    const third = await run(2);
    // The replaced file's old bytes are a version now (17.2): a new object.
    expect(third.objects).toMatchObject({ objects: 3, fetched: 2, removed: 1 });
    // Off-site, the deleted object stays while a kept snapshot can name it.
    expect(third.offsite).toMatchObject({
        objectsSent: 2,
        objectsRemoved: 0,
        objectsKept: 1,
        prunedSnapshots: 1,
    });
    // The second backup still has the deleted object and the old version.
    expect(objectFiles(join(second.userdata, 'objects'))).toHaveLength(3);
    expect(objectFiles(join(third.userdata, 'objects'))).toHaveLength(3);
    expect(objectFiles(join(backups, 'objects'))).toHaveLength(3);
    // BACKUP_KEEP=2 here and off-site.
    expect(existsSync(first.userdata)).toBe(false);
    expect(readdirSync(backups).filter((name) => /^company-brain-.*\.sqlite$/.test(name))).toHaveLength(2);
    // Single private files: no -wal or -shm beside them.
    expect(readdirSync(backups).filter((name) => /-(wal|shm)$/.test(name))).toEqual([]);
    expect(statSync(third.database).mode & 0o777).toBe(0o600);
    const remote = [...offsiteFake.objects.keys()];
    const stamps = new Set(
        remote.filter((key) => key.startsWith('brain-offsite/cb/snapshots/')).map((key) => key.split('/')[3]),
    );
    expect([...stamps].sort()).toEqual(['20261009-120001', '20261009-120002']);
    const offsiteObjects = () =>
        [...offsiteFake.objects.keys()].filter((key) => key.startsWith('brain-offsite/cb/objects/'));
    // a.txt, its version, b.txt's (still named by a snapshot) and c.txt.
    expect(offsiteObjects()).toHaveLength(4);

    // Off-site, nothing is plaintext: the database is sealed under the data
    // key and opens with it; files are as stored (sealed).
    const all = offsiteFake.allBytes().toString('latin1');
    for (const plain of ['SQLite format 3', 'FILE-a', 'FILE-c', 'Alice']) {
        expect(all).not.toContain(plain);
    }
    const sealedDb = offsiteFake.objects.get('brain-offsite/cb/snapshots/20261009-120002/company-brain.sqlite.sealed')!;
    const box = new SecretBox({ current: KEY, legacy: 'x' }, 'backups');
    expect(box.openBytes(sealedDb, BACKUP_CONTEXT).subarray(0, 15).toString()).toBe('SQLite format 3');
    // The requests carried only opaque keys.
    for (const request of offsiteFake.requests) {
        expect(request.path).not.toMatch(/a\.txt|alice\/a/);
    }

    const status = readBackupStatus(backups);
    expect(status).toMatchObject({
        lastSuccessAt: Date.UTC(2026, 9, 9, 12, 0, 2),
        lastSizeBytes: third.sizeBytes,
        offsiteSuccessAt: Date.UTC(2026, 9, 9, 12, 0, 2),
    });
    expect(status.lastError).toBeUndefined();

    // The snapshot that first missed it (it may still name it) is kept…
    const fourth = await run(3);
    expect(fourth.offsite).toMatchObject({ objectsRemoved: 0, objectsKept: 1 });
    expect(offsiteObjects()).toHaveLength(4);
    // …then every kept snapshot is newer: the object goes.
    const fifth = await run(4);
    expect(fifth.offsite).toMatchObject({ objectsRemoved: 1, objectsKept: 0 });
    expect(offsiteObjects()).toHaveLength(3);
});

it('keeps complete off-site snapshots when runs fail, and removes the cut-off ones', async () => {
    const w = await workspaceOverS3();
    await w.space.putFile(alice, 'a.txt', Buffer.from('FILE-a'));
    const backups = join(w.dir, 'backups');
    const offsiteFake = await startFakeS3();
    cleanup.push(() => offsiteFake.close());
    const settings: BackupSettings = {
        directory: backups,
        keep: 2,
        intervalHours: 24,
        offsite: { ...offsiteFake.settings({ bucket: 'offsite' }), prefix: '' },
    };
    const run = (at: number, cutOff = false) => {
        const offsiteStore = new S3ObjectStore(settings.offsite!, {
            backoffMs: 1,
            retries: 0,
        });
        // Cut off after the database went up (files are streamed, CB-378).
        let puts = 0;
        const put = offsiteStore.put.bind(offsiteStore);
        const putFile = offsiteStore.putFile.bind(offsiteStore);
        if (cutOff) {
            const cut = () => {
                if (++puts > 1) {
                    throw new Error('Object storage PUT failed: unreachable.');
                }
            };
            offsiteStore.put = async (key, body) => {
                cut();
                return put(key, body);
            };
            offsiteStore.putFile = async (key, path) => {
                cut();
                return putFile(key, path);
            };
        }
        return runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings,
            objects: { store: w.store, tenantId: 'acme' },
            offsiteStore,
            keys: { current: KEY, legacy: SECRET },
            now: new Date(Date.UTC(2026, 9, 9, 14, 0, at)),
        });
    };
    const snapshots = () =>
        [
            ...new Set(
                [...offsiteFake.objects.keys()]
                    .filter((key) => key.startsWith('offsite/snapshots/'))
                    .map((key) => key.split('/')[2]),
            ),
        ].sort();
    await run(0);
    await run(1);
    // Three runs cut off midway: none counts against BACKUP_KEEP.
    for (const at of [2, 3, 4]) {
        expect((await run(at, true)).offsiteError).toBe('Object storage PUT failed: unreachable.');
    }
    expect(snapshots()).toEqual([
        '20261009-140000',
        '20261009-140001',
        '20261009-140002',
        '20261009-140003',
        '20261009-140004',
    ]);
    // The next good run keeps the two newest complete ones, its own included.
    const good = await run(5);
    expect(good.offsite).toMatchObject({ prunedSnapshots: 4 });
    expect(snapshots()).toEqual(['20261009-140001', '20261009-140005']);
    expect(offsiteFake.objects.has('offsite/snapshots/20261009-140005/complete')).toBe(true);
});

it('refuses to send a file off-site that isn’t sealed', async () => {
    const w = await workspaceOverS3();
    const backups = join(w.dir, 'backups');
    // Something put a plaintext file where only sealed ones belong.
    mkdirSync(join(w.userData, 'alice', 'files'), { recursive: true });
    writeFileSync(join(w.userData, 'alice', 'files', 'stray.bin'), 'PLAINTEXT-SECRET');
    const offsiteFake = await startFakeS3();
    cleanup.push(() => offsiteFake.close());
    const settings: BackupSettings = {
        directory: backups,
        keep: 2,
        intervalHours: 24,
        offsite: { ...offsiteFake.settings({ bucket: 'offsite' }), prefix: '' },
    };
    const result = await runBackup({
        databasePath: w.database,
        userDataDir: w.userData,
        settings,
        offsiteStore: new S3ObjectStore(settings.offsite!, { backoffMs: 1 }),
        keys: { current: KEY, legacy: SECRET },
    });
    expect(result.offsiteError).toBe('A file for the off-site copy isn’t sealed, so the copy stopped.');
    expect(offsiteFake.allBytes().toString('latin1')).not.toContain('PLAINTEXT-SECRET');
});

it('takes over a backup lock left by a run that died, and clears what it left', async () => {
    const w = await workspaceOverS3();
    const directory = join(w.dir, 'backups');
    const base = {
        databasePath: w.database,
        userDataDir: w.userData,
        settings: { directory, keep: 3, intervalHours: 24 },
    };
    const lockDir = join(directory, '.backup-running');
    mkdirSync(lockDir, { recursive: true });
    // Fresh: another run holds it.
    await expect(runBackup(base)).rejects.toThrow('A backup is already running.');
    // Untouched for longer than a run's heartbeat allows: taken over.
    const old = new Date(Date.now() - STALE_LOCK_MS - 1000);
    utimesSync(lockDir, old, old);
    writeFileSync(join(directory, 'company-brain-20261001-000000.sqlite.partial'), 'x');
    mkdirSync(join(directory, 'userdata-20261001-000000.partial', 'alice'), {
        recursive: true,
    });
    writeFileSync(join(directory, 'objects.json.tmp'), '{');
    // The off-site copy's sealed file, from a run cut off while sending it (CB-378).
    writeFileSync(join(directory, 'offsite.sealed.tmp'), 'x');
    await runBackup(base);
    expect(existsSync(lockDir)).toBe(false);
    expect(readdirSync(directory).filter((name) => /\.partial|\.tmp$/.test(name))).toEqual([]);
});

it('keeps the local backup when the off-site copy fails, and resumes a mirror cut off midway', async () => {
    const w = await workspaceOverS3();
    for (const name of ['a', 'b', 'c', 'd']) {
        await w.space.putFile(alice, `${name}.txt`, Buffer.from(name));
    }
    const backups = join(w.dir, 'backups');
    const offsiteFake = await startFakeS3();
    cleanup.push(() => offsiteFake.close());
    const settings: BackupSettings = {
        directory: backups,
        keep: 5,
        intervalHours: 24,
        offsite: {
            ...offsiteFake.settings({ bucket: 'brain-offsite' }),
            prefix: '',
        },
    };
    const run = (at: number) =>
        runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings,
            objects: { store: w.store, tenantId: 'acme' },
            offsiteStore: new S3ObjectStore(settings.offsite!, {
                backoffMs: 1,
                retries: 0,
            }),
            keys: { current: KEY, legacy: SECRET },
            now: new Date(Date.UTC(2026, 9, 9, 13, 0, at)),
        });

    // The source cuts off on the third GET (retries used up): the run fails.
    // The mirror streams each object into its file (CB-378).
    expect(w.store.getFile).toBeTypeOf('function');
    let gets = 0;
    const getFile = w.store.getFile!.bind(w.store);
    w.store.getFile = async (key, path) => {
        if (++gets === 3) {
            w.s3.failNext(3, 503, 'GET');
        }
        return getFile(key, path);
    };
    await expect(run(0)).rejects.toThrow('Object storage GET failed: HTTP 503.');
    expect(readBackupStatus(backups)).toMatchObject({
        lastErrorAt: Date.UTC(2026, 9, 9, 13, 0, 0),
        lastError: 'Object storage GET failed: HTTP 503.',
    });
    expect(existsSync(join(backups, '.backup-running'))).toBe(false);
    // The next run completes, fetching only what is still missing.
    offsiteFake.failNext(10, 500);
    const next = await run(1);
    expect(next.objects).toMatchObject({ objects: 4 });
    expect(next.objects!.fetched).toBeLessThanOrEqual(2);
    expect(next.offsiteError).toBe('Object storage HEAD failed: HTTP 500.');
    const status = readBackupStatus(backups);
    expect(status.lastSuccessAt).toBe(Date.UTC(2026, 9, 9, 13, 0, 1));
    expect(status.lastError).toBeUndefined();
    expect(status.offsiteError).toBe('Object storage HEAD failed: HTTP 500.');
    offsiteFake.failNext(0);
    await run(2);
    expect(readBackupStatus(backups).offsiteError).toBeUndefined();
});

it('never lets failed runs push complete backups out of BACKUP_KEEP', async () => {
    const w = await workspaceOverS3();
    await w.space.putFile(alice, 'a.txt', Buffer.from('FILE-a'));
    const backups = join(w.dir, 'backups');
    const run = (at: number) =>
        runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings: { directory: backups, keep: 2, intervalHours: 24 },
            objects: { store: w.store, tenantId: 'acme' },
            now: new Date(Date.UTC(2026, 9, 9, 15, 0, at)),
        });
    const names = () =>
        readdirSync(backups)
            .filter((name) => /^(company-brain-|userdata-)/.test(name))
            .sort();
    await run(0);
    await run(1);
    const good = names();
    expect(good).toEqual([
        'company-brain-20261009-150000.sqlite',
        'company-brain-20261009-150001.sqlite',
        'userdata-20261009-150000',
        'userdata-20261009-150001',
    ]);
    // S3 is down for three runs: each fails and leaves nothing behind.
    for (const at of [2, 3, 4]) {
        w.s3.failNext(100, 503);
        await expect(run(at)).rejects.toThrow('Object storage GET failed');
        expect(names()).toEqual(good);
    }
    w.s3.failNext(0);
    // Back: the next run is complete, with its objects, and prunes to two.
    await run(5);
    expect(names()).toEqual([
        'company-brain-20261009-150001.sqlite',
        'company-brain-20261009-150005.sqlite',
        'userdata-20261009-150001',
        'userdata-20261009-150005',
    ]);
    expect(objectFiles(join(backups, 'userdata-20261009-150005', 'objects'))).toHaveLength(1);
    expect(objectFiles(join(backups, 'userdata-20261009-150001', 'objects'))).toHaveLength(1);
});

it('runs one backup at a time and refuses a second', async () => {
    const w = await workspaceOverS3();
    const settings = {
        directory: join(w.dir, 'backups'),
        keep: 3,
        intervalHours: 24,
    };
    const base = {
        databasePath: w.database,
        userDataDir: w.userData,
        settings,
    };
    const one = runBackup(base);
    await expect(runBackup(base)).rejects.toThrow('A backup is already running.');
    await one;
    await runBackup(base);
});

it('rolls permanent removals’ backups off after the days in force, never by hand (CB-391)', async () => {
    const w = await workspaceOverS3();
    const directory = join(w.dir, 'backups');
    const now = Date.UTC(2026, 10, 17, 12, 0, 0);
    for (const name of ['purge-20261001-000000', 'purge-20261101-000000', 'purge-20261116-000000']) {
        mkdirSync(join(directory, name, 'files'), { recursive: true });
    }
    const purges = () =>
        readdirSync(directory)
            .filter((name) => name.startsWith('purge-'))
            .sort();
    const base = {
        databasePath: w.database,
        userDataDir: w.userData,
        settings: { directory, keep: 3, intervalHours: 24, purgeBackupDays: 30 },
    };
    // By hand (pnpm run backup) it can't read Settings: they wait.
    await runBackup({ ...base, now: new Date(now) });
    expect(purges()).toHaveLength(3);
    // Scheduled: the environment's 30 days, then an admin's 10.
    let own: { purgeBackupDays?: number } | undefined;
    const lines: string[] = [];
    const service = new BackupService({
        ...base,
        schedule: () => own,
        log: (line) => lines.push(line),
        now: () => now,
    });
    expect(service.schedule().purgeBackupDays).toBe(30);
    expect((await service.run())?.prunedPurgeBackups).toBe(1);
    expect(purges()).toEqual(['purge-20261101-000000', 'purge-20261116-000000']);
    expect(lines.at(-1)).toContain('1 permanent removal backup(s) past their days removed');
    own = { purgeBackupDays: 10 };
    expect((await service.run())?.prunedPurgeBackups).toBe(1);
    // The newest, younger than the limit, stays.
    expect(purges()).toEqual(['purge-20261116-000000']);
    expect((await service.run())?.prunedPurgeBackups).toBeUndefined();
    expect(purges()).toEqual(['purge-20261116-000000']);
});

it('schedules backups from the last attempt, retries a failure within the hour, and reports status', async () => {
    const w = await workspaceOverS3();
    const directory = join(w.dir, 'backups');
    let now = Date.UTC(2026, 9, 9, 0, 0, 0);
    const lines: string[] = [];
    // The scheduled backup, awaited to its end rather than polled for: on a
    // busy host it takes as long as it takes. Its report comes while it
    // runs, so the run in progress (what run() returns then) is awaited.
    let reported!: (run: Promise<unknown>) => void;
    const report = new Promise<unknown>((resolve) => (reported = resolve));
    const service = new BackupService({
        databasePath: w.database,
        userDataDir: w.userData,
        settings: { directory, keep: 3, intervalHours: 24 },
        objects: { store: w.store, tenantId: 'acme' },
        log: (line) => {
            lines.push(line);
            reported(service.run());
        },
        now: () => now,
        firstCheckMs: 1,
        checkMs: 5,
    });
    expect(service.due()).toBe(true);
    expect(service.status()).toEqual({
        intervalHours: 24,
        offsite: false,
        running: false,
    });
    service.start();
    await report;
    cleanup.push(() => service.stop());
    await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 10_000 });
    expect(lines[0]).toMatch(/^Backup: the database and 0 dataset\(s\)/);
    expect(lines[0]).not.toContain(directory);
    expect(service.status()).toMatchObject({
        lastSuccessAt: now,
        lastSizeBytes: expect.any(Number),
        running: false,
    });
    // Not again until a day has passed.
    now += 23 * 3_600_000;
    expect(service.due()).toBe(false);
    now += 3_600_000;
    expect(service.due()).toBe(true);
    service.stop();

    // A failure is retried after an hour, not a day.
    const failing = new BackupService({
        databasePath: join(w.dir, 'missing', 'nope.sqlite'),
        userDataDir: w.userData,
        settings: { directory, keep: 3, intervalHours: 24 },
        log: (line) => lines.push(line),
        now: () => now,
    });
    expect(await failing.run()).toBeUndefined();
    expect(lines.at(-1)).toMatch(/^Backup failed: /);
    expect(failing.status()).toMatchObject({
        lastErrorAt: now,
        lastError: expect.any(String),
    });
    now += 30 * 60_000;
    expect(failing.due()).toBe(false);
    now += 30 * 60_000;
    expect(failing.due()).toBe(true);
    // BACKUP_INTERVAL_HOURS=0: never due, until an admin sets an interval
    // in Settings (CB-112), which the next check reads.
    const own: { schedule?: { intervalHours: number } } = {};
    const off = new BackupService({
        databasePath: w.database,
        userDataDir: w.userData,
        settings: { directory: join(w.dir, 'off'), keep: 3, intervalHours: 0 },
        schedule: () => own.schedule,
        log: (line) => lines.push(line),
    });
    expect(off.due()).toBe(false);
    off.start();
    cleanup.push(() => off.stop());
    expect(off.status().intervalHours).toBe(0);
    own.schedule = { intervalHours: 6 };
    expect(off.due()).toBe(true);
    expect(off.status().intervalHours).toBe(6);
});

it('makes the /backups mount point the app’s in the image, so its volume is writable', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/mkdir -p \/data \/backups && chown node:node \/data \/backups/);
});

it('checks a copy’s integrity off the main thread and never names a damaged one a backup', async () => {
    const dir = scratch('cb-integrity-');
    const source = join(dir, 'brain.sqlite');
    const db = new DatabaseSync(source);
    db.exec('CREATE TABLE t(x TEXT); CREATE INDEX tx ON t(x); BEGIN');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 3000; i++) {
        insert.run(`row-${i}`);
    }
    db.exec('COMMIT');
    db.close();
    const backups = join(dir, 'backups');
    // A good copy: the event loop ran while it was checked.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
        const good = await backupDatabaseOnline(source, backups, 3);
        expect(existsSync(good.path)).toBe(true);
    } finally {
        clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    // A damaged source: the copy is damaged too, and isn't kept.
    const fd = openSync(source, 'r+');
    writeSync(fd, Buffer.alloc(512, 0x41), 0, 512, 4096 * 4 + 64);
    closeSync(fd);
    await expect(backupDatabaseOnline(source, backups, 3, new Date(Date.UTC(2026, 0, 1)))).rejects.toThrow(
        /integrity check/,
    );
    expect(readdirSync(backups).filter((name) => name.includes('20260101'))).toEqual([]);
});

it('finishes a copy while another connection keeps writing', async () => {
    const dir = scratch('cb-busy-');
    const source = join(dir, 'brain.sqlite');
    const db = new DatabaseSync(source);
    cleanup.push(() => db.close());
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x BLOB); BEGIN');
    const insert = db.prepare('INSERT INTO t VALUES (randomblob(4000))');
    for (let i = 0; i < 5000; i++) {
        insert.run();
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    // The server writes all the time: a copy taken a few pages at a time
    // would start over after every write and never finish.
    let writes = 0;
    const writer = setInterval(() => {
        insert.run();
        writes++;
    }, 2);
    try {
        const copy = await backupDatabaseOnline(source, join(dir, 'backups'), 3);
        const check = new DatabaseSync(copy.path, { readOnly: true });
        const { n } = check.prepare('SELECT count(*) AS n FROM t').get() as {
            n: number;
        };
        check.close();
        expect(n).toBeGreaterThanOrEqual(5000);
    } finally {
        clearInterval(writer);
    }
    expect(writes).toBeGreaterThan(0);
}, 15_000);
