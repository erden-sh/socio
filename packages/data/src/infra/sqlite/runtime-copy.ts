import type { DatabaseSync } from 'node:sqlite';

import { isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';

import { runtimeInstances, runtimeLeases } from './runtime-schema.js';

/**
 * A copy of the database (a backup) on its own connection, outside the
 * app's unit of work (CB-110): nothing in a copy is running (CB-108).
 */
export class SqliteRuntimeCopy {
    private db;
    constructor(copy: DatabaseSync) {
        this.db = drizzle({ client: copy });
    }

    /**
     * Releases every runtime and lease in the copy, so a server opened on it
     * closes the turns and runs they held at once instead of waiting out
     * their leases. Runs in the caller's transaction on the copy.
     */
    releaseAllNow(at: number) {
        this.db.update(runtimeInstances).set({ releasedAt: at }).where(isNull(runtimeInstances.releasedAt)).run();
        this.db.update(runtimeLeases).set({ releasedAt: at }).where(isNull(runtimeLeases.releasedAt)).run();
    }
}
