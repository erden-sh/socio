import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type {
    TelegramRoomCode,
    TelegramRoomCodeRepository,
    TelegramTopicSender,
    TelegramTopicSenderRepository,
} from '../../contract.js';

import { SqliteRepository } from './base.js';
import { telegramRoomCodes, telegramTopicSenders } from './schema.js';

/** Codes that bind a forum topic to a room (CB-214), stored hashed. */
export class SqliteTelegramRoomCodes extends SqliteRepository implements TelegramRoomCodeRepository {
    issue(hash: string, code: Omit<TelegramRoomCode, 'usedAt'> & { createdAt: number }, expiredBefore: number) {
        return this.write('create Telegram room code', async () => {
            await this.db
                .delete(telegramRoomCodes)
                .where(
                    or(
                        and(
                            eq(telegramRoomCodes.userId, code.userId),
                            eq(telegramRoomCodes.purpose, code.purpose),
                            eq(telegramRoomCodes.target, code.target),
                        ),
                        lte(telegramRoomCodes.expiresAt, expiredBefore),
                    ),
                );
            await this.db.insert(telegramRoomCodes).values({ hash, ...code, usedAt: null });
        });
    }

    async get(hash: string) {
        return this.db
            .select({
                userId: telegramRoomCodes.userId,
                purpose: telegramRoomCodes.purpose,
                target: telegramRoomCodes.target,
                expiresAt: telegramRoomCodes.expiresAt,
                usedAt: telegramRoomCodes.usedAt,
            })
            .from(telegramRoomCodes)
            .where(eq(telegramRoomCodes.hash, hash))
            .get();
    }

    claim(hash: string, now: number) {
        return this.write('redeem Telegram room code', async () => {
            const claimed = await this.db
                .update(telegramRoomCodes)
                .set({ usedAt: now })
                .where(
                    and(
                        eq(telegramRoomCodes.hash, hash),
                        // One redemption each.
                        isNull(telegramRoomCodes.usedAt),
                    ),
                )
                .returning({ hash: telegramRoomCodes.hash });
            return claimed.length > 0;
        });
    }
}

/** Who addressed the socio in a bound topic and was not answered (CB-214). */
export class SqliteTelegramTopicSenders extends SqliteRepository implements TelegramTopicSenderRepository {
    record(
        sender: Pick<TelegramTopicSender, 'sourceKey' | 'roomId' | 'telegramUserId' | 'reason' | 'username'>,
        now: number,
    ) {
        return this.write('record Telegram topic sender', async () => {
            const [row] = await this.db
                .insert(telegramTopicSenders)
                .values({
                    ...sender,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    seen: 1,
                    noticedAt: now,
                })
                .onConflictDoUpdate({
                    target: [
                        telegramTopicSenders.sourceKey,
                        telegramTopicSenders.roomId,
                        telegramTopicSenders.telegramUserId,
                        telegramTopicSenders.reason,
                    ],
                    set: {
                        lastSeenAt: now,
                        seen: sql`${telegramTopicSenders.seen} + 1`,
                        // The latest @username Telegram gave, if it gave one.
                        ...(sender.username ? { username: sender.username } : {}),
                    },
                })
                .returning({ seen: telegramTopicSenders.seen });
            return row?.seen === 1;
        });
    }

    async forRoom(roomId: string, limit: number) {
        return this.db
            .select()
            .from(telegramTopicSenders)
            .where(eq(telegramTopicSenders.roomId, roomId))
            .orderBy(desc(telegramTopicSenders.lastSeenAt))
            .limit(limit)
            .all();
    }
}
