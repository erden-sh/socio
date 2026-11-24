import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
    KnowledgeSourceReader,
    SourceDataAccess,
    SourceDataset,
    SourceDatasetDay,
    SourceLifetime,
    SourceOwnerFiles,
    SourcePage,
    SourcePageEdit,
    SourcePageKey,
    SourcePageUse,
    SourceRequest,
    SourceSearchDay,
} from '../../etl/knowledge-source.js';

const HOUR = 3_600_000;
const readers = new WeakMap<DatabaseSync, SqliteKnowledgeSource>();

/**
 * The Knowledge ETL's reads of the app's database (CB-191), on the
 * analytics process's own read-only connection, each one statement. Live
 * pages are listed from the covering index `pages_live_keys`, so no
 * page text is read until a page changed; times are grouped by the hour.
 */
export function sqliteKnowledgeSource(db: DatabaseSync): KnowledgeSourceReader {
    let reader = readers.get(db);
    if (!reader) {
        readers.set(db, (reader = new SqliteKnowledgeSource(db)));
    }
    return reader;
}

class SqliteKnowledgeSource implements KnowledgeSourceReader {
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

    livePageKeys() {
        return this.statement(
            'SELECT rowid AS rowKey, spaceId, updatedAt, title FROM pages INDEXED BY pages_live_keys WHERE (deletedAt IS NULL) = 1',
        ).all() as unknown as SourcePageKey[];
    }

    pagesByKey(keys: readonly number[]) {
        if (!keys.length) {
            return [];
        }
        return this.statement(
            `SELECT rowid AS rowKey, id, spaceId, title, length(content) AS chars,
        revision, createdAt, updatedAt, createdBy
      FROM pages WHERE rowid IN (SELECT value FROM json_each(?)) AND deletedAt IS NULL`,
        ).all(JSON.stringify(keys)) as unknown as SourcePage[];
    }

    pageUse() {
        if (!this.has('page_use')) {
            return [];
        }
        return this.statement(
            'SELECT pageId, usedAt FROM page_use ORDER BY pageId',
        ).all() as unknown as SourcePageUse[];
    }

    pageEditsAfter(id: number, limit: number) {
        if (!this.has('page_revisions')) {
            return [];
        }
        return this.statement(
            'SELECT id, pageId, spaceId, authorId, replacedAt FROM page_revisions WHERE id > ? ORDER BY id LIMIT ?',
        ).all(id, limit) as unknown as SourcePageEdit[];
    }

    lastPageEditId() {
        if (!this.has('page_revisions')) {
            return 0;
        }
        const row = this.statement('SELECT MAX(id) AS id FROM page_revisions').get() as
            | { id: number | null }
            | undefined;
        return row?.id ?? 0;
    }

    searchDays() {
        if (!this.has('page_search_daily')) {
            return [];
        }
        return this.statement(
            'SELECT day, queries, empty, corrected, trigram, maxMs, histogram FROM page_search_daily ORDER BY day',
        ).all() as unknown as SourceSearchDay[];
    }

    dataAccessAfter(after: { at: number; id: string }, before: number, limit: number) {
        if (!this.has('data_audit')) {
            return [];
        }
        return this.statement(
            `SELECT id, createdAt, ownerUserId, actorKind, actorId, dotId, datasetId, action, outcome, threadId
      FROM data_audit INDEXED BY data_audit_time
      WHERE (createdAt, id) > (?, ?) AND createdAt < ?
      ORDER BY createdAt, id LIMIT ?`,
        ).all(after.at, after.id, before, limit) as unknown as SourceDataAccess[];
    }

    datasets() {
        if (!this.has('data_datasets')) {
            return [];
        }
        return this.statement(
            `SELECT id, ownerUserId, name, scratchForDotId IS NOT NULL AS scratch,
        sizeBytes, historyBytes, tableCount, createdAt, updatedAt, deletedAt
      FROM data_datasets ORDER BY id`,
        ).all() as unknown as SourceDataset[];
    }

    datasetDaysAfter(after: { at: number; rowKey: number }, before: number, limit: number) {
        if (!this.has('data_dataset_days')) {
            return [];
        }
        return this.statement(
            `SELECT rowid AS rowKey, datasetId, day, sizeBytes, historyBytes, tableCount, measuredAt
      FROM data_dataset_days INDEXED BY data_dataset_days_measured
      WHERE (measuredAt, rowid) > (?, ?) AND measuredAt < ?
      ORDER BY measuredAt, rowid LIMIT ?`,
        ).all(after.at, after.rowKey, before, limit) as unknown as SourceDatasetDay[];
    }

    lifetimes() {
        const hour = (column: string) => `(${column} / ${HOUR}) * ${HOUR}`;
        const grouped = (kind: SourceLifetime['kind'], table: string, bytes: string, from = table) =>
            this.has(table)
                ? (this.statement(
                      `SELECT '${kind}' AS kind, ${hour('createdAt')} AS createdAt,
              ${hour('deletedAt')} AS deletedAt, count(*) AS items,
              COALESCE(sum(${bytes}), 0) AS bytes
            FROM ${from} GROUP BY 2, 3 ORDER BY 2, 3`,
                  ).all() as unknown as SourceLifetime[])
                : [];
        return [
            ...grouped('datasets', 'data_datasets', '0'),
            ...grouped('files', 'data_files', 'storedSize'),
            ...grouped('attachments', 'media_attachments', 'size'),
            // A version lives as long as its app.
            ...(this.has('apps')
                ? grouped(
                      'apps',
                      'app_versions',
                      'sizeBytes',
                      '(SELECT v.createdAt, a.deletedAt, v.sizeBytes FROM app_versions v JOIN apps a ON a.id = v.appId)',
                  )
                : []),
        ];
    }

    socioNames() {
        if (!this.has('dots')) {
            return [];
        }
        return this.statement('SELECT id, name FROM dots ORDER BY id').all() as Array<{
            id: string;
            name: string;
        }>;
    }

    ownerFiles() {
        if (!this.has('data_files')) {
            return [];
        }
        return this.statement(
            `SELECT ownerUserId, count(*) AS files, COALESCE(sum(storedSize), 0) AS bytes, COALESCE(max(size), 0) AS largest
      FROM data_files WHERE deletedAt IS NULL GROUP BY ownerUserId ORDER BY ownerUserId`,
        ).all() as unknown as SourceOwnerFiles[];
    }

    databaseSize() {
        const pragma = (name: string) =>
            Number(Object.values((this.statement(`PRAGMA ${name}`).get() ?? {}) as Record<string, unknown>)[0] ?? 0);
        const pageSize = pragma('page_size');
        return {
            bytes: pragma('page_count') * pageSize,
            freeBytes: pragma('freelist_count') * pageSize,
        };
    }

    tableBytes(table: string) {
        const names = (
            this.statement("SELECT name FROM sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index')").all(
                table,
            ) as { name: string }[]
        ).map((row) => row.name);
        const size = this.statement(
            'SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ? AND aggregate = TRUE',
        );
        return names.reduce((total, name) => total + Number((size.get(name) as { bytes: number }).bytes), 0);
    }

    requests() {
        if (!this.has('dot_requests') || !this.has('dot_request_requesters')) {
            return [];
        }
        const issues = this.has('issues');
        return this.statement(
            `SELECT r.issueId, ${issues ? 'i.number, i.title, i.status' : 'NULL AS number, NULL AS title, NULL AS status'},
        r.capability, r.createdAt, count(q.id) AS requesters,
        count(DISTINCT q.dotId) AS socios, count(DISTINCT q.userId) AS people,
        COALESCE(max(q.createdAt), r.createdAt) AS lastAt
      FROM dot_requests r
      LEFT JOIN dot_request_requesters q ON q.issueId = r.issueId
      ${issues ? 'LEFT JOIN issues i ON i.id = r.issueId' : ''}
      ${issues ? 'WHERE i.deletedAt IS NULL' : ''}
      GROUP BY r.issueId ORDER BY r.issueId`,
        ).all() as unknown as SourceRequest[];
    }
}
