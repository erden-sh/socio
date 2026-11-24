import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';

import type { IssueEvent, IssueEventKind } from '@socio/shared/issues/issue-types';

import type { IssueHistoryRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { issueEvents } from './schema.js';

/** The newest `seq`, 0 for none. */
const LAST_SEQ = sql<number>`COALESCE(MAX(${issueEvents.seq}), 0)`;

/** An issue's history (append-only), ordered by `seq`. */
export class SqliteHistory extends SqliteRepository implements IssueHistoryRepository {
    private forIssueQuery = this.data.uow
        .executor()
        .select({
            id: issueEvents.id,
            issueId: issueEvents.issueId,
            actorId: issueEvents.actorId,
            kind: issueEvents.kind,
            fromValue: issueEvents.fromValue,
            toValue: issueEvents.toValue,
            createdAt: issueEvents.createdAt,
        })
        .from(issueEvents)
        .where(eq(issueEvents.issueId, sql.placeholder('issueId')))
        .orderBy(asc(issueEvents.createdAt), asc(issueEvents.seq))
        .prepare();

    append(event: Omit<IssueEvent, 'agent'>) {
        return this.write('append issue history', async () => {
            // Inside the write lock, so the next `seq` is this row's alone.
            await this.db.insert(issueEvents).values({
                ...event,
                seq: sql`(SELECT ${LAST_SEQ} + 1 FROM ${issueEvents})`,
            });
        });
    }

    async forIssue(issueId: string): Promise<IssueEvent[]> {
        this.data.uow.executor();
        return this.forIssueQuery.all({ issueId });
    }

    async statusEvents(issueId: string, after: number, limit: number) {
        const rows = await this.db
            .select({
                sequence: issueEvents.seq,
                kind: issueEvents.kind,
                at: issueEvents.createdAt,
                from: issueEvents.fromValue,
                to: issueEvents.toValue,
            })
            .from(issueEvents)
            .where(
                and(
                    eq(issueEvents.issueId, issueId),
                    gt(issueEvents.seq, after),
                    inArray(issueEvents.kind, ['created', 'imported', 'status']),
                ),
            )
            .orderBy(asc(issueEvents.seq))
            .limit(limit);
        return rows.map((row) => ({
            ...row,
            // seq > after excludes null; migration backfills legacy rows and its trigger fills new legacy writes.
            sequence: row.sequence!,
            kind: row.kind as 'created' | 'imported' | 'status',
        }));
    }

    async lastSeq() {
        const row = await this.db.select({ seq: LAST_SEQ }).from(issueEvents).get();
        return Number(row?.seq ?? 0);
    }

    async after(seq: number, filter: { issueId: string; kind?: IssueEventKind; actorId?: string }) {
        const where: SQL[] = [gt(issueEvents.seq, seq), eq(issueEvents.issueId, filter.issueId)];
        if (filter.kind) {
            where.push(eq(issueEvents.kind, filter.kind));
        }
        if (filter.actorId) {
            where.push(eq(issueEvents.actorId, filter.actorId));
        }
        return this.db
            .select({ id: issueEvents.id, kind: issueEvents.kind })
            .from(issueEvents)
            .where(and(...where))
            .orderBy(asc(issueEvents.seq));
    }
}
