import { and, asc, desc, eq, max, sql, type SQL } from 'drizzle-orm';

import type { Goal, GoalCommentRecord, GoalRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { goalComments, goals } from './schema.js';

/** Goals and their comments (CB-135), on the shared SQLite connection. */
export class SqliteGoals extends SqliteRepository implements GoalRepository {
    async get(id: string): Promise<Goal | undefined> {
        return this.db.select().from(goals).where(eq(goals.id, id)).get();
    }

    private newest(...where: SQL[]) {
        return this.db
            .select()
            .from(goals)
            .where(and(...where))
            .orderBy(desc(goals.createdAt))
            .all();
    }

    async list(userId: string, dotId?: string) {
        return this.newest(eq(goals.userId, userId), ...(dotId ? [eq(goals.dotId, dotId)] : []));
    }

    async forDot(dotId: string) {
        return this.newest(eq(goals.dotId, dotId));
    }

    async lastOfDot(dotId: string) {
        const row = await this.db
            .select({ at: max(goals.createdAt) })
            .from(goals)
            .where(eq(goals.dotId, dotId))
            .get();
        return row?.at ?? null;
    }

    async bySchedule(scheduleId: string) {
        return this.db.select().from(goals).where(eq(goals.scheduleId, scheduleId)).get();
    }

    insert(goal: Omit<Goal, 'closedAt'>) {
        return this.write('add goal', async () => {
            await this.db.insert(goals).values({ ...goal, closedAt: null });
        });
    }

    update(id: string, patch: { progress?: string; status?: 'done' | 'cancelled' }, now: number) {
        return this.write('update goal', async () => {
            await this.db
                .update(goals)
                .set({
                    progress: sql`COALESCE(${patch.progress || null}, ${goals.progress})`,
                    status: sql`COALESCE(${patch.status ?? null}, ${goals.status})`,
                    updatedAt: now,
                    closedAt: patch.status ? now : null,
                })
                .where(eq(goals.id, id));
        });
    }

    async comments(goalId: string): Promise<GoalCommentRecord[]> {
        return this.db
            .select()
            .from(goalComments)
            .where(eq(goalComments.goalId, goalId))
            .orderBy(asc(goalComments.createdAt), asc(insertionOrder(goalComments)))
            .all();
    }

    comment(comment: GoalCommentRecord) {
        return this.write('comment on goal', async () => {
            await this.db.insert(goalComments).values(comment);
        });
    }
}
