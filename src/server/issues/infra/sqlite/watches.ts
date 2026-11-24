import { and, asc, count, desc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';

import type { IssueStatus } from '@socio/shared/issues/issue-types';

import type { IssueWatchSource } from '../../contract.js';
import type {
    IssueWatchMember,
    IssueWatchOutbox,
    IssueWatchRepository,
    IssueWatchRow,
} from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import {
    issueEvents,
    issueWatches as watches,
    issueWatchMembers as members,
    issueWatchOutbox as outbox,
} from './schema.js';

export class SqliteIssueWatches extends SqliteRepository implements IssueWatchRepository {
    insert(watch: IssueWatchRow, rows: IssueWatchMember[]) {
        return this.write('create issue subscription', async () => {
            await this.db.insert(watches).values(watch);
            await this.db.insert(members).values(rows.map((row) => ({ ...row, watchId: watch.id })));
        });
    }
    async activeDuplicate(userId: string, fingerprint: string) {
        return this.db
            .select()
            .from(watches)
            .where(
                and(
                    eq(watches.userId, userId),
                    eq(watches.fingerprint, fingerprint),
                    inArray(watches.state, ['watching', 'ready']),
                ),
            )
            .get();
    }
    async activeCount(userId: string) {
        return (await this.db
            .select({ n: count() })
            .from(watches)
            .where(and(eq(watches.userId, userId), inArray(watches.state, ['watching', 'ready'])))
            .get())!.n;
    }
    forUser(userId: string, limit: number, offset: number) {
        return this.db
            .select()
            .from(watches)
            .where(eq(watches.userId, userId))
            .orderBy(desc(watches.createdAt), desc(watches.id))
            .limit(limit)
            .offset(offset);
    }
    async owned(userId: string, id: string) {
        return this.db
            .select()
            .from(watches)
            .where(and(eq(watches.userId, userId), eq(watches.id, id)))
            .get();
    }
    members(id: string) {
        return this.db
            .select({
                issueId: members.issueId,
                number: members.number,
                status: members.status,
            })
            .from(members)
            .where(eq(members.watchId, id))
            .orderBy(asc(members.number));
    }
    watching(after: string | undefined, limit: number) {
        return this.db
            .select()
            .from(watches)
            .where(and(eq(watches.state, 'watching'), after ? gt(watches.id, after) : undefined))
            .orderBy(asc(watches.id))
            .limit(limit);
    }
    async statusEvents(ids: string[], after: number, through: number, limit: number) {
        const rows = await this.db
            .select({
                sequence: issueEvents.seq,
                issueId: issueEvents.issueId,
                to: issueEvents.toValue,
            })
            .from(issueEvents)
            .where(
                and(
                    inArray(issueEvents.issueId, ids),
                    eq(issueEvents.kind, 'status'),
                    gt(issueEvents.seq, after),
                    lte(issueEvents.seq, through),
                ),
            )
            .orderBy(asc(issueEvents.seq))
            .limit(limit);
        return rows.map((row) => ({ ...row, sequence: row.sequence! }));
    }
    memberStatus(watchId: string, issueId: string, status: IssueStatus) {
        return this.write('advance watched issue', async () => {
            await this.db
                .update(members)
                .set({ status })
                .where(and(eq(members.watchId, watchId), eq(members.issueId, issueId)));
        });
    }
    cursor(id: string, value: number) {
        return this.write('advance issue subscription cursor', async () => {
            await this.db.update(watches).set({ cursor: value }).where(eq(watches.id, id));
        });
    }
    ready(id: string, notice: IssueWatchOutbox) {
        return this.write('enqueue issue subscription notice', async () => {
            await this.db.insert(outbox).values(notice);
            await this.db.update(watches).set({ state: 'ready' }).where(eq(watches.id, id));
        });
    }
    pending(limit: number) {
        return this.db
            .select({
                id: outbox.id,
                watchId: outbox.watchId,
                userId: outbox.userId,
                title: outbox.title,
                message: outbox.message,
                path: outbox.path,
                createdAt: outbox.createdAt,
                claimedAt: outbox.claimedAt,
            })
            .from(outbox)
            .innerJoin(watches, eq(watches.id, outbox.watchId))
            .where(and(isNull(outbox.claimedAt), eq(watches.state, 'ready')))
            .orderBy(asc(outbox.createdAt), asc(outbox.id))
            .limit(limit);
    }
    claim(id: string, now: number) {
        return this.write('claim issue subscription outbox', async () => {
            const row = await this.db
                .update(outbox)
                .set({ claimedAt: now })
                .where(and(eq(outbox.id, id), isNull(outbox.claimedAt)))
                .returning()
                .get();
            if (row) {
                await this.db
                    .update(watches)
                    .set({ state: 'triggered', triggeredAt: now })
                    .where(eq(watches.id, row.watchId));
            }
            return row;
        });
    }
    cancel(id: string, reason: NonNullable<IssueWatchRow['cancelReason']>, now: number, source?: IssueWatchSource) {
        return this.write('cancel issue subscription', async () => {
            await this.db
                .update(watches)
                .set({
                    state: 'cancelled',
                    cancelReason: reason,
                    cancelledAt: now,
                    cancelSourceKind: source?.sourceKind ?? null,
                    cancelSourceId: source?.sourceId ?? null,
                    cancelThreadId: source?.threadId ?? null,
                    cancelCauseId: source?.causeId ?? null,
                })
                .where(and(eq(watches.id, id), inArray(watches.state, ['watching', 'ready', 'cancelled'])));
        });
    }
}
