import { and, eq, isNull, sql } from 'drizzle-orm';

import type { TimeZoneNotePlace, TimeZoneNoteRepository } from '../../contract.js';

import { SqliteRepository } from './base.js';
import { timeZoneNotes } from './schema.js';

const SHOWN = {
    chat: timeZoneNotes.chatShownAt,
    page: timeZoneNotes.pageShownAt,
} as const;

/** The notes of a detected time zone that moved (CB-176), on the shared SQLite connection. */
export class SqliteTimeZoneNotes extends SqliteRepository implements TimeZoneNoteRepository {
    /** Every web turn asks for its chat's note: prepared once. */
    private pendingQueries = (() => {
        const db = this.data.uow.executor();
        const pending = (place: TimeZoneNotePlace) =>
            db
                .select({ zone: timeZoneNotes.zone })
                .from(timeZoneNotes)
                .where(and(eq(timeZoneNotes.userId, sql.placeholder('userId')), isNull(SHOWN[place])))
                .prepare();
        return { chat: pending('chat'), page: pending('page') };
    })();

    add(userId: string, zone: string, now = Date.now()) {
        return this.write('note time zone', async () => {
            await this.db
                .insert(timeZoneNotes)
                .values({ userId, zone, createdAt: now })
                .onConflictDoUpdate({
                    target: timeZoneNotes.userId,
                    set: { zone, createdAt: now, chatShownAt: null, pageShownAt: null },
                });
        });
    }

    async pending(userId: string, place: TimeZoneNotePlace) {
        this.data.uow.executor();
        return (await this.pendingQueries[place].get({ userId }))?.zone ?? null;
    }

    shown(userId: string, place: TimeZoneNotePlace, zone: string, now = Date.now()) {
        return this.write('see time zone note', async () => {
            const { changes } = await this.db
                .update(timeZoneNotes)
                .set(place === 'chat' ? { chatShownAt: now } : { pageShownAt: now })
                .where(and(eq(timeZoneNotes.userId, userId), eq(timeZoneNotes.zone, zone), isNull(SHOWN[place])))
                .run();
            return Number(changes) > 0;
        });
    }
}
