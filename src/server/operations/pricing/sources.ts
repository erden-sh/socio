import type { PriceSourceId, TokenPrices } from '@socio/shared/operations/operations-cost';

import type { PriceGet } from './fetch.js';
import { canonicalProvider } from './model-key.js';

/**
 * The price lists (CB-195): each adapter reads one public list whole (no
 * API key, no account) and yields its token prices; the sync keeps only
 * the models in use. Lists too large to read whole are narrowed by
 * service and region in the request (Azure's Foundry Models in East US 2,
 * AWS's Bedrock offer for us-east-1), which names nothing about who asks.
 * Together's model list needs an API key, so it is read through the
 * community lists instead.
 */

/** One model's prices as a list gives them, in dollars per million tokens. */
export interface PriceEntry {
    provider: string;
    model: string;
    /** Other names it goes by (Bedrock's display name), for matching. */
    aliases?: string[];
    prices: TokenPrices;
    /** When the list says the price took effect. */
    effectiveFrom?: number;
}

export interface PriceSource {
    id: PriceSourceId;
    /** The only hosts it reads from. */
    hosts: readonly string[];
    read(get: PriceGet): Promise<PriceEntry[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
/** A finite, non-negative number from a number or a numeric string. */
const amount = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
};
/** Rounds away float noise from per-token to per-million conversions. */
const perM = (value: number) => Math.round(value * 1e12) / 1e6;
const time = (value: unknown) => {
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(at) ? at : undefined;
};

/** OpenRouter's model list: per-token prices as strings. */
export const openRouterSource: PriceSource = {
    id: 'openrouter',
    hosts: ['openrouter.ai'],
    async read(get) {
        const body = await get('https://openrouter.ai/api/v1/models', this.hosts);
        const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
        const out: PriceEntry[] = [];
        for (const item of data) {
            if (!isObject(item) || typeof item.id !== 'string') {
                continue;
            }
            const pricing = isObject(item.pricing) ? item.pricing : {};
            const input = amount(pricing.prompt);
            const output = amount(pricing.completion);
            if (input === null || output === null) {
                continue;
            }
            const cached = amount(pricing.input_cache_read);
            const reasoning = amount(pricing.internal_reasoning);
            out.push({
                provider: 'openrouter',
                model: item.id,
                prices: {
                    inputPerM: perM(input),
                    cachedInputPerM: cached === null ? null : perM(cached),
                    outputPerM: perM(output),
                    reasoningPerM: reasoning ? perM(reasoning) : null,
                },
            });
        }
        return out;
    },
};

/** DeepInfra's OpenAI-style model list: dollars per million tokens. */
export const deepInfraSource: PriceSource = {
    id: 'deepinfra',
    hosts: ['api.deepinfra.com'],
    async read(get) {
        const body = await get('https://api.deepinfra.com/v1/openai/models', this.hosts);
        const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
        const out: PriceEntry[] = [];
        for (const item of data) {
            if (!isObject(item) || typeof item.id !== 'string') {
                continue;
            }
            const meta = isObject(item.metadata) ? item.metadata : {};
            const pricing = isObject(meta.pricing) ? meta.pricing : {};
            const input = amount(pricing.input_tokens);
            const output = amount(pricing.output_tokens);
            if (input === null || output === null) {
                continue;
            }
            const cached = amount(pricing.cache_read_tokens);
            out.push({
                provider: 'deepinfra',
                model: item.id,
                prices: {
                    inputPerM: input,
                    cachedInputPerM: cached,
                    outputPerM: output,
                    reasoningPerM: null,
                },
            });
        }
        return out;
    },
};

/** Azure's service and region the sync asks for; the full list is far larger. */
export const AZURE_FILTER = {
    serviceName: 'Foundry Models',
    armRegionName: 'eastus2',
};
/** At most this many pages of 1,000 (the region's list is a few). */
const AZURE_PAGES = 40;
// Meters that aren't text tokens at pay-as-you-go prices.
const AZURE_SKIP =
    /batch|realtime|\brt\b|-rt-|transcri|trscb|\baud|audio|tts|\bimg\b|image|training|hosting|provisioned|\bptu\b|\bft\b|-ft-|grader|embed|dall|whisper|sora|video|\bdev\b|\bstt\b|\bpp\b/i;
const AZURE_CACHED = /^(cchd|cached|cache|cd)$/i;
const AZURE_INPUT = /^(inp|inpt|input|in)$/i;
const AZURE_OUTPUT = /^(outp|outpt|out|output|opt)$/i;
const AZURE_DEPLOYMENT: [RegExp, number][] = [
    [/^(glbl|gl|glb|global)$/i, 0],
    [/^(dz|dzone|dzn|datazone)$/i, 1],
    [/^(regnl|rgnl|regn|rgn|regional)$/i, 2],
];

/**
 * An Azure meter's model, direction and deployment from its SKU name
 * ("gpt 4o 1120 cached Inp regnl", "GPT 5.2 pro inp Dz"); undefined for
 * meters that aren't one model's text tokens.
 */
export function azureMeter(skuName: string, productName = '') {
    if (AZURE_SKIP.test(skuName)) {
        return undefined;
    }
    const words = skuName
        .replace(/data\s*zone/gi, 'dz')
        .split(/[\s]+/)
        .filter(Boolean);
    let direction: 'input' | 'output' | 'cached' | undefined;
    let deployment = 3;
    const name: string[] = [];
    for (const word of words) {
        if (AZURE_CACHED.test(word)) {
            direction = 'cached';
        } else if (AZURE_INPUT.test(word)) {
            direction ??= 'input';
        } else if (AZURE_OUTPUT.test(word)) {
            direction = 'output';
        } else if (/^tokens?$/i.test(word) || /^\d+[km]$/i.test(word)) {
            continue;
        } else {
            const found = AZURE_DEPLOYMENT.find(([pattern]) => pattern.test(word));
            if (found) {
                deployment = Math.min(deployment, found[1]);
            }
            // A four-digit version ("1120", "mini0718") is the model's release.
            else if (!/^\d{4}$/.test(word)) {
                name.push(word.replace(/(\D)\d{4}$/, '$1'));
            }
        }
    }
    if (!direction || !name.length) {
        return undefined;
    }
    let model = name.join('-').toLowerCase();
    if (/^\d/.test(model) && /gpt/i.test(productName)) {
        model = `gpt-${model}`;
    }
    return { model, direction, deployment };
}

/** Azure Retail Prices, Foundry Models in one region, page by page. */
export const azureSource: PriceSource = {
    id: 'azure',
    hosts: ['prices.azure.com'],
    async read(get) {
        const filter = `serviceName eq '${AZURE_FILTER.serviceName}' and armRegionName eq '${AZURE_FILTER.armRegionName}'`;
        let next: string | null = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
        const meters = new Map<
            string,
            {
                deployment: number;
                input?: number;
                output?: number;
                cached?: number;
                from?: number;
            }
        >();
        for (let page = 0; next && page < AZURE_PAGES; page++) {
            const body = await get(next, this.hosts);
            if (!isObject(body)) {
                break;
            }
            for (const item of Array.isArray(body.Items) ? body.Items : []) {
                if (
                    !isObject(item) ||
                    item.type !== 'Consumption' ||
                    item.currencyCode !== 'USD' ||
                    typeof item.skuName !== 'string'
                ) {
                    continue;
                }
                const unit = item.unitOfMeasure === '1K' ? 1000 : item.unitOfMeasure === '1M' ? 1 : 0;
                const price = amount(item.retailPrice);
                if (!unit || price === null) {
                    continue;
                }
                const meter = azureMeter(item.skuName, typeof item.productName === 'string' ? item.productName : '');
                if (!meter) {
                    continue;
                }
                let entry = meters.get(meter.model);
                // Global deployments first, then data zones, then regional ones.
                if (!entry || meter.deployment < entry.deployment) {
                    meters.set(meter.model, (entry = { deployment: meter.deployment }));
                }
                if (meter.deployment > entry.deployment) {
                    continue;
                }
                entry[meter.direction] = perM(price * unit * 1e-6);
                const from = time(item.effectiveStartDate);
                if (from !== undefined) {
                    entry.from = Math.max(entry.from ?? 0, from);
                }
            }
            next = typeof body.NextPageLink === 'string' ? body.NextPageLink : null;
        }
        const out: PriceEntry[] = [];
        for (const [model, entry] of meters) {
            if (entry.input !== undefined && entry.output !== undefined) {
                out.push({
                    provider: 'azure',
                    model,
                    prices: {
                        inputPerM: entry.input,
                        cachedInputPerM: entry.cached ?? null,
                        outputPerM: entry.output,
                        reasoningPerM: null,
                    },
                    effectiveFrom: entry.from,
                });
            }
        }
        return out;
    },
};

/** The AWS region whose Bedrock offer the sync reads. */
export const AWS_REGION = 'us-east-1';
const AWS_TYPES: Record<string, 'input' | 'output' | 'cached'> = {
    'input tokens': 'input',
    'output tokens': 'output',
    'cache read tokens': 'cached',
    'prompt cache read input tokens': 'cached',
};

/** The AWS Price List's Bedrock offer for one region (on-demand tokens). */
export const awsSource: PriceSource = {
    id: 'aws',
    hosts: ['pricing.us-east-1.amazonaws.com'],
    async read(get) {
        const body = await get(
            `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/${AWS_REGION}/index.json`,
            this.hosts,
        );
        if (!isObject(body) || !isObject(body.products)) {
            return [];
        }
        const onDemand = isObject(body.terms) && isObject(body.terms.OnDemand) ? body.terms.OnDemand : {};
        const models = new Map<
            string,
            {
                id: string;
                input?: number;
                output?: number;
                cached?: number;
                from?: number;
            }
        >();
        for (const [sku, product] of Object.entries(body.products)) {
            if (!isObject(product) || !isObject(product.attributes)) {
                continue;
            }
            const { inferenceType, model, usagetype } = product.attributes;
            if (typeof inferenceType !== 'string' || typeof model !== 'string') {
                continue;
            }
            const kind = AWS_TYPES[inferenceType.trim().toLowerCase()];
            if (!kind) {
                continue;
            }
            const terms = onDemand[sku];
            if (!isObject(terms)) {
                continue;
            }
            for (const term of Object.values(terms)) {
                if (!isObject(term) || !isObject(term.priceDimensions)) {
                    continue;
                }
                for (const dimension of Object.values(term.priceDimensions)) {
                    if (!isObject(dimension) || !isObject(dimension.pricePerUnit)) {
                        continue;
                    }
                    const unit = String(dimension.unit ?? '').toLowerCase();
                    const scale = unit === '1k tokens' ? 1000 : unit === '1m tokens' ? 1 : 0;
                    const price = amount(dimension.pricePerUnit.USD);
                    if (!scale || price === null) {
                        continue;
                    }
                    let entry = models.get(model);
                    if (!entry) {
                        models.set(
                            model,
                            (entry = {
                                id:
                                    typeof usagetype === 'string'
                                        ? usagetype
                                              .replace(/^[A-Z0-9]+-/, '')
                                              .replace(/-(input|output|cache|prompt)[-\w]*$/i, '')
                                        : model,
                            }),
                        );
                    }
                    entry[kind] ??= perM(price * scale * 1e-6);
                    const from = time(term.effectiveDate);
                    if (from !== undefined) {
                        entry.from = Math.max(entry.from ?? 0, from);
                    }
                }
            }
        }
        const out: PriceEntry[] = [];
        for (const [name, entry] of models) {
            if (entry.input !== undefined && entry.output !== undefined) {
                out.push({
                    provider: 'aws',
                    model: entry.id,
                    aliases: [name],
                    prices: {
                        inputPerM: entry.input,
                        cachedInputPerM: entry.cached ?? null,
                        outputPerM: entry.output,
                        reasoningPerM: null,
                    },
                    effectiveFrom: entry.from,
                });
            }
        }
        return out;
    },
};

/** models.dev's catalog: every provider's models, dollars per million. */
export const modelsDevSource: PriceSource = {
    id: 'models.dev',
    hosts: ['models.dev'],
    async read(get) {
        const body = await get('https://models.dev/api.json', this.hosts);
        if (!isObject(body)) {
            return [];
        }
        const out: PriceEntry[] = [];
        for (const [providerId, provider] of Object.entries(body)) {
            if (!isObject(provider) || !isObject(provider.models)) {
                continue;
            }
            for (const [id, model] of Object.entries(provider.models)) {
                if (!isObject(model) || !isObject(model.cost)) {
                    continue;
                }
                const input = amount(model.cost.input);
                const output = amount(model.cost.output);
                if (input === null || output === null) {
                    continue;
                }
                const reasoning = amount(model.cost.reasoning);
                out.push({
                    provider: canonicalProvider(providerId),
                    model: typeof model.id === 'string' ? model.id : id,
                    prices: {
                        inputPerM: input,
                        cachedInputPerM: amount(model.cost.cache_read),
                        outputPerM: output,
                        reasoningPerM: reasoning || null,
                    },
                });
            }
        }
        return out;
    },
};

const LITELLM_MODES = new Set(['chat', 'responses', 'completion']);

/** LiteLLM's price list: per-token prices, keyed `provider/model`. */
export const liteLlmSource: PriceSource = {
    id: 'litellm',
    hosts: ['raw.githubusercontent.com'],
    async read(get) {
        const body = await get(
            'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
            this.hosts,
        );
        if (!isObject(body)) {
            return [];
        }
        const out: PriceEntry[] = [];
        for (const [key, value] of Object.entries(body)) {
            if (key === 'sample_spec' || !isObject(value)) {
                continue;
            }
            if (typeof value.mode === 'string' && !LITELLM_MODES.has(value.mode)) {
                continue;
            }
            if (typeof value.litellm_provider !== 'string') {
                continue;
            }
            const input = amount(value.input_cost_per_token);
            const output = amount(value.output_cost_per_token);
            if (input === null || output === null) {
                continue;
            }
            const cached = amount(value.cache_read_input_token_cost);
            const reasoning = amount(value.output_cost_per_reasoning_token);
            out.push({
                provider: canonicalProvider(value.litellm_provider),
                model: key,
                prices: {
                    inputPerM: perM(input),
                    cachedInputPerM: cached === null ? null : perM(cached),
                    outputPerM: perM(output),
                    reasoningPerM: reasoning ? perM(reasoning) : null,
                },
            });
        }
        return out;
    },
};

/** Every source, in the order a run reads them. */
export const PRICE_SOURCE_ADAPTERS: readonly PriceSource[] = [
    openRouterSource,
    deepInfraSource,
    azureSource,
    awsSource,
    modelsDevSource,
    liteLlmSource,
];
