import { createHash } from 'node:crypto';

import type { DuckDBConnection } from '@duckdb/node-api';

import type { EtlContext, EtlStep } from '../infra/duckdb/etl.js';
import { sqliteGroundingSource } from '../infra/sqlite/grounding-source.js';

import { append } from './append.js';
import { ETL_BATCH } from './source-reader.js';

const DAY = 86_400_000;

/**
 * The analytics store's grounding tables (CB-194), beside CB-187's: what
 * each turn read (`f_run_ref`: ids, kind and Space, never content) and
 * the turns items were filed from (`f_issue_run`). A change here needs
 * `ETL_VERSION` bumped (`analytics/steps.ts`).
 */
export const RUN_REF_DDL = [
    `CREATE TABLE f_run_ref (id BIGINT NOT NULL, run_id VARCHAR NOT NULL, thread_id VARCHAR NOT NULL, kind VARCHAR NOT NULL, space_id VARCHAR, ref_id VARCHAR NOT NULL, ref_at BIGINT NOT NULL)`,
];
export const ISSUE_RUN_DDL = [
    `CREATE TABLE f_issue_run (issue_id VARCHAR NOT NULL, run_id VARCHAR NOT NULL, thread_id VARCHAR NOT NULL, via VARCHAR NOT NULL, linked_at BIGINT NOT NULL)`,
];

/** Fact retention (`factDays`), as the turns' facts have it. */
async function prune(duck: DuckDBConnection, context: EtlContext) {
    const days = context.settings.factDays;
    if (days) {
        await duck.run('DELETE FROM f_run_ref WHERE ref_at < $1', [context.now - days * DAY]);
    }
}

/**
 * What grounded each turn (CB-194): `run_refs` is append-only with an
 * integer key, read by it in batches; each batch deletes its key range
 * first, so running it again changes nothing. Rows older than `factDays`
 * go, as the turns' facts do.
 */
export const runRefsStep: EtlStep = {
    source: 'run_refs',
    ddl: RUN_REF_DDL,
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteGroundingSource(sqlite);
        const after = Number(watermark ?? 0) || 0;
        const refs = reader.runRefsAfter(after, ETL_BATCH);
        if (!refs.length) {
            await prune(duck, context);
            return { caughtUp: true };
        }
        const last = refs.at(-1)!.id;
        await duck.run('DELETE FROM f_run_ref WHERE id > $1 AND id <= $2', [BigInt(after), BigInt(last)]);
        await append(
            duck,
            'f_run_ref',
            refs.map((ref) => [ref.id, ref.runId, ref.threadId, ref.kind, ref.spaceId, ref.refId, ref.at]),
        );
        await prune(duck, context);
        const top = reader.lastRunRefId();
        return {
            watermark: String(last),
            caughtUp: refs.length < ETL_BATCH,
            progress: top ? Math.min(1, last / top) : 1,
        };
    },
};

/**
 * The turns items were filed from (CB-194): a small table, read whole
 * each cycle and written when it changed (the watermark is its hash), as
 * the board's items are.
 */
export const issueRunsStep: EtlStep = {
    source: 'issue_runs',
    ddl: ISSUE_RUN_DDL,
    async batch({ sqlite, duck, watermark }) {
        const read = sqliteGroundingSource(sqlite).issueRuns();
        const hash = createHash('sha256').update(JSON.stringify(read)).digest('base64url').slice(0, 22);
        if (hash === watermark || (!read.length && watermark === null)) {
            return { caughtUp: true };
        }
        await duck.run('DELETE FROM f_issue_run');
        await append(
            duck,
            'f_issue_run',
            read.map((link) => [link.issueId, link.runId, link.threadId, link.via, link.createdAt]),
        );
        return { watermark: hash, caughtUp: true };
    },
};

/** The grounding steps, in `ETL_STEPS` order. */
export const GROUNDING_STEPS: readonly EtlStep[] = [runRefsStep, issueRunsStep];
