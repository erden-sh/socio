import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, it, vi } from 'vitest';

import { SearchRateLimitedError } from '../src/server/search/contract.js';
import { gatherSources, searchProviderFor, webSearchProvider } from '../src/server/search/index.js';
import { ParallelProvider } from '../src/server/search/parallel.js';
import { SearxngProvider } from '../src/server/search/searxng.js';

const servers: Server[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
const signal = new AbortController().signal;

async function fakeSearxng(handler: (url: URL) => { status?: number; body?: unknown }) {
    const seen: URL[] = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url!, 'http://localhost');
        seen.push(url);
        const { status = 200, body = {} } = handler(url);
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/searxng`, seen };
}

it('selects providers by setting and explains unknown or planned values', () => {
    expect(webSearchProvider(' SearXNG ')).toBe('searxng');
    expect(() => webSearchProvider('brave')).toThrow(/planned/);
    expect(() => webSearchProvider('bing')).toThrow('WEB_SEARCH_PROVIDER must be parallel, searxng, or disabled.');
    expect(searchProviderFor({})).toBeInstanceOf(ParallelProvider);
    expect(searchProviderFor({ webSearchProvider: 'disabled' })).toBeUndefined();
    expect(() => webSearchProvider('browser')).toThrow(/removed with the standalone browser service/);
    expect(() => searchProviderFor({ webSearchProvider: 'searxng' })).toThrow('SEARXNG_URL');
});

it('answers from SearXNG search snippets, bounded and deduplicated', async () => {
    const fake = await fakeSearxng((url) => ({
        body: {
            results: [
                {
                    url: `https://example.com/${url.searchParams.get('q')}`,
                    title: 'Result',
                    content: 'x'.repeat(7000),
                },
                { url: 'https://shared.example', content: 'Shared' },
                { url: 'ftp://bad.example', content: 'Not http' },
                { url: 'https://empty.example' },
            ],
        },
    }));
    const provider = new SearxngProvider(fake.url);
    const warnings: string[] = [];
    const sources = await gatherSources(
        provider,
        {
            objective: 'SQLite WAL',
            searchQueries: ['wal mode', 'checkpoints'],
            sessionId: 'thread',
            onWarning: (message) => warnings.push(message),
        },
        signal,
    );
    expect(fake.seen.map((url) => url.pathname)).toEqual(['/searxng/search', '/searxng/search']);
    expect(fake.seen.map((url) => url.searchParams.get('format'))).toEqual(['json', 'json']);
    // Only the queries leave the server; no session or objective.
    expect([...fake.seen[0].searchParams.keys()].sort()).toEqual(['format', 'q']);
    expect(sources.map((s) => s.url)).toEqual([
        'https://example.com/wal mode',
        'https://shared.example',
        'https://example.com/checkpoints',
    ]);
    expect(sources[0].text).toHaveLength(6000);
    expect(warnings.join(' ')).toMatch(/malformed or empty/);
});

it('reports SearXNG rate limits, a disabled JSON API, and page reads it cannot do', async () => {
    const limited = await fakeSearxng(() => ({ status: 429 }));
    await expect(
        gatherSources(new SearxngProvider(limited.url), { objective: 'x', sessionId: 's' }, signal),
    ).rejects.toBeInstanceOf(SearchRateLimitedError);
    const forbidden = await fakeSearxng(() => ({ status: 403 }));
    await expect(
        gatherSources(new SearxngProvider(forbidden.url), { objective: 'x', sessionId: 's' }, signal),
    ).rejects.toThrow('Enable the json format');
    await expect(
        gatherSources(
            new SearxngProvider(forbidden.url),
            { objective: 'x', urls: ['https://example.com'], sessionId: 's' },
            signal,
        ),
    ).rejects.toThrow('SearXNG cannot read a specific page');
});

it("turns Parallel's anonymous-tier 429 into a retry-shortly error", async () => {
    const fetch = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response(JSON.stringify({ error: 'Too many requests' }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            }),
    );
    vi.stubGlobal('fetch', fetch);
    const error = await gatherSources(
        new ParallelProvider({}),
        { objective: 'Research', sessionId: 's' },
        signal,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchRateLimitedError);
    expect((error as Error).message).toBe(
        'Parallel web search is rate-limited right now. Retry shortly, or continue without web sources.',
    );
    expect(String(fetch.mock.calls[0][0])).toBe('https://search.parallel.ai/mcp');
});
