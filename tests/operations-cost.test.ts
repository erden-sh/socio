import type { DatabaseSync } from 'node:sqlite';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import {
    DEFAULT_POOL_WEIGHTS,
    MONTH_MS,
    type CostPool,
    type ModelPrice,
} from '@socio/shared/operations/operations-cost';

import { ETL_STEPS } from '../src/server/operations/analytics/steps.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { costStep } from '../src/server/operations/etl/cost-step.js';
import { dimensionsStep } from '../src/server/operations/etl/dimensions-step.js';
import { runsStep } from '../src/server/operations/etl/runs-step.js';
import { taxonomyStep } from '../src/server/operations/etl/taxonomy-step.js';
import type { EtlStep } from '../src/server/operations/infra/duckdb/etl.js';
import { rows } from '../src/server/operations/infra/duckdb/open.js';
import { duckOpsQueries } from '../src/server/operations/infra/duckdb/ops-queries.js';
import { createSchema } from '../src/server/operations/infra/duckdb/schema.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { SqlitePricing } from '../src/server/operations/infra/sqlite/pricing.js';
import { PriceBook, tokenCost } from '../src/server/operations/pricing/cost.js';
import { providerOf } from '../src/server/operations/pricing/model-key.js';
import { allocatePools, poolCost, readingSpans, tokenWeight } from '../src/server/operations/pricing/pools.js';
import { traceEntry } from '../src/server/turns/turn-trace.js';

import { testDatabase } from './helpers/test-database.js';

// CB-195 and CB-196: turns priced by effective-dated model prices, and
// self-hosted backends by cost pools spread over their hours, in the
// analytics store's cost step and queries.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 0);

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const price = (fields: Partial<ModelPrice>): ModelPrice => ({
    id: fields.id ?? `${fields.source}-${fields.provider}-${fields.model}`,
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    modelKey: '',
    inputPerM: 1,
    cachedInputPerM: null,
    outputPerM: 2,
    reasoningPerM: null,
    currency: 'USD',
    effectiveFrom: T0,
    source: 'sync:openrouter',
    fetchedAt: T0,
    ...fields,
});

const pool = (fields: Partial<CostPool>): CostPool => ({
    id: 'pool-1',
    name: 'GPU box',
    kind: 'fixed',
    category: 'hardware',
    amount: 1,
    currency: 'USD',
    period: 'hour',
    depreciationMonths: null,
    startsAt: T0,
    endsAt: null,
    backendIds: ['local'],
    allocation: 'tokens',
    weights: DEFAULT_POOL_WEIGHTS,
    createdAt: T0,
    updatedAt: T0,
    ...fields,
});

const tokens = (input: number, output: number, cached = 0) => ({
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    reasoningTokens: null,
});

describe('turn prices', () => {
    it('prices uncached and cached input and output per million tokens', () => {
        const at = price({ inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8 });
        expect(tokenCost(tokens(1000, 500, 400), at)).toBeCloseTo((600 * 2 + 400 * 0.5 + 500 * 8) / 1e6, 12);
        // No cached price: cached input at the input price.
        expect(tokenCost(tokens(1000, 0, 400), price({}))).toBeCloseTo(1000 / 1e6);
        expect(
            tokenCost({ ...tokens(0, 100), reasoningTokens: 40 }, price({ outputPerM: 2, reasoningPerM: 5 })),
        ).toBeCloseTo((100 * 2 + 40 * 3) / 1e6);
        expect(
            tokenCost(
                {
                    inputTokens: null,
                    cachedTokens: null,
                    outputTokens: null,
                    reasoningTokens: null,
                },
                price({}),
            ),
        ).toBeNull();
    });

    it('uses an admin price from its date on, then the provider’s, then a catalog’s', () => {
        const book = new PriceBook([
            price({ source: 'catalog:models.dev', inputPerM: 9, effectiveFrom: 0 }),
            price({ inputPerM: 1, effectiveFrom: T0 }),
            price({ id: 'later', inputPerM: 3, effectiveFrom: T0 + 10 * HOUR }),
            price({ source: 'admin', inputPerM: 5, effectiveFrom: T0 + 20 * HOUR }),
        ]);
        const at = (time: number) => book.lookup('openrouter', 'openai/gpt-4o-mini', time)?.inputPerM;
        expect(at(T0 - HOUR)).toBe(9); // before the provider's first: the catalog's
        expect(at(T0 + HOUR)).toBe(1);
        expect(at(T0 + 11 * HOUR)).toBe(3);
        expect(at(T0 + 21 * HOUR)).toBe(5);
        // Another provider's prices are not this one's.
        expect(book.lookup('deepinfra', 'openai/gpt-4o-mini', T0)).toBeUndefined();
        // By key: the same model under another name.
        expect(book.lookup('openrouter', 'gpt-4o-mini', T0 + HOUR)?.inputPerM).toBe(1);
    });

    it('backfills a synced price before its first date, but never an admin’s', () => {
        const book = new PriceBook([
            price({ inputPerM: 1, effectiveFrom: T0 }),
            price({
                source: 'admin',
                provider: '*',
                inputPerM: 7,
                effectiveFrom: T0 + HOUR,
            }),
        ]);
        expect(book.lookup('openrouter', 'openai/gpt-4o-mini', 0)?.inputPerM).toBe(1);
        expect(book.lookup('openrouter', 'openai/gpt-4o-mini', T0 + 2 * HOUR)?.inputPerM).toBe(7);
        // An admin's `*` price holds for any provider from its date.
        expect(book.lookup('self-hosted', 'gpt-4o-mini', T0 + 2 * HOUR)?.inputPerM).toBe(7);
        expect(book.lookup('self-hosted', 'gpt-4o-mini', T0)).toBeUndefined();
    });

    it('takes the cheapest cloud price as a self-hosted model’s reference', () => {
        const book = new PriceBook([
            price({
                provider: 'deepinfra',
                model: 'Qwen/Qwen3-32B',
                inputPerM: 0.1,
                outputPerM: 0.3,
            }),
            price({
                provider: 'together',
                model: 'Qwen/Qwen3-32B',
                source: 'catalog:models.dev',
                inputPerM: 0.2,
                outputPerM: 0.6,
            }),
            price({
                provider: 'self-hosted',
                model: 'qwen3-32b',
                source: 'admin',
                inputPerM: 0,
                outputPerM: 0,
            }),
        ]);
        expect(book.reference('qwen3-32b', T0, tokens(1000, 100))).toBeCloseTo((1000 * 0.1 + 100 * 0.3) / 1e6);
        expect(book.reference('unlisted', T0, tokens(1, 1))).toBeUndefined();
    });
});

describe('cost pools', () => {
    it('spreads fixed, depreciated and metered costs over their hours', () => {
        expect(poolCost(pool({ amount: 24, period: 'day' }), [], T0, T0 + HOUR)).toBeCloseTo(1);
        const bought = pool({ amount: 3600, depreciationMonths: 36 });
        expect(poolCost(bought, [], T0, T0 + 36 * MONTH_MS)).toBeCloseTo(3600);
        // Written off: nothing after its months.
        expect(poolCost(bought, [], T0 + 36 * MONTH_MS, T0 + 37 * MONTH_MS)).toBe(0);
        const metered = pool({ kind: 'variable', amount: 0.2, startsAt: T0 });
        const spans = readingSpans(metered, [
            {
                id: 'r1',
                poolId: 'pool-1',
                at: T0 + 2 * HOUR,
                quantity: 10,
                unit: 'kWh',
                unitPrice: null,
            },
            {
                id: 'r2',
                poolId: 'pool-1',
                at: T0 + 3 * HOUR,
                quantity: 5,
                unit: 'kWh',
                unitPrice: 0.4,
            },
        ]);
        expect(poolCost(metered, spans, T0, T0 + HOUR)).toBeCloseTo(1); // 10 kWh × $0.20 over 2 h
        expect(poolCost(metered, spans, T0 + 2 * HOUR, T0 + 3 * HOUR)).toBeCloseTo(2);
    });

    it('allocates each hour to its turns by weighted tokens, the rest idle, and reconciles', () => {
        const turns = [
            {
                seq: 1,
                startedAt: T0 + 60_000,
                backend: 'local',
                ...tokens(1000, 100),
            },
            {
                seq: 2,
                startedAt: T0 + 120_000,
                backend: 'local',
                ...tokens(2000, 50, 1000),
            },
            {
                seq: 3,
                startedAt: T0 + 180_000,
                backend: 'cloud',
                ...tokens(9000, 900),
            },
        ];
        const { shares, hours } = allocatePools({
            pools: [pool({})],
            readings: [],
            turns,
            from: T0,
            to: T0 + 3 * HOUR + 1,
        });
        const w1 = tokenWeight(turns[0]!, DEFAULT_POOL_WEIGHTS);
        const w2 = tokenWeight(turns[1]!, DEFAULT_POOL_WEIGHTS);
        expect(w2).toBeCloseTo(1000 + 100 + 200);
        expect(shares.get(1)).toBeCloseTo(w1 / (w1 + w2));
        expect(shares.get(2)).toBeCloseTo(w2 / (w1 + w2));
        expect(shares.has(3)).toBe(false);
        expect(hours).toHaveLength(4);
        const total = hours.reduce((sum, hour) => sum + hour.costUsd, 0);
        const allocated = hours.reduce((sum, hour) => sum + hour.allocatedUsd, 0);
        expect(total).toBeCloseTo(4);
        expect(allocated).toBeCloseTo(1);
        expect(allocated + (total - allocated)).toBeCloseTo(total);
        // GPU-seconds have no meter yet: turns are the pool's, at no share.
        const gpu = allocatePools({
            pools: [pool({ allocation: 'gpu_seconds' })],
            readings: [],
            turns,
            from: T0,
            to: T0 + 1,
        });
        expect(gpu.shares.get(1)).toBe(0);
        expect(gpu.hours[0]).toMatchObject({
            costUsd: 1,
            allocatedUsd: 0,
            turns: 2,
        });
    });
});

/** A small workspace: one socio, one person, three backends. */
function workspaceDb() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    db.prepare("INSERT INTO spaces (id, name, description, createdAt) VALUES ('space-1', 'Space', '', ?)").run(
        T0 - HOUR,
    );
    db.prepare(
        "INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES ('socio-a', 'space-1', 'Homelab', '', 0, 0, ?)",
    ).run(T0 - HOUR);
    db.prepare(
        "INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES ('alice', 'Alice', 'member', ?, ?)",
    ).run(T0 - HOUR, T0);
    db.prepare(
        "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES ('chat-1', 'socio-a', 'alice', 'A chat', ?)",
    ).run(T0 - HOUR);
    let n = 0;
    const run = (startedAt: number, model: string, backendId: string | undefined, input: number, output: number) => {
        const runId = `run-${++n}`;
        db.prepare(
            "INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES ('chat-1', ?, 'finished', '[]', ?, ?, 'web', ?)",
        ).run(
            runId,
            startedAt,
            startedAt + 1000,
            JSON.stringify({
                turn: {
                    label: 'x',
                    model,
                    source: 'shared',
                    ...(backendId ? { backendId } : {}),
                    cap: 12,
                },
                rounds: [],
                tools: [],
                waits: [],
                end: { reason: 'completed', rounds: 1, cap: 12 },
                totals: { rounds: 1, inputTokens: input, outputTokens: output },
                trigger: { kind: 'person', id: 'alice' },
                messages: [],
            }),
        );
        return runId;
    };
    return { db, run };
}

async function duck() {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    cleanup.push(() => {
        connection.closeSync();
        instance.closeSync();
    });
    await createSchema(connection, ETL_STEPS, 'test');
    return connection;
}

/** Runs the steps the cost answer needs, each to its end, as the engine does. */
async function cycle(
    db: DatabaseSync,
    connection: DuckDBConnection,
    now: number,
    steps: readonly EtlStep[] = [runsStep, taxonomyStep, costStep, dimensionsStep],
) {
    const context = { settings: analyticsDefaults({}), timeZone: 'UTC', now };
    for (const step of steps) {
        for (;;) {
            const [state] = await rows<{ watermark: string | null }>(
                connection,
                'SELECT watermark FROM etl_state WHERE source = $1',
                [step.source],
            );
            const batch = await step.batch({
                sqlite: db,
                duck: connection,
                watermark: state?.watermark ?? null,
                rebuilding: false,
                context,
            });
            await connection.run(
                `INSERT INTO etl_state VALUES ($1, $2, $3) ON CONFLICT (source) DO UPDATE SET watermark = excluded.watermark, "at" = excluded."at"`,
                [step.source, batch.watermark ?? state?.watermark ?? null, BigInt(now)],
            );
            if (batch.caughtUp) {
                break;
            }
        }
    }
}

const scope = (from: number, to: number): OpsScope => ({
    window: {
        from,
        to,
        bucket: 'hour',
        buckets: ['hour'],
        previous: null,
        timeZone: 'UTC',
    },
    filters: {},
});

it('records which shared backend served a turn in its trace', () => {
    const turn = { kind: 'turn', label: 'Local GPU', model: 'qwen3-32b', cap: 3 };
    expect(traceEntry({ ...turn, source: 'shared', backendId: 'b-1' })).toMatchObject({
        source: 'shared',
        backendId: 'b-1',
    });
    expect(traceEntry({ ...turn, source: 'byo:byo-chatgpt' })).not.toHaveProperty('backendId');
});

describe('the cost step and Cost queries', () => {
    it('prices turns by effective-dated prices and pools, marks the rest none, and reconciles pools', async () => {
        const { db, run } = workspaceDb();
        const pricing = new SqlitePricing(sqliteData(db));
        // The app's copy of the backends: their providers from their base URLs.
        const shared = (id: string, baseUrl: string, model: string) => ({
            id,
            label: id,
            kind: 'shared' as const,
            model,
            provider: providerOf(baseUrl),
            enabled: true,
        });
        await pricing.recordBackends(
            [
                shared('cloud', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini'),
                shared('local', 'http://10.0.0.5:8000/v1', 'qwen3-32b'),
                shared('other', 'https://api.example.com/v1', 'mystery-1'),
                shared('gone', 'https://api.openai.com/v1', 'gpt-4o'),
            ],
            T0,
        );
        // A backend that went is kept, so its old turns stay priced.
        await pricing.recordBackends(
            [
                shared('cloud', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini'),
                shared('local', 'http://10.0.0.5:8000/v1', 'qwen3-32b'),
                shared('other', 'https://api.example.com/v1', 'mystery-1'),
            ],
            T0 + 1,
        );
        expect(db.prepare("SELECT removedAt FROM cost_backends WHERE id = 'gone'").get()).toEqual({
            removedAt: T0 + 1,
        });
        await pricing.recordSynced(
            'sync:openrouter',
            [
                {
                    provider: 'openrouter',
                    model: 'openai/gpt-4o-mini',
                    modelKey: 'gpt4omini',
                    prices: {
                        inputPerM: 0.15,
                        cachedInputPerM: null,
                        outputPerM: 0.6,
                        reasoningPerM: null,
                    },
                    effectiveFrom: T0,
                },
            ],
            T0,
        );
        await pricing.recordSynced(
            'sync:deepinfra',
            [
                {
                    provider: 'deepinfra',
                    model: 'Qwen/Qwen3-32B',
                    modelKey: 'qwen332b',
                    prices: {
                        inputPerM: 0.1,
                        cachedInputPerM: null,
                        outputPerM: 0.3,
                        reasoningPerM: null,
                    },
                },
            ],
            T0,
        );
        // An admin's price wins from its date on.
        await pricing.addAdminPrice(
            {
                provider: 'openrouter',
                model: 'openai/gpt-4o-mini',
                inputPerM: 1,
                cachedInputPerM: null,
                outputPerM: 2,
                reasoningPerM: null,
                effectiveFrom: T0 + 2 * HOUR,
            },
            T0,
        );
        await pricing.savePool(pool({}));
        run(T0 + 30 * 60_000, 'openai/gpt-4o-mini', 'cloud', 1000, 500);
        run(T0 + 3 * HOUR, 'openai/gpt-4o-mini', 'cloud', 1000, 500);
        run(T0 + 10 * 60_000, 'qwen3-32b', 'local', 1000, 100);
        // An older turn without a backend id: the one backend serving its model.
        run(T0 + 20 * 60_000, 'qwen3-32b', undefined, 2000, 50);
        run(T0 + HOUR, 'mystery-1', 'other', 10, 10);

        const connection = await duck();
        const now = T0 + 4 * HOUR + 30 * 60_000;
        await cycle(db, connection, now);

        const turns = await rows<{
            seq: number;
            cost_usd: number | null;
            cost_basis: string;
            cost_backend: string;
            cost_source: string | null;
        }>(connection, 'SELECT seq, cost_usd, cost_basis, cost_backend, cost_source FROM f_turn ORDER BY seq');
        expect(turns.map((turn) => turn.cost_basis)).toEqual(['price', 'price', 'pool', 'pool', 'none']);
        expect(turns[0]!.cost_usd).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1e6, 12);
        expect(turns[0]!.cost_source).toBe('sync:openrouter');
        expect(turns[1]!.cost_usd).toBeCloseTo((1000 * 1 + 500 * 2) / 1e6, 12);
        expect(turns[1]!.cost_source).toBe('admin');
        expect(turns[3]!.cost_backend).toBe('local');
        expect(turns[2]!.cost_usd! + turns[3]!.cost_usd!).toBeCloseTo(1, 9);
        expect(turns[4]).toMatchObject({
            cost_usd: null,
            cost_basis: 'none',
            cost_backend: 'other',
        });

        const queries = duckOpsQueries(connection);
        const cost = await queries.cost(scope(T0, T0 + 5 * HOUR));
        expect(cost.totals).toMatchObject({
            turns: 5,
            priced: 2,
            pooled: 2,
            unpriced: 1,
        });
        expect(cost.totals.costUsd).toBeCloseTo(1 + 0.00045 + 0.002, 9);
        // Five hours of the pool (up to the hour `now` is in), one of them used.
        expect(cost.pools).toHaveLength(1);
        const [only] = cost.pools;
        expect(only!.costUsd).toBeCloseTo(5);
        expect(only!.allocatedUsd).toBeCloseTo(1);
        expect(only!.idleUsd).toBeCloseTo(4);
        expect(only!.allocatedUsd + only!.idleUsd).toBeCloseTo(only!.costUsd, 9);
        expect(cost.totals.idleUsd).toBeCloseTo(4);
        const local = cost.backends.find((row) => row.backend === 'local')!;
        expect(local.poolUsd).toBeCloseTo(1);
        expect(local.referenceUsd).toBeCloseTo((3000 * 0.1 + 150 * 0.3) / 1e6, 12);
        expect(cost.unpricedModels).toEqual([{ model: 'mystery-1', backend: 'other', turns: 1 }]);
        expect(cost.byPerson).toMatchObject([{ key: 'alice', name: 'Alice', turns: 5 }]);
        expect(cost.bySocio[0]).toMatchObject({ key: 'socio-a', name: 'Homelab' });
        expect(cost.series.reduce((sum, point) => sum + point.priceUsd + point.poolUsd, 0)).toBeCloseTo(
            cost.totals.costUsd,
            9,
        );
        expect(await queries.costModels({})).toEqual(['mystery-1', 'openai/gpt-4o-mini', 'qwen3-32b']);

        // A new turn shares its hour; the pool's idle hour becomes allocated.
        run(T0 + 2 * HOUR + 60_000, 'qwen3-32b', 'local', 500, 20);
        await cycle(db, connection, now + 60_000);
        const again = await queries.cost(scope(T0, T0 + 5 * HOUR));
        expect(again.pools[0]!.allocatedUsd).toBeCloseTo(2);
        expect(again.pools[0]!.idleUsd).toBeCloseTo(3);
        expect(again.totals.pooled).toBe(3);

        // A price change reprices every turn (the hash of the inputs changed).
        await pricing.removeAdminPrice((await pricing.prices()).find((row) => row.source === 'admin')!.id);
        await cycle(db, connection, now + 120_000);
        const [second] = await rows<{ cost_usd: number; cost_source: string }>(
            connection,
            'SELECT cost_usd, cost_source FROM f_turn WHERE seq = 2',
        );
        expect(second!.cost_source).toBe('sync:openrouter');
        expect(second!.cost_usd).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1e6, 12);

        // Running the cycle again changes nothing.
        const before = await queries.cost(scope(T0, T0 + 5 * HOUR));
        await cycle(db, connection, now + 120_000);
        expect(await queries.cost(scope(T0, T0 + 5 * HOUR))).toEqual(before);
    });

    it('answers the same from memory, and null before the store is ready', async () => {
        const reader = new MemoryOpsReader({
            turns: [
                {
                    runId: 'a',
                    threadId: 'c',
                    socioId: 's',
                    source: 'web',
                    status: 'finished',
                    startedAt: T0 + 1000,
                    inputTokens: 10,
                    outputTokens: 5,
                    model: 'm',
                    personId: 'alice',
                    costBackend: 'local',
                    costUsd: 0.5,
                    costBasis: 'pool',
                    refCostUsd: 0.1,
                },
                {
                    runId: 'b',
                    threadId: 'c',
                    socioId: 's',
                    source: 'web',
                    status: 'finished',
                    startedAt: T0 + 2000,
                    inputTokens: 10,
                    outputTokens: 5,
                    model: 'n',
                    personId: 'alice',
                    costBackend: 'other',
                    costUsd: null,
                    costBasis: 'none',
                },
            ],
            poolHours: [
                {
                    poolId: 'pool-1',
                    hourAt: T0,
                    costUsd: 0.5,
                    allocatedUsd: 0.5,
                    turns: 1,
                },
                {
                    poolId: 'pool-1',
                    hourAt: T0 + HOUR,
                    costUsd: 0.5,
                    allocatedUsd: 0,
                    turns: 0,
                },
            ],
        });
        const cost = await reader.cost(scope(T0, T0 + 2 * HOUR));
        expect(cost!.totals).toMatchObject({
            costUsd: 0.5,
            pooled: 1,
            unpriced: 1,
            idleUsd: 0.5,
        });
        expect(cost!.pools).toEqual([
            {
                poolId: 'pool-1',
                costUsd: 1,
                allocatedUsd: 0.5,
                idleUsd: 0.5,
                turns: 1,
            },
        ]);
        expect(cost!.unpricedModels).toEqual([{ model: 'n', backend: 'other', turns: 1 }]);
        expect(await new MemoryOpsReader().cost(scope(T0, T0 + HOUR))).toBeNull();
    });
});
