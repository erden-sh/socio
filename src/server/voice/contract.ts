/**
 * What other features may know of voice (calls, dictation and live text,
 * CB-101, CB-204, CB-222, CB-265): its tags, the slices of `VoiceService`,
 * `DictationStreams` and `TranscriptionKeys` they call, and plain types and
 * constants. It imports only `effect`, `@socio/*` and `import type` from
 * the allowlist,
 * and holds no logic.
 *
 * Every old path keeps working until its importer switches to the contract:
 * - `UPGRADE_ENV` (`dictation-stream.ts`) and `TRANSCRIPTION_PATH`
 *   (`voice.ts`) moved here; those files re-export them. `UpgradeEnv` here
 *   takes the accepted socket's type; `dictation-stream.ts` keeps its own
 *   `UpgradeEnv` as this one over `ws`'s `WebSocket`.
 * - The pure functions other features call moved to packages:
 *   `@socio/foundation/voice/transcription-provider` (`transcriptionProvider`,
 *   `transcriptionView`, `dictationSetup`, `callSocketUrl` and their types),
 *   re-exported by `transcription.ts`; `@socio/foundation/voice/speech-provider`
 *   (`voiceCallsView`, `callsSetup`, `speechProvider`, `voiceBackend` and
 *   their types), re-exported by `voice-speech.ts`. Their types are
 *   re-exported here too.
 *
 * Not here, on purpose:
 * - `VoiceService`, `DictationStreams` and `TranscriptionKeys` themselves:
 *   the composition builds them (`composition/voice.ts`,
 *   `composition/http/voice.ts`, `platform.ts`). Other folders get the tags
 *   below, which the classes implement.
 * - `dictationUpgrade`: the HTTP server's `upgrade` hook, mounted by the
 *   composition only (`composition/http/voice.ts`).
 * - `transcriptionFromEnv` and `voiceCallsFromEnv`: only the entry
 *   (`index.ts`) reads the environment; the composition hands the result
 *   in as `VoiceConfig`.
 * - `realtimeTranscription`, `CallSession`, `synthesize`, `SpeechError`,
 *   `STREAM_LIMITS` and `SESSION_LIMITS`: only voice and its tests use them.
 *   `SpeechError` is a `Data.TaggedError`.
 */
import { Context } from 'effect';

import type { VoiceCallsEnv } from '@socio/foundation/voice/speech-provider';
import type {
    SavedTranscriptionKey,
    TranscriptionEnv,
    TranscriptionSources,
} from '@socio/foundation/voice/transcription-provider';
import type { DictationShape, VoiceShape } from '@socio/foundation/voice/voice-shape';

// ── Plain types and constants ────────────────────────────────────────────

export type {
    SavedTranscriptionKey,
    TranscriptionEnv,
    TranscriptionProvider,
    TranscriptionSources,
} from '@socio/foundation/voice/transcription-provider';
export type { SpeechEnv, SpeechProvider, VoiceCallsEnv } from '@socio/foundation/voice/speech-provider';

/** Where the composer sends a dictation recording (CB-101). */
export const TRANSCRIPTION_PATH = '/api/voice/transcriptions';

/**
 * The upgrade key and env, the browser's socket, and the shapes the tags
 * below offer: `@socio/foundation/voice/voice-shape` (they moved there so
 * the workspace's routes read them without voice).
 */
export { UPGRADE_ENV } from '@socio/foundation/voice/voice-shape';
export type {
    BrowserSocket,
    DictationRefusal,
    DictationShape,
    UpgradeEnv,
    VoiceShape,
} from '@socio/foundation/voice/voice-shape';

// ── Dictation ────────────────────────────────────────────────────────────

export class Dictation extends Context.Service<Dictation, DictationShape>()('socio/voice/Dictation') {}

// ── Voice ────────────────────────────────────────────────────────────────

export class Voice extends Context.Service<Voice, VoiceShape>()('socio/voice/Voice') {}

// ── Transcription ────────────────────────────────────────────────────────

/**
 * What picks dictation's transcription server and key
 * (`AppStatus.transcriptionSources()`): the environment's, and the key an
 * admin saved, opened. Live, web and the workspace read it for
 * `transcriptionProvider`.
 */
export interface TranscriptionShape {
    sources(): TranscriptionSources;
}

export class Transcription extends Context.Service<Transcription, TranscriptionShape>()('socio/voice/Transcription') {}

/**
 * The key an admin sets for the transcription server (CB-204,
 * `TranscriptionKeys`): sealed with the URL it is for. Settings' save seals
 * it; `AppStatus.transcriptionSources()` reads it; the data key's counts
 * and reseal (CB-62) count and reseal it.
 */
export interface TranscriptionSecretsShape {
    /**
     * The key to save for `url`: sealed with it, and the URL beside it (a
     * secret setting, as `SecretSettings` keeps it).
     */
    seal(key: string, url: string): { value: string; url?: string | null };
    /** The saved key, opened (the last one opened is kept); undefined when none. */
    read(): SavedTranscriptionKey | undefined;
    /** The saved key's seal, for the data key's counts. */
    sealStates(): { current: number; previous: number; legacy: number; unknown: number };
    /** Seals the saved key again under the current data key; idempotent. */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
}

export class TranscriptionSecrets extends Context.Service<TranscriptionSecrets, TranscriptionSecretsShape>()(
    'socio/voice/TranscriptionSecrets',
) {}

// ── VoiceConfig ──────────────────────────────────────────────────────────

/**
 * What voice reads of the platform's configuration: `VOICE_API_KEY`,
 * `VOICE_MODEL` and `VOICE_NAME` (cloud calls), `VOICE_TRANSCRIBE_*`
 * (`transcriptionFromEnv`) and `VOICE_BACKEND` with `VOICE_SPEECH_*`
 * (`voiceCallsFromEnv`). The same fields of `PlatformConfig`.
 */
export interface VoiceConfigShape {
    readonly voiceKey?: string;
    readonly voiceModel?: string;
    readonly voiceName: string;
    readonly transcription?: TranscriptionEnv;
    readonly voiceCalls?: VoiceCallsEnv;
}

export class VoiceConfig extends Context.Service<VoiceConfig, VoiceConfigShape>()('socio/voice/VoiceConfig') {}
