import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Work cycles (CB-211): one person's message,
 * or a server's request, and every model round, tool and later step it
 * leads to, bounded by the limits it started with. The module's own
 * migrations (`schema_migrations` is per module), so they never collide
 * with the workspace's numbers (rooms take workspace 16).
 *
 * - `work_cycles`: a row per cycle, as `TurnContext` describes it: who
 *   started it, whose access and subscription it uses, who pays, and its
 *   use so far. `status` is `running` while one of its steps runs (the
 *   conversation's execution lease: one running cycle per conversation,
 *   by the partial unique index), `waiting` between steps (an approval
 *   waited for, a restart) and `ended`, with its `endReason`.
 *   `dispatchKey` is the message that started it: the same message never
 *   starts a second cycle, so a dispatch retried after a crash carries on
 *   the cycle it began, with what it used, instead of running again from
 *   nothing. `tokensReserved` holds the model requests in flight; a crash
 *   counts them as used. `costUsd` is NULL once any request did not report
 *   its cost (`costKnown` 0): then the cycle's spend is unknown.
 * - `work_cycle_submissions`: when each message reached a conversation,
 *   for its rate limit (the last minute's); pruned after an hour.
 */
export const cyclesSchema: SchemaSet = {
    id: MODULE_IDS.cycles,
    migrations: [
        {
            version: 1,
            name: 'work cycles',
            compatible:
                'Its unique indexes are on the tables it creates, which no older build reads or writes (CB-108).',
            up: `CREATE TABLE work_cycles(
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'private' CHECK(kind IN ('private','room')),
        dispatchKey TEXT,
        initiatorKind TEXT NOT NULL,
        initiatorId TEXT,
        actingUserId TEXT NOT NULL,
        dotId TEXT NOT NULL,
        dotOwnerId TEXT,
        billingKind TEXT CHECK(billingKind IN ('person','workspace')),
        billingUserId TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','waiting','ended')),
        runId TEXT,
        hop INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0,
        limits TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        elapsedMs INTEGER NOT NULL DEFAULT 0,
        stepStartedAt INTEGER,
        deadlineAt INTEGER,
        tokensReserved INTEGER NOT NULL DEFAULT 0,
        tokensUsed INTEGER NOT NULL DEFAULT 0,
        costUsd REAL,
        costKnown INTEGER NOT NULL DEFAULT 1,
        handoffs INTEGER NOT NULL DEFAULT 0,
        unstopped TEXT,
        endedAt INTEGER,
        endReason TEXT CHECK(endReason IN ('completed','failed','stopped','interrupted','deadline','tokens','handoffs','spend','expired')),
        updatedAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX work_cycles_lease ON work_cycles(conversationId) WHERE status = 'running';
      CREATE UNIQUE INDEX work_cycles_dispatch ON work_cycles(conversationId, dispatchKey) WHERE dispatchKey IS NOT NULL;
      CREATE INDEX work_cycles_conversation ON work_cycles(conversationId, startedAt);
      CREATE INDEX work_cycles_status ON work_cycles(status, updatedAt);
      CREATE TABLE work_cycle_submissions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversationId TEXT NOT NULL,
        actorId TEXT,
        at INTEGER NOT NULL);
      CREATE INDEX work_cycle_submissions_conversation ON work_cycle_submissions(conversationId, at);`,
        },
        {
            // CB-218: the Operations ETL copies cycles in the order they
            // started, a batch at a time, by this index rather than a scan.
            version: 2,
            name: 'cycles by start',
            up: 'CREATE INDEX work_cycles_started ON work_cycles(startedAt, id);',
        },
    ],
};
