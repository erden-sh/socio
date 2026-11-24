/**
 * The board's inputs for agents and Dots, as zod schemas: an item's
 * reference, links a filing asks for, the status-history page, and status
 * watches. Moved from `issues/filings.ts`, `issues/store.ts` and
 * `issues/subscriptions.ts`; those files re-export them.
 */
import { z } from 'zod';

import { ISSUE_STATUSES } from './issue-types.js';

/** The most issues one issue can wait for (CB-29). */
export const BLOCKERS_MAX = 20;
/** The most issues one issue can be related to (CB-274). */
export const RELATED_MAX = 50;

/** An item on the board, as a Dot names it: `CB-12` or `12`. */
export const issueRef = z
    .string()
    .trim()
    .regex(/^(?:CB-)?[1-9]\d{0,8}$/i);
/** Relationship authoring uses the same bounded references as board reads. */
export const filingDependencies = {
    blockedBy: z
        .array(issueRef)
        .max(BLOCKERS_MAX)
        .optional()
        .describe('Issue keys this item waits for; only an admin can set blocking links.'),
    blocks: z
        .array(issueRef)
        .max(BLOCKERS_MAX)
        .optional()
        .describe('Issue keys that wait for this item; only an admin can set blocking links.'),
    related: z
        .array(issueRef)
        .max(RELATED_MAX)
        .optional()
        .describe('Issue keys related to this item, with no blocking either way; anyone may set these.'),
};

export const boardHistoryInput = {
    historyAfter: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe('Status-history sequence cursor from the prior page; omit for the first page.'),
    historyLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Status-history page size, at most 100. Follow statusHistory.next until null.'),
};

export const issueWatchInput = z
    .object({
        issues: z
            .array(issueRef)
            .min(1)
            .max(20)
            .describe('Explicit board issue keys. One notice when ALL reach targetStatus after a future transition.'),
        targetStatus: z.enum(ISSUE_STATUSES).default('done'),
    })
    .strict();
export const issueWatchPage = z
    .object({
        limit: z.number().int().min(1).max(50).default(25),
        offset: z.number().int().min(0).max(100000).default(0),
    })
    .strict();
