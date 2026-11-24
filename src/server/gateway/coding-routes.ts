import { Hono } from 'hono';

import { requireFlag } from '@socio/foundation/flags/guard';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { CodingSettingsState } from '@socio/shared/coding/coding-gateway';

import { CodingSettingsError } from './coding-settings.js';
import type { ModelGateway } from './model.js';
import { GatewayOptionsError } from './options.js';
import type { GatewaySources } from './sources.js';

/**
 * Settings → Coding's models, limits, switches (personal plans) and usage
 * (CB-239), under `/api/gateway/coding`: admins only, and only
 * where the flag `coding-sessions` is on for them (dark until then). The
 * Git proxy's repository routes sit beside these under `/api/gateway`, so
 * every guard here is scoped to `/coding/*`.
 */
export function codingSettingsRoutes(sources: GatewaySources, gateway: ModelGateway) {
    const app = new Hono<AppEnv>();
    app.use('/coding/*', requireAdmin);
    app.use('/coding/*', requireFlag(sources.flags, 'coding-sessions'));
    app.use('/coding', requireAdmin);
    app.use('/coding', requireFlag(sources.flags, 'coding-sessions'));
    const { settings } = gateway;
    const label = (id: string, kind: 'person' | 'socio') =>
        kind === 'person'
            ? (sources.workspace.users().find((user) => user.id === id)?.name ?? id)
            : (sources.workspace.dot(id)?.name ?? id);
    const state = async (): Promise<CodingSettingsState> => {
        const usage = gateway.ledger.summary();
        return {
            models: await settings.views(),
            backends: await settings.backendOptions(),
            limits: settings.limits(),
            limitDefaults: settings.limitDefaults,
            usage: {
                persons: usage.persons.map((row) => ({
                    ...row,
                    label: label(row.id, 'person'),
                })),
                socios: usage.socios.map((row) => ({
                    ...row,
                    label: label(row.id, 'socio'),
                })),
                models: usage.models.map((row) => ({ ...row, label: row.id })),
            },
        };
    };
    const failed = (error: unknown) => {
        if (error instanceof CodingSettingsError) {
            return { body: { error: error.message }, status: error.status };
        }
        throw error;
    };
    const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => undefined);

    app.get('/coding', async (c) => c.json(await state()));
    app.put('/coding/models/:id', async (c) => {
        try {
            await settings.saveModel(c.req.param('id'), await body(c), c.get('user').id);
            return c.json(await state());
        } catch (error) {
            const out = failed(error);
            return c.json(out.body, out.status);
        }
    });
    app.delete('/coding/models/:id', async (c) => {
        if (!(await settings.deleteModel(c.req.param('id'), c.get('user').id))) {
            return c.json({ error: 'That model isn’t listed.' }, 404);
        }
        return c.json(await state());
    });
    app.put('/coding/models/:id/repositories', async (c) => {
        try {
            const input = (await body(c)) as { repositories?: unknown } | undefined;
            await settings.setRepositories(c.req.param('id'), input?.repositories, c.get('user').id);
            return c.json(await state());
        } catch (error) {
            const out = failed(error);
            return c.json(out.body, out.status);
        }
    });
    // Personal plans for coding: off unless an admin turns them
    // on (over CODING_PERSONAL_PLANS).
    app.get('/coding/options', (c) => c.json(gateway.options.view()));
    app.put('/coding/options', async (c) => {
        try {
            return c.json(await gateway.options.save(await body(c), c.get('user').id));
        } catch (error) {
            if (error instanceof GatewayOptionsError) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });
    app.put('/coding/limits', async (c) => {
        try {
            await settings.saveLimits(await body(c), c.get('user').id);
            return c.json(await state());
        } catch (error) {
            const out = failed(error);
            return c.json(out.body, out.status);
        }
    });
    return app;
}
