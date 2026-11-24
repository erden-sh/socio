import type { PluginManifest } from '@socio/shared/plugins/plugins';

import { calendarTools } from './tools.js';

/**
 * The calendar (CB-254): events a team keeps in Socio, such as venue
 * bookings copied from Notion by an agent. Bundled: it runs inside Socio,
 * with no service, Docker or apps host, so an admin enables it by
 * installing it from Plugins. Offered on every instance; installed on none
 * until an admin does.
 */
export const calendarManifest: PluginManifest = {
    id: 'calendar',
    name: 'Calendar',
    version: '1.0.0',
    author: 'Socio',
    description:
        'A shared calendar of events, with week, month and agenda views, tools for agents and socios to add and sync events, and private subscription links.',
    entry: { path: '/' },
    display: 'embed',
    permissions: ['calendar:read', 'calendar:write'],
    audience: 'members',
    mcp: {
        tools: calendarTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            scope: tool.permission,
        })),
    },
    config: {
        timeZone: {
            description:
                'The calendar’s time zone, an IANA name such as America/New_York. Empty: the workspace’s (Operations).',
            default: '',
        },
        writers: {
            description: 'Who may add events: everyone (everyone who can open the calendar) or admins.',
            type: 'enum',
            options: ['everyone', 'admins'],
            default: 'everyone',
        },
        editing: {
            description:
                'Who may change and delete events: own (the person who created it, and admins) or everyone (everyone who may add events).',
            type: 'enum',
            options: ['own', 'everyone'],
            default: 'own',
        },
    },
};
