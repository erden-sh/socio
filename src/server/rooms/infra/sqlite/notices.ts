import { and, asc, eq, lt, min, notInArray, sql } from 'drizzle-orm';
import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, id, ms, str } from '@socio/data/columns.sqlite';
import type { SqliteData } from '@socio/data/open';
import { ROOM_NOTIFY_LEVELS, type RoomNotifyLevel } from '@socio/shared/rooms/room-notices';

import type { StoredRoomMention } from '../../contract.js';
import type { RoomNoticeRepository } from '../../domain/notices.js';

/**
 * Rooms' notification tables (CB-216, rooms migration 3), as
 * `rooms/migrations.ts` makes them: the typed mirror the repository
 * queries; tests/rooms-migration.test.ts holds them to the migration.
 */
export const roomNotifySettings = sqliteTable(
    'room_notify_settings',
    {
        roomId: id().notNull(),
        userId: str().notNull(),
        level: enumText(ROOM_NOTIFY_LEVELS).notNull(),
        updatedAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.roomId, table.userId] })],
);

export const roomMentions = sqliteTable(
    'room_mentions',
    {
        roomId: id().notNull(),
        messageId: str().notNull(),
        userId: str().notNull(),
        authorId: str().notNull(),
        label: str().notNull(),
        status: enumText(['pending', 'confirmed']).notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.roomId, table.messageId, table.userId] })],
);

export const roomNotices = sqliteTable(
    'room_notices',
    {
        userId: str().notNull(),
        cause: str().notNull(),
        roomId: id().notNull(),
        createdAt: ms().notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.cause] })],
);

/** The notification tables, for the drift test. */
export const roomNoticeTables = [roomNotifySettings, roomMentions, roomNotices] as const;

class SqliteRoomNotices implements RoomNoticeRepository {
    constructor(private data: SqliteData) {}
    private get db() {
        return this.data.uow.executor();
    }
    private write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }

    async level(roomId: string, userId: string) {
        const row = await this.db
            .select({ level: roomNotifySettings.level })
            .from(roomNotifySettings)
            .where(and(eq(roomNotifySettings.roomId, roomId), eq(roomNotifySettings.userId, userId)))
            .get();
        return row?.level;
    }

    async levels(userId: string) {
        const rows = await this.db
            .select({
                roomId: roomNotifySettings.roomId,
                level: roomNotifySettings.level,
            })
            .from(roomNotifySettings)
            .where(eq(roomNotifySettings.userId, userId))
            .all();
        return new Map<string, RoomNotifyLevel>(rows.map((row) => [row.roomId, row.level]));
    }

    setLevel(roomId: string, userId: string, level: RoomNotifyLevel, now: number) {
        return this.write('set room notifications', async () => {
            // The same level again writes nothing, so it bumps no live update.
            await this.db
                .insert(roomNotifySettings)
                .values({ roomId, userId, level, updatedAt: now })
                .onConflictDoUpdate({
                    target: [roomNotifySettings.roomId, roomNotifySettings.userId],
                    set: { level, updatedAt: now },
                    setWhere: sql`${roomNotifySettings.level} IS NOT ${level}`,
                });
        });
    }

    replaceMentions(roomId: string, messageId: string, mentions: readonly StoredRoomMention[]) {
        return this.write('record room mentions', async () => {
            await this.db
                .delete(roomMentions)
                .where(
                    and(
                        eq(roomMentions.roomId, roomId),
                        eq(roomMentions.messageId, messageId),
                        eq(roomMentions.status, 'pending'),
                    ),
                );
            if (mentions.length) {
                await this.db
                    .insert(roomMentions)
                    .values(mentions.map((mention) => ({ ...mention })))
                    .onConflictDoNothing();
            }
        });
    }

    forgetMentions(roomId: string, messageId: string) {
        return this.write('forget room mentions', async () => {
            await this.db
                .delete(roomMentions)
                .where(
                    and(
                        eq(roomMentions.roomId, roomId),
                        eq(roomMentions.messageId, messageId),
                        eq(roomMentions.status, 'pending'),
                    ),
                );
        });
    }

    async pending(roomId: string): Promise<StoredRoomMention[]> {
        return this.db
            .select()
            .from(roomMentions)
            .where(and(eq(roomMentions.roomId, roomId), eq(roomMentions.status, 'pending')))
            .orderBy(asc(roomMentions.createdAt))
            .all();
    }

    async pendingRooms() {
        return this.db
            .select({
                roomId: roomMentions.roomId,
                oldest: sql<number>`${min(roomMentions.createdAt)}`,
            })
            .from(roomMentions)
            .where(eq(roomMentions.status, 'pending'))
            .groupBy(roomMentions.roomId)
            .all();
    }

    settle(roomId: string, messageId: string, keep: readonly string[]) {
        return this.write('settle room mentions', async () => {
            const ofMessage = and(
                eq(roomMentions.roomId, roomId),
                eq(roomMentions.messageId, messageId),
                eq(roomMentions.status, 'pending'),
            );
            await this.db
                .delete(roomMentions)
                .where(keep.length ? and(ofMessage, notInArray(roomMentions.userId, [...keep])) : ofMessage);
            if (keep.length) {
                await this.db.update(roomMentions).set({ status: 'confirmed' }).where(ofMessage);
            }
        });
    }

    async confirmed(roomId: string) {
        const rows = await this.db
            .select()
            .from(roomMentions)
            .where(and(eq(roomMentions.roomId, roomId), eq(roomMentions.status, 'confirmed')))
            .orderBy(asc(roomMentions.createdAt), asc(sql`rowid`))
            .all();
        const byMessage = new Map<string, StoredRoomMention[]>();
        for (const row of rows) {
            byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
        }
        return byMessage;
    }

    claim(userId: string, cause: string, roomId: string, now: number) {
        return this.write('claim room notice', async () => {
            const inserted = await this.db
                .insert(roomNotices)
                .values({ userId, cause, roomId, createdAt: now })
                .onConflictDoNothing()
                .returning({ cause: roomNotices.cause })
                .all();
            return inserted.length > 0;
        });
    }

    pruneClaims(before: number) {
        return this.write('prune room notices', async () => {
            await this.db.delete(roomNotices).where(lt(roomNotices.createdAt, before));
        });
    }
}

/** Rooms' notification repository on a migrated connection. */
export function sqliteRoomNotices(data: SqliteData): RoomNoticeRepository {
    return new SqliteRoomNotices(data);
}
