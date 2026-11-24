import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { TranscriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { DICTATION_LIMITS, DICTATION_STREAM, type DictationStreamEvent } from '@socio/shared/voice/dictation';
import type { DictationLanguage } from '@socio/shared/voice/dictation-languages';
import { CALL_STREAM } from '@socio/shared/voice/voice-call';

import { UPGRADE_ENV, type DictationShape, type UpgradeEnv as ContractUpgradeEnv } from './contract.js';
import { realtimeTranscription } from './transcription.js';

/**
 * Live text while dictating (CB-222). The composer opens a socket here
 * (`DICTATION_STREAM.path`, signed in like any other API request) and
 * streams PCM; this server relays it to the transcription server's
 * realtime socket (`provider.realtimeUrl`), an OpenAI Realtime-style
 * transcription session, and sends back only the text. So the key never
 * reaches the browser, and every CB-204 rule holds for the socket: the key
 * goes as `Authorization: Bearer` to the realtime URL of the URL it is
 * bound to and nowhere else, over wss (or ws to this machine), never
 * across a redirect. The audio is passed on and never stored.
 */

/** A session's limits: a recording's, as for record-then-send, and the socket's own. */
export const STREAM_LIMITS = {
    /** The audio a session takes: `DICTATION_LIMITS.maxSeconds` of PCM. */
    maxBytes: DICTATION_LIMITS.maxSeconds * DICTATION_STREAM.sampleRate * 2,
    /** How long a session may last before it ends as if Done were pressed. */
    maxMs: DICTATION_LIMITS.maxSeconds * 1000 + 5_000,
    /** One frame from the browser (about 100 ms of audio is 3.2 KB). */
    maxFrameBytes: 64 * 1024,
    /** And at least 10 ms of audio, but for the last one before Done. */
    minFrameBytes: 320,
    /**
     * Audio goes on in appends of at least 100 ms (and at most 2 s), however
     * small the browser's frames; the rest goes with Done.
     */
    appendBytes: 3_200,
    appendMaxBytes: 64 * 1024,
    /** Sent but not yet taken by the transcription server: past this, the session ends. */
    maxBufferedBytes: 1024 * 1024,
    /** One message from the transcription server. */
    maxUpstreamBytes: 1024 * 1024,
    /** How long the transcription server may take to answer the socket. */
    connectMs: 10_000,
    /**
     * And the first session update (`auto`): a server that doesn't answer it
     * speaks another dialect, and gets record-then-send.
     */
    answerMs: 3_000,
    /** And to give the final text after Done; then the recording is sent instead. */
    finalMs: 15_000,
    /** Sessions open at once, everyone's; each person has one. */
    total: 20,
    /** Sessions one person may start in a minute. */
    startsPerMinute: 10,
    /** How long `auto` remembers a server without the socket. */
    batchOnlyMs: 10 * 60_000,
};

/**
 * Answers to the socket's handshake that mean there is no realtime socket
 * there: `auto` remembers them. A refused key (401, or 403: socio-voice
 * closes with 1008 before accepting) or a server that is down (502, 503)
 * isn't remembered.
 */
const NO_ENDPOINT = new Set([404, 405, 426]);

/** The contract's `UpgradeEnv` over `ws`'s `WebSocket`, as it was declared here. */
export type UpgradeEnv = ContractUpgradeEnv<WebSocket>;

/**
 * The HTTP server's `upgrade` event for `DICTATION_STREAM.path` (and
 * `CALL_STREAM.path`): the
 * request runs through the app (`fetch`) like any other, so the host,
 * origin, cross-site and session checks all apply, then its route claims
 * the upgrade. Unclaimed, its answer (401, 403…) is the handshake's.
 * Returns false for other paths.
 */
export function dictationUpgrade(
    fetch: (request: Request, env: UpgradeEnv) => Response | Promise<Response>,
    /** And self-hosted calls' socket (CB-265), checked the same way. */
    paths: readonly string[] = [DICTATION_STREAM.path, CALL_STREAM.path],
) {
    const sockets = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        perMessageDeflate: false,
        maxPayload: STREAM_LIMITS.maxFrameBytes,
    });
    return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!paths.includes((request.url ?? '').split('?')[0])) {
            return false;
        }
        socket.on('error', () => socket.destroy());
        // HTTP/1.1 requires a Host; without one there is nothing to check.
        if (!request.headers.host) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return true;
        }
        void (async () => {
            const headers = new Headers();
            for (let i = 0; i < request.rawHeaders.length; i += 2) {
                headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
            }
            let accept: ((socket: WebSocket) => void) | undefined;
            const response = await fetch(
                new Request(`http://${request.headers.host}${request.url}`, {
                    headers,
                }),
                { incoming: request, [UPGRADE_ENV]: (next) => (accept = next) },
            );
            if (!accept) {
                const body = Buffer.from(await response.text());
                socket.end(
                    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}\r\nConnection: close\r\nContent-Type: ${response.headers.get('content-type') ?? 'text/plain'}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
                );
                return;
            }
            const claimed = accept;
            sockets.handleUpgrade(request, socket, head, (ws) => claimed(ws));
        })().catch(() => socket.destroy());
        return true;
    };
}

/** Upstream events this relay reads (OpenAI Realtime transcription). */
interface UpstreamEvent {
    type?: unknown;
    item_id?: unknown;
    delta?: unknown;
    partial?: unknown;
    transcript?: unknown;
    error?: { code?: unknown };
}

const send = (socket: WebSocket, event: DictationStreamEvent) => {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
    }
};

/**
 * Every open session, one per person; how often each person started one;
 * and the servers `auto` leaves alone for a while.
 */
export class DictationStreams implements DictationShape {
    /** `STREAM_LIMITS`, read as each session goes (tests shorten them). */
    readonly limits = STREAM_LIMITS;
    private sessions = new Map<string, { end: () => void; unavailable: () => void }>();
    private batchOnly = new Map<string, number>();
    private starts = new Map<string, number[]>();
    constructor(private log: (line: string) => void = (line) => console.warn(line)) {}

    get open() {
        return this.sessions.size;
    }

    /**
     * `auto`, and this server's socket turned out missing a while ago: the
     * composer records, then sends (setup says so), until it is forgotten.
     */
    recordingsOnly(provider: TranscriptionProvider) {
        const url = provider.realtimeUrl;
        return provider.streaming === 'auto' && !!url && (this.batchOnly.get(url) ?? 0) > Date.now();
    }

    /** Forgets the servers without a socket: an admin changed the URL, key or setting. */
    forget() {
        this.batchOnly.clear();
    }

    private remember(provider: TranscriptionProvider) {
        if (provider.streaming === 'auto' && provider.realtimeUrl) {
            this.batchOnly.set(provider.realtimeUrl, Date.now() + this.limits.batchOnlyMs);
        }
    }

    /**
     * Whether a person may start a session now: undefined when they may
     * (the start counts toward their rate), else the refusal for the route
     * to answer with. A person's own older session doesn't count toward the
     * total: it ends when the new one opens.
     */
    admit(provider: TranscriptionProvider, userId: string) {
        if (!provider.realtimeUrl) {
            return {
                status: 409 as const,
                error: 'Live text is off for this transcription server.',
            };
        }
        if (this.recordingsOnly(provider)) {
            return {
                status: 409 as const,
                error: 'This transcription server has no live text.',
            };
        }
        const now = Date.now();
        const recent = (this.starts.get(userId) ?? []).filter((at) => at > now - 60_000);
        if (recent.length >= this.limits.startsPerMinute) {
            return {
                status: 429 as const,
                error: 'Live text was started too often. Try again in a minute.',
            };
        }
        if (!this.sessions.has(userId) && this.sessions.size >= this.limits.total) {
            return {
                status: 429 as const,
                error: 'Too many people are dictating. Try again in a moment.',
            };
        }
        recent.push(now);
        this.starts.set(userId, recent);
        return undefined;
    }

    /** Ends every session (a pause, a drain); each composer sends its recording. */
    closeAll() {
        for (const session of [...this.sessions.values()]) {
            session.unavailable();
        }
    }

    /**
     * Relays one browser socket to `provider.realtimeUrl` until Done, the
     * limits, or either side closes.
     *
     * The end of the text relies on the transcription server handling a
     * session's messages in order, as socio-voice and OpenAI do: after Done,
     * `input_audio_buffer.commit` and then a session update go, and the
     * update's answer comes only once everything before it, the last
     * turn's `...completed` included, has been sent.
     *
     * `language`: the person's dictation language (CB-221), read on the
     * server from their own preferences; undefined (Auto) sends none.
     */
    start(browser: WebSocket, userId: string, provider: TranscriptionProvider, language?: DictationLanguage) {
        // Handshakes admitted at once may outnumber the free places.
        if (!this.sessions.has(userId) && this.sessions.size >= this.limits.total) {
            send(browser, { type: 'unavailable' });
            browser.close(1013);
            return;
        }
        const url = provider.realtimeUrl!;
        const host = new URL(url).host;
        const log = (problem: string) => this.log(`Voice: live text at ${host} ${problem}.`);
        this.sessions.get(userId)?.end();
        // The transcription server's socket. No redirect is followed (a key
        // would go elsewhere), and nothing but the key goes in the handshake.
        const upstream = new WebSocket(url, {
            headers: provider.secret ? { Authorization: `Bearer ${provider.secret}` } : {},
            followRedirects: false,
            handshakeTimeout: this.limits.connectMs,
            maxPayload: this.limits.maxUpstreamBytes,
            perMessageDeflate: false,
        });
        let ready = false;
        let ended = false;
        let finishing = false;
        let bytes = 0;
        /** Audio not passed on yet: before the server listens, or under 100 ms. */
        // One buffer, grown by doubling (up to `maxBytes`), so frames held
        // while the server answers cost their bytes, not a Buffer each.
        let held = Buffer.alloc(0);
        let heldBytes = 0;
        const hold = (audio: Buffer) => {
            if (heldBytes + audio.length > held.length) {
                const grown = Buffer.alloc(Math.max(heldBytes + audio.length, held.length * 2, 16 * 1024));
                held.copy(grown, 0, 0, heldBytes);
                held = grown;
            }
            audio.copy(held, heldBytes);
            heldBytes += audio.length;
        };
        /** The last frame was under `minFrameBytes`: only one may be, before Done. */
        let tiny = false;
        /** The server sent `transcription_session.created`: it speaks this protocol. */
        let created = false;
        // Session updates sent and answered: the answer to the one after
        // `commit` comes once everything before it is transcribed.
        let updates = 0;
        let answered = 0;
        const order: string[] = [];
        const partials = new Map<string, string>();
        /** The text the browser has. */
        let shown = '';
        const finals = new Map<string, string>();
        const text = () =>
            order
                .map((item) => finals.get(item) ?? partials.get(item) ?? '')
                .map((part) => part.trim())
                .filter(Boolean)
                .join(' ')
                .slice(0, 4000);
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const later = (ms: number, fn: () => void) => {
            const timer = setTimeout(fn, ms);
            timer.unref?.();
            timers.push(timer);
        };
        const session = {
            end: () => {
                if (ended) {
                    return;
                }
                ended = true;
                timers.forEach(clearTimeout);
                if (this.sessions.get(userId)?.end === session.end) {
                    this.sessions.delete(userId);
                }
                upstream.terminate();
                if (browser.readyState === WebSocket.OPEN) {
                    browser.close(1000);
                } else {
                    browser.terminate();
                }
            },
        };
        /** No live text after all: the composer sends the recording. */
        const unavailable = () => {
            if (ended) {
                return;
            }
            send(browser, { type: 'unavailable' });
            session.end();
        };
        this.sessions.set(userId, { end: session.end, unavailable });
        const tell = (event: object) => {
            if (upstream.readyState !== WebSocket.OPEN) {
                return;
            }
            upstream.send(JSON.stringify(event));
            // A server that can't keep up doesn't get a growing queue here.
            if (upstream.bufferedAmount > this.limits.maxBufferedBytes) {
                log('fell behind');
                unavailable();
            }
        };
        const update = () => {
            updates++;
            tell({
                type: 'transcription_session.update',
                session: {
                    input_audio_format: 'pcm16',
                    input_audio_sample_rate: DICTATION_STREAM.sampleRate,
                    input_audio_transcription: realtimeTranscription(provider.model, language),
                },
            });
        };
        /** The audio so far in appends of 100 ms to 2 s; with `all`, the rest too. */
        const flush = (all = false) => {
            const least = all ? 1 : this.limits.appendBytes;
            if (!ready || heldBytes < least) {
                return;
            }
            let at = 0;
            while (!ended && heldBytes - at >= least) {
                const next = held.subarray(at, Math.min(heldBytes, at + this.limits.appendMaxBytes));
                at += next.length;
                tell({
                    type: 'input_audio_buffer.append',
                    audio: next.toString('base64'),
                });
            }
            held.copy(held, 0, at, heldBytes);
            heldBytes -= at;
        };
        /**
         * Done (or the limits): the rest is transcribed, then the text goes.
         * Before the server listens, there is no live text to finish.
         */
        const finish = () => {
            if (finishing || ended) {
                return;
            }
            finishing = true;
            if (!ready) {
                unavailable();
                return;
            }
            flush(true);
            tell({ type: 'input_audio_buffer.commit' });
            update();
            later(this.limits.finalMs, () => {
                log(`gave no final text within ${this.limits.finalMs / 1000} s`);
                unavailable();
            });
        };
        later(this.limits.maxMs, finish);

        upstream.on('unexpected-response', (request, response) => {
            const status = response.statusCode ?? 0;
            response.resume();
            request.destroy();
            log(status >= 300 && status < 400 ? 'redirected (refused)' : `answered HTTP ${status}`);
            // `auto`: a server without the socket records, then sends, for a while.
            if (NO_ENDPOINT.has(status)) {
                this.remember(provider);
            }
            unavailable();
        });
        upstream.on('error', (error) => {
            if (!ended) {
                log(`failed (${error.name})`);
            }
            unavailable();
        });
        upstream.on('close', () => {
            if (!ended && ready) {
                log('closed the socket');
            }
            unavailable();
        });
        upstream.on('open', () => {
            if (ended) {
                return;
            }
            ready = true;
            update();
            if (provider.streaming === 'auto') {
                later(this.limits.answerMs, () => {
                    if (answered) {
                        return;
                    }
                    log('did not answer the session update');
                    // One that said `...created` speaks the protocol, only slowly.
                    if (!created) {
                        this.remember(provider);
                    }
                    unavailable();
                });
            }
            flush();
            send(browser, { type: 'ready' });
        });
        upstream.on('message', (data: RawData, binary) => {
            if (ended || binary) {
                return;
            }
            let event: UpstreamEvent;
            try {
                event = JSON.parse(String(data)) as UpstreamEvent;
            } catch {
                return;
            }
            const item = typeof event.item_id === 'string' ? event.item_id : '';
            const seen = () => {
                if (item && !order.includes(item)) {
                    order.push(item);
                }
            };
            switch (event.type) {
                case 'transcription_session.created':
                case 'session.created':
                    created = true;
                    return;
                case 'input_audio_buffer.speech_started':
                    seen();
                    return;
                case 'conversation.item.input_audio_transcription.delta':
                    // A turn's late delta after its final text changes nothing.
                    if (!item || typeof event.delta !== 'string' || finals.has(item)) {
                        return;
                    }
                    seen();
                    // socio-voice sends the whole hypothesis so far (`partial`);
                    // OpenAI sends the words since the last delta.
                    partials.set(
                        item,
                        event.partial === true ? event.delta : `${partials.get(item) ?? ''}${event.delta}`,
                    );
                    break;
                case 'conversation.item.input_audio_transcription.completed':
                    if (!item || typeof event.transcript !== 'string') {
                        return;
                    }
                    seen();
                    finals.set(item, event.transcript);
                    partials.delete(item);
                    break;
                case 'transcription_session.updated':
                    answered++;
                    if (finishing && answered >= updates) {
                        send(browser, { type: 'final', text: text() });
                        session.end();
                    }
                    return;
                case 'error':
                    log(`sent an error (${String(event.error?.code ?? 'no code')})`);
                    return;
                default:
                    return;
            }
            const now = text();
            if (finishing || now === shown) {
                return;
            }
            shown = now;
            send(browser, { type: 'partial', text: now });
        });

        browser.on('message', (data: RawData, binary) => {
            if (ended) {
                return;
            }
            if (!binary) {
                let message: { type?: unknown } | null = null;
                try {
                    message = JSON.parse(String(data)) as { type?: unknown };
                } catch {
                    // Not a message: ignored.
                }
                if (message?.type === 'done') {
                    finish();
                }
                return;
            }
            if (finishing) {
                return;
            }
            const audio = Buffer.isBuffer(data)
                ? data
                : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
            // Whole 16-bit samples only, no more than a recording may be, and
            // frames of 10 ms or more but for the last: past these, it ends as
            // if Done were pressed.
            const small = audio.length < this.limits.minFrameBytes;
            if (audio.length % 2 || bytes + audio.length > this.limits.maxBytes || (small && tiny)) {
                finish();
                return;
            }
            tiny = small;
            bytes += audio.length;
            hold(audio);
            flush();
        });
        browser.on('close', session.end);
        browser.on('error', session.end);
    }
}
