import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { ROOM_TOPIC_COMMAND, type RoomTopicCode } from '@socio/shared/rooms/room-telegram';

import { RoomError } from './contract.js';
import type { RoomsPlatform } from './services.js';

const confirmed = z.object({ confirmAudience: z.boolean() }).strict();

/**
 * A room's Telegram topic (CB-214): its members read whether
 * it has one; its admins get a one-time code to post in a forum topic
 * (which binds it), see who was not answered there and unlink it. A
 * legacy team topic's reader gets a code that makes it a room. Every
 * answer is by the one rule: a room or topic the person can't see is a
 * 404, as another person's chat is.
 */
export function roomTopicRoutes(platform: RoomsPlatform) {
    const app = new Hono<AppEnv>();
    const topics = platform.roomTopics;
    const bot = () => {
        const telegram = platform.telegram;
        return {
            available: !!telegram?.username && telegram.status === 'online',
            username: telegram?.username ?? null,
        };
    };
    const refused = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof RoomError) {
            return c.json({ error: error.message, code: error.reason }, error.status as 400);
        }
        throw error;
    };
    /** A code, with what to post in the topic, while the bot is online. */
    const code = async (
        c: Context<AppEnv>,
        issue: (confirmAudience: boolean) => Promise<{
            code: string;
            expiresAt: number;
        }>,
    ) => {
        const parsed = confirmed.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'That request doesn’t fit.', code: 'invalid' }, 400);
        }
        const { available, username } = bot();
        try {
            const issued = await issue(parsed.data.confirmAudience);
            if (!available || !username) {
                return c.json({ error: 'Telegram is not connected on this server.' }, 503);
            }
            const body: RoomTopicCode = {
                ...issued,
                bot: username,
                command: `/${ROOM_TOPIC_COMMAND}@${username} ${issued.code}`,
            };
            return c.json(body, 201);
        } catch (error) {
            return refused(c, error);
        }
    };
    const user = (c: Context<AppEnv>) => c.get('user').id;

    // A legacy team topic, made a room by someone who reads it.
    app.post('/rooms/telegram/topics/:id/code', (c) =>
        code(c, (confirmAudience) => topics.convertCode(c.req.param('id'), user(c), confirmAudience)),
    );
    app.get('/rooms/:id/telegram', async (c) => {
        try {
            return c.json(await topics.view(c.req.param('id'), user(c), bot()));
        } catch (error) {
            return refused(c, error);
        }
    });
    app.post('/rooms/:id/telegram/code', (c) =>
        code(c, (confirmAudience) => topics.bindCode(c.req.param('id'), user(c), confirmAudience)),
    );
    app.delete('/rooms/:id/telegram', async (c) => {
        try {
            const unbound = await topics.unbind(c.req.param('id'), user(c));
            return c.json({ unbound });
        } catch (error) {
            return refused(c, error);
        }
    });
    return app;
}
