/**
 * Service accounts at the HTTP edge: their API keys, checked before the browser
 * checks, and their admin routes. `index.ts` mounts each where app.ts did.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { SERVICE_KEY_PREFIX } from '../../service-accounts/contract.js';
import { serviceAccountRoutes } from '../../service-accounts/service-account-routes.js';
import { requestIp, scopeAllows } from '../../service-accounts/service-accounts.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyServiceAccounts } from '../service-accounts.js';

/**
 * Service accounts' API keys (CB-57), from anywhere that reaches the app:
 * like data tokens, a bearer header is never sent by a browser on its own,
 * so the origin and cross-site checks below don't apply (the host check
 * does). A key reaches only what its scopes list; everything else,
 * /api/auth and the chat runtime included, is refused here.
 */
export function mountServiceKeys(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const serviceAccounts = edge && Context.get(edge.services, LegacyServiceAccounts);
    app.use('/api/*', async function serviceKey(c, next) {
        const header = c.req.header('authorization') ?? '';
        if (!serviceAccounts || !header.startsWith(`Bearer ${SERVICE_KEY_PREFIX}`)) {
            return next();
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        const found = serviceAccounts.resolve(header.slice('Bearer '.length).trim(), requestIp(c));
        if (!found) {
            return c.json(
                {
                    error: 'The API key is invalid, expired or revoked.',
                    code: 'bad_key',
                },
                401,
            );
        }
        if (!scopeAllows(found.key.scopes, c.req.method, c.req.path)) {
            return c.json(
                {
                    error: `This key (scopes: ${found.key.scopes.join(', ')}) may not ${c.req.method} ${c.req.path}.`,
                    code: 'scope',
                },
                403,
            );
        }
        if (!serviceAccounts.take(found.key.keyId)) {
            return c.json({ error: 'Too many requests for this key. Try again in a minute.' }, 429);
        }
        c.set('serviceKey', found.key);
        c.set('user', found.user);
        await next();
    });
}

export function mountServiceAccountRoutes(app: Hono<AppEnv>, edge: AppEdge) {
    const workspace = Context.get(edge.services, LegacyWorkspace);
    app.route(
        '/api',
        serviceAccountRoutes(Context.get(edge.services, LegacyServiceAccounts), (entry) => workspace.audit(entry)),
    );
}

/** Service accounts' steps, as index.ts mounts them: their keys and their routes. */
export const serviceAccountsRoutes = {
    keys: mountServiceKeys,
    routes: mountServiceAccountRoutes,
};
