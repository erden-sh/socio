import {
    foldText,
    PAGE_SEARCH_MAX_LIMIT,
    PAGE_SEARCH_MIN_CHARS,
    type PageSearchResult,
} from '@socio/shared/pages/page-search';

import type { AuthedFetch } from '../net/authed-fetch';
import { NetworkError } from '../net/errors';
import { readJson } from '../net/read-body';

import { ISSUE_SEARCH_MAX, searchIssues } from './issue-search';

// Search's server half: the web
// palette's search-as-you-type (`useSearchAsYouType`) for the Search tab. From
// two characters (`PAGE_SEARCH_MIN_CHARS`, spaces not counted), `SEARCH_DELAY_MS`
// after the last keystroke, it asks `/api/spaces/search?q=` (pages by their
// text) and `/api/issues/search?q=` (issue numbers by key, title or
// description) together, through the workspace's authedFetch. Each keystroke
// aborts the request in flight and the wait before it, so an answer to an
// older query never shows for a newer one. The last `SEARCH_KEEP` answers are
// kept, so backspacing doesn't ask again, until the field empties or Search
// loses focus (`forget`): a later visit asks afresh. Offline (the screen says so, or no
// answer came) nothing is asked and the state is `offline`: Search shows its
// local results with "Searching page text needs a connection". One request
// that fails otherwise leaves its half null; the local results stay. With a
// `space` (a Space's library) it asks only for that
// Space's pages (`space=`, the web's SpaceLibrary search, up to
// `PAGE_SEARCH_MAX_LIMIT`), never the issues. No React Native: tests/sync runs
// it under Node.

/** How long after the last keystroke the server is asked (the web's). */
export const SEARCH_DELAY_MS = 250;
/** Answers kept, by folded query, while the scope lives. */
export const SEARCH_KEEP = 20;

/** What the server found for one query; a half is null when its request failed. */
export interface ServerSearchAnswer {
    /** The folded query it answers. */
    readonly query: string;
    readonly pages: PageSearchResult | null;
    /** The matching issues' numbers, in the server's order. */
    readonly issues: readonly number[] | null;
}

export type ServerSearchState =
    | { readonly status: 'idle' }
    | { readonly status: 'waiting'; readonly query: string }
    | { readonly status: 'offline'; readonly query: string }
    | { readonly status: 'done'; readonly answer: ServerSearchAnswer };

export const IDLE: ServerSearchState = { status: 'idle' };

/** Whether `query` is long enough to ask the server: two characters, spaces not counted. */
export const searchesServer = (query: string) => foldText(query).replace(/ /g, '').length >= PAGE_SEARCH_MIN_CHARS;

export interface ServerSearch {
    /** The person typed `query`; `offline` when the screen knows the server can't be reached. */
    search(query: string, offline: boolean): void;
    state(): ServerSearchState;
    /** Calls `listener` after each change of `state()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Search lost focus: aborts what is in flight and drops the kept answers, so the next search asks again. */
    forget(): void;
    /** Aborts what is in flight; nothing is asked after. */
    dispose(): void;
}

export interface ServerSearchOptions {
    readonly fetch: AuthedFetch;
    /** One Space's pages only (its library's search): no issues are asked. */
    readonly space?: string;
    readonly delayMs?: number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export const pageSearchPath = (query: string, space?: string) =>
    `/api/spaces/search?q=${encodeURIComponent(query.slice(0, ISSUE_SEARCH_MAX))}${
        space === undefined ? '' : `&space=${encodeURIComponent(space)}&limit=${PAGE_SEARCH_MAX_LIMIT}`
    }`;

/** Pages by their text; rejects on no answer, a refusal or a body that isn't the server's. */
async function searchPages(
    fetch: AuthedFetch,
    query: string,
    signal: AbortSignal,
    space?: string,
): Promise<PageSearchResult> {
    const response = await fetch(pageSearchPath(query, space), { signal });
    if (!response.ok) {
        throw new Error(`The page search answered ${response.status}.`);
    }
    const body = (await readJson(response, signal)) as { results?: unknown } | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.results)) {
        throw new Error('The page search answered something else.');
    }
    return body as PageSearchResult;
}

export function createServerSearch(options: ServerSearchOptions): ServerSearch {
    const delayMs = options.delayMs ?? SEARCH_DELAY_MS;
    const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const kept = new Map<string, ServerSearchAnswer>();
    const listeners = new Set<() => void>();
    let state: ServerSearchState = IDLE;
    let timer: unknown = null;
    let controller: AbortController | null = null;
    let disposed = false;

    const set = (next: ServerSearchState) => {
        state = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const stop = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        controller?.abort();
        controller = null;
    };

    const ask = async (query: string, folded: string, signal: AbortSignal) => {
        const [pages, issues] = await Promise.allSettled([
            searchPages(options.fetch, query, signal, options.space),
            options.space === undefined
                ? searchIssues(options.fetch, query, signal)
                : Promise.reject(new Error('Not asked in a Space.')),
        ]);
        if (signal.aborted || disposed) {
            return;
        }
        if (pages.status === 'rejected' && issues.status === 'rejected') {
            const away = [pages.reason, issues.reason].some((reason) => reason instanceof NetworkError);
            set(
                away
                    ? { status: 'offline', query: folded }
                    : { status: 'done', answer: { query: folded, pages: null, issues: null } },
            );
            return;
        }
        const answer: ServerSearchAnswer = {
            query: folded,
            pages: pages.status === 'fulfilled' ? pages.value : null,
            issues: issues.status === 'fulfilled' ? [...issues.value] : null,
        };
        kept.delete(folded);
        kept.set(folded, answer);
        if (kept.size > SEARCH_KEEP) {
            kept.delete(kept.keys().next().value!);
        }
        set({ status: 'done', answer });
    };

    return {
        search(query, offline) {
            if (disposed) {
                return;
            }
            stop();
            if (foldText(query) === '') {
                // An emptied field: what was kept goes, so typing again asks afresh.
                kept.clear();
            }
            if (!searchesServer(query)) {
                if (state.status !== 'idle') {
                    set(IDLE);
                }
                return;
            }
            const folded = foldText(query);
            const answer = kept.get(folded);
            if (answer !== undefined) {
                set({ status: 'done', answer });
                return;
            }
            if (offline) {
                set({ status: 'offline', query: folded });
                return;
            }
            set({ status: 'waiting', query: folded });
            const asking = new AbortController();
            controller = asking;
            timer = setTimer(() => {
                timer = null;
                void ask(query.trim(), folded, asking.signal).catch(() => {});
            }, delayMs);
        },
        state: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        forget() {
            stop();
            kept.clear();
        },
        dispose() {
            disposed = true;
            stop();
            listeners.clear();
        },
    };
}
