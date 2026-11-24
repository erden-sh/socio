import { z } from 'zod';

import {
    MAX_SOURCES,
    SearchRateLimitedError,
    type SearchData,
    type SearchProvider,
    type SearchSession,
} from './contract.js';

const response = z.object({
    results: z
        .array(
            z.object({
                url: z.string(),
                title: z.string().optional(),
                content: z.string().optional(),
            }),
        )
        .default([]),
});

/**
 * A self-hosted SearXNG instance (`SEARXNG_URL`, JSON API enabled with
 * `search.formats: [html, json]`). Best effort: it returns search snippets as
 * excerpts and cannot read a page on request. Only queries go to SearXNG.
 */
export class SearxngProvider implements SearchProvider {
    readonly label = 'SearXNG';
    readonly canRead = false;
    constructor(
        private baseUrl: string,
        private transport: typeof fetch = fetch,
    ) {}
    async open(_sessionId: string, signal: AbortSignal): Promise<SearchSession> {
        const query = async (q: string, s: AbortSignal) => {
            const url = new URL('search', this.baseUrl.replace(/\/?$/, '/'));
            url.searchParams.set('q', q);
            url.searchParams.set('format', 'json');
            const reply = await this.transport(url, {
                headers: { Accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.any([signal, s]),
            });
            if (reply.status === 429) {
                throw new SearchRateLimitedError(this.label);
            }
            if (!reply.ok) {
                throw new Error(
                    reply.status === 403
                        ? 'SearXNG refused the JSON API. Enable the json format in its settings.'
                        : `SearXNG search failed (HTTP ${reply.status}).`,
                );
            }
            return response.parse(await reply.json()).results;
        };
        return {
            async search(_objective, queries, s): Promise<SearchData> {
                const results = (await Promise.all(queries.slice(0, 3).map((q) => query(q, s)))).flat();
                return {
                    results: results.slice(0, MAX_SOURCES * 3).map((item) => ({
                        url: item.url,
                        title: item.title ?? null,
                        excerpts: item.content ? [item.content] : [],
                    })),
                };
            },
            close: async () => {},
        };
    }
}
