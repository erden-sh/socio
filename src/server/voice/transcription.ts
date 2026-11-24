import type { SecretBox } from '@socio/foundation/keys/secret-box';
import type { SavedTranscriptionKey, TranscriptionEnv } from '@socio/foundation/voice/transcription-provider';
import { isDictationLanguage, type DictationLanguage } from '@socio/shared/voice/dictation-languages';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';
import {
    DEFAULT_TRANSCRIBE_MODEL,
    OPENAI_TRANSCRIBE_URL,
    keySafeUrl,
    normalizeTranscribeUrl,
    transcriptionStreamingFromEnv,
} from '@socio/shared/voice/transcription';

import type { SecretSetting, SecretSettingsShape } from '../settings/contract.js';

import type { TranscriptionSecretsShape } from './contract.js';

/**
 * `VOICE_TRANSCRIBE_URL` (OpenAI's when unset or empty),
 * `VOICE_TRANSCRIBE_MODEL`, the optional `VOICE_TRANSCRIBE_API_KEY`, and
 * `VOICE_TRANSCRIBE_STREAMING` (live text, CB-222).
 * A set but unusable URL leaves server dictation unavailable, with a
 * warning; so does a key for a plain-http URL to another machine (CB-204).
 */
export function transcriptionFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void = () => {},
): TranscriptionEnv {
    const raw = env.VOICE_TRANSCRIBE_URL?.trim() || OPENAI_TRANSCRIBE_URL;
    const url = normalizeTranscribeUrl(raw);
    if (!url) {
        warn(
            'Voice: VOICE_TRANSCRIBE_URL must be an http(s) base URL without credentials; server dictation is off until it is fixed or set in Settings.',
        );
    }
    const key = env.VOICE_TRANSCRIBE_API_KEY?.trim() || undefined;
    if (url && key && !keySafeUrl(url)) {
        warn(
            'Voice: VOICE_TRANSCRIBE_API_KEY is sent only over https (or to this machine), and VOICE_TRANSCRIBE_URL is plain http to another machine; server dictation there is off until VOICE_TRANSCRIBE_URL is https or VOICE_TRANSCRIBE_API_KEY is unset.',
        );
    }
    return {
        url,
        model: env.VOICE_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
        key,
        streaming: transcriptionStreamingFromEnv(env),
    };
}

/**
 * A realtime session's `input_audio_transcription` (CB-221): the model,
 * and the person's dictation language when they chose one
 * (`VoiceService.dictationLanguage`). With Auto there is no `language` at
 * all, so the server detects it; anything but an offered code is left out
 * too. Live text (dictation-stream.ts) and self-hosted calls
 * (voice-call.ts) both build their `transcription_session.update` with it.
 */
export function realtimeTranscription(
    model: string,
    language?: DictationLanguage,
): { model: string; language?: DictationLanguage } {
    return { model, ...(isDictationLanguage(language) ? { language } : {}) };
}

/** The secret settings the store keeps: sealed values by name (the settings contract's slice). */
export type SecretSettings = SecretSettingsShape;

/**
 * The key an admin sets for the transcription server (CB-204): sealed
 * under the data key (CB-62) with the URL it is for, in the core store's
 * secret settings, never in `settings` (which `GET /api/state` shows).
 * It leaves the server only as the Authorization header to that URL.
 */
export class TranscriptionKeys implements TranscriptionSecretsShape {
    private last?: { saved: SecretSetting; opened: SavedTranscriptionKey };
    constructor(
        private store: SecretSettings,
        private box: SecretBox,
    ) {}

    /** The key to save for `url`: sealed with it, and the URL beside it. */
    seal(key: string, url: string): SecretSetting {
        return { value: this.box.seal({ key, url }), url };
    }

    /** The saved key, opened (the last one opened is kept); undefined when none. */
    read(): SavedTranscriptionKey | undefined {
        const saved = this.store.secretSetting(TRANSCRIPTION_KEY_SETTING);
        if (!saved) {
            return undefined;
        }
        if (this.last?.saved.value === saved.value && this.last.saved.url === saved.url) {
            return this.last.opened;
        }
        // The sealed URL is the one it goes to; the unsealed one only says
        // which URL can't have it.
        let opened: SavedTranscriptionKey = {
            unreadable: true,
            ...(saved.url ? { url: saved.url } : {}),
        };
        try {
            const value = this.box.open(saved.value) as {
                key?: unknown;
                url?: unknown;
            };
            if (typeof value?.key === 'string' && typeof value.url === 'string') {
                opened = { key: value.key, url: value.url };
            }
        } catch {
            // Under a data key this server doesn't have.
        }
        this.last = { saved, opened };
        return opened;
    }

    /** The saved key's seal, for the data key's counts (CB-62). */
    sealStates() {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const sealed = this.store.secretSetting(TRANSCRIPTION_KEY_SETTING)?.value;
        if (sealed) {
            counts[this.box.state(this.box.valueKey(sealed))]++;
        }
        return counts;
    }

    /** Seals the saved key again under the current data key; idempotent. */
    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        const sealed = this.store.secretSetting(TRANSCRIPTION_KEY_SETTING)?.value;
        if (!sealed) {
            return result;
        }
        let next: string | undefined;
        try {
            next = this.box.reseal(sealed);
        } catch {
            result.unreadable++;
            return result;
        }
        if (next && (await this.store.replaceSecretSetting(TRANSCRIPTION_KEY_SETTING, sealed, next))) {
            result.resealed++;
        }
        return result;
    }
}
