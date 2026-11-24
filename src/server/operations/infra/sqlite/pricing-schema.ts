import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, float, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import {
    POOL_ALLOCATIONS,
    POOL_CATEGORIES,
    POOL_KINDS,
    POOL_PERIODS,
    type PoolWeights,
} from '@socio/shared/operations/operations-cost';

/**
 * The pricing tables (CB-195, CB-196), as operations migration 4 makes
 * them; tests/operations-pricing.test.ts holds these to it.
 */

export const modelPrices = sqliteTable('model_prices', {
    id: id().primaryKey(),
    provider: str().notNull(),
    model: str().notNull(),
    modelKey: str().notNull(),
    inputPerM: float().notNull(),
    cachedInputPerM: float(),
    outputPerM: float().notNull(),
    reasoningPerM: float(),
    currency: enumText(['USD']).notNull(),
    effectiveFrom: ms().notNull(),
    source: str().notNull(),
    fetchedAt: ms().notNull(),
});

export const priceSyncRuns = sqliteTable('price_sync_runs', {
    source: str().primaryKey(),
    at: ms().notNull(),
    ok: flag().notNull(),
    fetched: int().notNull(),
    matched: int().notNull(),
    stored: int().notNull(),
    error: str(),
});

export const costPools = sqliteTable('cost_pools', {
    id: id().primaryKey(),
    name: str().notNull(),
    kind: enumText(POOL_KINDS).notNull(),
    category: enumText(POOL_CATEGORIES).notNull(),
    amount: float().notNull(),
    currency: enumText(['USD']).notNull(),
    period: enumText(POOL_PERIODS).notNull(),
    depreciationMonths: int(),
    startsAt: ms().notNull(),
    endsAt: ms(),
    backendIds: json<string[]>().notNull(),
    allocation: enumText(POOL_ALLOCATIONS).notNull(),
    weights: json<PoolWeights>().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

export const costMeterReadings = sqliteTable('cost_meter_readings', {
    id: id().primaryKey(),
    poolId: str().notNull(),
    at: ms().notNull(),
    quantity: float().notNull(),
    unit: str().notNull(),
    unitPrice: float(),
});

export const costBackends = sqliteTable('cost_backends', {
    id: str().primaryKey(),
    kind: enumText(['shared', 'byo']).notNull(),
    label: str().notNull(),
    provider: str().notNull(),
    model: str(),
    removedAt: ms(),
    updatedAt: ms().notNull(),
});

export const pricingTables = [modelPrices, priceSyncRuns, costPools, costMeterReadings, costBackends] as const;
