/**
 * Storage's layer: its tags (`contract.ts`) over the implementations in
 * `services.ts`. `ObjectStores` makes a store as today's constructors do;
 * `FileMoves` runs today's two functions. Neither reads configuration or
 * another feature, so the layer needs nothing; the composition
 * (`composition/storage.ts`) adds `StorageConfig` from the startup
 * configuration. Only the composition and tests import this file.
 */
import { Layer } from 'effect';

import { FileMoves, ObjectStores } from './contract.js';
import { fileMoves, objectStores } from './services.js';

/** `ObjectStores` and `FileMoves`; needs nothing. */
export const StorageLive = Layer.mergeAll(
    Layer.succeed(ObjectStores, objectStores),
    Layer.succeed(FileMoves, fileMoves),
);
