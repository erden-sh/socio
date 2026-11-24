import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Issue, IssueLabel, IssueLinkRef } from '@socio/shared/issues/issue-types';

import type { IssueFilter } from '../../contract.js';
import type { IssueFields, IssueRepository } from '../../domain/repositories.js';

import { SqliteRepository, priorityRank } from './base.js';
import { issueCounter, issueLabels, issueLinks, issueRelations, issues } from './schema.js';

type IssueRow = typeof issues.$inferSelect;

/** A stored issue as the domain's `Issue` (no stamps), with its labels. */
export function issueOf(row: IssueRow, labels: IssueLabel[]): Issue {
    return {
        id: row.id,
        number: row.number,
        title: row.title,
        body: row.body,
        status: row.status,
        priority: row.priority,
        kind: row.kind,
        area: row.area,
        labels,
        reporterId: row.reporterId,
        assigneeId: row.assigneeId,
        resolution: row.resolution,
        source: row.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        closedAt: row.closedAt,
    };
}

/** The board's order: priority, then most recently updated, then newest. */
export const boardOrder = [priorityRank(issues.priority), desc(issues.updatedAt), desc(issues.number)];

/** A related link's pair in stored order: the smaller id first (CB-274). */
const ordered = (oneId: string, otherId: string): [string, string] =>
    oneId < otherId ? [oneId, otherId] : [otherId, oneId];

/** Issues, their labels, blocked-by and related links, the number counter. */
export class SqliteIssues extends SqliteRepository implements IssueRepository {
    private statements = (() => {
        const db = this.data.uow.executor();
        const id = sql.placeholder('id');
        return {
            byNumber: db
                .select()
                .from(issues)
                .where(and(eq(issues.number, sql.placeholder('number')), isNull(issues.deletedAt)))
                .prepare(),
            byId: db
                .select()
                .from(issues)
                .where(and(eq(issues.id, id), isNull(issues.deletedAt)))
                .prepare(),
            labels: db
                .select({ label: issueLabels.label })
                .from(issueLabels)
                .where(eq(issueLabels.issueId, id))
                .orderBy(asc(issueLabels.label))
                .prepare(),
        };
    })();

    private async labels(issueId: string) {
        this.data.uow.executor();
        return (await this.statements.labels.all({ id: issueId })).map((row) => row.label);
    }

    private async withLabels(row: IssueRow | undefined) {
        return row ? issueOf(row, await this.labels(row.id)) : undefined;
    }

    async list(filter: IssueFilter = {}) {
        const where: SQL[] = [];
        for (const key of ['status', 'priority', 'kind', 'area', 'assigneeId'] as const) {
            const value = filter[key];
            if (value) {
                where.push(eq(issues[key], value));
            }
        }
        if (filter.label) {
            where.push(
                inArray(
                    issues.id,
                    this.db
                        .select({ id: issueLabels.issueId })
                        .from(issueLabels)
                        .where(eq(issueLabels.label, filter.label)),
                ),
            );
        }
        const q = filter.q?.trim();
        if (q) {
            const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
            where.push(
                sql`(lower(${issues.title}) LIKE lower(${like}) ESCAPE '\\' OR lower(${issues.body}) LIKE lower(${like}) ESCAPE '\\')`,
            );
        }
        where.push(isNull(issues.deletedAt));
        const rows = await this.db
            .select()
            .from(issues)
            .where(and(...where))
            .orderBy(...boardOrder);
        const labels = new Map<string, IssueLabel[]>();
        for (const row of await this.db.select().from(issueLabels).orderBy(asc(issueLabels.label))) {
            labels.set(row.issueId, [...(labels.get(row.issueId) ?? []), row.label]);
        }
        return rows.map((row) => issueOf(row, labels.get(row.id) ?? []));
    }

    async byNumber(number: number) {
        this.data.uow.executor();
        return this.withLabels(await this.statements.byNumber.get({ number }));
    }

    async byId(id: string) {
        this.data.uow.executor();
        return this.withLabels(await this.statements.byId.get({ id }));
    }

    async withDeleted(number: number) {
        return this.db.select().from(issues).where(eq(issues.number, number)).get();
    }

    async nextNumber() {
        const counter = await this.db
            .select({ last: issueCounter.last })
            .from(issueCounter)
            .where(eq(issueCounter.id, 1))
            .get();
        const highest = await this.db
            .select({ number: sql<number | null>`MAX(${issues.number})` })
            .from(issues)
            .get();
        return Math.max(counter?.last ?? 0, highest?.number ?? 0) + 1;
    }

    insert(issue: Issue) {
        return this.write('insert issue', async () => {
            const { labels, ...row } = issue;
            await this.db.insert(issues).values(row);
            // An imported number above the counter moves it on too.
            await this.db
                .update(issueCounter)
                .set({
                    last: sql`CASE WHEN ${issueCounter.last} < ${issue.number} THEN ${issue.number} ELSE ${issueCounter.last} END`,
                })
                .where(eq(issueCounter.id, 1));
            for (const label of new Set(labels)) {
                await this.db.insert(issueLabels).values({ issueId: issue.id, label });
            }
        });
    }

    update(id: string, fields: IssueFields) {
        return this.write('update issue', async () => {
            if (Object.keys(fields).length) {
                await this.db.update(issues).set(fields).where(eq(issues.id, id));
            }
        });
    }

    setLabels(id: string, labels: readonly IssueLabel[]) {
        return this.write('set issue labels', async () => {
            await this.db.delete(issueLabels).where(eq(issueLabels.issueId, id));
            for (const label of labels) {
                await this.db.insert(issueLabels).values({ issueId: id, label });
            }
        });
    }

    touch(id: string, now: number) {
        return this.write('touch issue', async () => {
            await this.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, id));
        });
    }

    markDeleted(id: string, by: string | null, now: number) {
        return this.write('delete issue', async () => {
            await this.db.update(issues).set({ deletedAt: now, deletedBy: by }).where(eq(issues.id, id));
        });
    }

    async links(id: string, side: 'blockedBy' | 'blocks') {
        const [own, other] =
            side === 'blockedBy' ? [issueLinks.fromId, issueLinks.toId] : [issueLinks.toId, issueLinks.fromId];
        return this.db
            .select({
                number: issues.number,
                title: issues.title,
                status: issues.status,
            })
            .from(issueLinks)
            .innerJoin(issues, and(eq(issues.id, other), isNull(issues.deletedAt)))
            .where(and(eq(own, id), eq(issueLinks.kind, 'blocked_by'), isNull(issueLinks.removedAt)))
            .orderBy(asc(issues.number)) as Promise<IssueLinkRef[]>;
    }

    async hasLink(fromId: string, toId: string) {
        return !!(await this.db
            .select({ id: issueLinks.id })
            .from(issueLinks)
            .where(
                and(
                    eq(issueLinks.fromId, fromId),
                    eq(issueLinks.toId, toId),
                    eq(issueLinks.kind, 'blocked_by'),
                    isNull(issueLinks.removedAt),
                ),
            )
            .get());
    }

    async reaches(fromId: string, toId: string) {
        return !!(await this.db.get(
            sql`WITH RECURSIVE ahead(id) AS (SELECT ${issueLinks.toId} FROM ${issueLinks} WHERE ${issueLinks.fromId} = ${fromId} AND ${issueLinks.kind} = 'blocked_by' AND ${issueLinks.removedAt} IS NULL UNION SELECT l.toId FROM ${issueLinks} l JOIN ahead a ON l.fromId = a.id WHERE l.kind = 'blocked_by' AND l.removedAt IS NULL) SELECT 1 AS found FROM ahead WHERE id = ${toId}`,
        ));
    }

    addLink(link: { id: string; fromId: string; toId: string; createdBy: string; createdAt: number }) {
        return this.write('add issue link', async () => {
            await this.db.insert(issueLinks).values({ ...link, kind: 'blocked_by' });
        });
    }

    removeLink(fromId: string, toId: string, by: string, now: number) {
        return this.write('remove issue link', async () => {
            const { changes } = await this.db
                .update(issueLinks)
                .set({ removedAt: now, removedBy: by })
                .where(
                    and(
                        eq(issueLinks.fromId, fromId),
                        eq(issueLinks.toId, toId),
                        eq(issueLinks.kind, 'blocked_by'),
                        isNull(issueLinks.removedAt),
                    ),
                )
                .run();
            return Number(changes) > 0;
        });
    }

    async relatedLinks(id: string) {
        const other = sql`CASE WHEN ${issueRelations.fromId} = ${id} THEN ${issueRelations.toId} ELSE ${issueRelations.fromId} END`;
        return this.db
            .select({
                number: issues.number,
                title: issues.title,
                status: issues.status,
            })
            .from(issueRelations)
            .innerJoin(issues, and(eq(issues.id, other), isNull(issues.deletedAt)))
            .where(
                and(or(eq(issueRelations.fromId, id), eq(issueRelations.toId, id)), isNull(issueRelations.removedAt)),
            )
            .orderBy(asc(issues.number)) as Promise<IssueLinkRef[]>;
    }

    private livePair(oneId: string, otherId: string) {
        const [fromId, toId] = ordered(oneId, otherId);
        return and(
            eq(issueRelations.fromId, fromId),
            eq(issueRelations.toId, toId),
            eq(issueRelations.kind, 'related'),
            isNull(issueRelations.removedAt),
        );
    }

    async hasRelated(oneId: string, otherId: string) {
        return !!(await this.db
            .select({ id: issueRelations.id })
            .from(issueRelations)
            .where(this.livePair(oneId, otherId))
            .get());
    }

    addRelated({
        oneId,
        otherId,
        ...link
    }: {
        id: string;
        oneId: string;
        otherId: string;
        createdBy: string;
        createdAt: number;
    }) {
        const [fromId, toId] = ordered(oneId, otherId);
        return this.write('add related issue link', async () => {
            await this.db.insert(issueRelations).values({ ...link, fromId: fromId, toId: toId, kind: 'related' });
        });
    }

    removeRelated(oneId: string, otherId: string, by: string, now: number) {
        return this.write('remove related issue link', async () => {
            const { changes } = await this.db
                .update(issueRelations)
                .set({ removedAt: now, removedBy: by })
                .where(this.livePair(oneId, otherId))
                .run();
            return Number(changes) > 0;
        });
    }
}
