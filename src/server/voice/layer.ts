/**
 * The voice layers: they implement `contract.ts`'s tags. `TranscriptionSecrets`
 * is the transcription key's store (`TranscriptionKeys`), `Transcription` reads
 * `VoiceConfig` and that key at each call, `Dictation` is live text's
 * relays, and `Voice` is calls and dictation (`VoiceService`), built from
 * the tags it reads: the workspace's `Conversations`, `Socios` and `People`
 * slices, `WorkspaceSettings`, `Approvals`, voice's own tags, and
 * `VoiceHost` for what no feature's tag offers yet. Only the composition
 * root (`composition/voice.ts`) and tests import this file.
 */
import { Context, Effect, Layer } from 'effect';

import type { SecretBox } from '@socio/foundation/keys/secret-box';
import type { AgentRunSource, SetupStatus } from '@socio/shared/types';

import { Approvals } from '../approvals/contract.js';
import type { SecretSettingsShape } from '../settings/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import type { PlatformTurnOptions, TurnOutcome } from '../turns/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import {
    Dictation,
    Transcription,
    TranscriptionSecrets,
    Voice,
    VoiceConfig,
    type DictationShape,
    type TranscriptionSecretsShape,
    type TranscriptionShape,
    type VoiceConfigShape,
} from './contract.js';
import { TranscriptionKeys } from './transcription.js';
import { VoiceService } from './voice.js';

// ── What the composition hands in ───────────────────────────────────────

/**
 * What `VoiceService` takes from the composition root because no
 * feature's contract offers it yet: a socio's turn (`AppTurns`), readiness,
 * setup (`AppStatus`) and the drain. Each is read at the moment of use.
 */
export interface VoiceHostShape {
    /** Resolves once the platform's boot work is done (`AppStatus.requireReady`). */
    requireReady(): Promise<void>;
    /** Setup status, for a user when given (`AppStatus.setup`). */
    setup(userId?: string): Promise<SetupStatus>;
    /** A conversation's recent history, as text, for a cloud call's instructions (`ConversationAdmin.history`). */
    history(threadId: string): Promise<string>;
    /** A Dot's turn in a conversation (`AppTurns.turn`). */
    turn(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        metadata?: Record<string, unknown>,
        source?: AgentRunSource,
    ): Promise<string>;
    /** A Dot's turn and its outcome (`AppTurns.turnOutcome`). */
    turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ): Promise<TurnOutcome>;
    /** Set on SIGTERM (CB-37), read at the moment of use. */
    draining(): boolean;
    /**
     * The Language field of a person's profile, alone (CB-106), for a cloud
     * call's language line; undefined when it is empty or there is none.
     */
    profileLanguage(userId: string): Promise<string | undefined>;
}

export class VoiceHost extends Context.Service<VoiceHost, VoiceHostShape>()('socio/voice/VoiceHost') {}

// ── Transcription ────────────────────────────────────────────────────────

/** The transcription key's store (CB-204): the secret settings, sealed with `box` (`settings-secrets`). */
export const transcriptionKeys = (settings: SecretSettingsShape, box: SecretBox) =>
    new TranscriptionKeys(settings, box);

/**
 * What picks dictation's transcription server and key, read at each call:
 * the environment's (`VoiceConfig`) and the key an admin saved, opened.
 * The same values as `AppStatus.transcriptionSources()`.
 */
export const transcriptionOver = (
    config: Pick<VoiceConfigShape, 'transcription' | 'voiceKey'>,
    secrets: Pick<TranscriptionSecretsShape, 'read'>,
): TranscriptionShape => ({
    sources: () => ({
        transcription: config.transcription,
        voiceKey: config.voiceKey,
        savedKey: secrets.read(),
    }),
});

/**
 * `TranscriptionSecrets`, `Transcription` and `Dictation` over the key's
 * store and live text's relays, each built once by the caller.
 */
export const voiceContext = (keys: TranscriptionSecretsShape, dictation: DictationShape) =>
    Effect.gen(function* () {
        const config = yield* VoiceConfig;
        return Context.make(TranscriptionSecrets, keys).pipe(
            Context.add(Dictation, dictation),
            Context.add(Transcription, transcriptionOver(config, keys)),
        );
    });

/** `TranscriptionSecrets`, `Transcription` and `Dictation`, over a key store and relays built once. */
export const TranscriptionLive = (keys: TranscriptionSecretsShape, dictation: DictationShape) =>
    Layer.effectContext(voiceContext(keys, dictation));

// ── Voice ────────────────────────────────────────────────────────────────

/**
 * Calls and dictation over the tags. It registers its approvals listener
 * (a self-hosted call hears that an approval waits, CB-265) as it is
 * built, as `new VoiceService(platform)` does. `transport`: the provider's
 * fetch; tests replace it. Without one, the service reads the global fetch
 * when it is built, not when this module loads.
 */
export const voiceService = (transport?: typeof fetch) =>
    Effect.gen(function* () {
        const conversations = yield* Conversations;
        const socios = yield* Socios;
        const people = yield* People;
        const settings = yield* WorkspaceSettings;
        const approvals = yield* Approvals;
        const config = yield* VoiceConfig;
        const dictation = yield* Dictation;
        const transcription = yield* Transcription;
        const host = yield* VoiceHost;
        return new VoiceService(
            {
                // Each read goes to its slice at the moment of use.
                workspace: {
                    requireThread: (id) => conversations.requireThread(id),
                    calls: () => conversations.calls(),
                    createCall: (threadId) => conversations.createCall(threadId),
                    call: (id) => conversations.call(id),
                    setCall: (...args) => conversations.setCall(...args),
                    saveLateTranscript: (id, transcript) => conversations.saveLateTranscript(id, transcript),
                    setCallError: (id, error) => conversations.setCallError(id, error),
                    dot: (id) => socios.dot(id),
                    users: () => people.users(),
                    preferences: (userId) => people.preferences(userId),
                },
                store: { settings: () => settings.settings() },
                config,
                approvals,
                dictationStreams: dictation,
                get draining() {
                    return host.draining();
                },
                transcriptionSources: () => transcription.sources(),
                requireReady: () => host.requireReady(),
                setup: (userId) => host.setup(userId),
                history: (threadId) => host.history(threadId),
                turn: (...args) => host.turn(...args),
                turnOutcome: (...args) => host.turnOutcome(...args),
                profileLanguage: (userId) => host.profileLanguage(userId),
            },
            transport,
        );
    });

/** `Voice`, over a service built once. */
export const VoiceLive = (transport?: typeof fetch) => Layer.effect(Voice, voiceService(transport));
