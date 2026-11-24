import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';

import type { ContextThreadOwnershipShape } from '../../contract.js';

/** The context links of moved conversations (CB-360): the new owner's, or dropped on a clash. */
export function contextThreadOwnership(db: DatabaseSync): ContextThreadOwnershipShape {
    return {
        followThreads({ from, to }, threadIds) {
            return transactionSync(db, 'transfer context links', () => {
                const move = db.prepare('UPDATE OR IGNORE context_threads SET userId=? WHERE userId=? AND threadId=?');
                const drop = db.prepare('DELETE FROM context_threads WHERE userId=? AND threadId=?');
                let moved = 0;
                let dropped = 0;
                for (const id of threadIds) {
                    moved += Number(move.run(to, from, id).changes);
                    dropped += Number(drop.run(from, id).changes);
                }
                return {
                    moved: { contextLinks: moved, ...(dropped ? { contextLinksDropped: dropped } : {}) },
                    notes: [],
                };
            });
        },
    };
}
