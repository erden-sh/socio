import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { ApplyRefused, type Updater } from './updater.js';

const digest = (text: string) => createHash('sha256').update(text).digest();

/**
 * The updater's HTTP API (CB-259), for the app only: `GET /healthz` (no
 * token; says nothing but that it runs), and, with the shared bearer token,
 * `GET /v1/status` and `POST /v1/apply`. Only the app holds the token and
 * only the app's internal network reaches the port.
 */
export function updaterApp(updater: Updater, token: string) {
    const expected = digest(token);
    const app = new Hono();
    app.get('/healthz', (c) => c.json({ ok: true }));
    app.use('/v1/*', async (c, next) => {
        const header = c.req.header('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!presented || !timingSafeEqual(digest(presented), expected)) {
            return c.json({ error: 'Unauthorized.' }, 401);
        }
        await next();
    });
    app.get('/v1/status', (c) => c.json(updater.status()));
    app.post('/v1/apply', async (c) => {
        const body = await c.req.json().catch(() => null);
        try {
            return c.json({ job: await updater.apply(body) }, 202);
        } catch (error) {
            if (error instanceof ApplyRefused) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        }
    });
    app.onError((_error, c) => c.json({ error: 'The updater failed.' }, 500));
    return app;
}
