/**
 * Web search's construction: `search/layer.ts` offers `WebSearch`, and
 * `SearchConfig` built here from the startup configuration (`LegacyConfig`, not
 * the environment; moving environment parsing into composition is a later
 * change). Search has no routes and nothing to start or stop.
 */
import { Effect, Layer } from 'effect';

import { SearchLive } from '../search/layer.js';

import { LegacyConfig } from './base.js';

/** Web search's step of the graph: `WebSearch`, and `SearchConfig` from the config. */
export const searchLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            return SearchLive(yield* LegacyConfig);
        }),
    ),
};
