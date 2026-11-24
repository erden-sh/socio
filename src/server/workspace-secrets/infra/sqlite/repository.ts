import type { DatabaseSync } from 'node:sqlite';

import { transaction, writeSoon } from '@socio/data/open';
import { LIVE } from '@socio/data/soft-delete';
import type { SecretScope, SecretVersionState, WorkloadKind } from '@socio/shared/workspace-secrets';

import { SecretAuditLines } from './audit-lines.js';

/** A workspace app or a service plugin. */

export interface StoredSecret {
    id: string;
    name: string;
    scope: SecretScope;
    workloadKind: WorkloadKind | null;
    workloadId: string | null;
    description: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    lastReadAt: number | null;
    lastReadBy: string | null;
    deletedAt: number | null;
    deletedBy: string | null;
    deletedWith: string | null;
}
export interface StoredVersion {
    secretId: string;
    version: number;
    sealed: string;
    state: SecretVersionState;
    retireAt: number | null;
    setBy: string;
    setAt: number;
    lastReadAt: number | null;
}
export interface StoredGrant {
    secretId: string;
    workloadKind: WorkloadKind;
    workloadId: string;
    grantedBy: string;
    grantedAt: number;
}

const rows = <T>(list: unknown[]) => list.map((row) => ({ ...(row as object) })) as T[];

/**
 * Socio Secrets' tables on the workspace connection. Writes go through
 * its unit of work; the read stamps (`lastReadAt`) are written soon, like
 * audit rows, so a read never waits on another chain's write.
 */
export class WorkspaceSecretRepository {
    /** The audit lines a history and the read flags read, and the flags' table. */
    readonly lines: SecretAuditLines;
    constructor(private db: DatabaseSync) {
        this.lines = new SecretAuditLines(db);
    }
    write<T>(label: string, fn: () => T) {
        return transaction(this.db, label, fn);
    }

    // ---- reads -----------------------------------------------------------
    live(): StoredSecret[] {
        return rows(this.db.prepare(`SELECT * FROM workspace_secrets WHERE ${LIVE} ORDER BY name, scope, id`).all());
    }
    liveCount(): number {
        return Number(this.db.prepare(`SELECT COUNT(*) n FROM workspace_secrets WHERE ${LIVE}`).get()!.n);
    }
    get(id: string): StoredSecret | undefined {
        const row = this.db.prepare(`SELECT * FROM workspace_secrets WHERE id=? AND ${LIVE}`).get(id);
        return row ? ({ ...row } as unknown as StoredSecret) : undefined;
    }
    /** A deleted one too (tests, the audit trail). */
    withDeleted(id: string): StoredSecret | undefined {
        const row = this.db.prepare('SELECT * FROM workspace_secrets WHERE id=?').get(id);
        return row ? ({ ...row } as unknown as StoredSecret) : undefined;
    }
    /** The live secret of this name in a scope (a workload's, or the workspace's). */
    byName(name: string, scope: SecretScope, workload?: { kind: WorkloadKind; id: string }) {
        const row =
            scope === 'workspace'
                ? this.db
                      .prepare(`SELECT * FROM workspace_secrets WHERE name=? AND scope='workspace' AND ${LIVE}`)
                      .get(name)
                : this.db
                      .prepare(
                          `SELECT * FROM workspace_secrets WHERE name=? AND scope='workload' AND workloadKind=? AND workloadId=? AND ${LIVE}`,
                      )
                      .get(name, workload!.kind, workload!.id);
        return row ? ({ ...row } as unknown as StoredSecret) : undefined;
    }
    versions(secretId: string): StoredVersion[] {
        return rows(
            this.db
                .prepare('SELECT * FROM workspace_secret_versions WHERE secretId=? ORDER BY version DESC')
                .all(secretId),
        );
    }
    version(secretId: string, version: number): StoredVersion | undefined {
        const row = this.db
            .prepare('SELECT * FROM workspace_secret_versions WHERE secretId=? AND version=?')
            .get(secretId, version);
        return row ? ({ ...row } as unknown as StoredVersion) : undefined;
    }
    current(secretId: string): StoredVersion | undefined {
        const row = this.db
            .prepare("SELECT * FROM workspace_secret_versions WHERE secretId=? AND state='current'")
            .get(secretId);
        return row ? ({ ...row } as unknown as StoredVersion) : undefined;
    }
    /** Every sealed version, for the seal counts and the re-seal. */
    allSealed(): Array<Pick<StoredVersion, 'secretId' | 'version' | 'sealed'>> {
        return rows(this.db.prepare('SELECT secretId, version, sealed FROM workspace_secret_versions').all());
    }
    grants(secretId: string): StoredGrant[] {
        return rows(
            this.db.prepare('SELECT * FROM workspace_secret_grants WHERE secretId=? ORDER BY grantedAt').all(secretId),
        );
    }
    granted(secretId: string, kind: WorkloadKind, workloadId: string) {
        return !!this.db
            .prepare('SELECT 1 FROM workspace_secret_grants WHERE secretId=? AND workloadKind=? AND workloadId=?')
            .get(secretId, kind, workloadId);
    }
    allGrants(): StoredGrant[] {
        return rows(this.db.prepare('SELECT * FROM workspace_secret_grants').all());
    }

    // ---- writes (inside `write`) -----------------------------------------
    insertSecret(row: StoredSecret) {
        this.db
            .prepare(
                'INSERT INTO workspace_secrets(id,name,scope,workloadKind,workloadId,description,createdBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(
                row.id,
                row.name,
                row.scope,
                row.workloadKind,
                row.workloadId,
                row.description,
                row.createdBy,
                row.createdAt,
                row.updatedAt,
            );
    }
    insertVersion(row: Omit<StoredVersion, 'lastReadAt'>) {
        this.db
            .prepare(
                'INSERT INTO workspace_secret_versions(secretId,version,sealed,state,retireAt,setBy,setAt) VALUES(?,?,?,?,?,?,?)',
            )
            .run(row.secretId, row.version, row.sealed, row.state, row.retireAt, row.setBy, row.setAt);
    }
    /** Every `previous` version retires; the current one becomes `previous` until `retireAt` (or retires at once). */
    demote(secretId: string, now: number, retireAt: number) {
        this.db
            .prepare(
                "UPDATE workspace_secret_versions SET state='retired', retireAt=? WHERE secretId=? AND state='previous'",
            )
            .run(now, secretId);
        this.db
            .prepare("UPDATE workspace_secret_versions SET state=?, retireAt=? WHERE secretId=? AND state='current'")
            .run(retireAt > now ? 'previous' : 'retired', retireAt, secretId);
    }
    touch(secretId: string, now: number) {
        this.db.prepare('UPDATE workspace_secrets SET updatedAt=? WHERE id=?').run(now, secretId);
    }
    describe(secretId: string, description: string, now: number) {
        this.db
            .prepare('UPDATE workspace_secrets SET description=?, updatedAt=? WHERE id=? AND deletedAt IS NULL')
            .run(description, now, secretId);
    }
    /** Soft delete (CB-64): every version retires, kept sealed; grants go. */
    softDelete(secretId: string, by: string, now: number, withParent: string | null = null) {
        this.db
            .prepare(
                'UPDATE workspace_secrets SET deletedAt=?, deletedBy=?, deletedWith=? WHERE id=? AND deletedAt IS NULL',
            )
            .run(now, by, withParent, secretId);
        this.db
            .prepare(
                "UPDATE workspace_secret_versions SET state='retired', retireAt=coalesce(min(retireAt, ?), ?) WHERE secretId=? AND state<>'retired'",
            )
            .run(now, now, secretId);
        this.db.prepare('DELETE FROM workspace_secret_grants WHERE secretId=?').run(secretId);
    }
    insertGrant(row: StoredGrant) {
        this.db
            .prepare(
                'INSERT OR IGNORE INTO workspace_secret_grants(secretId,workloadKind,workloadId,grantedBy,grantedAt) VALUES(?,?,?,?,?)',
            )
            .run(row.secretId, row.workloadKind, row.workloadId, row.grantedBy, row.grantedAt);
    }
    deleteGrant(secretId: string, kind: WorkloadKind, workloadId: string) {
        return (
            Number(
                this.db
                    .prepare('DELETE FROM workspace_secret_grants WHERE secretId=? AND workloadKind=? AND workloadId=?')
                    .run(secretId, kind, workloadId).changes,
            ) > 0
        );
    }
    /** Previous versions past their window retire. */
    retireDue(now: number) {
        return Number(
            this.db
                .prepare("UPDATE workspace_secret_versions SET state='retired' WHERE state='previous' AND retireAt<=?")
                .run(now).changes,
        );
    }
    /** A re-seal's swap: only when the row still holds what was opened. */
    replaceSealed(secretId: string, version: number, previous: string, next: string) {
        return (
            Number(
                this.db
                    .prepare(
                        'UPDATE workspace_secret_versions SET sealed=? WHERE secretId=? AND version=? AND sealed=?',
                    )
                    .run(next, secretId, version, previous).changes,
            ) > 0
        );
    }

    /** A workload's read, stamped soon (it never waits on another write). */
    stampRead(secretId: string, version: number, reader: string, now: number) {
        writeSoon(this.db, 'workspace secret read', () => {
            this.db
                .prepare('UPDATE workspace_secrets SET lastReadAt=?, lastReadBy=? WHERE id=?')
                .run(now, reader, secretId);
            this.db
                .prepare('UPDATE workspace_secret_versions SET lastReadAt=? WHERE secretId=? AND version=?')
                .run(now, secretId, version);
        });
    }
}
