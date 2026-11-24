import { Context, Effect, Layer } from 'effect';

/**
 * Voice's construction: voice's steps of the graph, which offer voice's tags
 * through the voice layers (`voice/layer.ts`).
 */
import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';

import type { SecretSettingsShape } from '../settings/contract.js';
import { Dictation, Voice, VoiceConfig, type VoiceConfigShape } from '../voice/contract.js';
import { transcriptionKeys, voiceContext, VoiceHost, voiceService } from '../voice/layer.js';
import type { TranscriptionKeys } from '../voice/transcription.js';
import type { VoiceService } from '../voice/voice.js';

import { ConversationAdmin } from './app/conversations.js';
import { AppStatus } from './app/status.js';
import { AppTurns } from './app/turns.js';
import { LegacyConfig, LegacyStore } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';
import { Ports } from './ports.js';

/** The key an admin sets for the transcription server (CB-204), sealed. */
export function buildTranscriptionKeys(store: SecretSettingsShape, keys: DataKeyring): TranscriptionKeys {
    return transcriptionKeys(store, new SecretBox(keys, 'settings-secrets'));
}

/** The transcription key's store, under the graph's `LegacyTranscriptionKeys` tag. */
export class LegacyTranscriptionKeys extends Context.Service<LegacyTranscriptionKeys, TranscriptionKeys>()(
    'socio/composition/voice/TranscriptionKeys',
) {}

/**
 * What voice reads of the startup configuration (the `PlatformConfig` the
 * boot step built, not the environment again; moving env parsing here is a
 * later change):
 * `VOICE_API_KEY`, `VOICE_MODEL`, `VOICE_NAME`, `VOICE_TRANSCRIBE_*` and
 * `VOICE_BACKEND` with `VOICE_SPEECH_*`.
 */
export function voiceConfigOf(
    config: Pick<PlatformConfig, 'voiceKey' | 'voiceModel' | 'voiceName' | 'transcription' | 'voiceCalls'>,
): VoiceConfigShape {
    return {
        voiceKey: config.voiceKey,
        voiceModel: config.voiceModel,
        voiceName: config.voiceName,
        transcription: config.transcription,
        voiceCalls: config.voiceCalls,
    };
}

/**
 * Voice's step of the graph: the transcription key's store
 * (offered as `TranscriptionSecrets`, and as `LegacyTranscriptionKeys` for
 * the data keys and the app's status), live dictation's relays (`Dictation`, read from its leaf
 * step, `composition/app/dictation.ts`, and offered again as the same
 * instance; the shutdown closes them), the transcription sources
 * (`Transcription`), and `VoiceConfig` from the supplied startup
 * configuration. Built at the same point of the chain as before.
 *
 * `voice`, the graph's last step: calls and dictation (`Voice`,
 * and `LegacyVoice` for the HTTP edge's routes), over the workspace's and
 * settings' tags and `VoiceHost`. It registers its approvals listener as
 * it is built, as `new VoiceService(platform)` did when the HTTP edge
 * built it after the graph: no listener on the approvals is registered in
 * between, so it is still the last one.
 */
/** Calls and dictation, as the HTTP edge's routes take them (the class). */
export class LegacyVoice extends Context.Service<LegacyVoice, VoiceService>()('socio/composition/voice/VoiceService') {}

/**
 * `VoiceHost` over the app's services: the
 * turns (`AppTurns`), the history (`ConversationAdmin`), readiness and
 * setup (`AppStatus`) and the drain's port, each read at the moment of use,
 * as `new VoiceService(platform)` read them.
 */
const VoiceHostLive = Layer.effect(
    VoiceHost,
    Effect.gen(function* () {
        const turns = yield* AppTurns;
        const conversations = yield* ConversationAdmin;
        const status = yield* AppStatus;
        const ports = yield* Ports;
        return VoiceHost.of({
            requireReady: () => status.requireReady(),
            setup: (userId) => status.setup(userId),
            history: (threadId) => conversations.history(threadId),
            turn: (...args) => turns.turn(...args),
            turnOutcome: (...args) => turns.turnOutcome(...args),
            draining: () => ports.draining.get(),
        });
    }),
);

export const voiceLayers = {
    transcriptionKeys: Layer.effectContext(
        Effect.gen(function* () {
            const config = VoiceConfig.of(voiceConfigOf(yield* LegacyConfig));
            const keys = buildTranscriptionKeys((yield* LegacyStore).slices.secrets, (yield* PlatformKeys).keys);
            const context = yield* voiceContext(keys, yield* Dictation).pipe(
                Effect.provideService(VoiceConfig, config),
            );
            return context.pipe(Context.add(LegacyTranscriptionKeys, keys), Context.add(VoiceConfig, config));
        }),
    ),
    voice: Layer.effectContext(
        Effect.map(voiceService(), (voice) => Context.make(LegacyVoice, voice).pipe(Context.add(Voice, voice))),
    ).pipe(Layer.provide(VoiceHostLive)),
};
