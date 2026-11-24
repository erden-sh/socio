import { and, eq, lte } from 'drizzle-orm';

import type { PageThreadKey, PageThreadRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { pageThreads, pageThreads as t } from './schema.js';

const keyed = ({ pageId, dotId, userId }: PageThreadKey) =>
    and(eq(t.pageId, pageId), eq(t.dotId, dotId), eq(t.userId, userId));

/** Page conversations: one per page, socio and person. */
export class SqlitePageThreads extends SqliteRepository implements PageThreadRepository {
    reserve(key: PageThreadKey, threadId: string, leaseUntil: number, now: number) {
        return this.write('reserve page conversation', async () => {
            await this.db
                .insert(t)
                .values({ ...key, threadId, ready: false, leaseUntil: 0 })
                .onConflictDoNothing();
            const { changes } = await this.db
                .update(t)
                .set({ leaseUntil })
                .where(and(keyed(key), eq(t.ready, false), lte(t.leaseUntil, now)));
            return Number(changes) > 0;
        });
    }

    finish(key: PageThreadKey) {
        return this.write('finish page conversation', async () => {
            await this.db.update(t).set({ ready: true }).where(keyed(key));
        });
    }

    release(key: PageThreadKey) {
        return this.write('release page conversation', async () => {
            await this.db
                .update(t)
                .set({ leaseUntil: 0 })
                .where(and(keyed(key), eq(t.ready, false)));
        });
    }

    removeForPage(pageId: string) {
        return this.write('unlink page conversations', async () => {
            await this.db.delete(pageThreads).where(eq(t.pageId, pageId));
        });
    }
}
