import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { RUNTIME_ACTOR_ENV, type RuntimeStartRequest } from '@socio/shared/apps/apps-runtime-types';
import { PLUGIN_IDENTITY_TOKEN } from '@socio/shared/identity-delivery';
import { PLUGIN_ID, type PluginServiceSpec } from '@socio/shared/plugins/plugin-service';

import { sameSecret } from './keys.js';
import type { PluginServices } from './services.js';
import { RuntimeError, type AppsSupervisor } from './supervisor.js';

const startBody = z
    .object({
        version: z.number().int().min(1).max(1_000_000),
        token: z.string().min(1).max(200).nullable(),
        dataUrl: z.string().url().max(500).nullable(),
        appUrl: z.string().url().max(500),
        env: z
            .record(z.string().max(64), z.string().max(300))
            .default({})
            // A `CB_` name is the runtime's own: only the envelope keys
            // (CB-232) may come with a start.
            .refine(
                (env) =>
                    Object.keys(env).every(
                        (name) => !name.startsWith('CB_') || (RUNTIME_ACTOR_ENV as readonly string[]).includes(name),
                    ),
                { message: 'Reserved environment name.' },
            ),
    })
    .strict();
const tokenBody = z.object({ token: z.string().min(1).max(200) }).strict();
/** A plugin's identity token and its version. */
const identityGrant = z
    .object({
        token: z.string().regex(PLUGIN_IDENTITY_TOKEN),
        version: z.number().int().min(1).max(999_999_999),
    })
    .strict();
/**
 * The registry login the plugin's image pulls with, and its fingerprint
 * (`socio.registry`). Never logged.
 */
const registryGrant = z
    .object({
        registry: z.string().min(1).max(260),
        username: z.string().min(1).max(256),
        password: z.string().min(1).max(4096),
        fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict();

/**
 * The runtime's API (`packages/shared/src/apps/apps-runtime-types.ts`). Only the app
 * calls it, over the internal apps network, with the shared token;
 * `/healthz` alone is open and says nothing.
 */
export function runtimeApp(
    supervisor: AppsSupervisor,
    token: string,
    maxBundleBytes: number,
    services?: PluginServices,
) {
    const app = new Hono();
    app.get('/healthz', (c) => c.json({ ok: true }));
    app.use('*', async (c, next) => {
        const supplied = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
        if (!sameSecret(supplied, token)) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        await next();
    });
    const small = bodyLimit({
        maxSize: 64 * 1024,
        onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    });
    const fail = (c: Context, error: unknown) => {
        if (error instanceof RuntimeError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    const attempt = async (c: Context, work: () => unknown) => {
        try {
            return c.json((await work()) as object);
        } catch (error) {
            return fail(c, error);
        }
    };
    app.get('/v1/apps', (c) => c.json({ apps: supervisor.list() }));
    app.get('/v1/apps/:id', (c) => attempt(c, () => supervisor.status(c.req.param('id'))));
    app.get('/v1/apps/:id/logs', (c) =>
        attempt(c, () => ({
            lines: supervisor.logs(c.req.param('id'), Number(c.req.query('tail') ?? 200) || 200),
        })),
    );
    app.get('/v1/apps/:id/attempts', (c) =>
        attempt(c, () => supervisor.attempts(c.req.param('id'), Number(c.req.query('tail') ?? 0) || undefined)),
    );
    app.put(
        '/v1/apps/:id/versions/:version',
        bodyLimit({
            maxSize: maxBundleBytes,
            onError: (c) => c.json({ error: 'The bundle is too large.' }, 413),
        }),
        async (c) => {
            const sha256 = c.req.header('x-bundle-sha256') ?? '';
            if (!/^[0-9a-f]{64}$/.test(sha256)) {
                return c.json({ error: 'Send x-bundle-sha256.' }, 400);
            }
            const bytes = Buffer.from(await c.req.arrayBuffer());
            return attempt(c, () =>
                supervisor.deploy(c.req.param('id'), Number(c.req.param('version')), bytes, sha256),
            );
        },
    );
    app.post('/v1/apps/:id/start', small, async (c) => {
        const parsed = startBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Invalid start request.' }, 400);
        }
        return attempt(c, () => supervisor.start(c.req.param('id'), parsed.data as RuntimeStartRequest));
    });
    app.post('/v1/apps/:id/stop', small, (c) => attempt(c, () => supervisor.stop(c.req.param('id'))));
    app.put('/v1/apps/:id/token', small, async (c) => {
        const parsed = tokenBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Send { token }.' }, 400);
        }
        return attempt(c, () => supervisor.setToken(c.req.param('id'), parsed.data.token));
    });
    app.delete('/v1/apps/:id', (c) =>
        attempt(c, async () => {
            await supervisor.remove(c.req.param('id'));
            return { ok: true };
        }),
    );
    const plugins = (c: Context) => {
        if (!services) {
            throw new RuntimeError('Plugin services are off on this runtime (APPS_RUNTIME_DOCKER is not on).', 503);
        }
        const id = c.req.param('id');
        if (!id || !PLUGIN_ID.test(id)) {
            throw new RuntimeError('That plugin id is not a service name.', 400);
        }
        return { services, id };
    };
    app.put('/v1/services/:id', small, async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            spec?: PluginServiceSpec;
            identity?: unknown;
            registry?: unknown;
        } | null;
        if (!body?.spec) {
            return c.json({ error: 'Send { spec }.' }, 400);
        }
        // The plugin's fresh identity token and its version, delivered
        // before the service is written. Never logged.
        const identity = identityGrant.safeParse(body.identity);
        if (body.identity !== undefined && !identity.success) {
            return c.json({ error: 'identity is { token, version }.' }, 400);
        }
        const registry = registryGrant.safeParse(body.registry);
        if (body.registry !== undefined && !registry.success) {
            return c.json({ error: 'registry is { registry, username, password, fingerprint }.' }, 400);
        }
        return attempt(c, () => {
            const { services: pluginsOn, id } = plugins(c);
            return pluginsOn.ensure(
                id,
                body.spec!,
                identity.success ? identity.data : undefined,
                registry.success ? registry.data : undefined,
            );
        });
    });
    // Re-attaches the infra services to the plugin's network (Socio's
    // reconcile): a stack update drops attachments the stack doesn't know.
    app.post('/v1/services/:id/networks', small, async (c) => {
        const body = (await c.req.json().catch(() => null)) as { egress?: unknown } | null;
        if (!body || typeof body.egress !== 'boolean') {
            return c.json({ error: 'Send { egress }.' }, 400);
        }
        return attempt(c, () => {
            const { services: pluginsOn, id } = plugins(c);
            return pluginsOn.repairNetworks(id, body.egress as boolean);
        });
    });
    app.post('/v1/services/:id/scale', small, async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            replicas?: number;
        } | null;
        if (!body || typeof body.replicas !== 'number') {
            return c.json({ error: 'Send { replicas }.' }, 400);
        }
        return attempt(c, () => {
            const { services: pluginsOn, id } = plugins(c);
            return pluginsOn.scale(id, body.replicas!);
        });
    });
    app.get('/v1/services/:id', (c) =>
        attempt(c, async () => {
            const { services: pluginsOn, id } = plugins(c);
            const status = await pluginsOn.status(id);
            if (!status) {
                throw new RuntimeError('That plugin service is not here.', 404);
            }
            return status;
        }),
    );
    app.delete('/v1/services/:id', (c) =>
        attempt(c, async () => {
            const { services: pluginsOn, id } = plugins(c);
            await pluginsOn.remove(id);
            return { ok: true };
        }),
    );
    app.onError((error, c) => {
        console.error('Apps runtime request failed:', error.name);
        return c.json({ error: 'The apps runtime failed.' }, 500);
    });
    return app;
}
