import type { DatabaseSync } from 'node:sqlite';

import type { SecretFlagRule, WorkloadKind } from '@socio/shared/workspace-secrets';

/** A `workspace_audit` line about a secret, as history and flags read it. */
export interface SecretAuditLine {
    id: number;
    actor: string;
    action: string;
    detail: string;
    createdAt: number;
}

export interface ReadCounts {
    actor: string;
    reads: number;
    firstReadAt: number | null;
    lastReadAt: number | null;
    refused: number;
    lastRefusedAt: number | null;
}

export interface StoredFlag {
    id: string;
    rule: SecretFlagRule;
    dedupKey: string;
    workloadKind: WorkloadKind;
    workloadId: string;
    secretId: string | null;
    explanation: string;
    firstSeenAt: number;
    lastSeenAt: number;
    notifiedAt: number | null;
    dismissedAt: number | null;
    dismissedBy: string | null;
}

const KIND = "targetKind='workspace_secret'";
const CHANGES = "action IN ('create','update','delete','grant','revoke')";
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const rows = <T>(list: unknown[]) => list.map((row) => ({ ...(row as object) })) as T[];

/**
 * Socio Secrets: what a secret's history and the read-anomaly rules read
 * from `workspace_audit` (the lines the service writes, never a value), and
 * the read flags' own table. Reads use the audit's `(targetKind, targetId)`
 * and `(targetKind, createdAt)` indexes.
 */
export class SecretAuditLines {
    constructor(private db: DatabaseSync) {}

    // ---- a secret's history ----------------------------------------------
    /**
     * Changes (create, replace, describe, delete, grant, revoke) and each
     * workload's first read, newest first, older than `before`.
     */
    events(secretId: string, before: number, limit: number): SecretAuditLine[] {
        return rows(
            this.db
                .prepare(
                    `SELECT id, actor, action, detail, createdAt FROM workspace_audit
                     WHERE ${KIND} AND targetId=? AND id<? AND (${CHANGES} OR id IN (
                         SELECT min(id) FROM workspace_audit WHERE ${KIND} AND targetId=? AND action='read' GROUP BY actor))
                     ORDER BY id DESC LIMIT ?`,
                )
                .all(secretId, before, secretId, limit),
        );
    }
    /** Reads and refusals per reader. */
    readCounts(secretId: string): ReadCounts[] {
        return this.db
            .prepare(
                `SELECT actor,
                        sum(action='read') AS reads,
                        min(CASE WHEN action='read' THEN createdAt END) AS firstReadAt,
                        max(CASE WHEN action='read' THEN createdAt END) AS lastReadAt,
                        sum(action='deny') AS refused,
                        max(CASE WHEN action='deny' THEN createdAt END) AS lastRefusedAt
                 FROM workspace_audit WHERE ${KIND} AND targetId=? AND action IN ('read','deny')
                 GROUP BY actor ORDER BY min(id)`,
            )
            .all(secretId)
            .map((row) => ({
                actor: String(row.actor),
                reads: Number(row.reads),
                firstReadAt: num(row.firstReadAt),
                lastReadAt: num(row.lastReadAt),
                refused: Number(row.refused),
                lastRefusedAt: num(row.lastRefusedAt),
            }));
    }

    // ---- the rules ---------------------------------------------------------
    /** Readers with any read since `from`. */
    readersSince(from: number): string[] {
        return this.db
            .prepare(`SELECT DISTINCT actor FROM workspace_audit WHERE ${KIND} AND createdAt>=? AND action='read'`)
            .all(from)
            .map((row) => String(row.actor));
    }
    /** A reader's reads of any secret in [from, to); and the last one's time. */
    readsBetween(actor: string, from: number, to: number): { count: number; lastAt: number | null } {
        const row = this.db
            .prepare(
                `SELECT count(*) AS n, max(createdAt) AS lastAt FROM workspace_audit
                 WHERE ${KIND} AND createdAt>=? AND createdAt<? AND action='read' AND actor=?`,
            )
            .get(from, to, actor)!;
        return { count: Number(row.n), lastAt: num(row.lastAt) };
    }
    /** Whether a reader read anything before `at`. */
    readBefore(actor: string, at: number): boolean {
        return !!this.db
            .prepare(
                `SELECT 1 FROM workspace_audit WHERE ${KIND} AND createdAt<? AND action='read' AND actor=? LIMIT 1`,
            )
            .get(at, actor);
    }
    /** Secrets and readers with "not granted" refusals since `from`. */
    refusedSince(from: number): Array<{ secretId: string; actor: string }> {
        return rows(
            this.db
                .prepare(
                    `SELECT DISTINCT targetId AS secretId, actor FROM workspace_audit
                     WHERE ${KIND} AND createdAt>=? AND action='deny' AND targetId NOT LIKE 'name:%'
                       AND instr(detail, '(not granted or not set)')>0`,
                )
                .all(from),
        );
    }
    /** The latest line of `action` on a secret whose detail ends with `suffix`. */
    latestEndingWith(secretId: string, action: string, suffix: string): SecretAuditLine | undefined {
        const row = this.db
            .prepare(
                `SELECT id, actor, action, detail, createdAt FROM workspace_audit
                 WHERE ${KIND} AND targetId=? AND action=? AND substr(detail, -length(?))=?
                 ORDER BY id DESC LIMIT 1`,
            )
            .get(secretId, action, suffix, suffix);
        return row ? ({ ...row } as unknown as SecretAuditLine) : undefined;
    }
    /** A reader's "not granted" refusals of a secret since `from`. */
    refusalsSince(secretId: string, actor: string, from: number): { count: number; lastAt: number | null } {
        const row = this.db
            .prepare(
                `SELECT count(*) AS n, max(createdAt) AS lastAt FROM workspace_audit
                 WHERE ${KIND} AND targetId=? AND actor=? AND createdAt>=? AND action='deny'
                   AND instr(detail, '(not granted or not set)')>0`,
            )
            .get(secretId, actor, from)!;
        return { count: Number(row.n), lastAt: num(row.lastAt) };
    }
    /** Plugin readers with a read or refusal marked `stale` since `from`. */
    staleReadersSince(from: number): string[] {
        return this.db
            .prepare(
                `SELECT DISTINCT actor FROM workspace_audit WHERE ${KIND} AND createdAt>=? AND action IN ('read','deny')
                   AND actor LIKE 'plugin:%' AND instr(detail, ' stale (current ')>0`,
            )
            .all(from)
            .map((row) => String(row.actor));
    }
    /** A plugin's stale uses since `from`: how many, and the latest line. */
    staleUsesSince(actor: string, from: number): { count: number; last: SecretAuditLine | undefined } {
        const row = this.db
            .prepare(
                `SELECT count(*) AS n, max(id) AS lastId FROM workspace_audit WHERE ${KIND} AND createdAt>=?
                   AND action IN ('read','deny') AND actor=? AND instr(detail, ' stale (current ')>0`,
            )
            .get(from, actor)!;
        const last = row.lastId
            ? this.db
                  .prepare('SELECT id, actor, action, detail, createdAt FROM workspace_audit WHERE id=?')
                  .get(row.lastId)
            : undefined;
        return { count: Number(row.n), last: last ? ({ ...last } as unknown as SecretAuditLine) : undefined };
    }

    // ---- flags -------------------------------------------------------------
    openFlag(dedupKey: string): StoredFlag | undefined {
        const row = this.db
            .prepare('SELECT * FROM workspace_secret_flags WHERE dedupKey=? AND dismissedAt IS NULL')
            .get(dedupKey);
        return row ? ({ ...row } as unknown as StoredFlag) : undefined;
    }
    /** When a flag with this key was last dismissed, if ever. */
    lastDismissed(dedupKey: string): number | null {
        const row = this.db
            .prepare('SELECT max(dismissedAt) AS at FROM workspace_secret_flags WHERE dedupKey=?')
            .get(dedupKey)!;
        return num(row.at);
    }
    flag(id: string): StoredFlag | undefined {
        const row = this.db.prepare('SELECT * FROM workspace_secret_flags WHERE id=?').get(id);
        return row ? ({ ...row } as unknown as StoredFlag) : undefined;
    }
    openFlags(): StoredFlag[] {
        return rows(
            this.db
                .prepare('SELECT * FROM workspace_secret_flags WHERE dismissedAt IS NULL ORDER BY lastSeenAt DESC')
                .all(),
        );
    }
    /** A secret's flags, open and dismissed, newest first. */
    flagsOf(secretId: string, limit = 50): StoredFlag[] {
        return rows(
            this.db
                .prepare('SELECT * FROM workspace_secret_flags WHERE secretId=? ORDER BY lastSeenAt DESC LIMIT ?')
                .all(secretId, limit),
        );
    }
    /** Workload-wide flags (no secret) of a workload, open and dismissed. */
    flagsOfWorkload(kind: WorkloadKind, id: string, limit = 50): StoredFlag[] {
        return rows(
            this.db
                .prepare(
                    'SELECT * FROM workspace_secret_flags WHERE secretId IS NULL AND workloadKind=? AND workloadId=? ORDER BY lastSeenAt DESC LIMIT ?',
                )
                .all(kind, id, limit),
        );
    }

    // ---- flag writes (inside the repository's `write`) ---------------------
    insertFlag(row: StoredFlag) {
        this.db
            .prepare(
                'INSERT OR IGNORE INTO workspace_secret_flags(id,rule,dedupKey,workloadKind,workloadId,secretId,explanation,firstSeenAt,lastSeenAt,notifiedAt,dismissedAt,dismissedBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
                row.id,
                row.rule,
                row.dedupKey,
                row.workloadKind,
                row.workloadId,
                row.secretId,
                row.explanation,
                row.firstSeenAt,
                row.lastSeenAt,
                row.notifiedAt,
                row.dismissedAt,
                row.dismissedBy,
            );
    }
    refreshFlag(id: string, explanation: string, lastSeenAt: number) {
        this.db
            .prepare('UPDATE workspace_secret_flags SET explanation=?, lastSeenAt=max(lastSeenAt, ?) WHERE id=?')
            .run(explanation, lastSeenAt, id);
    }
    notified(ids: readonly string[], at: number) {
        const update = this.db.prepare('UPDATE workspace_secret_flags SET notifiedAt=? WHERE id=?');
        for (const id of ids) {
            update.run(at, id);
        }
    }
    /** Dismissing keeps the row (the record); only an open flag changes. */
    dismiss(id: string, by: string, at: number) {
        return (
            Number(
                this.db
                    .prepare(
                        'UPDATE workspace_secret_flags SET dismissedAt=?, dismissedBy=? WHERE id=? AND dismissedAt IS NULL',
                    )
                    .run(at, by, id).changes,
            ) > 0
        );
    }
}
