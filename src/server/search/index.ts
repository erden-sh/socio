import type { SearchWebConfig as WebConfig } from '@socio/foundation/search/providers';

import type { SearchProvider } from './contract.js';
import { ParallelProvider } from './parallel.js';
import { SearxngProvider } from './searxng.js';

export * from './provider.js';
export * from './select.js';

/** The configured search provider, or undefined when search is off. */
export function searchProviderFor(config: WebConfig): SearchProvider | undefined {
    const kind = config.webSearchProvider ?? 'parallel';
    if (kind === 'parallel') {
        return new ParallelProvider(config);
    }
    if (kind === 'searxng') {
        if (!config.searxngUrl?.trim()) {
            throw new Error('SearXNG is not configured: set SEARXNG_URL.');
        }
        return new SearxngProvider(config.searxngUrl.trim());
    }
    return undefined;
}
