// Moved from `src/server/web/research.ts`: the research
// config and whether a live run has what it needs, which the shell's state
// view (`live/views/state.ts`) reports as well.
import type { SearchWebConfig } from '../search/providers.js';

/** What a research task reads of the platform's configuration. */
export interface ResearchConfig extends SearchWebConfig {
    mode: 'sample' | 'live';
    apiKey?: string;
    baseUrl: string;
    model?: string;
    maxCompletionTokens?: number;
}

/** Whether a live research run has what it needs (a sample one always does). */
export function configured(config: ResearchConfig): boolean {
    return (
        config.mode === 'sample' ||
        Boolean(
            config.baseUrl &&
            config.apiKey &&
            config.model &&
            ((config.webSearchProvider ?? 'parallel') === 'parallel' ||
                (config.webSearchProvider === 'searxng' && config.searxngUrl)),
        )
    );
}
