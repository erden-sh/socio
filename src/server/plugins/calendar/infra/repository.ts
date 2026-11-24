import { and, asc, eq, gt, lt, or, sql } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';
import type { EventStatus } from '@socio/shared/calendar';

import { calendarEvents, calendarFeeds } from './schema.js';

export type EventRow = typeof calendarEvents.$inferSelect;
export type EventInsert = typeof calendarEvents.$inferInsert;
export type EventPatch = Partial<Omit<EventInsert, 'id' | 'createdBy' | 'createdVia' | 'createdAt'>>;

export interface EventFilter {
    /** Events that overlap [from, to). */
    from: number;
    to: number;
    /** Only events this person may see: shared ones and their own private ones. */
    viewer: string;
    location?: string;
    status?: EventStatus;
    source?: string;
    sourceId?: string;
    createdBy?: string;
    query?: string;
    limit: number;
}

/** `%` and `_` match themselves. */
const likeText = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** The calendar's rows. Writes go through the unit of work. */
export class SqliteCalendar {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    private write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }

    list(filter: EventFilter) {
        const where = and(
            lt(calendarEvents.startAt, filter.to),
            gt(calendarEvents.endAt, filter.from),
            or(eq(calendarEvents.visibility, 'workspace'), eq(calendarEvents.createdBy, filter.viewer)),
            filter.location
                ? sql`lower(${calendarEvents.location}) LIKE ${likeText(filter.location)} ESCAPE '\\'`
                : undefined,
            filter.status ? eq(calendarEvents.status, filter.status) : undefined,
            filter.source ? eq(calendarEvents.source, filter.source) : undefined,
            filter.sourceId ? eq(calendarEvents.sourceId, filter.sourceId) : undefined,
            filter.createdBy ? eq(calendarEvents.createdBy, filter.createdBy) : undefined,
            filter.query
                ? or(
                      sql`lower(${calendarEvents.title}) LIKE ${likeText(filter.query)} ESCAPE '\\'`,
                      sql`lower(${calendarEvents.description}) LIKE ${likeText(filter.query)} ESCAPE '\\'`,
                  )
                : undefined,
        );
        return this.db
            .select()
            .from(calendarEvents)
            .where(where)
            .orderBy(asc(calendarEvents.startAt), asc(calendarEvents.id))
            .limit(filter.limit)
            .all();
    }

    get(id: string) {
        return this.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();
    }

    bySource(source: string, sourceId: string) {
        return this.db
            .select()
            .from(calendarEvents)
            .where(and(eq(calendarEvents.source, source), eq(calendarEvents.sourceId, sourceId)))
            .get();
    }

    /**
     * Inserts `row`, unless it names a source id an event already has: then
     * `matched` decides, in the same write, what to change on that event
     * (undefined: nothing). Two syncs racing on one page cannot both insert;
     * the unique index stops the second, in this process or another.
     */
    createOrMatch(
        row: EventInsert,
        matched: (existing: EventRow) => EventPatch | undefined,
    ): Promise<{ outcome: 'created' | 'updated' | 'unchanged'; id: string }> {
        return this.write('create calendar event', async () => {
            const existing = row.sourceId ? await this.bySource(row.source ?? '', row.sourceId) : undefined;
            if (!existing) {
                await this.db.insert(calendarEvents).values(row);
                return { outcome: 'created' as const, id: row.id };
            }
            const patch = matched(existing);
            if (!patch || !Object.keys(patch).length) {
                return { outcome: 'unchanged' as const, id: existing.id };
            }
            await this.db.update(calendarEvents).set(patch).where(eq(calendarEvents.id, existing.id));
            return { outcome: 'updated' as const, id: existing.id };
        });
    }

    update(id: string, patch: EventPatch) {
        return this.write('update calendar event', async () => {
            await this.db.update(calendarEvents).set(patch).where(eq(calendarEvents.id, id));
        });
    }

    delete(id: string) {
        return this.write('delete calendar event', async () => {
            await this.db.delete(calendarEvents).where(eq(calendarEvents.id, id));
        });
    }

    feedOf(userId: string) {
        return this.db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, userId)).get();
    }

    feedByHash(hash: string) {
        return this.db.select().from(calendarFeeds).where(eq(calendarFeeds.hash, hash)).get();
    }

    /** One feed per person: a new one replaces the old, whose link stops. */
    replaceFeed(userId: string, hash: string, now: number) {
        return this.write('replace calendar feed', async () => {
            await this.db.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
            await this.db.insert(calendarFeeds).values({ hash, userId, createdAt: now, lastUsedAt: null });
        });
    }

    deleteFeed(userId: string) {
        return this.write('delete calendar feed', async () => {
            await this.db.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
        });
    }

    touchFeed(hash: string, now: number) {
        return this.write('calendar feed read', async () => {
            await this.db.update(calendarFeeds).set({ lastUsedAt: now }).where(eq(calendarFeeds.hash, hash));
        });
    }
}
