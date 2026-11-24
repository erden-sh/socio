/**
 * What every Operations question is asked with: the scope (a window and
 * filters), a page of a list, and the sessions' options. Split from
 * `reader.ts`, so the query registries (`health-queries.ts`,
 * `ops-queries.ts`, `reliability-queries.ts`) name them without importing
 * the reader that names their answers.
 */
import type { OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import type { OpsOutcome } from '@socio/shared/operations/operations-activity';

import type { OpsCursor } from './cursor.js';

/** What a section asks about: a window, cut in the reporting time zone, and filters. */
export interface OpsScope {
    window: OpsWindow;
    filters: OpsFilters;
}

/** A page of a newest-first list: after `cursor`, at most `limit` rows. */
export interface OpsPageRequest {
    cursor?: OpsCursor;
    limit: number;
}
export interface OpsPage<T> {
    items: T[];
    /** Where the next page starts; null at the end. */
    next: OpsCursor | null;
}

/**
 * What Activity's and Value's questions add to the scope (CB-190): the
 * session gap in force (sessions are derived when asked, so a new gap
 * needs no rebuild), and for a sessions list, one outcome.
 */
export interface OpsSessionOptions {
    sessionGapMinutes: number;
    outcome?: OpsOutcome;
}
