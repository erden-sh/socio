import { sql } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';

import type { SoulRecord, SoulRepository } from '../../contract.js';

import { socioSouls } from './schema.js';

/**
 * Souls on the shared connection. Its statements run on the open unit of
 * work's handle, or at once outside one; Drizzle's node:sqlite statements
 * execute at once (`.run()`), which `appendNow` relies on.
 */
export class SqliteSouls implements SoulRepository {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    appendNow(soul: SoulRecord) {
        this.db.insert(socioSouls).values(soul).run();
        // The socio's own row is the workspace's (`dots`), whose mirror comes
        // with the workspace's repositories; only its copy of the standing
        // instructions is written here.
        this.db.run(sql`UPDATE "dots" SET "instructions" = ${soul.instructions} WHERE "id" = ${soul.dotId}`);
    }
}
