import { sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, ms, str } from '@socio/data/columns.sqlite';
import type { EventStatus, EventVisibility } from '@socio/shared/calendar';

/** The typed mirror of `calendar/migrations.ts`. */
export const calendarEvents = sqliteTable('calendar_events', {
    id: id().primaryKey(),
    title: str().notNull(),
    description: str().notNull().default(''),
    location: str().notNull().default(''),
    status: enumText(['confirmed', 'tentative', 'cancelled']).notNull().default('confirmed').$type<EventStatus>(),
    allDay: flag().notNull().default(false),
    timeZone: str().notNull(),
    startAt: ms().notNull(),
    endAt: ms().notNull(),
    startLocal: str().notNull(),
    endLocal: str().notNull(),
    source: str().notNull().default(''),
    sourceId: str().notNull().default(''),
    sourceUrl: str().notNull().default(''),
    visibility: enumText(['workspace', 'private']).notNull().default('workspace').$type<EventVisibility>(),
    createdBy: str().notNull(),
    createdVia: str().notNull().default(''),
    updatedBy: str().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

/** One subscription feed per person, by the hash of its token. */
export const calendarFeeds = sqliteTable('calendar_feeds', {
    hash: str().primaryKey(),
    userId: str().notNull(),
    createdAt: ms().notNull(),
    lastUsedAt: ms(),
});
