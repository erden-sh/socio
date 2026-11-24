import type { OperationsSettings } from '@socio/shared/operations/operations';
import { originOf, type PriceSyncRun, type PriceSyncView } from '@socio/shared/operations/operations-cost';

import type { SqlitePricing, SyncedPrice } from '../infra/sqlite/pricing.js';

import { PriceFetchError, priceFetcher, type PriceGet } from './fetch.js';
import { modelKey } from './model-key.js';
import { PRICE_SOURCE_ADAPTERS, type PriceSource } from './sources.js';

const DAY = 86_400_000;
/** A failed source is tried again after this long, not the next minute. */
const RETRY_MS = 3_600_000;

/**
 * Whether the daily price sync runs (CB-195): an admin's choice in
 * Operations → Settings over the server's (`OPS_PRICE_SYNC`).
 */
export function priceSyncEnabled(saved: OperationsSettings | undefined, env: OperationsSettings | undefined) {
    const choice = saved?.pricing?.sync;
    return typeof choice === 'boolean' ? choice : (env?.pricing?.sync ?? false);
}

/**
 * `OPS_PRICE_SYNC` (`on` or `off`); unset, it is on in production images
 * (`NODE_ENV=production`) and off elsewhere, so a development server
 * never calls out unless told to.
 */
export function priceSyncFromEnv(env: Record<string, string | undefined>) {
    const raw = env.OPS_PRICE_SYNC?.trim().toLowerCase();
    if (!raw) {
        return env.NODE_ENV === 'production';
    }
    if (['on', 'true', '1'].includes(raw)) {
        return true;
    }
    if (['off', 'false', '0'].includes(raw)) {
        return false;
    }
    throw new Error('OPS_PRICE_SYNC must be on or off.');
}

export interface PriceSyncDeps {
    repo: SqlitePricing;
    /** Whether the switch is on now (read on every tick). */
    enabled: () => boolean;
    /** The models in use, as backends, connections and turns name them. */
    watched: () => Promise<string[]>;
    /** The sources' reader; a loopback fake in tests and development. */
    get?: PriceGet;
    /** `OPS_PRICE_SYNC_URL`, when `get` isn't given. */
    origin?: string;
    sources?: readonly PriceSource[];
    now?: () => number;
    log?: (line: string) => void;
    /** After a run stored prices: the analytics store prices turns again. */
    changed?: () => void;
}

/**
 * The daily price sync (CB-195): while the switch is on, once a day, it
 * reads every source's full list, keeps the prices of the models in use
 * (by exact name or `modelKey`) and stores a new row only when a price
 * changed. With the switch off it makes no request at all. Runs one at a
 * time; `stop()` aborts one in flight.
 */
export class PriceSync {
    private running?: Promise<void>;
    private controller = new AbortController();
    private readonly sources: readonly PriceSource[];
    private readonly now: () => number;

    constructor(private deps: PriceSyncDeps) {
        this.sources = deps.sources ?? PRICE_SOURCE_ADAPTERS;
        this.now = deps.now ?? Date.now;
    }

    /** When the next run is due: a day after the oldest source's last run. */
    async nextAt(): Promise<number | null> {
        if (!this.deps.enabled()) {
            return null;
        }
        const runs = new Map((await this.deps.repo.runs()).map((run) => [run.source, run]));
        let next = -Infinity;
        for (const source of this.sources) {
            const run = runs.get(source.id);
            if (!run) {
                return this.now();
            }
            const due = run.at + (run.ok ? DAY : RETRY_MS);
            next = next === -Infinity ? due : Math.min(next, due);
        }
        return next === -Infinity ? null : next;
    }

    /** From the module's tick: starts a run when one is due; never waits for it. */
    async tick() {
        if (this.running || !this.deps.enabled()) {
            return;
        }
        const next = await this.nextAt();
        if (next !== null && next <= this.now()) {
            void this.run(true);
        }
    }

    /** Runs now (an admin's "Sync now"), or joins the run in progress. */
    run(onlyDue = false): Promise<void> {
        if (!this.deps.enabled()) {
            return Promise.resolve();
        }
        if (this.controller.signal.aborted) {
            this.controller = new AbortController();
        }
        this.running ??= this.sync(onlyDue).finally(() => {
            this.running = undefined;
        });
        return this.running;
    }

    get busy() {
        return !!this.running;
    }

    async stop() {
        this.controller.abort();
        await this.running?.catch(() => undefined);
    }

    async view(serverDefault: boolean, saved: boolean): Promise<PriceSyncView> {
        return {
            enabled: this.deps.enabled(),
            serverDefault,
            saved,
            watched: await this.watchedModels(),
            runs: await this.deps.repo.runs(),
            nextAt: await this.nextAt(),
            running: this.busy,
        };
    }

    private async watchedModels() {
        const names = (await this.deps.watched().catch(() => [])).filter((name) => name.trim() && modelKey(name));
        return [...new Set(names)].sort();
    }

    private async sync(onlyDue: boolean) {
        const signal = this.controller.signal;
        const get = this.deps.get ?? priceFetcher({ origin: this.deps.origin, signal });
        const watched = await this.watchedModels();
        const names = new Set(watched.map((name) => name.toLowerCase()));
        const keys = new Set(watched.map(modelKey));
        const last = new Map((await this.deps.repo.runs()).map((run) => [run.source, run]));
        let stored = 0;
        for (const source of this.sources) {
            // The switch can go off mid-run: then the next source isn't read.
            if (signal.aborted || !this.deps.enabled()) {
                break;
            }
            const previous = last.get(source.id);
            if (onlyDue && previous && previous.at + (previous.ok ? DAY : RETRY_MS) > this.now()) {
                continue;
            }
            const at = this.now();
            let run: PriceSyncRun;
            try {
                const entries = await source.read(get);
                const found: SyncedPrice[] = [];
                for (const entry of entries) {
                    const key = [entry.model, ...(entry.aliases ?? [])]
                        .map((name) =>
                            names.has(name.toLowerCase()) || keys.has(modelKey(name)) ? modelKey(name) : '',
                        )
                        .find(Boolean);
                    if (key) {
                        found.push({
                            provider: entry.provider,
                            model: entry.model,
                            modelKey: key,
                            prices: entry.prices,
                            effectiveFrom: entry.effectiveFrom,
                        });
                    }
                }
                const added = await this.deps.repo.recordSynced(originOf(source.id), found, at);
                stored += added;
                run = {
                    source: source.id,
                    at,
                    ok: true,
                    fetched: entries.length,
                    matched: found.length,
                    stored: added,
                    error: null,
                };
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                const reason =
                    error instanceof PriceFetchError
                        ? error.message
                        : error instanceof Error && error.name === 'TimeoutError'
                          ? 'timed out'
                          : 'could not be read';
                this.deps.log?.(`Operations: the ${source.id} price list ${reason}; it is tried again in an hour.`);
                run = {
                    source: source.id,
                    at,
                    ok: false,
                    fetched: 0,
                    matched: 0,
                    stored: 0,
                    error: reason,
                };
            }
            await this.deps.repo.recordRun(run);
        }
        if (stored) {
            this.deps.changed?.();
        }
    }
}
