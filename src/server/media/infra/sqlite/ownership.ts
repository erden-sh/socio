import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';

import type { MediaOwnershipShape } from '../../contract.js';

/**
 * A person's media rows, moved with their data space's files (CB-360):
 * attachments and embeds name a file by id, so only the owner changes; a
 * library folder the new owner has already is kept once.
 */
export function mediaOwnership(db: DatabaseSync): MediaOwnershipShape {
    const count = (table: string, userId: string) =>
        Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ownerUserId=?`).get(userId) as { n: number }).n);
    return {
        counts(userId) {
            return {
                attachments: count('media_attachments', userId),
                folders: count('media_folders', userId),
                embeds: count('media_embeds', userId),
            };
        },
        transfer({ from, to }) {
            return transactionSync(db, 'transfer media', () => {
                const attachments = db
                    .prepare('UPDATE media_attachments SET ownerUserId=? WHERE ownerUserId=?')
                    .run(to, from);
                const embeds = db.prepare('UPDATE media_embeds SET ownerUserId=? WHERE ownerUserId=?').run(to, from);
                const folders = db
                    .prepare(
                        'INSERT OR IGNORE INTO media_folders(ownerUserId, path, createdAt) SELECT ?, path, createdAt FROM media_folders WHERE ownerUserId=?',
                    )
                    .run(to, from);
                const all = db.prepare('DELETE FROM media_folders WHERE ownerUserId=?').run(from);
                const merged = Number(all.changes) - Number(folders.changes);
                return {
                    moved: {
                        attachments: Number(attachments.changes),
                        embeds: Number(embeds.changes),
                        folders: Number(folders.changes),
                        ...(merged ? { foldersMerged: merged } : {}),
                    },
                    notes: [],
                };
            });
        },
    };
}
