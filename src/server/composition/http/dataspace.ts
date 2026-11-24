/**
 * The data space at the HTTP edge: scoped data tokens, checked before the
 * browser checks. `index.ts` mounts them where app.ts did.
 */
import { Context } from 'effect';
import type { Hono, MiddlewareHandler } from 'hono';

import { DATA_TOKEN_PREFIX } from '@socio/foundation/actors/redact';
import type { AppEnv } from '@socio/foundation/http/app-env';

import { DATA_APPEND_PATH } from '../../dataspace/routes.js';
import type { AppEdge } from '../../main.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyData } from '../dataspace.js';
import { LegacyPlugins } from '../plugins.js';

/**
 * Scoped data tokens (a Dot's computer, a job) reach /api/data/* only, from
 * the computers network under any Host: a bearer token is never sent by a
 * browser on its own, so the host, origin and session checks below don't
 * apply to them. An unknown or expired token is refused here.
 */
export function mountDataTokens(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const data = edge && Context.get(edge.services, LegacyData);
    const workspace = edge && Context.get(edge.services, LegacyWorkspace);
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    const dataTokens: MiddlewareHandler<AppEnv> = async (c, next) => {
        const header = c.req.header('authorization') ?? '';
        if (!data || !workspace || !header.startsWith(`Bearer ${DATA_TOKEN_PREFIX}`)) {
            return next();
        }
        const token = header.slice(7).trim();
        const scope = data.tokens.resolve(token);
        if (!scope) {
            // A mini app holding a dead token recovers by itself (CB-291).
            data.tokens.refused?.(token);
            return c.json({ error: 'The data token is invalid or expired.' }, 401);
        }
        // A plugin's token, on every request: its plugin still installed and
        // enabled, the identity it was exchanged for still accepted, and only
        // the data API (never an app's or a workload's routes).
        if (scope.purpose === 'plugin') {
            const live =
                !!scope.pluginId &&
                scope.identityVersion !== undefined &&
                !!plugins?.dataTokenLive(scope.pluginId, scope.identityVersion);
            if (!live) {
                return c.json({ error: 'The data token is invalid or expired.' }, 401);
            }
            if (c.req.path !== '/api/data' && !c.req.path.startsWith('/api/data/')) {
                return c.json({ error: 'A plugin’s data token reaches the data API only.' }, 403);
            }
        }
        // An admin's data API token: the data API only, too.
        if (scope.purpose === 'api' && c.req.path !== '/api/data' && !c.req.path.startsWith('/api/data/')) {
            return c.json({ error: 'A data API token reaches the data API only.' }, 403);
        }
        if (
            !['GET', 'HEAD', 'DELETE'].includes(c.req.method) &&
            !c.req.header('content-type')?.includes('application/json') &&
            // An analytical append may be NDJSON (CB-369).
            !(
                c.req.method === 'POST' &&
                DATA_APPEND_PATH.test(c.req.path) &&
                /^application\/(x-ndjson|jsonl)\b/i.test(c.req.header('content-type') ?? '')
            )
        ) {
            return c.json({ error: 'Use application/json.' }, 415);
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        // Recheck company-computer reach on every request, including tokens
        // issued before this guard. Promoted apps run in the isolated app runtime
        // and have app-specific grants instead (CB-226).
        const sharedComputer =
            !scope.appId &&
            (scope.purpose === 'app' || scope.purpose === 'job') &&
            workspace.dot(scope.dotId)?.ownerId === null;
        c.set('dataToken', sharedComputer ? { ...scope, reach: 'socio' } : scope);
        await next();
        // Its use, for its row and the workspace audit's summary.
        if (scope.purpose === 'api' && scope.apiToken) {
            data.apiTokens.used(scope.apiToken.id, {
                write: !['GET', 'HEAD'].includes(c.req.method),
                status: c.res.status,
            });
        }
    };
    app.use('/api/data/*', dataTokens);
    // CB-232: a mini app's own data token also reaches its socio-access
    // calls (action approvals, continuations), with the request's `x-cb-obo`;
    // the routes accept app tokens only (apps/routes.ts).
    app.use('/api/apps/actor/*', dataTokens);
    // Socio Secrets (phase 1): a workspace app reads the secrets granted to
    // it with its own data token; the routes take promoted apps' only.
    app.use('/api/workload/*', dataTokens);
}

/** The dataspace's step, as index.ts mounts it: data tokens. */
export const dataspaceRoutes = { tokens: mountDataTokens };
