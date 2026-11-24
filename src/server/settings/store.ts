import type { DatabaseSync } from 'node:sqlite';

import type { SchemaSet } from '@socio/data/migrate';
import type { Settings } from '@socio/shared/types';

import { SqliteSecretSettings } from './secret-settings.js';
import { SqliteWorkspaceSettings } from './workspace-settings.js';

const defaults: Settings = {
    name: 'Socio',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
};
/**
 * Settings, scheduled tasks and their runs. Versions 1 and 3 to 6 also
 * made the Memory context's tables (`memories`, `user_profiles`,
 * `time_zone_notes`), and versions 1 to 3 the Scheduling context's
 * (`tasks`, `runs`, `events`): that history stays here, frozen, and their
 * changes go in `memory/migrations.ts` and `schedules/migrations.ts` from
 * now on (CB-110).
 */
export const coreSchema: SchemaSet = {
    id: 'core',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['2338e7a7a4911d42'],
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
                for (const table of ['tasks', 'memories']) {
                    if (
                        !db
                            .prepare(`PRAGMA table_info(${table})`)
                            .all()
                            .some((field) => field.name === 'userId')
                    ) {
                        db.exec(`ALTER TABLE ${table} ADD COLUMN userId TEXT`);
                    }
                }
            },
        },
        {
            version: 2,
            name: 'schedules',
            // Cadence-based schedules (Dot-proposed, or the user's), which
            // run a Dot turn or a job; `kind` NULL is a turn, as before.
            up: `ALTER TABLE tasks ADD COLUMN title TEXT;
      ALTER TABLE tasks ADD COLUMN cadence TEXT;
      ALTER TABLE tasks ADD COLUMN timezone TEXT;
      ALTER TABLE tasks ADD COLUMN dotId TEXT;
      ALTER TABLE tasks ADD COLUMN kind TEXT;
      ALTER TABLE tasks ADD COLUMN jobId TEXT;
      ALTER TABLE tasks ADD COLUMN origin TEXT;
      ALTER TABLE tasks ADD COLUMN lastRunAt INTEGER;
      CREATE INDEX tasks_user ON tasks(userId, createdAt);`,
        },
        {
            // CB-64: deleting hides a task or memory and keeps it. A task deleted
            // with its conversation records it in `deletedWith`.
            version: 3,
            name: 'soft delete',
            up: `ALTER TABLE tasks ADD COLUMN deletedAt INTEGER;
      ALTER TABLE tasks ADD COLUMN deletedBy TEXT;
      ALTER TABLE tasks ADD COLUMN deletedWith TEXT;
      ALTER TABLE memories ADD COLUMN deletedAt INTEGER;
      ALTER TABLE memories ADD COLUMN deletedBy TEXT;`,
        },
        {
            // CB-106: a person's memories say where they came from (the person,
            // or a socio's proposal from a chat), wait for approval when a socio
            // proposed them, may be used in team chats, and say when the person
            // last confirmed them. Memories from before were the person's own.
            // A profile per person, one live version each: a save stamps the one
            // before it as deleted (CB-64), so earlier versions are kept.
            version: 4,
            name: 'personal memory',
            up: `ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IS NOT NULL AND status IN ('proposed', 'active'));
      ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'person' CHECK (source IS NOT NULL AND source IN ('person', 'socio', 'notes'));
      ALTER TABLE memories ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0 CHECK (shareable IS NOT NULL AND shareable IN (0, 1));
      ALTER TABLE memories ADD COLUMN dotId TEXT;
      ALTER TABLE memories ADD COLUMN threadId TEXT;
      ALTER TABLE memories ADD COLUMN updatedAt INTEGER;
      ALTER TABLE memories ADD COLUMN confirmedAt INTEGER;
      UPDATE memories SET updatedAt = createdAt, confirmedAt = createdAt;
      CREATE INDEX memories_user ON memories(userId, status, createdAt);
      CREATE TABLE user_profiles (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        fields TEXT NOT NULL CHECK (fields IS NOT NULL AND json_valid(fields)),
        shareable INTEGER NOT NULL CHECK (shareable IS NOT NULL AND shareable IN (0, 1)),
        createdAt INTEGER NOT NULL,
        deletedAt INTEGER,
        deletedBy TEXT
      );
      CREATE UNIQUE INDEX user_profiles_live ON user_profiles(userId) WHERE deletedAt IS NULL;`,
        },
        {
            version: 5,
            name: 'detected time zone',
            // CB-159: the profile's time zone was detected from the person's
            // browser (1), not written by them (0).
            up: `ALTER TABLE user_profiles ADD COLUMN timezoneDetected INTEGER NOT NULL DEFAULT 0 CHECK (timezoneDetected IS NOT NULL AND timezoneDetected IN (0, 1))`,
        },
        {
            version: 6,
            name: 'time zone notes',
            // CB-176: a person's detected time zone followed their browser to
            // `zone`; the quiet note saying so, shown once in their next chat
            // and once on the Memories page. One per person: the latest move.
            up: `CREATE TABLE time_zone_notes (
        userId TEXT PRIMARY KEY,
        zone TEXT NOT NULL CHECK (zone IS NOT NULL AND length(zone) > 0),
        createdAt INTEGER NOT NULL,
        chatShownAt INTEGER,
        pageShownAt INTEGER
      )`,
        },
        {
            version: 7,
            name: 'secret settings',
            // CB-204: settings that are secrets, sealed under the data key and
            // kept out of `settings` (which the browser sees): the transcription
            // server's key, by name. `url` is the one a key is for, when it is
            // for one: not secret, and readable when the seal isn't.
            up: `CREATE TABLE secret_settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL CHECK (value IS NOT NULL AND length(value) > 0),
        url TEXT
      )`,
        },
    ],
};
/** The settings slices the core store holds (`composition/core-store.ts`, `settings/contract.ts`). */
export interface StoreSlices {
    readonly settings: SqliteWorkspaceSettings;
    readonly secrets: SqliteSecretSettings;
}

/** Writes the default settings row unless the database has one. */
export function seedSettings(db: DatabaseSync) {
    db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify(defaults));
}

/**
 * The settings slices on one connection. A save that turns work off
 * interrupts the running tasks through `interruptRunning`, in the same
 * unit of work (`SqliteWorkspaceSettings.updateSettings`).
 */
export function settingsSlices(db: DatabaseSync, interruptRunning: (reason: string) => Promise<unknown>): StoreSlices {
    const secrets = new SqliteSecretSettings(db);
    return { settings: new SqliteWorkspaceSettings(db, secrets, interruptRunning), secrets };
}
