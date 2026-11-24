import { Hono, type Context } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { CalendarEventInput, CalendarState } from '@socio/shared/calendar';
import type { User } from '@socio/shared/types';

import type { PluginContext } from '../bundle-types.js';
import { PluginToolError } from '../errors.js';

import { CalendarEvents } from './events.js';

/**
 * `/api/plugins/calendar/data`: the calendar page's routes, as the signed-in
 * person (the plugins routes already checked they are in its audience).
 * The same rules as the tools: `CalendarEvents`.
 */
export function calendarData(ctx: PluginContext) {
    const app = new Hono<AppEnv>();
    const events = new CalendarEvents(ctx);
    const fail = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof PluginToolError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    const body = async (c: Context<AppEnv>) => {
        const value = (await c.req.json().catch(() => null)) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new PluginToolError('Send a JSON object.');
        }
        return value as Record<string, unknown>;
    };
    // The plugins routes hand the signed-in person over as the request's
    // env (routes.ts); there is no other way in.
    const personOf = (c: Context<AppEnv>): User => {
        const user = (c.env as { user?: User } | undefined)?.user;
        if (!user) {
            throw new PluginToolError('Sign in to continue.', 403);
        }
        return user;
    };
    const number = (value: string | undefined) => {
        if (value === undefined || value === '') {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    };

    app.get('/state', async (c) => {
        try {
            const person = personOf(c);
            const listed = await events.list(person, {
                from: number(c.req.query('from')),
                to: number(c.req.query('to')),
                limit: 500,
            });
            const state: CalendarState = {
                events: listed.events,
                timeZone: listed.timeZone,
                canWrite: events.canWrite(person),
                feed: await events.feedState(person),
                now: Date.now(),
            };
            return c.json(state);
        } catch (error) {
            return fail(c, error);
        }
    });

    app.post('/events', async (c) => {
        try {
            const result = await events.create(personOf(c), (await body(c)) as unknown as CalendarEventInput);
            return c.json(result, result.outcome === 'created' ? 201 : 200);
        } catch (error) {
            return fail(c, error);
        }
    });

    app.patch('/events/:eventId', async (c) => {
        try {
            const patch = await body(c);
            return c.json(
                await events.update(personOf(c), { id: c.req.param('eventId') }, patch as Partial<CalendarEventInput>),
            );
        } catch (error) {
            return fail(c, error);
        }
    });

    app.delete('/events/:eventId', async (c) => {
        try {
            await events.remove(personOf(c), { id: c.req.param('eventId') });
            return c.json({ ok: true });
        } catch (error) {
            return fail(c, error);
        }
    });

    app.post('/feed', async (c) => {
        try {
            return c.json(await events.createFeed(personOf(c)));
        } catch (error) {
            return fail(c, error);
        }
    });

    app.delete('/feed', async (c) => {
        try {
            return c.json(await events.deleteFeed(personOf(c)));
        } catch (error) {
            return fail(c, error);
        }
    });

    return app;
}
