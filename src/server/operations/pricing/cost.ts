import type { ModelPrice, TokenPrices } from '@socio/shared/operations/operations-cost';

import { modelKey } from './model-key.js';

/** A turn's tokens, as `f_turn` keeps them (input includes cached). */
export interface TurnTokens {
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
}

/**
 * What tokens cost at a price, in dollars: uncached input, cached input
 * (at the input price when the list has no cached one) and output, which
 * includes reasoning; reasoning billed apart adds its difference. Null
 * when the turn recorded no tokens at all.
 */
export function tokenCost(tokens: TurnTokens, price: TokenPrices) {
    if (tokens.inputTokens === null && tokens.outputTokens === null) {
        return null;
    }
    const input = tokens.inputTokens ?? 0;
    const cached = Math.min(input, tokens.cachedTokens ?? 0);
    const output = tokens.outputTokens ?? 0;
    const reasoning =
        price.reasoningPerM !== null && tokens.reasoningTokens
            ? Math.min(output, tokens.reasoningTokens) * (price.reasoningPerM - price.outputPerM)
            : 0;
    return (
        ((input - cached) * price.inputPerM +
            cached * (price.cachedInputPerM ?? price.inputPerM) +
            output * price.outputPerM +
            reasoning) /
        1e6
    );
}

const tier = (price: ModelPrice) => (price.source === 'admin' ? 0 : price.source.startsWith('sync:') ? 1 : 2);

/** The rows of one tier for a model: exact name first, then the shortest name. */
function pick(rows: ModelPrice[], model: string, at: number, backfill: boolean) {
    const exact = rows.filter((row) => row.model === model);
    const list = exact.length ? exact : rows;
    const inForce = list.filter((row) => row.effectiveFrom <= at);
    const pool = inForce.length ? inForce : backfill ? list : [];
    let best: ModelPrice | undefined;
    for (const row of pool) {
        if (
            !best ||
            row.model.length < best.model.length ||
            (row.model.length === best.model.length &&
                (inForce.length ? row.effectiveFrom > best.effectiveFrom : row.effectiveFrom < best.effectiveFrom))
        ) {
            best = row;
        }
    }
    return best;
}

/**
 * The prices Socio keeps, for pricing turns (CB-195). A turn is priced at
 * its provider's price for its model in force when it started: an admin's
 * from its date onward, else a provider's own list's, else a community
 * list's. An admin price for provider `*` holds for every provider. A
 * turn from before a model's first synced price takes that first price
 * (the lists only say what a price is now); an admin's never reaches back.
 */
export class PriceBook {
    private byKey = new Map<string, ModelPrice[]>();

    constructor(prices: readonly ModelPrice[]) {
        for (const price of prices) {
            const key = price.modelKey || modelKey(price.model);
            let list = this.byKey.get(key);
            if (!list) {
                this.byKey.set(key, (list = []));
            }
            list.push(price);
        }
    }

    /** The price for a model at a provider at a time, or undefined. */
    lookup(provider: string | null, model: string | null, at: number): ModelPrice | undefined {
        if (!model) {
            return undefined;
        }
        const rows = this.byKey.get(modelKey(model)) ?? [];
        const of = (wanted: (row: ModelPrice) => boolean) => rows.filter(wanted);
        const admin = of((row) => row.source === 'admin' && (row.provider === provider || row.provider === '*'));
        const own = admin.filter((row) => row.provider === provider);
        const found = pick(own, model, at, false) ?? pick(admin, model, at, false);
        if (found) {
            return found;
        }
        if (!provider) {
            return undefined;
        }
        const listed = of((row) => row.provider === provider && tier(row) > 0);
        const sync = listed.filter((row) => tier(row) === 1);
        const catalog = listed.filter((row) => tier(row) === 2);
        return (
            pick(sync, model, at, false) ??
            pick(catalog, model, at, false) ??
            pick(sync, model, at, true) ??
            pick(catalog, model, at, true)
        );
    }

    /**
     * The cheapest cloud price listed for a model at a time (synced or
     * catalog, any provider but self-hosted): the reference a self-hosted
     * backend's cost is compared with (CB-196).
     */
    reference(model: string | null, at: number, tokens: TurnTokens) {
        if (!model) {
            return undefined;
        }
        const rows = (this.byKey.get(modelKey(model)) ?? []).filter(
            (row) => tier(row) > 0 && row.provider !== 'self-hosted',
        );
        const providers = new Map<string, ModelPrice[]>();
        for (const row of rows) {
            let list = providers.get(row.provider);
            if (!list) {
                providers.set(row.provider, (list = []));
            }
            list.push(row);
        }
        let best: number | undefined;
        for (const list of providers.values()) {
            const price = pick(list, model, at, false) ?? pick(list, model, at, true);
            const cost = price && tokenCost(tokens, price);
            if (cost !== null && cost !== undefined && (best === undefined || cost < best)) {
                best = cost;
            }
        }
        return best;
    }
}
