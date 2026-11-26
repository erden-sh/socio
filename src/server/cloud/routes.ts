import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';

import { ReplyReportsUnavailable, type CloudShape, type CloudStatus, type ReplyReportsShape } from './contract.js';

const sharingInput = z.object({ sharing: z.boolean() }).strict();

/**
 * `GET /api/cloud`, admins only (403 for members): the Cloud connection
 * card's view, the connection's status as `Cloud.status()` reads it from
 * the sealed record. It names the deployment and what the issuer lets it
 * do; it never holds the key, an access token or the enrollment token.
 *
 * `GET` and `PUT /api/cloud/reply-reports`, admins only too: the AI reply
 * reports' setting (CB-382, docs/specs/REPLY-REPORTS.md §6).
 */
export function cloudRoutes(
    cloud: Pick<CloudShape, 'status'>,
    reports?: Pick<ReplyReportsShape, 'admin' | 'setSharing'>,
) {
    const app = new Hono<AppEnv>();
    app.use('/cloud', requireAdmin);
    app.use('/cloud/*', requireAdmin);
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
    if (reports) {
        // AI reply reports' setting (CB-382): whether this server can share, whether it does, and the queue's counts.
        app.get('/cloud/reply-reports', (c) => c.json(reports.admin()));
        app.put('/cloud/reply-reports', async (c) => {
            const parsed = sharingInput.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Send { sharing: true } or { sharing: false }.' }, 400);
            }
            try {
                return c.json(await reports.setSharing(parsed.data.sharing, c.get('user').id));
            } catch (error) {
                if (error instanceof ReplyReportsUnavailable) {
                    return c.json(
                        {
                            error: 'Reply reports need a cloud connection that lets this server send them.',
                            code: 'unavailable',
                        },
                        409,
                    );
                }
                throw error;
            }
        });
    }
    return app;
}
