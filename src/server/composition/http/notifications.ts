/** Notifications at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { LegacyNotifications } from '../notifications.js';

/**
 * A notification's image (CB-114): behind its random token for 7 days,
 * without a session (a notification's image request may carry none of
 * the SameSite=Strict cookies). Outside /api, before the pages.
 */
export function mountNotificationImages(app: Hono<AppEnv>, edge: AppEdge) {
    const notifications = Context.get(edge.services, LegacyNotifications);
    app.get('/notification-images/:token', async (c) => {
        const image = await notifications.image(c.req.param('token'));
        if (!image) {
            c.header('Cache-Control', 'no-store');
            return c.text('Not found.', 404);
        }
        return c.body(new Uint8Array(image.bytes), 200, {
            'Content-Type': image.mediaType,
            'Cache-Control': 'private, max-age=86400',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
        });
    });
}

/** Notifications' step, as index.ts mounts it: their images. */
export const notificationsRoutes = { images: mountNotificationImages };
