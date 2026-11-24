import { Context, Effect, Layer } from 'effect';

/**
 * Inference's construction: its layer (`inference/layer.ts`) on the boot step's
 * connection and the data keyring, and its config.
 */
import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { Inference, InferenceConfig, type InferenceConfigShape, type InferenceShape } from '../inference/contract.js';
import { InferenceRegistry, inferenceLayer, InferenceSeedLive } from '../inference/layer.js';
import { type InferenceServiceOptions } from '../inference/service.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';

/** The registry's options: the data keyring it seals with, and its log. */
const inferenceOptions = (keys: DataKeyring): InferenceServiceOptions => ({
    secret: keys,
    log: (line) => console.log(line),
});

/**
 * `InferenceConfig`: the model settings the environment gave the process
 * (`modelSettingsFromEnv`), which seed the first backend.
 */
export function inferenceConfig(config: PlatformConfig): InferenceConfigShape {
    return {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        maxCompletionTokens: config.maxCompletionTokens,
        titleModelOptions: config.titleModelOptions,
        acceptsImages: config.acceptsImages,
        maxImages: config.maxImages,
        contextWindow: config.contextWindow,
    };
}

/** Background work runs on the default shared backend, or waits. */
export function sharedBackend(inference: InferenceShape) {
    return async () => (await inference.shared())?.chatCompletions;
}
export type SharedBackend = ReturnType<typeof sharedBackend>;

/**
 * Inference, as the steps that still take the class hold it:
 * inference's own `InferenceRegistry` tag, under its old name.
 */
export const LegacyInference = InferenceRegistry;

/** The default shared backend's completions, for background work. */
export class LegacySharedBackend extends Context.Service<LegacySharedBackend, SharedBackend>()(
    'socio/composition/inference/SharedBackend',
) {}

/**
 * Inference's steps of the graph, in the graph's order: its layer (the
 * registry as `InferenceRegistry` and `Inference`, `SettingsInference`,
 * `InferenceViews`) with `InferenceConfig`, then, much later, the
 * environment's seed and the shared backend.
 */
export const inferenceLayers = {
    inference: Layer.unwrap(
        Effect.gen(function* () {
            const config = inferenceConfig(yield* LegacyConfig);
            const workspace = yield* LegacyWorkspace;
            const { keys } = yield* PlatformKeys;
            return inferenceLayer(workspace.db, inferenceOptions(keys)).pipe(
                Layer.provideMerge(Layer.succeed(InferenceConfig, InferenceConfig.of(config))),
            );
        }),
    ),
    seed: InferenceSeedLive,
    shared: Layer.effect(
        LegacySharedBackend,
        Effect.gen(function* () {
            return sharedBackend(yield* Inference);
        }),
    ),
};
