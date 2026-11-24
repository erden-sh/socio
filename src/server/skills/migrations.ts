import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Workspace chat skills (CB-143): the `prompt` skills admins add in
 * Settings, and the skills on in each chat. The only module that reads or
 * writes their tables.
 *
 * - `chat_skills`: one row per skill, with its current `revision`. A delete
 *   hides it and keeps it; its name is free again.
 * - `chat_skill_revisions`: every revision of a skill, never changed: its
 *   content (description, instructions, mode), the content's SHA-256, and
 *   its source, lockfile-style (`workspace` now; a git URL, path, ref and
 *   commit once skills install from git, CB-144). A rollback adds a
 *   revision with an earlier one's content (`restoredFrom`).
 * - `chat_skill_sessions`: each time an `until-done` skill was on in a
 *   chat, who started it, and when and how it ended. A session is its
 *   starter's: in a shared chat (a Telegram team topic) it applies to
 *   their turns only, and only they (or the Dot on their turns) end it; at
 *   most one on per person and chat (`endedAt` NULL).
 */
export const chatSkillsSchema: SchemaSet = {
    id: MODULE_IDS.chatSkills,
    migrations: [
        {
            version: 1,
            name: 'workspace skills',
            up: `CREATE TABLE chat_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (name IS NOT NULL AND length(name) BETWEEN 1 AND 32),
        revision INTEGER NOT NULL CHECK (revision IS NOT NULL AND revision >= 1),
        createdAt INTEGER NOT NULL,
        createdBy TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL,
        deletedAt INTEGER,
        deletedBy TEXT
      );
      CREATE UNIQUE INDEX chat_skills_name ON chat_skills(name) WHERE deletedAt IS NULL;
      CREATE TABLE chat_skill_revisions (
        skillId TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision IS NOT NULL AND revision >= 1),
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IS NOT NULL AND mode IN ('turn', 'until-done')),
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IS NOT NULL AND source IN ('workspace', 'git')),
        sourceUrl TEXT,
        sourcePath TEXT,
        sourceRef TEXT,
        sourceCommit TEXT,
        restoredFrom INTEGER,
        createdAt INTEGER NOT NULL,
        createdBy TEXT NOT NULL,
        PRIMARY KEY (skillId, revision)
      );
      CREATE TABLE chat_skill_sessions (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        skill TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        startedBy TEXT NOT NULL,
        endedAt INTEGER,
        endedBy TEXT,
        endReason TEXT CHECK (endReason IS NULL OR endReason IN ('done', 'model', 'replaced', 'stopped', 'removed'))
      );
      CREATE UNIQUE INDEX chat_skill_sessions_on ON chat_skill_sessions(threadId, startedBy) WHERE endedAt IS NULL`,
        },
        {
            version: 2,
            name: 'sessions per person',
            // Development databases that ran version 1 before it was changed
            // have one session per chat; it is per person and chat now. A fresh
            // database makes the same index again.
            up: `DROP INDEX IF EXISTS chat_skill_sessions_on;
      CREATE UNIQUE INDEX chat_skill_sessions_on ON chat_skill_sessions(threadId, startedBy) WHERE endedAt IS NULL`,
        },
        {
            version: 3,
            name: 'import provenance',
            up: 'ALTER TABLE chat_skill_revisions ADD COLUMN sourceMetadata TEXT',
        },
    ],
};
