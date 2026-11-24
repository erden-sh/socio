import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';

import type { EvidenceOwnershipShape } from '../../contract.js';

/** Learning evidence names its conversation's owner: it follows a moved one (CB-360). */
export function evidenceOwnership(db: DatabaseSync): EvidenceOwnershipShape {
    return {
        followThreads({ from, to }, threadIds) {
            return transactionSync(db, 'transfer learning evidence', () => {
                const move = db.prepare('UPDATE learning_evidence SET ownerId=? WHERE ownerId=? AND threadId=?');
                let evidence = 0;
                for (const id of threadIds) {
                    evidence += Number(move.run(to, from, id).changes);
                }
                return { moved: { learningEvidence: evidence }, notes: [] };
            });
        },
    };
}
