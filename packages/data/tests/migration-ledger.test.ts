import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '../src/drift.js';
import { SqliteMigrationLedger } from '../src/infra/sqlite/ledger.js';
import { migrationTables } from '../src/infra/sqlite/migrations-schema.js';
import { migrate, migrationChecksum } from '../src/migrate.js';

/*
 * The migration runner's ledger (CB-110): `schema_migrations` and
 * `schema_readers` written through their Drizzle mirror, held to the
 * runner's DDL here.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function database() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    return db;
}

const contract = {
    id: 'widgets',
    migrations: [
        { version: 1, name: 'widgets', up: 'CREATE TABLE widgets(id TEXT)' },
        {
            version: 2,
            name: 'drop widgets',
            phase: 'contract' as const,
            readersFrom: 2,
            up: 'DROP TABLE widgets',
        },
    ],
};

it('mirrors the runner’s tables as it makes them', () => {
    const db = database();
    migrate(db, [contract]);
    expect(schemaDrift(db, migrationTables)).toEqual([]);
    db.exec('ALTER TABLE schema_readers ADD COLUMN note TEXT');
    expect(schemaDrift(db, migrationTables)).toEqual([expect.stringContaining('note')]);
});

it('records each migration it applies, and a contract’s oldest reader', () => {
    const db = database();
    const before = Date.now();
    migrate(db, [contract]);
    const rows = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([
        {
            module: 'widgets',
            version: 1,
            name: 'widgets',
            appliedAt: expect.any(Number),
            checksum: migrationChecksum(contract.migrations[0]!),
        },
        {
            module: 'widgets',
            version: 2,
            name: 'drop widgets',
            appliedAt: expect.any(Number),
            checksum: migrationChecksum(contract.migrations[1]!),
        },
    ]);
    expect(Number(rows[0]!.appliedAt)).toBeGreaterThanOrEqual(before);
    expect(db.prepare('SELECT * FROM schema_readers').all()).toEqual([{ module: 'widgets', minVersion: 2 }]);
});

it('raises a module’s oldest reader, never lowers it', () => {
    const db = database();
    migrate(db, [contract]);
    const ledger = new SqliteMigrationLedger(db);
    ledger.raiseReadersNow('widgets', 1);
    ledger.raiseReadersNow('gadgets', 3);
    ledger.raiseReadersNow('widgets', 4);
    expect(db.prepare('SELECT * FROM schema_readers ORDER BY module').all()).toEqual([
        { module: 'gadgets', minVersion: 3 },
        { module: 'widgets', minVersion: 4 },
    ]);
    // One migration is recorded once.
    expect(() =>
        ledger.recordNow({
            module: 'widgets',
            version: 1,
            name: 'again',
            appliedAt: 1,
            checksum: 'x',
        }),
    ).toThrow();
});
