/**
 * Where dictation's "On our server" method transcribes (CB-101): any
 * OpenAI-compatible speech-to-text server, `POST {url}/v1/audio/transcriptions`.
 * The environment sets the default (`VOICE_TRANSCRIBE_URL`,
 * `VOICE_TRANSCRIBE_MODEL`); an admin may override both in Settings, and set
 * a key for the server there too (CB-204). A key never leaves the server.
 */
export const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com';
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const TRANSCRIBE_URL_MAX = 2048;
export const TRANSCRIBE_MODEL_MAX = 200;
/** `whisper-1`, `Systran/faster-whisper-large-v3`, `ggml:large-v3`. */
export const TRANSCRIBE_MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
export const TRANSCRIBE_KEY_MAX = 4096;
/** A bearer token: printable ASCII, no spaces (it goes in a header). */
export const TRANSCRIBE_KEY_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Live text while dictating (CB-222): the composer streams the audio
 * through this server to the transcription server's realtime socket
 * (`realtimeUrl`) and shows its partial transcripts. `auto` streams to any
 * server but OpenAI's, and a server that turns the socket down gets
 * record-then-send for a while (`DictationStreams`); `on` tries it every
 * time; `off` always records, then sends. An admin's choice in Settings,
 * over `VOICE_TRANSCRIBE_STREAMING` (`auto` when unset).
 */
export const TRANSCRIPTION_STREAMING = ['auto', 'on', 'off'] as const;
export type TranscriptionStreaming = (typeof TRANSCRIPTION_STREAMING)[number];

/** `VOICE_TRANSCRIBE_STREAMING`: `auto` when unset or unknown. */
export function transcriptionStreamingFromEnv(env: Record<string, string | undefined>): TranscriptionStreaming {
    const raw = env.VOICE_TRANSCRIBE_STREAMING?.trim().toLowerCase();
    return TRANSCRIPTION_STREAMING.find((value) => value === raw) ?? 'auto';
}

/** What an admin saves in Settings (`settings.transcription`). */
export interface TranscriptionSettings {
    /** The server's base URL, without `/v1/audio/transcriptions`. */
    url: string;
    model: string;
}

/** Which key the server sends: never the key itself. */
export type TranscriptionKey =
    /** The key an admin set in Settings, for this URL (CB-204). */
    | 'settings'
    /** `VOICE_TRANSCRIBE_API_KEY`. */
    | 'transcribe'
    /** `VOICE_API_KEY`, for OpenAI's URL only. */
    | 'voice'
    /** No Authorization header. */
    | 'none'
    /**
     * No Authorization header: VOICE_TRANSCRIBE_API_KEY is set, but for
     * VOICE_TRANSCRIBE_URL's origin, not this one (an admin's URL).
     */
    | 'withheld'
    /**
     * Nothing is sent: a key is set for this server, but its URL is plain
     * http to another machine, and a key goes only over https (CB-204).
     */
    | 'insecure'
    /** Nothing is sent: the key set in Settings can't be opened (its data key is gone). */
    | 'unreadable';

/** What `GET /api/state` shows: the settings in force, and where they come from. */
export interface TranscriptionView extends TranscriptionSettings {
    /** An admin's (Settings) or the environment's. */
    source: 'settings' | 'env';
    key: TranscriptionKey;
    /** With `withheld`: the host the key is for (VOICE_TRANSCRIBE_URL's, or the URL's it was set for). */
    keyHost?: string;
    /** An admin set a key in Settings (CB-204); only whether, never the key. */
    keySaved?: boolean;
    /** With `insecure`: which key would have gone (the fix differs). */
    insecureKey?: 'settings' | 'transcribe';
    /** Live text (CB-222): the choice in force, an admin's over the environment's. */
    streaming?: TranscriptionStreaming;
    /**
     * Live text is tried here: not `off`, not OpenAI's URL, and its socket
     * would be wss (or ws to this machine).
     */
    realtime?: boolean;
}

/**
 * A base URL in one form: http or https, no credentials, query or fragment,
 * no trailing slash, and no trailing `/v1` (the path is added). Loopback,
 * private and tailnet hosts are fine: only an admin or the operator sets it.
 * Undefined when it isn't a usable URL.
 */
export function normalizeTranscribeUrl(raw: string): string | undefined {
    const text = raw.trim();
    if (!text || text.length > TRANSCRIBE_URL_MAX) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
    }
    if (!url.hostname || url.username || url.password) {
        return undefined;
    }
    if (url.search || url.hash) {
        return undefined;
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${url.origin}${path}`;
}

/** A URL's origin (`http://stt.lab:8000`); undefined when it isn't one. */
export function transcribeOrigin(url: string | undefined) {
    if (!url) {
        return undefined;
    }
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

/**
 * Whether a key may go to this URL (CB-204): https, or plain http to this
 * machine only (`localhost`, 127.0.0.0/8, `[::1]`), so a key never crosses
 * a network in the clear. The same for a socket (CB-222): wss, or plain ws
 * to this machine.
 */
export function keySafeUrl(url: string) {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
        return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A transcription server's realtime socket (CB-222), from its base URL:
 * the same host, port and path, plus `/v1/realtime` (next to
 * `/v1/audio/transcriptions`), over wss for https and ws for http. So it
 * is always at the URL a key is bound to (CB-204), never anywhere else.
 */
export function realtimeUrl(base: string) {
    const url = new URL(`${base}/v1/realtime`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
}

/** OpenAI's own API, where `VOICE_API_KEY` may be sent. */
export function isOpenAiTranscribeUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'api.openai.com';
    } catch {
        return false;
    }
}
