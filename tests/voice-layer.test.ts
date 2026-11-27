// Voice's tags are implemented by its layers (`voice/layer.ts`). `Voice` is
// built from the tags it reads (the workspace's slices, `WorkspaceSettings`,
// `Approvals`, voice's own tags and `VoiceHost`); `Transcription` reads
// `VoiceConfig` and the saved key at each call; the server's graph offers
// `TranscriptionSecrets`, `Dictation`, `Transcription` and `VoiceConfig`, the
// last from the supplied startup config, and `Platform` holds the same key
// store and relays.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { LegacyTranscriptionKeys } from '../src/server/composition/voice.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import {
    Dictation,
    Transcription,
    TranscriptionSecrets,
    Voice,
    VoiceConfig,
    type DictationShape,
    type TranscriptionSecretsShape,
} from '../src/server/voice/contract.js';
import { TranscriptionLive, VoiceHost, VoiceLive, type VoiceHostShape } from '../src/server/voice/layer.js';
import { VoiceService } from '../src/server/voice/voice.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function stores() {
    const store = new Store(testDatabase());
    const ws = new WorkspaceStore(testDatabase());
    cleanup.push(() => {
        store.close();
        ws.close();
    });
    return { store, ws };
}

const dictation = (): DictationShape => ({
    recordingsOnly: () => false,
    forget: () => {},
    admit: () => undefined,
    start: () => {},
    closeAll: vi.fn(),
});

const keys = (saved?: { url: string; key: string }): TranscriptionSecretsShape => ({
    seal: () => ({ value: '' }),
    read: vi.fn(() => saved),
    sealStates: () => ({ current: 0, previous: 0, legacy: 0, unknown: 0 }),
    reseal: async () => ({ resealed: 0, unreadable: 0 }),
});

it('Transcription reads VoiceConfig and the saved key at each call', async () => {
    const secrets = keys({ url: 'https://stt.example.invalid', key: 'saved' });
    const streams = dictation();
    const runtime = ManagedRuntime.make(
        TranscriptionLive(secrets, streams).pipe(
            Layer.provide(
                Layer.succeed(VoiceConfig, {
                    voiceKey: 'cloud',
                    voiceName: 'marin',
                    transcription: { url: 'https://env.example.invalid', model: 'm', streaming: 'off' },
                }),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    expect(Context.get(context, TranscriptionSecrets)).toBe(secrets);
    expect(Context.get(context, Dictation)).toBe(streams);
    const transcription = Context.get(context, Transcription);
    expect(secrets.read).not.toHaveBeenCalled();
    expect(transcription.sources()).toEqual({
        transcription: { url: 'https://env.example.invalid', model: 'm', streaming: 'off' },
        voiceKey: 'cloud',
        savedKey: { url: 'https://stt.example.invalid', key: 'saved' },
    });
    transcription.sources();
    expect(secrets.read).toHaveBeenCalledTimes(2);
});

it('builds VoiceService from the tags it reads, each read at the moment of use', async () => {
    const { store, ws } = stores();
    ws.bindThread('thread', ws.dots()[0].id, 'A conversation', 'owner');
    ws.setPreferences('owner', { dictationLanguage: 'es' });
    const onPending = vi.fn<ApprovalsShape['onPending']>();
    const streams = dictation();
    const sources = vi.fn(() => ({ voiceKey: 'cloud' }));
    const host: VoiceHostShape = {
        requireReady: vi.fn(async () => {}),
        setup: vi.fn(async () => ({
            voice: true,
            model: true,
            browser: false,
            telegram: 'not_configured' as const,
            missing: [],
        })),
        history: vi.fn(async () => ''),
        turn: vi.fn(async () => 'answer'),
        turnOutcome: vi.fn(),
        draining: () => false,
        profileLanguage: vi.fn(async () => undefined),
    };
    const runtime = ManagedRuntime.make(
        VoiceLive().pipe(
            Layer.provide(
                Layer.mergeAll(
                    WorkspaceLive(ws),
                    Layer.succeed(WorkspaceSettings, store.slices.settings),
                    Layer.succeed(Approvals, { onPending } as unknown as ApprovalsShape),
                    Layer.succeed(VoiceConfig, { voiceName: 'marin' }),
                    Layer.succeed(Dictation, streams),
                    Layer.succeed(Transcription, { sources }),
                    Layer.succeed(VoiceHost, host),
                ),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const voice = await runtime.runPromise(
        Effect.gen(function* () {
            return yield* Voice;
        }),
    );
    expect(voice).toBeInstanceOf(VoiceService);
    // Its approvals listener, once, as it is built.
    expect(onPending).toHaveBeenCalledTimes(1);
    // Live text is the Dictation tag's.
    expect(voice.streams).toBe(streams);
    // The People slice: the person's dictation language.
    expect(voice.dictationLanguage('owner')).toBe('es');
    // Settings, at the moment of use: a pause stops dictation.
    expect(sources).not.toHaveBeenCalled();
    await store.updateSettings({ paused: true });
    expect(() => voice.dictationProvider()).toThrow();
    expect(sources).toHaveBeenCalled();
    // VoiceConfig: no VOICE_BACKEND, so cloud calls.
    expect(voice.backend()).toBe('cloud');
    // The host's readiness and setup, at the moment of use.
    await store.updateSettings({ paused: false });
    await expect(voice.begin('thread', 'not sdp', new AbortController().signal)).rejects.toThrow(
        'An audio WebRTC SDP offer is required.',
    );
    expect(host.requireReady).toHaveBeenCalledTimes(1);
    expect(host.setup).toHaveBeenCalledTimes(1);
});

it("the server's graph offers voice's tags: Platform holds the same key store and relays", async () => {
    // The supplied config wins over the environment (moving environment parsing here is a later change).
    vi.stubEnv('VOICE_NAME', 'from-env');
    const { store, ws } = stores();
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceKey: 'cloud-key',
            voiceModel: 'voice-model',
            voiceName: 'cedar',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [],
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const { secrets, legacy, streams, transcription, config } = await runtime.runPromise(
        Effect.gen(function* () {
            return {
                secrets: yield* TranscriptionSecrets,
                legacy: yield* LegacyTranscriptionKeys,
                streams: yield* Dictation,
                transcription: yield* Transcription,
                config: yield* VoiceConfig,
            };
        }),
    );
    expect(secrets).toBe(legacy);
    expect(platform.transcriptionKeys).toBe(legacy);
    expect(streams).toBe(platform.dictationStreams);
    expect(config).toEqual({
        voiceKey: 'cloud-key',
        voiceModel: 'voice-model',
        voiceName: 'cedar',
        transcription: undefined,
        voiceCalls: undefined,
    });
    expect(transcription.sources()).toEqual(platform.transcriptionSources());
});
