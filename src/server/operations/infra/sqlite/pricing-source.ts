import type { DatabaseSync } from 'node:sqlite';

import type { CostPool, MeterReading, ModelPrice, PoolWeights } from '@socio/shared/operations/operations-cost';
import { DEFAULT_POOL_WEIGHTS } from '@socio/shared/operations/operations-cost';

/** A backend as the cost step reads it (`cost_backends`, the app's copy). */
export interface SourceBackend {
    id: string;
    kind: string;
    /** What its prices are listed under (`providerOf` its base URL). */
    provider: string;
    model: string;
}

/** What the cost step prices turns with (CB-195, CB-196). */
export interface PricingInputs {
    prices: ModelPrice[];
    pools: CostPool[];
    readings: MeterReading[];
    backends: SourceBackend[];
}

const parse = <T>(text: unknown, fallback: T): T => {
    if (typeof text !== 'string') {
        return fallback;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
};

/**
 * The cost step's reads of the app's database, on the analytics
 * process's own read-only connection: Operations' small pricing tables
 * whole (operations 4), backends included as the app copied them into
 * `cost_backends` (inference's own tables are never read here). A table
 * the app hasn't made yet reads as empty.
 */
export function readPricingInputs(db: DatabaseSync): PricingInputs {
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const all = (table: string, sql: string) =>
        has(table) ? (db.prepare(sql).all() as Record<string, unknown>[]) : [];
    const prices = all(
        'model_prices',
        `SELECT id, provider, model, modelKey, inputPerM, cachedInputPerM, outputPerM,
      reasoningPerM, effectiveFrom, source, fetchedAt
    FROM model_prices ORDER BY id`,
    ).map((row): ModelPrice => ({
        id: String(row.id),
        provider: String(row.provider),
        model: String(row.model),
        modelKey: String(row.modelKey),
        inputPerM: Number(row.inputPerM),
        cachedInputPerM: row.cachedInputPerM === null ? null : Number(row.cachedInputPerM),
        outputPerM: Number(row.outputPerM),
        reasoningPerM: row.reasoningPerM === null ? null : Number(row.reasoningPerM),
        currency: 'USD',
        effectiveFrom: Number(row.effectiveFrom),
        source: String(row.source) as ModelPrice['source'],
        fetchedAt: Number(row.fetchedAt),
    }));
    const pools = all(
        'cost_pools',
        `SELECT id, name, kind, category, amount, period, depreciationMonths, startsAt,
      endsAt, backendIds, allocation, weights, createdAt, updatedAt
    FROM cost_pools ORDER BY id`,
    ).map((row): CostPool => ({
        id: String(row.id),
        name: String(row.name),
        kind: row.kind === 'variable' ? 'variable' : 'fixed',
        category: String(row.category) as CostPool['category'],
        amount: Number(row.amount),
        currency: 'USD',
        period: String(row.period) as CostPool['period'],
        depreciationMonths: row.depreciationMonths === null ? null : Number(row.depreciationMonths),
        startsAt: Number(row.startsAt),
        endsAt: row.endsAt === null ? null : Number(row.endsAt),
        backendIds: parse<string[]>(row.backendIds, []).filter((id) => typeof id === 'string'),
        allocation: row.allocation === 'gpu_seconds' ? 'gpu_seconds' : 'tokens',
        weights: {
            ...DEFAULT_POOL_WEIGHTS,
            ...parse<Partial<PoolWeights>>(row.weights, {}),
        },
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
    }));
    const readings = all(
        'cost_meter_readings',
        `SELECT id, poolId, at, quantity, unit, unitPrice FROM cost_meter_readings ORDER BY poolId, at, id`,
    ).map((row): MeterReading => ({
        id: String(row.id),
        poolId: String(row.poolId),
        at: Number(row.at),
        quantity: Number(row.quantity),
        unit: String(row.unit),
        unitPrice: row.unitPrice === null ? null : Number(row.unitPrice),
    }));
    const backends = all('cost_backends', 'SELECT id, kind, provider, model FROM cost_backends ORDER BY id').map(
        (row): SourceBackend => ({
            id: String(row.id),
            kind: String(row.kind),
            provider: String(row.provider),
            model: typeof row.model === 'string' ? row.model : '',
        }),
    );
    return { prices, pools, readings, backends };
}
