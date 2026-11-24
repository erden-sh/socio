/**
 * Voice calls with a socio (CB-265). Two backends:
 *
 * - `cloud`: OpenAI's Realtime API over WebRTC (`VOICE_API_KEY`,
 *   `VOICE_MODEL`). The realtime model speaks for the socio and hands
 *   research to the socio's own turn (`ask_compute`).
 * - `self-hosted`: the workspace's own voice server. Speech becomes text on
 *   the transcription server's realtime socket (the one live dictation
 *   uses, CB-222), each thing the person says is a normal turn of the
 *   socio in this conversation (its model, tools, permissions and
 *   approvals), and the reply is spoken by the speech server
 *   (`POST /v1/audio/speech`, OpenAI-compatible), or by this device's own
 *   voice when there is none.
 *
 * An admin picks one in Settings → General → Calls, over `VOICE_BACKEND`
 * (`cloud` when unset).
 */
export const VOICE_BACKENDS = ['cloud', 'self-hosted'] as const;
export type VoiceBackend = (typeof VOICE_BACKENDS)[number];

/** `VOICE_BACKEND`: `cloud` when unset or unknown. */
export function voiceBackendFromEnv(env: Record<string, string | undefined>): VoiceBackend {
    const raw = env.VOICE_BACKEND?.trim().toLowerCase();
    return VOICE_BACKENDS.find((value) => value === raw) ?? 'cloud';
}

/**
 * A self-hosted call's socket to this server. The browser sends binary
 * frames of 16-bit little-endian mono PCM at `inputRate` (the microphone);
 * it gets `CallStreamEvent`s as text, and the reply's speech as binary
 * frames of 16-bit little-endian mono PCM at `outputRate`.
 */
export const CALL_STREAM = {
    path: '/api/voice/call',
    inputRate: 16_000,
    /** OpenAI's `pcm` speech format, which socio-voice speaks too. */
    outputRate: 24_000,
};

/**
 * What a self-hosted call's socket says.
 * - `ready`: the transcription server is listening.
 * - `speech`: the person started speaking: playback stops (barge-in).
 * - `partial`: what they are saying so far, unconfirmed.
 * - `heard`: what they said, final; a turn starts (or follows the one running).
 * - `thinking`: the socio's turn is running.
 * - `reply`: its answer as text, for the caption; `audio` says its speech
 *   follows as binary frames, then `spoken`.
 * - `say`: text for this device to speak itself (no speech server, or it
 *   failed part way).
 * - `spoken`: the reply's speech has all been sent.
 * - `notice`: something to show, such as an approval waiting in the chat.
 * - `ended`: the server ended the call, with the reason.
 */
export type CallStreamEvent =
    | { type: 'ready'; speech: boolean }
    | { type: 'speech' }
    | { type: 'partial'; text: string }
    | { type: 'heard'; text: string }
    | { type: 'thinking' }
    | { type: 'reply'; text: string; audio: boolean }
    | { type: 'say'; text: string }
    | { type: 'spoken' }
    | { type: 'notice'; text: string }
    | { type: 'ended'; reason: string };

/** What the browser may send as text on the call's socket. */
export type CallClientMessage =
    /** Stop speaking now (the Interrupt button). */
    { type: 'interrupt' };

/**
 * The speech server (`POST {url}/v1/audio/speech`): an admin's from
 * Settings, over `VOICE_SPEECH_URL`, `VOICE_SPEECH_MODEL` and
 * `VOICE_SPEECH_VOICE`.
 */
export interface SpeechSettings {
    /** The server's base URL, without `/v1/audio/speech`; empty: none. */
    url: string;
    model: string;
    voice: string;
}
export const DEFAULT_SPEECH_MODEL = 'kokoro';
/** socio-voice picks an English or Spanish voice by the reply's language. */
export const DEFAULT_SPEECH_VOICE = 'auto';
export const SPEECH_VOICE_MAX = 100;
/** Kokoro's `af_heart`, OpenAI's `alloy`, `en-US-1`. */
export const SPEECH_VOICE_PATTERN = /^[A-Za-z0-9._:@+-]+$/;

/** Which key goes to the speech server: never the key itself. */
export type SpeechKey =
    /** `VOICE_SPEECH_API_KEY`, to `VOICE_SPEECH_URL`'s origin only. */
    | 'speech'
    /** The transcription server's key in force: the speech URL is at its origin. */
    | 'transcription'
    /** No Authorization header. */
    | 'none'
    /** No Authorization header: VOICE_SPEECH_API_KEY is for another origin. */
    | 'withheld'
    /** Nothing is sent: a key would go over plain http to another machine. */
    | 'insecure';

/** What `GET /api/state` shows of calls (`settings.voiceCalls`). */
export interface VoiceCallsView {
    /** The backend in force, an admin's over `VOICE_BACKEND`. */
    backend: VoiceBackend;
    backendSource: 'settings' | 'env';
    /** The speech server in force (`url` empty: this device speaks). */
    speech: SpeechSettings & {
        source: 'settings' | 'env';
        key: SpeechKey;
        /** With `withheld`: the host the key is for. */
        keyHost?: string;
    };
}

/** Self-hosted calls' limits. */
export const CALL_LIMITS = {
    /** A call ends after this long, as a cloud call does. */
    maxMs: 15 * 60_000,
    /** One frame of microphone audio from the browser. */
    maxFrameBytes: 64 * 1024,
    /** The most of a reply that is spoken; the rest is in the chat. */
    maxSpokenChars: 1_200,
};

/**
 * The note a self-hosted call's turn carries for the model (not stored):
 * the person spoke, and the answer will be heard, not read.
 */
export const SPOKEN_TURN_NOTE =
    'This message was spoken in a voice call and transcribed, so it may have recognition errors; ask if something is unclear. Your answer will be read aloud: reply in a few short spoken sentences, without markdown, lists, tables, code or links. Work that needs a long answer can go on in the chat afterwards.';

/**
 * A reply as it is spoken: no markdown, code or links (they stay in the
 * chat), at most `max` characters, cut at a sentence where it can be.
 */
export function spokenText(text: string, max = CALL_LIMITS.maxSpokenChars) {
    let out = text
        .replace(/```[\s\S]*?```/g, ' (code in the chat) ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' (link in the chat) ')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\|/g, ' ')
        .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/\s+/g, ' ')
        .trim();
    if (out.length <= max) {
        return out;
    }
    const cut = out.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
    return `${out} The rest is in the chat.`;
}

/**
 * A spoken reply in pieces for the speech server: sentences, joined up to
 * about `size` characters, so the first audio comes soon and each piece
 * still sounds whole.
 */
export function speechPieces(text: string, size = 240) {
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text];
    const pieces: string[] = [];
    let current = '';
    for (const sentence of sentences) {
        // The first piece is one sentence, so the first audio comes soonest.
        if (current && (pieces.length === 0 || current.length + sentence.length > size)) {
            pieces.push(current.trim());
            current = '';
        }
        current += sentence;
        while (current.length > size * 2) {
            const at = current.lastIndexOf(' ', size * 2);
            const split = at > size / 2 ? at : size * 2;
            pieces.push(current.slice(0, split).trim());
            current = current.slice(split);
        }
    }
    if (current.trim()) {
        pieces.push(current.trim());
    }
    return pieces.filter(Boolean);
}
