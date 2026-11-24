import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { ownedList, type TransferParties } from '@socio/shared/auth';

import type { AppOwnershipShape } from '../../contract.js';

/**
 * The apps a person owns, and moving them to another person (CB-360). No
 * key names the owner, so nothing clashes. Who has an app open (its
 * sessions) is not ownership: those stay with the person who signed in.
 * The caller hands the live ones' ids to the apps service after the
 * commit (`AppsShape.handedOver`): their data tokens name the old owner.
 */
export function appOwnership(db: DatabaseSync): AppOwnershipShape {
    return {
        owned(userId) {
            const rows = db
                .prepare('SELECT id, name, deletedAt FROM apps WHERE ownerUserId=? ORDER BY createdAt, id')
                .all(userId) as { id: string; name: string; deletedAt: number | null }[];
            return ownedList(
                rows.map((row) => ({ id: row.id, name: row.name, type: 'app', deleted: row.deletedAt !== null })),
            );
        },
        transfer({ from, to }: TransferParties) {
            return transactionSync(db, 'transfer apps', () => {
                const live = db
                    .prepare('SELECT id FROM apps WHERE ownerUserId=? AND deletedAt IS NULL ORDER BY createdAt, id')
                    .all(from) as { id: string }[];
                const { changes } = db
                    .prepare('UPDATE apps SET ownerUserId=?, updatedAt=? WHERE ownerUserId=?')
                    .run(to, Date.now(), from);
                return { moved: { apps: Number(changes) }, notes: [], appIds: live.map((row) => row.id) };
            });
        },
    };
}
