import type { MiddlewareHandler } from 'hono';

import { isAdmin } from '@socio/shared/roles';

import type { AppEnv } from './app-env.js';

/** Route guard: admins pass; members get 403. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!isAdmin(c.get('user'))) {
        return c.json({ error: 'Only an admin can change this.' }, 403);
    }
    await next();
};

/**
 * The former operator guard, now the admin guard (CB-390): kept as
 * an alias until the Platform routes it still guards move to admins.
 */
export const requireOperator: MiddlewareHandler<AppEnv> = requireAdmin;
