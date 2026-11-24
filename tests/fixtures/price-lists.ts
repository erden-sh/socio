import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback fake of every price list the sync reads (CB-195), with a
 * few models each: the ones tests watch, and ones nobody uses. It records
 * every request's path and headers. Prices are per million tokens:
 * gpt-4o-mini 0.15 in / 0.6 out at OpenAI-style lists.
 */
export function priceLists() {
    return {
        '/api/v1/models': {
            data: [
                {
                    id: 'openai/gpt-4o-mini',
                    pricing: {
                        prompt: '0.00000015',
                        completion: '0.0000006',
                        input_cache_read: '0.000000075',
                    },
                },
                {
                    id: 'vendor/unused-model',
                    pricing: { prompt: '0.000001', completion: '0.000002' },
                },
                // A router with no fixed price.
                { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
            ],
        },
        '/v1/openai/models': {
            data: [
                {
                    id: 'Qwen/Qwen3-32B',
                    metadata: {
                        pricing: {
                            input_tokens: 0.1,
                            output_tokens: 0.3,
                            cache_read_tokens: 0.05,
                        },
                    },
                },
                {
                    id: 'black-forest-labs/FLUX',
                    metadata: { pricing: { per_image_unit: 0.02 } },
                },
            ],
        },
        '/api/retail/prices': {
            Items: [
                {
                    currencyCode: 'USD',
                    retailPrice: 0.00015,
                    unitOfMeasure: '1K',
                    type: 'Consumption',
                    skuName: 'gpt 4o mini 0718 Inp glbl',
                    productName: 'Azure OpenAI',
                    effectiveStartDate: '2026-01-01T00:00:00Z',
                },
                {
                    currencyCode: 'USD',
                    retailPrice: 0.0006,
                    unitOfMeasure: '1K',
                    type: 'Consumption',
                    skuName: 'gpt 4o mini 0718 Outp glbl',
                    productName: 'Azure OpenAI',
                    effectiveStartDate: '2026-01-01T00:00:00Z',
                },
                {
                    currencyCode: 'USD',
                    retailPrice: 0.000075,
                    unitOfMeasure: '1K',
                    type: 'Consumption',
                    skuName: 'gpt 4o mini 0718 cached Inp glbl',
                    productName: 'Azure OpenAI',
                    effectiveStartDate: '2026-01-01T00:00:00Z',
                },
                // Regional meters lose to global ones; batch meters are skipped.
                {
                    currencyCode: 'USD',
                    retailPrice: 0.000165,
                    unitOfMeasure: '1K',
                    type: 'Consumption',
                    skuName: 'gpt 4o mini 0718 Inp regnl',
                    productName: 'Azure OpenAI',
                },
                {
                    currencyCode: 'USD',
                    retailPrice: 0.00001,
                    unitOfMeasure: '1K',
                    type: 'Consumption',
                    skuName: 'gpt 4o mini 0718 Batch Inp glbl',
                    productName: 'Azure OpenAI',
                },
            ],
            NextPageLink: 'https://prices.azure.com:443/api/retail/prices?page=2',
        },
        '/api/retail/prices?page=2': {
            Items: [
                {
                    currencyCode: 'USD',
                    retailPrice: 5,
                    unitOfMeasure: '1M',
                    type: 'Consumption',
                    skuName: 'gpt 9 Inp glbl',
                    productName: 'Azure OpenAI',
                },
                {
                    currencyCode: 'USD',
                    retailPrice: 20,
                    unitOfMeasure: '1M',
                    type: 'Consumption',
                    skuName: 'gpt 9 Outp glbl',
                    productName: 'Azure OpenAI',
                },
            ],
            NextPageLink: null,
        },
        '/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json': {
            products: {
                IN: {
                    attributes: {
                        inferenceType: 'Input tokens',
                        model: 'Claude 3.5 Sonnet',
                        usagetype: 'USE1-Claude3.5Sonnet-input-tokens',
                    },
                },
                OUT: {
                    attributes: {
                        inferenceType: 'Output tokens',
                        model: 'Claude 3.5 Sonnet',
                        usagetype: 'USE1-Claude3.5Sonnet-output-tokens',
                    },
                },
                BATCH: {
                    attributes: {
                        inferenceType: 'input tokens batch',
                        model: 'Claude 3.5 Sonnet',
                        usagetype: 'USE1-x-batch',
                    },
                },
            },
            terms: {
                OnDemand: {
                    IN: {
                        'IN.T': {
                            effectiveDate: '2026-02-01T00:00:00Z',
                            priceDimensions: {
                                d: { unit: '1K tokens', pricePerUnit: { USD: '0.003' } },
                            },
                        },
                    },
                    OUT: {
                        'OUT.T': {
                            effectiveDate: '2026-02-01T00:00:00Z',
                            priceDimensions: {
                                d: { unit: '1K tokens', pricePerUnit: { USD: '0.015' } },
                            },
                        },
                    },
                    BATCH: {
                        'B.T': {
                            priceDimensions: {
                                d: { unit: '1K tokens', pricePerUnit: { USD: '0.001' } },
                            },
                        },
                    },
                },
            },
        },
        '/api.json': {
            openai: {
                id: 'openai',
                models: {
                    'gpt-4o-mini': {
                        id: 'gpt-4o-mini',
                        cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
                    },
                },
            },
            togetherai: {
                id: 'togetherai',
                models: {
                    'Qwen/Qwen3-32B': {
                        id: 'Qwen/Qwen3-32B',
                        cost: { input: 0.2, output: 0.6 },
                    },
                    'other/model': { id: 'other/model', cost: { input: 1, output: 1 } },
                },
            },
        },
        '/BerriAI/litellm/main/model_prices_and_context_window.json': {
            sample_spec: {
                litellm_provider: 'openai',
                mode: 'chat',
                input_cost_per_token: 0,
                output_cost_per_token: 0,
            },
            'gpt-4o-mini': {
                litellm_provider: 'openai',
                mode: 'chat',
                input_cost_per_token: 1.5e-7,
                output_cost_per_token: 6e-7,
            },
            'bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0': {
                litellm_provider: 'bedrock',
                mode: 'chat',
                input_cost_per_token: 3e-6,
                output_cost_per_token: 1.5e-5,
            },
            'dall-e-3': {
                litellm_provider: 'openai',
                mode: 'image_generation',
                output_cost_per_image: 0.04,
            },
        },
    } as Record<string, unknown>;
}

export interface PriceRequest {
    path: string;
    headers: IncomingHttpHeaders;
}

/** Serves `priceLists()` on 127.0.0.1; `lists` can be changed between runs. */
export async function priceListServer() {
    const requests: PriceRequest[] = [];
    const lists = priceLists();
    const server = createServer((request, response) => {
        const path = request.url ?? '/';
        requests.push({ path, headers: request.headers });
        const key = path.startsWith('/api/retail/prices?')
            ? path.includes('page=2')
                ? '/api/retail/prices?page=2'
                : '/api/retail/prices'
            : path;
        const body = lists[key];
        if (body === undefined) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        lists,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
