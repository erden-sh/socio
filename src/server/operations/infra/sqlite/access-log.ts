import { and, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';

import type { AccessSubject } from '../../contract.js';
import type { AccessEntry, AccessLogRepository } from '../../domain/access-log.js';
import type { OpsPageRequest } from '../../domain/reader.js';

import { accessLog } from './schema.js';

type Row = typeof accessLog.$inferSelect;

/** Keys in one order, so equal filters are stored, and compared, as equal text. */
const canonical = (filters: Record<string, string>) =>
    Object.fromEntries(Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const entryOf = (row: Row): AccessEntry => ({
    id: row.id,
    at: row.at,
    viewerId: row.viewerId,
    surface: row.surface,
    subject: (row.subjectKind === 'workspace'
        ? { kind: 'workspace', id: null }
        : { kind: row.subjectKind, id: row.subjectId ?? '' }) as AccessSubject,
    content: row.content,
    filters: row.filters,
    requestId: row.requestId,
});

/**
 * The access log on the workspace connection (CB-188). Writes go through
 * the connection's unit of work, so one from a route never lands inside
 * another chain's open unit; reads are one statement on its index.
 */
export class SqliteAccessLog implements AccessLogRepository {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    record(entry: AccessEntry, options: { unlessSince?: number } = {}) {
        const filters = canonical(entry.filters);
        return this.data.uow.run(
            async () => {
                if (options.unlessSince !== undefined) {
                    const seen = await this.db
                        .select({ id: accessLog.id })
                        .from(accessLog)
                        .where(
                            and(
                                eq(accessLog.viewerId, entry.viewerId),
                                eq(accessLog.surface, entry.surface),
                                gte(accessLog.at, options.unlessSince),
                                eq(accessLog.subjectKind, entry.subject.kind),
                                entry.subject.id === null
                                    ? isNull(accessLog.subjectId)
                                    : eq(accessLog.subjectId, entry.subject.id),
                                eq(accessLog.filters, filters),
                            ),
                        )
                        .limit(1)
                        .get();
                    if (seen) {
                        return false;
                    }
                }
                await this.db.insert(accessLog).values({
                    id: entry.id,
                    at: entry.at,
                    viewerId: entry.viewerId,
                    surface: entry.surface,
                    subjectKind: entry.subject.kind,
                    subjectId: entry.subject.id,
                    content: entry.content,
                    filters,
                    requestId: entry.requestId,
                });
                return true;
            },
            { label: 'record access' },
        );
    }

    async page({ cursor, limit }: OpsPageRequest) {
        const rows = await this.db
            .select()
            .from(accessLog)
            .where(
                cursor
                    ? or(
                          lt(accessLog.at, Number(cursor.key)),
                          and(eq(accessLog.at, Number(cursor.key)), lt(accessLog.id, cursor.id)),
                      )
                    : undefined,
            )
            .orderBy(desc(accessLog.at), desc(accessLog.id))
            .limit(limit + 1);
        const items = rows.slice(0, limit).map(entryOf);
        const last = items.at(-1);
        return {
            items,
            next: rows.length > limit && last ? { key: last.at, id: last.id } : null,
        };
    }
}

/** Operations' SQLite repositories on a migrated connection. */
export const sqliteOperationsRepositories = (data: SqliteData) => ({
    accessLog: new SqliteAccessLog(data),
});
