import { expect, it } from 'vitest';

import { modelSettingsFromEnv, setupStatus, type PlatformConfig } from '../src/server/composition/config.js';

const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://example.com',
    runtimeUrl: '',
    voiceName: 'marin',
};
it('requires the model and disables voice when the model is absent', () => {
    expect(
        setupStatus({
            ...config,
            model: '',
            voiceKey: 'fixture',
            voiceModel: 'fixture',
        }),
    ).toMatchObject({ missing: ['OPENAI_MODEL'], model: false, voice: false });
    expect(setupStatus({ ...config, voiceKey: 'fixture', voiceModel: 'fixture' })).toEqual({
        model: true,
        voice: true,
        // Calls (CB-265): cloud by default; no speech server for self-hosted.
        voiceBackend: 'cloud',
        voiceCloud: true,
        voiceSpeech: false,
        transcription: true,
        // OpenAI's URL: recordings only, no live text (CB-222).
        transcriptionStreaming: false,
        telegram: 'not_configured',
        missing: [],
    });
});

it('reports a missing model endpoint instead of defaulting to a hosted provider', () => {
    expect(setupStatus({ ...config, baseUrl: '' })).toMatchObject({
        missing: ['OPENAI_BASE_URL'],
        model: false,
    });
    expect(modelSettingsFromEnv({}).baseUrl).toBe('');
});
it('reads OpenAI-compatible model settings and an optional completion cap', () => {
    expect(
        modelSettingsFromEnv({
            OPENAI_BASE_URL: ' http://model.example.test:8016/v1 ',
            OPENAI_API_KEY: 'unused-by-server',
            OPENAI_MODEL: 'qwen38-flash',
            MODEL_MAX_COMPLETION_TOKENS: '8192',
        }),
    ).toEqual({
        baseUrl: 'http://model.example.test:8016/v1',
        apiKey: 'unused-by-server',
        model: 'qwen38-flash',
        maxCompletionTokens: 8192,
        acceptsImages: false,
    });
    expect(modelSettingsFromEnv({ MODEL_ACCEPTS_IMAGES: ' TRUE ' }).acceptsImages).toBe(true);
    expect(modelSettingsFromEnv({ MODEL_MAX_IMAGES: '6' }).maxImages).toBe(6);
    expect(() => modelSettingsFromEnv({ MODEL_MAX_IMAGES: '0' })).toThrow('MODEL_MAX_IMAGES');
    expect(modelSettingsFromEnv({ OPENAI_API_KEY: ' ', OPENAI_MODEL: '' })).toMatchObject({
        apiKey: undefined,
        model: undefined,
    });
    for (const value of ['0', '-5', '1.5', 'many']) {
        expect(() => modelSettingsFromEnv({ MODEL_MAX_COMPLETION_TOKENS: value })).toThrow(
            'MODEL_MAX_COMPLETION_TOKENS must be a positive integer.',
        );
    }
});
