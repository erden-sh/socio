import { createHash } from 'node:crypto';

import type { DuckDBConnection } from '@duckdb/node-api';

import { HOUR_MS, type CostBasis } from '@socio/shared/operations/operations-cost';

import type { EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { readPricingInputs, type SourceBackend } from '../infra/sqlite/pricing-source.js';
import { PriceBook, tokenCost, type TurnTokens } from '../pricing/cost.js';
import { allocatePools, type PoolTurn } from '../pricing/pools.js';

import { appendTyped } from './append.js';

const DAY = 86_400_000;
const floorHour = (at: number) => Math.floor(at / HOUR_MS) * HOUR_MS;

/**
 * Each cost pool's hours (CB-196): what the hour cost, what its turns
 * took; the rest is idle capacity. Allocated plus idle is the hour's cost.
 */
export const POOL_HOUR_DDL = `CREATE TABLE f_pool_hour (
  pool_id VARCHAR NOT NULL,
  hour_at BIGINT NOT NULL,
  cost_usd DOUBLE NOT NULL,
  allocated_usd DOUBLE NOT NULL,
  turns INTEGER NOT NULL
)`;

/** Where the cost step got to: the inputs it priced with, and the hour. */
interface CostWatermark {
    hash: string | null;
    hour: number | null;
}

function readWatermark(text: string | null): CostWatermark {
    try {
        const value = JSON.parse(text ?? '') as Partial<CostWatermark>;
        return {
            hash: typeof value.hash === 'string' ? value.hash : null,
            hour: typeof value.hour === 'number' ? value.hour : null,
        };
    } catch {
        return { hash: null, hour: null };
    }
}

/**
 * The backend a turn is priced by: the shared backend its trace names,
 * else (older turns) the one shared backend serving its model, else its
 * source key (`byo:<kind>`, or `shared` when that can't be told).
 */
export function costBackend(
    turn: {
        backendId: string | null;
        backendKey: string | null;
        model: string | null;
    },
    backends: readonly SourceBackend[],
) {
    if (turn.backendId) {
        return turn.backendId;
    }
    const key = turn.backendKey ?? 'unknown';
    if (key === 'shared' && turn.model) {
        const serving = backends.filter((backend) => backend.kind === 'shared' && backend.model === turn.model);
        if (serving.length === 1) {
            return serving[0]!.id;
        }
    }
    return key;
}

/** The provider a backend's prices are listed under (`byo:byo-chatgpt`: chatgpt). */
export function costProvider(backend: string, backends: readonly SourceBackend[]): string | null {
    const known = backends.find((item) => item.id === backend);
    if (known) {
        return known.provider;
    }
    if (backend.startsWith('byo:')) {
        return backend.slice(4).replace(/^byo-/, '');
    }
    return null;
}

interface CostRow {
    seq: number;
    started_at: number;
    model: string | null;
    backend_key: string | null;
    backend_id: string | null;
    input_tokens: number | null;
    cached_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
}

/**
 * Turn cost (CB-195) and self-hosted pools (CB-196). After the turns are
 * copied, each turn is priced: by its backend's cost pools when one
 * covers it that hour (`pool`, with the cheapest cloud price as a
 * reference), else by its model's price in force when it started
 * (`price`), else `none`. Prices, pools and backends are read from
 * SQLite each cycle; when they changed (their hash) every turn and pool
 * hour is worked out again, otherwise only from the oldest turn not yet
 * priced and the hour it last reached, so a new turn shares its hour
 * with the turns already in it. Idle pool hours accrue as time passes.
 */
export const costStep: EtlStep = {
    source: 'cost',
    ddl: [POOL_HOUR_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        const inputs = readPricingInputs(sqlite);
        const hash = createHash('sha256')
            .update(
                JSON.stringify({
                    // When a list was last fetched changes no price.
                    prices: inputs.prices.map(({ fetchedAt: _, ...price }) => price),
                    pools: inputs.pools.map(({ updatedAt: _, ...pool }) => pool),
                    readings: inputs.readings,
                    backends: inputs.backends,
                }),
            )
            .digest('hex')
            .slice(0, 32);
        const state = readWatermark(watermark);
        const nowHour = floorHour(context.now);
        let since = -Infinity;
        if (state.hash === hash && state.hour !== null) {
            const [unpriced] = await rows<{ lo: number | null }>(
                duck,
                'SELECT min(started_at) AS lo FROM f_turn WHERE cost_basis IS NULL',
            );
            since = floorHour(Math.min(unpriced?.lo ?? Infinity, state.hour));
        }
        const cutoff = context.settings.factDays ? floorHour(context.now - context.settings.factDays * DAY) : -Infinity;
        const [span] = await rows<{ lo: number | null }>(duck, 'SELECT min(started_at) AS lo FROM f_turn');
        const turns = await rows<CostRow>(
            duck,
            `SELECT seq, started_at, model, backend_key, backend_id, input_tokens,
        cached_tokens, output_tokens, reasoning_tokens
      FROM f_turn ${Number.isFinite(since) ? 'WHERE started_at >= $1' : ''}`,
            Number.isFinite(since) ? [BigInt(since)] : undefined,
        );
        const book = new PriceBook(inputs.prices);
        const priced = turns.map((row) => {
            const backend = costBackend(
                {
                    backendId: row.backend_id,
                    backendKey: row.backend_key,
                    model: row.model,
                },
                inputs.backends,
            );
            const tokens: TurnTokens = {
                inputTokens: row.input_tokens,
                cachedTokens: row.cached_tokens,
                outputTokens: row.output_tokens,
                reasoningTokens: row.reasoning_tokens,
            };
            return { row, backend, tokens };
        });
        // Pool hours from the first turn the store holds (and retention's cut).
        const from = Math.max(since, cutoff, floorHour(span?.lo ?? Infinity));
        const { shares, hours } = Number.isFinite(from)
            ? allocatePools({
                  pools: inputs.pools,
                  readings: inputs.readings,
                  turns: priced.map(({ row, backend, tokens }): PoolTurn => ({
                      seq: row.seq,
                      startedAt: row.started_at,
                      backend,
                      ...tokens,
                  })),
                  from,
                  to: context.now,
              })
            : { shares: new Map<number, number>(), hours: [] };

        const costs = priced.map(({ row, backend, tokens }) => {
            const pooled = shares.get(row.seq);
            if (pooled !== undefined) {
                const reference = book.reference(row.model, row.started_at, tokens);
                return [row.seq, backend, pooled, 'pool', null, reference ?? null] as const;
            }
            const price = book.lookup(costProvider(backend, inputs.backends), row.model, row.started_at);
            const cost = price ? tokenCost(tokens, price) : null;
            return cost === null
                ? ([row.seq, backend, null, 'none', null, null] as const)
                : ([row.seq, backend, cost, 'price', price!.source, null] as const);
        });
        await writeCosts(duck, costs);

        if (Number.isFinite(since)) {
            await duck.run('DELETE FROM f_pool_hour WHERE hour_at >= $1', [BigInt(since)]);
        } else {
            await duck.run('DELETE FROM f_pool_hour');
        }
        if (Number.isFinite(cutoff)) {
            await duck.run('DELETE FROM f_pool_hour WHERE hour_at < $1', [BigInt(cutoff)]);
        }
        await appendTyped(
            duck,
            'f_pool_hour',
            hours.map((hour) => [
                hour.poolId,
                BigInt(hour.hourAt),
                hour.costUsd,
                hour.allocatedUsd,
                BigInt(hour.turns),
            ]),
        );
        return {
            watermark: JSON.stringify({ hash, hour: nowHour }),
            caughtUp: true,
        };
    },
};

async function writeCosts(
    duck: DuckDBConnection,
    costs: readonly (readonly [number, string, number | null, CostBasis, string | null, number | null])[],
) {
    if (!costs.length) {
        return;
    }
    await duck.run(
        `CREATE OR REPLACE TEMP TABLE q_cost (seq BIGINT, backend VARCHAR, cost DOUBLE,
      basis VARCHAR, src VARCHAR, ref DOUBLE)`,
    );
    await appendTyped(
        duck,
        'q_cost',
        costs.map(([seq, backend, cost, basis, source, ref]) => [BigInt(seq), backend, cost, basis, source, ref]),
        { schema: 'main', catalog: 'temp' },
    );
    await duck.run(
        `UPDATE f_turn SET cost_backend = c.backend, cost_usd = c.cost,
      cost_basis = c.basis, cost_source = c.src, ref_cost_usd = c.ref
    FROM temp.main.q_cost c WHERE f_turn.seq = c.seq`,
    );
    await duck.run('DROP TABLE temp.main.q_cost');
}
