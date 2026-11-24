import type { DuckDBConnection } from '@duckdb/node-api';

import { FAILURE_CATEGORIES, type FailureCategory } from '@socio/shared/failure-taxonomy';
import { bucketStarts, type OpsFilters } from '@socio/shared/operations/operations';
import {
    BREAKDOWN_LIMIT,
    frictionFrom,
    FRICTION_LIMIT,
    FRICTION_PEOPLE,
    FRICTION_TIMES,
    type OpsBreakdownRow,
    type OpsFailureRow,
    type OpsFrictionRow,
    type OpsReliabilitySummary,
    type ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';

import { issueVelocity } from '../../domain/issue-velocity.js';
import type { OpsQueries } from '../../domain/ops-queries.js';

import { rows } from './open.js';
import { calendarTable, earliest, KEY_COLUMN, range, rollupMeta, Sql, turnFilters } from './sql.js';

/** A turn or tool call that failed: any category but Stopped. */
const FAILED = (column: string) => `(${column} IS NOT NULL AND ${column} <> 'stopped')`;
const CATEGORY_LIST = `[${FAILURE_CATEGORIES.map((category) => `'${category}'`).join(', ')}]`;

type ReliabilityQueries = Pick<
    OpsQueries,
    'reliability' | 'failureSeries' | 'failureBreakdown' | 'failures' | 'friction' | 'issueVelocity'
>;

/**
 * Reliability's SQL (CB-189), on a connection of the analytics process:
 * the failure taxonomy's categories the ETL keeps on `f_turn` and
 * `f_tool`. Turns are in a window by their start; their tool calls with
 * them. Answers as `MemoryOpsReader` does (`tests/operations-reliability`).
 */
export function reliabilityQueries(connection: DuckDBConnection): ReliabilityQueries {
    return {
        async reliability({ window, filters }) {
            const now = await summary(connection, filters, window.from, window.to);
            const before = window.previous
                ? await summary(connection, filters, window.previous.from, window.previous.to)
                : undefined;
            return {
                ...now,
                previousTurns: before?.turns ?? null,
                previousFailures: before?.failures ?? null,
            };
        },

        async failureSeries({ window, filters }) {
            const { bucket, timeZone, to } = window;
            const start = window.from ?? (await earliest(connection));
            if (start === null) {
                return [];
            }
            const starts = bucketStarts(start, to, bucket, timeZone);
            if (!starts.length) {
                return [];
            }
            const points = new Map(
                starts.map((at) => [
                    at,
                    {
                        at,
                        turns: 0,
                        failures: 0,
                        counts: FAILURE_CATEGORIES.map(() => 0),
                    },
                ]),
            );
            const calendar = await calendarTable(connection, window, await rollupMeta(connection), start, to);
            const sql = new Sql();
            const where = [...range(sql, 'started_at', start, to), ...turnFilters(sql, filters)];
            const key = KEY_COLUMN[bucket];
            const found = await rows<Record<string, number | bigint>>(
                connection,
                `SELECT c.${key} AS k, count(*) AS turns,
          count(*) FILTER (WHERE ${FAILED('f.cat')}) AS failures,
          ${FAILURE_CATEGORIES.map((category, i) => `count(*) FILTER (WHERE f.cat = '${category}') AS c${i}`).join(', ')}
        FROM (SELECT started_at AS ts, failure_category AS cat FROM f_turn
          WHERE ${where.join(' AND ')}) f
        ASOF JOIN ${calendar} c ON f.ts >= c.utc_at
        GROUP BY c.${key}`,
                sql.values,
            );
            for (const row of found) {
                const point = points.get(Number(row.k));
                if (!point) {
                    continue;
                }
                point.turns = Number(row.turns);
                point.failures = Number(row.failures);
                point.counts = FAILURE_CATEGORIES.map((_, i) => Number(row[`c${i}`]));
            }
            return [...points.values()];
        },

        failureBreakdown: ({ window, filters, by }) => breakdown(connection, filters, window.from, window.to, by),

        async failures(params) {
            const { window, filters, cursor, limit, category, tool } = params;
            const sql = new Sql();
            const where = [...range(sql, 't.started_at', window.from, window.to), ...turnFilters(sql, filters, 't.')];
            const outer: string[] = [];
            if (category) {
                outer.push(`category = ${sql.text(category)}`);
            }
            if (tool) {
                outer.push(`EXISTS (SELECT 1 FROM ft x WHERE x.run_seq = seq AND x.tool = ${sql.text(tool)})`);
            }
            if (cursor) {
                if (typeof cursor.key !== 'number') {
                    return { items: [], next: null };
                }
                const key = sql.int(cursor.key);
                outer.push(`(started_at < ${key} OR (started_at = ${key} AND run_id < ${sql.text(cursor.id)}))`);
            }
            const found = await rows<{
                seq: number;
                run_id: string;
                thread_id: string;
                socio_id: string | null;
                socio_name: string | null;
                source: string;
                status: OpsFailureRow['status'];
                started_at: number;
                finished_at: number | null;
                level: 'turn' | 'tool';
                category: FailureCategory;
                rule: string;
                code: string | null;
                end_reason: string | null;
                model: string | null;
                tool: string | null;
                tool_failures: number;
            }>(
                connection,
                `WITH t AS (
          SELECT t.* FROM f_turn t WHERE ${where.join(' AND ')}
        ), ft AS (
          SELECT run_seq, tool, code, category, category_rule,
            row_number() OVER (PARTITION BY run_seq ORDER BY idx) AS r,
            count(*) OVER (PARTITION BY run_seq) AS n
          FROM f_tool WHERE run_seq IN (SELECT seq FROM t) AND ${FAILED('category')}
        ), f AS (
          SELECT t.seq, t.run_id, t.thread_id, t.socio_id, t.source, t.status,
            t.started_at, t.finished_at, t.end_reason, t.model,
            ${FAILED('t.failure_category')} AS turn_failed,
            CASE WHEN ${FAILED('t.failure_category')} THEN 'turn' ELSE 'tool' END AS level,
            CASE WHEN ${FAILED('t.failure_category')} THEN t.failure_category ELSE ft.category END AS category,
            CASE WHEN ${FAILED('t.failure_category')} THEN t.failure_rule ELSE ft.category_rule END AS rule,
            CASE WHEN ${FAILED('t.failure_category')} THEN t.failure_code ELSE ft.code END AS code,
            ft.tool, COALESCE(ft.n, 0)::INTEGER AS tool_failures
          FROM t LEFT JOIN ft ON ft.run_seq = t.seq AND ft.r = 1
          WHERE ${FAILED('t.failure_category')} OR ft.run_seq IS NOT NULL
        )
        SELECT f.*, s.name AS socio_name FROM f LEFT JOIN d_socio s ON s.id = f.socio_id
        ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
        ORDER BY started_at DESC, run_id DESC
        LIMIT ${limit + 1}`,
                sql.values,
            );
            const items = found.slice(0, limit).map((row): OpsFailureRow => ({
                runId: row.run_id,
                threadId: row.thread_id,
                socioId: row.socio_id ?? '',
                socioName: row.socio_name,
                source: row.source,
                status: row.status,
                startedAt: row.started_at,
                finishedAt: row.finished_at,
                level: row.level,
                category: row.category,
                rule: row.rule,
                code: row.code,
                endReason: row.end_reason,
                model: row.model,
                tool: row.tool,
                toolFailures: row.tool_failures,
            }));
            const last = items.at(-1);
            return {
                items,
                next: found.length > limit && last ? { key: last.startedAt, id: last.runId } : null,
            };
        },

        async friction({ window, filters }) {
            const from = frictionFrom(window);
            const sql = new Sql();
            const where = [
                ...range(sql, 't.started_at', from, window.to),
                ...turnFilters(sql, filters, 't.'),
                `t.trigger_kind = 'person'`,
                't.trigger_id IS NOT NULL',
            ].join(' AND ');
            const found = await rows<{
                category: FailureCategory;
                code: string | null;
                tool: string | null;
                people: number;
                failures: number;
                most: number;
                last_at: number;
            }>(
                connection,
                `WITH f AS (
          SELECT t.failure_category AS cat, t.failure_code AS code, NULL::VARCHAR AS tool,
            t.trigger_id AS person, t.started_at AS ts
          FROM f_turn t WHERE ${where} AND ${FAILED('t.failure_category')}
          UNION ALL
          SELECT x.category, x.code, x.tool, t.trigger_id, x.started_at
          FROM f_tool x JOIN f_turn t ON t.seq = x.run_seq
          WHERE ${where} AND ${FAILED('x.category')}
        ), p AS (
          SELECT cat, code, tool, person, count(*) AS n, max(ts) AS last_at
          FROM f GROUP BY cat, code, tool, person
        )
        SELECT cat AS category, code, tool, count(*)::INTEGER AS people,
          sum(n)::INTEGER AS failures, max(n)::INTEGER AS most, max(last_at) AS last_at
        FROM p GROUP BY cat, code, tool
        HAVING count(*) >= ${FRICTION_PEOPLE} OR max(n) >= ${FRICTION_TIMES}
        ORDER BY people DESC, failures DESC, last_at DESC, category,
          code NULLS FIRST, tool NULLS FIRST
        LIMIT ${FRICTION_LIMIT}`,
                sql.values,
            );
            return {
                from,
                rows: found.map((row): OpsFrictionRow => ({
                    category: row.category,
                    code: row.code,
                    tool: row.tool,
                    people: row.people,
                    failures: row.failures,
                    mostForOne: row.most,
                    lastAt: row.last_at,
                })),
            };
        },

        async issueVelocity(scope) {
            const issues = await rows<{
                kind: string;
                reporter_id: string;
                created_at: number;
                closed_at: number | null;
            }>(connection, 'SELECT kind, reporter_id, created_at, closed_at FROM f_issue WHERE deleted_at IS NULL');
            // Failed turns filed about from Runs (CB-194).
            const reports = await rows<{
                reporter_id: string;
                failed_at: number;
                reported_at: number;
            }>(
                connection,
                `SELECT i.reporter_id, t.finished_at AS failed_at, i.created_at AS reported_at
        FROM f_issue_run r
        JOIN f_issue i ON i.id = r.issue_id AND i.deleted_at IS NULL
        JOIN f_turn t ON t.run_id = r.run_id
        WHERE r.via = 'report' AND t.status = 'failed' AND t.finished_at IS NOT NULL`,
            );
            return issueVelocity(
                issues.map((issue) => ({
                    kind: issue.kind,
                    reporterId: issue.reporter_id,
                    createdAt: issue.created_at,
                    closedAt: issue.closed_at,
                })),
                scope,
                reports.map((report) => ({
                    reporterId: report.reporter_id,
                    failedAt: report.failed_at,
                    reportedAt: report.reported_at,
                })),
            );
        },
    };
}

/** The totals of one period. */
async function summary(
    connection: DuckDBConnection,
    filters: OpsFilters,
    from: number | null,
    to: number,
): Promise<Omit<OpsReliabilitySummary, 'previousTurns' | 'previousFailures'>> {
    const sql = new Sql();
    const where = [...range(sql, 'started_at', from, to), ...turnFilters(sql, filters)];
    const [row] = await rows<Record<string, number | null>>(
        connection,
        `WITH t AS (
        SELECT seq, status, failure_category, retries, fallback_reason
        FROM f_turn WHERE ${where.join(' AND ')}
      ), tl AS (
        SELECT category FROM f_tool WHERE run_seq IN (SELECT seq FROM t)
      )
      SELECT
        (SELECT count(*) FROM t) AS turns,
        (SELECT count(*) FROM t WHERE ${FAILED('failure_category')}) AS failures,
        (SELECT count(*) FROM t WHERE failure_category = 'stopped') AS stopped,
        (SELECT count(*) FROM t WHERE status = 'interrupted' AND ${FAILED('failure_category')}) AS interrupted,
        (SELECT COALESCE(sum(retries), 0)::BIGINT FROM t) AS retries,
        (SELECT count(*) FROM t WHERE retries > 0) AS retried_turns,
        (SELECT count(*) FROM t WHERE fallback_reason IS NOT NULL) AS fallbacks,
        (SELECT count(*) FROM tl) AS tool_calls,
        (SELECT count(*) FROM tl WHERE ${FAILED('category')}) AS tool_failures`,
        sql.values,
    );
    const sqlCats = new Sql();
    const whereCats = [...range(sqlCats, 'started_at', from, to), ...turnFilters(sqlCats, filters)];
    const counts = await rows<{ cat: string; turns: number; tools: number }>(
        connection,
        `WITH t AS (SELECT seq, failure_category FROM f_turn WHERE ${whereCats.join(' AND ')})
    SELECT cat, sum(turns)::INTEGER AS turns, sum(tools)::INTEGER AS tools FROM (
      SELECT failure_category AS cat, 1 AS turns, 0 AS tools FROM t WHERE failure_category IS NOT NULL
      UNION ALL
      SELECT category, 0, 1 FROM f_tool WHERE run_seq IN (SELECT seq FROM t) AND category IS NOT NULL
    ) GROUP BY cat`,
        sqlCats.values,
    );
    const byCategory = new Map(counts.map((count) => [count.cat, count]));
    return {
        turns: Number(row!.turns),
        failures: Number(row!.failures),
        stopped: Number(row!.stopped),
        interrupted: Number(row!.interrupted),
        retries: Number(row!.retries),
        retriedTurns: Number(row!.retried_turns),
        fallbacks: Number(row!.fallbacks),
        toolCalls: Number(row!.tool_calls),
        toolFailures: Number(row!.tool_failures),
        categories: FAILURE_CATEGORIES.map((category) => ({
            category,
            turns: byCategory.get(category)?.turns ?? 0,
            tools: byCategory.get(category)?.tools ?? 0,
        })),
    };
}

/** What each breakdown groups, from which facts. */
function breakdownRows(by: ReliabilityDimension, turns: string) {
    const failed = FAILED('failure_category');
    const ms = 'finished_at - started_at';
    switch (by) {
        case 'tool':
            return `SELECT tool AS key, category AS cat, code, duration_ms AS ms,
          ${FAILED('category')} AS fail
        FROM f_tool WHERE run_seq IN (SELECT seq FROM (${turns}))`;
        case 'code':
            return `SELECT COALESCE(failure_code, '') AS key, failure_category AS cat,
          failure_code AS code, ${ms} AS ms, true AS fail
        FROM (${turns}) WHERE ${failed}`;
        case 'socio':
        case 'model':
        case 'source': {
            const column = by === 'socio' ? 'socio_id' : by === 'model' ? 'model' : 'source';
            return `SELECT COALESCE(${column}, '') AS key, failure_category AS cat,
          failure_code AS code, ${ms} AS ms, ${failed} AS fail
        FROM (${turns})`;
        }
    }
}

async function breakdown(
    connection: DuckDBConnection,
    filters: OpsFilters,
    from: number | null,
    to: number,
    by: ReliabilityDimension,
): Promise<OpsBreakdownRow[]> {
    const sql = new Sql();
    const where = [...range(sql, 'started_at', from, to), ...turnFilters(sql, filters)];
    const turns = `SELECT * FROM f_turn WHERE ${where.join(' AND ')}`;
    const found = await rows<{
        key: string;
        label: string | null;
        total: number;
        failed: number;
        category: FailureCategory | null;
        code: string | null;
        p50: number | null;
        p95: number | null;
    }>(
        connection,
        `WITH x AS (${breakdownRows(by, turns)}),
    g AS (
      SELECT key, count(*)::INTEGER AS total, count(*) FILTER (WHERE fail)::INTEGER AS failed,
        quantile_disc(ms, 0.5) AS p50, quantile_disc(ms, 0.95) AS p95
      FROM x GROUP BY key
    ), c AS (
      SELECT key, cat, row_number() OVER (PARTITION BY key
        ORDER BY count(*) DESC, list_position(${CATEGORY_LIST}, cat)) AS r
      FROM x WHERE fail GROUP BY key, cat
    ), k AS (
      SELECT key, code, row_number() OVER (PARTITION BY key ORDER BY count(*) DESC, code) AS r
      FROM x WHERE fail AND code IS NOT NULL GROUP BY key, code
    )
    SELECT g.key, ${by === 'socio' ? 's.name' : 'NULL'} AS label, g.total, g.failed,
      c.cat AS category, k.code, g.p50, g.p95
    FROM g LEFT JOIN c ON c.key = g.key AND c.r = 1
      LEFT JOIN k ON k.key = g.key AND k.r = 1
      ${by === 'socio' ? 'LEFT JOIN d_socio s ON s.id = g.key' : ''}
    ORDER BY g.failed DESC, g.total DESC, g.key
    LIMIT ${BREAKDOWN_LIMIT}`,
        sql.values,
    );
    return found.map((row) => ({
        key: row.key,
        label: row.label,
        total: row.total,
        failed: row.failed,
        category: row.category,
        code: row.code,
        p50Ms: row.p50 === null ? null : Number(row.p50),
        p95Ms: row.p95 === null ? null : Number(row.p95),
    }));
}
