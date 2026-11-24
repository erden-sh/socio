import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { ProfileFields } from '@socio/shared/memory';
import { SPACE_MEMORY_STATUSES } from '@socio/shared/space-memory';

/**
 * The Memory context's tables (CB-110), as the migrations make them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth (`core` 1 to 6, frozen, then `memory/migrations.ts`);
 * tests/memory-repositories.test.ts holds these to them.
 */

export const memories = sqliteTable('memories', {
    id: id().primaryKey(),
    text: str().notNull(),
    createdAt: ms().notNull(),
    /** Null only for a memory from before user accounts (`assignUnowned`). */
    userId: str(),
    deletedAt: ms(),
    deletedBy: str(),
    status: enumText(['proposed', 'active']).notNull(),
    source: enumText(['person', 'socio', 'notes']).notNull(),
    shareable: flag().notNull(),
    dotId: str(),
    threadId: str(),
    updatedAt: ms(),
    confirmedAt: ms(),
});

/** One live version per person; saving stamps the one before (CB-64). */
export const userProfiles = sqliteTable('user_profiles', {
    id: id().primaryKey(),
    userId: str().notNull(),
    fields: json<ProfileFields>().notNull(),
    shareable: flag().notNull(),
    createdAt: ms().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
    timezoneDetected: flag().notNull(),
});

/** One per person: the latest move of their detected time zone (CB-176). */
export const timeZoneNotes = sqliteTable('time_zone_notes', {
    userId: str().primaryKey(),
    zone: str().notNull(),
    createdAt: ms().notNull(),
    chatShownAt: ms(),
    pageShownAt: ms(),
});

/**
 * A person's episodes (CB-180): what happened in their own chats, one row
 * per fact (by `key`, per chat) and one summary per chat.
 */
export const memoryEpisodes = sqliteTable('memory_episodes', {
    id: id().primaryKey(),
    userId: str().notNull(),
    threadId: str().notNull(),
    dotId: str(),
    kind: enumText(['fact', 'summary']).notNull(),
    label: str(),
    key: str().notNull(),
    text: str().notNull(),
    occurredAt: ms().notNull(),
    createdAt: ms().notNull(),
});

/**
 * A Space's shared memory (CB-181): one row per version of an entry, with
 * its provenance; see memory migration 3.
 */
export const spaceMemories = sqliteTable('space_memories', {
    id: id().primaryKey(),
    entryId: str().notNull(),
    spaceId: str().notNull(),
    version: int(),
    text: str().notNull(),
    status: enumText(SPACE_MEMORY_STATUSES).notNull(),
    proposedBy: str().notNull(),
    dotId: str(),
    threadId: str(),
    supersedes: str(),
    createdAt: ms().notNull(),
    decidedBy: str(),
    decidedAt: ms(),
    endedBy: str(),
    endedAt: ms(),
});

/** The tables core's history made (frozen), and the baseline adopts. */
export const baselineMemoryTables = [memories, userProfiles, timeZoneNotes] as const;

/** Every table the Memory context owns. */
export const memoryTables = [...baselineMemoryTables, memoryEpisodes, spaceMemories] as const;
