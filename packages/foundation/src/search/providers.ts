// Moved from `src/server/search/select.ts` (the types) and
// `src/server/search/index.ts` (`searches`), which re-export them.

/** `WEB_SEARCH_PROVIDER`: who answers a socio's web research. */
export type WebSearchProvider = 'parallel' | 'searxng' | 'disabled';

/**
 * What web search reads of the platform's configuration. `select.ts` and
 * `index.ts` re-export it as `WebConfig`; the contract names it
 * `SearchWebConfig` so it doesn't clash with web's `WebConfig` tag.
 */
export interface SearchWebConfig {
    webSearchProvider?: WebSearchProvider;
    parallelApiKey?: string;
    searxngUrl?: string;
}

/** Providers that answer search_web (as opposed to the URL-only browser). */
export const searches = (config: SearchWebConfig) =>
    ['parallel', 'searxng'].includes(config.webSearchProvider ?? 'parallel');
