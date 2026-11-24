import { sqliteTable, primaryKey } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import { ACCESS_SUBJECT_KINDS } from '@socio/shared/operations/operations-access';

/**
 * Operations' tables (CB-110), as `operations/migrations.ts` makes them:
 * the typed mirror the repositories query. The migrations stay the source
 * of truth; tests/operations-access.test.ts holds these to them.
 */

export const accessLog = sqliteTable('access_log', {
    id: id().primaryKey(),
    at: ms().notNull(),
    viewerId: str().notNull(),
    surface: str().notNull(),
    subjectKind: enumText(ACCESS_SUBJECT_KINDS).notNull(),
    subjectId: str(),
    content: flag().notNull(),
    filters: json<Record<string, string>>().notNull(),
    requestId: str().notNull(),
});

/** Every table Operations owns in SQLite, for the drift test. */
export const opsSamples = sqliteTable(
    'ops_samples',
    {
        scopeId: str().notNull(),
        at: ms().notNull(),
        data: json<Record<string, number | null>>().notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeId, table.at] })],
);
export const opsSamplesHourly = sqliteTable(
    'ops_samples_hourly',
    {
        scopeId: str().notNull(),
        at: ms().notNull(),
        samples: int().notNull(),
        data: json<Record<string, number | null>>().notNull(),
        observedAt: json<Record<string, number | null>>().notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeId, table.at] })],
);
export const operationsTables = [accessLog, opsSamples, opsSamplesHourly] as const;
