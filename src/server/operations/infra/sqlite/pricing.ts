import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';
import type {
    CostPool,
    MeterReading,
    ModelPrice,
    PriceOrigin,
    PriceSourceId,
    PriceSyncRun,
    PricingBackend,
    TokenPrices,
} from '@socio/shared/operations/operations-cost';

import { modelKey } from '../../pricing/model-key.js';

import { costBackends, costMeterReadings, costPools, modelPrices, priceSyncRuns } from './pricing-schema.js';

/** A price a sync found for a model in use. */
export interface SyncedPrice {
    provider: string;
    model: string;
    /** The key it matched a model in use by. */
    modelKey: string;
    prices: TokenPrices;
    /** When the list says it took effect; else when it was fetched. */
    effectiveFrom?: number;
}

/** An admin's price for a model, from a date. */
export interface AdminPrice extends TokenPrices {
    provider: string;
    model: string;
    effectiveFrom: number;
}

type PriceRow = typeof modelPrices.$inferSelect;
const priceOf = (row: PriceRow): ModelPrice => ({
    ...row,
    currency: 'USD',
    source: row.source as PriceOrigin,
});

const samePrices = (a: TokenPrices, b: TokenPrices) =>
    a.inputPerM === b.inputPerM &&
    a.cachedInputPerM === b.cachedInputPerM &&
    a.outputPerM === b.outputPerM &&
    a.reasoningPerM === b.reasoningPerM;

/**
 * Model prices, sync runs, cost pools and meter readings on the workspace
 * connection (CB-195, CB-196). Writes go through its unit of work.
 */
export class SqlitePricing {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    async prices(): Promise<ModelPrice[]> {
        return (
            await this.db
                .select()
                .from(modelPrices)
                .orderBy(asc(modelPrices.provider), asc(modelPrices.model), desc(modelPrices.effectiveFrom))
                .all()
        ).map(priceOf);
    }

    /**
     * Stores what a source's run found: a price that changed (or is new) as
     * a new row from its date; one that didn't only moves its `fetchedAt`.
     * Returns how many rows it added.
     */
    recordSynced(source: PriceOrigin, found: SyncedPrice[], at: number) {
        return this.data.uow.run(
            async () => {
                let stored = 0;
                for (const entry of found) {
                    const latest = await this.db
                        .select()
                        .from(modelPrices)
                        .where(
                            and(
                                eq(modelPrices.provider, entry.provider),
                                eq(modelPrices.model, entry.model),
                                eq(modelPrices.source, source),
                            ),
                        )
                        .orderBy(desc(modelPrices.effectiveFrom))
                        .limit(1)
                        .get();
                    if (latest && samePrices(latest, entry.prices)) {
                        await this.db.update(modelPrices).set({ fetchedAt: at }).where(eq(modelPrices.id, latest.id));
                        continue;
                    }
                    let from = entry.effectiveFrom ?? at;
                    // A changed price never takes effect before the one it replaces.
                    if (latest && from <= latest.effectiveFrom) {
                        from = at;
                    }
                    if (latest && from <= latest.effectiveFrom) {
                        from = latest.effectiveFrom + 1;
                    }
                    await this.db.insert(modelPrices).values({
                        id: randomUUID(),
                        provider: entry.provider,
                        model: entry.model,
                        modelKey: entry.modelKey,
                        ...entry.prices,
                        currency: 'USD',
                        effectiveFrom: from,
                        source,
                        fetchedAt: at,
                    });
                    stored++;
                }
                return stored;
            },
            { label: 'record model prices' },
        );
    }

    addAdminPrice(price: AdminPrice, at: number) {
        return this.data.uow.run(
            async () => {
                const row = {
                    provider: price.provider,
                    model: price.model,
                    modelKey: modelKey(price.model),
                    inputPerM: price.inputPerM,
                    cachedInputPerM: price.cachedInputPerM,
                    outputPerM: price.outputPerM,
                    reasoningPerM: price.reasoningPerM,
                    currency: 'USD' as const,
                    effectiveFrom: price.effectiveFrom,
                    source: 'admin',
                    fetchedAt: at,
                };
                // One admin price per model and date: a second replaces the first.
                const same = await this.db
                    .select({ id: modelPrices.id })
                    .from(modelPrices)
                    .where(
                        and(
                            eq(modelPrices.provider, row.provider),
                            eq(modelPrices.model, row.model),
                            eq(modelPrices.source, 'admin'),
                            eq(modelPrices.effectiveFrom, row.effectiveFrom),
                        ),
                    )
                    .get();
                const id = same?.id ?? randomUUID();
                if (same) {
                    await this.db.update(modelPrices).set(row).where(eq(modelPrices.id, id));
                } else {
                    await this.db.insert(modelPrices).values({ id, ...row });
                }
                return priceOf({ id, ...row });
            },
            { label: 'save admin model price' },
        );
    }

    /** Removes an admin's price; synced ones can't be removed. */
    removeAdminPrice(id: string) {
        return this.data.uow.run(
            async () => {
                const row = await this.db
                    .select()
                    .from(modelPrices)
                    .where(and(eq(modelPrices.id, id), eq(modelPrices.source, 'admin')))
                    .get();
                if (!row) {
                    return undefined;
                }
                await this.db.delete(modelPrices).where(eq(modelPrices.id, id));
                return priceOf(row);
            },
            { label: 'remove admin model price' },
        );
    }

    /**
     * Records the backends in force (the inference module's, read through
     * its store): their provider and model, for the cost step. A backend
     * that went is kept with `removedAt`, so its old turns stay priced.
     * Writes only what changed.
     */
    recordBackends(live: readonly PricingBackend[], at: number) {
        return this.data.uow.run(
            async () => {
                const known = new Map((await this.db.select().from(costBackends).all()).map((row) => [row.id, row]));
                for (const backend of live) {
                    const row = {
                        id: backend.id,
                        kind: backend.kind,
                        label: backend.label,
                        provider: backend.provider,
                        model: backend.model,
                        removedAt: null,
                        updatedAt: at,
                    };
                    const old = known.get(backend.id);
                    known.delete(backend.id);
                    if (
                        old &&
                        old.kind === row.kind &&
                        old.label === row.label &&
                        old.provider === row.provider &&
                        old.model === row.model &&
                        old.removedAt === null
                    ) {
                        continue;
                    }
                    await this.db
                        .insert(costBackends)
                        .values(row)
                        .onConflictDoUpdate({ target: costBackends.id, set: row });
                }
                for (const gone of known.values()) {
                    if (gone.removedAt === null) {
                        await this.db
                            .update(costBackends)
                            .set({ removedAt: at, updatedAt: at })
                            .where(eq(costBackends.id, gone.id));
                    }
                }
            },
            { label: 'record cost backends' },
        );
    }

    async runs(): Promise<PriceSyncRun[]> {
        return (await this.db.select().from(priceSyncRuns).orderBy(asc(priceSyncRuns.source)).all()).map((row) => ({
            ...row,
            source: row.source as PriceSourceId,
        }));
    }

    recordRun(run: PriceSyncRun) {
        return this.data.uow.run(
            async () => {
                await this.db
                    .insert(priceSyncRuns)
                    .values(run)
                    .onConflictDoUpdate({ target: priceSyncRuns.source, set: run });
            },
            { label: 'record price sync run' },
        );
    }

    async pools(): Promise<CostPool[]> {
        return (await this.db.select().from(costPools).orderBy(asc(costPools.name), asc(costPools.id)).all()).map(
            (row) => ({ ...row, currency: 'USD' }),
        );
    }

    async pool(id: string): Promise<CostPool | undefined> {
        const row = await this.db.select().from(costPools).where(eq(costPools.id, id)).get();
        return row && { ...row, currency: 'USD' };
    }

    savePool(pool: CostPool) {
        return this.data.uow.run(
            async () => {
                await this.db
                    .insert(costPools)
                    .values(pool)
                    .onConflictDoUpdate({
                        target: costPools.id,
                        set: { ...pool, createdAt: undefined },
                    });
                return pool;
            },
            { label: 'save cost pool' },
        );
    }

    /** Removes a pool and its readings. */
    removePool(id: string) {
        return this.data.uow.run(
            async () => {
                const pool = await this.pool(id);
                if (!pool) {
                    return undefined;
                }
                await this.db.delete(costMeterReadings).where(eq(costMeterReadings.poolId, id));
                await this.db.delete(costPools).where(eq(costPools.id, id));
                return pool;
            },
            { label: 'remove cost pool' },
        );
    }

    /** Meter readings, newest first; one pool's when given. */
    async readings(poolId?: string, limit = 500): Promise<MeterReading[]> {
        return this.db
            .select()
            .from(costMeterReadings)
            .where(poolId ? eq(costMeterReadings.poolId, poolId) : undefined)
            .orderBy(desc(costMeterReadings.at), desc(costMeterReadings.id))
            .limit(limit)
            .all();
    }

    addReading(reading: Omit<MeterReading, 'id'>) {
        return this.data.uow.run(
            async () => {
                const row = { id: randomUUID(), ...reading };
                await this.db.insert(costMeterReadings).values(row);
                return row;
            },
            { label: 'add meter reading' },
        );
    }

    removeReading(id: string) {
        return this.data.uow.run(
            async () => {
                const row = await this.db.select().from(costMeterReadings).where(eq(costMeterReadings.id, id)).get();
                if (!row) {
                    return undefined;
                }
                await this.db.delete(costMeterReadings).where(eq(costMeterReadings.id, id));
                return row;
            },
            { label: 'remove meter reading' },
        );
    }
}
