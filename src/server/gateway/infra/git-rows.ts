import type { DatabaseSync } from 'node:sqlite';

import type { CodingRepositoryView } from '@socio/shared/coding/coding-repos';

/**
 * The SQL of the Git proxy (CB-239, CB-267), on the shared connection.
 * Every write here runs inside the caller's `transaction()` or
 * `writeSoon` (docs/DATA-LAYER.md); nothing here opens one itself.
 */

interface RepositoryRow {
    key: string;
    repository: string;
    baseBranches: string;
    branchPrefix: string;
    push: number;
    pushChecklistAt: number | null;
    pushChecklistBy: string | null;
    users: string | null;
    extraction: number;
    standingExtraction: number;
    createdAt: number;
    updatedAt: number;
    updatedBy: string;
}

const repositoryOf = (row: RepositoryRow): CodingRepositoryView => ({
    repository: row.repository,
    baseBranches: JSON.parse(row.baseBranches) as string[],
    branchPrefix: row.branchPrefix,
    push: row.push === 1,
    pushChecklist: row.pushChecklistAt !== null ? { at: row.pushChecklistAt, by: row.pushChecklistBy ?? '' } : null,
    users: row.users === null ? null : (JSON.parse(row.users) as string[]),
    extraction: row.extraction === 1,
    standingExtraction: row.standingExtraction === 1,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
});

export class RepositoryRows {
    constructor(private db: DatabaseSync) {}
    get(repository: string): CodingRepositoryView | undefined {
        const row = this.db.prepare('SELECT * FROM gateway_repositories WHERE key=?').get(repository.toLowerCase()) as
            | RepositoryRow
            | undefined;
        return row && repositoryOf(row);
    }
    list(): CodingRepositoryView[] {
        return (
            this.db.prepare('SELECT * FROM gateway_repositories ORDER BY key').all() as unknown as RepositoryRow[]
        ).map(repositoryOf);
    }
    upsert(view: CodingRepositoryView, now: number) {
        this.db
            .prepare(
                `INSERT INTO gateway_repositories(key, repository, baseBranches, branchPrefix, push, pushChecklistAt, pushChecklistBy, users, extraction, standingExtraction, createdAt, updatedAt, updatedBy)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET repository=excluded.repository, baseBranches=excluded.baseBranches,
           branchPrefix=excluded.branchPrefix, push=excluded.push, pushChecklistAt=excluded.pushChecklistAt,
           pushChecklistBy=excluded.pushChecklistBy, users=excluded.users,
           extraction=excluded.extraction, standingExtraction=excluded.standingExtraction,
           updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
            )
            .run(
                view.repository.toLowerCase(),
                view.repository,
                JSON.stringify(view.baseBranches),
                view.branchPrefix,
                view.push ? 1 : 0,
                view.pushChecklist?.at ?? null,
                view.pushChecklist?.by ?? null,
                view.users === null ? null : JSON.stringify(view.users),
                view.extraction ? 1 : 0,
                view.standingExtraction ? 1 : 0,
                now,
                view.updatedAt,
                view.updatedBy,
            );
    }
    remove(repository: string) {
        return (
            Number(
                this.db.prepare('DELETE FROM gateway_repositories WHERE key=?').run(repository.toLowerCase()).changes,
            ) > 0
        );
    }
}

export class GitSettingRows {
    constructor(private db: DatabaseSync) {}
    all(): Record<string, string> {
        const rows = this.db.prepare('SELECT key, value FROM gateway_git_settings').all() as Array<{
            key: string;
            value: string;
        }>;
        return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    }
    set(key: string, value: string | null, now: number, by: string) {
        if (value === null) {
            this.db.prepare('DELETE FROM gateway_git_settings WHERE key=?').run(key);
        } else {
            this.db
                .prepare(
                    `INSERT INTO gateway_git_settings(key, value, updatedAt, updatedBy) VALUES(?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
                )
                .run(key, value, now, by);
        }
    }
}

export class MintRows {
    constructor(private db: DatabaseSync) {}
    /**
     * Counts one mint in `hour` when fewer than `ceiling` were; whether it
     * was counted. Old hours are dropped as it goes.
     */
    take(hour: number, ceiling: number) {
        this.db.prepare('DELETE FROM gateway_git_mints WHERE hour < ?').run(hour - 48);
        const changed = this.db
            .prepare(
                `INSERT INTO gateway_git_mints(hour, count) VALUES(?, 1)
         ON CONFLICT(hour) DO UPDATE SET count = count + 1 WHERE count < ?`,
            )
            .run(hour, ceiling).changes;
        if (Number(changed) !== 1) {
            return false;
        }
        // A ceiling of 0 or a lowered one: the insert above may have made 1.
        const row = this.db.prepare('SELECT count FROM gateway_git_mints WHERE hour=?').get(hour) as { count: number };
        return row.count <= ceiling;
    }
    count(hour: number) {
        return (
            (
                this.db.prepare('SELECT count FROM gateway_git_mints WHERE hour=?').get(hour) as
                    | { count: number }
                    | undefined
            )?.count ?? 0
        );
    }
}

export type ExtractionStatus = 'requested' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExtractionRecord {
    id: string;
    personId: string;
    socioId: string;
    appId: string;
    repository: string;
    ref: string;
    commitId: string;
    paths: string[];
    threadId: string;
    status: ExtractionStatus;
    approvalId: string | null;
    standingGrantId: string | null;
    filePath: string | null;
    files: number | null;
    bytes: number | null;
    failure: string | null;
    createdAt: number;
    readyAt: number | null;
    expiresAt: number;
    firstReadAt: number | null;
    removedAt: number | null;
}

type ExtractionRow = Omit<ExtractionRecord, 'paths'> & { paths: string };

const extractionOf = (row: ExtractionRow): ExtractionRecord => ({
    ...row,
    paths: JSON.parse(row.paths) as string[],
});

export class ExtractionRows {
    constructor(private db: DatabaseSync) {}
    insert(record: ExtractionRecord) {
        this.db
            .prepare(
                `INSERT INTO gateway_extractions(id, personId, socioId, appId, repository, ref, commitId, paths, threadId, status, approvalId, standingGrantId, filePath, files, bytes, failure, createdAt, readyAt, expiresAt, firstReadAt, removedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
                record.id,
                record.personId,
                record.socioId,
                record.appId,
                record.repository,
                record.ref,
                record.commitId,
                JSON.stringify(record.paths),
                record.threadId,
                record.status,
                record.approvalId,
                record.standingGrantId,
                record.filePath,
                record.files,
                record.bytes,
                record.failure,
                record.createdAt,
                record.readyAt,
                record.expiresAt,
                record.firstReadAt,
                record.removedAt,
            );
    }
    get(id: string) {
        const row = this.db.prepare('SELECT * FROM gateway_extractions WHERE id=?').get(id) as
            | ExtractionRow
            | undefined;
        return row && extractionOf(row);
    }
    setApproval(id: string, approvalId: string) {
        this.db.prepare('UPDATE gateway_extractions SET approvalId=? WHERE id=?').run(approvalId, id);
    }
    /**
     * `requested` → `running`, once: whether this caller claimed it. The
     * run gets until `until` before the sweep may take it.
     */
    claim(id: string, until: number) {
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE gateway_extractions SET status='running', expiresAt=? WHERE id=? AND status='requested' AND removedAt IS NULL",
                    )
                    .run(until, id).changes,
            ) === 1
        );
    }
    ready(
        id: string,
        input: {
            filePath: string;
            files: number;
            bytes: number;
            at: number;
            expiresAt: number;
        },
    ) {
        this.db
            .prepare(
                "UPDATE gateway_extractions SET status='ready', filePath=?, files=?, bytes=?, readyAt=?, expiresAt=? WHERE id=? AND status='running'",
            )
            .run(input.filePath, input.files, input.bytes, input.at, input.expiresAt, id);
    }
    fail(id: string, failure: string) {
        this.db
            .prepare(
                "UPDATE gateway_extractions SET status='failed', failure=? WHERE id=? AND status IN ('requested','running')",
            )
            .run(failure.slice(0, 300), id);
    }
    /** The first read starts the 10-minute window; later reads keep it. */
    firstRead(id: string, at: number) {
        this.db.prepare('UPDATE gateway_extractions SET firstReadAt=? WHERE id=? AND firstReadAt IS NULL').run(at, id);
    }
    /** Live extractions past their time, oldest first. */
    due(now: number, limit = 50) {
        return (
            this.db
                .prepare(
                    'SELECT * FROM gateway_extractions WHERE removedAt IS NULL AND expiresAt <= ? ORDER BY expiresAt LIMIT ?',
                )
                .all(now, limit) as unknown as ExtractionRow[]
        ).map(extractionOf);
    }
    removed(id: string, at: number) {
        this.db
            .prepare(
                "UPDATE gateway_extractions SET removedAt=?, status=CASE WHEN status IN ('ready','requested','running') THEN 'expired' ELSE status END WHERE id=? AND removedAt IS NULL",
            )
            .run(at, id);
    }
    /** A person's own, newest first (their history; counts only). */
    ofPerson(personId: string, limit = 50) {
        return (
            this.db
                .prepare('SELECT * FROM gateway_extractions WHERE personId=? ORDER BY createdAt DESC LIMIT ?')
                .all(personId, limit) as unknown as ExtractionRow[]
        ).map(extractionOf);
    }
}

/** A person's app session on an app's origin, by its cookie hash. */
export function appSessionByHash(db: DatabaseSync, hash: string) {
    return db.prepare('SELECT appId, userId, expiresAt FROM app_sessions WHERE hash=?').get(hash) as
        | { appId: string; userId: string; expiresAt: number }
        | undefined;
}
