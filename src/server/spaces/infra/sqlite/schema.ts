import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, ms, str } from '@socio/data/columns.sqlite';
import { SPACE_ROLES } from '@socio/shared/space-memory';

/**
 * The Spaces module's tables (CB-181), as `spaces/migrations.ts` makes
 * them: the typed mirror the repository queries. The migrations stay the
 * source of truth; tests/space-memory.test.ts holds these to them.
 */

export const spaceMembers = sqliteTable(
    'space_members',
    {
        spaceId: id().notNull(),
        userId: str().notNull(),
        role: enumText(SPACE_ROLES).notNull(),
        addedBy: str(),
        addedAt: ms().notNull(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.spaceId, table.userId] })],
);

export const spaceSettings = sqliteTable('space_settings', {
    spaceId: id().primaryKey(),
    membersOnly: flag().notNull(),
    updatedBy: str().notNull(),
    updatedAt: ms().notNull(),
});

/** Every table the Spaces module owns. */
export const spaceTables = [spaceMembers, spaceSettings] as const;
