import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';

import type {
    ApprovalRequest,
    ApprovalRequestFilter,
    ApprovalRequestRepository,
    ContinuationState,
    NewApprovalRequest,
} from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { approvalAutoDecisions, approvalRequests } from './schema.js';

type Row = typeof approvalRequests.$inferSelect;

/** A stored row as the domain reads it: its JSON fields parsed. */
const request = ({ payload, undoData, ...row }: Row): ApprovalRequest => ({
    ...row,
    payload: JSON.parse(payload) as unknown,
    undoData: undoData ? (JSON.parse(undoData) as unknown) : null,
});

/** Approval requests: the decision, outcome and continuation. */
export class SqliteRequests extends SqliteRepository implements ApprovalRequestRepository {
    async byId(id: string) {
        const row = await this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
        return row && request(row);
    }

    insert(input: NewApprovalRequest) {
        return this.write('request approval', async () => {
            await this.db.insert(approvalRequests).values({
                ...input,
                digest: input.digest ?? null,
                bindingId: input.bindingId ?? null,
                payload: JSON.stringify(input.payload ?? null),
                status: 'pending',
            });
        });
    }

    async countPending(input: { capabilities: readonly string[]; dotId?: string; bindingId?: string; now: number }) {
        if (!input.capabilities.length) {
            return 0;
        }
        const row = await this.db
            .select({ n: count() })
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.status, 'pending'),
                    gt(approvalRequests.expiresAt, input.now),
                    inArray(approvalRequests.capability, [...input.capabilities]),
                    input.dotId ? eq(approvalRequests.dotId, input.dotId) : undefined,
                    input.bindingId ? eq(approvalRequests.bindingId, input.bindingId) : undefined,
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    async bound(bindingId: string, digest: string, now: number) {
        const row = await this.db
            .select()
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.bindingId, bindingId),
                    eq(approvalRequests.digest, digest),
                    isNull(approvalRequests.consumedAt),
                    or(
                        and(eq(approvalRequests.status, 'pending'), gt(approvalRequests.expiresAt, now)),
                        eq(approvalRequests.status, 'approved'),
                    ),
                ),
            )
            .orderBy(desc(approvalRequests.createdAt))
            .get();
        return row && request(row);
    }

    async pendingBound(bindingIds: readonly string[]) {
        if (!bindingIds.length) {
            return [];
        }
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.bindingId, [...bindingIds])));
        return rows.map(request);
    }

    consume(id: string, binding: { digest: string; bindingId: string }, at: number) {
        // One statement decides it: a second consume, another
        // binding, another digest, a denied or expired request change nothing.
        return this.write('consume approval', async () => {
            const { changes } = await this.db
                .update(approvalRequests)
                .set({ consumedAt: at })
                .where(
                    and(
                        eq(approvalRequests.id, id),
                        eq(approvalRequests.digest, binding.digest),
                        eq(approvalRequests.bindingId, binding.bindingId),
                        isNull(approvalRequests.consumedAt),
                        eq(approvalRequests.status, 'approved'),
                    ),
                );
            return Number(changes) > 0;
        });
    }

    markOpened(id: string, at: number) {
        return this.write('record approval opened', async () => {
            await this.db
                .update(approvalRequests)
                .set({ openedAt: at })
                .where(and(eq(approvalRequests.id, id), isNull(approvalRequests.openedAt)));
        });
    }

    async pending(userId: string, dotId: string, capability: string) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.userId, userId),
                    eq(approvalRequests.dotId, dotId),
                    eq(approvalRequests.capability, capability),
                    eq(approvalRequests.status, 'pending'),
                ),
            )
            .orderBy(asc(approvalRequests.createdAt));
        return rows.map(request);
    }

    async failed(userId: string, dotId: string, capability: string) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.userId, userId),
                    eq(approvalRequests.dotId, dotId),
                    eq(approvalRequests.capability, capability),
                    eq(approvalRequests.status, 'failed'),
                ),
            )
            .orderBy(desc(approvalRequests.createdAt));
        return rows.map(request);
    }

    async overdue(now: number) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(and(eq(approvalRequests.status, 'pending'), lte(approvalRequests.expiresAt, now)));
        return rows.map(request);
    }

    async pendingOfDot(dotId: string) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(and(eq(approvalRequests.status, 'pending'), eq(approvalRequests.dotId, dotId)));
        return rows.map(request);
    }

    async list(userId: string, filter: ApprovalRequestFilter) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.userId, userId),
                    filter.auto
                        ? inArray(
                              approvalRequests.id,
                              this.db
                                  .select({ requestId: approvalAutoDecisions.requestId })
                                  .from(approvalAutoDecisions)
                                  .where(eq(approvalAutoDecisions.userId, userId)),
                          )
                        : undefined,
                    filter.status ? eq(approvalRequests.status, filter.status) : undefined,
                    filter.dotId ? eq(approvalRequests.dotId, filter.dotId) : undefined,
                ),
            )
            .orderBy(desc(approvalRequests.createdAt))
            .limit(filter.limit);
        return rows.map(request);
    }

    async recentDecided(userId: string, capability: string, exceptId: string, limit: number) {
        return this.db
            .select({
                summary: approvalRequests.summary,
                status: approvalRequests.status,
                decidedVia: approvalRequests.decidedVia,
            })
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.userId, userId),
                    eq(approvalRequests.capability, capability),
                    ne(approvalRequests.id, exceptId),
                    ne(approvalRequests.status, 'pending'),
                ),
            )
            .orderBy(desc(approvalRequests.createdAt))
            .limit(limit);
    }

    decide(
        id: string,
        decision: {
            status: 'approved' | 'denied';
            via: 'user' | 'bypass' | 'auto';
            at: number;
            deciding?: boolean;
        },
    ) {
        return this.write('decide approval', async () => {
            const { changes } = await this.db
                .update(approvalRequests)
                .set({
                    status: decision.status,
                    decidedVia: decision.via,
                    decidedAt: decision.at,
                    ...(decision.deciding
                        ? {
                              continuation: sql`CASE WHEN ${approvalRequests.threadId} IS NULL THEN ${approvalRequests.continuation} ELSE 'deciding' END`,
                          }
                        : {}),
                })
                .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')));
            return Number(changes) > 0;
        });
    }

    expire(id: string, at: number, outcome?: string) {
        return this.write('expire approval', async () => {
            const { changes } = await this.db
                .update(approvalRequests)
                .set({
                    status: 'expired',
                    decidedVia: 'expiry',
                    decidedAt: at,
                    ...(outcome === undefined ? {} : { outcome }),
                })
                .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')));
            return Number(changes) > 0;
        });
    }

    recordExecution(id: string, outcome: string, undoData: unknown) {
        return this.write('record approval outcome', async () => {
            await this.db
                .update(approvalRequests)
                .set({
                    outcome,
                    undoData: undoData === undefined ? null : JSON.stringify(undoData),
                })
                .where(eq(approvalRequests.id, id));
        });
    }

    recordOutcome(id: string, outcome: string) {
        return this.write('record approval outcome', async () => {
            await this.db.update(approvalRequests).set({ outcome }).where(eq(approvalRequests.id, id));
        });
    }

    recordFailure(id: string, outcome: string) {
        return this.write('record approval failure', async () => {
            await this.db
                .update(approvalRequests)
                .set({ status: 'failed', outcome })
                .where(eq(approvalRequests.id, id));
        });
    }

    setContinuation(
        ids: readonly string[],
        state: ContinuationState,
        options: { continuationId?: string; detail?: string | null } = {},
    ) {
        return this.write('record approval continuation', async () => {
            if (!ids.length) {
                return;
            }
            await this.db
                .update(approvalRequests)
                .set({
                    continuation: state,
                    ...(options.continuationId === undefined ? {} : { continuationId: options.continuationId }),
                    ...(options.detail === undefined ? {} : { continuationDetail: options.detail }),
                })
                .where(inArray(approvalRequests.id, [...ids]));
        });
    }

    endRunning(detail: string) {
        return this.write('end approval continuations', async () => {
            await this.db
                .update(approvalRequests)
                .set({ continuation: 'failed', continuationDetail: detail })
                .where(eq(approvalRequests.continuation, 'running'));
            await this.db
                .update(approvalRequests)
                .set({ continuation: 'waiting' })
                .where(eq(approvalRequests.continuation, 'deciding'));
        });
    }

    async waitingIn(threadId: string) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(and(eq(approvalRequests.threadId, threadId), eq(approvalRequests.continuation, 'waiting')))
            .orderBy(asc(approvalRequests.createdAt), insertionOrder(approvalRequests));
        return rows.map(request);
    }

    async waitingThreads() {
        const rows = await this.db
            .selectDistinct({ threadId: approvalRequests.threadId })
            .from(approvalRequests)
            .where(and(eq(approvalRequests.continuation, 'waiting'), isNotNull(approvalRequests.threadId)));
        return rows.map((row) => row.threadId!);
    }

    async outstandingInRun(threadId: string, runId: string, exceptId: string, now: number) {
        const row = await this.db
            .select({ n: count() })
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.threadId, threadId),
                    eq(approvalRequests.runId, runId),
                    ne(approvalRequests.id, exceptId),
                    or(
                        and(eq(approvalRequests.status, 'pending'), gt(approvalRequests.expiresAt, now)),
                        eq(approvalRequests.continuation, 'deciding'),
                    ),
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    async awaitingInRun(threadId: string, runId: string, now: number) {
        const row = await this.db
            .select({ n: count() })
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.threadId, threadId),
                    eq(approvalRequests.runId, runId),
                    or(
                        and(eq(approvalRequests.status, 'pending'), gt(approvalRequests.expiresAt, now)),
                        inArray(approvalRequests.continuation, ['waiting', 'deciding']),
                    ),
                ),
            )
            .get();
        return (row?.n ?? 0) > 0;
    }

    async pendingIn(threadId: string, userId?: string) {
        const rows = await this.db
            .select()
            .from(approvalRequests)
            .where(
                and(
                    eq(approvalRequests.threadId, threadId),
                    userId === undefined ? undefined : eq(approvalRequests.userId, userId),
                    eq(approvalRequests.status, 'pending'),
                ),
            )
            .orderBy(asc(approvalRequests.createdAt));
        return rows.map(request);
    }
}
