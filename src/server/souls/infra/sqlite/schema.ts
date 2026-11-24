import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, int, ms, str } from '@socio/data/columns.sqlite';

/**
 * Souls' table (CB-110), as workspace migration 17 makes it
 * (workspace.ts): the typed mirror the repository queries. The migrations
 * stay the source of truth; tests/soul-repositories.test.ts holds it to
 * them.
 */

export const socioSouls = sqliteTable(
    'socio_souls',
    {
        dotId: str().notNull(),
        version: int().notNull(),
        instructions: str().notNull(),
        voice: str().notNull(),
        values: str().notNull(),
        style: str().notNull(),
        createdAt: ms().notNull(),
        createdBy: str().notNull(),
        source: enumText(['migrated', 'created', 'edited', 'restored']).notNull(),
        restoredFrom: int(),
    },
    (t) => [primaryKey({ columns: [t.dotId, t.version] })],
);

export const soulTables = [socioSouls];
