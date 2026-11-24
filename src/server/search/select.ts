import type { WebSearchProvider } from '@socio/foundation/search/providers';

const PLANNED = ['brave', 'tavily'];

/** Parses WEB_SEARCH_PROVIDER; empty means Parallel. */
export function webSearchProvider(value?: string): WebSearchProvider {
    const name = value?.trim().toLowerCase();
    if (!name) {
        return 'parallel';
    }
    if (name === 'parallel' || name === 'searxng' || name === 'disabled') {
        return name;
    }
    if (name === 'browser') {
        throw new Error(
            "WEB_SEARCH_PROVIDER=browser was removed with the standalone browser service (CB-319): socios read pages with their computer's browser. Use parallel, searxng, or disabled.",
        );
    }
    if (PLANNED.includes(name)) {
        throw new Error(
            `WEB_SEARCH_PROVIDER=${name} is planned but not available yet. Use parallel, searxng, or disabled.`,
        );
    }
    throw new Error('WEB_SEARCH_PROVIDER must be parallel, searxng, or disabled.');
}
