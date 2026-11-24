/**
 * What other features may know of web search (public-web research for a
 * socio's turn and for research runs): its tags, the error a turn catches,
 * and the plain types and constants they name. It imports only `effect` and
 * `@socio/*`, and holds no logic.
 *
 * Moved here, re-exported at their old paths (`provider.ts`, and through it
 * `index.ts` and `parallel.ts`): `SearchData`, `SearchSession`,
 * `SearchProvider`, `WebSource`, `GatherRequest`, `MAX_SOURCES`,
 * `MAX_SOURCE_CHARS` and `SearchRateLimitedError`.
 *
 * Moved into a package, re-exported at `select.ts` and `index.ts`:
 * - `SearchWebConfig` (re-exported as `WebConfig` at `select.ts`, the name
 *   importers use; the contract doesn't export `WebConfig`, which is web's
 *   config tag), `WebSearchProvider` and `searches`:
 *   `@socio/foundation/search/providers`. `searches` is pure and called by
 *   three other folders (capabilities, dots, web).
 *
 * Not here, on purpose:
 * - `ParallelProvider`, `SearxngProvider`: built only by `searchProviderFor`
 *   (and the tests); other folders get a provider from `WebSearch` below.
 * - `webSearchProvider` (`select.ts`): parses `WEB_SEARCH_PROVIDER`; only
 *   the entry (`index.ts`) reads it.
 * - `sourceSchema`, `sourcesFromData`, `sourcesFromResult` and
 *   `parallelSources`: only search and its tests use them.
 */
import { Context } from 'effect';

import type { SearchWebConfig } from '@socio/foundation/search/providers';

export type { SearchWebConfig, WebSearchProvider } from '@socio/foundation/search/providers';

// ── Providers (`provider.ts`) ────────────────────────────────────────────

/**
 * Public-web research behind one interface. A provider opens a session (one
 * connection per research call) that can `search` and, optionally, `read`
 * pages. Both return the provider's raw result shape,
 * `{results:[{url, title?, excerpts[]}], errors?, warnings?}`; `gatherSources`
 * validates and bounds it (at most 5 sources, 6,000 characters each).
 * Providers without `read` answer from their search excerpts and cannot read
 * a URL on request.
 */
export interface SearchData {
    results: unknown[];
    errors?: unknown[];
    warnings?: unknown[] | null;
}
export interface SearchSession {
    search(objective: string, queries: string[], signal: AbortSignal): Promise<SearchData>;
    read?(urls: string[], objective: string, queries: string[], signal: AbortSignal): Promise<SearchData>;
    close(): Promise<void>;
}
export interface SearchProvider {
    /** Shown to the model and the user, e.g. "Parallel". */
    readonly label: string;
    readonly canRead: boolean;
    open(sessionId: string, signal: AbortSignal): Promise<SearchSession>;
}
export interface WebSource {
    title: string;
    url: string;
    text: string;
}
export const MAX_SOURCES = 5;
export const MAX_SOURCE_CHARS = 6000;

/**
 * Thrown when a provider answers HTTP 429; the turn continues without sources.
 * A plain `Error`: callers check it with `instanceof`, and a tagged error
 * would change its name and `String()`.
 */
export class SearchRateLimitedError extends Error {
    constructor(label: string) {
        super(`${label} web search is rate-limited right now. Retry shortly, or continue without web sources.`);
        this.name = 'SearchRateLimitedError';
    }
}

/** One research call: what `gatherSources` searches for or reads. */
export interface GatherRequest {
    objective: string;
    urls?: string[];
    sessionId: string;
    searchQueries?: string[];
    onWarning?: (message: string) => void;
}

// ── WebSearch ────────────────────────────────────────────────────────────

/**
 * What dots and web call of search, with today's signatures. `index.ts`'s
 * `webSearch` implements it over `searchProviderFor` and `gatherSources`.
 * Whether search is on at all is `searches(config)` in
 * `@socio/foundation/search/providers`.
 */
export interface WebSearchShape {
    /**
     * The configured provider (`searchProviderFor`), or undefined when search
     * is off. Throws when SearXNG is chosen without `SEARXNG_URL`.
     */
    providerFor(config: SearchWebConfig): SearchProvider | undefined;
    /** Search (unless URLs are given), then read the sources, within one session (`gatherSources`). */
    gather(provider: SearchProvider, request: GatherRequest, signal: AbortSignal): Promise<WebSource[]>;
}

export class WebSearch extends Context.Service<WebSearch, WebSearchShape>()('socio/search/WebSearch') {}

// ── SearchConfig ─────────────────────────────────────────────────────────

/**
 * What search reads of the platform's configuration: `WEB_SEARCH_PROVIDER`,
 * `PARALLEL_API_KEY` and `SEARXNG_URL` (`PlatformConfig` extends it as
 * `WebConfig` today, from `select.ts`).
 */
export class SearchConfig extends Context.Service<SearchConfig, SearchWebConfig>()('socio/search/SearchConfig') {}
