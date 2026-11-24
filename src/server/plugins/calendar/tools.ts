import { z } from 'zod';

import {
    EVENT_LIMITS,
    EVENT_STATUSES,
    EVENT_VISIBILITIES,
    MAX_LIST,
    type CalendarEventInput,
    type EventStatus,
} from '@socio/shared/calendar';

import type { PluginToolDefinition } from '../bundle-types.js';

import { CalendarEvents, type EventRef } from './events.js';

const TIMES =
    'Times: YYYY-MM-DDTHH:mm is wall-clock time in timeZone (default: the calendar’s zone, which every answer names); an ISO time with Z or an offset is that instant. An all-day event takes dates (YYYY-MM-DD) and allDay true; its end is its last day.';
const DEDUPE =
    'When copying from another system, pass source (such as notion) and sourceId (that system’s id, such as the Notion page id): an event with the same source and sourceId is updated instead of duplicated.';

const ref = {
    id: z.string().trim().max(100).optional().describe('The event’s id.'),
    source: z
        .string()
        .trim()
        .max(EVENT_LIMITS.source)
        .optional()
        .describe('With sourceId, instead of id: the system it was copied from.'),
    sourceId: z
        .string()
        .trim()
        .max(EVENT_LIMITS.sourceId)
        .optional()
        .describe('With source, instead of id: its id there.'),
};

const fields = {
    title: z.string().max(EVENT_LIMITS.title),
    start: z.string().max(40).describe('YYYY-MM-DDTHH:mm, an ISO time, or YYYY-MM-DD when all-day.'),
    end: z
        .string()
        .max(40)
        .optional()
        .describe('Default: an hour after start, or the same day when all-day (inclusive).'),
    allDay: z.boolean().optional(),
    timeZone: z.string().max(64).optional().describe('IANA zone, such as America/New_York.'),
    location: z.string().max(EVENT_LIMITS.location).optional(),
    description: z.string().max(EVENT_LIMITS.description).optional(),
    status: z.enum(EVENT_STATUSES).optional().describe('confirmed (default), tentative (a hold) or cancelled.'),
    visibility: z
        .enum(EVENT_VISIBILITIES)
        .optional()
        .describe('workspace (default): everyone who can open the calendar; private: only you.'),
    source: z.string().max(EVENT_LIMITS.source).optional(),
    sourceId: z.string().max(EVENT_LIMITS.sourceId).optional(),
    sourceUrl: z
        .string()
        .max(EVENT_LIMITS.sourceUrl)
        .optional()
        .describe('https link to the original, such as the Notion page.'),
};

const READ = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false };

/**
 * The calendar's tools, for connected agents (`/mcp`, with the calendar's
 * scopes) and in-app socios alike. Each acts as its person, with that
 * person's permissions on the calendar.
 */
export const calendarTools: PluginToolDefinition[] = [
    {
        name: 'list_events',
        description: `List calendar events that overlap a range (default: today and the next 6 days), optionally by location, status, source and sourceId, text, or only your own. from and to are dates (to is inclusive), wall-clock times in the calendar’s zone, or ISO times. Use it before a sync to see what is already there.`,
        permission: 'calendar:read',
        input: {
            from: z.string().max(40).optional(),
            to: z.string().max(40).optional(),
            location: z.string().max(EVENT_LIMITS.location).optional(),
            status: z.enum(EVENT_STATUSES).optional(),
            source: z.string().max(EVENT_LIMITS.source).optional(),
            sourceId: z.string().max(EVENT_LIMITS.sourceId).optional(),
            query: z.string().max(200).optional().describe('Text in the title or description.'),
            mine: z.boolean().optional().describe('Only events you created.'),
            limit: z.number().int().min(1).max(MAX_LIST).optional(),
        },
        annotations: READ,
        run: async (args, call, ctx) =>
            new CalendarEvents(ctx).list(call.person, {
                ...(args as {
                    from?: string;
                    to?: string;
                    location?: string;
                    source?: string;
                    sourceId?: string;
                    query?: string;
                    mine?: boolean;
                    limit?: number;
                }),
                ...(args.status ? { status: args.status as EventStatus } : {}),
            }),
    },
    {
        name: 'create_event',
        description: `Add an event to the calendar. ${TIMES} ${DEDUPE} Answers with the event and outcome: created, updated (it was already there) or unchanged.`,
        permission: 'calendar:write',
        input: fields,
        annotations: WRITE,
        run: async (args, call, ctx) =>
            new CalendarEvents(ctx).create(call.person, args as unknown as CalendarEventInput, call.via),
    },
    {
        name: 'update_event',
        description: `Change an event, named by id or by source and sourceId. Send only what changes. A new start without an end keeps its length. ${TIMES} You can change events you created; admins can change shared ones.`,
        permission: 'calendar:write',
        input: {
            ...ref,
            title: fields.title.optional(),
            start: fields.start.optional(),
            end: fields.end,
            allDay: fields.allDay,
            timeZone: fields.timeZone,
            location: fields.location,
            description: fields.description,
            status: fields.status,
            visibility: fields.visibility,
            sourceUrl: fields.sourceUrl,
        },
        annotations: WRITE,
        run: async (args, call, ctx) => {
            const { id, source, sourceId, ...patch } = args as EventRef & Partial<CalendarEventInput>;
            return new CalendarEvents(ctx).update(call.person, { id, source, sourceId }, patch);
        },
    },
    {
        name: 'delete_event',
        description:
            'Delete an event, named by id or by source and sourceId. To keep it visible as called off, set its status to cancelled with update_event instead.',
        permission: 'calendar:write',
        input: ref,
        annotations: { readOnlyHint: false, destructiveHint: true },
        run: async (args, call, ctx) => new CalendarEvents(ctx).remove(call.person, args as EventRef),
    },
];
