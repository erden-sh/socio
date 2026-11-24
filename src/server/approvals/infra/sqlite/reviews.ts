import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';

import type { AutoReview, AutoReviewRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { approvalAutoDecisions } from './schema.js';

/** Auto reviews: one per review of a request, and its undo. */
export class SqliteReviews extends SqliteRepository implements AutoReviewRepository {
    insert(review: Omit<AutoReview, 'undoneAt' | 'undoOutcome'>) {
        return this.write('record auto review', async () => {
            await this.db.insert(approvalAutoDecisions).values(review);
        });
    }

    async latest(requestId: string) {
        return this.db
            .select()
            .from(approvalAutoDecisions)
            .where(eq(approvalAutoDecisions.requestId, requestId))
            .orderBy(desc(approvalAutoDecisions.createdAt), desc(insertionOrder(approvalAutoDecisions)))
            .limit(1)
            .get();
    }

    async approvedSince(dotId: string, since: number) {
        const row = await this.db
            .select({ n: count() })
            .from(approvalAutoDecisions)
            .where(
                and(
                    eq(approvalAutoDecisions.dotId, dotId),
                    eq(approvalAutoDecisions.verdict, 'approved'),
                    gt(approvalAutoDecisions.createdAt, since),
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    claimUndo(id: string, now: number) {
        return this.write('undo auto approval', async () => {
            const { changes } = await this.db
                .update(approvalAutoDecisions)
                .set({ undoneAt: now })
                .where(and(eq(approvalAutoDecisions.id, id), isNull(approvalAutoDecisions.undoneAt)));
            return Number(changes) > 0;
        });
    }

    recordUndo(id: string, outcome: string) {
        return this.write('record undo', async () => {
            await this.db
                .update(approvalAutoDecisions)
                .set({ undoOutcome: outcome })
                .where(eq(approvalAutoDecisions.id, id));
        });
    }

    releaseUndo(id: string, outcome: string) {
        return this.write('record undo failure', async () => {
            await this.db
                .update(approvalAutoDecisions)
                .set({ undoneAt: null, undoOutcome: outcome })
                .where(eq(approvalAutoDecisions.id, id));
        });
    }
}
