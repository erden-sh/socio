import type { SymbolName } from './symbols';

// What a search or a filter that matched nothing shows (CB-552), drawn by
// empty-state.tsx's `SearchEmptyState`: iOS's ContentUnavailableView.search
// (a magnifying glass, "No results for “…”" as a Title 2, one muted line) and
// Material's empty state on Android, with the ways out the screen already has:
// Clear search, which empties the field and keeps the focus in it, and Clear
// filters where filters narrowed it. A screen reader reads the block as one
// element and hears it once as it appears, not once per keystroke. No React
// Native here, so the Node tests read it as the app does.

/** The symbol over it: SF Symbols' magnifyingglass on iOS, lucide's search on Android. */
export const SEARCH_EMPTY_SYMBOL: SymbolName = 'search';

export const CLEAR_SEARCH = 'Clear search';
export const CLEAR_FILTERS = 'Clear filters';

/** The longest query the title quotes whole; a longer one is cut with an ellipsis. */
export const QUOTED_QUERY_MAX = 40;

/** What is said when nothing matched what was typed. */
export const NO_RESULTS = 'No results';

export interface SearchEmptyInput {
    /** What the person typed, as typed. */
    readonly query: string;
    /** The line under the title. */
    readonly line: string;
    /** A title of the screen's own (the web's "No matching pages"); "No results for “…”" when none. */
    readonly title?: string;
    /** Whether filters narrowed the list too, so Clear filters is offered. */
    readonly filtered?: boolean;
}

export interface SearchEmptyView {
    readonly title: string;
    readonly line: string;
    /** The block's one label for screen readers: the title, then the line. */
    readonly accessibilityLabel: string;
    /** What a screen reader hears as the state appears: the same while it stays, whatever is typed. */
    readonly announcement: string;
    /** Clear search: something is typed. */
    readonly clearSearch: boolean;
    /** Clear filters: filters are on. */
    readonly clearFilters: boolean;
}

/** `query` trimmed and cut to QUOTED_QUERY_MAX characters, an ellipsis marking the cut. */
export function quotedQuery(query: string): string {
    const trimmed = query.trim().replace(/\s+/g, ' ');
    const chars = Array.from(trimmed);
    return chars.length <= QUOTED_QUERY_MAX
        ? trimmed
        : `${chars
              .slice(0, QUOTED_QUERY_MAX - 1)
              .join('')
              .trimEnd()}…`;
}

/** The empty state for a search (and filters) that matched nothing. */
export function searchEmpty(input: SearchEmptyInput): SearchEmptyView {
    const typed = input.query.trim() !== '';
    const title = input.title ?? (typed ? `${NO_RESULTS} for “${quotedQuery(input.query)}”` : NO_RESULTS);
    return {
        title,
        line: input.line,
        accessibilityLabel: `${title}. ${input.line}`,
        announcement: input.title ?? NO_RESULTS,
        clearSearch: typed,
        clearFilters: input.filtered === true,
    };
}
