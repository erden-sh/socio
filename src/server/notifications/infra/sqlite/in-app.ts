import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { InAppNoticeRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { notificationInApp } from './schema.js';

/** Toasts for people in the app; read on every `/api/state` build. */
export class SqliteInAppNotices extends SqliteRepository implements InAppNoticeRepository {
    private unseenQuery = this.data.uow
        .executor()
        .select({
            id: notificationInApp.id,
            title: notificationInApp.title,
            body: notificationInApp.body,
            link: notificationInApp.link,
            createdAt: notificationInApp.createdAt,
        })
        .from(notificationInApp)
        .where(
            and(
                eq(notificationInApp.userId, sql.placeholder('userId')),
                isNull(notificationInApp.seenAt),
                gt(notificationInApp.createdAt, sql.placeholder('since')),
            ),
        )
        .orderBy(asc(notificationInApp.createdAt))
        .limit(sql.placeholder('limit'))
        .prepare();

    insert(notice: {
        id: string;
        userId: string;
        notificationId: string;
        title: string;
        body: string;
        link: string;
        createdAt: number;
    }) {
        return this.write('show notification in app', async () => {
            await this.db.insert(notificationInApp).values(notice);
        });
    }

    async unseen(userId: string, since: number, limit: number) {
        this.data.uow.executor();
        return this.unseenQuery.all({ userId, since, limit });
    }

    markSeen(userId: string, ids: readonly string[], now: number) {
        return this.write('mark notices seen', async () => {
            if (!ids.length) {
                return;
            }
            await this.db
                .update(notificationInApp)
                .set({ seenAt: now })
                .where(
                    and(
                        inArray(notificationInApp.id, [...ids]),
                        eq(notificationInApp.userId, userId),
                        isNull(notificationInApp.seenAt),
                    ),
                );
        });
    }

    removeBefore(before: number) {
        return this.write('prune notices', async () => {
            await this.db.delete(notificationInApp).where(lt(notificationInApp.createdAt, before));
        });
    }
}
