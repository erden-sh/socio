import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    DEFAULT_POOL_WEIGHTS,
    POOL_ALLOCATIONS,
    POOL_CATEGORIES,
    POOL_KINDS,
    POOL_PERIODS,
    type CostPool,
    type MeterReading,
    type ModelPrice,
    type PriceSyncView,
    type PricingBackend,
    type PricingView,
} from '@socio/shared/operations/operations-cost';

import { Inference } from '../../inference/contract.js';
import type { ModuleContext } from '../../modules/contract.js';
import { WorkspaceSettings } from '../../settings/contract.js';
import { Audit } from '../../workspace/contract.js';
import { AnalyticsStore } from '../analytics/connect.js';
import { OperationsConfig } from '../contract.js';
import { AnalyticsOpsReader } from '../infra/analytics/reader.js';
import { SqlitePricing } from '../infra/sqlite/pricing.js';

import { providerOf } from './model-key.js';
import { PriceSync, priceSyncEnabled } from './sync.js';

/**
 * What prices read of other features, from the app's services at each use:
 * the backends and bring-your-own kinds in force (`Inference`), and the
 * analytics store, when there is one (`AnalyticsStore`), for the models its
 * turns used and a nudge after a change.
 */
const inferenceOf = (context: ModuleContext) => context.services.get(Inference);
const analyticsOf = (context: ModuleContext) => context.services.get(AnalyticsStore);

/** Each runtime's price sync and repository, by its context's services. */
const services = new WeakMap<object, { repo: SqlitePricing; sync: PriceSync }>();

/** The models in use: backends', bring-your-own kinds' and turns'. */
async function watched(context: ModuleContext) {
    const inference = inferenceOf(context);
    const models: string[] = [];
    for (const backend of await inference.store.backends()) {
        if (backend.config.model) {
            models.push(backend.config.model);
        }
    }
    for (const kind of inference.byoKinds()) {
        const model = await inference.byoModel(kind);
        if (model) {
            models.push(model);
        }
    }
    const analytics = analyticsOf(context);
    if (analytics) {
        models.push(...(await new AnalyticsOpsReader(analytics).costModels().catch(() => [])));
    }
    return models;
}

/** One price sync and repository per runtime (never a process global). */
export function pricing(context: ModuleContext) {
    let found = services.get(context.services);
    if (!found) {
        const repo = new SqlitePricing(sqliteData(context.db));
        // The workspace's settings and Operations' config, from the app's services.
        const store = context.services.get(WorkspaceSettings);
        const config = context.services.get(OperationsConfig);
        found = {
            repo,
            sync: new PriceSync({
                repo,
                enabled: () => priceSyncEnabled(store.settings().operations, config.operations),
                watched: () => watched(context),
                origin: config.priceSyncUrl,
                log: context.log,
                changed: () => analyticsOf(context)?.nudge(),
            }),
        };
        services.set(context.services, found);
    }
    return found;
}

/**
 * The backends in force, as the Cost page and the cost step know them:
 * the shared ones (read through inference's store, never its tables or
 * keys) and the bring-your-own kinds. Copied into `cost_backends` for the
 * analytics process, which reads no inference table.
 */
export async function recordBackends(context: ModuleContext): Promise<PricingBackend[]> {
    const inference = inferenceOf(context);
    const live = [
        ...(await inference.store.backends()).map((backend): PricingBackend => ({
            id: backend.id,
            label: backend.label,
            kind: 'shared',
            model: backend.config.model || null,
            provider: providerOf(backend.config.baseUrl),
            enabled: backend.enabled,
        })),
        ...(await Promise.all(
            inference.byoKinds().map(async (kind): Promise<PricingBackend> => ({
                id: `byo:${kind.id}`,
                label: kind.label,
                kind: 'byo',
                model: (await inference.byoModel(kind)) ?? null,
                provider: kind.id.replace(/^byo-/, ''),
                enabled: true,
            })),
        )),
    ];
    await pricing(context).repo.recordBackends(live, Date.now());
    return live;
}

const perM = z.number().finite().min(0).max(1_000_000);
const priceInput = z
    .object({
        provider: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[\w.*:@+-]+$/),
        model: z.string().trim().min(1).max(200),
        inputPerM: perM,
        cachedInputPerM: perM.nullable().default(null),
        outputPerM: perM,
        reasoningPerM: perM.nullable().default(null),
        effectiveFrom: z.number().int().min(0).max(8.64e15),
    })
    .strict();

const backendRef = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w.:@+-]+$/);
const weight = z.number().finite().min(0).max(1000);
const poolInput = z
    .object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(POOL_KINDS),
        category: z.enum(POOL_CATEGORIES),
        amount: z.number().finite().min(0).max(1e9),
        period: z.enum(POOL_PERIODS).default('month'),
        depreciationMonths: z.number().int().min(1).max(600).nullable().default(null),
        startsAt: z.number().int().min(0).max(8.64e15),
        endsAt: z.number().int().min(0).max(8.64e15).nullable().default(null),
        backendIds: z.array(backendRef).max(50).default([]),
        allocation: z.enum(POOL_ALLOCATIONS).default('tokens'),
        weights: z.object({ input: weight, cached: weight, output: weight }).strict().default(DEFAULT_POOL_WEIGHTS),
    })
    .strict()
    .refine((pool) => pool.endsAt === null || pool.endsAt > pool.startsAt, {
        message: 'endsAt must be after startsAt',
    })
    .refine((pool) => pool.kind === 'fixed' || pool.depreciationMonths === null, {
        message: 'only a fixed pool is depreciated',
    });

const readingInput = z
    .object({
        at: z.number().int().min(0).max(8.64e15),
        quantity: z.number().finite().min(0).max(1e12),
        unit: z.string().trim().min(1).max(32),
        unitPrice: z.number().finite().min(0).max(1e9).nullable().default(null),
    })
    .strict();

/**
 * Prices, the price sync and cost pools (CB-195, CB-196), admins only
 * (the module's `access`). Every change is written to `workspace_audit`
 * and nudges the analytics store, which prices turns again with it.
 */
export function pricingRoutes(context: ModuleContext) {
    const store = context.services.get(WorkspaceSettings);
    const config = context.services.get(OperationsConfig);
    const workspace = context.services.get(Audit);
    const { repo, sync } = pricing(context);
    const app = new Hono<AppEnv>();
    const audit = (actor: string, action: 'create' | 'update' | 'delete', targetId: string, detail: unknown) => {
        workspace.audit({
            actor,
            action,
            targetKind: 'operations_pricing',
            targetId,
            detail: JSON.stringify(detail),
        });
        analyticsOf(context)?.nudge();
    };
    const syncView = () => {
        const saved = store.settings().operations?.pricing?.sync;
        return sync.view(priceSyncEnabled(undefined, config.operations), typeof saved === 'boolean');
    };
    app.get('/operations/pricing', async (c) =>
        c.json<PricingView>({
            sync: await syncView(),
            prices: await repo.prices(),
            backends: await recordBackends(context),
            pools: await repo.pools(),
            readings: await repo.readings(),
        }),
    );

    // The switch: true or false saves an admin's choice, null goes back to the server's.
    app.put('/operations/pricing/sync', async (c) => {
        const input = z
            .object({ enabled: z.boolean().nullable() })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json({ error: 'Send enabled as true or false, or null for the server’s.' }, 400);
        }
        const operations = { ...store.settings().operations };
        const before = priceSyncEnabled(operations, config.operations);
        const pricingSettings = { ...operations.pricing };
        if (input.data.enabled === null) {
            delete pricingSettings.sync;
        } else {
            pricingSettings.sync = input.data.enabled;
        }
        if (Object.keys(pricingSettings).length) {
            operations.pricing = pricingSettings;
        } else {
            delete operations.pricing;
        }
        await store.updateSettings({ operations });
        const after = priceSyncEnabled(operations, config.operations);
        // Off stops a run in flight; the next source is not read.
        if (!after) {
            await sync.stop();
        }
        workspace.audit({
            actor: c.get('user').id,
            action: 'update',
            targetKind: 'operations_settings',
            targetId: 'price_sync',
            detail: JSON.stringify({ before, after, change: input.data }),
        });
        return c.json<PriceSyncView>(await syncView());
    });

    // "Sync now": starts a run (or joins the one going) and answers at once.
    app.post('/operations/pricing/sync', async (c) => {
        if (!priceSyncEnabled(store.settings().operations, config.operations)) {
            return c.json(
                {
                    error: 'Price sync is off. Turn it on in Operations → Settings first.',
                },
                409,
            );
        }
        void sync.run().catch(() => undefined);
        return c.json<PriceSyncView>(await syncView(), 202);
    });

    app.post('/operations/pricing/prices', async (c) => {
        const input = priceInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json(
                {
                    error: 'Send provider, model, inputPerM and outputPerM (US dollars per million tokens, 0 or more), and effectiveFrom (ms); cachedInputPerM and reasoningPerM may be null.',
                },
                400,
            );
        }
        const price = await repo.addAdminPrice(input.data, Date.now());
        audit(c.get('user').id, 'create', price.id, input.data);
        return c.json<ModelPrice>(price, 201);
    });

    app.delete('/operations/pricing/prices/:id', async (c) => {
        const removed = await repo.removeAdminPrice(c.req.param('id'));
        if (!removed) {
            return c.json({ error: 'There is no such admin price.' }, 404);
        }
        audit(c.get('user').id, 'delete', removed.id, {
            provider: removed.provider,
            model: removed.model,
            effectiveFrom: removed.effectiveFrom,
        });
        return c.body(null, 204);
    });

    const poolError =
        'Send name, kind (fixed or variable), category, amount (US dollars), period, startsAt and, optionally, endsAt after it, depreciationMonths (fixed pools only), backendIds, allocation and weights.';

    app.post('/operations/pricing/pools', async (c) => {
        const input = poolInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json({ error: poolError }, 400);
        }
        const now = Date.now();
        const pool = await repo.savePool({
            id: randomUUID(),
            ...input.data,
            currency: 'USD',
            createdAt: now,
            updatedAt: now,
        });
        audit(c.get('user').id, 'create', pool.id, input.data);
        return c.json<CostPool>(pool, 201);
    });

    app.put('/operations/pricing/pools/:id', async (c) => {
        const old = await repo.pool(c.req.param('id'));
        if (!old) {
            return c.json({ error: 'There is no such cost pool.' }, 404);
        }
        const input = poolInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json({ error: poolError }, 400);
        }
        const pool = await repo.savePool({
            ...old,
            ...input.data,
            updatedAt: Date.now(),
        });
        audit(c.get('user').id, 'update', pool.id, input.data);
        return c.json<CostPool>(pool);
    });

    app.delete('/operations/pricing/pools/:id', async (c) => {
        const removed = await repo.removePool(c.req.param('id'));
        if (!removed) {
            return c.json({ error: 'There is no such cost pool.' }, 404);
        }
        audit(c.get('user').id, 'delete', removed.id, { name: removed.name });
        return c.body(null, 204);
    });

    app.post('/operations/pricing/pools/:id/readings', async (c) => {
        const pool = await repo.pool(c.req.param('id'));
        if (!pool) {
            return c.json({ error: 'There is no such cost pool.' }, 404);
        }
        if (pool.kind !== 'variable') {
            return c.json({ error: 'Only a variable pool takes meter readings.' }, 400);
        }
        const input = readingInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json(
                {
                    error: 'Send at (ms), quantity (0 or more), unit, and unitPrice in US dollars or null for the pool’s.',
                },
                400,
            );
        }
        const reading = await repo.addReading({ poolId: pool.id, ...input.data });
        audit(c.get('user').id, 'create', pool.id, { reading: input.data });
        return c.json<MeterReading>(reading, 201);
    });

    app.delete('/operations/pricing/readings/:id', async (c) => {
        const removed = await repo.removeReading(c.req.param('id'));
        if (!removed) {
            return c.json({ error: 'There is no such meter reading.' }, 404);
        }
        audit(c.get('user').id, 'delete', removed.poolId, { reading: removed.id });
        return c.body(null, 204);
    });

    return app;
}
