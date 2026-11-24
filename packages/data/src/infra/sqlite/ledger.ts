import type { DatabaseSync } from 'node:sqlite';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';

import { schemaMigrations, schemaReaders } from './migrations-schema.js';

/** An applied (or adopted) migration, as the ledger records it. */
export interface AppliedMigration {
    module: string;
    version: number;
    name: string;
    appliedAt: number;
    checksum: string;
}

/**
 * The migration runner's ledger on one connection (CB-110): its writes run
 * in the runner's own `BEGIN IMMEDIATE`, with the migration they record.
 * The runner may run before the app's unit of work exists on the
 * connection, and on connections that never have one, so it uses its own
 * Drizzle handle.
 */
export class SqliteMigrationLedger {
    private db;
    constructor(connection: DatabaseSync) {
        this.db = drizzle({ client: connection });
    }

    recordNow(migration: AppliedMigration) {
        this.db.insert(schemaMigrations).values(migration).run();
    }

    /** Raises a module's oldest reader to `minVersion`; never lowers it. */
    raiseReadersNow(module: string, minVersion: number) {
        const r = schemaReaders;
        this.db
            .insert(r)
            .values({ module, minVersion })
            .onConflictDoUpdate({
                target: r.module,
                set: {
                    minVersion: sql`max(${r.minVersion}, excluded.${sql.identifier('minVersion')})`,
                },
            })
            .run();
    }
}
