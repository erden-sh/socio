import { Hono, type Context, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { isAdmin } from '@socio/shared/roles';

import { AccessPolicyError, type AccessPolicyService } from './access-policy.js';

/**
 * Admins (CB-390), in their own signed-in session: a service account's key
 * or a data token is refused even when its account is an admin, so neither
 * a script nor a socio's computer reaches the access policy (CB-124).
 * Members get 403.
 */
const adminInPerson: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get('serviceKey') || c.get('dataToken')) {
        return c.json({ error: 'The access policy is changed in person, not with a key.' }, 403);
    }
    if (!isAdmin(c.get('user'))) {
        return c.json({ error: 'Only an admin can see or change the access policy.' }, 403);
    }
    await next();
};

const failed = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof AccessPolicyError) {
        return c.json(
            {
                error: error.message,
                ...(error.impact ? { impact: error.impact } : {}),
            },
            error.status,
        );
    }
    throw error;
};

/**
 * The access policy API (CB-124): `GET /api/access-policy` (the view),
 * `POST /api/access-policy/preview` (what a change would do),
 * `POST /api/access-policy/step-up` (a challenge for one change) and
 * `PUT /api/access-policy` (the change, with its proof). No socio tool or
 * MCP tool reaches any of it.
 */
export function accessPolicyRoutes(service: AccessPolicyService) {
    const app = new Hono<AppEnv>();
    app.use('/access-policy', adminInPerson);
    app.use('/access-policy/*', adminInPerson);
    app.get('/access-policy', (c) => c.json(service.view()));
    app.post('/access-policy/preview', async (c) => {
        try {
            return c.json(await service.preview(c.req.raw, await c.req.json().catch(() => null)));
        } catch (error) {
            return failed(c, error);
        }
    });
    app.post('/access-policy/step-up', async (c) => {
        try {
            return c.json(await service.stepUp(c.get('user'), c.req.raw, await c.req.json().catch(() => null)));
        } catch (error) {
            return failed(c, error);
        }
    });
    app.put('/access-policy', async (c) => {
        try {
            return c.json(await service.save(c.get('user'), c.req.raw, await c.req.json().catch(() => null)));
        } catch (error) {
            return failed(c, error);
        }
    });
    return app;
}
