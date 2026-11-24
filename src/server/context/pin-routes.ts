import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { ROOM_PIN_ORIGINS } from '@socio/shared/rooms/room-pins';

import { PinError, type RoomPins } from './pins.js';

const pinned = z
    .object({
        text: z.unknown(),
        origin: z.enum(ROOM_PIN_ORIGINS).optional(),
    })
    .strict();
const edited = z.object({ text: z.unknown(), baseVersion: z.unknown() }).strict();

/**
 * A room's pinned facts and notes (CB-217), under `/api/rooms/:id`: its members
 * read them; who may send there pins (a room admin) or proposes (anyone else);
 * room admins approve and reject; a pin's pinner and room admins edit and unpin
 * it. A room the person can't see is a 404, as for every room route.
 */
export function pinRoutes(pins: RoomPins) {
    const app = new Hono<AppEnv>();
    const user = (c: Context<AppEnv>) => c.get('user').id;
    const attempt = async (c: Context<AppEnv>, work: () => Promise<unknown>) => {
        try {
            return c.json(await work());
        } catch (error) {
            if (error instanceof PinError) {
                return c.json({ error: error.message, code: error.reason }, error.status);
            }
            throw error;
        }
    };
    // A body that doesn't fit is passed on as nothing: the service checks
    // the person's access to the room before what they ask (CB-213).
    const body = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        return parsed.success ? parsed.data : undefined;
    };

    app.get('/rooms/:id/pins', (c) => attempt(c, () => pins.state(c.req.param('id'), user(c))));
    app.post('/rooms/:id/pins', async (c) => {
        const data = await body(c, pinned);
        return attempt(c, () => pins.pin(c.req.param('id'), user(c), data ?? { text: undefined }));
    });
    app.get('/rooms/:id/pins/:pinId/history', (c) =>
        attempt(c, () => pins.history(c.req.param('id'), user(c), c.req.param('pinId'))),
    );
    app.put('/rooms/:id/pins/:pinId', async (c) => {
        const data = await body(c, edited);
        return attempt(c, () =>
            pins.edit(
                c.req.param('id'),
                user(c),
                c.req.param('pinId'),
                data ?? { text: undefined, baseVersion: undefined },
            ),
        );
    });
    app.delete('/rooms/:id/pins/:pinId', (c) => {
        const base = c.req.query('baseVersion');
        const baseVersion = base === undefined ? undefined : Number(base);
        return attempt(c, () => pins.unpin(c.req.param('id'), user(c), c.req.param('pinId'), baseVersion));
    });
    for (const action of ['approve', 'reject', 'withdraw'] as const) {
        app.post(`/rooms/:id/pin-proposals/:proposalId/${action}`, (c) =>
            attempt(c, () => pins[action](c.req.param('id'), user(c), c.req.param('proposalId'))),
        );
    }
    return app;
}
