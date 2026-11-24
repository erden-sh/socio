import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The classification seam (CB-198).
 * Version 1:
 * - `classify_labels`: every label given to a subject (a failed turn, or
 *   one of its tool calls: `idx` is its place in the trace, -1 for the
 *   turn), append-only; the newest of a subject wins. `source` is `admin`
 *   (a relabel in Reliability: always applied, and the golden set) or
 *   `model` (with its provider, version and confidence; `applied` when it
 *   was sure enough and its version had passed an evaluation). `input` is
 *   the scrubbed text it was given, at most 300 characters, so the golden
 *   set can be evaluated again without reading the turns.
 *   `classify_labels.seq` is the analytics ETL's watermark.
 * - `classify_calls`: every model call, labeling or evaluation, with its
 *   outcome, tokens and cost (null: the provider didn't say).
 * - `classify_evals`: each evaluation of a provider version against the
 *   golden set, with its report.
 * - `classify_cursors`: how far each use's labeling has read the turns.
 */
export const classifySchema: SchemaSet = {
    id: MODULE_IDS.classify,
    migrations: [
        {
            version: 1,
            name: 'labels, calls and evaluations',
            up: `CREATE TABLE classify_labels(seq INTEGER PRIMARY KEY AUTOINCREMENT, use TEXT NOT NULL, labelsVersion INTEGER NOT NULL, runId TEXT NOT NULL, idx INTEGER NOT NULL CHECK(idx >= -1), label TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('admin','model')), provider TEXT, version TEXT, confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1), applied INTEGER NOT NULL CHECK(applied IN (0,1)), input TEXT NOT NULL CHECK(length(input) <= 4000), actorId TEXT, at INTEGER NOT NULL, CHECK((source = 'admin') = (provider IS NULL)));
      CREATE INDEX classify_labels_subject ON classify_labels(use, runId, idx, seq);
      CREATE INDEX classify_labels_golden ON classify_labels(use, source, labelsVersion, seq);
      CREATE TABLE classify_calls(id TEXT PRIMARY KEY, at INTEGER NOT NULL, use TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('label','eval')), provider TEXT NOT NULL, version TEXT NOT NULL, subject TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('ok','invalid','error')), answer TEXT, confidence REAL, inputTokens INTEGER, outputTokens INTEGER, costUsd REAL, durationMs INTEGER NOT NULL);
      CREATE INDEX classify_calls_time ON classify_calls(use, purpose, at);
      CREATE INDEX classify_calls_subject ON classify_calls(use, subject);
      CREATE TABLE classify_evals(id TEXT PRIMARY KEY, use TEXT NOT NULL, provider TEXT NOT NULL, version TEXT NOT NULL, labelsVersion INTEGER NOT NULL, threshold REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','done','failed')), passed INTEGER NOT NULL DEFAULT 0 CHECK(passed IN (0,1)), startedAt INTEGER NOT NULL, finishedAt INTEGER, startedBy TEXT, report TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report)));
      CREATE INDEX classify_evals_version ON classify_evals(use, provider, version, labelsVersion, startedAt);
      CREATE TABLE classify_cursors(use TEXT PRIMARY KEY, cursor TEXT NOT NULL);`,
        },
    ],
};
