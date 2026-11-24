// Inference's layer: one registry behind `InferenceRegistry` and `Inference`,
// the settings resolvers, the views, the seed on first read, and the kinds'
// registration.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { inferenceConfig } from '../src/server/composition/inference.js';
import { Inference, InferenceConfig, InferenceViews, SettingsInference } from '../src/server/inference/contract.js';
import { registerInferenceKinds } from '../src/server/inference/kinds.js';
import { InferenceRegistry, inferenceLayer, InferenceSeedLive } from '../src/server/inference/layer.js';
import { settingsResolvers } from '../src/server/inference/openai-compatible.js';
import { operatorInferenceView } from '../src/server/inference/views.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup.splice(0).forEach((close) => close());
    vi.restoreAllMocks();
});

const SECRET = 'secret-0123456789abcdef-xyz';

function layer() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    return inferenceLayer(workspace.db, { secret: SECRET, log: () => {} });
}

it('declares InferenceViews under socio/inference', () => {
    expect(InferenceViews.key).toBe('socio/inference/InferenceViews');
    expect(InferenceRegistry.key).toBe('socio/inference/InferenceRegistry');
});

it('builds one registry, offered as InferenceRegistry and Inference', async () => {
    const program = Effect.gen(function* () {
        const registry = yield* InferenceRegistry;
        const inference = yield* Inference;
        return {
            same: registry === inference,
            settings: (yield* SettingsInference) === settingsResolvers,
            view: (yield* InferenceViews).operatorInferenceView === operatorInferenceView,
            state: yield* Effect.promise(() => operatorInferenceView(inference)),
        };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer())));
    expect(result.same).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.view).toBe(true);
    expect(result.state.backends).toEqual([]);
});

it('seeds the first backend from InferenceConfig on the first read', async () => {
    const config = inferenceConfig({
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'test-model',
        acceptsImages: false,
    } as unknown as PlatformConfig);
    const program = Effect.gen(function* () {
        const inference = yield* Inference;
        return yield* Effect.promise(() => inference.operatorState());
    });
    const seeded = InferenceSeedLive.pipe(
        Layer.provideMerge(layer()),
        Layer.provideMerge(Layer.succeed(InferenceConfig, config)),
    );
    const state = await Effect.runPromise(program.pipe(Effect.provide(seeded)));
    expect(state.backends.map((backend) => backend.label)).toEqual(['Self-hosted (test-model)']);
});

it('reads only the model settings out of the platform config', () => {
    const config = inferenceConfig({
        baseUrl: 'http://example.test/v1',
        apiKey: 'key',
        model: 'm',
        maxCompletionTokens: 10,
        titleModelOptions: { a: 1 },
        acceptsImages: true,
        maxImages: 2,
        contextWindow: 4096,
        sessionSecret: 'not inference config',
    } as unknown as PlatformConfig);
    expect(config).toEqual({
        baseUrl: 'http://example.test/v1',
        apiKey: 'key',
        model: 'm',
        maxCompletionTokens: 10,
        titleModelOptions: { a: 1 },
        acceptsImages: true,
        maxImages: 2,
        contextWindow: 4096,
    });
});

it('registers the bring-your-own kinds, the fake one only when its URL is set', () => {
    const ids = (env: Record<string, string | undefined>) => {
        const registered: string[] = [];
        registerInferenceKinds({ register: (kind) => void registered.push(kind.id) }, env);
        return registered;
    };
    expect(ids({})).toEqual(['byo-chatgpt', 'byo-claude-key']);
    expect(ids({ INFERENCE_FAKE_BYO_URL: 'http://127.0.0.1:9' })).toEqual([
        'byo-chatgpt',
        'byo-claude-key',
        'byo-fake',
    ]);
});
