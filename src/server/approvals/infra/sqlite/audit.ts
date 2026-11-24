import { and, desc, eq, lte } from 'drizzle-orm';

import type { ApprovalAuditRepository, AuditEntry } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { approvalAudit } from './schema.js';

/** The approval audit: append-only. */
export class SqliteAudit extends SqliteRepository implements ApprovalAuditRepository {
    append(entry: AuditEntry) {
        return this.write('audit approval', async () => {
            await this.db.insert(approvalAudit).values(entry);
        });
    }

    async forUser(userId: string, limit: number) {
        return this.db
            .select({
                id: approvalAudit.id,
                dotId: approvalAudit.dotId,
                capability: approvalAudit.capability,
                requestId: approvalAudit.requestId,
                event: approvalAudit.event,
                actor: approvalAudit.actor,
                detail: approvalAudit.detail,
                createdAt: approvalAudit.createdAt,
            })
            .from(approvalAudit)
            .where(eq(approvalAudit.userId, userId))
            .orderBy(desc(approvalAudit.createdAt), desc(insertionOrder(approvalAudit)))
            .limit(limit);
    }

    async forDot(dotId: string, before: number, limit: number) {
        return this.db
            .select({
                userId: approvalAudit.userId,
                capability: approvalAudit.capability,
                event: approvalAudit.event,
                actor: approvalAudit.actor,
                createdAt: approvalAudit.createdAt,
            })
            .from(approvalAudit)
            .where(and(eq(approvalAudit.dotId, dotId), lte(approvalAudit.createdAt, before)))
            .orderBy(desc(approvalAudit.createdAt))
            .limit(limit);
    }
}
