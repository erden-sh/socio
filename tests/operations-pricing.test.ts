import { afterEach, describe, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData } from '@socio/data/open';

import { pricingTables } from '../src/server/operations/infra/sqlite/pricing-schema.js';
import { SqlitePricing } from '../src/server/operations/infra/sqlite/pricing.js';
import { PRICE_SYNC_USER_AGENT, priceFetcher, priceSyncOrigin } from '../src/server/operations/pricing/fetch.js';
import { canonicalProvider, modelKey, providerOf } from '../src/server/operations/pricing/model-key.js';
import { azureMeter } from '../src/server/operations/pricing/sources.js';
import { PriceSync, priceSyncEnabled, priceSyncFromEnv } from '../src/server/operations/pricing/sync.js';
import { operationsSettingsFromEnv } from '../src/server/operations/settings.js';

import { priceListServer } from './fixtures/price-lists.js';
import { staticAuth } from './fixtures/static-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-195: the daily price sync reads full public price lists through a
// loopback fake here (the suite blocks egress), keeps only the models in
// use, sends nothing that identifies anyone, and makes no request at all
// while its switch is off; admins' prices and the switch are audited.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const WATCHED = ['openai/gpt-4o-mini', 'qwen3-32b', 'claude-3-5-sonnet-20240620'];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function repo() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return { db, pricing: new SqlitePricing(sqliteData(db)) };
}

async function fake() {
    const server = await priceListServer();
    cleanup.push(() => server.close());
    return server;
}

describe('matching models and providers', () => {
    it('folds one model’s names to one key', () => {
        for (const name of [
            'gpt-4o-mini',
            'openai/gpt-4o-mini',
            'gpt-4o-mini-2024-07-18',
            'GPT 4o mini',
            'openai/gpt-4o-mini:free',
        ]) {
            expect(modelKey(name)).toBe('gpt4omini');
        }
        expect(modelKey('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe('claude35sonnet');
        expect(modelKey('Claude 3.5 Sonnet')).toBe('claude35sonnet');
        expect(modelKey('Qwen/Qwen3-32B')).toBe(modelKey('qwen3-32b'));
        // A size tag is part of the model.
        expect(modelKey('qwen3:32b')).toBe('qwen332b');
    });

    it('names a backend’s provider from its base URL', () => {
        expect(providerOf('https://api.openai.com/v1')).toBe('openai');
        expect(providerOf('https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(providerOf('https://my.openai.azure.com/openai')).toBe('azure');
        expect(providerOf('https://bedrock-runtime.us-east-1.amazonaws.com/v1')).toBe('aws');
        for (const local of [
            'http://127.0.0.1:8000/v1',
            'http://10.1.2.3/v1',
            'http://ollama:11434/v1',
            'http://gpu.lan:8000',
        ]) {
            expect(providerOf(local)).toBe('self-hosted');
        }
        expect(providerOf('https://llm.example.com/v1')).toBe('llm.example.com');
        expect(canonicalProvider('togetherai')).toBe('together');
        expect(canonicalProvider('bedrock')).toBe('aws');
    });

    it('reads Azure meters’ model, direction and deployment', () => {
        expect(azureMeter('gpt 4o 1120 cached Inp regnl')).toEqual({
            model: 'gpt-4o',
            direction: 'cached',
            deployment: 2,
        });
        expect(azureMeter('5.4 opt Dz', 'Azure OpenAI GPT5')).toEqual({
            model: 'gpt-5.4',
            direction: 'output',
            deployment: 1,
        });
        expect(azureMeter('gpt 4o mini0718 BatchOutp DataZone')).toBeUndefined();
        expect(azureMeter('gpt-4o-rt-txt-1217 Inp DZone')).toBeUndefined();
    });
});

describe('the price sync', () => {
    it('reads every full list, stores only the models in use, and sends nothing identifying', async () => {
        const server = await fake();
        const { pricing } = repo();
        let now = NOW;
        const changed = vi.fn();
        const sync = new PriceSync({
            repo: pricing,
            enabled: () => true,
            watched: async () => WATCHED,
            origin: server.origin,
            now: () => now,
            changed,
        });
        await sync.run();
        const runs = await pricing.runs();
        expect(runs.map((run) => [run.source, run.ok, run.error])).toEqual([
            ['aws', true, null],
            ['azure', true, null],
            ['deepinfra', true, null],
            ['litellm', true, null],
            ['models.dev', true, null],
            ['openrouter', true, null],
        ]);
        // Full lists were read (every priced entry), only matches kept.
        expect(runs.find((run) => run.source === 'openrouter')).toMatchObject({
            fetched: 2,
            matched: 1,
            stored: 1,
        });
        expect(runs.find((run) => run.source === 'azure')).toMatchObject({
            fetched: 2,
            matched: 1,
        });
        const stored = await pricing.prices();
        expect(stored.map((row) => `${row.source} ${row.provider} ${row.model}`).sort()).toEqual([
            'catalog:litellm aws bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0',
            'catalog:litellm openai gpt-4o-mini',
            'catalog:models.dev openai gpt-4o-mini',
            'catalog:models.dev together Qwen/Qwen3-32B',
            'sync:aws aws Claude3.5Sonnet',
            'sync:azure azure gpt-4o-mini',
            'sync:deepinfra deepinfra Qwen/Qwen3-32B',
            'sync:openrouter openrouter openai/gpt-4o-mini',
        ]);
        const azure = stored.find((row) => row.source === 'sync:azure')!;
        expect(azure).toMatchObject({
            inputPerM: 0.15,
            cachedInputPerM: 0.075,
            outputPerM: 0.6,
            effectiveFrom: Date.UTC(2026, 0, 1),
        });
        expect(stored.find((row) => row.source === 'sync:aws')).toMatchObject({
            inputPerM: 3,
            outputPerM: 15,
            modelKey: 'claude35sonnet',
        });
        expect(stored.find((row) => row.source === 'sync:openrouter')).toMatchObject({
            inputPerM: 0.15,
            cachedInputPerM: 0.075,
            outputPerM: 0.6,
        });
        expect(changed).toHaveBeenCalledTimes(1);

        // Every request: a plain GET of a public list with a generic agent.
        expect(server.requests.map((request) => request.path)).toEqual([
            '/api/v1/models',
            '/v1/openai/models',
            '/api/retail/prices?$filter=serviceName%20eq%20%27Foundry%20Models%27%20and%20armRegionName%20eq%20%27eastus2%27',
            '/api/retail/prices?page=2',
            '/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json',
            '/api.json',
            '/BerriAI/litellm/main/model_prices_and_context_window.json',
        ]);
        for (const { headers } of server.requests) {
            expect(headers['user-agent']).toBe(PRICE_SYNC_USER_AGENT);
            expect(Object.keys(headers).sort()).toEqual(expect.arrayContaining(['accept', 'host', 'user-agent']));
            for (const name of Object.keys(headers)) {
                expect(name).not.toMatch(/cookie|authorization|referer|from|x-|forwarded|origin/);
            }
            expect(JSON.stringify(headers)).not.toMatch(/@|socio|company|brain/i);
        }
        expect(PRICE_SYNC_USER_AGENT).toBe('research-script/0.1');

        // The next day: unchanged prices add no rows; a changed one does.
        now += DAY + 1;
        (server.lists['/api/v1/models'] as { data: { pricing: object }[] }).data[0]!.pricing = {
            prompt: '0.0000002',
            completion: '0.0000008',
        };
        await sync.run();
        const after = await pricing.prices();
        expect(after).toHaveLength(stored.length + 1);
        const openrouter = after.filter((row) => row.source === 'sync:openrouter');
        expect(openrouter.map((row) => [row.inputPerM, row.effectiveFrom])).toEqual([
            [0.2, now],
            [0.15, NOW],
        ]);
    });

    it('makes no request at all while the switch is off, and stops between sources when it goes off', async () => {
        const server = await fake();
        const { pricing } = repo();
        let on = false;
        const sync = new PriceSync({
            repo: pricing,
            enabled: () => on,
            watched: async () => WATCHED,
            origin: server.origin,
            now: () => NOW,
        });
        await sync.tick();
        await sync.run();
        expect(await sync.nextAt()).toBeNull();
        expect(server.requests).toEqual([]);
        expect(await pricing.runs()).toEqual([]);
        // On: due at once; the switch going off mid-run stops the next source.
        on = true;
        expect(await sync.nextAt()).toBe(NOW);
        const reads: string[] = [];
        const stopping = new PriceSync({
            repo: pricing,
            enabled: () => on,
            watched: async () => WATCHED,
            get: async (url) => {
                reads.push(url);
                on = false;
                return { data: [] };
            },
            now: () => NOW,
        });
        await stopping.run();
        expect(reads).toHaveLength(1);
    });

    it('runs once a day, and retries a failed source an hour later', async () => {
        const server = await fake();
        const { pricing } = repo();
        let now = NOW;
        delete server.lists['/api.json'];
        const lines: string[] = [];
        const sync = new PriceSync({
            repo: pricing,
            enabled: () => true,
            watched: async () => WATCHED,
            origin: server.origin,
            now: () => now,
            log: (line) => lines.push(line),
        });
        await sync.tick();
        await vi.waitFor(async () => expect(await pricing.runs()).toHaveLength(6));
        await vi.waitFor(() => expect(sync.busy).toBe(false));
        expect((await pricing.runs()).find((run) => run.source === 'models.dev')).toMatchObject({
            ok: false,
            error: 'HTTP 404',
        });
        expect(lines).toEqual(['Operations: the models.dev price list HTTP 404; it is tried again in an hour.']);
        expect(await sync.nextAt()).toBe(NOW + 3_600_000);
        const count = server.requests.length;
        now += 30 * 60_000;
        await sync.tick();
        expect(server.requests).toHaveLength(count);
        now = NOW + 3_600_000;
        await sync.tick();
        await vi.waitFor(() => expect(server.requests.length).toBeGreaterThan(count));
        await vi.waitFor(() => expect(sync.busy).toBe(false));
        // Only the failed source was read again.
        expect(server.requests.slice(count).map((r) => r.path)).toEqual(['/api.json']);
    });

    it('fetches only https lists from the source’s own hosts, and only JSON within its size', async () => {
        const server = await fake();
        const get = priceFetcher({ origin: server.origin });
        await expect(get('https://evil.example/api/v1/models', ['openrouter.ai'])).rejects.toThrow(/refused/);
        await expect(get('http://openrouter.ai/api/v1/models', ['openrouter.ai'])).rejects.toThrow(/refused/);
        const small = priceFetcher({ origin: server.origin, maxBytes: 10 });
        await expect(small('https://openrouter.ai/api/v1/models', ['openrouter.ai'])).rejects.toThrow(/too large/);
        expect(priceSyncOrigin(server.origin)).toBe(server.origin);
        expect(() => priceSyncOrigin('http://user:pw@127.0.0.1')).toThrow();
        expect(() => priceSyncOrigin('ftp://127.0.0.1')).toThrow();
        expect(priceSyncOrigin(' ')).toBeUndefined();
    });

    it('is on by default only in production images, an admin’s choice winning', () => {
        expect(priceSyncFromEnv({ NODE_ENV: 'production' })).toBe(true);
        expect(priceSyncFromEnv({ NODE_ENV: 'development' })).toBe(false);
        expect(priceSyncFromEnv({})).toBe(false);
        expect(priceSyncFromEnv({ NODE_ENV: 'production', OPS_PRICE_SYNC: 'off' })).toBe(false);
        expect(priceSyncFromEnv({ OPS_PRICE_SYNC: 'on' })).toBe(true);
        expect(() => priceSyncFromEnv({ OPS_PRICE_SYNC: 'maybe' })).toThrow();
        expect(operationsSettingsFromEnv({ NODE_ENV: 'production' })).toEqual({
            pricing: { sync: true },
        });
        expect(operationsSettingsFromEnv({})).toEqual({});
        const env = { pricing: { sync: true } };
        expect(priceSyncEnabled(undefined, env)).toBe(true);
        expect(priceSyncEnabled({ pricing: { sync: false } }, env)).toBe(false);
        expect(priceSyncEnabled({}, undefined)).toBe(false);
    });
});

describe('the pricing tables', () => {
    it('mirror operations migration 4, and keep one admin price per model and date', async () => {
        const { db, pricing } = repo();
        expect(schemaDrift(db, pricingTables)).toEqual([]);
        const input = {
            provider: 'self-hosted',
            model: 'qwen3-32b',
            inputPerM: 0.05,
            cachedInputPerM: null,
            outputPerM: 0.1,
            reasoningPerM: null,
            effectiveFrom: NOW,
        };
        const first = await pricing.addAdminPrice(input, NOW);
        const second = await pricing.addAdminPrice({ ...input, outputPerM: 0.2 }, NOW);
        expect(second.id).toBe(first.id);
        expect(await pricing.prices()).toMatchObject([{ outputPerM: 0.2, modelKey: 'qwen332b', source: 'admin' }]);
        // Synced prices can't be removed by hand.
        await pricing.recordSynced(
            'sync:deepinfra',
            [
                {
                    provider: 'deepinfra',
                    model: 'Qwen/Qwen3-32B',
                    modelKey: 'qwen332b',
                    prices: {
                        inputPerM: 1,
                        cachedInputPerM: null,
                        outputPerM: 1,
                        reasoningPerM: null,
                    },
                },
            ],
            NOW,
        );
        const synced = (await pricing.prices()).find((row) => row.source === 'sync:deepinfra')!;
        expect(await pricing.removeAdminPrice(synced.id)).toBeUndefined();
        expect(() =>
            db
                .prepare(
                    "INSERT INTO model_prices (id, provider, model, modelKey, inputPerM, outputPerM, currency, effectiveFrom, source, fetchedAt) VALUES ('x', 'a', 'b', 'b', 1, 1, 'EUR', 0, 'admin', 0)",
                )
                .run(),
        ).toThrow();
    });
});

describe('the pricing routes', () => {
    async function app() {
        const { store, workspace, platform, makeApp, dispose } = await makeTestRuntime({
            config: {
                baseUrl: '',
                runtimeUrl: '',
                voiceName: 'marin',
            },
        });
        cleanup.push(dispose);
        const make = (role: 'admin' | 'member') => makeApp({ auth: staticAuth({ id: role, name: role, role }) });
        return {
            store,
            workspace,
            platform,
            admin: make('admin'),
            member: make('member'),
        };
    }
    const json = (method: string, body: unknown) => ({
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const del = {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
    };

    it('are admins’: members are refused every one', async () => {
        const { member } = await app();
        for (const [path, init] of [
            ['/api/operations/pricing', undefined],
            ['/api/operations/cost', undefined],
            ['/api/operations/pricing/sync', json('PUT', { enabled: true })],
            ['/api/operations/pricing/sync', json('POST', {})],
            ['/api/operations/pricing/prices', json('POST', {})],
            ['/api/operations/pricing/pools', json('POST', {})],
        ] as const) {
            expect((await member.request(path, init)).status).toBe(403);
        }
    });

    it('keeps the switch off by default, audits a change, and refuses Sync now while off', async () => {
        const { admin, store, workspace } = await app();
        const view = await (await admin.request('/api/operations/pricing')).json();
        expect(view.sync).toMatchObject({
            enabled: false,
            serverDefault: false,
            saved: false,
            runs: [],
            nextAt: null,
        });
        expect((await admin.request('/api/operations/pricing/sync', json('POST', {}))).status).toBe(409);
        expect((await admin.request('/api/operations/pricing/sync', json('PUT', { enabled: 'yes' }))).status).toBe(400);
        const on = await admin.request('/api/operations/pricing/sync', json('PUT', { enabled: false }));
        expect(await on.json()).toMatchObject({ enabled: false, saved: true });
        expect(store.settings().operations?.pricing).toEqual({ sync: false });
        const reset = await admin.request('/api/operations/pricing/sync', json('PUT', { enabled: null }));
        expect(await reset.json()).toMatchObject({ saved: false });
        expect(store.settings().operations?.pricing).toBeUndefined();
        await vi.waitFor(() => expect(workspace.auditOf('operations_settings', 'price_sync')).toHaveLength(2));
    });

    it('saves admins’ prices and cost pools with their readings, each audited', async () => {
        const { admin, workspace, platform } = await app();
        await platform.inference.store.createBackend({
            kind: 'openai-compatible',
            label: 'Local GPU',
            enabled: true,
            config: { baseUrl: 'http://10.0.0.5:8000/v1', model: 'qwen3-32b' },
            capabilities: { acceptsImages: false },
            apiKey: 'sk-never-shown',
        });
        const bad = await admin.request(
            '/api/operations/pricing/prices',
            json('POST', {
                provider: 'openai',
                model: 'gpt-4o',
                inputPerM: -1,
                outputPerM: 1,
                effectiveFrom: NOW,
            }),
        );
        expect(bad.status).toBe(400);
        const made = await admin.request(
            '/api/operations/pricing/prices',
            json('POST', {
                provider: '*',
                model: 'qwen3-32b',
                inputPerM: 0.05,
                outputPerM: 0.1,
                effectiveFrom: NOW,
            }),
        );
        expect(made.status).toBe(201);
        const price = await made.json();
        expect(price).toMatchObject({
            source: 'admin',
            provider: '*',
            cachedInputPerM: null,
        });

        const pool = await admin.request(
            '/api/operations/pricing/pools',
            json('POST', {
                name: 'GPU box',
                kind: 'fixed',
                category: 'hardware',
                amount: 3600,
                depreciationMonths: 36,
                startsAt: NOW,
                backendIds: ['local-backend'],
            }),
        );
        expect(pool.status).toBe(201);
        const fixed = await pool.json();
        expect(fixed).toMatchObject({
            period: 'month',
            allocation: 'tokens',
            weights: { input: 1, cached: 0.1, output: 4 },
        });
        // A fixed pool takes no readings; a depreciated variable one is refused.
        expect(
            (
                await admin.request(
                    `/api/operations/pricing/pools/${fixed.id}/readings`,
                    json('POST', { at: NOW, quantity: 1, unit: 'kWh' }),
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await admin.request(
                    '/api/operations/pricing/pools',
                    json('POST', {
                        name: 'x',
                        kind: 'variable',
                        category: 'power',
                        amount: 0.2,
                        depreciationMonths: 12,
                        startsAt: NOW,
                    }),
                )
            ).status,
        ).toBe(400);
        const power = await (
            await admin.request(
                '/api/operations/pricing/pools',
                json('POST', {
                    name: 'Power',
                    kind: 'variable',
                    category: 'power',
                    amount: 0.2,
                    startsAt: NOW,
                    backendIds: ['local-backend'],
                }),
            )
        ).json();
        const reading = await admin.request(
            `/api/operations/pricing/pools/${power.id}/readings`,
            json('POST', { at: NOW + DAY, quantity: 12.5, unit: 'kWh' }),
        );
        expect(reading.status).toBe(201);
        const updated = await admin.request(
            `/api/operations/pricing/pools/${fixed.id}`,
            json('PUT', {
                name: 'GPU box 2',
                kind: 'fixed',
                category: 'hardware',
                amount: 4000,
                depreciationMonths: 36,
                startsAt: NOW,
                backendIds: ['local-backend'],
            }),
        );
        expect(await updated.json()).toMatchObject({
            name: 'GPU box 2',
            amount: 4000,
            createdAt: fixed.createdAt,
        });

        const view = await (await admin.request('/api/operations/pricing')).json();
        expect(view.pools).toHaveLength(2);
        expect(view.readings).toMatchObject([{ poolId: power.id, quantity: 12.5, unitPrice: null }]);
        expect(view.prices).toHaveLength(1);
        expect(view.backends).toMatchObject([
            {
                label: 'Local GPU',
                kind: 'shared',
                model: 'qwen3-32b',
                provider: 'self-hosted',
            },
        ]);
        expect(JSON.stringify(view)).not.toContain('sk-never-shown');

        expect((await admin.request(`/api/operations/pricing/pools/${power.id}`, del)).status).toBe(204);
        expect((await (await admin.request('/api/operations/pricing')).json()).readings).toEqual([]);
        expect((await admin.request(`/api/operations/pricing/prices/${price.id}`, del)).status).toBe(204);
        expect((await admin.request(`/api/operations/pricing/prices/${price.id}`, del)).status).toBe(404);
        await vi.waitFor(() => expect(workspace.auditOf('operations_pricing', fixed.id)).toHaveLength(2));
    });

    it('answers Cost with the store’s status, null while it can’t', async () => {
        const { admin } = await app();
        const response = await admin.request('/api/operations/cost?range=7d');
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            status: { state: 'unavailable' },
            cost: null,
        });
    });
});
