import type { SchemaSet } from '@socio/data/migrate';

/**
 * The calendar's events and its people's subscription feeds (CB-254). Not
 * part of the boot schema list: these tables appear when an admin installs
 * the plugin, and on later boots only while that install row is there.
 * Uninstalling keeps them, so a later install sees the same events.
 */
export const calendarSchema: SchemaSet = {
    id: 'calendar',
    migrations: [
        {
            version: 1,
            name: 'calendar events',
            phase: 'expand',
            compatible:
                'The unique indexes are on tables this migration creates, so no row an older build wrote can break them.',
            up: `CREATE TABLE calendar_events(id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','tentative','cancelled')), allDay INTEGER NOT NULL DEFAULT 0 CHECK(allDay IN (0,1)), timeZone TEXT NOT NULL, startAt INTEGER NOT NULL, endAt INTEGER NOT NULL, startLocal TEXT NOT NULL, endLocal TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', sourceId TEXT NOT NULL DEFAULT '', sourceUrl TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private')), createdBy TEXT NOT NULL, createdVia TEXT NOT NULL DEFAULT '', updatedBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, CHECK(endAt > startAt));
CREATE INDEX calendar_events_range ON calendar_events(startAt, endAt);
CREATE UNIQUE INDEX calendar_events_source ON calendar_events(source, sourceId) WHERE sourceId <> '';
CREATE TABLE calendar_feeds(hash TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsedAt INTEGER);
CREATE UNIQUE INDEX calendar_feeds_user ON calendar_feeds(userId);`,
        },
    ],
};
