import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, float, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import { CONVERSATION_KINDS } from '@socio/shared/rooms/rooms';
import type { RoomLimits } from '@socio/shared/rooms/rooms';

import { CYCLE_END_REASONS, CYCLE_STATUSES } from '../../contract.js';

/**
 * The cycle tables (CB-211), as `cycles/migrations.ts` makes them: the
 * typed mirror the repositories query. The migrations stay the source of
 * truth; tests/cycles.test.ts holds these to them.
 */

export const workCycles = sqliteTable('work_cycles', {
    id: id().primaryKey(),
    conversationId: str().notNull(),
    kind: enumText(CONVERSATION_KINDS).notNull(),
    dispatchKey: str(),
    initiatorKind: str().notNull(),
    initiatorId: str(),
    actingUserId: str().notNull(),
    dotId: str().notNull(),
    dotOwnerId: str(),
    billingKind: enumText(['person', 'workspace'] as const),
    billingUserId: str(),
    status: enumText(CYCLE_STATUSES).notNull(),
    runId: str(),
    hop: int().notNull(),
    steps: int().notNull(),
    limits: json<RoomLimits>().notNull(),
    startedAt: ms().notNull(),
    elapsedMs: int().notNull(),
    stepStartedAt: ms(),
    deadlineAt: ms(),
    tokensReserved: int().notNull(),
    tokensUsed: int().notNull(),
    costUsd: float(),
    costKnown: flag().notNull(),
    handoffs: int().notNull(),
    /** JSON array of tool names, or NULL. */
    unstopped: json<string[]>(),
    endedAt: ms(),
    endReason: enumText(CYCLE_END_REASONS),
    updatedAt: ms().notNull(),
});

export const workCycleSubmissions = sqliteTable('work_cycle_submissions', {
    id: int().primaryKey({ autoIncrement: true }),
    conversationId: str().notNull(),
    actorId: str(),
    at: ms().notNull(),
});

export const cycleTables = [workCycles, workCycleSubmissions];
