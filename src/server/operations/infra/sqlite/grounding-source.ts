import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { GroundingSourceReader, SourceIssueRun, SourceRunRef } from '../../etl/grounding-source.js';

const readers = new WeakMap<DatabaseSync, SqliteGroundingSource>();

/**
 * The grounding ETL's reads of the app's database (CB-194), on the
 * analytics process's own read-only connection, each one statement.
 */
export function sqliteGroundingSource(db: DatabaseSync): GroundingSourceReader {
    let reader = readers.get(db);
    if (!reader) {
        readers.set(db, (reader = new SqliteGroundingSource(db)));
    }
    return reader;
}

class SqliteGroundingSource implements GroundingSourceReader {
    private statements = new Map<string, StatementSync>();
    constructor(private db: DatabaseSync) {}

    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) {
            this.statements.set(sql, (statement = this.db.prepare(sql)));
        }
        return statement;
    }

    has(table: string) {
        return !!this.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }

    runRefsAfter(id: number, limit: number) {
        if (!this.has('run_refs')) {
            return [];
        }
        return this.statement(
            'SELECT id, runId, threadId, kind, spaceId, refId, at FROM run_refs WHERE id > ? ORDER BY id LIMIT ?',
        ).all(id, limit) as unknown as SourceRunRef[];
    }

    lastRunRefId() {
        if (!this.has('run_refs')) {
            return 0;
        }
        const row = this.statement('SELECT max(id) AS id FROM run_refs').get() as { id: number | null } | undefined;
        return row?.id ?? 0;
    }

    issueRuns() {
        if (!this.has('issue_runs')) {
            return [];
        }
        return this.statement(
            'SELECT issueId, runId, threadId, via, createdAt FROM issue_runs ORDER BY issueId, runId',
        ).all() as unknown as SourceIssueRun[];
    }
}
