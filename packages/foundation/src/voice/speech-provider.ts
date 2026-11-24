import type { Settings } from '@socio/shared/types';
import { keySafeUrl, transcribeOrigin } from '@socio/shared/voice/transcription';
import {
    DEFAULT_SPEECH_MODEL,
    DEFAULT_SPEECH_VOICE,
    type SpeechKey,
    type VoiceBackend,
    type VoiceCallsView,
} from '@socio/shared/voice/voice-call';

import { callSocketUrl, type TranscriptionProvider } from './transcription-provider.js';

/*
 * Which backend calls use, and which speech server self-hosted calls speak
 * with (CB-265): pure functions of the environment's settings and an
 * admin's. Moved from `src/server/voice/voice-speech.ts`, which re-exports
 * every name here.
 */

/**
 * Self-hosted calls' speech (CB-265): any server with OpenAI's
 * `POST /v1/audio/speech` that answers `response_format: "pcm"` (16-bit
 * mono at 24 kHz), such as socio-voice. `VOICE_SPEECH_*` set the default;
 * an admin may change the URL, model and voice in Settings → General →
 * Calls. Unset: this device speaks the replies.
 */
export interface SpeechEnv {
    /** Normalized; undefined when unset or not a usable URL. */
    url?: string;
    model: string;
    voice: string;
    /** VOICE_SPEECH_API_KEY; never stored in settings. */
    key?: string;
}

/** `VOICE_BACKEND` and `VOICE_SPEECH_*`, read once at start. */
export interface VoiceCallsEnv {
    backend: VoiceBackend;
    speech: SpeechEnv;
}

/** The speech server in force, with the key to send (if any). */
export interface SpeechProvider {
    url?: string;
    model: string;
    voice: string;
    source: 'settings' | 'env';
    key: SpeechKey;
    keyHost?: string;
    /** For the Authorization header; never shown. */
    secret?: string;
    /** A URL is set, and no key would go in the clear. */
    available: boolean;
}

const hostOf = (url: string | undefined) => {
    const origin = transcribeOrigin(url);
    return origin ? new URL(origin).host : undefined;
};

/**
 * An admin's speech server over the environment's. The key, the same
 * rules as transcription's (CB-204): VOICE_SPEECH_API_KEY goes only to
 * VOICE_SPEECH_URL's origin; else, at the transcription server's origin,
 * the transcription key in force (one server for both); else none. A key
 * goes only over https or to this machine, and never across a redirect.
 */
export function speechProvider(
    env: SpeechEnv | undefined,
    settings: Pick<Settings, 'voiceSpeech'> | undefined,
    transcription?: Pick<TranscriptionProvider, 'url' | 'secret'>,
): SpeechProvider {
    const base: SpeechEnv = env ?? {
        model: DEFAULT_SPEECH_MODEL,
        voice: DEFAULT_SPEECH_VOICE,
    };
    const saved = settings?.voiceSpeech;
    const url = saved ? saved.url || undefined : base.url;
    const model = saved ? saved.model : base.model;
    const voice = saved ? saved.voice : base.voice;
    const origin = transcribeOrigin(url);
    let key: SpeechKey = 'none';
    let secret: string | undefined;
    let keyHost: string | undefined;
    if (url && base.key && origin === transcribeOrigin(base.url)) {
        key = 'speech';
        secret = base.key;
    } else if (url && transcription?.secret && origin === transcribeOrigin(transcription.url)) {
        key = 'transcription';
        secret = transcription.secret;
    } else if (url && base.key) {
        key = 'withheld';
        keyHost = hostOf(base.url);
    }
    if (secret && url && !keySafeUrl(url)) {
        key = 'insecure';
        secret = undefined;
    }
    return {
        url,
        model,
        voice,
        source: saved ? 'settings' : 'env',
        key,
        ...(keyHost ? { keyHost } : {}),
        secret,
        available: !!url && key !== 'insecure',
    };
}

/** The backend in force: an admin's over `VOICE_BACKEND`. */
export const voiceBackend = (
    env: VoiceCallsEnv | undefined,
    settings: Pick<Settings, 'voiceBackend'> | undefined,
): { backend: VoiceBackend; source: 'settings' | 'env' } =>
    settings?.voiceBackend
        ? { backend: settings.voiceBackend, source: 'settings' }
        : { backend: env?.backend ?? 'cloud', source: 'env' };

/** For `GET /api/state`: everything but the key. */
export function voiceCallsView(
    env: VoiceCallsEnv | undefined,
    settings: Pick<Settings, 'voiceBackend' | 'voiceSpeech'>,
    transcription?: Pick<TranscriptionProvider, 'url' | 'secret'>,
): VoiceCallsView {
    const { backend, source } = voiceBackend(env, settings);
    const speech = speechProvider(env?.speech, settings, transcription);
    return {
        backend,
        backendSource: source,
        speech: {
            url: speech.url ?? '',
            model: speech.model,
            voice: speech.voice,
            source: speech.source,
            key: speech.key,
            ...(speech.keyHost ? { keyHost: speech.keyHost } : {}),
        },
    };
}

/**
 * `SetupStatus`'s call flags (CB-265): the backend in force, whether a
 * call can start with it, whether cloud calls could (the fallback), and
 * whether self-hosted replies are spoken by a speech server.
 */
export function callsSetup(input: {
    /** VOICE_API_KEY and VOICE_MODEL, and a model for turns. */
    cloud: boolean;
    /** A model for the socio's turns. */
    model: boolean;
    env?: VoiceCallsEnv;
    settings: Pick<Settings, 'voiceBackend' | 'voiceSpeech'>;
    transcription: TranscriptionProvider;
}) {
    const { backend } = voiceBackend(input.env, input.settings);
    const selfHosted = input.model && !!callSocketUrl(input.transcription);
    return {
        voice: backend === 'cloud' ? input.cloud : selfHosted,
        voiceBackend: backend,
        voiceCloud: input.cloud,
        voiceSpeech: speechProvider(input.env?.speech, input.settings, input.transcription).available,
    };
}
