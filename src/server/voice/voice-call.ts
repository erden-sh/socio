import { WebSocket, type RawData } from 'ws';

import type { SpeechProvider } from '@socio/foundation/voice/speech-provider';
import type { DictationLanguage } from '@socio/shared/voice/dictation-languages';
import {
    CALL_LIMITS,
    CALL_STREAM,
    speechPieces,
    spokenText,
    type CallStreamEvent,
} from '@socio/shared/voice/voice-call';

import { realtimeTranscription } from './transcription.js';
import { SpeechError, synthesize } from './voice-speech.js';

/**
 * A self-hosted voice call (CB-265), one browser socket's worth. The
 * browser streams its microphone here (`CALL_STREAM`); this server relays
 * it to the transcription server's realtime socket, an OpenAI
 * Realtime-style transcription session with server VAD (socio-voice's
 * `WS /v1/realtime`, as live dictation uses, CB-222). Each turn the
 * person finishes becomes a turn of the socio (`turn`): its model, tools,
 * permissions, approvals and limits, as a typed message. The reply is
 * spoken by the speech server (`POST /v1/audio/speech`) and streamed back
 * as PCM; with none, or when it fails, the browser speaks it itself.
 *
 * The key rules are dictation's (CB-204): each key goes as a bearer token
 * to the URL it is bound to and nowhere else, over wss/https (or to this
 * machine), never across a redirect; the browser never sees one. The
 * audio is passed on and never stored; what was said is stored as the
 * conversation's messages, as typed ones are.
 */

export const SESSION_LIMITS = {
    /** How long the transcription server may take to answer the socket. */
    connectMs: 10_000,
    /** Audio held before the server listens (5 s); older audio is dropped. */
    heldBytes: 5 * CALL_STREAM.inputRate * 2,
    /** Audio goes on in appends of at least 100 ms. */
    appendBytes: 3_200,
    /** Sent but not yet taken by the transcription server: past this, the call ends. */
    maxBufferedBytes: 1024 * 1024,
    /** One message from the transcription server. */
    maxUpstreamBytes: 1024 * 1024,
    /** Silence that ends what the person is saying. */
    silenceMs: 600,
};

/** What a call needs from the rest of the server. */
export interface CallSessionDeps {
    /**
     * The transcription server's realtime socket, its key and model, and
     * the caller's dictation language (CB-221; none: Auto, the server
     * detects it).
     */
    socket: {
        url: string;
        secret?: string;
        model: string;
        language?: DictationLanguage;
    };
    /** The speech server in force; unavailable: the browser speaks. */
    speech: SpeechProvider;
    /** The socio's name, for the transcript. */
    name: string;
    /** One turn of the socio: what the person said in, its reply out. */
    turn: (text: string, signal: AbortSignal) => Promise<string>;
    /** The transcription server is listening: the call is active. */
    onReady: () => void;
    /**
     * The session is over: either side closed, or it never connected
     * (`connected` false). `reason` is for the person.
     */
    onClose: (outcome: { transcript: string; reason?: string; connected: boolean }) => void;
    log: (line: string) => void;
    transport?: typeof fetch;
}

const send = (socket: WebSocket, event: CallStreamEvent) => {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
    }
};

/** Why a socket that never opened can't take the call, for the person. */
export function connectFailure(status?: number) {
    if (status === 401 || status === 403) {
        return 'The self-hosted voice server refused Socio’s key. An admin checks the transcription key in Settings → General → Transcription.';
    }
    if (status === 404 || status === 405 || status === 426) {
        return 'The self-hosted voice server has no realtime socket at the transcription URL, so calls can’t run on it. An admin checks Settings → General → Transcription.';
    }
    if (status && status >= 300 && status < 400) {
        return 'The self-hosted voice server redirected the call, which is refused (a key would go elsewhere). An admin sets the transcription URL to the server itself.';
    }
    return 'The self-hosted voice server isn’t answering, so the call couldn’t start. Try again in a few minutes, or type instead.';
}

export class CallSession {
    readonly limits = SESSION_LIMITS;
    private upstream: WebSocket;
    private ready = false;
    private closed = false;
    /** Lines of the call, `You: …` and `<socio>: …`. */
    readonly lines: string[] = [];
    private held = Buffer.alloc(0);
    private queue: string[] = [];
    private turning = false;
    private turnAbort = new AbortController();
    private speechAbort?: AbortController;
    private speaking: Promise<void> = Promise.resolve();
    /** The speech server failed this call: the browser speaks from here on. */
    private speechDown = false;
    private partials = new Map<string, string>();
    private timer: ReturnType<typeof setTimeout>;

    constructor(
        private browser: WebSocket,
        private deps: CallSessionDeps,
    ) {
        const host = new URL(deps.socket.url).host;
        const log = (problem: string) => deps.log(`Voice: call socket at ${host} ${problem}.`);
        this.upstream = new WebSocket(deps.socket.url, {
            headers: deps.socket.secret ? { Authorization: `Bearer ${deps.socket.secret}` } : {},
            followRedirects: false,
            handshakeTimeout: this.limits.connectMs,
            maxPayload: this.limits.maxUpstreamBytes,
            perMessageDeflate: false,
        });
        // A call never lasts past its limit, whatever else happens.
        this.timer = setTimeout(() => this.close('This call reached its 15-minute limit.'), CALL_LIMITS.maxMs);
        this.timer.unref?.();
        this.upstream.on('unexpected-response', (request, response) => {
            const status = response.statusCode ?? 0;
            response.resume();
            request.destroy();
            log(status >= 300 && status < 400 ? 'redirected (refused)' : `answered HTTP ${status}`);
            this.close(connectFailure(status));
        });
        this.upstream.on('error', (error) => {
            if (this.closed) {
                return;
            }
            log(`failed (${error.name})`);
            this.close(
                this.ready
                    ? 'The connection to the self-hosted voice server dropped. Start the call again, or type instead.'
                    : connectFailure(),
            );
        });
        this.upstream.on('close', () => {
            if (this.closed) {
                return;
            }
            if (this.ready) {
                log('closed the socket');
            }
            this.close(
                this.ready
                    ? 'The connection to the self-hosted voice server dropped. Start the call again, or type instead.'
                    : connectFailure(),
            );
        });
        this.upstream.on('open', () => {
            if (this.closed) {
                return;
            }
            this.ready = true;
            this.tell({
                type: 'transcription_session.update',
                session: {
                    input_audio_format: 'pcm16',
                    input_audio_sample_rate: CALL_STREAM.inputRate,
                    input_audio_transcription: realtimeTranscription(deps.socket.model, deps.socket.language),
                    turn_detection: {
                        type: 'server_vad',
                        silence_duration_ms: this.limits.silenceMs,
                    },
                },
            });
            this.flush();
            send(browser, {
                type: 'ready',
                speech: deps.speech.available,
            });
            deps.onReady();
        });
        this.upstream.on('message', (data: RawData, binary) => {
            if (this.closed || binary) {
                return;
            }
            let event: {
                type?: unknown;
                item_id?: unknown;
                delta?: unknown;
                partial?: unknown;
                transcript?: unknown;
                error?: { code?: unknown };
            };
            try {
                event = JSON.parse(String(data)) as typeof event;
            } catch {
                return;
            }
            const item = typeof event.item_id === 'string' ? event.item_id : '';
            switch (event.type) {
                case 'input_audio_buffer.speech_started':
                    // Barge-in: the person talks over the reply, which stops.
                    this.speechAbort?.abort();
                    send(browser, { type: 'speech' });
                    return;
                case 'conversation.item.input_audio_transcription.delta': {
                    if (!item || typeof event.delta !== 'string') {
                        return;
                    }
                    const text =
                        event.partial === true ? event.delta : `${this.partials.get(item) ?? ''}${event.delta}`;
                    this.partials.set(item, text);
                    send(browser, { type: 'partial', text: text.slice(0, 4000) });
                    return;
                }
                case 'conversation.item.input_audio_transcription.completed': {
                    if (typeof event.transcript !== 'string') {
                        return;
                    }
                    this.partials.delete(item);
                    const text = event.transcript.trim().slice(0, 4000);
                    if (!text) {
                        send(browser, { type: 'partial', text: '' });
                        return;
                    }
                    this.lines.push(`You: ${text}`);
                    send(browser, { type: 'heard', text });
                    this.queue.push(text);
                    this.pump();
                    return;
                }
                case 'error':
                    log(`sent an error (${String(event.error?.code ?? 'no code')})`);
                    return;
                default:
                    return;
            }
        });

        browser.on('message', (data: RawData, binary) => {
            if (this.closed) {
                return;
            }
            if (!binary) {
                let message: { type?: unknown } | null = null;
                try {
                    message = JSON.parse(String(data)) as { type?: unknown };
                } catch {
                    // Not a message: ignored.
                }
                if (message?.type === 'interrupt') {
                    this.speechAbort?.abort();
                }
                return;
            }
            const audio = Buffer.isBuffer(data)
                ? data
                : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
            // Whole 16-bit samples only.
            if (audio.length % 2 || audio.length > CALL_LIMITS.maxFrameBytes) {
                return;
            }
            this.held = Buffer.concat([this.held, audio]);
            if (!this.ready && this.held.length > this.limits.heldBytes) {
                this.held = this.held.subarray(this.held.length - this.limits.heldBytes);
            }
            this.flush();
        });
        browser.on('close', () => this.close());
        browser.on('error', () => this.close());
    }

    /** Something for the person to see during the call (an approval waiting). */
    notice(text: string) {
        if (!this.closed) {
            send(this.browser, { type: 'notice', text });
        }
    }

    get transcript() {
        return this.lines.join('\n').slice(0, 20_000);
    }

    private tell(event: object) {
        if (this.upstream.readyState !== WebSocket.OPEN) {
            return;
        }
        this.upstream.send(JSON.stringify(event));
        if (this.upstream.bufferedAmount > this.limits.maxBufferedBytes) {
            this.deps.log('Voice: the call socket fell behind.');
            this.close('The self-hosted voice server fell behind, so the call ended. Start it again, or type instead.');
        }
    }

    private flush() {
        if (!this.ready || this.held.length < this.limits.appendBytes) {
            return;
        }
        this.tell({
            type: 'input_audio_buffer.append',
            audio: this.held.toString('base64'),
        });
        this.held = Buffer.alloc(0);
    }

    /** The next turn, once the one running is done: what was said meanwhile, together. */
    private pump() {
        if (this.closed || this.turning || !this.queue.length) {
            return;
        }
        const text = this.queue.splice(0).join(' ');
        this.turning = true;
        send(this.browser, { type: 'thinking' });
        this.deps
            .turn(text, this.turnAbort.signal)
            .then((reply) => {
                if (this.closed) {
                    return;
                }
                this.lines.push(`${this.deps.name}: ${reply}`);
                this.say(reply);
            })
            .catch((error: unknown) => {
                if (this.closed) {
                    return;
                }
                const message = error instanceof Error && error.message ? error.message : 'The turn failed.';
                this.notice(`That turn didn’t work: ${message}`);
                this.say(`Sorry, that didn't work. ${message}`);
            })
            .finally(() => {
                this.turning = false;
                this.pump();
            });
    }

    /** A reply, spoken after the ones before it. */
    private say(reply: string) {
        const text = spokenText(reply);
        if (!text) {
            return;
        }
        const audio = this.deps.speech.available && !this.speechDown;
        send(this.browser, { type: 'reply', text, audio });
        if (!audio) {
            return;
        }
        this.speaking = this.speaking.then(() => this.speak(text));
    }

    private async speak(text: string) {
        if (this.closed) {
            return;
        }
        const controller = new AbortController();
        this.speechAbort = controller;
        const pieces = speechPieces(text);
        let odd: Buffer | undefined;
        try {
            for (let i = 0; i < pieces.length; i++) {
                if (controller.signal.aborted || this.closed) {
                    return;
                }
                try {
                    for await (const chunk of synthesize(
                        this.deps.speech,
                        pieces[i],
                        AbortSignal.any([controller.signal, this.turnAbort.signal]),
                        this.deps.transport,
                    )) {
                        if (controller.signal.aborted || this.closed) {
                            return;
                        }
                        // Whole samples only: a byte left over goes with the next chunk.
                        let bytes = Buffer.from(chunk);
                        if (odd) {
                            bytes = Buffer.concat([odd, bytes]);
                        }
                        odd = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : undefined;
                        if (odd) {
                            bytes = bytes.subarray(0, bytes.length - 1);
                        }
                        if (bytes.length && this.browser.readyState === WebSocket.OPEN) {
                            this.browser.send(bytes);
                        }
                    }
                } catch (error) {
                    if (controller.signal.aborted || this.closed) {
                        return;
                    }
                    const host = this.deps.speech.url ? new URL(this.deps.speech.url).host : 'none';
                    this.deps.log(
                        `Voice: speech at ${host} ${error instanceof SpeechError ? error.message : 'failed'}.`,
                    );
                    this.speechDown = true;
                    this.notice(
                        'The speech server didn’t answer, so this device speaks the replies for the rest of the call.',
                    );
                    send(this.browser, {
                        type: 'say',
                        text: pieces.slice(i).join(' '),
                    });
                    return;
                }
            }
        } finally {
            if (this.speechAbort === controller) {
                this.speechAbort = undefined;
            }
            send(this.browser, { type: 'spoken' });
        }
    }

    /**
     * Ends the session: no more audio either way, the turn running and the
     * speech stopped. With a reason, the browser is told why first.
     */
    close(reason?: string) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.timer);
        this.turnAbort.abort();
        this.speechAbort?.abort();
        const connected = this.ready;
        this.upstream.terminate();
        if (reason) {
            send(this.browser, { type: 'ended', reason });
        }
        if (this.browser.readyState === WebSocket.OPEN) {
            this.browser.close(1000);
        } else {
            this.browser.terminate();
        }
        this.deps.onClose({ transcript: this.transcript, reason, connected });
    }
}
