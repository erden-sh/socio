import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { isTabId } from '@socio/shared/notifications/presence';

import { allowedEndpoint } from './push.js';
import type { NotificationService } from './service.js';

/**
 * A short name for a browser from its User-Agent ("Edge on Windows"),
 * shown in the person's own list of devices; "app" when it runs as the
 * installed app.
 */
export function deviceLabel(userAgent: string | undefined, installed: boolean) {
    const ua = userAgent ?? '';
    const browser = /Edg\//.test(ua)
        ? 'Edge'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
    const os = /iPhone/.test(ua)
        ? 'iPhone'
        : /iPad/.test(ua)
          ? 'iPad'
          : /Android/.test(ua)
            ? 'Android'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Mac OS X/.test(ua)
                ? 'macOS'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : 'a device';
    return installed ? `Socio app on ${os}` : `${browser} on ${os}`;
}

const base64url = z
    .string()
    .min(16)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+=*$/);

/**
 * `/api/notifications` (CB-114): a person's own channels, push
 * subscriptions, test, presence beacon and in-app notices. Signed-in
 * people only: data tokens and service keys never reach these.
 */
export function notificationRoutes(service: NotificationService) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app for notifications.' }, 403);
        }
        await next();
    };
    app.use('/notifications', signedIn);
    app.use('/notifications/*', signedIn);

    app.get('/notifications/channels', async (c) =>
        c.json({
            channels: await service.views(c.get('user').id),
            pushKey: await service.push.publicKey(),
        }),
    );
    app.post('/notifications/push/subscriptions', async (c) => {
        const parsed = z
            .object({
                endpoint: z.string().url().max(2000),
                keys: z.object({ p256dh: base64url, auth: base64url }),
                installed: z.boolean().optional(),
            })
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'That is not a push subscription.' }, 400);
        }
        if (!allowedEndpoint(parsed.data.endpoint, service.push.settings)) {
            return c.json({ error: 'This browser’s push service is not one Socio sends to.' }, 400);
        }
        // The service worker's renewal can't tell the installed app from the
        // browser: it keeps the label the device had.
        const known =
            parsed.data.installed === undefined ? await service.push.byEndpoint(parsed.data.endpoint) : undefined;
        const row = await service.push.subscribe(c.get('user').id, {
            endpoint: parsed.data.endpoint,
            p256dh: parsed.data.keys.p256dh,
            auth: parsed.data.keys.auth,
            device:
                known?.userId === c.get('user').id
                    ? known.device
                    : deviceLabel(c.req.header('user-agent'), parsed.data.installed ?? false),
        });
        return c.json({ id: row.id, label: row.device }, 201);
    });
    app.delete('/notifications/push/subscriptions/:id', async (c) =>
        (await service.push.unsubscribe(c.get('user').id, c.req.param('id')))
            ? c.json({ ok: true })
            : c.json({ error: 'Not found.' }, 404),
    );
    app.post('/notifications/test', async (c) => {
        const channels = await service.test(c.get('user').id);
        return c.json({ channels });
    });
    // `sendBeacon` when a tab is hidden or closed (presence.ts).
    app.post('/notifications/away', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            tab?: unknown;
        } | null;
        if (isTabId(body?.tab)) {
            service.presence.away(c.get('user').id, body.tab);
        }
        return c.body(null, 204);
    });
    app.post('/notifications/in-app/seen', async (c) => {
        const parsed = z
            .object({ ids: z.array(z.string().max(64)).max(20) })
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Invalid notices.' }, 400);
        }
        await service.seenInApp(c.get('user').id, parsed.data.ids);
        return c.json({ ok: true });
    });
    return app;
}
