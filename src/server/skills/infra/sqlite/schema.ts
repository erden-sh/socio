import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, int, ms, str } from '@socio/data/columns.sqlite';

/**
 * Chat skills' tables (CB-110), as `skills/migrations.ts` makes them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth; tests/chat-skill-repositories.test.ts holds these to them.
 */

export const chatSkills = sqliteTable('chat_skills', {
    id: str().primaryKey(),
    name: str().notNull(),
    revision: int().notNull(),
    createdAt: ms().notNull(),
    createdBy: str().notNull(),
    updatedAt: ms().notNull(),
    updatedBy: str().notNull(),
    deletedAt: ms(),
    deletedBy: str(),
});

export const chatSkillRevisions = sqliteTable(
    'chat_skill_revisions',
    {
        skillId: str().notNull(),
        revision: int().notNull(),
        description: str().notNull(),
        instructions: str().notNull(),
        mode: enumText(['turn', 'until-done']).notNull(),
        sha256: str().notNull(),
        source: enumText(['workspace', 'git']).notNull(),
        sourceUrl: str(),
        sourcePath: str(),
        sourceRef: str(),
        sourceCommit: str(),
        restoredFrom: int(),
        createdAt: ms().notNull(),
        createdBy: str().notNull(),
        /** JSON of the import's digest and license (`SkillProvenance`). */
        sourceMetadata: str(),
    },
    (t) => [primaryKey({ columns: [t.skillId, t.revision] })],
);

export const chatSkillSessions = sqliteTable('chat_skill_sessions', {
    id: str().primaryKey(),
    threadId: str().notNull(),
    skill: str().notNull(),
    startedAt: ms().notNull(),
    startedBy: str().notNull(),
    endedAt: ms(),
    endedBy: str(),
    endReason: enumText(['done', 'model', 'replaced', 'stopped', 'removed']),
});

export const chatSkillTables = [chatSkills, chatSkillRevisions, chatSkillSessions];
