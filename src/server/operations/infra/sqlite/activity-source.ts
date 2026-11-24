import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type {
    ActivitySourceReader,
    Keyset,
    SourceApproval,
    SourceMemory,
    SourcePage,
    SourceReaction,
    SourceRevision,
} from '../../etl/activity-source.js';

const readers = new WeakMap<DatabaseSync, SqliteActivitySource>();

/**
 * The Activity ETL's reads of the app's database (CB-190), on the
 * analytics process's read-only connection: each one statement, so one
 * short read transaction. A table the app hasn't made yet reads as null.
 */
export function sqliteActivitySource(db: DatabaseSync): ActivitySourceReader {
    let reader = readers.get(db);
    if (!reader) {
        readers.set(db, (reader = new SqliteActivitySource(db)));
    }
    return reader;
}

class SqliteActivitySource implements ActivitySourceReader {
    private statements = new Map<string, StatementSync>();
    constructor(private db: DatabaseSync) {}

    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) {
            this.statements.set(sql, (statement = this.db.prepare(sql)));
        }
        return statement;
    }
    private has(table: string) {
        return !!this.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }

    approvalsAfter([at, id]: Keyset, limit: number) {
        if (!this.has('approval_audit') || !this.has('approval_requests')) {
            return null;
        }
        return this.statement(
            `SELECT a.id, a.createdAt, a.requestId, r.threadId, a.dotId, a.userId,
        a.capability, a.event
      FROM approval_audit a LEFT JOIN approval_requests r ON r.id = a.requestId
      WHERE a.createdAt > ? OR (a.createdAt = ? AND a.id > ?)
      ORDER BY a.createdAt, a.id LIMIT ?`,
        ).all(at, at, id, limit) as unknown as SourceApproval[];
    }

    revisionsAfter(id: number, limit: number) {
        if (!this.has('page_revisions')) {
            return null;
        }
        return this.statement(
            `SELECT id, pageId, spaceId, authorId, replacedAt FROM page_revisions
      WHERE id > ? ORDER BY id LIMIT ?`,
        ).all(id, limit) as unknown as SourceRevision[];
    }

    pagesAfter([at, id]: Keyset, limit: number) {
        if (!this.has('pages')) {
            return null;
        }
        const reviewed = this.has('page_reviews') ? 'p.id IN (SELECT pageId FROM page_reviews)' : '0';
        return this.statement(
            `SELECT p.id, p.spaceId, p.createdAt, p.createdBy, p.sourceThreadId,
        b.dotId AS socioId, ${reviewed} AS reviewed
      FROM pages p LEFT JOIN thread_bindings b ON b.id = p.sourceThreadId
      WHERE p.createdAt > ? OR (p.createdAt = ? AND p.id > ?)
      ORDER BY p.createdAt, p.id LIMIT ?`,
        ).all(at, at, id, limit) as unknown as SourcePage[];
    }

    reactionsPrint() {
        if (!this.has('message_reactions')) {
            return null;
        }
        return JSON.stringify(
            this.statement(
                'SELECT count(*) AS n, total(createdAt) AS t, max(createdAt) AS m FROM message_reactions',
            ).get(),
        );
    }

    reactions() {
        if (!this.has('message_reactions')) {
            return [];
        }
        return this.statement(
            `SELECT threadId, messageId, userId, kind, createdAt FROM message_reactions
      ORDER BY threadId, messageId, userId, kind`,
        ).all() as unknown as SourceReaction[];
    }

    memoriesPrint() {
        if (!this.has('memories')) {
            return null;
        }
        return JSON.stringify(
            this.statement(
                `SELECT count(*) AS n, total(createdAt) AS t, total(confirmedAt) AS c,
          total(deletedAt) AS d, sum(status = 'active') AS a
        FROM memories WHERE threadId IS NOT NULL`,
            ).get(),
        );
    }

    memories() {
        if (!this.has('memories')) {
            return [];
        }
        return this.statement(
            `SELECT id, threadId, userId, status, createdAt, confirmedAt, deletedAt
      FROM memories WHERE threadId IS NOT NULL ORDER BY id`,
        ).all() as unknown as SourceMemory[];
    }
}
