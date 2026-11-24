import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate, MigrationError, planMigrations } from '@socio/data/migrate';

import { bootDatabase } from '../src/server/modules/boot.js';
import { schemas } from '../src/server/modules/index.js';
import { calendarSchema } from '../src/server/plugins/calendar/migrations.js';
import { plannerSchema } from '../src/server/plugins/planner/migrations.js';
import { migrateBundledPlugin } from '../src/server/plugins/plugin-schemas.js';

import { testDatabaseFile } from './helpers/test-database.js';

// The one step that migrates the app's database (modules/boot.ts): what it
// does beyond the registry, and that a booted database needs nothing else.

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn());
    vi.restoreAllMocks();
});
function paths() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-boot-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return { path: join(dir, 'app.sqlite'), backupDirectory: join(dir, 'backups') };
}
function open(path: string) {
    const db = new DatabaseSync(path);
    cleanup.push(() => db.isOpen && db.close());
    return db;
}
const hasTable = (db: DatabaseSync, name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const install = (db: DatabaseSync, id: string) =>
    db
        .prepare(
            "INSERT INTO plugin_installs (id, version, enabled, display, config, permissions, manifest, replicas, audience, installedAt, updatedAt) VALUES (?, '1.0.0', 1, 'tab', '{}', '[]', '{}', 1, 'admins', 1, 1)",
        )
        .run(id);

it('migrates an empty database, with no plugin tables until one is installed', () => {
    const { path, backupDirectory } = paths();
    const { steps, backup } = bootDatabase(path, { backupDirectory });
    expect(steps).toHaveLength(schemas.flatMap((set) => set.migrations ?? []).length);
    // Nothing to protect yet.
    expect(backup).toBeUndefined();
    const db = open(path);
    expect(planMigrations(db, schemas, { strict: true })).toEqual([]);
    expect(hasTable(db, 'calendar_events')).toBe(false);
    db.close();
    // Again: nothing to do, so nothing is written or backed up.
    expect(bootDatabase(path, { backupDirectory })).toEqual({ steps: [], backup: undefined });
});

it('brings an installed plugin up to date, after a backup, and leaves the others alone', () => {
    const { path, backupDirectory } = paths();
    testDatabaseFile(path);
    const seeded = open(path);
    install(seeded, 'calendar');
    // A plugin whose bundle this build doesn't have isn't an error.
    install(seeded, 'someone-elses');
    seeded.close();

    const lines: string[] = [];
    const { steps, backup } = bootDatabase(path, { backupDirectory, log: (line) => lines.push(line) });
    expect(steps.map((step) => step.module)).toEqual(calendarSchema.migrations!.map(() => 'calendar'));
    expect(backup).toBeTruthy();
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('Backed up'))).toHaveLength(1);

    const db = open(path);
    expect(hasTable(db, 'calendar_events')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE module='social-strategy'").get()?.n).toBe(0);
    db.close();
    expect(bootDatabase(path, { backupDirectory }).steps).toEqual([]);
});

it('migrates an installed plugin that is partway up, from where it stopped', () => {
    const { path, backupDirectory } = paths();
    testDatabaseFile(path);
    const seeded = open(path);
    install(seeded, 'social-strategy');
    // As a release with only its first migration left it.
    const [first, ...pending] = plannerSchema.migrations!;
    expect(pending).not.toEqual([]);
    migrate(seeded, [{ id: plannerSchema.id, migrations: [first] }]);
    const hasExcerpt = () =>
        !!seeded.prepare("SELECT 1 FROM pragma_table_info('reply_queue') WHERE name='excerpt'").get();
    expect(hasExcerpt()).toBe(false);

    const { steps, backup } = bootDatabase(path, { backupDirectory });
    expect(steps.map(({ module, version }) => ({ module, version }))).toEqual(
        pending.map(({ version }) => ({ module: plannerSchema.id, version })),
    );
    expect(backup).toBeTruthy();
    expect(hasExcerpt()).toBe(true);
    expect(planMigrations(seeded, [plannerSchema])).toEqual([]);
});

it('keeps the downgrade guard on an installed plugin', () => {
    const { path, backupDirectory } = paths();
    testDatabaseFile(path);
    const db = open(path);
    install(db, 'calendar');
    migrateBundledPlugin(db, 'calendar');
    const newest = Math.max(...calendarSchema.migrations!.map((migration) => migration.version));
    db.prepare(
        "INSERT INTO schema_migrations (module, version, name, appliedAt, checksum) VALUES ('calendar', ?, 'future', 1, 'x')",
    ).run(newest + 1);
    db.exec('CREATE TABLE IF NOT EXISTS schema_readers(module TEXT PRIMARY KEY, minVersion INTEGER NOT NULL)');
    db.prepare("INSERT INTO schema_readers VALUES ('calendar', ?)").run(newest + 1);
    db.close();
    expect(() => bootDatabase(path, { backupDirectory })).toThrow(MigrationError);
});

it('makes a bundled plugin’s tables on install, and nothing for an unknown one', () => {
    const { path } = paths();
    const db = open(testDatabaseFile(path));
    expect(hasTable(db, 'calendar_events')).toBe(false);
    migrateBundledPlugin(db, 'calendar');
    expect(hasTable(db, 'calendar_events')).toBe(true);
    expect(() => migrateBundledPlugin(db, 'no-such-plugin')).not.toThrow();
});

it('refuses an in-memory database rather than booting on empty stores', () => {
    expect(() => bootDatabase(':memory:', { backupDirectory: paths().backupDirectory })).toThrow(/must be a file/);
});
