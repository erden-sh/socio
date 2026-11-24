import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { SearchWebConfig as WebConfig } from '@socio/foundation/search/providers';

import {
    SearchRateLimitedError,
    type GatherRequest,
    type SearchData,
    type SearchProvider,
    type SearchSession,
    type WebSource,
} from './contract.js';
import { gatherSources, sourcesFromData } from './provider.js';

/** Unwraps an MCP tool result into the provider's raw result shape. */
function dataFromResult(result: unknown): SearchData {
    const envelope = z
        .object({
            isError: z.boolean().optional(),
            structuredContent: z.unknown().optional(),
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        })
        .parse(result);
    if (envelope.isError) {
        throw new Error('Parallel could not complete the web request. Retry later or check the provider quota.');
    }
    let data = envelope.structuredContent;
    if (!data) {
        const text = envelope.content?.find((item) => item.type === 'text')?.text;
        try {
            data = JSON.parse(text ?? '');
        } catch {
            throw new Error('Parallel returned an invalid response.');
        }
    }
    return data as SearchData;
}
export function sourcesFromResult(result: unknown, warn: (message: string) => void = () => {}): WebSource[] {
    return sourcesFromData(dataFromResult(result), warn);
}

/**
 * Parallel's MCP endpoint (search.parallel.ai). Without PARALLEL_API_KEY it
 * uses the anonymous, rate-limited tier; HTTP 429 becomes
 * SearchRateLimitedError.
 */
export class ParallelProvider implements SearchProvider {
    readonly label = 'Parallel';
    readonly canRead = true;
    constructor(private config: WebConfig) {}
    async open(sessionId: string, signal: AbortSignal): Promise<SearchSession> {
        const client = new Client({ name: 'socio', version: '0.1.0' });
        let rateLimited = false;
        const transport = new StreamableHTTPClientTransport(new URL('https://search.parallel.ai/mcp'), {
            requestInit: this.config.parallelApiKey
                ? {
                      headers: {
                          Authorization: `Bearer ${this.config.parallelApiKey}`,
                      },
                  }
                : undefined,
            fetch: async (url, init) => {
                const response = await fetch(url, {
                    ...init,
                    signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
                });
                if (response.status === 429) {
                    rateLimited = true;
                }
                return response;
            },
        });
        const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
            try {
                return await fn();
            } catch (error) {
                if (rateLimited) {
                    throw new SearchRateLimitedError(this.label);
                }
                throw error;
            }
        };
        const call = (name: string, args: Record<string, unknown>, s: AbortSignal) =>
            limited(async () =>
                dataFromResult(
                    await client.callTool({ name, arguments: args }, undefined, {
                        signal: s,
                    }),
                ),
            );
        try {
            await limited(() => client.connect(transport));
        } catch (error) {
            await client.close().catch(() => {});
            throw error;
        }
        return {
            search: (objective, search_queries, s) =>
                call('web_search', { objective, search_queries, session_id: sessionId }, s),
            read: (urls, objective, search_queries, s) =>
                call('web_fetch', { urls, objective, search_queries, session_id: sessionId }, s),
            close: () => client.close(),
        };
    }
}

export async function parallelSources(
    request: Omit<GatherRequest, 'sessionId'> & { sessionId?: string },
    config: WebConfig,
    signal: AbortSignal,
): Promise<WebSource[]> {
    signal.throwIfAborted();
    if ((config.webSearchProvider ?? 'parallel') !== 'parallel') {
        throw new Error('Parallel web research is disabled.');
    }
    return gatherSources(
        new ParallelProvider(config),
        { ...request, sessionId: request.sessionId ?? randomUUID() },
        signal,
    );
}
