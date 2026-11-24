/**
 * Web search's layer: `WebSearch` serves today's functions, and `SearchConfig`
 * keeps only search's three fields of the supplied configuration, whatever the
 * environment says.
 */
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LegacyConfig } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { searchLayers } from '../src/server/composition/search.js';
import { SearchConfig, WebSearch } from '../src/server/search/contract.js';
import { gatherSources, searchProviderFor } from '../src/server/search/index.js';
import { SearchLive, webSearch } from '../src/server/search/layer.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

it('serves the WebSearch tag with the existing functions', async () => {
    const served = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* WebSearch;
        }).pipe(Effect.provide(SearchLive({ webSearchProvider: 'disabled' }))),
    );
    expect(served).toBe(webSearch);
    expect(served.providerFor).toBe(searchProviderFor);
    expect(served.gather).toBe(gatherSources);
    expect(served.providerFor({ webSearchProvider: 'disabled' })).toBeUndefined();
});

it('builds SearchConfig from the supplied config, not the environment', async () => {
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'parallel');
    vi.stubEnv('SEARXNG_URL', 'http://env.invalid');
    const config = {
        webSearchProvider: 'searxng',
        searxngUrl: 'http://searxng.invalid',
        parallelApiKey: undefined,
        dataDir: '/tmp/not-read',
    } as unknown as PlatformConfig;
    const read = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* SearchConfig;
        }).pipe(Effect.provide(searchLayers.bridges.pipe(Layer.provide(Layer.succeed(LegacyConfig, config))))),
    );
    expect(read).toEqual({
        webSearchProvider: 'searxng',
        parallelApiKey: undefined,
        searxngUrl: 'http://searxng.invalid',
    });
});
