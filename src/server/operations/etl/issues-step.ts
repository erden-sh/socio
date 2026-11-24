import { createHash } from 'node:crypto';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { sqliteSourceReader } from '../infra/sqlite/source-reader.js';

import { append } from './append.js';
import { ETL_BATCH, type SourceIssue } from './source-reader.js';

/**
 * The Improvements board's items (CB-189), for Reliability's reporting
 * and resolution velocity: when each was filed and closed, its kind,
 * priority and reporter; never its title or text. Deleted ones keep
 * their row with `deleted_at`, which the queries leave out.
 */
export const ISSUE_DDL = `CREATE TABLE f_issue (
  id VARCHAR NOT NULL,
  number INTEGER NOT NULL,
  kind VARCHAR NOT NULL,
  priority VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  reporter_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  closed_at BIGINT,
  deleted_at BIGINT
)`;

/**
 * A small table, read whole each cycle (a soft delete doesn't move its
 * `updatedAt`), `ETL_BATCH` rows a statement in one short read
 * transaction, and written only when it changed: the watermark is a hash
 * of what was read, as the dimensions'.
 */
export const issuesStep: EtlStep = {
    source: 'issues',
    ddl: [ISSUE_DDL],
    async batch({ sqlite, duck, watermark }) {
        const reader = sqliteSourceReader(sqlite);
        const issues: SourceIssue[] = [];
        sqlite.exec('BEGIN');
        try {
            for (;;) {
                const page = reader.issuesAfter(issues.at(-1)?.number ?? 0, ETL_BATCH);
                issues.push(...page);
                if (page.length < ETL_BATCH) {
                    break;
                }
            }
        } finally {
            sqlite.exec('COMMIT');
        }
        const hash = createHash('sha256').update(JSON.stringify(issues)).digest('base64url').slice(0, 22);
        if (hash === watermark) {
            return { caughtUp: true };
        }
        await duck.run('DELETE FROM f_issue');
        await append(
            duck,
            'f_issue',
            issues.map((issue) => [
                issue.id,
                issue.number,
                issue.kind,
                issue.priority,
                issue.status,
                issue.reporterId,
                issue.createdAt,
                issue.closedAt,
                issue.deletedAt,
            ]),
        );
        return { watermark: hash, caughtUp: true };
    },
};
