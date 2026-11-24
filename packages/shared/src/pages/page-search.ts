/**
 * Server page search: what
 * `GET /api/spaces/search` answers, and the freshness line every result
 * row shows.
 */

/** A piece of a snippet; `match` pieces are the words the query found. */
export interface SnippetPart {
    text: string;
    match: boolean;
}

/**
 * Why a page counts as fresh: its last edit, or its last use (someone
 * opened it from a search, or a Dot read it for someone), whichever
 * counts for more. Never who used it.
 */
export interface Freshness {
    basis: 'edited' | 'used';
    /** When (ms). */
    at: number;
}

export interface PageHit {
    id: string;
    spaceId: string;
    title: string;
    updatedAt: number;
    /** Plain text around the best match; the start of the body for a title hit. */
    snippet: SnippetPart[];
    /** `word`: words starting with the query's; `text`: inside words (trigram). */
    matched: 'word' | 'text';
    freshness: Freshness;
}

export interface PageSearchResult {
    /** The words searched, after normalizing (the corrected ones, if any). */
    query: string;
    /** Set when a misspelt word was replaced: the words searched instead. */
    corrected: string | null;
    results: PageHit[];
    /** Whether a next page (`offset + limit`) has more. */
    more: boolean;
}

/** Results per request: the palette's group size by default, at most 20. */
export const PAGE_SEARCH_LIMIT = 8;
export const PAGE_SEARCH_MAX_LIMIT = 20;
/** The deepest page: results come from the best 200 candidates. */
export const PAGE_SEARCH_MAX_OFFSET = 180;
/** Fewer characters than this, in all, are not sent to the server. */
export const PAGE_SEARCH_MIN_CHARS = 2;

/** Case, accents and spacing folded, as the palette matches titles. */
export const foldText = (text: string) =>
    text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The snippet markers the server's FTS5 `snippet()` uses (control characters). */
export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

/** A marked snippet as parts; marker characters never reach the client. */
export function snippetParts(marked: string): SnippetPart[] {
    const parts: SnippetPart[] = [];
    let match = false;
    let text = '';
    const push = () => {
        if (text) {
            parts.push({ text, match });
        }
        text = '';
    };
    for (const ch of marked) {
        if (ch === MARK_OPEN || ch === MARK_CLOSE) {
            push();
            match = ch === MARK_OPEN;
        } else {
            text += ch;
        }
    }
    push();
    return parts;
}

const DAY = 86_400_000;
const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * The freshness line, short: "Edited 3 days ago", "Used this week".
 * Edits say how long ago; uses only say roughly when, never by whom.
 */
export function freshnessLabel({ basis, at }: Freshness, now = Date.now()) {
    const days = Math.max(0, Math.floor((now - at) / DAY));
    if (basis === 'used') {
        return days < 1
            ? 'Used today'
            : days < 7
              ? 'Used this week'
              : days < 31
                ? 'Used this month'
                : `Used ${plural(Math.floor(days / 30), 'month')} ago`;
    }
    if (days < 1) {
        return 'Edited today';
    }
    if (days < 2) {
        return 'Edited yesterday';
    }
    if (days < 14) {
        return `Edited ${plural(days, 'day')} ago`;
    }
    if (days < 61) {
        return `Edited ${plural(Math.floor(days / 7), 'week')} ago`;
    }
    if (days < 365) {
        return `Edited ${plural(Math.floor(days / 30), 'month')} ago`;
    }
    return `Edited ${plural(Math.floor(days / 365), 'year')} ago`;
}

/** What the operator page shows for one day (UTC). No query text. */
export interface SearchDay {
    day: string;
    queries: number;
    /** Searches that found nothing, after any correction. */
    empty: number;
    corrected: number;
    /** Searches the trigram index filled in. */
    trigram: number;
    /** Milliseconds, from a histogram (within about 9%). */
    p50: number | null;
    p95: number | null;
    p99: number | null;
    maxMs: number;
    /** Sizes measured with the first searches of the day. */
    sizes: SearchIndexSizes | null;
}

export interface SearchIndexSizes {
    pages: number;
    /** The plain-text copy (`page_search` and its key). */
    textBytes: number;
    /** The unicode61 word index with its prefix indexes. */
    wordBytes: number;
    trigramBytes: number;
}

/**
 * `GET /api/operator/page-search` (operators): the daily rollup of
 * search timings, newest day first, and the index's sizes now.
 */
export interface SearchStatsView {
    days: SearchDay[];
    now: SearchIndexSizes;
    /** Kept page revisions, which search never reads. */
    revisions?: PageRevisionStats;
}

/** Earlier states of pages kept on edits (`page_revisions`), operators only. */
export interface PageRevisionStats {
    revisions: number;
    /** Pages with at least one revision. */
    pages: number;
    /** The table and its index on disk. */
    bytes: number;
}
