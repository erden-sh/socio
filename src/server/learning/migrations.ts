import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Learning: run evidence and cursors, skill and container revisions with
 * their pins, analysis runs and proposals. The baseline is the former DDL of
 * the EvidenceLedger, SkillStore and LearningAnalysis constructors.
 */
export const learningSchema: SchemaSet = {
    id: MODULE_IDS.learning,
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS learning_evidence(threadId TEXT PRIMARY KEY, containerId TEXT NOT NULL, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, eligible INTEGER NOT NULL, finishedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_evidence_container ON learning_evidence(containerId, eligible, finishedAt);
      CREATE TABLE IF NOT EXISTS learning_cursors(containerId TEXT PRIMARY KEY, analyzedThrough INTEGER NOT NULL);`);
                db.exec(`CREATE TABLE IF NOT EXISTS learning_skill_revisions(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, description TEXT NOT NULL, files TEXT NOT NULL, createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL, UNIQUE(containerId, name, revision));
      CREATE TABLE IF NOT EXISTS learning_container_revisions(containerId TEXT NOT NULL, revision INTEGER NOT NULL, skills TEXT NOT NULL, createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL, PRIMARY KEY (containerId, revision));
      CREATE TABLE IF NOT EXISTS learning_container_pins(containerId TEXT PRIMARY KEY, revision INTEGER NOT NULL);`);
                db.exec(`CREATE TABLE IF NOT EXISTS learning_runs(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, threads INTEGER NOT NULL, proposals INTEGER NOT NULL, dropped INTEGER NOT NULL, error TEXT, startedBy TEXT);
      CREATE TABLE IF NOT EXISTS learning_proposals(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, runId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, skillMd TEXT NOT NULL, rationale TEXT NOT NULL, evidenceThreadIds TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, reviewedBy TEXT, reviewedAt INTEGER, revisionId TEXT);`);
            },
        },
        {
            version: 2,
            name: 'proposals by container',
            // The Learning page reads a container's proposals a page at a time,
            // newest first (createdAt, then id).
            up: 'CREATE INDEX IF NOT EXISTS learning_proposals_container ON learning_proposals(containerId, createdAt, id)',
        },
        {
            version: 3,
            name: 'run drop reasons',
            // A run's dropped tool calls by reason, as JSON: {"rejected": 2, ...}.
            up: "ALTER TABLE learning_runs ADD COLUMN dropReasons TEXT NOT NULL DEFAULT '{}'",
        },
        {
            version: 4,
            name: 'run triage and cost',
            // Learning on the classification seam (CB-200), expand only: the
            // conversations triage kept from a run, and what the run's own
            // analysis calls used, as the model reported it (null: not said).
            up: `ALTER TABLE learning_runs ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE learning_runs ADD COLUMN inputTokens INTEGER;
      ALTER TABLE learning_runs ADD COLUMN outputTokens INTEGER;
      ALTER TABLE learning_runs ADD COLUMN costUsd REAL;`,
        },
    ],
};
