import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';

import { BACKUP_CONTEXT } from '../src/server/backup/backup-offsite.js';
import type { BackupSettings } from '../src/server/backup/contract.js';

import { startFakeS3, type FakeS3 } from './fixtures/fake-s3.js';

// CB-378: a backup's memory must not grow with the data it copies. The
// fixture is a database of DATABASE_MB, and a dataset, a local file and S3
// objects of SMALL_MB each; the backup (with the object mirror and the
// off-site copy) runs in a child process, which measures how much more its
// resident set grows than a small backup's (so what every run costs on a
// given Node doesn't count), and that may be CEILING at most. Streamed, it
// is 70 to 100 MB (buffers waiting for the garbage collector) on Node 24
// and 26, at 88 MB or 200 MB of database alike; reading whole files, as
// before CB-378, it was 275 to 295 MB at 88 MB, and fails.
// BACKUP_MEMORY_MB sets DATABASE_MB by hand and prints what was measured.
//
// On disk it needs about three times DATABASE_MB at its peak (the database,
// its backup, the off-site copy's sealed file): on the system's temporary
// directory, or /dev/shm when that has ample room. Without the room it is
// skipped, and says why.
const MB = 1024 * 1024;
const DATABASE_MB = Number(process.env.BACKUP_MEMORY_MB) || 88;
const SMALL_MB = 4;
const CEILING = 176 * MB;
const NEEDED = (DATABASE_MB * 3 + SMALL_MB * 6 + 32) * MB;
const linux = process.platform === 'linux';

const free = (path: string) => {
    try {
        const stats = statfsSync(path);
        return stats.bavail * stats.bsize;
    } catch {
        return 0;
    }
};
/** /dev/shm only with room to spare for the rest of the suite; else the system's temporary directory. */
const root = linux && free('/dev/shm') >= NEEDED * 4 ? '/dev/shm' : tmpdir();
const room = free(root) >= NEEDED;
if (linux && !room) {
    console.warn(
        `backup-memory.test.ts skipped: ${root} has ${Math.floor(free(root) / MB)} MB free, the fixture needs ${NEEDED / MB} MB.`,
    );
}

const KEY = randomBytes(32);
const box = new SecretBox({ current: KEY, legacy: 'backup-memory-test-secret-0123456' }, 'data-files');
/** What a sealed file starts with: the backup checks no more of it. */
const SEALED_HEADER = box.sealBytes(Buffer.alloc(0), 'fixture');

let dir: string | undefined;
let fake: FakeS3 | undefined;
beforeAll(async () => {
    if (linux && room) {
        dir = mkdtempSync(join(root, 'backup-memory-'));
        fake = await startFakeS3();
    }
});
afterAll(async () => {
    await fake?.close();
    if (dir) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A database of about `mb` megabytes of random rows, written a row at a time. */
function database(path: string, mb: number) {
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA journal_mode=WAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB)');
        const insert = db.prepare('INSERT INTO rows (body) VALUES (randomblob(?))');
        db.exec('BEGIN');
        for (let i = 0; i < mb * 16; i++) {
            insert.run(64 * 1024);
        }
        db.exec('COMMIT');
    } finally {
        db.close();
    }
}
/** Sealed-looking bytes of `mb` megabytes, written a megabyte at a time. */
function sealedFile(path: string, mb: number) {
    const fd = openSync(path, 'w', 0o600);
    try {
        writeSync(fd, SEALED_HEADER);
        for (let i = 0; i < mb; i++) {
            writeSync(fd, randomBytes(MB));
        }
    } finally {
        closeSync(fd);
    }
}
function sealedBytes(mb: number) {
    return Buffer.concat([SEALED_HEADER, randomBytes(mb * MB)]);
}

it.skipIf(!linux || !room)(
    'backs up large data with a bounded resident set (CB-378)',
    async () => {
        const dir_ = dir!;
        const fake_ = fake!;
        const databasePath = join(dir_, 'company-brain.sqlite');
        database(databasePath, DATABASE_MB);
        const userData = join(dir_, 'userdata');
        mkdirSync(join(userData, 'alice', 'datasets'), { recursive: true });
        mkdirSync(join(userData, 'alice', 'files'), { recursive: true });
        database(join(userData, 'alice', 'datasets', 'sales.sqlite'), SMALL_MB);
        sealedFile(join(userData, 'alice', 'files', 'report.bin'), SMALL_MB);
        fake_.buckets.add('company-brain');
        fake_.objects.set('company-brain/tenants/acme/users/alice/files/video', sealedBytes(SMALL_MB));
        fake_.objects.set('company-brain/tenants/acme/users/alice/files/small', sealedBytes(1));
        // The warm-up: a database of a megabyte, a tenant with one small object.
        const warm = join(dir_, 'warm');
        mkdirSync(join(warm, 'userdata'), { recursive: true });
        database(join(warm, 'company-brain.sqlite'), 1);
        fake_.objects.set('company-brain/tenants/warm/users/alice/files/small', sealedBytes(1));

        const offsite = { ...fake_.settings({ bucket: 'brain-offsite' }), prefix: 'cb/' };
        const settings: BackupSettings = { directory: join(dir_, 'backups'), keep: 2, intervalHours: 24, offsite };
        const run = {
            databasePath,
            userDataDir: userData,
            settings,
            objects: { ...fake_.settings(), prefix: '', tenantId: 'acme' },
            key: KEY.toString('base64'),
            warmup: {
                databasePath: join(warm, 'company-brain.sqlite'),
                userDataDir: join(warm, 'userdata'),
                settings: {
                    directory: join(warm, 'backups'),
                    keep: 2,
                    intervalHours: 24,
                    offsite: { ...offsite, prefix: 'warm/' },
                },
                tenantId: 'warm',
            },
        };
        const child = spawn(
            process.execPath,
            ['--max-old-space-size=256', '--expose-gc', '--import', 'tsx', 'tests/fixtures/backup-memory-child.ts'],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    TMPDIR: process.env.TMPDIR,
                    BACKUP_MEMORY_RUN: JSON.stringify(run),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.stderr.on('data', (chunk) => (err += chunk));
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        expect(err).toBe('');
        expect(code).toBe(0);
        const measured = JSON.parse(out) as {
            growth: number;
            offsiteError?: string;
            offsite?: { objectsSent: number };
            objects?: { fetched: number };
            datasets: number;
            files: number;
        };
        if (process.env.BACKUP_MEMORY_MB) {
            console.log(`backup memory: ${JSON.stringify(measured)}`);
        }
        expect(measured).toMatchObject({ datasets: 1, files: 1, objects: { fetched: 2 }, offsite: { objectsSent: 2 } });
        expect(measured.offsiteError).toBeUndefined();
        expect(measured.growth).toBeLessThan(CEILING);

        // The off-site copy is as before: the sealed database opens and holds every row.
        // The local backups are done with: room for the restored copy.
        rmSync(join(dir_, 'backups'), { recursive: true, force: true });
        const sealed = [...fake_.objects.entries()].find(([key]) =>
            /^brain-offsite\/cb\/snapshots\/[^/]+\/company-brain\.sqlite\.sealed$/.test(key),
        )?.[1];
        const restored = join(dir_, 'restored.sqlite');
        writeFileSync(
            restored,
            new SecretBox({ current: KEY, legacy: 'x' }, 'backups').openBytes(sealed!, BACKUP_CONTEXT),
        );
        const db = new DatabaseSync(restored, { readOnly: true });
        try {
            expect(db.prepare('SELECT count(*) AS n FROM rows').get()).toEqual({ n: DATABASE_MB * 16 });
        } finally {
            db.close();
        }
        const video = fake_.objects.get('company-brain/tenants/acme/users/alice/files/video')!;
        expect(fake_.objects.get('brain-offsite/cb/objects/tenants/acme/users/alice/files/video')?.equals(video)).toBe(
            true,
        );
    },
    300_000,
);
