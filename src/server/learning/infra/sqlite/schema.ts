import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, float, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { LearningDropReason } from '@socio/shared/learning';

import type { ContainerRevision, SkillFile } from '../../contract.js';

/**
 * Learning's tables (CB-110), as `learning/migrations.ts` makes them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth; tests/learning-repositories.test.ts holds these to them.
 */

export const learningEvidence = sqliteTable('learning_evidence', {
    threadId: str().primaryKey(),
    containerId: str().notNull(),
    dotId: str().notNull(),
    ownerId: str().notNull(),
    eligible: flag().notNull(),
    finishedAt: ms().notNull(),
});

export const learningCursors = sqliteTable('learning_cursors', {
    containerId: str().primaryKey(),
    analyzedThrough: ms().notNull(),
});

export const learningSkillRevisions = sqliteTable('learning_skill_revisions', {
    id: str().primaryKey(),
    containerId: str().notNull(),
    name: str().notNull(),
    revision: int().notNull(),
    description: str().notNull(),
    files: json<SkillFile[]>().notNull(),
    createdAt: ms().notNull(),
    createdBy: str().notNull(),
});

export const learningContainerRevisions = sqliteTable(
    'learning_container_revisions',
    {
        containerId: str().notNull(),
        revision: int().notNull(),
        skills: json<ContainerRevision['skills']>().notNull(),
        createdAt: ms().notNull(),
        createdBy: str().notNull(),
    },
    (t) => [primaryKey({ columns: [t.containerId, t.revision] })],
);

export const learningContainerPins = sqliteTable('learning_container_pins', {
    containerId: str().primaryKey(),
    revision: int().notNull(),
});

export const learningRuns = sqliteTable('learning_runs', {
    id: str().primaryKey(),
    containerId: str().notNull(),
    trigger: enumText(['threshold', 'schedule', 'manual', 'intent']).notNull(),
    status: enumText(['running', 'succeeded', 'failed', 'cancelled']).notNull(),
    startedAt: ms().notNull(),
    finishedAt: ms(),
    threads: int().notNull(),
    proposals: int().notNull(),
    dropped: int().notNull(),
    error: str(),
    startedBy: str(),
    dropReasons: json<Partial<Record<LearningDropReason, number>>>().notNull(),
    skipped: int().notNull(),
    inputTokens: int(),
    outputTokens: int(),
    costUsd: float(),
});

export const learningProposals = sqliteTable('learning_proposals', {
    id: str().primaryKey(),
    containerId: str().notNull(),
    runId: str().notNull(),
    name: str().notNull(),
    description: str().notNull(),
    skillMd: str().notNull(),
    rationale: str().notNull(),
    evidenceThreadIds: json<string[]>().notNull(),
    status: enumText(['pending', 'published', 'rejected']).notNull(),
    createdAt: ms().notNull(),
    reviewedBy: str(),
    reviewedAt: ms(),
    revisionId: str(),
});

export const learningTables = [
    learningEvidence,
    learningCursors,
    learningSkillRevisions,
    learningContainerRevisions,
    learningContainerPins,
    learningRuns,
    learningProposals,
];
