import type { DatabaseSync } from 'node:sqlite';

import { transaction, writeSoon } from '@socio/data/open';

import type { AuditShape, AuditTrailShape, TrailCursor, WorkspaceAuditEntry, WorkspaceAuditLine } from './contract.js';

/**
 * The `Audit` slice: `workspace_audit` (CB-64), on the workspace's connection.
 * Moved from `WorkspaceStore` as it was.
 */
export class SqliteAudit implements AuditShape, AuditTrailShape {
    constructor(private db: DatabaseSync) {}
    /** Records a delete that has no audit of its own module (CB-64). */
    audit(entry: WorkspaceAuditEntry, now = Date.now()) {
        // Queued behind another chain's unit of work, in order (CB-110).
        writeSoon(this.db, 'workspace audit', () =>
            this.db
                .prepare(
                    'INSERT INTO workspace_audit (actor, action, targetKind, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .run(entry.actor, entry.action, entry.targetKind, entry.targetId, entry.detail ?? '', now),
        );
    }
    /** Records these lines before anything that follows, in one transaction: awaited, and a failure throws (CB-352). */
    async auditNow(entries: readonly WorkspaceAuditEntry[], now = Date.now()) {
        await transaction(this.db, 'workspace audit', () => {
            const insert = this.db.prepare(
                'INSERT INTO workspace_audit (actor, action, targetKind, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
            );
            for (const entry of entries) {
                insert.run(entry.actor, entry.action, entry.targetKind, entry.targetId, entry.detail ?? '', now);
            }
        });
    }
    /** The audit lines about one target, oldest first. */
    auditOf(targetKind: WorkspaceAuditEntry['targetKind'], targetId: string) {
        return this.db
            .prepare(
                'SELECT actor, action, targetKind, targetId, detail, createdAt FROM workspace_audit WHERE targetKind=? AND targetId=? ORDER BY id',
            )
            .all(targetKind, targetId)
            .map((row) => ({ ...row })) as unknown as WorkspaceAuditLine[];
    }
    /** A person's lines, as actor or about them (`AuditShape.personTrail`). */
    personTrail(userId: string, before: TrailCursor | undefined, limit: number) {
        // Space memberships are `<spaceId>:<userId>`; an agent's revocation says `... for <userId>`.
        return this.db
            .prepare(
                `SELECT id, actor, action, targetKind, targetId, detail, createdAt FROM workspace_audit
         WHERE (actor=?1
           OR (targetKind IN ('user', 'telegram_link') AND targetId=?1)
           OR (targetKind='space_member' AND substr(targetId, -length(?1) - 1)=':' || ?1)
           OR (targetKind='agent_grant' AND substr(detail, -length(?1) - 5)=' for ' || ?1))
           AND (createdAt, id) < (?2, ?3)
         ORDER BY createdAt DESC, id DESC LIMIT ?4`,
            )
            .all(userId, before?.at ?? Number.MAX_SAFE_INTEGER, before?.id ?? Number.MAX_SAFE_INTEGER, limit)
            .map((row) => ({
                ...row,
                id: Number(row.id),
                createdAt: Number(row.createdAt),
            })) as unknown as (WorkspaceAuditLine & {
            id: number;
        })[];
    }
}
