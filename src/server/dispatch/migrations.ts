import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Dispatch was removed (CB-325); only its migrations stay, so databases
 * that ran them keep starting (boot refuses migrations of a module it
 * doesn't list) and none is rewritten. No code reads or writes the runs
 * and events any more. A later contract migration drops these tables, once
 * a release without dispatch has shipped. `dispatch_settings` still holds
 * the GitHub App's `github.*` rows (`github/store.ts`): that migration must
 * move them first. Never edit the migrations below: they are checksummed.
 *
 * Dispatch runs, their append-only event log and the module's switches
 * (`paused`). New in release 2, so version 1 is a plain migration.
 * Version 2: the credential kind and runs whose cost is unknown
 * (subscription usage), which `costUsd` (0 there) can't say.
 * Version 3 (CB-29): `batchId`, set on runs queued together by a batch
 * dispatch, which holds a run until the runs of its blockers in the same
 * batch have succeeded.
 */
export const dispatchSchema: SchemaSet = {
    id: MODULE_IDS.dispatch,
    migrations: [
        {
            version: 1,
            name: 'runs and events',
            up: `CREATE TABLE dispatch_runs(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, executor TEXT NOT NULL, model TEXT, dotId TEXT, threadId TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')), requestedBy TEXT NOT NULL, createdAt INTEGER NOT NULL, startedAt INTEGER, finishedAt INTEGER, budgetUsd REAL NOT NULL, timeLimitMs INTEGER NOT NULL, costUsd REAL NOT NULL DEFAULT 0, inputTokens INTEGER, outputTokens INTEGER, issueStatusBefore TEXT, summary TEXT, error TEXT, errorDetail TEXT, result TEXT);
      CREATE INDEX dispatch_runs_issue ON dispatch_runs(issueId, createdAt);
      CREATE INDEX dispatch_runs_status ON dispatch_runs(status, createdAt);
      CREATE INDEX dispatch_runs_thread ON dispatch_runs(threadId);
      CREATE TABLE dispatch_run_events(runId TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('status','message','tool','log','usage','error')), text TEXT NOT NULL, PRIMARY KEY(runId, seq));
      CREATE TABLE dispatch_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
        },
        {
            version: 2,
            name: 'auth mode and unknown cost',
            up: `ALTER TABLE dispatch_runs ADD COLUMN authMode TEXT;
      ALTER TABLE dispatch_runs ADD COLUMN costUnknown INTEGER NOT NULL DEFAULT 0;`,
        },
        {
            version: 3,
            name: 'batches',
            up: `ALTER TABLE dispatch_runs ADD COLUMN batchId TEXT CHECK(batchId IS NULL OR length(batchId) > 0);
      CREATE INDEX dispatch_runs_batch ON dispatch_runs(batchId) WHERE batchId IS NOT NULL;`,
        },
    ],
};
