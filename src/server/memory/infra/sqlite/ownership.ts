import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { ownedList } from '@socio/shared/auth';

import type { MemoryOwnershipShape } from '../../contract.js';

/**
 * A person's memories and episodes, moved to another person (CB-360).
 * Memories in use become proposals (docs/MEMORY.md): a socio uses none of
 * them for the new owner until they approve it. Episodes are summaries of
 * one conversation, so they go where it goes (`followThreads`); the rest
 * stay. Their profile and time zone notes are about them, and stay.
 */
export function memoryOwnership(db: DatabaseSync): MemoryOwnershipShape {
    return {
        owned(userId) {
            const rows = db
                .prepare('SELECT id, text, status, deletedAt FROM memories WHERE userId=? ORDER BY createdAt, id')
                .all(userId) as { id: string; text: string; status: string; deletedAt: number | null }[];
            return ownedList(
                rows.map((row) => ({
                    id: row.id,
                    name: row.text.length > 80 ? `${row.text.slice(0, 79)}…` : row.text,
                    type: row.status === 'proposed' ? 'proposed memory' : 'memory',
                    deleted: row.deletedAt !== null,
                })),
            );
        },
        transfer({ from, to }) {
            return transactionSync(db, 'transfer memories', () => {
                const now = Date.now();
                const proposed = db
                    .prepare(
                        "UPDATE memories SET userId=?, status='proposed', confirmedAt=NULL, updatedAt=? WHERE userId=? AND deletedAt IS NULL",
                    )
                    .run(to, now, from);
                const deleted = db.prepare('UPDATE memories SET userId=? WHERE userId=?').run(to, from);
                const moved = Number(proposed.changes) + Number(deleted.changes);
                return {
                    moved: { memories: moved },
                    notes: Number(proposed.changes)
                        ? [`${proposed.changes} memory(ies) wait for the new owner to keep, edit or turn down.`]
                        : [],
                };
            });
        },
        followThreads({ from, to }, threadIds) {
            return transactionSync(db, 'transfer episodes', () => {
                const move = db.prepare('UPDATE memory_episodes SET userId=? WHERE userId=? AND threadId=?');
                let episodes = 0;
                for (const id of threadIds) {
                    episodes += Number(move.run(to, from, id).changes);
                }
                return { moved: { episodes }, notes: [] };
            });
        },
    };
}
