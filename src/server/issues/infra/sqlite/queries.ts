import { and, asc, count, desc, eq, inArray, isNull, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { CLOSED_ISSUE_STATUSES, issueExcerpt, type IssueTitle } from '@socio/shared/issues/issue-types';

import type { BoardQueries } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { boardOrder } from './issues.js';
import {
    dotRequestNotices,
    dotRequestRequesters,
    dotRequests,
    issueAgentActions,
    issueDotActions,
    issueEvents,
    issueLinks,
    issues,
} from './schema.js';

const CLOSED = [...CLOSED_ISSUE_STATUSES];
const liveIssue = isNull(issues.deletedAt);
const title = {
    number: issues.number,
    title: issues.title,
    status: issues.status,
};

/** The Board's read model: joins across its own tables only. */
export class SqliteBoardQueries extends SqliteRepository implements BoardQueries {
    private statements = (() => {
        const db = this.data.uow.executor();
        const blocker = alias(issues, 'blocker');
        return {
            titles: db
                .select(title)
                .from(issues)
                .where(liveIssue)
                .orderBy(...boardOrder)
                .prepare(),
            openTitles: db
                .select(title)
                .from(issues)
                .where(and(liveIssue, notInArray(issues.status, CLOSED)))
                .orderBy(...boardOrder)
                .prepare(),
            texts: db
                .select({
                    id: issues.id,
                    number: issues.number,
                    title: issues.title,
                    body: issues.body,
                    status: issues.status,
                    kind: issues.kind,
                })
                .from(issues)
                .where(liveIssue)
                .orderBy(...boardOrder)
                .prepare(),
            openBlockers: db
                .select({ id: issueLinks.fromId, number: blocker.number })
                .from(issueLinks)
                .innerJoin(blocker, and(eq(blocker.id, issueLinks.toId), isNull(blocker.deletedAt)))
                .where(
                    and(
                        eq(issueLinks.kind, 'blocked_by'),
                        isNull(issueLinks.removedAt),
                        notInArray(blocker.status, CLOSED),
                    ),
                )
                .orderBy(asc(blocker.number))
                .prepare(),
            demand: db
                .select({
                    issueId: dotRequests.issueId,
                    n: count(dotRequestRequesters.id),
                })
                .from(dotRequests)
                .innerJoin(issues, and(eq(issues.id, dotRequests.issueId), liveIssue))
                .leftJoin(dotRequestRequesters, eq(dotRequestRequesters.issueId, dotRequests.issueId))
                .groupBy(dotRequests.issueId)
                .prepare(),
        };
    })();

    async titles({ open }: { open: boolean }): Promise<IssueTitle[]> {
        this.data.uow.executor();
        return (open ? this.statements.openTitles : this.statements.titles).all();
    }

    async cards(numbers: readonly number[]) {
        if (!numbers.length) {
            return [];
        }
        const rows = await this.db
            .select({
                ...title,
                body: issues.body,
                kind: issues.kind,
                priority: issues.priority,
                area: issues.area,
            })
            .from(issues)
            .where(and(inArray(issues.number, [...numbers]), liveIssue))
            .orderBy(asc(issues.number));
        return rows.map(({ body, ...card }) => ({
            ...card,
            excerpt: issueExcerpt(body),
        }));
    }

    async texts() {
        this.data.uow.executor();
        return this.statements.texts.all();
    }

    async openBlockerNumbers() {
        this.data.uow.executor();
        const open = new Map<string, number[]>();
        for (const row of await this.statements.openBlockers.all()) {
            open.set(row.id, [...(open.get(row.id) ?? []), row.number]);
        }
        return open;
    }

    async titlesById(ids: readonly string[], { deleted = false }: { deleted?: boolean } = {}) {
        const wanted = [...new Set(ids)];
        if (!wanted.length) {
            return new Map<string, IssueTitle>();
        }
        const rows = await this.db
            .select({ id: issues.id, ...title })
            .from(issues)
            .where(deleted ? inArray(issues.id, wanted) : and(inArray(issues.id, wanted), liveIssue));
        return new Map(rows.map(({ id, ...rest }) => [id, rest]));
    }

    async openRequest(key: string) {
        return this.db
            .select({
                issueId: dotRequests.issueId,
                capability: dotRequests.capability,
            })
            .from(dotRequests)
            .innerJoin(issues, eq(issues.id, dotRequests.issueId))
            .where(and(eq(dotRequests.key, key), notInArray(issues.status, CLOSED), liveIssue))
            .orderBy(asc(issues.createdAt), asc(issues.number))
            .limit(1)
            .get();
    }

    async demand() {
        this.data.uow.executor();
        return new Map((await this.statements.demand.all()).map((row) => [row.issueId, row.n]));
    }

    async requestSummaries(
        dotId: string,
        userId: string,
        { closed, unannounced = false }: { closed: boolean; unannounced?: boolean },
    ) {
        const where: SQL[] = [
            eq(dotRequestRequesters.dotId, dotId),
            eq(dotRequestRequesters.userId, userId),
            liveIssue,
            closed ? inArray(issues.status, CLOSED) : notInArray(issues.status, CLOSED),
        ];
        if (unannounced) {
            where.push(isNull(dotRequestRequesters.announcedAt));
        }
        return this.db
            .select({
                issueId: issues.id,
                number: issues.number,
                status: issues.status,
                resolution: issues.resolution,
                closedAt: issues.closedAt,
                capability: dotRequests.capability,
                requestedAt: dotRequestRequesters.createdAt,
            })
            .from(dotRequestRequesters)
            .innerJoin(dotRequests, eq(dotRequests.issueId, dotRequestRequesters.issueId))
            .innerJoin(issues, eq(issues.id, dotRequestRequesters.issueId))
            .where(and(...where))
            .orderBy(closed ? desc(issues.closedAt) : desc(dotRequestRequesters.createdAt), desc(issues.number))
            .limit(20);
    }

    async notices(userId: string) {
        return this.db
            .select({
                id: dotRequestNotices.id,
                issueId: dotRequestNotices.issueId,
                number: issues.number,
                capability: dotRequests.capability,
                status: dotRequestNotices.status,
                resolution: dotRequestNotices.resolution,
                createdAt: dotRequestNotices.createdAt,
            })
            .from(dotRequestNotices)
            .innerJoin(issues, eq(issues.id, dotRequestNotices.issueId))
            .innerJoin(dotRequests, eq(dotRequests.issueId, dotRequestNotices.issueId))
            .where(and(eq(dotRequestNotices.userId, userId), isNull(dotRequestNotices.seenAt), liveIssue))
            .orderBy(desc(dotRequestNotices.createdAt), sql`${insertionOrder(dotRequestNotices)} DESC`)
            .limit(20);
    }

    async filedFor(dotId: string, userId: string, limit: number) {
        return this.db
            .select({ ...title, filedAt: issueDotActions.createdAt })
            .from(issueDotActions)
            .innerJoin(issues, eq(issues.id, issueDotActions.issueId))
            .where(
                and(
                    eq(issueDotActions.dotId, dotId),
                    eq(issueDotActions.userId, userId),
                    eq(issueDotActions.action, 'create'),
                    liveIssue,
                ),
            )
            .orderBy(desc(issueDotActions.createdAt), sql`${insertionOrder(issueDotActions)} DESC`)
            .limit(limit);
    }

    async agentActivity(grantId: string, before: number, limit: number) {
        return this.db
            .select({
                action: issueAgentActions.action,
                targetId: issueAgentActions.targetId,
                userId: issueAgentActions.userId,
                createdAt: issueAgentActions.createdAt,
                number: issues.number,
                title: issues.title,
                field: issueEvents.kind,
            })
            .from(issueAgentActions)
            .leftJoin(issues, and(eq(issues.id, issueAgentActions.issueId), liveIssue))
            .leftJoin(
                issueEvents,
                and(eq(issueEvents.id, issueAgentActions.targetId), eq(issueAgentActions.action, 'update')),
            )
            .where(and(eq(issueAgentActions.grantId, grantId), lte(issueAgentActions.createdAt, before)))
            .orderBy(desc(issueAgentActions.createdAt), sql`${insertionOrder(issueAgentActions)} DESC`)
            .limit(limit);
    }
}
