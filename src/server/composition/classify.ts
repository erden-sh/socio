/**
 * The classification seam's construction: its layer (`classify/layer.ts`), made
 * once at this step of the graph, with `ClassifyConfig` built here from the
 * startup configuration (`LegacyConfig`; environment parsing is to move into
 * composition). The module's hooks and Learning's triage read the same seam
 * (`ClassifyHost`) from the app's services.
 */
import { Effect, Layer } from 'effect';

import { ClassifyConfig } from '../classify/contract.js';
import { ClassifyLive } from '../classify/layer.js';

import { LegacyConfig, LegacyModuleContext } from './base.js';

/**
 * The seam's step of the graph: `Seam`, `Labels`, `ClassifyConfig` and
 * `ClassifyHost`, the seam made on the modules' connection, with no I/O.
 * The platform's module hooks and Learning's triage read the same seam.
 */
export const classifyLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            const context = yield* LegacyModuleContext;
            const config = yield* LegacyConfig;
            return ClassifyLive({ db: context.db, log: context.log }).pipe(
                Layer.provideMerge(
                    Layer.succeed(ClassifyConfig, { classify: config.classify, operations: config.operations }),
                ),
            );
        }),
    ),
};
