/**
 * Workspace plugins at the HTTP edge: subscription feeds, a service plugin's
 * identity on the workload routes, and its calls back for data and socio
 * access. `index.ts` mounts each where app.ts did.
 *
 * They take the whole plugin service from the app's services (`LegacyPlugins`):
 * what they call (`feed`, `workloadIdentity`, `staleIdentity`,
 * `acceptsServiceCall`, `serviceCaller`) is plugins' own edge, not in the
 * `Plugins` contract, and none of it is an Effect, so no route here runs
 * through `handle(...)`. A stale identity is reported to Socio Secrets by
 * its contract's slice (`refuseStaleIdentity`).
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import { DataError } from '@socio/foundation/dataspace/data-error';
import { allowedHost, originList } from '@socio/foundation/http/allowed-host';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { PLUGIN_IDENTITY_PREFIX } from '@socio/shared/identity-delivery';

import type { AppEdge } from '../../main.js';
import { LegacyData } from '../dataspace.js';
import { LegacyPlugins } from '../plugins.js';
import { LegacyWorkspaceSecrets } from '../workspace-secrets.js';

/**
 * A bundled plugin's subscription feed (CB-254, a calendar's .ics): the
 * token in the path is the only credential, as a calendar app has no
 * session. The plugin checks it and that its person may still use the
 * plugin. Outside /api, before the pages; only GET and HEAD.
 */
export function mountPluginFeeds(app: Hono<AppEnv>, edge: AppEdge, origin: string | string[] | undefined) {
    const plugins = Context.get(edge.services, LegacyPlugins);
    app.on(['GET', 'HEAD'], '/plugin-feeds/:id/:token', async (c) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        if (!allowedHost(c.req.url, originList(origin))) {
            return c.text('Unrecognized host.', 403);
        }
        const found = await plugins.feed(c.req.param('id'), c.req.param('token')).catch(() => undefined);
        return found ?? c.text('Not found.', 404);
    });
}

/**
 * Socio Secrets phase 2: a service plugin reads its secrets with its own
 * identity token (`cbpi_`, delivered by the runtime) and the proof of its
 * id; the shared PLUGIN_SERVICE_TOKEN never reaches these routes.
 */
export function mountPluginIdentities(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    const workspaceSecrets = edge && Context.get(edge.services, LegacyWorkspaceSecrets);
    app.use('/api/workload/*', async function pluginIdentity(c, next) {
        const header = c.req.header('authorization') ?? '';
        if (!plugins || !workspaceSecrets || !header.startsWith(`Bearer ${PLUGIN_IDENTITY_PREFIX}`)) {
            return next();
        }
        const token = header.slice(7).trim();
        const proof = c.req.header('x-cb-plugin-proof');
        const identity = plugins.workloadIdentity(token, proof);
        if (!identity) {
            // Socio Secrets phase 4: a plugin's own identity that is no longer
            // accepted, with its valid proof, is audited as a stale identity.
            const stale = plugins.staleIdentity(token, proof);
            if (stale) {
                const names =
                    c.req.path.match(/^\/api\/workload\/secrets\/([^/]+)$/)?.[1] ?? c.req.query('names') ?? '';
                workspaceSecrets.refuseStaleIdentity(stale.pluginId, stale.version, names);
            }
            return c.json({ error: 'The plugin identity was refused.' }, 401);
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.set('pluginService', {
            pluginId: identity.pluginId,
            identity: true,
            identityVersion: identity.version,
        });
        await next();
    });
}

/**
 * A plugin service calls back over the apps network. Its bearer is not a
 * browser's, so the host check does not apply. The proof binds the call
 * to that plugin's id: the shared token alone cannot open another plugin.
 */
export function mountPluginServiceCalls(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    app.use('/api/plugins/:id/data/*', async function pluginServiceCall(c, next) {
        if (!plugins) {
            return next();
        }
        const header = c.req.header('authorization') ?? '';
        if (!header.startsWith('Bearer ')) {
            return next();
        }
        const token = header.slice('Bearer '.length).trim();
        const id = c.req.param('id');
        const proof = c.req.header('x-cb-plugin-proof');
        if (!plugins.acceptsServiceCall(id, token, proof)) {
            return c.json({ error: 'The plugin service was refused.' }, 401);
        }
        if (
            !['GET', 'HEAD', 'DELETE'].includes(c.req.method) &&
            !c.req.header('content-type')?.includes('application/json')
        ) {
            return c.json({ error: 'Use application/json.' }, 415);
        }
        // Whose call it is (CB-232): the person or socio behind the
        // request's `x-cb-obo`, else the service's own background work.
        const caller = await plugins.serviceCaller(id, c.req.header('x-cb-obo'), c.req.method);
        if (!caller.ok) {
            return c.json({ error: caller.error }, caller.status);
        }
        c.set('pluginService', { pluginId: id });
        c.set('user', caller.user);
        await next();
    });
}

/**
 * CB-232: a service plugin's socio-access calls (action approvals,
 * continuations) are its own service's only, by the same token and
 * proof, and never a person's session: no fallback past this check.
 * Whom they are for is the request's `x-cb-obo` (plugins/routes.ts).
 */
export function mountPluginActorCalls(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    app.use('/api/plugins/:id/actor/*', async function pluginActorCall(c, next) {
        if (!plugins) {
            return next();
        }
        const header = c.req.header('authorization') ?? '';
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
        const id = c.req.param('id');
        if (!plugins.acceptsServiceCall(id, token, c.req.header('x-cb-plugin-proof'))) {
            return c.json({ error: 'The plugin service was refused.' }, 401);
        }
        if (!c.req.header('content-type')?.includes('application/json')) {
            return c.json({ error: 'Use application/json.' }, 415);
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.set('pluginService', { pluginId: id });
        await next();
    });
}

/**
 * CB-458 step 5: a service plugin asks for a snapshot of its own storage
 * (`socio.backup.request`) with its own identity token (`cbpi_`) and the
 * proof of its id, never the shared token or a person's session: no
 * fallback past this check. The route rate-limits it (plugins/routes.ts).
 */
export function mountPluginBackupRequests(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    app.use('/api/plugins/:id/backup/request', async function pluginBackupRequest(c, next) {
        if (!plugins) {
            return next();
        }
        const header = c.req.header('authorization') ?? '';
        const token = header.startsWith(`Bearer ${PLUGIN_IDENTITY_PREFIX}`) ? header.slice(7).trim() : undefined;
        const identity = token ? plugins.workloadIdentity(token, c.req.header('x-cb-plugin-proof')) : undefined;
        if (!identity || identity.pluginId !== c.req.param('id')) {
            return c.json({ error: 'The plugin identity was refused.' }, 401);
        }
        if (!c.req.header('content-type')?.includes('application/json')) {
            return c.json({ error: 'Use application/json.' }, 415);
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        c.set('pluginService', { pluginId: identity.pluginId, identity: true, identityVersion: identity.version });
        await next();
    });
}

/** Token exchanges a plugin may make in a minute. */
const DATA_TOKEN_EXCHANGES_PER_MINUTE = 30;

/**
 * A service plugin exchanges its identity (its own `cbpi_` token and the
 * proof of its id, checked by `mountPluginIdentities` on `/api/workload/*`)
 * for a short-lived data token (`cbdt_`, purpose `plugin`) that reaches the
 * datasets bound to its manifest's needs (CB-451), each with its binding's
 * access, and nothing else, at `/api/data/*`, as the plugin: no `x-cb-obo`
 * (its scheduled work, no person present), audited as the plugin. The
 * shared service token, an app's data token and a session are refused.
 * `datasets` narrows it to some of the plugin's needs by name.
 */
export function mountPluginDataTokens(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    const plugins = edge && Context.get(edge.services, LegacyPlugins);
    const data = edge && Context.get(edge.services, LegacyData);
    const recent = new Map<string, number[]>();
    app.post('/api/workload/data-token', async (c) => {
        const plugin = c.get('pluginService');
        if (!plugins || !data || !plugin?.identity || plugin.identityVersion === undefined) {
            return c.json({ error: 'Send the plugin’s own identity token and its proof.' }, 401);
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        const id = plugin.pluginId;
        const now = Date.now();
        const window = (recent.get(id) ?? []).filter((at) => at > now - 60_000);
        if (window.length >= DATA_TOKEN_EXCHANGES_PER_MINUTE) {
            recent.set(id, window);
            c.header('Retry-After', '60');
            return c.json(
                { error: 'Too many data token exchanges for this plugin. Reuse a token until it expires.' },
                429,
            );
        }
        window.push(now);
        recent.set(id, window);
        const raw = (await c.req.text().catch(() => '')).trim();
        let names: string[] | undefined;
        if (raw) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return c.json({ error: 'Send JSON: {} or { "datasets": ["name", …] }.' }, 400);
            }
            const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : null;
            const wanted = (parsed as { datasets?: unknown } | null)?.datasets;
            if (
                !keys ||
                keys.some((key) => key !== 'datasets') ||
                (wanted !== undefined &&
                    (!Array.isArray(wanted) ||
                        wanted.length > 16 ||
                        wanted.some((name) => typeof name !== 'string' || !name || name.length > 63)))
            ) {
                return c.json({ error: 'Send JSON: {} or { "datasets": ["name", …] } (at most 16 names).' }, 400);
            }
            names = wanted as string[] | undefined;
        }
        if (!plugins.dataTokenLive(id, plugin.identityVersion)) {
            return c.json({ error: 'The plugin identity was refused.' }, 401);
        }
        try {
            const issued = data.issuePluginToken(id, plugin.identityVersion, names);
            if (!issued.token) {
                return c.json(
                    {
                        error: issued.unbound.length
                            ? 'None of this plugin’s dataset needs is bound: an admin binds them on the plugin’s page.'
                            : 'This plugin has no datasets: its manifest declares none, or an admin deleted them (enable it again to make new ones).',
                        unbound: issued.unbound,
                    },
                    404,
                );
            }
            // Each bound need with its dataset's id and access (CB-451), and
            // the needs an admin left unbound, which the token doesn't cover.
            return c.json({
                token: issued.token,
                expiresAt: issued.expiresAt,
                dataUrl: '/api/data',
                datasets: issued.datasets,
                unbound: issued.unbound,
            });
        } catch (error) {
            if (error instanceof DataError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        }
    });
}

/** Plugins' steps, as index.ts orders them: their feeds, identities, data tokens, service calls and actor calls. */
export const pluginsRoutes = {
    feeds: mountPluginFeeds,
    identities: mountPluginIdentities,
    dataTokens: mountPluginDataTokens,
    serviceCalls: mountPluginServiceCalls,
    actorCalls: (app: Hono<AppEnv>, edge: AppEdge | undefined) => {
        mountPluginActorCalls(app, edge);
        // CB-458: beside the actor calls, before the session, as theirs is.
        mountPluginBackupRequests(app, edge);
    },
};
