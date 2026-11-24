import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';

import type { PageThreadOwnershipShape } from '../../contract.js';

/** The page links of moved conversations (CB-360): the new owner's page chat, or dropped on a clash. */
export function pageThreadOwnership(db: DatabaseSync): PageThreadOwnershipShape {
    return {
        followThreads({ from, to }, threadIds) {
            return transactionSync(db, 'transfer page chats', () => {
                const move = db.prepare('UPDATE OR IGNORE page_threads SET userId=? WHERE userId=? AND threadId=?');
                const drop = db.prepare('DELETE FROM page_threads WHERE userId=? AND threadId=?');
                let moved = 0;
                let dropped = 0;
                for (const id of threadIds) {
                    moved += Number(move.run(to, from, id).changes);
                    dropped += Number(drop.run(from, id).changes);
                }
                return { moved: { pageChats: moved, ...(dropped ? { pageChatsUnlinked: dropped } : {}) }, notes: [] };
            });
        },
    };
}
