import type { DatabaseSync } from 'node:sqlite';

import type { ActorScope, Audience } from '@socio/shared/actor-scopes';

import type {
    AuditEntry,
    ContextRecord,
    CredentialKind,
    CredentialRecord,
    GrantFilter,
    GrantRecord,
    HolderKind,
} from '../../contract.js';

export type { AuditEntry, ContextRecord, CredentialKind, CredentialRecord, GrantFilter, GrantRecord, HolderKind };

/**
 * The SQL of socio-actor access (CB-232), on the shared connection. Every
 * write here runs inside the caller's `transaction()`, `transactionSync()`
 * or `writeSoon` (docs/DATA-LAYER.md); nothing here opens one itself.
 */

type GrantRow = Omit<GrantRecord, 'audiences' | 'scopes' | 'resources'> & {
    audiences: string;
    scopes: string;
    resources: string | null;
};

const grantOf = (row: GrantRow): GrantRecord => ({
    ...row,
    audiences: JSON.parse(row.audiences) as Audience[],
    scopes: JSON.parse(row.scopes) as ActorScope[],
    resources: row.resources ? (JSON.parse(row.resources) as Record<string, unknown>) : null,
});

function where(filter: GrantFilter): { sql: string; values: string[] } {
    const used = (
        [
            ['id=?', filter.grantId],
            ['personId=?', filter.personId],
            ['socioId=?', filter.socioId],
            ['conversationId=?', filter.conversationId],
            ['EXISTS (SELECT 1 FROM json_each(audiences) WHERE value=?)', filter.audience],
        ] as [string, string | undefined][]
    ).filter((clause): clause is [string, string] => !!clause[1]);
    if (!used.length && !filter.all) {
        throw new Error('A grant filter names at least one field, or all.');
    }
    return {
        sql: used.length ? used.map(([sql]) => sql).join(' AND ') : '1',
        values: used.map(([, value]) => value),
    };
}

export class GrantRows {
    constructor(private db: DatabaseSync) {}
    insert(grant: GrantRecord) {
        this.db
            .prepare(
                `INSERT INTO socio_grants(id, personId, socioId, audiences, scopes, resources, conversationId, conversationKind, task, policyVersion, approvalId, createdAt, expiresAt, idleMs, lastUsedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                grant.id,
                grant.personId,
                grant.socioId,
                JSON.stringify(grant.audiences),
                JSON.stringify(grant.scopes),
                grant.resources ? JSON.stringify(grant.resources) : null,
                grant.conversationId,
                grant.conversationKind,
                grant.task,
                grant.policyVersion,
                grant.approvalId,
                grant.createdAt,
                grant.expiresAt,
                grant.idleMs,
                grant.lastUsedAt,
            );
    }
    get(id: string): GrantRecord | undefined {
        const row = this.db.prepare('SELECT * FROM socio_grants WHERE id=?').get(id) as GrantRow | undefined;
        return row && grantOf(row);
    }
    /** Unrevoked grants matching `filter`, oldest first (expired ones too). */
    unrevoked(filter: GrantFilter): GrantRecord[] {
        const { sql, values } = where(filter);
        return (
            this.db
                .prepare(`SELECT * FROM socio_grants WHERE revokedAt IS NULL AND ${sql} ORDER BY createdAt, id`)
                .all(...values) as unknown as GrantRow[]
        ).map(grantOf);
    }
    /** A person's grants, newest first, revoked ones too (their history). */
    ofPerson(personId: string, limit = 200): GrantRecord[] {
        return (
            this.db
                .prepare('SELECT * FROM socio_grants WHERE personId=? ORDER BY createdAt DESC, id LIMIT ?')
                .all(personId, limit) as unknown as GrantRow[]
        ).map(grantOf);
    }
    /** Live grants, newest first (admins). */
    live(now: number, limit = 500): GrantRecord[] {
        return (
            this.db
                .prepare(
                    'SELECT * FROM socio_grants WHERE revokedAt IS NULL AND expiresAt>? ORDER BY createdAt DESC, id LIMIT ?',
                )
                .all(now, limit) as unknown as GrantRow[]
        ).map(grantOf);
    }
    /** Marks unrevoked grants revoked; returns the ids it changed. */
    revoke(ids: readonly string[], at: number, by: string, reason: string, replacedBy?: string) {
        const changed: string[] = [];
        const statement = this.db.prepare(
            'UPDATE socio_grants SET revokedAt=?, revokedBy=?, revokeReason=?, replacedBy=COALESCE(?, replacedBy) WHERE id=? AND revokedAt IS NULL',
        );
        for (const id of ids) {
            if (Number(statement.run(at, by, reason, replacedBy ?? null, id).changes)) {
                changed.push(id);
            }
        }
        return changed;
    }
    touch(id: string, at: number) {
        this.db
            .prepare('UPDATE socio_grants SET lastUsedAt=? WHERE id=? AND lastUsedAt<? AND revokedAt IS NULL')
            .run(at, id, at);
    }
}

export class CredentialRows {
    constructor(private db: DatabaseSync) {}
    insert(record: CredentialRecord) {
        this.db
            .prepare(
                `INSERT INTO actor_credentials(hash, kind, grantId, audiences, scopes, contextId, holderKind, holderId, issuedAt, expiresAt, issuedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                record.hash,
                record.kind,
                record.grantId,
                JSON.stringify(record.audiences),
                JSON.stringify(record.scopes),
                record.contextId,
                record.holderKind,
                record.holderId,
                record.issuedAt,
                record.expiresAt,
                record.issuedBy,
            );
    }
    get(hash: string): CredentialRecord | undefined {
        const row = this.db.prepare('SELECT * FROM actor_credentials WHERE hash=?').get(hash) as
            | (Omit<CredentialRecord, 'audiences' | 'scopes'> & {
                  audiences: string;
                  scopes: string;
              })
            | undefined;
        return (
            row && {
                ...row,
                audiences: JSON.parse(row.audiences) as Audience[],
                scopes: JSON.parse(row.scopes) as ActorScope[],
            }
        );
    }
    deleteGrants(ids: readonly string[]) {
        const statement = this.db.prepare('DELETE FROM actor_credentials WHERE grantId=?');
        let n = 0;
        for (const id of ids) {
            n += Number(statement.run(id).changes);
        }
        return n;
    }
    deleteHolder(kind: HolderKind, id: string) {
        return Number(
            this.db.prepare('DELETE FROM actor_credentials WHERE holderKind=? AND holderId=?').run(kind, id).changes,
        );
    }
    deleteHash(hash: string) {
        return Number(this.db.prepare('DELETE FROM actor_credentials WHERE hash=?').run(hash).changes);
    }
    /** Drops rows past their expiry (the sweep); returns how many. */
    deleteExpired(now: number) {
        return Number(this.db.prepare('DELETE FROM actor_credentials WHERE expiresAt<=?').run(now).changes);
    }
    /** The newest expiry among a holder's credentials (renewal). */
    newestExpiry(kind: HolderKind, id: string): number | undefined {
        const row = this.db
            .prepare('SELECT MAX(expiresAt) AS at FROM actor_credentials WHERE holderKind=? AND holderId=?')
            .get(kind, id) as { at: number | null };
        return row.at ?? undefined;
    }
}

export class ContextRows {
    constructor(private db: DatabaseSync) {}
    insert(record: ContextRecord) {
        this.db
            .prepare(
                'INSERT INTO actor_contexts(id, grantId, personId, socioId, kind, audience, worker, openedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                record.id,
                record.grantId,
                record.personId,
                record.socioId,
                record.kind,
                record.audience,
                record.worker,
                record.openedAt,
            );
    }
    get(id: string): ContextRecord | undefined {
        return this.db.prepare('SELECT * FROM actor_contexts WHERE id=?').get(id) as ContextRecord | undefined;
    }
    /** Open contexts of a kind, counted for the caps. */
    openCounts(kind: ContextRecord['kind'], personId: string, socioId: string) {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS total, SUM(personId=?) AS person, SUM(socioId=?) AS socio
         FROM actor_contexts WHERE kind=? AND closedAt IS NULL`,
            )
            .get(personId, socioId, kind) as {
            total: number;
            person: number | null;
            socio: number | null;
        };
        return {
            total: Number(row.total),
            person: Number(row.person ?? 0),
            socio: Number(row.socio ?? 0),
        };
    }
    open(filter?: { grantIds?: readonly string[] }): ContextRecord[] {
        const rows = this.db
            .prepare('SELECT * FROM actor_contexts WHERE closedAt IS NULL ORDER BY openedAt')
            .all() as unknown as ContextRecord[];
        return filter?.grantIds ? rows.filter((row) => filter.grantIds!.includes(row.grantId)) : rows;
    }
    close(ids: readonly string[], at: number, reason: string) {
        const statement = this.db.prepare(
            'UPDATE actor_contexts SET closedAt=?, closeReason=? WHERE id=? AND closedAt IS NULL',
        );
        const closed: string[] = [];
        for (const id of ids) {
            if (Number(statement.run(at, reason, id).changes)) {
                closed.push(id);
            }
        }
        return closed;
    }
    ofGrants(ids: readonly string[]) {
        const statement = this.db.prepare('SELECT id FROM actor_contexts WHERE grantId=? AND closedAt IS NULL');
        return ids.flatMap((id) => statement.all(id).map((row) => String(row.id)));
    }
}

export interface AuditRow extends AuditEntry {
    id: number;
}

export class AuditRows {
    constructor(private db: DatabaseSync) {}
    insert(entry: AuditEntry) {
        this.db
            .prepare(
                `INSERT INTO actor_audit(at, correlationId, phase, decision, reason, personId, socioId, grantId, actorBy, audience, action, tier, resourceKind, resourceId, status, digest, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entry.at,
                entry.correlationId,
                entry.phase,
                entry.decision ?? null,
                entry.reason ?? null,
                entry.personId ?? null,
                entry.socioId ?? null,
                entry.grantId ?? null,
                entry.actorBy ?? null,
                entry.audience ?? null,
                entry.action ?? null,
                entry.tier ?? null,
                entry.resourceKind ?? null,
                entry.resourceId ?? null,
                entry.status ?? null,
                entry.digest ?? null,
                entry.detail ?? null,
            );
    }
    /** A person's rows, newest first, older than `before` (by time, then id). */
    personPage(personId: string, before: { at: number; id: number } | undefined, limit: number): AuditRow[] {
        const rows = this.db
            .prepare(
                'SELECT * FROM actor_audit WHERE personId=? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT ?',
            )
            .all(
                personId,
                before?.at ?? Number.MAX_SAFE_INTEGER,
                before?.id ?? Number.MAX_SAFE_INTEGER,
                limit,
            ) as Record<string, unknown>[];
        return rows.map(
            (row) =>
                Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as AuditRow,
        );
    }
    list(filter: { personId?: string; grantId?: string; correlationId?: string }, limit = 500): AuditRow[] {
        const used = (
            [
                ['personId=?', filter.personId],
                ['grantId=?', filter.grantId],
                ['correlationId=?', filter.correlationId],
            ] as [string, string | undefined][]
        ).filter((clause): clause is [string, string] => !!clause[1]);
        const parts = used.map(([sql]) => sql);
        const values = used.map(([, value]) => value);
        const rows = this.db
            .prepare(
                `SELECT * FROM actor_audit ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
            )
            .all(...values, limit) as Record<string, unknown>[];
        return rows.map(
            (row) =>
                Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as AuditRow,
        );
    }
}

/**
 * Revocations other runtimes poll (`runtime_signals`, CB-108): a fast path
 * only; every runtime also re-checks what it holds every 5 s.
 */
export class RevocationSignals {
    static readonly KIND = 'actor-grant';
    constructor(private db: DatabaseSync) {}
    insert(grantId: string, reason: string, at: number) {
        this.db
            .prepare(
                `INSERT INTO runtime_signals VALUES(?,?,'revoke',?,?) ON CONFLICT(kind,id,signal) DO UPDATE SET reason=excluded.reason, requestedAt=excluded.requestedAt`,
            )
            .run(RevocationSignals.KIND, grantId, reason, at);
    }
    since(at: number): { grantId: string; reason: string; at: number }[] {
        if (!this.db.isOpen) {
            return [];
        }
        return this.db
            .prepare(
                `SELECT id, reason, requestedAt FROM runtime_signals WHERE kind=? AND signal='revoke' AND requestedAt>=? ORDER BY requestedAt`,
            )
            .all(RevocationSignals.KIND, at)
            .map((row) => ({
                grantId: String(row.id),
                reason: String(row.reason ?? ''),
                at: Number(row.requestedAt),
            }));
    }
}
