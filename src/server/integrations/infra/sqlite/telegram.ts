import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type { TelegramConversationRepository, TelegramLinkRepository, TelegramThreadInfo } from '../../contract.js';

import { SqliteRepository } from './base.js';
import { telegramLinkCodes, telegramLinks, telegramMembers, telegramThreads } from './schema.js';

/** Link codes (stored hashed) and the account links they made. */
export class SqliteTelegramLinks extends SqliteRepository implements TelegramLinkRepository {
    issueCode(hash: string, userId: string, expiresAt: number, expiredBefore: number) {
        return this.write('create Telegram link code', async () => {
            await this.db
                .delete(telegramLinkCodes)
                .where(or(eq(telegramLinkCodes.userId, userId), lte(telegramLinkCodes.expiresAt, expiredBefore)));
            await this.db.insert(telegramLinkCodes).values({ hash, userId, expiresAt, usedAt: null });
        });
    }

    async code(hash: string) {
        return this.db
            .select({
                userId: telegramLinkCodes.userId,
                expiresAt: telegramLinkCodes.expiresAt,
                usedAt: telegramLinkCodes.usedAt,
            })
            .from(telegramLinkCodes)
            .where(eq(telegramLinkCodes.hash, hash))
            .get();
    }

    claimCode(hash: string, now: number) {
        return this.write('redeem Telegram link code', async () => {
            const claimed = await this.db
                .update(telegramLinkCodes)
                .set({ usedAt: now })
                .where(
                    and(
                        eq(telegramLinkCodes.hash, hash),
                        // An unused code only: one redemption each.
                        isNull(telegramLinkCodes.usedAt),
                    ),
                )
                .returning({ hash: telegramLinkCodes.hash });
            return claimed.length > 0;
        });
    }

    link(telegramUserId: string, userId: string, username: string | null, now: number) {
        return this.write('link Telegram account', async () => {
            await this.db
                .delete(telegramLinks)
                .where(or(eq(telegramLinks.telegramUserId, telegramUserId), eq(telegramLinks.userId, userId)));
            await this.db.insert(telegramLinks).values({ telegramUserId, userId, username, linkedAt: now });
        });
    }

    async userFor(telegramUserId: string) {
        return (
            await this.db
                .select({ userId: telegramLinks.userId })
                .from(telegramLinks)
                .where(eq(telegramLinks.telegramUserId, telegramUserId))
                .get()
        )?.userId;
    }

    async linkFor(userId: string) {
        return this.db
            .select({
                telegramUserId: telegramLinks.telegramUserId,
                username: telegramLinks.username,
                linkedAt: telegramLinks.linkedAt,
            })
            .from(telegramLinks)
            .where(eq(telegramLinks.userId, userId))
            .get();
    }

    async linked() {
        return this.db
            .select({
                telegramUserId: telegramLinks.telegramUserId,
                userId: telegramLinks.userId,
            })
            .from(telegramLinks)
            .all();
    }

    unlink(userId: string) {
        return this.write('unlink Telegram account', async () => {
            const removed = await this.db
                .delete(telegramLinks)
                .where(eq(telegramLinks.userId, userId))
                .returning({ userId: telegramLinks.userId });
            return removed.length > 0;
        });
    }
}

const INFO = {
    kind: telegramThreads.kind,
    chatId: telegramThreads.chatId,
    topicId: telegramThreads.topicId,
};

/** Telegram conversations' app threads, and who was seen in which group. */
export class SqliteTelegramConversations extends SqliteRepository implements TelegramConversationRepository {
    async threadFor(key: string) {
        return (
            await this.db
                .select({ threadId: telegramThreads.threadId })
                .from(telegramThreads)
                .where(eq(telegramThreads.key, key))
                .get()
        )?.threadId;
    }

    bind(key: string, threadId: string, info: TelegramThreadInfo, now: number) {
        return this.write('bind Telegram conversation', async () => {
            await this.db.insert(telegramThreads).values({
                key,
                threadId,
                kind: info.kind,
                chatId: info.chatId,
                topicId: info.topicId,
                createdAt: now,
            });
        });
    }

    rebind(key: string, threadId: string) {
        return this.write('rebind Telegram conversation', async () => {
            await this.db.update(telegramThreads).set({ threadId }).where(eq(telegramThreads.key, key));
        });
    }

    retire(key: string) {
        return this.write('retire Telegram conversation', async () => {
            await this.db
                .update(telegramThreads)
                .set({
                    key: sql`${telegramThreads.key} || '~' || ${telegramThreads.threadId}`,
                })
                .where(eq(telegramThreads.key, key));
        });
    }

    async info(threadId: string): Promise<TelegramThreadInfo | undefined> {
        return this.infoNow(threadId);
    }
    infoNow(threadId: string): TelegramThreadInfo | undefined {
        return this.db.select(INFO).from(telegramThreads).where(eq(telegramThreads.threadId, threadId)).get();
    }

    async infos(threadIds: string[]) {
        const rows = threadIds.length
            ? await this.db
                  .select({ threadId: telegramThreads.threadId, ...INFO })
                  .from(telegramThreads)
                  .where(inArray(telegramThreads.threadId, threadIds))
                  .all()
            : [];
        return new Map<string, TelegramThreadInfo>(rows.map(({ threadId, ...info }) => [threadId, info]));
    }

    recordMember(chatId: string, userId: string, now: number) {
        return this.write('record Telegram member', async () => {
            await this.db
                .insert(telegramMembers)
                .values({ chatId, userId, seenAt: now })
                .onConflictDoUpdate({
                    target: [telegramMembers.chatId, telegramMembers.userId],
                    set: { seenAt: now },
                });
        });
    }

    async isMember(chatId: string, userId: string) {
        return !!(await this.db
            .select({ chatId: telegramMembers.chatId })
            .from(telegramMembers)
            .where(and(eq(telegramMembers.chatId, chatId), eq(telegramMembers.userId, userId)))
            .get());
    }

    async memberChats(userId: string) {
        return (
            await this.db
                .select({ chatId: telegramMembers.chatId })
                .from(telegramMembers)
                .where(eq(telegramMembers.userId, userId))
                .orderBy(asc(telegramMembers.chatId))
                .all()
        ).map((row) => row.chatId);
    }

    async chatMembers(chatId: string) {
        return (
            await this.db
                .select({ userId: telegramMembers.userId })
                .from(telegramMembers)
                .where(eq(telegramMembers.chatId, chatId))
                .orderBy(asc(telegramMembers.seenAt))
                .all()
        ).map((row) => row.userId);
    }

    async teamThreads(userId: string) {
        return this.teamThreadsNow(userId);
    }
    teamThreadsNow(userId: string) {
        return this.db
            .select({ threadId: telegramThreads.threadId })
            .from(telegramThreads)
            .innerJoin(
                telegramMembers,
                and(eq(telegramMembers.chatId, telegramThreads.chatId), eq(telegramMembers.userId, userId)),
            )
            .where(eq(telegramThreads.kind, 'topic'))
            .all()
            .map((row) => row.threadId);
    }
}
