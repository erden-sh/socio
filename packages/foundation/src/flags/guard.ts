import type { MiddlewareHandler } from 'hono';

import type { FlagKey } from '@socio/shared/flags';

import type { AppEnv } from '../http/app-env.js';

/** What a flag guard reads: whether a flag is on for one person. */
export interface FlagGate {
    enabled(key: FlagKey, userId: string): boolean;
}

/**
 * Route guard for a flagged feature: a 404 for anyone it is off for, as if
 * the route weren't there. The server decides; what the client shows
 * never counts.
 */
export const requireFlag =
    (flags: FlagGate, key: FlagKey): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
        if (!flags.enabled(key, c.get('user').id)) {
            return c.json({ error: 'This feature isn’t available to you.' }, 404);
        }
        await next();
    };
