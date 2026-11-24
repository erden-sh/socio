/**
 * The live views' construction: the change counters, synced once every module's
 * tables exist, as the last step of the graph (`composition/index.ts`).
 */
import { Effect, Layer } from 'effect';

import { CountersLive } from '../live/layer.js';

import { LegacyWorkspace } from './base.js';

/**
 * The live views' step of the graph, last: the live layer's `Counters`
 * (`live/layer.ts`) over the workspace's counters, which installs the
 * modules' change triggers as it is built (`counters.sync()`). Live reads
 * no `PlatformConfig` field, so it has no config tag.
 */
export const liveLayers = {
    counters: Layer.unwrap(
        Effect.gen(function* () {
            const workspace = yield* LegacyWorkspace;
            return CountersLive(workspace.counters);
        }),
    ),
};
