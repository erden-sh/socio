/**
 * Storage's construction: the layer `storage/layer.ts` implements its tags with
 * (the object stores' makers and the file moves), and `StorageConfig` from the
 * startup configuration. Nothing to build, start or stop.
 */
import { Effect, Layer } from 'effect';

import { StorageConfig } from '../storage/contract.js';
import { StorageLive } from '../storage/layer.js';

import { LegacyConfig } from './base.js';

/**
 * What storage reads of the configuration: `config.storage` as the process
 * entry read it (`STORAGE_DRIVER`, `TENANT_ID`, `S3_*`), or as a test's
 * config sets it; unset means the local disk.
 */
const StorageConfigLive = Layer.effect(
    StorageConfig,
    Effect.gen(function* () {
        return { settings: (yield* LegacyConfig).storage };
    }),
);

/**
 * Storage's step of the graph: `ObjectStores`, `FileMoves` and
 * `StorageConfig`. One layer value, so the data spaces' step, which
 * provides it too, shares the build.
 */
export const storageLayers = {
    bridges: Layer.mergeAll(StorageLive, StorageConfigLive),
};
