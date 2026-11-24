// The inference contract: the tags other features will reach `inference/`
// through, the registry serving `Inference`, and the moved helpers, unchanged,
// at their packages (their old paths are gone).
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import * as chatGptErrors from '@socio/foundation/inference/chatgpt-errors';
import { connectionTurnError } from '@socio/foundation/inference/chatgpt-turn-error';

import { responsesHttpError } from '../src/server/inference/chatgpt/errors.js';
import { Inference, InferenceConfig, SettingsInference } from '../src/server/inference/contract.js';
import { settingsResolvers } from '../src/server/inference/openai-compatible.js';
import { InferenceService } from '../src/server/inference/service.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

it('declares its tags under socio/inference', () => {
    expect(Inference.key).toBe('socio/inference/Inference');
    expect(SettingsInference.key).toBe('socio/inference/SettingsInference');
    expect(InferenceConfig.key).toBe('socio/inference/InferenceConfig');
});

it('serves Inference with the registry as it is', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const registry = new InferenceService(workspace.db, { secret: 'secret-0123456789abcdef-xyz', log: () => {} });
    const program = Effect.gen(function* () {
        const inference = yield* Inference;
        return {
            registered: yield* Effect.promise(() => inference.registered()),
            shared: yield* Effect.promise(() => inference.shared()),
            resolution: yield* Effect.promise(() => inference.resolve({ purpose: 'title' })),
            sealStates: yield* Effect.promise(() => inference.store.sealStates()),
        };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(Inference, registry))));
    expect(result).toEqual({
        registered: false,
        shared: undefined,
        resolution: { ok: false, reason: 'ask_operator' },
        sealStates: { current: 0, previous: 0, legacy: 0, unknown: 0 },
    });
});

it('serves SettingsInference with the fixed-settings resolver', async () => {
    const program = Effect.gen(function* () {
        const settings = yield* SettingsInference;
        return yield* Effect.promise(() => settings.resolver({ baseUrl: '' }).resolve({ purpose: 'chat' }));
    });
    const result = await Effect.runPromise(
        program.pipe(Effect.provide(Layer.succeed(SettingsInference, settingsResolvers))),
    );
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
});

it('still parses provider answers into the moved error', () => {
    const error = responsesHttpError(400, JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
    expect(error).toBeInstanceOf(chatGptErrors.ChatGptError);
    expect(error.code).toBe('chatgpt_context_too_long');
    expect(connectionTurnError(error)).toMatchObject({ code: 'chatgpt_context_too_long', errorDetail: error.detail });
});
