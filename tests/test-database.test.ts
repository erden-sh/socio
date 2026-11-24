import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { migrate, migrateDatabase } from '@socio/data/migrate';

import { schemas } from '../src/server/modules/index.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

// The template is what most tests now start from, so these are what keep it
// honest: the real migrations still run, from nothing and from an older
// ledger, and the template is exactly what they leave.

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-test-database-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const objects = (db: DatabaseSync) =>
    db
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
const ledger = (db: DatabaseSync) =>
    db.prepare('SELECT module, version, name, checksum FROM schema_migrations ORDER BY module, version').all();

it('holds exactly what the real migrations make on an empty database', () => {
    const empty = new DatabaseSync(':memory:');
    cleanup.push(() => empty.close());
    expect(objects(empty)).toEqual([]);
    const steps = migrate(empty, schemas, { strict: true });
    const applied = schemas.flatMap((set) => set.migrations ?? []).length;
    expect(steps).toHaveLength(applied);
    expect(steps.every((step) => step.action === 'apply')).toBe(true);
    const template = testDatabase();
    cleanup.push(() => template.close());
    expect(objects(template)).toEqual(objects(empty));
    expect(ledger(template)).toEqual(ledger(empty));
    // A copy has nothing left to run, so a constructor can trust it.
    expect(migrate(template, schemas, { strict: true })).toEqual([]);
});

it('gives each caller its own copy', () => {
    const one = testDatabase();
    const other = testDatabase();
    cleanup.push(
        () => one.close(),
        () => other.close(),
    );
    one.prepare("INSERT INTO settings VALUES (1, '{}')").run();
    expect(one.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n).toBe(1);
    expect(other.prepare('SELECT COUNT(*) AS n FROM settings').get()?.n).toBe(0);
});

it('writes a file a server can open, reopen and share between stores', () => {
    const path = testDatabaseFile(join(scratch(), 'nested', 'app.sqlite'));
    for (let open = 0; open < 2; open++) {
        const store = new Store(path);
        const workspace = new WorkspaceStore(path);
        expect(store.settings().name).toBe('Socio');
        expect(workspace.companyDots().length).toBeGreaterThan(0);
        workspace.close();
        store.close();
    }
    expect(() => migrateDatabase(path, schemas, { backupDirectory: join(scratch(), 'backups') })).not.toThrow();
});

it('upgrades a database whose ledger stops short, running only what is pending', () => {
    const dir = scratch();
    const path = join(dir, 'old.sqlite');
    // An older build: the last migration of each module hasn't happened yet.
    // A set of one migration was all there or all new, so it counts too.
    const older = schemas.map((set) => ({ ...set, migrations: set.migrations?.slice(0, -1) }));
    const before = migrateDatabase(path, older, { backupDirectory: join(dir, 'backups') });
    const missing = schemas.flatMap((set) => set.migrations?.slice(-1).map((m) => `${set.id} ${m.version}`) ?? []);
    expect(before.steps).toHaveLength(schemas.flatMap((set) => set.migrations ?? []).length - missing.length);

    const after = migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    expect(after.steps.map((step) => `${step.module} ${step.version}`).sort()).toEqual(missing.sort());
    // There was data to protect, so boot took a backup first.
    expect(after.backup).toBeTruthy();

    const upgraded = new DatabaseSync(path);
    const template = testDatabase();
    cleanup.push(
        () => upgraded.close(),
        () => template.close(),
    );
    expect(ledger(upgraded)).toEqual(ledger(template));
    expect(migrate(upgraded, schemas, { strict: true })).toEqual([]);
});
