import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { freeName, ownedList } from '@socio/shared/auth';

import type { ConversationOwnershipShape, SocioOwnershipShape } from '../contract.js';

/**
 * A person's own socios (`dots.ownerId`), and moving them to another
 * person (CB-360). A socio keeps its id, Soul, Spaces, computer and
 * history; the new owner's live socio with the same name makes the moved
 * one `name 2`, so their pickers tell them apart. Grants others gave the
 * socio (CB-232) are the people's, and stay.
 */
export function socioOwnership(db: DatabaseSync): SocioOwnershipShape {
    return {
        owned(userId) {
            const rows = db
                .prepare('SELECT id, name, deletedAt, archivedAt FROM dots WHERE ownerId=? ORDER BY createdAt, id')
                .all(userId) as { id: string; name: string; deletedAt: number | null; archivedAt: number | null }[];
            return ownedList(
                rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    type: row.archivedAt === null ? 'socio' : 'archived socio',
                    deleted: row.deletedAt !== null,
                })),
            );
        },
        transfer({ from, to }) {
            return transactionSync(db, 'transfer socios', () => {
                const notes: string[] = [];
                // A clash with the new owner's names gets a name free of both people's.
                const names = (userId: string) =>
                    new Set(
                        (
                            db.prepare('SELECT name FROM dots WHERE ownerId=? AND deletedAt IS NULL').all(userId) as {
                                name: string;
                            }[]
                        ).map((row) => row.name.toLocaleLowerCase()),
                    );
                const theirs = names(to);
                const taken = new Set([...theirs, ...names(from)]);
                const live = db
                    .prepare('SELECT id, name FROM dots WHERE ownerId=? AND deletedAt IS NULL ORDER BY createdAt, id')
                    .all(from) as { id: string; name: string }[];
                const rename = db.prepare('UPDATE dots SET name=? WHERE id=?');
                let renamed = 0;
                for (const dot of live) {
                    if (!theirs.has(dot.name.toLocaleLowerCase())) {
                        continue;
                    }
                    const name = freeName(dot.name, (candidate) => taken.has(candidate.toLocaleLowerCase()));
                    taken.add(name.toLocaleLowerCase());
                    rename.run(name, dot.id);
                    renamed++;
                    notes.push(`Socio “${dot.name}” is now “${name}”: the new owner has a socio by that name.`);
                }
                const { changes } = db.prepare('UPDATE dots SET ownerId=? WHERE ownerId=?').run(to, from);
                return { moved: { socios: Number(changes), ...(renamed ? { sociosRenamed: renamed } : {}) }, notes };
            });
        },
    };
}

/**
 * A person's own conversations (`thread_bindings.ownerId`, never a room),
 * and moving them to another person (CB-360). Their messages, runs and
 * pins are the conversation's, keyed by its id, and go with it.
 */
export function conversationOwnership(db: DatabaseSync): ConversationOwnershipShape {
    return {
        owned(userId) {
            const rows = db
                .prepare(
                    "SELECT id, title, deletedAt FROM thread_bindings WHERE ownerId=? AND kind<>'room' ORDER BY createdAt, id",
                )
                .all(userId) as { id: string; title: string; deletedAt: number | null }[];
            return ownedList(
                rows.map((row) => ({
                    id: row.id,
                    name: row.title,
                    type: 'conversation',
                    deleted: row.deletedAt !== null,
                })),
            );
        },
        transfer({ from, to }, threadIds) {
            return transactionSync(db, 'transfer conversations', () => {
                const ids = (
                    db
                        .prepare(
                            "SELECT id FROM thread_bindings WHERE ownerId=? AND kind<>'room' ORDER BY createdAt, id",
                        )
                        .all(from) as { id: string }[]
                )
                    .map((row) => row.id)
                    .filter((id) => !threadIds || threadIds.includes(id));
                const move = db.prepare(
                    "UPDATE thread_bindings SET ownerId=? WHERE id=? AND ownerId=? AND kind<>'room'",
                );
                for (const id of ids) {
                    move.run(to, id, from);
                }
                return { moved: { conversations: ids.length }, notes: [], threadIds: ids };
            });
        },
    };
}
