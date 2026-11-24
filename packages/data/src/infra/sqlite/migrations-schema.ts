import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { int, ms, str } from '../../columns.sqlite.js';

/**
 * The migration runner's own tables (CB-110), as `migrate` makes them
 * (packages/data/src/migrate.ts): the typed mirror its ledger writes. The runner's
 * DDL stays the source of truth; tests/migration-ledger.test.ts holds
 * these to it.
 */

/** Each module's applied migrations. */
export const schemaMigrations = sqliteTable(
    'schema_migrations',
    {
        module: str().notNull(),
        version: int().notNull(),
        name: str().notNull(),
        appliedAt: ms().notNull(),
        checksum: str().notNull(),
    },
    (t) => [primaryKey({ columns: [t.module, t.version] })],
);

/** The oldest version of a module a build must know (CB-108). */
export const schemaReaders = sqliteTable('schema_readers', {
    module: str().primaryKey(),
    minVersion: int().notNull(),
});

export const migrationTables = [schemaMigrations, schemaReaders];
