import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';

import { BACKUP_CONTEXT } from '../src/server/backup/backup-offsite.js';
import { runBackup } from '../src/server/backup/backup-service.js';
import type { BackupSettings } from '../src/server/backup/contract.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';

// CB-369: analytical parts are in every backup, copied once into a
// mirror and hard-linked into each run, and sent off-site once, sealed.

const KEY = randomBytes(32);
const NEXT_KEY = randomBytes(32);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A dataset file with a catalog listing `parts`, and their files beside it. */
function world() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-analytical-backups-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const database = join(dir, 'app.sqlite');
    new DatabaseSync(database).close();
    const userData = join(dir, 'userdata');
    const datasetId = randomUUID();
    const tableId = randomUUID();
    const datasets = join(userData, 'plugin_datasync', 'datasets');
    mkdirSync(datasets, { recursive: true });
    const path = join(datasets, `${datasetId}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec(
        'CREATE TABLE _olap_parts(id TEXT PRIMARY KEY, table_id TEXT NOT NULL, partition TEXT NOT NULL, rows INTEGER, bytes INTEGER, min_value INTEGER, max_value INTEGER, columns INTEGER, append_id TEXT, write_id INTEGER, created_at INTEGER, retired_at INTEGER, retired_by TEXT)',
    );
    db.close();
    const addPart = (partition: string, body = `PARQUET-${partition}`) => {
        const id = randomUUID();
        const file = join(datasets, `${datasetId}.parts`, tableId, partition, `${id}.parquet`);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, body);
        const rw = new DatabaseSync(path);
        rw.prepare('INSERT INTO _olap_parts(id, table_id, partition, rows, bytes) VALUES (?, ?, ?, 1, ?)').run(
            id,
            tableId,
            partition,
            body.length,
        );
        rw.close();
        return { id, file };
    };
    return { dir, database, userData, datasetId, tableId, path, addPart };
}

it('links each part into every run, copies it once, and prunes it with the last run that links it', async () => {
    const w = world();
    const first = w.addPart('2026-11-09');
    const backups = join(w.dir, 'backups');
    const settings: BackupSettings = { directory: backups, keep: 2, intervalHours: 24 };
    const run = (at: number) =>
        runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings,
            now: new Date(Date.UTC(2026, 10, 15, 3, 0, at)),
        });
    const a = await run(0);
    expect(a).toMatchObject({ parts: 1 });
    const linked = (result: { userdata: string }, part: { id: string }, partition: string) =>
        join(
            result.userdata,
            'plugin_datasync',
            'datasets',
            `${w.datasetId}.parts`,
            w.tableId,
            partition,
            `${part.id}.parquet`,
        );
    const inA = linked(a, first, '2026-11-09');
    expect(existsSync(inA)).toBe(true);
    const second = w.addPart('2026-11-10');
    const b = await run(1);
    expect(b).toMatchObject({ parts: 2 });
    // The same part in both runs is one file on the backup volume.
    expect(statSync(linked(b, first, '2026-11-09')).ino).toBe(statSync(inA).ino);
    // A listed part missing on disk is counted, never fatal.
    rmSync(second.file);
    const mirrored = join(backups, 'parts', w.datasetId, `${second.id}.parquet`);
    rmSync(mirrored);
    const c = await run(2);
    expect(c).toMatchObject({ parts: 1, missingParts: 1 });
    // BACKUP_KEEP=2: run a went, b and c keep the first part; nothing else is mirrored.
    expect(existsSync(a.userdata)).toBe(false);
    expect(existsSync(join(backups, 'parts', w.datasetId, `${first.id}.parquet`))).toBe(true);
    // Retired from the catalog, a part's mirror stays while a kept run links
    // it, and goes with the last of them.
    const db = new DatabaseSync(w.path);
    db.prepare('DELETE FROM _olap_parts WHERE id = ?').run(first.id);
    db.close();
    rmSync(first.file);
    const firstMirror = join(backups, 'parts', w.datasetId, `${first.id}.parquet`);
    await run(3);
    expect(existsSync(firstMirror)).toBe(true);
    await run(4);
    expect(existsSync(firstMirror)).toBe(false);
});

it('sends each part off-site once, sealed, beside the snapshots', async () => {
    const w = world();
    w.addPart('2026-11-09', 'PARQUET-PLAINTEXT-ROWS');
    const fake = await startFakeS3({ region: 'eu-west-1' });
    cleanup.push(() => fake.close());
    const settings: BackupSettings = {
        directory: join(w.dir, 'backups'),
        keep: 2,
        intervalHours: 24,
        offsite: { ...fake.settings({ bucket: 'offsite' }), prefix: 'cb/' },
    };
    const offsiteStore = new S3ObjectStore(settings.offsite!, { backoffMs: 1 });
    const run = (at: number, current = KEY, previous?: Uint8Array) =>
        runBackup({
            databasePath: w.database,
            userDataDir: w.userData,
            settings,
            offsiteStore,
            keys: { current, ...(previous ? { previous } : {}), legacy: 'legacy-secret-0123456789abcdef' },
            now: new Date(Date.UTC(2026, 10, 15, 3, 0, at)),
        });
    const first = await run(0);
    expect(first.offsiteError).toBeUndefined();
    expect(first.offsite).toMatchObject({ parts: 1, partsSent: 1 });
    const second = await run(1);
    expect(second.offsite).toMatchObject({ parts: 1, partsSent: 0 });
    const keys = [...fake.objects.keys()].filter((key) => key.startsWith('offsite/cb/parts/'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/\.parquet\.sealed$/);
    // No part goes into a snapshot as a plain file, and nothing is plaintext.
    expect([...fake.objects.keys()].some((key) => /snapshots\/.*\.parts\//.test(key))).toBe(false);
    expect(fake.allBytes().toString('latin1')).not.toContain('PARQUET-PLAINTEXT-ROWS');
    const box = new SecretBox({ current: KEY, legacy: 'x' }, 'backups');
    expect(box.openBytes(fake.objects.get(keys[0]!)!, BACKUP_CONTEXT).toString()).toBe('PARQUET-PLAINTEXT-ROWS');
    // After the data key rotates, the part goes again under the new key, so
    // the kept snapshots never need the retired one.
    const rotated = await run(2, NEXT_KEY, KEY);
    expect(rotated.offsite).toMatchObject({ parts: 1, partsSent: 1 });
    expect((await run(3, NEXT_KEY)).offsite).toMatchObject({ parts: 1, partsSent: 0 });
    const next = new SecretBox({ current: NEXT_KEY, legacy: 'x' }, 'backups');
    expect(next.openBytes(fake.objects.get(keys[0]!)!, BACKUP_CONTEXT).toString()).toBe('PARQUET-PLAINTEXT-ROWS');
    // Retired, the off-site part stays while a kept snapshot may need it:
    // it leaves the local mirror with the last local run that links it (run
    // 5, BACKUP_KEEP=2), and off-site once every kept snapshot is newer (7).
    const db = new DatabaseSync(w.path);
    db.exec('DELETE FROM _olap_parts');
    db.close();
    for (const at of [4, 5, 6]) {
        expect((await run(at, NEXT_KEY)).offsite?.partsRemoved ?? 0).toBe(0);
        expect(fake.objects.has(keys[0]!)).toBe(true);
    }
    expect((await run(7, NEXT_KEY)).offsite).toMatchObject({ partsRemoved: 1 });
    expect(fake.objects.has(keys[0]!)).toBe(false);
});
