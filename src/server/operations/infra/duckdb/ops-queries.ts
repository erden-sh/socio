import type { DuckDBConnection } from '@duckdb/node-api';

import {
    bucketStarts,
    nextBucket,
    OPS_TILES,
    type OpsFilters,
    type OpsMetric,
    type OpsPoint,
    type OpsTile,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';

import type { EngineStatus } from '../../analytics/ipc.js';
import type { OpsQueries, OpsQueryParams } from '../../domain/ops-queries.js';
import { themesQueries } from '../../themes/duckdb.js';

import { activityQueries } from './activity.js';
import { costQueries } from './cost.js';
import { groundingOpsQueries } from './grounding-queries.js';
import { duckHealthQueries } from './health-queries.js';
import { knowledgeOpsQueries } from './knowledge-queries.js';
import { rows } from './open.js';
import { reliabilityQueries } from './reliability.js';
import {
    calendarTable,
    earliest,
    factSpan,
    KEY_COLUMN,
    messageFilters,
    range,
    rollupFilters,
    rollupMeta,
    Sql,
    turnFilters,
} from './sql.js';

/**
 * The analytics SQL (CB-164: not Drizzle), on one connection of the
 * analytics process; never on the app's event loop. The Overview's
 * queries (CB-187) answer as CB-184's `OpsReader` rules say: windows are
 * `from` inclusive, `to` exclusive, buckets cut in `window.timeZone`.
 * Tiles and lists read the facts; a series reads the rollups for the
 * buckets that lie whole in the window (and in the rollups' time zone and
 * retention), and the facts for the rest, such as a range's first and
 * last hours.
 */
export function duckOpsQueries(
    connection: DuckDBConnection,
    status: () => EngineStatus = () => ({ state: 'ready' }),
): OpsQueries {
    return {
        async freshness() {
            const sources = await rows<{
                source: string;
                watermark: string | null;
                at: number;
            }>(connection, 'SELECT source, watermark, "at" FROM etl_state ORDER BY source');
            const [meta] = await rows<{ value: string }>(connection, `SELECT value FROM ops_meta WHERE key = 'as_of'`);
            return { asOf: meta ? Number(meta.value) : null, sources };
        },

        async status() {
            const engine = status();
            const [meta] = await rows<{ value: string }>(connection, `SELECT value FROM ops_meta WHERE key = 'as_of'`);
            const asOf = engine.asOf ?? (meta ? Number(meta.value) : null);
            return {
                state: engine.state,
                asOf: asOf ?? null,
                earliest: await earliest(connection),
                ...(engine.state === 'rebuilding' && engine.progress !== undefined
                    ? { progress: engine.progress }
                    : {}),
            };
        },

        async overview(scope) {
            const { from, to, previous } = scope.window;
            const now = await tiles(connection, scope.filters, from, to);
            const before = previous ? await tiles(connection, scope.filters, previous.from, previous.to) : undefined;
            return OPS_TILES.map((id): OpsTile => ({
                id,
                value: now[id],
                previous: before ? before[id] : null,
            }));
        },

        series: (params) => series(connection, params),

        ...reliabilityQueries(connection),
        ...activityQueries(connection),

        async turns(params) {
            const { window, filters, cursor, limit } = params;
            const sql = new Sql();
            const where = [...range(sql, 't.started_at', window.from, window.to), ...turnFilters(sql, filters, 't.')];
            if (cursor) {
                // Keyset, newest first: after the cursor's (startedAt, runId).
                if (typeof cursor.key !== 'number') {
                    return { items: [], next: null };
                }
                const key = sql.int(cursor.key);
                where.push(`(t.started_at < ${key} OR (t.started_at = ${key} AND t.run_id < ${sql.text(cursor.id)}))`);
            }
            const found = await rows<{
                run_id: string;
                thread_id: string;
                socio_id: string | null;
                socio_name: string | null;
                source: string;
                status: OpsTurnRow['status'];
                started_at: number;
                finished_at: number | null;
                tokens: number;
                tool_calls: number;
                tool_errors: number;
            }>(
                connection,
                `SELECT t.run_id, t.thread_id, t.socio_id, s.name AS socio_name, t.source,
          t.status, t.started_at, t.finished_at,
          (COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0))::BIGINT AS tokens,
          t.tool_calls, t.tool_errors
        FROM f_turn t LEFT JOIN d_socio s ON s.id = t.socio_id
        WHERE ${where.join(' AND ') || 'true'}
        ORDER BY t.started_at DESC, t.run_id DESC
        LIMIT ${limit + 1}`,
                sql.values,
            );
            const items = found.slice(0, limit).map((row): OpsTurnRow => ({
                runId: row.run_id,
                threadId: row.thread_id,
                socioId: row.socio_id ?? '',
                socioName: row.socio_name,
                source: row.source,
                status: row.status,
                startedAt: row.started_at,
                finishedAt: row.finished_at,
                tokens: row.tokens,
                toolCalls: row.tool_calls,
                toolErrors: row.tool_errors,
            }));
            const last = items.at(-1);
            return {
                items,
                next: found.length > limit && last ? { key: last.startedAt, id: last.runId } : null,
            };
        },

        // Health (CB-192).
        ...duckHealthQueries(connection),
        // Knowledge, storage and capabilities (CB-191).
        ...knowledgeOpsQueries(connection),
        // Grounding and report links (CB-194).
        ...groundingOpsQueries(connection),
        // Cost (CB-195, CB-196).
        ...costQueries(connection),
        ...themesQueries(connection),
    };
}

/** The tiles over one period, from the facts. */
async function tiles(
    connection: DuckDBConnection,
    filters: OpsFilters,
    from: number | null,
    to: number,
): Promise<Record<(typeof OPS_TILES)[number], number>> {
    const sql = new Sql();
    const turns = [...range(sql, 'started_at', from, to), ...turnFilters(sql, filters)];
    const messages = [...range(sql, 'sent_at', from, to), ...messageFilters(sql, filters)];
    const [row] = await rows<Record<(typeof OPS_TILES)[number], number>>(
        connection,
        `WITH t AS (
        SELECT thread_id, status, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens
        FROM f_turn WHERE ${turns.join(' AND ')}
      ), m AS (
        SELECT thread_id, author_id FROM f_message WHERE ${messages.join(' AND ')}
      )
      SELECT
        (SELECT count(*) FROM t) AS turns,
        (SELECT count(*) FROM t WHERE status = 'failed') AS failed,
        (SELECT count(DISTINCT author_id) FROM m) AS people,
        (SELECT count(*) FROM m) AS messages,
        (SELECT count(DISTINCT thread_id) FROM (SELECT thread_id FROM t UNION ALL SELECT thread_id FROM m)) AS chats,
        (SELECT COALESCE(sum(tokens), 0)::BIGINT FROM t) AS tokens`,
        sql.values,
    );
    return row!;
}

/** How each metric adds up, over rollup rows and over facts. */
const ROLLUP_VALUE: Record<OpsMetric, string> = {
    turns: 'sum(turns)',
    failed: 'sum(failed)',
    tokens: 'sum(tokens)',
    messages: 'sum(messages)',
    people: 'count(DISTINCT person_id) FILTER (WHERE messages > 0)',
};

const DAY = 86_400_000;

async function series(
    connection: DuckDBConnection,
    { window, filters, metric }: OpsQueryParams<'series'>,
): Promise<OpsPoint[]> {
    const { bucket, timeZone, to } = window;
    const start = window.from ?? (await earliest(connection));
    if (start === null) {
        return [];
    }
    const starts = bucketStarts(start, to, bucket, timeZone);
    if (!starts.length) {
        return [];
    }
    const values = new Map(starts.map((at) => [at, 0]));
    const meta = await rollupMeta(connection);
    const rolled = meta.rollup_tz === timeZone;
    const hourlyFrom = Number(meta.hourly_from ?? Infinity);
    const key = KEY_COLUMN[bucket];

    // The buckets the rollups answer: inside the window, kept, and whole:
    // by the calendar, every instant from the bucket's start to the next is
    // in it and no other is (a clock change can stretch or shrink one).
    const covered: number[] = [];
    const spans: [number, number][] = [];
    const whole = new Map<number, { lo: number; hi: number | null }>();
    if (rolled) {
        const sql = new Sql();
        for (const row of await rows<{ k: number; lo: number; hi: number | null }>(
            connection,
            `SELECT k, min(utc_at) AS lo, max(nxt) AS hi FROM (
        SELECT ${key} AS k, utc_at, lead(utc_at) OVER (ORDER BY utc_at) AS nxt
        FROM d_calendar WHERE utc_at >= ${sql.int(starts[0]! - 2 * DAY)} AND utc_at < ${sql.int(to + 2 * DAY)}
      ) GROUP BY k`,
            sql.values,
        )) {
            whole.set(row.k, row);
        }
    }
    if (rolled) {
        for (const at of starts) {
            const next = nextBucket(at, bucket, timeZone);
            const span = whole.get(at);
            if (
                at >= start &&
                next <= to &&
                (bucket !== 'hour' || at >= hourlyFrom) &&
                span?.lo === at &&
                span.hi === next
            ) {
                covered.push(at);
                const last = spans.at(-1);
                if (last && last[1] === at) {
                    last[1] = next;
                } else {
                    spans.push([at, next]);
                }
            }
        }
    }
    if (covered.length) {
        const sql = new Sql();
        const where = [`${key} IN (SELECT unnest(${sql.ints(covered)}))`, ...rollupFilters(sql, filters)];
        for (const row of await rows<{ k: number; v: number | bigint }>(
            connection,
            `SELECT ${key} AS k, (${ROLLUP_VALUE[metric]})::BIGINT AS v
      FROM ${bucket === 'hour' ? 'r_hourly' : 'r_daily'}
      WHERE ${where.join(' AND ')} GROUP BY ${key}`,
            sql.values,
        )) {
            if (values.has(row.k)) {
                values.set(row.k, Number(row.v));
            }
        }
    }

    // The rest of the window from the facts, bucketed by the calendar; only
    // where there are facts.
    const facts = await factSpan(connection);
    const gaps: [number, number][] = [];
    let at = Math.max(window.from ?? start, facts?.lo ?? to);
    const end = Math.min(to, (facts?.hi ?? 0) + 1);
    for (const [lo, hi] of spans) {
        if (lo > at && at < end) {
            gaps.push([at, Math.min(lo, end)]);
        }
        at = Math.max(at, hi);
    }
    if (at < end) {
        gaps.push([at, end]);
    }
    if (!gaps.length) {
        return starts.map((s) => ({ at: s, value: values.get(s)! }));
    }

    const sql = new Sql();
    const calendar = await calendarTable(connection, window, meta, gaps[0]![0], gaps.at(-1)![1]);
    const inGaps = (column: string) =>
        `(${gaps.map(([lo, hi]) => `(${column} >= ${sql.int(lo)} AND ${column} < ${sql.int(hi)})`).join(' OR ')})`;
    const rowsOf =
        metric === 'messages' || metric === 'people'
            ? `SELECT sent_at AS ts, author_id AS person, 0 AS tokens, false AS failed
        FROM f_message WHERE ${[inGaps('sent_at'), ...messageFilters(sql, filters)].join(' AND ')}`
            : `SELECT started_at AS ts, NULL AS person,
          COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens,
          status = 'failed' AS failed
        FROM f_turn WHERE ${[inGaps('started_at'), ...turnFilters(sql, filters)].join(' AND ')}`;
    const value =
        metric === 'people'
            ? 'count(DISTINCT f.person)'
            : metric === 'tokens'
              ? 'sum(f.tokens)'
              : metric === 'failed'
                ? 'count(*) FILTER (WHERE f.failed)'
                : 'count(*)';
    for (const row of await rows<{ k: number; v: number | bigint }>(
        connection,
        `SELECT c.${key} AS k, (${value})::BIGINT AS v
    FROM (${rowsOf}) f ASOF JOIN ${calendar} c ON f.ts >= c.utc_at
    GROUP BY c.${key}`,
        sql.values,
    )) {
        if (values.has(row.k)) {
            values.set(row.k, values.get(row.k)! + Number(row.v));
        }
    }
    return starts.map((s) => ({ at: s, value: values.get(s)! }));
}
