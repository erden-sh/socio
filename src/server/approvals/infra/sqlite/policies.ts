import { and, asc, eq } from 'drizzle-orm';

import type { ApprovalPolicy } from '@socio/shared/approvals';

import type { ApprovalGuidanceRepository, ApprovalPolicyRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { approvalGuidance, approvalPolicies } from './schema.js';

/** Policies per person, socio and capability. */
export class SqlitePolicies extends SqliteRepository implements ApprovalPolicyRepository {
    async get(userId: string, dotId: string, capability: string) {
        return (
            await this.db
                .select({ policy: approvalPolicies.policy })
                .from(approvalPolicies)
                .where(
                    and(
                        eq(approvalPolicies.userId, userId),
                        eq(approvalPolicies.dotId, dotId),
                        eq(approvalPolicies.capability, capability),
                    ),
                )
                .get()
        )?.policy;
    }

    async list(userId: string, dotId?: string) {
        return this.db
            .select({
                dotId: approvalPolicies.dotId,
                capability: approvalPolicies.capability,
                policy: approvalPolicies.policy,
                updatedAt: approvalPolicies.updatedAt,
            })
            .from(approvalPolicies)
            .where(and(eq(approvalPolicies.userId, userId), dotId ? eq(approvalPolicies.dotId, dotId) : undefined))
            .orderBy(asc(approvalPolicies.dotId), asc(approvalPolicies.capability));
    }

    set(row: { userId: string; dotId: string; capability: string; policy: ApprovalPolicy; updatedAt: number }) {
        return this.write('set approval policy', async () => {
            await this.db
                .insert(approvalPolicies)
                .values(row)
                .onConflictDoUpdate({
                    target: [approvalPolicies.userId, approvalPolicies.dotId, approvalPolicies.capability],
                    set: { policy: row.policy, updatedAt: row.updatedAt },
                });
        });
    }

    removeForDot(dotId: string) {
        return this.write('remove approval policies', async () => {
            await this.db.delete(approvalPolicies).where(eq(approvalPolicies.dotId, dotId));
        });
    }
}

/** A person's standing guidance for their auto reviews. */
export class SqliteGuidance extends SqliteRepository implements ApprovalGuidanceRepository {
    async get(userId: string) {
        return (
            await this.db
                .select({ guidance: approvalGuidance.guidance })
                .from(approvalGuidance)
                .where(eq(approvalGuidance.userId, userId))
                .get()
        )?.guidance;
    }

    set(userId: string, guidance: string, now: number) {
        return this.write('set approval guidance', async () => {
            await this.db
                .insert(approvalGuidance)
                .values({ userId, guidance, updatedAt: now })
                .onConflictDoUpdate({
                    target: approvalGuidance.userId,
                    set: { guidance, updatedAt: now },
                });
        });
    }

    clear(userId: string) {
        return this.write('clear approval guidance', async () => {
            await this.db.delete(approvalGuidance).where(eq(approvalGuidance.userId, userId));
        });
    }
}
