import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { roomDenialStatus } from '@socio/foundation/rooms/denial-status';
import { ROOM_NOTIFY_LEVELS, type RoomNotifySetting, type RoomPresenceView } from '@socio/shared/rooms/room-notices';
import { ROOM_DENIAL_MESSAGES } from '@socio/shared/rooms/rooms';

import type { RoomsPlatform } from './services.js';

const level = z.object({ level: z.enum(ROOM_NOTIFY_LEVELS) }).strict();

/**
 * A member's own notifications and the room's presence (CB-216):
 *
 * - `GET`/`PUT /rooms/:id/notifications`: what of the room reaches them
 *   (`all`, `mentions`, `mute`); theirs alone to read and set.
 * - `GET /rooms/:id/presence`: who else of the room is looking at it now.
 *
 * A member may, as they may read the room: also when it is archived or
 * Rooms are off. Anyone else finds nothing, as for the room itself, so
 * neither who is in a room nor who looks at it can be probed.
 */
export function roomNoticeRoutes(platform: RoomsPlatform) {
    const app = new Hono<AppEnv>();
    const member = (c: Context<AppEnv>) => {
        const userId = c.get('user').id;
        const id = c.req.param('id') ?? '';
        const { thread, decision } = platform.workspace.access(userId, id, 'read');
        if (thread?.kind === 'room' && decision.allowed) {
            return { userId, id };
        }
        const reason = decision.allowed ? 'not_found' : decision.reason;
        return c.json({ error: ROOM_DENIAL_MESSAGES[reason], code: reason }, roomDenialStatus(reason));
    };
    app.get('/rooms/:id/notifications', async (c) => {
        const place = member(c);
        if (place instanceof Response) {
            return place;
        }
        return c.json({
            level: await platform.roomNotices.level(place.id, place.userId),
        } satisfies RoomNotifySetting);
    });
    app.put('/rooms/:id/notifications', async (c) => {
        const place = member(c);
        if (place instanceof Response) {
            return place;
        }
        const body = level.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json({ error: 'Choose everything, mentions or muted.', code: 'invalid' }, 400);
        }
        await platform.roomNotices.setLevel(place.id, place.userId, body.data.level);
        return c.json({ level: body.data.level } satisfies RoomNotifySetting);
    });
    app.get('/rooms/:id/presence', async (c) => {
        const place = member(c);
        if (place instanceof Response) {
            return place;
        }
        return c.json((await platform.roomNotices.presence(place.id, place.userId)) satisfies RoomPresenceView);
    });
    return app;
}
