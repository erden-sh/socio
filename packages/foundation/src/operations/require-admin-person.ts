import type { MiddlewareHandler } from 'hono';

import { isAdmin } from '@socio/shared/roles';

import type { AppEnv } from '../http/app-env.js';

/**
 * Who may open person-level rows and content (CB-188): a signed-in admin,
 * never a key. Moved from `src/server/operations/access-log.ts`, which
 * re-exports it.
 */
export const requireAdminPerson: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!isAdmin(c.get('user')) || c.get('serviceKey') || c.get('dataToken')) {
        return c.json({ error: 'Only an admin, signed in as themselves, can open this.' }, 403);
    }
    await next();
};
