import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { sameSecret } from '../../../apps-runtime/keys.js';

import type { AnalyticsAnswer, EngineStatus } from './ipc.js';

/** What the HTTP API needs of the engine (tests may fake it). */
export interface AnalyticsHandler {
    handle(request: unknown): Promise<AnalyticsAnswer>;
    status(): EngineStatus;
}

/**
 * The `socio-analytics` service's API (service mode): only the app calls
 * it, over the stack's internal network, with the shared secret
 * (`OPS_ANALYTICS_SECRET`, a Docker secret). `/healthz` alone is open and
 * says only whether it is up and its state.
 */
export function analyticsHttpApp(engine: AnalyticsHandler, secret: string) {
    const app = new Hono();
    app.get('/healthz', (c) => c.json({ ok: true, state: engine.status().state }));
    app.use('*', async (c, next) => {
        const supplied = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
        if (!sameSecret(supplied, secret)) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        await next();
    });
    app.post(
        '/v1/rpc',
        bodyLimit({
            maxSize: 64 * 1024,
            onError: (c) => c.json({ error: 'Request is too large.' }, 413),
        }),
        async (c) => {
            let body: unknown;
            try {
                body = await c.req.json();
            } catch {
                body = undefined;
            }
            return c.json(await engine.handle(body));
        },
    );
    return app;
}
