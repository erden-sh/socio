/**
 * Web search's layer: `WebSearch` over today's functions (`searchProviderFor`,
 * `gatherSources`), and `SearchConfig` from the configuration the composition
 * supplies. Search needs nothing from other features. Only the composition
 * (`composition/search.ts`) and tests import this file.
 */
import { Layer } from 'effect';

import { SearchConfig, WebSearch, type SearchWebConfig, type WebSearchShape } from './contract.js';
import { searchProviderFor } from './index.js';
import { gatherSources } from './provider.js';

/** The `WebSearch` tag's implementation (`contract.ts`): today's functions. */
export const webSearch: WebSearchShape = {
    providerFor: searchProviderFor,
    gather: gatherSources,
};

/** `WebSearch`: stateless, nothing to build or release. */
export const WebSearchLive = Layer.succeed(WebSearch, webSearch);

/**
 * `SearchConfig` from the supplied configuration's `WEB_SEARCH_PROVIDER`,
 * `PARALLEL_API_KEY` and `SEARXNG_URL` (only those three fields are kept).
 */
export const SearchConfigLive = (config: SearchWebConfig) =>
    Layer.succeed(SearchConfig, {
        webSearchProvider: config.webSearchProvider,
        parallelApiKey: config.parallelApiKey,
        searxngUrl: config.searxngUrl,
    });

/** Everything search offers: `WebSearch` and `SearchConfig`. */
export const SearchLive = (config: SearchWebConfig) => Layer.merge(WebSearchLive, SearchConfigLive(config));
