import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { CONTRACT_BASELINE, contractViolations } from '@socio/data/contract';
import { migrate, migrateDatabase, MigrationError, type Migration, type SchemaSet } from '@socio/data/migrate';

import { schemas } from '../src/server/modules/index.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-contract-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return { path: join(dir, 'app.sqlite'), backups: join(dir, 'backups') };
};

const v1: Migration = {
    version: 1,
    name: 'notes',
    up: 'CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
};
const v2: Migration = {
    version: 2,
    name: 'note titles',
    phase: 'expand',
    up: 'ALTER TABLE notes ADD COLUMN title TEXT',
};
const set = (...migrations: Migration[]): SchemaSet => ({
    id: 'notes',
    migrations,
});

it('holds every migration since the baseline to expand/contract', () => {
    expect(contractViolations(schemas)).toEqual([]);
});

it('keeps the baseline frozen: raising it would exempt new migrations', () => {
    // A copy, so that loosening the rule shows as an edit in two places.
    expect(CONTRACT_BASELINE).toEqual({
        core: 7,
        workspace: 15,
        'schedule-tasks': 2,
        auth: 3,
        'agent-grants': 1,
        pages: 9,
        computers: 2,
        channels: 1,
        inference: 2,
        web: 1,
        spaces: 0,
        telegram: 1,
        learning: 3,
        runs: 4,
        chat: 7,
        memories: 1,
        issues: 13,
        dispatch: 3,
        approvals: 4,
        data: 9,
        media: 4,
        apps: 5,
        schedules: 8,
        domains: 2,
        notifications: 2,
        'chat-skills': 3,
        operations: 3,
        'mcp-connections': 1,
        'change-counters': 1,
    });
    // The runtime module is new with CB-108: checked from its first migration.
    expect(CONTRACT_BASELINE.runtime).toBeUndefined();
});

it('flags removals, renames, deletes and tightening outside a contract', () => {
    const check = (up: Migration['up'], extra: Partial<Migration> = {}) =>
        contractViolations([set(v1, { ...v2, up, ...extra })], {});
    expect(check('ALTER TABLE notes ADD COLUMN title TEXT')).toEqual([]);
    expect(check('CREATE INDEX notes_title ON notes(title)')).toEqual([]);
    for (const up of [
        'DROP TABLE notes',
        'ALTER TABLE notes DROP COLUMN body',
        'ALTER TABLE notes RENAME COLUMN body TO text',
        'DELETE FROM notes WHERE body = ""',
        'CREATE UNIQUE INDEX notes_body ON notes(body)',
        "CREATE TRIGGER t BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'no'); END",
        'drop index notes_title',
    ]) {
        expect(check(up), up).toHaveLength(1);
    }
    // Function migrations are checked by their source too.
    expect(
        check((db) => {
            db.exec('DROP TABLE notes');
        }),
    ).toHaveLength(1);
    // An explained exception passes; a contract needs its readers.
    expect(check('DROP INDEX notes_tmp', { compatible: 'made and dropped here' })).toEqual([]);
    expect(check('ALTER TABLE notes DROP COLUMN body', { phase: 'contract' })).toEqual([
        expect.stringContaining('readersFrom'),
    ]);
    expect(
        check('ALTER TABLE notes DROP COLUMN body', {
            phase: 'contract',
            readersFrom: 2,
        }),
    ).toEqual([]);
});

it('lets an older build run on a schema a newer one only expanded', () => {
    const { path, backups } = scratch();
    const lines: string[] = [];
    // The newer build: notes 1 and 2, and a module the older one lacks.
    migrateDatabase(
        path,
        [
            set(v1, v2),
            {
                id: 'tags',
                migrations: [{ version: 1, name: 'tags', up: 'CREATE TABLE tags(id TEXT)' }],
            },
        ],
        { backupDirectory: backups },
    );
    // The older build, booting strictly (a rollback, or its task restarting
    // while the deploy overlaps): it runs.
    expect(
        migrateDatabase(path, [set(v1)], {
            backupDirectory: backups,
            log: (line) => lines.push(line),
        }).steps,
    ).toEqual([]);
    expect(lines.join('\n')).toContain('only expands');
    // And it still writes as it always did.
    const db = new DatabaseSync(path);
    cleanup.push(() => db.close());
    db.prepare('INSERT INTO notes(id, body) VALUES (?, ?)').run('n1', 'hello');
    expect(db.prepare('SELECT title FROM notes').get()).toEqual({ title: null });
});

it('refuses an older build below the readers a contract migration raised', () => {
    const { path, backups } = scratch();
    const v3: Migration = {
        version: 3,
        name: 'drop body',
        phase: 'contract',
        // Builds that know version 2 already stopped reading `body`.
        readersFrom: 2,
        up: 'ALTER TABLE notes DROP COLUMN body',
    };
    migrateDatabase(path, [set(v1, v2, v3)], { backupDirectory: backups });
    // The release before the contract runs on it…
    expect(migrateDatabase(path, [set(v1, v2)], { backupDirectory: backups }).steps).toEqual([]);
    // …the one that still read the dropped column doesn't.
    expect(() => migrateDatabase(path, [set(v1)], { backupDirectory: backups })).toThrow(MigrationError);
    expect(() => migrateDatabase(path, [set(v1)], { backupDirectory: backups })).toThrow('needs builds that know 2');
    // A later, stricter contract only ever raises the floor.
    const v4: Migration = {
        version: 4,
        name: 'unique titles',
        phase: 'contract',
        up: 'CREATE UNIQUE INDEX notes_title ON notes(title)',
    };
    migrateDatabase(path, [set(v1, v2, v3, v4)], { backupDirectory: backups });
    expect(() => migrateDatabase(path, [set(v1, v2, v3)], { backupDirectory: backups })).toThrow(
        'needs builds that know 4',
    );
});

it('refuses an unknown module once a contract of it ran', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [
        set(v1),
        {
            id: 'tags',
            migrations: [
                { version: 1, name: 'tags', up: 'CREATE TABLE tags(id TEXT)' },
                {
                    version: 2,
                    name: 'drop tags',
                    phase: 'contract',
                    readersFrom: 2,
                    up: 'DROP TABLE tags',
                },
            ],
        },
    ]);
    expect(() => migrate(db, [set(v1)], { strict: true })).toThrow('which this build of Socio doesn');
    // Not strict (a store migrating only its own sets): it doesn't look.
    expect(migrate(db, [set(v1)])).toEqual([]);
});

it('rejects readersFrom outside a contract or beyond its version', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    expect(() => migrate(db, [set(v1, { ...v2, readersFrom: 1 })])).toThrow('readersFrom is for a contract migration');
    expect(() => migrate(db, [set(v1, { ...v2, phase: 'contract', readersFrom: 3 })])).toThrow(
        'readersFrom is for a contract migration',
    );
});
