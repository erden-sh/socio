import { foldText } from '@socio/shared/pages/page-search';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

// The board's search on the server (the web's useIssueSearch, CB-71):
// the list has no descriptions, so `GET /api/issues/search?q=` says which
// issues hold every word in their key, title or description. Online only and
// never queued: until it answers, or when it can't, the board filters on what
// it holds (shared's `filterIssues` without matches). No React Native.

/** The server's longest query (`z.string().max(200)`). */
export const ISSUE_SEARCH_MAX = 200;
/** How long after the last keystroke the server is asked (the web's SEARCH_DELAY_MS). */
export const ISSUE_SEARCH_DELAY_MS = 250;

export const issueSearchPath = (query: string) =>
    `/api/issues/search?q=${encodeURIComponent(query.slice(0, ISSUE_SEARCH_MAX))}`;

/** The matching issues' numbers; rejects on no answer, a refusal or a body that isn't the server's. */
export async function searchIssues(fetch: AuthedFetch, query: string, signal?: AbortSignal): Promise<Set<number>> {
    const response = await fetch(issueSearchPath(query), signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw new Error(`The issue search answered ${response.status}.`);
    }
    const body = (await readJson(response, signal)) as { numbers?: unknown } | null;
    const numbers = body?.numbers;
    if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === 'number' && Number.isSafeInteger(n))) {
        throw new Error('The issue search answered something else.');
    }
    return new Set(numbers as number[]);
}

/** The server's last answer the board holds: the folded query it answers, and its numbers. */
export interface KeptIssueMatches {
    readonly query: string;
    readonly matches: ReadonlySet<number>;
}

/**
 * The matches the board shows for `query`: the kept answer while it answers
 * the same folded text, whatever the issue list did since (a changed list asks
 * again, and its answer replaces this one), else none.
 */
export function shownIssueMatches(kept: KeptIssueMatches | null, query: string): ReadonlySet<number> | undefined {
    const folded = foldText(query);
    return kept !== null && folded !== '' && kept.query === folded ? kept.matches : undefined;
}
