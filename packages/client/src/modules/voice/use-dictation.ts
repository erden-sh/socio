import { useCallback, useEffect, useRef, useState } from 'react';

import { UPLOAD_HEADER } from '@socio/shared/media-types';
import { DICTATION_LIMITS, type DictationMethod } from '@socio/shared/voice/dictation';

import { LIVE_BATCH_WAIT_MS, LiveDictation, liveAudioContext, liveDictationSupported } from './dictation-stream';

/**
 * Dictation in the composer (CB-101): speech in, text out, handed to
 * `onText` for the draft. Never sends anything to the chat itself.
 *
 * - `device`: the browser's speech recognition (Web Speech API). Nothing
 *   reaches this server; the browser may use its maker's service.
 * - `server`: a MediaRecorder recording, transcribed by the workspace's
 *   voice provider (`POST /api/voice/transcriptions`); or, where the
 *   server streams (CB-222), live text as it listens (dictation-stream.ts),
 *   with that recording sent instead when the stream fails.
 */
export type DictationStatus = 'idle' | 'listening' | 'transcribing';

/** The browser's speech recognition, prefixed in Safari and Chrome. */
interface Recognition {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: RecognitionResultEvent) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    onaudiostart?: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
interface RecognitionResultEvent {
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    const scope = window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
    };
    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/**
 * An iPhone or iPad, where continuous recognition doesn't end when told
 * to: one utterance at a time there, which ends itself after a pause.
 */
function iosWebKit() {
    if (typeof navigator === 'undefined') {
        return false;
    }
    return (
        /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
}

/** How long device recognition may stay silent before it counts as stuck. */
export const DEVICE_START_TIMEOUT_MS = 8000;
/** How long Done waits for recognition to end before using what it heard. */
export const DEVICE_STOP_GRACE_MS = 1500;

/** Device dictation works in this browser. */
export const deviceDictationSupported = () => !!recognitionConstructor();

/** This browser can record for server dictation. */
export const serverDictationSupported = () =>
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

/** The recording type this browser makes that the provider reads. */
function recordingType() {
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
        if (MediaRecorder.isTypeSupported?.(type)) {
            return type;
        }
    }
    return '';
}

export const DICTATION_ERRORS = {
    permission: 'Microphone access was denied. Allow it for this site in your browser’s settings, then try again.',
    noMic: 'No microphone was found.',
    nothingHeard: 'Nothing was heard. Try again, a little closer to the mic.',
    tooLong: 'The recording is too long to transcribe. Try a shorter one.',
    deviceService: 'Speech recognition on this device stopped working. Try again in a moment.',
    deviceStuck:
        'Speech recognition on this device didn’t respond. On iPhone, check that Dictation is on (Settings → General → Keyboard), or try in Safari instead of the installed app.',
    server: 'Transcription failed. Try again in a moment.',
};

function microphoneError(error: unknown) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return DICTATION_ERRORS.permission;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return DICTATION_ERRORS.noMic;
    }
    return 'The microphone could not start.';
}

/**
 * Speech recognition's error codes, in words. `aborted` is a cancel, and
 * `no-speech` is the same as hearing nothing.
 */
function recognitionError(code: string) {
    if (code === 'not-allowed' || code === 'service-not-allowed') {
        return DICTATION_ERRORS.permission;
    }
    if (code === 'audio-capture') {
        return DICTATION_ERRORS.noMic;
    }
    if (code === 'no-speech') {
        return DICTATION_ERRORS.nothingHeard;
    }
    return DICTATION_ERRORS.deviceService;
}

export function useDictation(
    onText: (text: string) => void,
    /** `live`: stream for live text (`setup.transcriptionStreaming`, CB-222). */
    settings: { live?: boolean } = {},
) {
    const options = useRef(settings);
    options.current = settings;
    const [status, setStatus] = useState<DictationStatus>('idle');
    const [method, setMethod] = useState<DictationMethod>();
    const [error, setError] = useState('');
    // The words so far, shown while it listens: device dictation's, or the
    // server's live text (CB-222).
    const [heard, setHeard] = useState('');
    const [startedAt, setStartedAt] = useState<number>();
    const deliver = useRef(onText);
    deliver.current = onText;
    // Each start is a generation: a cancel or a newer start ends the old one.
    const generation = useRef(0);
    const session = useRef<{
        stop: () => void;
        cancel: () => void;
    }>(undefined);

    const finish = useCallback((attempt: number, text: string, problem = '') => {
        if (attempt !== generation.current) {
            return;
        }
        session.current = undefined;
        setStatus('idle');
        setHeard('');
        setStartedAt(undefined);
        const words = text.trim();
        if (words) {
            deliver.current(words);
        } else {
            setError(problem || DICTATION_ERRORS.nothingHeard);
        }
    }, []);

    const startDevice = (attempt: number) => {
        const Constructor = recognitionConstructor();
        if (!Constructor) {
            finish(attempt, '', 'Dictation on this device isn’t available here.');
            return;
        }
        const recognition = new Constructor();
        recognition.continuous = !iosWebKit();
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        let finalText = '';
        let interim = '';
        let problem = '';
        const heardSoFar = () => `${finalText}${interim}`;
        // Never wait on the recognizer: it can go quiet (an installed iPhone
        // app), and the composer must stay usable (CB-101). Silent too long, it
        // is given up on; Done uses what was heard if it doesn't end in time.
        let timer = setTimeout(() => {
            quit();
            finish(attempt, '', DICTATION_ERRORS.deviceStuck);
        }, DEVICE_START_TIMEOUT_MS);
        const alive = () => clearTimeout(timer);
        const quit = () => {
            clearTimeout(timer);
            recognition.onresult = recognition.onerror = recognition.onend = null;
            // Later, so the screen has already moved on if it is slow to stop.
            setTimeout(() => {
                try {
                    recognition.abort();
                } catch {
                    // Already ended.
                }
            });
        };
        recognition.onaudiostart = alive;
        recognition.onresult = (event) => {
            if (attempt !== generation.current) {
                return;
            }
            alive();
            finalText = '';
            interim = '';
            for (const result of Array.from(event.results)) {
                if (result.isFinal) {
                    finalText += result[0].transcript;
                } else {
                    interim += result[0].transcript;
                }
            }
            setHeard(heardSoFar().trim());
        };
        recognition.onerror = (event) => {
            if (event.error !== 'aborted') {
                problem = recognitionError(event.error);
            }
        };
        recognition.onend = () => {
            clearTimeout(timer);
            // What it heard counts, even when it stopped on an error after.
            finish(attempt, heardSoFar(), problem);
        };
        session.current = {
            stop: () => {
                try {
                    recognition.stop();
                } catch {
                    // Already ended.
                }
                clearTimeout(timer);
                timer = setTimeout(() => {
                    quit();
                    finish(attempt, heardSoFar(), problem);
                }, DEVICE_STOP_GRACE_MS);
            },
            cancel: quit,
        };
        try {
            recognition.start();
            setStatus('listening');
            setStartedAt(Date.now());
        } catch {
            quit();
            finish(attempt, '', DICTATION_ERRORS.deviceService);
        }
    };

    /**
     * A recording to the server for its text (`POST /api/voice/transcriptions`):
     * the text, or the error to show. Undefined when aborted.
     */
    const upload = async (
        audio: Blob,
        signal: AbortSignal,
    ): Promise<{ text: string } | { error: string } | undefined> => {
        if (audio.size > DICTATION_LIMITS.maxBytes) {
            return { error: DICTATION_ERRORS.tooLong };
        }
        try {
            const response = await fetch('/api/voice/transcriptions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    [UPLOAD_HEADER]: '1',
                    'X-File-Type': audio.type,
                },
                body: audio,
                signal,
            });
            const data = (await response.json().catch(() => ({}))) as {
                text?: string;
                error?: string;
            };
            return response.ok ? { text: data.text ?? '' } : { error: data.error || DICTATION_ERRORS.server };
        } catch {
            return signal.aborted ? undefined : { error: DICTATION_ERRORS.server };
        }
    };
    const transcribe = async (attempt: number, audio: Blob, signal: AbortSignal, cancelled: () => boolean) => {
        if (cancelled() || attempt !== generation.current) {
            return;
        }
        if (!audio.size) {
            finish(attempt, '');
            return;
        }
        setStatus('transcribing');
        const result = await upload(audio, signal);
        if (!result || cancelled()) {
            return;
        }
        if ('error' in result) {
            finish(attempt, '', result.error);
        } else {
            finish(attempt, result.text);
        }
    };

    const startRecorder = (attempt: number, stream: MediaStream) => {
        const type = recordingType();
        const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        const chunks: Blob[] = [];
        const controller = new AbortController();
        let cancelled = false;
        const release = () => stream.getTracks().forEach((track) => track.stop());
        const limit = setTimeout(
            () => recorder.state === 'recording' && recorder.stop(),
            DICTATION_LIMITS.maxSeconds * 1000,
        );
        recorder.ondataavailable = (event) => {
            if (event.data.size) {
                chunks.push(event.data);
            }
        };
        recorder.onstop = () => {
            clearTimeout(limit);
            release();
            void transcribe(
                attempt,
                new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }),
                controller.signal,
                () => cancelled,
            );
        };
        session.current = {
            stop: () => recorder.state === 'recording' && recorder.stop(),
            cancel: () => {
                cancelled = true;
                controller.abort();
                clearTimeout(limit);
                if (recorder.state === 'recording') {
                    recorder.stop();
                }
                release();
            },
        };
        recorder.start();
        setStatus('listening');
        setStartedAt(Date.now());
    };

    /**
     * Live text (CB-222): the partial text shows while it listens, and the
     * final text replaces it. Without the socket, or when it drops, Done
     * sends the recording kept meanwhile. False when the capture can't run
     * here: the caller records instead.
     */
    const startLive = async (attempt: number, stream: MediaStream, context: AudioContext) => {
        let live: LiveDictation;
        try {
            live = await LiveDictation.start(
                context,
                stream,
                (text) => attempt === generation.current && setHeard(text),
                () => session.current?.stop(),
            );
        } catch {
            void context.close().catch(() => undefined);
            return false;
        }
        if (attempt !== generation.current) {
            live.cancel();
            return true;
        }
        const controller = new AbortController();
        let cancelled = false;
        let stopping = false;
        const limit = setTimeout(() => session.current?.stop(), DICTATION_LIMITS.maxSeconds * 1000);
        session.current = {
            stop: () => {
                if (stopping) {
                    return;
                }
                stopping = true;
                clearTimeout(limit);
                // The live text stays, finishing, until the final text is in.
                setStatus('transcribing');
                void (async () => {
                    const current = () => !cancelled && attempt === generation.current;
                    // Safe to call twice, or after a failure.
                    const close = () => {
                        try {
                            live.cancel();
                        } catch {
                            // Already ended.
                        }
                    };
                    let streamed: Promise<string | undefined> = Promise.resolve(undefined);
                    let batch: { text: string } | { error: string } | undefined;
                    let failed = false;
                    try {
                        const result = await live.finish();
                        streamed = result.streamed;
                        if (!current()) {
                            return;
                        }
                        // The recording, once, transcribed whole: its text is the final
                        // one; the streamed text was a preview (CB-222). No time limit
                        // of its own, as when recording and sending: only after
                        // LIVE_BATCH_WAIT_MS does a streamed final text, if one comes,
                        // take its place.
                        if (result.clip?.size) {
                            type Outcome = { batch: typeof batch } | { text: string };
                            const uploading: Promise<Outcome> = upload(result.clip, controller.signal).then(
                                (value) => ({ batch: value }),
                            );
                            let timer: ReturnType<typeof setTimeout> | undefined;
                            const slow = new Promise<undefined>(
                                (resolve) => (timer = setTimeout(() => resolve(undefined), LIVE_BATCH_WAIT_MS)),
                            );
                            let outcome = await Promise.race([uploading, slow]);
                            clearTimeout(timer);
                            if (!outcome) {
                                outcome = await Promise.race([
                                    uploading,
                                    streamed.then((text): Outcome | Promise<Outcome> =>
                                        text?.trim() ? { text } : uploading,
                                    ),
                                ]);
                            }
                            if (!current()) {
                                return;
                            }
                            if ('text' in outcome) {
                                controller.abort();
                                close();
                                finish(attempt, outcome.text);
                                return;
                            }
                            if ('batch' in outcome) {
                                batch = outcome.batch;
                            }
                        }
                    } catch {
                        // Here only from a browser without what this needs (an old
                        // Safari): the streamed text, else an error, never a hang.
                        failed = true;
                    }
                    if (!current()) {
                        return;
                    }
                    if (batch && 'text' in batch && batch.text.trim()) {
                        close();
                        finish(attempt, batch.text);
                        return;
                    }
                    const text = (await streamed.catch(() => undefined))?.trim();
                    close();
                    if (!current()) {
                        return;
                    }
                    if (text) {
                        finish(attempt, text);
                    } else {
                        finish(
                            attempt,
                            '',
                            batch && 'error' in batch ? batch.error : failed ? DICTATION_ERRORS.server : '',
                        );
                    }
                })();
            },
            cancel: () => {
                cancelled = true;
                controller.abort();
                clearTimeout(limit);
                live.cancel();
            },
        };
        setStatus('listening');
        setStartedAt(Date.now());
        return true;
    };

    const startServer = async (attempt: number) => {
        // Made in the tap, before the microphone is asked for (iOS).
        const context = options.current.live && liveDictationSupported() ? liveAudioContext() : undefined;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            void context?.close().catch(() => undefined);
            finish(attempt, '', microphoneError(e));
            return;
        }
        if (attempt !== generation.current) {
            stream.getTracks().forEach((track) => track.stop());
            void context?.close().catch(() => undefined);
            return;
        }
        if (context && (await startLive(attempt, stream, context))) {
            return;
        }
        if (attempt !== generation.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        startRecorder(attempt, stream);
    };

    const start = (next: DictationMethod) => {
        session.current?.cancel();
        const attempt = ++generation.current;
        setMethod(next);
        setError('');
        setHeard('');
        if (next === 'device') {
            startDevice(attempt);
        } else {
            // Listening from the moment it asks for the mic: Cancel works at once.
            setStatus('listening');
            void startServer(attempt);
        }
    };
    /** Ends listening; what was heard goes to the draft. */
    const stop = () => session.current?.stop();
    /** Ends listening or transcribing; nothing goes to the draft. */
    const cancel = useCallback(() => {
        generation.current++;
        const ending = session.current;
        session.current = undefined;
        setStatus('idle');
        setHeard('');
        setStartedAt(undefined);
        ending?.cancel();
    }, []);
    useEffect(() => cancel, [cancel]);
    return {
        status,
        method,
        error,
        heard,
        startedAt,
        start,
        stop,
        cancel,
        dismissError: () => setError(''),
    };
}
export type Dictation = ReturnType<typeof useDictation>;

/**
 * Puts dictated text into the draft at the cursor (or the selection), with
 * a space on each side where words would otherwise run together, within
 * the composer's length. Returns the new draft and where the cursor goes.
 */
export function insertDictation(draft: string, text: string, start = draft.length, end = start, maxLength = 4000) {
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
    const room = maxLength - before.length - after.length;
    const inserted = `${lead}${text}${trail}`.slice(0, Math.max(0, room));
    return {
        value: `${before}${inserted}${after}`,
        caret: before.length + inserted.length,
    };
}
