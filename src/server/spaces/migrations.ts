import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The Spaces module's own tables (CB-181). The Spaces themselves stay the
 * workspace schema's (`spaces`, `dot_spaces`); these say who reads and
 * approves a Space's shared memory: its people with their role
 * (`space_members`, one row per Space and person; removing a person
 * deletes the row, and the workspace audit keeps the change) and whether
 * the Space is read by its people only (`space_settings`, a row only once
 * an editor sets it). Nothing is back-filled: with no rows, every Space is
 * open to the workspace, as its pages are, and admins are its editors.
 *
 * Expand-only (CB-108's contract, tests/migration-contract.test.ts): new
 * tables only, so the build before it runs on the schema it leaves.
 */
export const spacesSchema: SchemaSet = {
    id: MODULE_IDS.spaces,
    migrations: [
        {
            version: 1,
            name: 'space access',
            phase: 'expand',
            up: `CREATE TABLE space_members(
        spaceId TEXT NOT NULL CHECK (spaceId IS NOT NULL AND length(spaceId) > 0),
        userId TEXT NOT NULL CHECK (userId IS NOT NULL AND length(userId) > 0),
        role TEXT NOT NULL CHECK (role IS NOT NULL AND role IN ('editor', 'member')),
        addedBy TEXT,
        addedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (spaceId, userId)
      );
      CREATE INDEX space_members_user ON space_members(userId);
      CREATE TABLE space_settings(
        spaceId TEXT PRIMARY KEY,
        membersOnly INTEGER NOT NULL DEFAULT 0 CHECK (membersOnly IS NOT NULL AND membersOnly IN (0, 1)),
        updatedBy TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
        },
    ],
};
