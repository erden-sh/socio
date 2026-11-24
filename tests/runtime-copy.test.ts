import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { backupDatabase } from '@socio/data/backup';
import { schemaDrift } from '@socio/data/drift';
import { SqliteRuntimeCopy } from '@socio/data/infra/sqlite/runtime-copy';
import { runtimeTables } from '@socio/data/infra/sqlite/runtime-schema';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

/*
 * A backup copy's runtimes (CB-108, CB-110): the copy's release writes
 * through its Drizzle mirror of the runtime tables, held to the runtime
 * migrations here.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function seeded(db: DatabaseSync) {
    db.exec(`INSERT INTO runtime_instances VALUES ('live', 1, 2, 9999999999999, NULL);
    INSERT INTO runtime_instances VALUES ('gone', 1, 2, 3, 5);
    INSERT INTO runtime_leases VALUES ('turn:t1', 'live', 3, 9999999999999, NULL);
    INSERT INTO runtime_leases VALUES ('turn:t0', 'gone', 1, 3, 4);`);
}

const released = (db: DatabaseSync) => ({
    instances: db.prepare('SELECT id, releasedAt FROM runtime_instances ORDER BY id').all(),
    leases: db.prepare('SELECT resource, releasedAt FROM runtime_leases ORDER BY resource').all(),
});

it('mirrors the migrated runtime identities and leases', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    expect(schemaDrift(db, runtimeTables)).toEqual([]);
    db.exec('ALTER TABLE runtime_leases ADD COLUMN note TEXT');
    expect(schemaDrift(db, runtimeTables)).toEqual([expect.stringContaining('note')]);
});

it('releases the live runtimes and leases, keeping when the others ended', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    seeded(db);
    new SqliteRuntimeCopy(db).releaseAllNow(100);
    expect(released(db)).toEqual({
        instances: [
            { id: 'gone', releasedAt: 5 },
            { id: 'live', releasedAt: 100 },
        ],
        leases: [
            { resource: 'turn:t0', releasedAt: 4 },
            { resource: 'turn:t1', releasedAt: 100 },
        ],
    });
});

it('a backup copy holds no running work; the live database keeps its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-runtime-copy-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'live.sqlite');
    const live = new DatabaseSync(testDatabaseFile(path));
    seeded(live);
    live.close();
    const { path: copyPath } = backupDatabase(path, join(dir, 'backups'));
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    const original = new DatabaseSync(path, { readOnly: true });
    cleanup.push(
        () => copy.close(),
        () => original.close(),
    );
    const fromCopy = released(copy);
    expect(fromCopy.instances).toEqual([
        { id: 'gone', releasedAt: 5 },
        { id: 'live', releasedAt: expect.any(Number) },
    ]);
    expect(fromCopy.leases[1]).toEqual({
        resource: 'turn:t1',
        releasedAt: fromCopy.instances[1]!.releasedAt,
    });
    expect(released(original).instances[1]).toEqual({
        id: 'live',
        releasedAt: null,
    });
});
