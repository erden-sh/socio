import type { Migration } from '@socio/data/migrate';

/**
 * Version 5 of the gateway module's schema (schema.ts, CB-239), expand
 * only. Nothing here holds a token, a prompt or an answer.
 *
 * - `gateway_models.dispatch`: an admin lets the dispatch worker's
 *   executors use this model through the gateway. Off for every
 *   model already listed; a release without the column leaves it as it is
 *   when it saves a model (its upsert names only its own columns).
 * - `gateway_options`: switches of Settings → Coding over an environment
 *   default, a missing row being the default: today only `personalPlans`
 *   (`CODING_PERSONAL_PLANS`). No CHECK on the key, so a later switch is a
 *   new row, not a table rebuild.
 * - `gateway_dispatch_credentials`: one gateway credential per dispatch run,
 *   by hash, so either runtime of a deploy accepts it. It works while its
 *   row is there and unexpired and the run is still running; the row goes
 *   when the run ends.
 * - `coding_sessions.plan`: the personal plan kind a session runs on
 *   (`byo-chatgpt`), or null for an operator's shared backend.
 *
 * Dispatch was removed (CB-325): nothing reads or writes
 * `gateway_models.dispatch` or `gateway_dispatch_credentials` any more.
 * They stay, and this migration stays as it was (it is checksummed), until
 * a later contract migration drops them after a release without dispatch.
 */
export const gatewayG5Migrations: readonly Migration[] = [
    {
        version: 5,
        name: 'dispatch through the gateway, personal plans for coding',
        phase: 'expand',
        up: `ALTER TABLE gateway_models ADD COLUMN dispatch INTEGER NOT NULL DEFAULT 0 CHECK(dispatch IN (0, 1));
      CREATE TABLE gateway_options(
        key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
        value TEXT NOT NULL CHECK(length(value) <= 4000),
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL);
      CREATE TABLE gateway_dispatch_credentials(
        hash TEXT PRIMARY KEY CHECK(length(hash) = 64),
        runId TEXT NOT NULL CHECK(length(runId) BETWEEN 1 AND 100),
        issuedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        CHECK(expiresAt > issuedAt));
      CREATE INDEX gateway_dispatch_credentials_run ON gateway_dispatch_credentials(runId);
      ALTER TABLE coding_sessions ADD COLUMN plan TEXT;`,
    },
];
