import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';

import type { DotRequestRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { dotRequestNotices, dotRequestRequesters, dotRequests } from './schema.js';

/** Dot requests: the key, who asked, and the notices once closed. */
export class SqliteDotRequests extends SqliteRepository implements DotRequestRepository {
    async capability(issueId: string) {
        return (
            await this.db
                .select({ capability: dotRequests.capability })
                .from(dotRequests)
                .where(eq(dotRequests.issueId, issueId))
                .get()
        )?.capability;
    }

    insert(request: { issueId: string; key: string; capability: string; createdAt: number }) {
        return this.write('file socio request', async () => {
            await this.db.insert(dotRequests).values(request);
        });
    }

    async hasRequester(issueId: string, dotId: string, userId: string) {
        return !!(await this.db
            .select({ id: dotRequestRequesters.id })
            .from(dotRequestRequesters)
            .where(
                and(
                    eq(dotRequestRequesters.issueId, issueId),
                    eq(dotRequestRequesters.dotId, dotId),
                    eq(dotRequestRequesters.userId, userId),
                ),
            )
            .get());
    }

    addRequester(requester: {
        id: string;
        issueId: string;
        dotId: string;
        userId: string;
        why: string;
        example: string;
        createdAt: number;
    }) {
        return this.write('add socio requester', async () => {
            await this.db.insert(dotRequestRequesters).values(requester);
        });
    }

    async demandOf(issueId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(dotRequestRequesters)
            .where(eq(dotRequestRequesters.issueId, issueId))
            .get();
        return row?.n ?? 0;
    }

    async requesters(issueId: string) {
        return this.db
            .select({
                dotId: dotRequestRequesters.dotId,
                userId: dotRequestRequesters.userId,
                createdAt: dotRequestRequesters.createdAt,
            })
            .from(dotRequestRequesters)
            .where(eq(dotRequestRequesters.issueId, issueId))
            .orderBy(asc(dotRequestRequesters.createdAt), insertionOrder(dotRequestRequesters));
    }

    async countSince(by: { dotId: string } | { userId: string }, since: number) {
        const row = await this.db
            .select({ n: count() })
            .from(dotRequestRequesters)
            .where(
                and(
                    'dotId' in by
                        ? eq(dotRequestRequesters.dotId, by.dotId)
                        : eq(dotRequestRequesters.userId, by.userId),
                    gt(dotRequestRequesters.createdAt, since),
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    markAnnounced(issueId: string, dotId: string, userId: string, now: number) {
        return this.write('announce socio request', async () => {
            await this.db
                .update(dotRequestRequesters)
                .set({ announcedAt: now })
                .where(
                    and(
                        eq(dotRequestRequesters.issueId, issueId),
                        eq(dotRequestRequesters.dotId, dotId),
                        eq(dotRequestRequesters.userId, userId),
                    ),
                );
        });
    }

    resetAnnounced(issueId: string) {
        return this.write('reset socio request announcements', async () => {
            await this.db
                .update(dotRequestRequesters)
                .set({ announcedAt: null })
                .where(eq(dotRequestRequesters.issueId, issueId));
        });
    }

    async dotsFor(issueId: string, userId: string) {
        // Each Dot once, by when it first asked.
        const rows = await this.db
            .select({ dotId: dotRequestRequesters.dotId })
            .from(dotRequestRequesters)
            .where(and(eq(dotRequestRequesters.issueId, issueId), eq(dotRequestRequesters.userId, userId)))
            .orderBy(asc(dotRequestRequesters.createdAt), insertionOrder(dotRequestRequesters));
        return [...new Set(rows.map((row) => row.dotId))];
    }

    addNotice(notice: {
        id: string;
        issueId: string;
        userId: string;
        status: 'done' | 'wont_fix';
        resolution: string | null;
        createdAt: number;
    }) {
        return this.write('add socio request notice', async () => {
            await this.db.insert(dotRequestNotices).values(notice);
        });
    }

    markSeen(userId: string, id: string, now: number) {
        return this.write('see socio request notice', async () => {
            const { changes } = await this.db
                .update(dotRequestNotices)
                .set({ seenAt: now })
                .where(
                    and(
                        eq(dotRequestNotices.id, id),
                        eq(dotRequestNotices.userId, userId),
                        isNull(dotRequestNotices.seenAt),
                    ),
                )
                .run();
            return Number(changes) > 0;
        });
    }
}
