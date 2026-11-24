import type { SqliteData } from '@socio/data/open';

import type { ApprovalRepositories } from '../../domain/repositories.js';

import { SqliteAudit } from './audit.js';
import { SqliteNotes } from './notes.js';
import { SqliteGuidance, SqlitePolicies } from './policies.js';
import { SqliteRequests } from './requests.js';
import { SqliteReviews } from './reviews.js';

/**
 * Approvals' repositories on a migrated connection (CB-110): the only code
 * that reads or writes the approval tables.
 */
export function sqliteApprovalRepositories(data: SqliteData): ApprovalRepositories {
    return {
        policies: new SqlitePolicies(data),
        guidance: new SqliteGuidance(data),
        requests: new SqliteRequests(data),
        reviews: new SqliteReviews(data),
        audit: new SqliteAudit(data),
        notes: new SqliteNotes(data),
    };
}
