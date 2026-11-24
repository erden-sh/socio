import type { DuckDBConnection } from '@duckdb/node-api';

import { bucketStarts } from '@socio/shared/operations/operations';
import {
    CYCLE_LIMITS,
    OPS_COST_ROWS,
    type OpsCostRow,
    type OpsCycleSummary,
    type OpsRoomCost,
} from '@socio/shared/operations/operations-cost';

import type { OpsQueries } from '../../domain/ops-queries.js';

import { rows } from './open.js';
import { calendarTable, earliest, KEY_COLUMN, range, rollupMeta, Sql, turnFilters } from './sql.js';

type CostQueries = Pick<OpsQueries, 'cost' | 'costModels'>;

const TOKENS = 'COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)';
const num = (value: unknown) => Number(value ?? 0);

/**
 * Cost's SQL (CB-195, CB-196) over the cost step's columns of `f_turn`
 * and `f_pool_hour`. Turns are in a window by their start and follow the
 * filters; pools' hours are the workspace's, in the window by the hour.
 * Answers as `MemoryOpsReader` does (`tests/operations-cost.test.ts`).
 */
export function costQueries(connection: DuckDBConnection): CostQueries {
    /** Turns of the window and filters, as a WHERE clause. */
    const where = (
        sql: Sql,
        scope: Parameters<CostQueries['cost']>[0],
        from = scope.window.from,
        to = scope.window.to,
        alias = '',
    ) => [...range(sql, `${alias}started_at`, from, to), ...turnFilters(sql, scope.filters, alias)].join(' AND ');

    /**
     * Rooms' turns and their cycles (CB-218): turns as any cost row, each
     * cycle once however many of its steps the window holds.
     */
    const byRoom = async (scope: Parameters<CostQueries['cost']>[0]): Promise<OpsRoomCost[]> => {
        const sql = new Sql();
        const found = await rows<Record<string, unknown>>(
            connection,
            `SELECT t.thread_id AS k, any_value(ch.title) AS name, count(*) AS turns,
        sum(COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0))::BIGINT AS tokens,
        COALESCE(sum(t.cost_usd), 0) AS cost,
        count(*) FILTER (WHERE t.cost_basis = 'none') AS unpriced,
        count(DISTINCT t.cycle_id) AS cycles,
        count(*) FILTER (WHERE t.hop > 0) AS handoffs,
        count(DISTINCT t.cycle_id) FILTER (WHERE c.end_reason IN (${CYCLE_LIMITS.map((limit) => `'${limit}'`).join(', ')})) AS exhausted,
        count(DISTINCT t.trigger_id) FILTER (WHERE t.trigger_kind = 'person') AS people,
        count(DISTINCT t.socio_id) AS socios
      FROM f_turn t LEFT JOIN f_cycle c ON c.id = t.cycle_id
        LEFT JOIN d_chat ch ON ch.id = t.thread_id
      WHERE ${where(sql, scope, scope.window.from, scope.window.to, 't.')}
        AND t.container_kind = 'room'
      GROUP BY t.thread_id ORDER BY cost DESC, turns DESC, k LIMIT ${OPS_COST_ROWS}`,
            sql.values,
        );
        return found.map((row) => ({
            key: String(row.k),
            name: (row.name as string | null) ?? null,
            turns: num(row.turns),
            tokens: num(row.tokens),
            costUsd: num(row.cost),
            unpriced: num(row.unpriced),
            cycles: num(row.cycles),
            handoffs: num(row.handoffs),
            exhausted: num(row.exhausted),
            people: num(row.people),
            socios: num(row.socios),
        }));
    };

    /** The window's work cycles (CB-218): those with a step in it. */
    const cycles = async (scope: Parameters<CostQueries['cost']>[0]): Promise<OpsCycleSummary> => {
        const sql = new Sql();
        const [row = {}] = await rows<Record<string, unknown>>(
            connection,
            `WITH t AS (
          SELECT cycle_id, hop FROM f_turn
          WHERE ${where(sql, scope)} AND cycle_id IS NOT NULL
        ), c AS (SELECT * FROM f_cycle WHERE id IN (SELECT cycle_id FROM t))
      SELECT (SELECT count(*) FROM t) AS steps,
        (SELECT count(*) FROM t WHERE hop > 0) AS handoffs,
        count(*) AS cycles,
        count(*) FILTER (WHERE kind = 'room') AS in_rooms,
        ${CYCLE_LIMITS.map((limit) => `count(*) FILTER (WHERE end_reason = '${limit}') AS ${limit}_n`).join(',\n        ')},
        count(*) FILTER (WHERE end_reason = 'stopped') AS stopped,
        count(*) FILTER (WHERE NOT cost_known) AS unknown,
        COALESCE(sum(elapsed_ms) FILTER (WHERE ended_at IS NOT NULL), 0)::BIGINT AS running,
        COALESCE(sum(ended_at - started_at) FILTER (WHERE ended_at IS NOT NULL), 0)::BIGINT AS wall
      FROM c`,
            sql.values,
        );
        return {
            cycles: num(row.cycles),
            inRooms: num(row.in_rooms),
            steps: num(row.steps),
            handoffs: num(row.handoffs),
            exhausted: Object.fromEntries(
                CYCLE_LIMITS.map((limit) => [limit, num(row[`${limit}_n`])]),
            ) as OpsCycleSummary['exhausted'],
            stopped: num(row.stopped),
            spendUnknown: num(row.unknown),
            runningMs: num(row.running),
            wallMs: Math.max(0, num(row.wall)),
        };
    };

    const breakdown = async (
        scope: Parameters<CostQueries['cost']>[0],
        key: string,
        join = '',
        name = 'NULL',
        extra = '',
    ): Promise<OpsCostRow[]> => {
        const sql = new Sql();
        const found = await rows<Record<string, unknown>>(
            connection,
            `SELECT ${key} AS k, ${name} AS name, count(*) AS turns,
        sum(${TOKENS})::BIGINT AS tokens, COALESCE(sum(cost_usd), 0) AS cost,
        count(*) FILTER (WHERE cost_basis = 'none') AS unpriced
      FROM f_turn ${join}
      WHERE ${where(sql, scope)} ${extra}
      GROUP BY ALL ORDER BY cost DESC, turns DESC, k LIMIT ${OPS_COST_ROWS}`,
            sql.values,
        );
        return found.map((row) => ({
            key: String(row.k ?? ''),
            name: (row.name as string | null) ?? null,
            turns: num(row.turns),
            tokens: num(row.tokens),
            costUsd: num(row.cost),
            unpriced: num(row.unpriced),
        }));
    };

    return {
        async cost(scope) {
            const { window } = scope;
            const totalsOf = async (from: number | null, to: number) => {
                const sql = new Sql();
                const [row] = await rows<Record<string, unknown>>(
                    connection,
                    `SELECT COALESCE(sum(cost_usd), 0) AS cost, count(*) AS turns,
            count(*) FILTER (WHERE cost_basis = 'price') AS priced,
            count(*) FILTER (WHERE cost_basis = 'pool') AS pooled,
            count(*) FILTER (WHERE cost_basis IS DISTINCT FROM 'price'
              AND cost_basis IS DISTINCT FROM 'pool') AS unpriced,
            COALESCE(sum(${TOKENS}), 0)::BIGINT AS tokens
          FROM f_turn WHERE ${where(sql, scope, from, to)}`,
                    sql.values,
                );
                return row ?? {};
            };
            const now = await totalsOf(window.from, window.to);
            const before = window.previous ? await totalsOf(window.previous.from, window.previous.to) : undefined;

            const poolSql = new Sql();
            const pools = await rows<Record<string, unknown>>(
                connection,
                `SELECT pool_id, sum(cost_usd) AS cost, sum(allocated_usd) AS allocated,
          sum(turns)::BIGINT AS turns
        FROM f_pool_hour WHERE ${range(poolSql, 'hour_at', window.from, window.to).join(' AND ')}
        GROUP BY pool_id ORDER BY cost DESC, pool_id`,
                poolSql.values,
            );
            const poolRows = pools.map((row) => ({
                poolId: String(row.pool_id),
                costUsd: num(row.cost),
                allocatedUsd: num(row.allocated),
                idleUsd: Math.max(0, num(row.cost) - num(row.allocated)),
                turns: num(row.turns),
            }));

            const backendSql = new Sql();
            const backends = await rows<Record<string, unknown>>(
                connection,
                `SELECT COALESCE(cost_backend, backend_key, 'unknown') AS backend, count(*) AS turns,
          COALESCE(sum(input_tokens), 0)::BIGINT AS input,
          COALESCE(sum(cached_tokens), 0)::BIGINT AS cached,
          COALESCE(sum(output_tokens), 0)::BIGINT AS output,
          COALESCE(sum(cost_usd), 0) AS cost,
          COALESCE(sum(cost_usd) FILTER (WHERE cost_basis = 'pool'), 0) AS pool,
          COALESCE(sum(${TOKENS}) FILTER (WHERE cost_basis = 'pool'), 0)::BIGINT AS pooled,
          sum(ref_cost_usd) AS reference,
          count(*) FILTER (WHERE cost_basis = 'none') AS unpriced
        FROM f_turn WHERE ${where(backendSql, scope)}
        GROUP BY ALL ORDER BY cost DESC, turns DESC, backend LIMIT ${OPS_COST_ROWS}`,
                backendSql.values,
            );

            const unpricedSql = new Sql();
            const unpriced = await rows<Record<string, unknown>>(
                connection,
                `SELECT model, COALESCE(cost_backend, backend_key, 'unknown') AS backend, count(*) AS turns
        FROM f_turn WHERE ${where(unpricedSql, scope)} AND cost_basis = 'none' AND model IS NOT NULL
        GROUP BY ALL ORDER BY turns DESC, model, backend LIMIT 20`,
                unpricedSql.values,
            );

            return {
                totals: {
                    costUsd: num(now.cost),
                    previousCostUsd: before ? num(before.cost) : null,
                    turns: num(now.turns),
                    priced: num(now.priced),
                    pooled: num(now.pooled),
                    unpriced: num(now.unpriced),
                    tokens: num(now.tokens),
                    idleUsd: poolRows.reduce((sum, pool) => sum + pool.idleUsd, 0),
                },
                series: await series(connection, scope, where),
                byModel: await breakdown(scope, "COALESCE(model, '')"),
                bySocio: await breakdown(
                    scope,
                    "COALESCE(socio_id, '')",
                    'LEFT JOIN d_socio s ON s.id = f_turn.socio_id',
                    'any_value(s.name)',
                ),
                byPerson: await breakdown(
                    scope,
                    'trigger_id',
                    'LEFT JOIN d_person p ON p.id = f_turn.trigger_id',
                    'any_value(p.name)',
                    "AND trigger_kind = 'person' AND trigger_id IS NOT NULL",
                ),
                byPayer: await breakdown(
                    scope,
                    "CASE WHEN payer_kind = 'workspace' THEN 'workspace' WHEN payer_kind = 'person' THEN COALESCE(payer_id, '') ELSE '' END",
                    'LEFT JOIN d_person p ON p.id = f_turn.payer_id',
                    "any_value(p.name) FILTER (WHERE f_turn.payer_kind = 'person')",
                ),
                byRoom: await byRoom(scope),
                cycles: await cycles(scope),
                backends: backends.map((row) => ({
                    backend: String(row.backend),
                    turns: num(row.turns),
                    inputTokens: num(row.input),
                    cachedTokens: num(row.cached),
                    outputTokens: num(row.output),
                    costUsd: num(row.cost),
                    poolUsd: num(row.pool),
                    pooledTokens: num(row.pooled),
                    referenceUsd: row.reference === null ? null : num(row.reference),
                    unpriced: num(row.unpriced),
                })),
                pools: poolRows,
                unpricedModels: unpriced.map((row) => ({
                    model: String(row.model),
                    backend: String(row.backend),
                    turns: num(row.turns),
                })),
            };
        },

        async costModels() {
            return (
                await rows<{ model: string }>(
                    connection,
                    'SELECT DISTINCT model FROM f_turn WHERE model IS NOT NULL ORDER BY model LIMIT 500',
                )
            ).map((row) => row.model);
        },
    };
}

/** Turns' cost per bucket, by price and by pool; every bucket present. */
async function series(
    connection: DuckDBConnection,
    scope: Parameters<CostQueries['cost']>[0],
    where: (sql: Sql, scope: Parameters<CostQueries['cost']>[0], from: number | null, to: number) => string,
) {
    const { window } = scope;
    const start = window.from ?? (await earliest(connection));
    if (start === null) {
        return [];
    }
    const starts = bucketStarts(start, window.to, window.bucket, window.timeZone);
    if (!starts.length) {
        return [];
    }
    const points = new Map(starts.map((at) => [at, { at, priceUsd: 0, poolUsd: 0 }]));
    const calendar = await calendarTable(connection, window, await rollupMeta(connection), start, window.to);
    const sql = new Sql();
    const key = KEY_COLUMN[window.bucket];
    for (const row of await rows<Record<string, unknown>>(
        connection,
        `SELECT c.${key} AS k,
      COALESCE(sum(f.cost) FILTER (WHERE f.basis = 'price'), 0) AS price,
      COALESCE(sum(f.cost) FILTER (WHERE f.basis = 'pool'), 0) AS pool
    FROM (SELECT started_at AS ts, cost_usd AS cost, cost_basis AS basis FROM f_turn
      WHERE ${where(sql, scope, start, window.to)}) f
    ASOF JOIN ${calendar} c ON f.ts >= c.utc_at
    GROUP BY c.${key}`,
        sql.values,
    )) {
        const point = points.get(num(row.k));
        if (!point) {
            continue;
        }
        point.priceUsd = num(row.price);
        point.poolUsd = num(row.pool);
    }
    return [...points.values()];
}
