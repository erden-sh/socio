import { and, desc, eq, lte } from 'drizzle-orm';

import type { ComputerAudit, ComputerPermissions } from '@socio/shared/computers/computer-types';

import type { ComputerAuditEntry, ComputerAuditRepository, ComputerPermissionRepository } from '../../contract.js';

import { SqliteRepository } from './base.js';
import { computerAudit, computerPermissions } from './schema.js';

/** Each socio's computer permissions, as one JSON value. */
export class SqliteComputerPermissions extends SqliteRepository implements ComputerPermissionRepository {
    async get(dotId: string) {
        return (
            await this.db
                .select({ value: computerPermissions.value })
                .from(computerPermissions)
                .where(eq(computerPermissions.dotId, dotId))
                .get()
        )?.value;
    }

    save(dotId: string, value: ComputerPermissions) {
        return this.write('save computer permissions', async () => {
            await this.db.insert(computerPermissions).values({ dotId, value }).onConflictDoUpdate({
                target: computerPermissions.dotId,
                set: { value },
            });
        });
    }
}

/** The computer audit: a pending entry per action, then its outcome. */
export class SqliteComputerAudit extends SqliteRepository implements ComputerAuditRepository {
    usedBy(userId: string, dotId: string) {
        return !!this.db
            .select({ id: computerAudit.id })
            .from(computerAudit)
            .where(and(eq(computerAudit.userId, userId), eq(computerAudit.dotId, dotId)))
            .limit(1)
            .get();
    }
    begin(entry: ComputerAuditEntry) {
        this.soon('computer audit', () => {
            this.db
                .insert(computerAudit)
                .values({ ...entry, outcome: 'pending' })
                .run();
        });
    }

    finish(id: string, outcome: 'succeeded' | 'failed') {
        this.soon('computer audit outcome', () => {
            this.db.update(computerAudit).set({ outcome }).where(eq(computerAudit.id, id)).run();
        });
    }

    async latest(dotId: string, limit: number): Promise<ComputerAudit[]> {
        return this.db
            .select({
                id: computerAudit.id,
                action: computerAudit.action,
                actor: computerAudit.actor,
                userId: computerAudit.userId,
                outcome: computerAudit.outcome,
                createdAt: computerAudit.createdAt,
            })
            .from(computerAudit)
            .where(eq(computerAudit.dotId, dotId))
            .orderBy(desc(computerAudit.createdAt))
            .limit(limit)
            .all();
    }

    async activity(dotId: string, before: number, limit: number) {
        return this.db
            .select({
                action: computerAudit.action,
                actor: computerAudit.actor,
                outcome: computerAudit.outcome,
                userId: computerAudit.userId,
                createdAt: computerAudit.createdAt,
            })
            .from(computerAudit)
            .where(and(eq(computerAudit.dotId, dotId), lte(computerAudit.createdAt, before)))
            .orderBy(desc(computerAudit.createdAt))
            .limit(limit)
            .all();
    }
}
