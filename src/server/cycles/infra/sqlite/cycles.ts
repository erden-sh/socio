import type { DatabaseSync } from 'node:sqlite';

import { and, asc, desc, eq, gt, gte, lt } from 'drizzle-orm';

import { writeSoon, type SqliteData } from '@socio/data/open';
import type { RunActor } from '@socio/shared/runs/run-trace';

import type { WorkCycle } from '../../contract.js';
import type { SubmissionRepository, WorkCyclePatch, WorkCycleRepository } from '../../domain/repositories.js';

import { workCycleSubmissions, workCycles } from './schema.js';

type Row = typeof workCycles.$inferSelect;
type Insert = typeof workCycles.$inferInsert;

/**
 * What the cycle repositories share: the connection's Drizzle handle,
 * whose node:sqlite queries run synchronously (`get`, `all`, `run`), in
 * the caller's transaction (`WorkCycles` runs each in `transact`).
 */
abstract class SqliteRepository {
    constructor(protected data: SqliteData) {}
    protected get db() {
        return this.data.uow.executor();
    }
}

const cycleOf = (row: Row): WorkCycle => ({
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    dispatchKey: row.dispatchKey,
    initiator: {
        kind: row.initiatorKind as RunActor['kind'],
        ...(row.initiatorId ? { id: row.initiatorId } : {}),
    },
    actingUserId: row.actingUserId,
    dotId: row.dotId,
    dotOwnerId: row.dotOwnerId,
    billing:
        row.billingKind === 'person' && row.billingUserId
            ? { kind: 'person', userId: row.billingUserId }
            : row.billingKind === 'workspace'
              ? { kind: 'workspace' }
              : null,
    status: row.status,
    runId: row.runId,
    hop: row.hop,
    steps: row.steps,
    limits: row.limits,
    startedAt: row.startedAt,
    elapsedMs: row.elapsedMs,
    stepStartedAt: row.stepStartedAt,
    deadlineAt: row.deadlineAt,
    tokensReserved: row.tokensReserved,
    tokensUsed: row.tokensUsed,
    costUsd: row.costUsd,
    costKnown: row.costKnown,
    handoffs: row.handoffs,
    unstopped: row.unstopped ?? [],
    endedAt: row.endedAt,
    endReason: row.endReason,
    updatedAt: row.updatedAt,
});

/** A domain patch as columns: the actor and billing split in two. */
function columns(patch: WorkCyclePatch): Partial<Insert> {
    const { initiator, billing, unstopped, ...rest } = patch;
    return {
        ...rest,
        ...(initiator ? { initiatorKind: initiator.kind, initiatorId: initiator.id ?? null } : {}),
        ...(billing !== undefined
            ? {
                  billingKind: billing?.kind ?? null,
                  billingUserId: billing?.kind === 'person' ? billing.userId : null,
              }
            : {}),
        ...(unstopped !== undefined ? { unstopped: unstopped.length ? unstopped : null } : {}),
    };
}

/** Work cycles (CB-211): the ledger of each message's work. */
export class SqliteWorkCycles extends SqliteRepository implements WorkCycleRepository {
    constructor(
        data: SqliteData,
        private connection: DatabaseSync,
    ) {
        super(data);
    }

    byId(id: string) {
        const row = this.db.select().from(workCycles).where(eq(workCycles.id, id)).get();
        return row && cycleOf(row);
    }

    byDispatch(conversationId: string, dispatchKey: string) {
        const row = this.db
            .select()
            .from(workCycles)
            .where(and(eq(workCycles.conversationId, conversationId), eq(workCycles.dispatchKey, dispatchKey)))
            .get();
        return row && cycleOf(row);
    }

    running(conversationId: string) {
        const row = this.db
            .select()
            .from(workCycles)
            .where(and(eq(workCycles.conversationId, conversationId), eq(workCycles.status, 'running')))
            .get();
        return row && cycleOf(row);
    }

    waiting(conversationId: string) {
        return this.db
            .select()
            .from(workCycles)
            .where(and(eq(workCycles.conversationId, conversationId), eq(workCycles.status, 'waiting')))
            .all()
            .map(cycleOf);
    }

    recent(conversationId: string, since: number, limit: number) {
        // By `work_cycles_conversation` (conversationId, startedAt).
        return this.db
            .select()
            .from(workCycles)
            .where(and(eq(workCycles.conversationId, conversationId), gte(workCycles.startedAt, since)))
            .orderBy(desc(workCycles.startedAt), desc(workCycles.id))
            .limit(limit)
            .all()
            .map(cycleOf);
    }

    allRunning() {
        return this.db.select().from(workCycles).where(eq(workCycles.status, 'running')).all().map(cycleOf);
    }

    insert(cycle: WorkCycle) {
        const { id, conversationId, startedAt, ...rest } = cycle;
        this.db
            .insert(workCycles)
            .values({
                id,
                conversationId,
                startedAt,
                ...(columns(rest) as Omit<Insert, 'id' | 'conversationId' | 'startedAt'>),
            })
            .run();
    }

    update(id: string, patch: WorkCyclePatch) {
        const result = this.db.update(workCycles).set(columns(patch)).where(eq(workCycles.id, id)).run();
        return Number(result.changes) > 0;
    }

    stamp(id: string, patch: WorkCyclePatch) {
        writeSoon(this.connection, 'record work cycle use', () => {
            this.update(id, patch);
        });
    }

    expireWaiting(before: number, now: number) {
        const result = this.db
            .update(workCycles)
            .set({
                status: 'ended',
                endReason: 'expired',
                endedAt: now,
                updatedAt: now,
            })
            .where(and(eq(workCycles.status, 'waiting'), lt(workCycles.updatedAt, before)))
            .run();
        return Number(result.changes);
    }
}

/** When messages reached each conversation, for its rate limit. */
export class SqliteSubmissions extends SqliteRepository implements SubmissionRepository {
    since(conversationId: string, after: number) {
        return this.db
            .select({ at: workCycleSubmissions.at })
            .from(workCycleSubmissions)
            .where(and(eq(workCycleSubmissions.conversationId, conversationId), gt(workCycleSubmissions.at, after)))
            .orderBy(asc(workCycleSubmissions.at))
            .all()
            .map((row) => row.at);
    }

    add(conversationId: string, actorId: string | null, at: number) {
        this.db.insert(workCycleSubmissions).values({ conversationId, actorId, at }).run();
    }

    prune(before: number) {
        const result = this.db.delete(workCycleSubmissions).where(lt(workCycleSubmissions.at, before)).run();
        return Number(result.changes);
    }
}
