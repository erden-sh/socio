import type { NotificationPreferences } from '../notifications.js';
import type { OnboardingPreferences } from '../onboarding.js';
import type { RoomPresencePreference } from '../rooms/room-notices.js';

import type { DictationLanguage } from './dictation-languages.js';

/**
 * Dictation in the chat composer (CB-101): speech becomes text in the
 * draft, which the person edits and sends. Two ways to turn speech into
 * text: `device`, the browser's own speech recognition (nothing reaches
 * this server), and `server`, a recording transcribed by the workspace's
 * voice provider (VOICE_API_KEY).
 */
export const DICTATION_METHODS = ['device', 'server'] as const;
export type DictationMethod = (typeof DICTATION_METHODS)[number];

/**
 * What an admin allows (Settings → General), over `DICTATION_METHODS` in
 * the server's environment: both (the default), or only one.
 */
export const DICTATION_ALLOWED = ['both', 'device', 'server'] as const;
export type DictationAllowed = (typeof DICTATION_ALLOWED)[number];

/** `DICTATION_METHODS`: `both` when unset or unknown. */
export function dictationAllowedFromEnv(env: Record<string, string | undefined>): DictationAllowed {
    const raw = env.DICTATION_METHODS?.trim().toLowerCase();
    return DICTATION_ALLOWED.find((value) => value === raw) ?? 'both';
}

/** One person's preferences, stored on the server (`/api/preferences`). */
export interface UserPreferences {
    /** Versioned guides, saved for this person across sessions. */
    onboarding?: OnboardingPreferences;
    /** How they dictate when both ways work; null: not chosen yet (ask). */
    dictation: DictationMethod | null;
    /**
     * The language hint for the transcription server (CB-221); null or
     * unset: Auto, nothing is sent and the server detects it. Read through
     * `dictationLanguageHint`, which drops a code no longer offered.
     */
    dictationLanguage?: DictationLanguage | null;
    /** Each notification channel on or off, and what it shows (CB-114). */
    notifications?: NotificationPreferences;
    /**
     * Whether a room's members see when they are looking at it (CB-216);
     * unset: shown.
     */
    roomPresence?: RoomPresencePreference;
    /**
     * The language Socio shows this person on this server: a registered
     * locale (`@socio/i18n`'s `LOCALES`, such as `es-US`); null or unset:
     * match the device or browser.
     */
    locale?: string | null;
}
export const DEFAULT_PREFERENCES: UserPreferences = { dictation: null };

/** A server recording's limits: the upload's size, and the recording's length. */
export const DICTATION_LIMITS = {
    maxBytes: 5 * 1024 * 1024,
    maxSeconds: 120,
};

/**
 * Live text while dictating (CB-222): the composer's socket to this server,
 * which relays it to the transcription server's realtime socket. The
 * browser sends binary frames of 16-bit little-endian mono PCM at
 * `sampleRate`, then `{ "type": "done" }`; it gets `DictationStreamEvent`s.
 * The audio is passed on and never stored.
 */
export const DICTATION_STREAM = {
    path: '/api/voice/realtime',
    sampleRate: 16_000,
};

/**
 * What the composer's socket says. `ready`: the transcription server is
 * listening. `partial`: the whole text so far, unconfirmed. `final`: the
 * text, after `done`. `unavailable`: no live text now (no realtime socket
 * there, or it dropped); the composer sends the recording at the end.
 */
export type DictationStreamEvent =
    | { type: 'ready' }
    | { type: 'partial'; text: string }
    | { type: 'final'; text: string }
    | { type: 'unavailable' };

/** Recording types the voice provider takes, with the file extension it reads them by. */
export const DICTATION_AUDIO_TYPES: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
};
/** `audio/webm;codecs=opus` → `audio/webm`. */
export const baseAudioType = (type: string) => type.split(';')[0].trim().toLowerCase();

/** The short line shown wherever someone picks a way to dictate. */
export const DICTATION_NOTES: Record<DictationMethod, string> = {
    device: 'Your browser turns speech into text; nothing goes to our server. On iPhone, Safari may send the audio to Apple.',
    server: 'Your browser records, and our server has the workspace’s voice provider transcribe it.',
};
export const DICTATION_LABELS: Record<DictationMethod, string> = {
    device: 'On this device',
    server: 'On our server',
};

/**
 * The ways that work here: the browser has what it needs, the server is
 * set up for it, and the admin allows it.
 */
export function availableDictation({
    device,
    server,
    allowed = 'both',
}: {
    device: boolean;
    server: boolean;
    allowed?: DictationAllowed;
}): DictationMethod[] {
    return DICTATION_METHODS.filter(
        (method) => (method === 'device' ? device : server) && (allowed === 'both' || allowed === method),
    );
}

/**
 * Which way the mic uses: none when nothing works (no mic button), the
 * only one that works, the person's choice, else `ask`.
 */
export function chooseDictation(
    available: readonly DictationMethod[],
    preference: DictationMethod | null | undefined,
): DictationMethod | 'ask' | null {
    if (!available.length) {
        return null;
    }
    if (available.length === 1) {
        return available[0];
    }
    return preference && available.includes(preference) ? preference : 'ask';
}
