import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';

import type { CloudShape, CloudStatus } from './contract.js';

/**
 * `GET /api/cloud`, admins only (403 for members): the Cloud connection
 * card's view, the connection's status as `Cloud.status()` reads it from
 * the sealed record. It names the deployment and what the issuer lets it
 * do; it never holds the key, an access token or the enrollment token.
 */
export function cloudRoutes(cloud: Pick<CloudShape, 'status'>) {
    const app = new Hono<AppEnv>();
    app.use('/cloud', requireAdmin);
    app.get('/cloud', (c) => {
        const status = cloud.status();
        // Field by field, so nothing added to the status later leaks by default.
        const view: CloudStatus = {
            connection: status.connection,
            issuer: status.issuer,
            ...(status.deploymentId ? { deploymentId: status.deploymentId } : {}),
            ...(status.deploymentMode ? { deploymentMode: status.deploymentMode } : {}),
            scopes: [...status.scopes],
            ...(status.enrolledAt ? { enrolledAt: status.enrolledAt } : {}),
            ...(status.lastSyncAt ? { lastSyncAt: status.lastSyncAt } : {}),
        };
        return c.json(view);
    });
    return app;
}
