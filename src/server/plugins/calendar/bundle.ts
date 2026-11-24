import type { BundledPlugin } from '../bundle-types.js';

import { calendarData } from './data.js';
import { CalendarEvents } from './events.js';
import { icsCalendar } from './ics.js';
import { calendarManifest } from './manifest.js';
import { calendarTools } from './tools.js';

/**
 * The calendar, bundled: its routes, tools and feed run inside Socio. It
 * is offered only where `PLUGIN_CATALOGS` lists `bundled:calendar`
 * (CB-371), and runs on none until an admin installs it from Plugins.
 */
export const calendarBundle: BundledPlugin = {
    manifest: calendarManifest,
    data: (ctx) => calendarData(ctx),
    tools: calendarTools,
    feed: async (ctx, token) => {
        const found = await new CalendarEvents(ctx).feedEvents(token);
        if (!found) {
            return undefined;
        }
        let host = 'socio';
        try {
            host = new URL(ctx.origin).hostname || host;
        } catch {
            /* The default. */
        }
        return new Response(
            icsCalendar(found.rows, {
                name: calendarManifest.name,
                host,
                now: Date.now(),
            }),
            {
                headers: {
                    'content-type': 'text/calendar; charset=utf-8',
                    'content-disposition': 'inline; filename="calendar.ics"',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    'referrer-policy': 'no-referrer',
                },
            },
        );
    },
};
