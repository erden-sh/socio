/**
 * A list's paging, as every Operations list reads it: the cursor and limit
 * of a request, and what a list says to ones it can't use. Split from
 * `routes.ts`, so the access log and the transcripts page their lists
 * without importing the routes that mount them.
 */
import { OPS_PAGE_LIMIT } from '@socio/shared/operations/operations';

import { decodeCursor } from './domain/cursor.js';

/** What a list says to a cursor or limit it can't use. */
export const PAGE_ERROR = `Send cursor as a list gave it and limit from 1 to ${OPS_PAGE_LIMIT.max}.`;

/** A list request's cursor and limit, or undefined when either is wrong. */
export function pageOf(cursor: string | undefined, limit: string | undefined) {
    const size =
        limit === undefined || limit === '' ? OPS_PAGE_LIMIT.default : /^\d{1,4}$/.test(limit) ? Number(limit) : NaN;
    if (!(size >= 1 && size <= OPS_PAGE_LIMIT.max)) {
        return undefined;
    }
    if (!cursor) {
        return { limit: size };
    }
    const after = decodeCursor(cursor);
    return after && { cursor: after, limit: size };
}
