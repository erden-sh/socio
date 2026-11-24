/**
 * Inference's layers: they implement `contract.ts`. Only the composition root
 * and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Inference, InferenceConfig, InferenceViews, SettingsInference } from './contract.js';
import { settingsResolvers } from './openai-compatible.js';
import { InferenceService, type InferenceServiceOptions } from './service.js';
import { operatorInferenceView } from './views.js';

/**
 * The registry itself, with the operator's and users' methods the
 * contract's slice leaves out (its routes; the composition holds it as the
 * class, `LegacyInference`). Other folders get `Inference`.
 */
export class InferenceRegistry extends Context.Service<InferenceRegistry, InferenceService>()(
    'socio/inference/InferenceRegistry',
) {}

/** The registry on the connection the boot step opened and migrated; built once. */
export const InferenceRegistryLive = (db: DatabaseSync, options: InferenceServiceOptions) =>
    Layer.sync(InferenceRegistry, () => new InferenceService(db, options));

/** `Inference`: the registry, as other folders call it. */
export const InferenceLive = Layer.effect(
    Inference,
    Effect.gen(function* () {
        return Inference.of(yield* InferenceRegistry);
    }),
);

/** `SettingsInference`: the fixed resolver from model settings. */
export const SettingsInferenceLive = Layer.succeed(SettingsInference, SettingsInference.of(settingsResolvers));

/** `InferenceViews`: the operator's view of the registry. */
export const InferenceViewsLive = Layer.succeed(InferenceViews, InferenceViews.of({ operatorInferenceView }));

/**
 * Inference's services: the registry (as `InferenceRegistry` and
 * `Inference`), `SettingsInference` and `InferenceViews`.
 */
export const inferenceLayer = (db: DatabaseSync, options: InferenceServiceOptions) =>
    Layer.mergeAll(InferenceLive, SettingsInferenceLive, InferenceViewsLive).pipe(
        Layer.provideMerge(InferenceRegistryLive(db, options)),
    );

/**
 * The environment's model settings (`InferenceConfig`) seed the first
 * backend, once, on the registry's first read.
 */
export const InferenceSeedLive = Layer.effectDiscard(
    Effect.gen(function* () {
        (yield* Inference).seedOnFirstUse(yield* InferenceConfig);
    }),
);
