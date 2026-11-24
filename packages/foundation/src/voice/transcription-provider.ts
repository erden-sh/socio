import type { Settings } from '@socio/shared/types';
import {
    DEFAULT_TRANSCRIBE_MODEL,
    OPENAI_TRANSCRIBE_URL,
    isOpenAiTranscribeUrl,
    keySafeUrl,
    realtimeUrl,
    transcribeOrigin,
    type TranscriptionKey,
    type TranscriptionStreaming,
    type TranscriptionView,
} from '@socio/shared/voice/transcription';

/*
 * Which transcription server dictation and self-hosted calls use, and with
 * which key (CB-101, CB-204, CB-222, CB-265): pure functions of the
 * environment's settings, an admin's, and the key an admin saved. Moved
 * from `src/server/voice/transcription.ts`, which re-exports every name
 * here.
 */

/** `VOICE_TRANSCRIBE_*`: the default transcription server (CB-101). */
export interface TranscriptionEnv {
    /** Normalized; undefined when VOICE_TRANSCRIBE_URL isn't a usable URL. */
    url?: string;
    model: string;
    /** VOICE_TRANSCRIBE_API_KEY; never stored in settings. */
    key?: string;
    /** VOICE_TRANSCRIBE_STREAMING (CB-222); `auto` when unset. */
    streaming?: TranscriptionStreaming;
}

/**
 * The key an admin set in Settings (CB-204), opened, with the URL it was
 * set for; `unreadable` when its data key is gone, with the URL it was
 * for (kept unsealed beside it).
 */
export type SavedTranscriptionKey = { key: string; url: string } | { unreadable: true; url?: string };

/** What picks the server and key: the environment's, and an admin's key. */
export interface TranscriptionSources {
    transcription?: TranscriptionEnv;
    voiceKey?: string;
    savedKey?: SavedTranscriptionKey;
}

/** The transcription server in force, with the key to send (if any). */
export interface TranscriptionProvider extends Omit<TranscriptionView, 'url'> {
    url?: string;
    /** The secret for the Authorization header; never shown. */
    secret?: string;
    /**
     * Live text (CB-222): the URL's realtime socket (`realtimeUrl`), when it
     * is tried here: not `off`, not OpenAI's URL, wss or ws to this machine.
     * The key in `secret` goes there and nowhere else.
     */
    realtimeUrl?: string;
    /**
     * Configured, and has a key where it needs one (OpenAI's URL), with no
     * key it would have to send in the clear or can't open.
     */
    available: boolean;
}

const hostOf = (url: string | undefined) => {
    const origin = transcribeOrigin(url);
    return origin ? new URL(origin).host : undefined;
};

/**
 * An admin's choice from Settings over the environment's. The key, first
 * found: the one an admin set in Settings, only for the exact URL it was
 * set for (changing the URL clears it, CB-204); VOICE_TRANSCRIBE_API_KEY
 * when set, sent only to VOICE_TRANSCRIBE_URL's origin (OpenAI's when
 * unset), so an admin's URL elsewhere gets no key; else VOICE_API_KEY for
 * OpenAI's URL only; else none, for a keyless lab server. A key goes only
 * over https, or plain http to this machine: else nothing is sent. A saved
 * key that can't be opened stops dictation at its own URL only.
 */
export function transcriptionProvider(
    config: TranscriptionSources,
    settings?: Pick<Settings, 'transcription' | 'transcriptionStreaming'>,
): TranscriptionProvider {
    const env = config.transcription ?? {
        url: OPENAI_TRANSCRIBE_URL,
        model: DEFAULT_TRANSCRIBE_MODEL,
    };
    const saved = settings?.transcription;
    const url = saved ? saved.url : env.url;
    const model = saved ? saved.model : env.model;
    const openai = !!url && isOpenAiTranscribeUrl(url);
    const voiceKey = config.voiceKey?.trim() || undefined;
    const keyOrigin = transcribeOrigin(env.url);
    const admin = config.savedKey;
    let keyHost: string | undefined;
    let [key, secret]: [TranscriptionKey, string | undefined] =
        admin && url && admin.url === url
            ? 'key' in admin
                ? ['settings', admin.key]
                : ['unreadable', undefined]
            : env.key
              ? keyOrigin && transcribeOrigin(url) === keyOrigin
                  ? ['transcribe', env.key]
                  : ['withheld', undefined]
              : openai && voiceKey
                ? ['voice', voiceKey]
                : ['none', undefined];
    if (key === 'withheld') {
        keyHost = hostOf(env.url);
    } else if (key === 'none' && admin?.url) {
        key = 'withheld';
        keyHost = hostOf(admin.url);
    }
    let insecureKey: TranscriptionView['insecureKey'];
    if (secret && url && !keySafeUrl(url)) {
        // Only these two can be plain http: VOICE_API_KEY is OpenAI's https.
        if (key === 'settings' || key === 'transcribe') {
            insecureKey = key;
        }
        [key, secret] = ['insecure', undefined];
    }
    const streaming = settings?.transcriptionStreaming ?? env.streaming ?? 'auto';
    // Wss only, or ws to this machine, with a key or without one.
    const socket = url && streaming !== 'off' && !openai ? realtimeUrl(url) : undefined;
    return {
        url,
        model,
        source: saved ? 'settings' : 'env',
        streaming,
        ...(socket && keySafeUrl(socket) ? { realtimeUrl: socket } : {}),
        key,
        ...(keyHost ? { keyHost } : {}),
        ...(admin ? { keySaved: true } : {}),
        ...(insecureKey ? { insecureKey } : {}),
        secret,
        available: !!url && key !== 'insecure' && key !== 'unreadable' && (!openai || !!secret),
    };
}

/**
 * A self-hosted call's socket (CB-265): the transcription server's
 * realtime socket, as for live text, whatever live text's setting (a call
 * has no record-then-send). Wss, or ws to this machine; never OpenAI's.
 * The key in `provider.secret` goes there and nowhere else.
 */
export function callSocketUrl(provider: Pick<TranscriptionProvider, 'url' | 'available'>) {
    if (!provider.available || !provider.url) {
        return undefined;
    }
    if (isOpenAiTranscribeUrl(provider.url)) {
        return undefined;
    }
    const socket = realtimeUrl(provider.url);
    return keySafeUrl(socket) ? socket : undefined;
}

/**
 * `SetupStatus`'s dictation flags: server dictation works, and streams
 * (not while `auto` remembers the server has no socket, CB-222).
 * `streams` is live dictation's relays (`DictationStreams`).
 */
export const dictationSetup = (
    provider: TranscriptionProvider,
    streams?: { recordingsOnly(provider: TranscriptionProvider): boolean },
) => ({
    transcription: provider.available,
    transcriptionStreaming: provider.available && !!provider.realtimeUrl && !streams?.recordingsOnly(provider),
});

/** For `GET /api/state`: everything but the secret. */
export function transcriptionView(provider: TranscriptionProvider): TranscriptionView {
    return {
        url: provider.url ?? '',
        model: provider.model,
        source: provider.source,
        key: provider.key,
        ...(provider.keyHost ? { keyHost: provider.keyHost } : {}),
        ...(provider.keySaved ? { keySaved: true } : {}),
        ...(provider.insecureKey ? { insecureKey: provider.insecureKey } : {}),
        streaming: provider.streaming,
        realtime: !!provider.realtimeUrl,
    };
}
