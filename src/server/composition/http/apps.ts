/**
 * Mini apps at the HTTP edge: their own origins' proxy, and their WebSockets.
 * `index.ts` mounts each where app.ts and the process entry did.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { appsProxy, appsUpgrade } from '../../apps/proxy.js';
import type { AppEdge } from '../../main.js';
import { LegacyApps } from '../apps.js';
import { LegacyPlugins } from '../plugins.js';

/**
 * Mini apps' own origins first: a request under APPS_HOST is served
 * by the proxy alone and never reaches the routes, client or cookies here.
 */
export function mountAppsProxy(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    if (!edge) {
        return;
    }
    const apps = Context.get(edge.services, LegacyApps);
    if (apps.enabled) {
        app.use('*', appsProxy(apps, Context.get(edge.services, LegacyPlugins)));
    }
}

/** WebSockets to mini apps' origins: true when the request was one. */
export function appsSockets(edge: AppEdge) {
    return appsUpgrade(Context.get(edge.services, LegacyApps));
}

/** Mini apps' steps, as index.ts mounts them: their proxy and their WebSocket upgrades. */
export const appsRoutes = { proxy: mountAppsProxy, sockets: appsSockets };
