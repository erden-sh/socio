import { and, asc, between, count, desc, eq, gt, inArray, lte } from 'drizzle-orm';

import type { AgentAttribution, DotFiling } from '@socio/shared/issues/issue-types';

import type { DotActionRow } from '../../contract.js';
import type { AgentActionRow, BoardAuditRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { issueAgentActions, issueDotActions } from './schema.js';

const dotFiling = {
    dotId: issueDotActions.dotId,
    dotOwnerId: issueDotActions.dotOwnerId,
    userId: issueDotActions.userId,
    trigger: issueDotActions.trigger,
    causeId: issueDotActions.causeId,
    createdAt: issueDotActions.createdAt,
};

/** What Dots (CB-31) and connected agents (CB-90) did on the board. */
export class SqliteBoardAudit extends SqliteRepository implements BoardAuditRepository {
    recordDot(row: DotActionRow) {
        return this.write('record socio action', async () => {
            await this.db.insert(issueDotActions).values(row);
        });
    }

    recordAgent(row: AgentActionRow) {
        return this.write('record agent action', async () => {
            await this.db.insert(issueAgentActions).values(row);
        });
    }

    async dotFiling(issueId: string): Promise<DotFiling | undefined> {
        return this.db
            .select(dotFiling)
            .from(issueDotActions)
            .where(and(eq(issueDotActions.issueId, issueId), eq(issueDotActions.action, 'create')))
            .orderBy(asc(issueDotActions.createdAt), insertionOrder(issueDotActions))
            .limit(1)
            .get();
    }

    async dotComments(issueId: string): Promise<Array<[string, DotFiling]>> {
        const rows = await this.db
            .select({ targetId: issueDotActions.targetId, ...dotFiling })
            .from(issueDotActions)
            .where(and(eq(issueDotActions.issueId, issueId), eq(issueDotActions.action, 'comment')))
            .orderBy(asc(issueDotActions.createdAt), insertionOrder(issueDotActions));
        return rows.map(({ targetId, ...filing }) => [String(targetId), filing]);
    }

    async dotEvents(issueId: string): Promise<Array<[string, DotFiling]>> {
        const rows = await this.db
            .select({ targetId: issueDotActions.targetId, ...dotFiling })
            .from(issueDotActions)
            .where(and(eq(issueDotActions.issueId, issueId), eq(issueDotActions.action, 'update')))
            .orderBy(asc(issueDotActions.createdAt), insertionOrder(issueDotActions));
        return rows.map(({ targetId, ...filing }) => [String(targetId), filing]);
    }

    async dotCountSince(
        actions: readonly DotActionRow['action'][],
        by: { dotId: string } | { userId: string },
        since: number,
    ) {
        const row = await this.db
            .select({ n: count() })
            .from(issueDotActions)
            .where(
                and(
                    inArray(issueDotActions.action, [...actions]),
                    'dotId' in by ? eq(issueDotActions.dotId, by.dotId) : eq(issueDotActions.userId, by.userId),
                    gt(issueDotActions.createdAt, since),
                ),
            )
            .get();
        return row?.n ?? 0;
    }

    async dotByCause(userId: string, causeIds: readonly string[], from: number, to: number) {
        if (!causeIds.length) {
            return [];
        }
        return this.db
            .select({
                issueId: issueDotActions.issueId,
                action: issueDotActions.action,
                createdAt: issueDotActions.createdAt,
            })
            .from(issueDotActions)
            .where(
                and(
                    eq(issueDotActions.userId, userId),
                    inArray(issueDotActions.trigger, ['scheduled', 'goal']),
                    inArray(issueDotActions.causeId, [...causeIds]),
                    between(issueDotActions.createdAt, from, to),
                ),
            )
            .orderBy(asc(issueDotActions.createdAt), insertionOrder(issueDotActions));
    }

    async dotActivity(dotId: string, before: number, limit: number) {
        return this.db
            .select()
            .from(issueDotActions)
            .where(and(eq(issueDotActions.dotId, dotId), lte(issueDotActions.createdAt, before)))
            .orderBy(desc(issueDotActions.createdAt))
            .limit(limit);
    }

    async dotFilingCount(dotId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(issueDotActions)
            .where(and(eq(issueDotActions.dotId, dotId), eq(issueDotActions.action, 'create')))
            .get();
        return row?.n ?? 0;
    }

    async agentActions(issueId: string) {
        const rows = await this.db
            .select({
                action: issueAgentActions.action,
                targetId: issueAgentActions.targetId,
                grantId: issueAgentActions.grantId,
                clientId: issueAgentActions.clientId,
                clientName: issueAgentActions.clientName,
                label: issueAgentActions.label,
                userId: issueAgentActions.userId,
                createdAt: issueAgentActions.createdAt,
            })
            .from(issueAgentActions)
            .where(eq(issueAgentActions.issueId, issueId))
            .orderBy(asc(issueAgentActions.createdAt), insertionOrder(issueAgentActions));
        return rows.map(
            ({ action, targetId, ...attribution }) =>
                ({ action, targetId, attribution }) as {
                    action: AgentActionRow['action'];
                    targetId: string | null;
                    attribution: AgentAttribution;
                },
        );
    }
}
