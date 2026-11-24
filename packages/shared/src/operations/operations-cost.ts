/**
 * Operations → Cost (CB-195, CB-196): what turns cost, priced by the
 * model prices Socio keeps (synced from providers' and community price
 * lists, or entered by an admin), and what self-hosted backends cost,
 * from cost pools spread over the turns they served. Shared by the
 * server, the analytics process and the Cost page.
 */
import type { OpsStatus, OpsWindow } from './operations.js';

/**
 * How a turn's `cost_usd` was worked out: by a model `price` in force when
 * it started, by the cost `pool`s of its backend (CB-196), or `none` (no
 * price for its model; its cost is unknown, never 0).
 */
export const COST_BASES = ['price', 'pool', 'none'] as const;
export type CostBasis = (typeof COST_BASES)[number];

/**
 * Where a price came from: a provider's price API (`sync:<source>`), a
 * community list (`catalog:<source>`), or an admin (`admin`). An admin's
 * price wins from its date onward, then a provider's, then a catalog's.
 */
export type PriceOrigin = 'admin' | `sync:${string}` | `catalog:${string}`;

/** The price lists the daily sync reads; none needs an API key. */
export const PRICE_SOURCES = {
    openrouter: { kind: 'sync', label: 'OpenRouter' },
    deepinfra: { kind: 'sync', label: 'DeepInfra' },
    azure: { kind: 'sync', label: 'Azure Retail Prices' },
    aws: { kind: 'sync', label: 'AWS Price List (Bedrock)' },
    'models.dev': { kind: 'catalog', label: 'models.dev' },
    litellm: { kind: 'catalog', label: 'LiteLLM price list' },
} as const satisfies Record<string, { kind: 'sync' | 'catalog'; label: string }>;
export type PriceSourceId = keyof typeof PRICE_SOURCES;
export const PRICE_SOURCE_IDS = Object.keys(PRICE_SOURCES) as PriceSourceId[];

/** The origin a source's prices are stored under. */
export const originOf = (source: PriceSourceId): PriceOrigin =>
    `${PRICE_SOURCES[source].kind}:${source}` as PriceOrigin;

/** US dollars per million tokens; null when the list doesn't say. */
export interface TokenPrices {
    inputPerM: number;
    cachedInputPerM: number | null;
    outputPerM: number;
    /** Only when reasoning is billed apart from output (rare). */
    reasoningPerM: number | null;
}

/** A row of `model_prices`: one price for a model at one provider, from a date. */
export interface ModelPrice extends TokenPrices {
    id: string;
    /** `openai`, `openrouter`, `azure`, … (`providerOf`), or what an admin typed. */
    provider: string;
    /** As the source names it. */
    model: string;
    /** The model's key for matching (`modelKey`). */
    modelKey: string;
    currency: 'USD';
    /** In force from this time (ms) until the next price of the same origin. */
    effectiveFrom: number;
    source: PriceOrigin;
    /** When it was fetched or entered. */
    fetchedAt: number;
}

/** The last run of one price source. */
export interface PriceSyncRun {
    source: PriceSourceId;
    at: number;
    ok: boolean;
    /** Entries the list held, and those that matched a model in use. */
    fetched: number;
    matched: number;
    /** New prices stored (a price that didn't change is not stored again). */
    stored: number;
    /** A short reason when it failed (never a URL's query or a body). */
    error: string | null;
}

/** Operations → Settings → Price sync, and the Cost page's header. */
export interface PriceSyncView {
    /** In force: an admin's choice over the server's. */
    enabled: boolean;
    /** The server's (`OPS_PRICE_SYNC`; on in production images when unset). */
    serverDefault: boolean;
    /** An admin saved a choice (else the server's applies). */
    saved: boolean;
    /** The models the sync keeps prices for: the ones in use. */
    watched: string[];
    runs: PriceSyncRun[];
    /** When the next daily run is due; null while off. */
    nextAt: number | null;
    /** A run is going now. */
    running: boolean;
}

/** A pool's costs are fixed per period (or a purchase written off) or metered. */
export const POOL_KINDS = ['fixed', 'variable'] as const;
export type PoolKind = (typeof POOL_KINDS)[number];
export const POOL_CATEGORIES = ['hardware', 'power', 'hosting', 'subscription', 'other'] as const;
export type PoolCategory = (typeof POOL_CATEGORIES)[number];
/** A fixed pool's amount is per this period (unless it is depreciated). */
export const POOL_PERIODS = ['hour', 'day', 'month', 'year'] as const;
export type PoolPeriod = (typeof POOL_PERIODS)[number];
/**
 * How a pool's hour is shared among that hour's turns: by weighted
 * `tokens`, or by `gpu_seconds` (no meter records those yet: such a
 * pool's cost all shows as idle until one does).
 */
export const POOL_ALLOCATIONS = ['tokens', 'gpu_seconds'] as const;
export type PoolAllocation = (typeof POOL_ALLOCATIONS)[number];

/** Token weights for `tokens` allocation; uncached input counts 1. */
export interface PoolWeights {
    input: number;
    cached: number;
    output: number;
}
export const DEFAULT_POOL_WEIGHTS: PoolWeights = {
    input: 1,
    cached: 0.1,
    output: 4,
};

/**
 * A cost pool (CB-196): what running some backends costs, spread hourly
 * over the turns they served. A backend is a shared backend's id or a
 * bring-your-own kind (`byo:byo-chatgpt`, for subscription pools).
 */
export interface CostPool {
    id: string;
    name: string;
    kind: PoolKind;
    category: PoolCategory;
    /**
     * Fixed: dollars per `period`, or the purchase price when
     * `depreciationMonths` is set. Variable: the default dollars per unit
     * of a meter reading.
     */
    amount: number;
    currency: 'USD';
    period: PoolPeriod;
    /** Straight-line write-off of `amount` over this many months. */
    depreciationMonths: number | null;
    startsAt: number;
    endsAt: number | null;
    backendIds: string[];
    allocation: PoolAllocation;
    weights: PoolWeights;
    createdAt: number;
    updatedAt: number;
}

/** A variable pool's use since its previous reading (or its start). */
export interface MeterReading {
    id: string;
    poolId: string;
    at: number;
    quantity: number;
    unit: string;
    /** Dollars per unit; the pool's `amount` when null. */
    unitPrice: number | null;
}

/** An average month, for per-month amounts and write-offs. */
export const MONTH_MS = (365.25 / 12) * 86_400_000;
export const HOUR_MS = 3_600_000;

/** One row of a cost breakdown. */
export interface OpsCostRow {
    key: string;
    /** The socio's or person's name, when the store knows it. */
    name: string | null;
    turns: number;
    tokens: number;
    costUsd: number;
    /** Turns with no price (`cost_basis` none). */
    unpriced: number;
}

/** What one backend's turns cost, and what the cloud would have charged. */
export interface OpsCostBackend {
    /** A shared backend's id, `byo:<kind>`, or `shared` for older turns. */
    backend: string;
    turns: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costUsd: number;
    /** The part from its cost pools (CB-196), and its turns' tokens. */
    poolUsd: number;
    pooledTokens: number;
    /** Its pooled turns at the cheapest listed cloud price for their models. */
    referenceUsd: number | null;
    unpriced: number;
}

/** A cost pool over the window: what it cost, what turns took, what idled. */
export interface OpsCostPool {
    poolId: string;
    costUsd: number;
    allocatedUsd: number;
    idleUsd: number;
    turns: number;
}

/**
 * A room's cost and use over the window (CB-218): its turns as any cost
 * row, and its work cycles. `key` is the room's id, `name` its name.
 */
export interface OpsRoomCost extends OpsCostRow {
    /** Work cycles with a step in the window: one person's message each. */
    cycles: number;
    /** Steps after a cycle's first (a socio handing on, CB-206). */
    handoffs: number;
    /** Cycles a limit stopped (time, tokens, handoffs or spend). */
    exhausted: number;
    /** People who started its turns, and socios that ran them. */
    people: number;
    socios: number;
}

/** The limits that stop a work cycle (CB-211's `CycleStop`). */
export const CYCLE_LIMITS = ['deadline', 'tokens', 'handoffs', 'spend'] as const;
export type CycleLimit = (typeof CYCLE_LIMITS)[number];

/**
 * Work cycles over the window (CB-218): those with a step (a turn) in it
 * that follows the filters. A cycle is one person's message and all it
 * led to; a turn is one socio's step of it; a retry is part of its turn.
 */
export interface OpsCycleSummary {
    cycles: number;
    /** Of them, in rooms. */
    inRooms: number;
    /** Their steps in the window (turns that recorded a cycle). */
    steps: number;
    /** Steps after a cycle's first. */
    handoffs: number;
    /** Cycles stopped by each limit. */
    exhausted: Record<CycleLimit, number>;
    /** Cycles a person stopped. */
    stopped: number;
    /** Cycles whose provider-reported spend is unknown (not 0). */
    spendUnknown: number;
    /** Of ended cycles: the time their steps ran (waits left out), and start to end. */
    runningMs: number;
    wallMs: number;
}

/** Operations → Cost's numbers for a window (`GET /api/operations/cost`). */
export interface OpsCost {
    totals: {
        costUsd: number;
        previousCostUsd: number | null;
        turns: number;
        priced: number;
        pooled: number;
        unpriced: number;
        tokens: number;
        idleUsd: number;
    };
    /** Turns' cost per bucket, every bucket present. */
    series: { at: number; priceUsd: number; poolUsd: number }[];
    byModel: OpsCostRow[];
    bySocio: OpsCostRow[];
    byPerson: OpsCostRow[];
    /**
     * Who paid (CB-218): a person's own subscription (`key` their id), the
     * workspace (`workspace`), or not recorded (`''`, turns before CB-211).
     */
    byPayer: OpsCostRow[];
    /** Rooms' turns and cycles (CB-218), the costliest first. */
    byRoom: OpsRoomCost[];
    cycles: OpsCycleSummary;
    backends: OpsCostBackend[];
    pools: OpsCostPool[];
    /** Models turns used with no price, the most turns first. */
    unpricedModels: { model: string; backend: string; turns: number }[];
}

/** The most rows a breakdown has. */
export const OPS_COST_ROWS = 50;

/** `GET /api/operations/cost`: the window's numbers, with the store's status. */
export interface OpsCostView {
    status: OpsStatus;
    window: OpsWindow;
    /** Null while the store can't answer. */
    cost: OpsCost | null;
}

/** A backend the Cost page can price or pool: a shared one or a bring-your-own kind. */
export interface PricingBackend {
    /** A shared backend's id, or `byo:<kind>`. */
    id: string;
    label: string;
    kind: 'shared' | 'byo';
    model: string | null;
    /** What its prices are listed under (`providerOf`). */
    provider: string;
    enabled: boolean;
}

/** `GET /api/operations/pricing`: everything the Cost page's admin parts show. */
export interface PricingView {
    sync: PriceSyncView;
    prices: ModelPrice[];
    backends: PricingBackend[];
    pools: CostPool[];
    readings: MeterReading[];
}
