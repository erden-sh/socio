import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { int, ms, str } from '../../columns.sqlite.js';

/**
 * The runtimes' identities and leases (CB-108), as `runtimeSchema`
 * (runtime-ownership.ts) makes them: the typed mirror of the columns a
 * backup copy's release writes (CB-110). The migrations stay the source of
 * truth; tests/runtime-copy.test.ts holds these to them. The lease and
 * fencing code itself (`RuntimeOwnership`) still runs its own SQL.
 */

export const runtimeInstances = sqliteTable('runtime_instances', {
    id: str().primaryKey(),
    startedAt: ms().notNull(),
    heartbeatAt: ms().notNull(),
    expiresAt: ms().notNull(),
    releasedAt: ms(),
});

export const runtimeLeases = sqliteTable('runtime_leases', {
    resource: str().primaryKey(),
    ownerId: str().notNull(),
    epoch: int().notNull(),
    expiresAt: ms().notNull(),
    releasedAt: ms(),
});

export const runtimeTables = [runtimeInstances, runtimeLeases];
