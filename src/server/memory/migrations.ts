import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The Memory context's migrations (CB-110). Its tables (`memories`,
 * `user_profiles`, `time_zone_notes`) were made by `core` 1 to 6, which
 * stay as they are, frozen. Version 1 is a baseline of the tables as they
 * are: on a database that has them, the runner adopts it without running
 * it (one `schema_migrations` row, no data change). Core migrates first,
 * so where it runs instead (a fresh database, or one older than core 6),
 * its `IF NOT EXISTS` finds everything made already and changes nothing;
 * it only makes the tables on a database migrated with this set alone.
 * Changes to these tables come here from now on, as version 2 and up.
 *
 * Every migration after the baseline is expand-only (CB-108's contract,
 * tests/migration-contract.test.ts): a build before it runs on the
 * schema it leaves.
 */
export const memorySchema: SchemaSet = {
    id: MODULE_IDS.memories,
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL, userId TEXT, deletedAt INTEGER, deletedBy TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IS NOT NULL AND status IN ('proposed', 'active')), source TEXT NOT NULL DEFAULT 'person' CHECK (source IS NOT NULL AND source IN ('person', 'socio', 'notes')), shareable INTEGER NOT NULL DEFAULT 0 CHECK (shareable IS NOT NULL AND shareable IN (0, 1)), dotId TEXT, threadId TEXT, updatedAt INTEGER, confirmedAt INTEGER);
    CREATE INDEX IF NOT EXISTS memories_user ON memories(userId, status, createdAt);
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      fields TEXT NOT NULL CHECK (fields IS NOT NULL AND json_valid(fields)),
      shareable INTEGER NOT NULL CHECK (shareable IS NOT NULL AND shareable IN (0, 1)),
      createdAt INTEGER NOT NULL,
      deletedAt INTEGER,
      deletedBy TEXT,
      timezoneDetected INTEGER NOT NULL DEFAULT 0 CHECK (timezoneDetected IS NOT NULL AND timezoneDetected IN (0, 1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_live ON user_profiles(userId) WHERE deletedAt IS NULL;
    CREATE TABLE IF NOT EXISTS time_zone_notes (
      userId TEXT PRIMARY KEY,
      zone TEXT NOT NULL CHECK (zone IS NOT NULL AND length(zone) > 0),
      createdAt INTEGER NOT NULL,
      chatShownAt INTEGER,
      pageShownAt INTEGER
    );`,
        },
        {
            version: 2,
            name: 'episodes',
            phase: 'expand',
            // A person's episodes (CB-180): what happened in their own chats,
            // captured when a chat's notes are compacted. `key` is the text
            // folded (a fact pinned again in the same chat is one row, moved on
            // in `occurredAt`); a chat's summary is one row, key 'summary'.
            // Deleting one removes the row; retention removes those whose
            // `occurredAt` is older than the setting.
            up: `CREATE TABLE memory_episodes (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL CHECK (userId IS NOT NULL AND length(userId) > 0),
        threadId TEXT NOT NULL CHECK (threadId IS NOT NULL AND length(threadId) > 0),
        dotId TEXT,
        kind TEXT NOT NULL CHECK (kind IS NOT NULL AND kind IN ('fact', 'summary')),
        label TEXT,
        key TEXT NOT NULL CHECK (key IS NOT NULL AND length(key) > 0),
        text TEXT NOT NULL CHECK (text IS NOT NULL AND length(text) > 0),
        occurredAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        UNIQUE (userId, threadId, kind, key)
      );
      CREATE INDEX memory_episodes_user ON memory_episodes(userId, occurredAt);
      CREATE INDEX memory_episodes_age ON memory_episodes(occurredAt)`,
        },
        {
            version: 3,
            name: 'space memory',
            phase: 'expand',
            // A Space's shared memory (CB-181): one row per version of an entry
            // (`entryId` across versions). Members and socios propose
            // (`proposed`); a Space editor approves (`active`, numbered in
            // `version`) or rejects; an approved change supersedes the version
            // before; an editor retires an entry. Provenance in every row: who
            // proposed it, for whom a socio did (`dotId`), in which chat, who
            // decided and ended it, and when. Retention deletes what has been
            // out of use longer than the setting; deleting a retired entry
            // removes its rows.
            up: `CREATE TABLE space_memories (
        id TEXT PRIMARY KEY,
        entryId TEXT NOT NULL CHECK (entryId IS NOT NULL AND length(entryId) > 0),
        spaceId TEXT NOT NULL CHECK (spaceId IS NOT NULL AND length(spaceId) > 0),
        version INTEGER,
        text TEXT NOT NULL CHECK (text IS NOT NULL AND length(text) > 0),
        status TEXT NOT NULL CHECK (status IS NOT NULL AND status IN ('proposed', 'active', 'superseded', 'rejected', 'withdrawn', 'retired')),
        proposedBy TEXT NOT NULL CHECK (proposedBy IS NOT NULL AND length(proposedBy) > 0),
        dotId TEXT,
        threadId TEXT,
        supersedes TEXT,
        createdAt INTEGER NOT NULL,
        decidedBy TEXT,
        decidedAt INTEGER,
        endedBy TEXT,
        endedAt INTEGER
      );
      CREATE INDEX space_memories_space ON space_memories(spaceId, status);
      CREATE INDEX space_memories_entry ON space_memories(entryId, createdAt);
      CREATE INDEX space_memories_ended ON space_memories(status, endedAt)`,
        },
    ],
};
