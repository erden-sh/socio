import {
    HOUR_MS,
    MONTH_MS,
    type CostPool,
    type MeterReading,
    type PoolPeriod,
    type PoolWeights,
} from '@socio/shared/operations/operations-cost';

import type { TurnTokens } from './cost.js';

/**
 * Self-hosted cost pools (CB-196): what a pool costs each hour, and how
 * an hour's cost is shared among that hour's turns on the pool's
 * backends. Pure: the ETL's cost step and the tests call it.
 *
 * - A fixed pool costs `amount` per `period`, spread evenly over its
 *   hours; with `depreciationMonths` its `amount` is a purchase written
 *   off in a straight line over those months from `startsAt`.
 * - A variable pool costs what its meter readings say: each reading is
 *   the use since the one before (or since the pool started), at its
 *   unit price (else the pool's `amount`), spread evenly over that span.
 * - An hour's cost goes to its turns by weight; with no turns (or no
 *   weights, as `gpu_seconds` has until a GPU meter exists) it is idle
 *   capacity. Allocated plus idle is always the hour's cost.
 */

const PERIOD_MS: Record<PoolPeriod, number> = {
    hour: HOUR_MS,
    day: 24 * HOUR_MS,
    month: MONTH_MS,
    year: 12 * MONTH_MS,
};

const overlap = (lo: number, hi: number, from: number, to: number) =>
    Math.max(0, Math.min(hi, to) - Math.max(lo, from));

/** When a pool's cost starts and stops accruing (`endsAt` null: still going). */
export function poolSpan(pool: CostPool): [number, number] {
    const end = pool.endsAt ?? Infinity;
    if (pool.kind === 'fixed' && pool.depreciationMonths) {
        return [pool.startsAt, Math.min(end, pool.startsAt + pool.depreciationMonths * MONTH_MS)];
    }
    return [pool.startsAt, end];
}

/** A variable pool's readings as spans of cost: [from, to, dollars]. */
export function readingSpans(pool: CostPool, readings: readonly MeterReading[]): [number, number, number][] {
    const sorted = [...readings].sort((a, b) => a.at - b.at);
    const spans: [number, number, number][] = [];
    let previous = pool.startsAt;
    for (const reading of sorted) {
        const cost = reading.quantity * (reading.unitPrice ?? pool.amount);
        // A reading at or before the last one (or the start) is its own hour's.
        const from = previous < reading.at ? previous : Math.floor(reading.at / HOUR_MS) * HOUR_MS;
        const to = Math.max(reading.at, from + 1);
        spans.push([from, to, cost]);
        previous = Math.max(previous, reading.at);
    }
    return spans;
}

/** What a pool costs over [from, to), in dollars. */
export function poolCost(pool: CostPool, spans: readonly [number, number, number][], from: number, to: number) {
    if (pool.kind === 'variable') {
        let cost = 0;
        for (const [lo, hi, dollars] of spans) {
            cost += (dollars * overlap(lo, hi, from, to)) / (hi - lo);
        }
        return cost;
    }
    const [lo, hi] = poolSpan(pool);
    const length = pool.depreciationMonths ? pool.depreciationMonths * MONTH_MS : PERIOD_MS[pool.period];
    return (pool.amount * overlap(lo, hi, from, to)) / length;
}

/** The first and last hour a pool has cost in, or undefined. */
export function poolHours(pool: CostPool, spans: readonly [number, number, number][]): [number, number] | undefined {
    let lo: number, hi: number;
    if (pool.kind === 'variable') {
        if (!spans.length) {
            return undefined;
        }
        lo = Math.min(...spans.map(([from]) => from));
        hi = Math.max(...spans.map(([, to]) => to));
    } else {
        [lo, hi] = poolSpan(pool);
    }
    if (!(hi > lo)) {
        return undefined;
    }
    return [Math.floor(lo / HOUR_MS) * HOUR_MS, Number.isFinite(hi) ? Math.ceil(hi / HOUR_MS) * HOUR_MS : Infinity];
}

/** A turn's weight in a `tokens` pool: uncached input, cached input, output. */
export function tokenWeight(tokens: TurnTokens, weights: PoolWeights) {
    const input = tokens.inputTokens ?? 0;
    const cached = Math.min(input, tokens.cachedTokens ?? 0);
    return (input - cached) * weights.input + cached * weights.cached + (tokens.outputTokens ?? 0) * weights.output;
}

/** A turn as the allocation reads it. */
export interface PoolTurn extends TurnTokens {
    seq: number;
    startedAt: number;
    /** A shared backend's id or `byo:<kind>`. */
    backend: string;
}

/** One pool's hour: its cost, what its turns took, and how many. */
export interface PoolHour {
    poolId: string;
    hourAt: number;
    costUsd: number;
    allocatedUsd: number;
    turns: number;
}

/**
 * Every pool's hours from `from` up to (not past) the hour `to` is in,
 * and each turn's share: by turn `seq`, its dollars from all its pools.
 * A turn in a pool's hour on one of its backends is the pool's even when
 * its share is 0 (a `gpu_seconds` pool, a turn without tokens).
 */
export function allocatePools(input: {
    pools: readonly CostPool[];
    readings: readonly MeterReading[];
    turns: readonly PoolTurn[];
    from: number;
    to: number;
}) {
    const shares = new Map<number, number>();
    const hours: PoolHour[] = [];
    const byHour = new Map<number, PoolTurn[]>();
    for (const turn of input.turns) {
        const hour = Math.floor(turn.startedAt / HOUR_MS) * HOUR_MS;
        let list = byHour.get(hour);
        if (!list) {
            byHour.set(hour, (list = []));
        }
        list.push(turn);
    }
    const first = Math.floor(input.from / HOUR_MS) * HOUR_MS;
    const last = Math.floor(input.to / HOUR_MS) * HOUR_MS;
    for (const pool of input.pools) {
        const spans =
            pool.kind === 'variable'
                ? readingSpans(
                      pool,
                      input.readings.filter((reading) => reading.poolId === pool.id),
                  )
                : [];
        const span = poolHours(pool, spans);
        if (!span) {
            continue;
        }
        const backends = new Set(pool.backendIds);
        for (let hour = Math.max(first, span[0]); hour <= last && hour < span[1]; hour += HOUR_MS) {
            const cost = poolCost(pool, spans, hour, hour + HOUR_MS);
            const turns = (byHour.get(hour) ?? []).filter((turn) => backends.has(turn.backend));
            const weights = turns.map((turn) => (pool.allocation === 'tokens' ? tokenWeight(turn, pool.weights) : 0));
            const total = weights.reduce((sum, weight) => sum + weight, 0);
            let allocated = 0;
            turns.forEach((turn, index) => {
                const share = total > 0 ? (cost * weights[index]!) / total : 0;
                allocated += share;
                shares.set(turn.seq, (shares.get(turn.seq) ?? 0) + share);
            });
            // Exactly the hour's cost when it went to turns, not float noise.
            if (total > 0) {
                allocated = cost;
            }
            if (cost > 0 || turns.length) {
                hours.push({
                    poolId: pool.id,
                    hourAt: hour,
                    costUsd: cost,
                    allocatedUsd: allocated,
                    turns: turns.length,
                });
            }
        }
    }
    return { shares, hours };
}
