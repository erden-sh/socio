import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { backupDatabase, tightenBackups } from './backup.js';
import { CONTRACT_BASELINE } from './contract.js';
import { SqliteMigrationLedger } from './infra/sqlite/ledger.js';
import { applyConnectionPragmas } from './sqlite-pragmas.js';

/**
 * One ordered schema change of a module. Each runs in its own transaction
 * together with its `schema_migrations` row, so it must not open one itself.
 */
export interface Migration {
    version: number;
    name: string;
    /**
     * The schema as it was before migrations were tracked (version 1 only).
     * It must be idempotent: on a database that already has all of its tables,
     * columns and indexes it is marked applied without running ("adopted");
     * otherwise it runs and fills in what is missing.
     */
    baseline?: boolean;
    /**
     * Expand/contract (CB-108, docs/DATA-LAYER.md "Migrations both versions
     * run on"): during a start-first deploy the previous release keeps
     * running on the schema this one migrated. `expand` (the default) only
     * adds: tables, nullable or defaulted columns, indexes that aren't
     * unique on an existing table. `contract` removes or tightens something
     * (DROP, RENAME, a new unique index on old data) and ships at least one
     * release after the code stopped using it. tests/migration-contract.test.ts
     * enforces this for every migration newer than `CONTRACT_BASELINE`.
     */
    phase?: 'expand' | 'contract';
    /**
     * A contract only: the oldest version of this module a build must know
     * to run on the result (default: this migration's own version, so no
     * older build may). Recorded in `schema_readers`; older builds refuse to
     * start below it, newer schemas above it are fine for them.
     */
    readersFrom?: number;
    /**
     * An expand migration the contract check would flag (a DROP of
     * something this same migration created, say): why every build since
     * the previous release still runs on it.
     */
    compatible?: string;
    /**
     * Checksums that earlier builds recorded for this migration when its
     * source differed only in form (formatting, braces, a call chain on one
     * line), reviewed as the same DDL and data. A database that recorded one
     * of them isn't told the migration changed. A change in what it does is
     * never listed here: it is a new migration. The checksum hashes the
     * compiled source (`String(up)` for a function), so reformatting a
     * released migration changes it; scripts/released-migrations.mjs fails
     * the build when that happens.
     */
    formerChecksums?: readonly string[];
    up: string | ((db: DatabaseSync) => void);
}
/** A module's migrations, or those of a store that isn't a module. */
export interface SchemaSet {
    id: string;
    migrations?: readonly Migration[];
}
export interface MigrationStep {
    module: string;
    version: number;
    name: string;
    action: 'adopt' | 'apply';
}
export class MigrationError extends Error {}

const ID = /^[a-z][a-z0-9-]*$/;
const TABLE =
    'CREATE TABLE IF NOT EXISTS schema_migrations(module TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, appliedAt INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(module, version))';
/**
 * The oldest version of a module a build must know to run on this
 * database (CB-108): raised only by contract migrations, and made by the
 * first one. No row: any build that knows the module at all, since every
 * migration after it expanded.
 * Builds from before this table ignore it and keep the strict guard.
 */
const READERS = 'CREATE TABLE IF NOT EXISTS schema_readers(module TEXT PRIMARY KEY, minVersion INTEGER NOT NULL)';

/**
 * Identifies a migration's source. Only compared to warn about an applied
 * migration that was edited; whitespace is ignored.
 */
export function migrationChecksum(migration: Migration) {
    const source = typeof migration.up === 'string' ? migration.up : String(migration.up);
    return createHash('sha256')
        .update(`${migration.name}\n${source.replace(/\s+/g, ' ').trim()}`)
        .digest('hex')
        .slice(0, 16);
}

function validate(sets: readonly SchemaSet[]) {
    const ids = new Set<string>();
    for (const set of sets) {
        if (!ID.test(set.id)) {
            throw new MigrationError(`Invalid module id "${set.id}".`);
        }
        if (ids.has(set.id)) {
            throw new MigrationError(`Module "${set.id}" is listed twice.`);
        }
        ids.add(set.id);
        let previous = 0;
        for (const migration of set.migrations ?? []) {
            if (!Number.isInteger(migration.version) || migration.version <= previous) {
                throw new MigrationError(`Migrations of "${set.id}" must have increasing positive versions.`);
            }
            if (migration.baseline && migration.version !== 1) {
                throw new MigrationError(`Only version 1 of "${set.id}" can be a baseline.`);
            }
            if (
                migration.readersFrom !== undefined &&
                (migration.phase !== 'contract' ||
                    !Number.isInteger(migration.readersFrom) ||
                    migration.readersFrom < 1 ||
                    migration.readersFrom > migration.version)
            ) {
                throw new MigrationError(
                    `Migration ${set.id} ${migration.version}: readersFrom is for a contract migration, between 1 and its own version.`,
                );
            }
            previous = migration.version;
        }
    }
}

/** Tables, indexes, triggers and views other than SQLite's and the runner's. */
function objects(db: DatabaseSync) {
    const rows = db
        .prepare(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'schema_readers')",
        )
        .all() as { type: string; name: string }[];
    return new Map(
        rows.map((row) => [
            row.name,
            {
                type: row.type,
                columns:
                    row.type === 'table'
                        ? new Set(
                              db
                                  .prepare(`PRAGMA table_info("${row.name}")`)
                                  .all()
                                  .map((column) => String(column.name)),
                          )
                        : new Set<string>(),
            },
        ]),
    );
}

function run(db: DatabaseSync, migration: Migration) {
    if (typeof migration.up === 'string') {
        db.exec(migration.up);
    } else {
        migration.up(db);
    }
}

/**
 * Whether the database already has every object a baseline creates: it is
 * run on an empty scratch database and the result compared, so adopting
 * needs no hand-written list of tables and columns.
 */
function baselinePresent(existing: ReturnType<typeof objects>, migration: Migration) {
    const scratch = new DatabaseSync(':memory:');
    let expected: ReturnType<typeof objects>;
    try {
        run(scratch, migration);
        expected = objects(scratch);
    } finally {
        scratch.close();
    }
    for (const [name, object] of expected) {
        const found = existing.get(name);
        if (!found || found.type !== object.type) {
            return false;
        }
        for (const column of object.columns) {
            if (!found.columns.has(column)) {
                return false;
            }
        }
    }
    return true;
}

type Applied = Map<string, Map<number, { checksum: string }>>;
function appliedMigrations(db: DatabaseSync): Applied {
    const applied: Applied = new Map();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) {
        return applied;
    }
    const rows = db.prepare('SELECT module, version, checksum FROM schema_migrations').all() as {
        module: string;
        version: number;
        checksum: string;
    }[];
    for (const row of rows) {
        if (!applied.has(row.module)) {
            applied.set(row.module, new Map());
        }
        applied.get(row.module)!.set(row.version, { checksum: row.checksum });
    }
    return applied;
}

/** `schema_readers`, or nothing when no contract migration ever ran. */
function readerFloors(db: DatabaseSync): Map<string, number> {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_readers'").get()) {
        return new Map();
    }
    return new Map(
        (
            db.prepare('SELECT module, minVersion FROM schema_readers').all() as {
                module: string;
                minVersion: number;
            }[]
        ).map((row) => [row.module, row.minVersion]),
    );
}

export interface PlanOptions {
    /**
     * Refuse a database with migrations of modules this code doesn't list.
     * Boot passes every module; a plugin's set on its own doesn't.
     */
    strict?: boolean;
    log?: (line: string) => void;
}

/**
 * What `migrate` would do, without writing. Throws the downgrade guard: a
 * database migrated by newer code is never opened by older code.
 */
export function planMigrations(
    db: DatabaseSync,
    sets: readonly SchemaSet[],
    { strict = false, log }: PlanOptions = {},
): MigrationStep[] {
    validate(sets);
    const applied = appliedMigrations(db);
    const floors = readerFloors(db);
    for (const [module, versions] of applied) {
        const set = sets.find((entry) => entry.id === module);
        const newest = Math.max(...versions.keys());
        const known = set ? Math.max(0, ...(set.migrations ?? []).map((m) => m.version)) : 0;
        if (newest <= known || (!set && !strict)) {
            continue;
        }
        // A newer build migrated it. Only expand migrations followed (CB-108):
        // this build still runs on it, as the previous release does while a
        // start-first deploy overlaps them, or after a rollback. Migrations
        // from before the rule (CONTRACT_BASELINE) may have contracted.
        const floor = floors.get(module) ?? 0;
        const unruled = [...versions.keys()].some(
            (version) => version > known && version <= (CONTRACT_BASELINE[module] ?? 0),
        );
        if (!unruled && floor <= known) {
            log?.(
                `The database has ${module} migration ${newest}, newer than this build's ${known}; every newer one only expands, so this build runs on it.`,
            );
            continue;
        }
        throw new MigrationError(
            set
                ? `The database has ${module} migration ${newest}, but this build of Socio knows only up to ${known} and the database needs builds that know ${floor}. It was migrated by a newer build: run that build, or restore a backup taken before it.`
                : `The database has migrations of module "${module}", which this build of Socio doesn't have, and they need builds that know them. It was migrated by a newer build: run that build, or restore a backup taken before it.`,
        );
    }
    let existing: ReturnType<typeof objects> | undefined;
    const steps: MigrationStep[] = [];
    for (const set of sets) {
        for (const migration of set.migrations ?? []) {
            const done = applied.get(set.id)?.get(migration.version);
            if (done) {
                if (
                    done.checksum !== migrationChecksum(migration) &&
                    !migration.formerChecksums?.includes(done.checksum)
                ) {
                    log?.(`Migration ${set.id} ${migration.version} (${migration.name}) changed after it was applied.`);
                }
                continue;
            }
            existing ??= objects(db);
            steps.push({
                module: set.id,
                version: migration.version,
                name: migration.name,
                action: migration.baseline && existing.size && baselinePresent(existing, migration) ? 'adopt' : 'apply',
            });
        }
    }
    return steps;
}

export interface MigrateOptions extends PlanOptions {
    /** Called once, before the first pending migration is written. */
    beforeApply?: (steps: MigrationStep[]) => void;
}

/**
 * Brings the database to the schema the given sets describe, in order: each
 * pending migration is adopted (a baseline whose objects all exist) or run,
 * in a `BEGIN IMMEDIATE` transaction with its `schema_migrations` row.
 */
export function migrate(db: DatabaseSync, sets: readonly SchemaSet[], options: MigrateOptions = {}): MigrationStep[] {
    const steps = planMigrations(db, sets, options);
    if (!steps.length) {
        return steps;
    }
    options.beforeApply?.(steps);
    db.exec(TABLE);
    const ledger = new SqliteMigrationLedger(db);
    for (const step of steps) {
        const migration = sets
            .find((set) => set.id === step.module)!
            .migrations!.find((entry) => entry.version === step.version)!;
        db.exec('BEGIN IMMEDIATE');
        try {
            // Another connection to the same file may have got here first.
            if (
                !db
                    .prepare('SELECT 1 FROM schema_migrations WHERE module=? AND version=?')
                    .get(step.module, step.version)
            ) {
                if (step.action === 'apply') {
                    run(db, migration);
                }
                ledger.recordNow({
                    module: step.module,
                    version: step.version,
                    name: step.name,
                    appliedAt: Date.now(),
                    checksum: migrationChecksum(migration),
                });
                // A contract raises the oldest build that may run on it; never lowers.
                if (migration.phase === 'contract') {
                    db.exec(READERS);
                    ledger.raiseReadersNow(step.module, migration.readersFrom ?? migration.version);
                }
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        options.log?.(
            `Migration ${step.module} ${step.version} (${step.name}): ${step.action === 'adopt' ? 'adopted, its objects already exist' : 'applied'}.`,
        );
    }
    return steps;
}

/**
 * Migrates the database file before any store opens it (`bootDatabase`).
 * Refuses a database from a newer build, and backs up a database that already
 * has tables before writing anything to it. `conditional` names sets that
 * depend on what the migrated database holds, which run after `sets`.
 */
export function migrateDatabase(
    path: string,
    sets: readonly SchemaSet[],
    options: {
        backupDirectory: string;
        keep?: number;
        log?: (line: string) => void;
        conditional?: (db: DatabaseSync) => readonly SchemaSet[];
    },
) {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
        const tightened = tightenBackups(options.backupDirectory);
        if (tightened > 0) {
            options.log?.(`Made ${tightened} existing backup(s) private (0600).`);
        }
    }
    const db = new DatabaseSync(path);
    let backup: string | undefined;
    try {
        applyConnectionPragmas(db);
        const populated = objects(db).size > 0;
        const beforeApply = (pending: MigrationStep[]) => {
            if (!populated || backup || path === ':memory:') {
                return;
            }
            backup = backupDatabase(path, options.backupDirectory, options.keep).path;
            options.log?.(`Backed up the database to ${backup} before ${pending.length} pending migration(s).`);
        };
        const steps = migrate(db, sets, { strict: true, log: options.log, beforeApply });
        const conditional = options.conditional?.(db) ?? [];
        // Not strict: the registry's sets aren't listed here, and were just checked.
        steps.push(...migrate(db, conditional, { log: options.log, beforeApply }));
        return { steps, backup };
    } finally {
        db.close();
    }
}
