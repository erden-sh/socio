import type { AccessSubject } from '../contract.js';

import type { OpsPage, OpsPageRequest } from './scope.js';

// In `operations/contract.ts` now; this path keeps working.

/** One access log entry, as stored (CB-188). */
export interface AccessEntry {
    id: string;
    at: number;
    viewerId: string;
    /** The audited endpoint (`ACCESS_SURFACE_LABELS`). */
    surface: string;
    subject: AccessSubject;
    content: boolean;
    /** The range and filters the view was opened with, and `via`. */
    filters: Record<string, string>;
    requestId: string;
}

/**
 * The access log (CB-188): append-only. There is no update or delete,
 * here or in the table (its triggers refuse both), so what an admin
 * opened stays on the record.
 */
export interface AccessLogRepository {
    /**
     * Appends the entry. With `unlessSince`, only when the viewer has no
     * entry at or after that time with the same surface, subject and
     * filters (checked and written in one unit of work). Whether it wrote.
     */
    record(entry: AccessEntry, options?: { unlessSince?: number }): Promise<boolean>;
    /** Every entry, newest first, keyset-paged by `(at, id)`. */
    page(request: OpsPageRequest): Promise<OpsPage<AccessEntry>>;
}
