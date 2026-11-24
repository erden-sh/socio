import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';

import type { TelegramThreadOwnershipShape } from '../../contract.js';

/**
 * A moved conversation leaves the old owner's Telegram chat (CB-360): the
 * binding goes, so nothing they send there lands in a conversation that
 * is no longer theirs; their next message starts a new one. Replies
 * already sent stay as history.
 */
export function telegramThreadOwnership(db: DatabaseSync): TelegramThreadOwnershipShape {
    return {
        followThreads(_parties, threadIds) {
            return transactionSync(db, 'unbind Telegram chats', () => {
                const drop = db.prepare('DELETE FROM telegram_threads WHERE threadId=?');
                let unbound = 0;
                for (const id of threadIds) {
                    unbound += Number(drop.run(id).changes);
                }
                const moved: Record<string, number> = unbound ? { telegramChatsUnbound: unbound } : {};
                return {
                    moved,
                    notes: unbound
                        ? [
                              `${unbound} conversation(s) left the old owner's Telegram chat: their next message there starts a new one.`,
                          ]
                        : [],
                };
            });
        },
    };
}
