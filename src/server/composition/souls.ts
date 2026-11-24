/**
 * Souls' construction: the workspace's soul store, which `WorkspaceStore` still
 * builds (moving construction here is a later change), offered as `Souls`, and
 * the souls layer's `SoulTools` over it (`souls/layer.ts`). Souls reads no startup configuration,
 * so there is no `SoulsConfig` to build; it has no routes of its own outside
 * the workspace's and nothing to start or stop.
 */
import { Effect, Layer } from 'effect';

import { Souls } from '../souls/contract.js';
import { SoulToolsLive } from '../souls/layer.js';

import { LegacyWorkspace } from './base.js';

/** The workspace's soul store (`WorkspaceStore.souls`), as `Souls`. */
const SoulsFromWorkspace = Layer.effect(
    Souls,
    Effect.gen(function* () {
        return (yield* LegacyWorkspace).souls;
    }),
);

/**
 * Souls' step of the graph: `Souls`, the workspace's store, and
 * `SoulTools` over it and the workspace's slices. Nothing is built here
 * and nothing takes a listener, so the step changes no order.
 */
export const soulsLayers = {
    bridges: SoulToolsLive.pipe(Layer.provideMerge(SoulsFromWorkspace)),
};
