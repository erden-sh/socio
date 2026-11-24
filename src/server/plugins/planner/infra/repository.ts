import { and, asc, eq, gte, lte } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';
import type { PostStatus, ReplyStatus } from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

import { plannedPosts, plannerVoice, replyQueue } from './schema.js';

type PostInsert = typeof plannedPosts.$inferInsert;
type ReplyInsert = typeof replyQueue.$inferInsert;

/** The planner's rows. Replicas of the plugin service share this database. */
export class SqlitePlanner {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    private write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }

    posts(filter: { from?: number; to?: number; status?: PostStatus } = {}) {
        const where = and(
            filter.from !== undefined ? gte(plannedPosts.plannedAt, filter.from) : undefined,
            filter.to !== undefined ? lte(plannedPosts.plannedAt, filter.to) : undefined,
            filter.status ? eq(plannedPosts.status, filter.status) : undefined,
        );
        return this.db.select().from(plannedPosts).where(where).orderBy(asc(plannedPosts.plannedAt)).all();
    }

    post(id: string) {
        return this.db.select().from(plannedPosts).where(eq(plannedPosts.id, id)).get();
    }

    insertPost(row: PostInsert) {
        return this.write('create planned post', async () => {
            await this.db.insert(plannedPosts).values(row);
        });
    }

    updatePost(
        id: string,
        patch: Partial<
            Pick<PostInsert, 'status' | 'account' | 'plannedAt' | 'topic' | 'notes' | 'parts' | 'updatedAt'>
        >,
    ) {
        return this.write('update planned post', async () => {
            await this.db.update(plannedPosts).set(patch).where(eq(plannedPosts.id, id));
        });
    }

    replies(status?: ReplyStatus) {
        return this.db
            .select()
            .from(replyQueue)
            .where(status ? eq(replyQueue.status, status) : undefined)
            .orderBy(asc(replyQueue.createdAt))
            .all();
    }

    reply(id: string) {
        return this.db.select().from(replyQueue).where(eq(replyQueue.id, id)).get();
    }

    insertReply(row: ReplyInsert) {
        return this.write('create reply item', async () => {
            await this.db.insert(replyQueue).values(row);
        });
    }

    updateReply(id: string, patch: Partial<Pick<ReplyInsert, 'status' | 'draft' | 'why' | 'excerpt' | 'updatedAt'>>) {
        return this.write('update reply item', async () => {
            await this.db.update(replyQueue).set(patch).where(eq(replyQueue.id, id));
        });
    }

    async voice() {
        return (
            (await this.db.select().from(plannerVoice).where(eq(plannerVoice.id, 'voice')).get()) ?? {
                id: 'voice',
                notes: '',
                updatedAt: 0,
            }
        );
    }

    setVoice(notes: string) {
        return this.write('save voice notes', async () => {
            await this.db
                .insert(plannerVoice)
                .values({ id: 'voice', notes, updatedAt: Date.now() })
                .onConflictDoUpdate({
                    target: plannerVoice.id,
                    set: { notes, updatedAt: Date.now() },
                });
        });
    }
}

export type { ThreadPart };
