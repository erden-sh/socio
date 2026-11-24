import { Data } from 'effect';

import type { SpeechProvider, VoiceCallsEnv } from '@socio/foundation/voice/speech-provider';
import { keySafeUrl, normalizeTranscribeUrl } from '@socio/shared/voice/transcription';
import {
    DEFAULT_SPEECH_MODEL,
    DEFAULT_SPEECH_VOICE,
    VOICE_BACKENDS,
    voiceBackendFromEnv,
    type VoiceBackend,
} from '@socio/shared/voice/voice-call';

/** `VOICE_BACKEND` and `VOICE_SPEECH_*`, read once at start. */
export function voiceCallsFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void = () => {},
): VoiceCallsEnv {
    const rawBackend = env.VOICE_BACKEND?.trim();
    if (rawBackend && !VOICE_BACKENDS.includes(rawBackend as VoiceBackend)) {
        warn(
            `Voice: VOICE_BACKEND must be ${VOICE_BACKENDS.join(' or ')}; calls use cloud until it is fixed or set in Settings.`,
        );
    }
    const raw = env.VOICE_SPEECH_URL?.trim();
    const url = raw ? normalizeTranscribeUrl(raw) : undefined;
    if (raw && !url) {
        warn(
            'Voice: VOICE_SPEECH_URL must be an http(s) base URL without credentials; self-hosted calls speak on the device until it is fixed or set in Settings.',
        );
    }
    const key = env.VOICE_SPEECH_API_KEY?.trim() || undefined;
    if (url && key && !keySafeUrl(url)) {
        warn(
            'Voice: VOICE_SPEECH_API_KEY is sent only over https (or to this machine), and VOICE_SPEECH_URL is plain http to another machine; replies are spoken on the device until VOICE_SPEECH_URL is https or VOICE_SPEECH_API_KEY is unset.',
        );
    }
    return {
        backend: voiceBackendFromEnv(env),
        speech: {
            url,
            model: env.VOICE_SPEECH_MODEL?.trim() || DEFAULT_SPEECH_MODEL,
            voice: env.VOICE_SPEECH_VOICE?.trim() || DEFAULT_SPEECH_VOICE,
            key,
        },
    };
}

/** How long one piece of a reply may take to start sounding. */
export const SPEECH_TIMEOUT_MS = 20_000;

/** A speech request that failed: why, for the log (the host only). */
export class SpeechError extends Data.TaggedError('SpeechError')<{ readonly message: string }> {}

/**
 * One piece of a reply as PCM (16-bit mono, 24 kHz), as it streams from
 * the speech server. The key goes as a bearer token to that URL only; a
 * redirect is refused, never followed.
 */
export async function* synthesize(
    provider: SpeechProvider,
    text: string,
    signal: AbortSignal,
    transport: typeof fetch = fetch,
    timeoutMs = SPEECH_TIMEOUT_MS,
): AsyncGenerator<Uint8Array> {
    if (!provider.available || !provider.url) {
        throw new SpeechError({ message: 'no speech server' });
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
        response = await transport(`${provider.url}/v1/audio/speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(provider.secret ? { Authorization: `Bearer ${provider.secret}` } : {}),
            },
            body: JSON.stringify({
                model: provider.model,
                input: text,
                voice: provider.voice,
                response_format: 'pcm',
            }),
            signal: AbortSignal.any([signal, timeout]),
            redirect: 'manual',
        });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new SpeechError({
            message: timeout.aborted
                ? `timed out after ${Math.round(timeoutMs / 1000)} s`
                : `failed (${error instanceof Error ? error.name : 'transport error'})`,
        });
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw new SpeechError({ message: 'redirected (refused)' });
    }
    if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new SpeechError({ message: `returned HTTP ${response.status}` });
    }
    const type = response.headers.get('content-type') ?? '';
    if (/json|text\//i.test(type)) {
        void response.body.cancel().catch(() => undefined);
        throw new SpeechError({ message: `returned ${type.split(';')[0]}, not audio` });
    }
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            if (value?.length) {
                yield value;
            }
        }
    } finally {
        void reader.cancel().catch(() => undefined);
    }
}
