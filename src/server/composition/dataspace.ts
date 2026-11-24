/**
 * The data spaces' construction: the layer `dataspace/layer.ts` implements its
 * tags with, wired into the graph at the step the server has always built it
 * at.
 */
import { Effect, Layer } from 'effect';

import { DataConfig, DataCounters } from '../dataspace/contract.js';
import { DataLive, DataSpaceBoot } from '../dataspace/layer.js';
import { Counters } from '../live/contract.js';
import { dataOverrides } from '../settings/limits.js';

import { LegacyConfig, LegacyStore, LegacyWorkspace } from './base.js';
import { PlatformKeys } from './keys.js';

/**
 * The data spaces as other features' builders take them (the class): the
 * same object `Data` offers.
 */
export { DataSpaceInstance as LegacyData } from '../dataspace/layer.js';

/**
 * What the data space reads of the configuration: `DATA_*` and
 * `USER_DATA_DIR`, as the process entry read them from the environment
 * (`dataSettingsFromEnv`, whose default directory is beside the
 * database), or as a test's config sets them.
 */
const DataConfigLive = Layer.effect(
    DataConfig,
    Effect.gen(function* () {
        return { data: (yield* LegacyConfig).data };
    }),
);

/** The boot step's connection, the data keyring and the limits saved in Settings. */
const DataSpaceBootLive = Layer.effect(
    DataSpaceBoot,
    Effect.gen(function* () {
        const store = yield* LegacyStore;
        return {
            db: (yield* LegacyWorkspace).db,
            keys: (yield* PlatformKeys).keys,
            overrides: () => dataOverrides(store.slices.settings.settings()),
        };
    }),
);

/**
 * The data spaces' step of the graph: `Data`, `DataspaceViews`, the class
 * (`LegacyData`) and `DataConfig`. Storage's tags and the runtime identity
 * are the graph's leaf bridges, built before every step.
 */
export const dataspaceLayers = {
    data: DataLive.pipe(Layer.provideMerge(DataConfigLive), Layer.provide(DataSpaceBootLive)),
    /**
     * The data routes' change counters (`DataCounters`, CB-451), over live's
     * once they exist: a bridge, built after every service, starting nothing.
     */
    bridges: Layer.effect(
        DataCounters,
        Effect.gen(function* () {
            return yield* Counters;
        }),
    ),
};
