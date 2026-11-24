import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { ownedList } from '@socio/shared/auth';

import type { SpaceMembershipOwnershipShape } from '../../contract.js';

const RANK: Record<string, number> = { member: 1, editor: 2 };

/**
 * A person's places in Spaces (`space_members`), and moving them to
 * another person (CB-360). Where the new owner is a member already, the
 * higher of the two roles stays. Who added whom stays as it was.
 */
export function spaceMembershipOwnership(db: DatabaseSync): SpaceMembershipOwnershipShape {
    return {
        owned(userId) {
            const rows = db
                .prepare(
                    'SELECT m.spaceId, m.role, s.name, s.deletedAt FROM space_members m LEFT JOIN spaces s ON s.id=m.spaceId WHERE m.userId=? ORDER BY s.name, m.spaceId',
                )
                .all(userId) as { spaceId: string; role: string; name: string | null; deletedAt: number | null }[];
            return ownedList(
                rows.map((row) => ({
                    id: row.spaceId,
                    name: row.name ?? row.spaceId,
                    type: row.role,
                    deleted: row.deletedAt !== null,
                })),
            );
        },
        soleEditorOf(userId) {
            return Number(
                (
                    db
                        .prepare(
                            `SELECT COUNT(*) AS n FROM space_members m JOIN spaces s ON s.id=m.spaceId AND s.deletedAt IS NULL
                              WHERE m.userId=? AND m.role='editor'
                                AND NOT EXISTS (SELECT 1 FROM space_members o WHERE o.spaceId=m.spaceId AND o.userId<>m.userId AND o.role='editor')`,
                        )
                        .get(userId) as { n: number }
                ).n,
            );
        },
        transfer({ from, to }) {
            return transactionSync(db, 'transfer Space memberships', () => {
                const now = Date.now();
                const rows = db.prepare('SELECT spaceId, role FROM space_members WHERE userId=?').all(from) as {
                    spaceId: string;
                    role: string;
                }[];
                const theirs = db.prepare('SELECT role FROM space_members WHERE spaceId=? AND userId=?');
                let moved = 0;
                let merged = 0;
                for (const row of rows) {
                    const existing = theirs.get(row.spaceId, to) as { role: string } | undefined;
                    if (!existing) {
                        db.prepare('UPDATE space_members SET userId=?, updatedAt=? WHERE spaceId=? AND userId=?').run(
                            to,
                            now,
                            row.spaceId,
                            from,
                        );
                        moved++;
                        continue;
                    }
                    if ((RANK[row.role] ?? 0) > (RANK[existing.role] ?? 0)) {
                        db.prepare('UPDATE space_members SET role=?, updatedAt=? WHERE spaceId=? AND userId=?').run(
                            row.role,
                            now,
                            row.spaceId,
                            to,
                        );
                    }
                    db.prepare('DELETE FROM space_members WHERE spaceId=? AND userId=?').run(row.spaceId, from);
                    merged++;
                }
                return {
                    moved: { memberships: moved, ...(merged ? { membershipsMerged: merged } : {}) },
                    notes: merged
                        ? [`${merged} Space(s) had the new owner already: each kept the higher of the two roles.`]
                        : [],
                };
            });
        },
    };
}
