import { and, eq } from 'drizzle-orm';

import type { TelegramReply, TelegramReplyRepository } from '../../contract.js';

import { SqliteRepository } from './base.js';
import { telegramReplies } from './schema.js';

/** The socio reply each of the bot's Telegram messages shows (CB-145). */
export class SqliteTelegramReplies extends SqliteRepository implements TelegramReplyRepository {
    record(chatId: string, messageIds: string[], reply: TelegramReply, now: number) {
        if (!messageIds.length) {
            return Promise.resolve();
        }
        return this.write('record Telegram replies', async () => {
            for (const messageId of messageIds) {
                await this.db
                    .insert(telegramReplies)
                    .values({ chatId, messageId, ...reply, createdAt: now })
                    .onConflictDoUpdate({
                        target: [telegramReplies.chatId, telegramReplies.messageId],
                        set: { ...reply, createdAt: now },
                    });
            }
        });
    }

    async reply(chatId: string, messageId: string) {
        return this.db
            .select({
                threadId: telegramReplies.threadId,
                replyId: telegramReplies.replyId,
            })
            .from(telegramReplies)
            .where(and(eq(telegramReplies.chatId, chatId), eq(telegramReplies.messageId, messageId)))
            .get();
    }
}
