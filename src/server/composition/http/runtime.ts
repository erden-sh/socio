/** The process runtime at the HTTP edge: draining, and the health check. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import type { LeaderLease } from '../../runtime/background.js';
import { drainingResponse, refusedWhileDraining } from '../../runtime/shutdown.js';
import { releaseData } from '../../updates/releases.js';
import { AppStatus } from '../app/status.js';
import { Ports } from '../ports.js';

/**
 * Draining for a restart (CB-108): new long-running work is refused with
 * 503, `draining` and Retry-After, which the app retries once the next
 * server is up; everything else is served as usual.
 */
export function mountDraining(app: Hono<AppEnv>, edge: AppEdge) {
    // Set by the drain (`LeaderWork.drain`), read at each request.
    const { draining: drainingPort } = Context.get(edge.services, Ports);
    app.use('/api/*', async function draining(c, next) {
        if (drainingPort.get() && refusedWhileDraining(c.req.method, c.req.path)) {
            return drainingResponse();
        }
        await next();
    });
}

/**
 * Liveness for container health checks; reveals nothing but readiness and
 * the release running (CB-165), which a deploy checks against its tag.
 */
export function mountHealth(app: Hono<AppEnv>, edge: AppEdge, leader: LeaderLease) {
    const status = Context.get(edge.services, AppStatus);
    app.get('/healthz', async (c) =>
        c.json({
            ...(await status.health()),
            version: releaseData().version,
            // CB-108: whether this task leads (a deploy checks the handover).
            leader: leader.state,
        }),
    );
}

/** The runtime's steps, as index.ts mounts them: draining and the health check. */
export const runtimeRoutes = { draining: mountDraining, health: mountHealth };
