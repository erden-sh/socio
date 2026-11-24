// Testing only (CB-222): a loopback stand-in for socio-voice's transcription
// server (~/stacks/voice/cb132), with its protocol. `WS /v1/realtime` is an
// OpenAI Realtime-style transcription session: a bearer token in the
// Authorization header or a `bearer.<token>` subprotocol; then
// `transcription_session.created`, and for each client message in turn:
// `transcription_session.update` → `transcription_session.updated`,
// `input_audio_buffer.append` (base64 pcm16) → speech, `..._commit` → the
// end of the turn, each in the order they came, as socio-voice handles
// them. A bad token is refused as socio-voice does: it closes with 1008
// before accepting, which reaches the client as HTTP 403. Instead of a model and VAD it "hears" the next scripted
// word every `bytesPerWord` of audio: `speech_started` when a turn opens,
// a `...transcription.delta` with the whole hypothesis (`partial: true`),
// and after `wordsPerTurn` words (or a commit) `speech_stopped`,
// `committed` and `...transcription.completed`. `POST
// /v1/audio/transcriptions` answers `{ text }` for record-then-send.
// With `speech` (CB-265) it is socio-voice's speech endpoint too:
// `POST /v1/audio/speech` (OpenAI's) answers `speech.bytes` of 16-bit PCM
// in two chunks, `speech.gapMs` apart, or `speech.status` instead.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeRealtimeOptions {
    /** The bearer token it wants; none: open (as socio-voice without a tokens file). */
    token?: string;
    /** What it hears, word by word, again from the start when it runs out. */
    words?: string[];
    bytesPerWord?: number;
    wordsPerTurn?: number;
    /** The socket answers this instead: a redirect (with `location`), 404… */
    refuse?: { status: number; location?: string };
    /** Closes the socket after this many appends (a drop mid-way). */
    dropAfterAppends?: number;
    /** Never answers a session update after a commit (a stuck server). */
    stuckAfterCommit?: boolean;
    /** Never answers a session update at all (another dialect). */
    ignoreUpdates?: boolean;
    /** Says nothing on opening (no `transcription_session.created`). */
    quietOnOpen?: boolean;
    /** Answers the handshake only after this long (a slow server). */
    delayUpgradeMs?: number;
    /** Accepts the socket, then closes it with this code (1008: a policy refusal). */
    closeAfterOpen?: number;
    /** After each turn's final text, a late delta for the same turn. */
    staleDelta?: boolean;
    /** Every turn's final text is empty (heard nothing it could transcribe). */
    emptyFinals?: boolean;
    /** An `error` event in answer to each commit (OpenAI's empty-buffer error). */
    errorOnCommit?: boolean;
    /** Stops reading the socket once open: a server that can't keep up. */
    stopReading?: boolean;
    /** Serves https and wss with this key and certificate. */
    tls?: { key: string; cert: string };
    /** The record-then-send answer. */
    batchText?: string;
    /** Where it listens on 127.0.0.1; any free port by default. */
    port?: number;
    /** Hears nothing more after this many turns of a session (a smoke run's mic never stops). */
    maxTurns?: number;
    /** `POST /v1/audio/speech` (CB-265); without it, 404. */
    speech?: {
        /** The bearer token it wants; none: `token`'s, or open. */
        token?: string;
        /** PCM bytes per answer (odd counts test the sample boundary). */
        bytes?: number;
        /** Between the two chunks of an answer. */
        gapMs?: number;
        /** Answers this status, with a JSON error, instead of audio. */
        status?: number;
        /** Only from this request on (1-based): the ones before answer audio. */
        failFrom?: number;
    };
}

export interface FakeRealtime {
    /** `http://127.0.0.1:<port>`: the transcription base URL. */
    url: string;
    /** Every socket handshake: its path and headers. */
    handshakes: Array<{ path: string; headers: IncomingHttpHeaders }>;
    /** Every message the sessions got, parsed. */
    received: Array<Record<string, unknown>>;
    /** Every record-then-send request: its headers. */
    uploads: IncomingHttpHeaders[];
    /** Every speech request: its headers and JSON body, and whether it was cut short. */
    speeches: Array<{
        headers: IncomingHttpHeaders;
        body: Record<string, unknown>;
        aborted: boolean;
    }>;
    /** Audio bytes appended, all sessions. */
    audioBytes: () => number;
    /** Each append's size in bytes, all sessions. */
    appends: number[];
    close: () => Promise<void>;
}

export async function startFakeRealtime(options: FakeRealtimeOptions = {}): Promise<FakeRealtime> {
    const words = options.words ?? ['hello', 'from', 'the', 'fake', 'server'];
    const bytesPerWord = options.bytesPerWord ?? 3200;
    const wordsPerTurn = options.wordsPerTurn ?? 3;
    const handshakes: FakeRealtime['handshakes'] = [];
    const received: FakeRealtime['received'] = [];
    const uploads: FakeRealtime['uploads'] = [];
    const speeches: FakeRealtime['speeches'] = [];
    const appendSizes: number[] = [];
    let audio = 0;
    const authorized = (headers: IncomingHttpHeaders) => {
        if (!options.token) {
            return true;
        }
        const protocol = String(headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map((part) => part.trim())
            .find((part) => part.startsWith('bearer.'));
        return headers.authorization === `Bearer ${options.token}` || protocol === `bearer.${options.token}`;
    };
    const http = (options.tls ? createTlsServer(options.tls) : createServer()).on('request', (request, response) => {
        if (request.method === 'POST' && request.url === '/v1/audio/transcriptions') {
            uploads.push(request.headers);
            request.resume();
            request.on('end', () => {
                if (!authorized(request.headers)) {
                    response.writeHead(401).end();
                    return;
                }
                response
                    .writeHead(200, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ text: options.batchText ?? 'from the clip' }));
            });
            return;
        }
        if (options.speech && request.method === 'POST' && request.url === '/v1/audio/speech') {
            const speech = options.speech;
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const entry = {
                    headers: request.headers,
                    body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>,
                    aborted: false,
                };
                speeches.push(entry);
                const token = speech.token ?? options.token;
                if (token && request.headers.authorization !== `Bearer ${token}`) {
                    response.writeHead(401).end();
                    return;
                }
                if (speech.status && speeches.length >= (speech.failFrom ?? 1)) {
                    response
                        .writeHead(speech.status, { 'Content-Type': 'application/json' })
                        .end(JSON.stringify({ error: { message: 'speech failed' } }));
                    return;
                }
                const bytes = speech.bytes ?? 4801;
                const half = Math.floor(bytes / 2) + 1;
                response.on('close', () => {
                    if (!response.writableFinished) {
                        entry.aborted = true;
                    }
                });
                response.writeHead(200, { 'Content-Type': 'audio/pcm' });
                response.write(Buffer.alloc(half, 7));
                setTimeout(() => {
                    if (!response.destroyed) {
                        response.end(Buffer.alloc(bytes - half, 7));
                    }
                }, speech.gapMs ?? 0);
            });
            return;
        }
        response.writeHead(404).end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    const sessions = new Set<WebSocket>();
    http.on('upgrade', (request, socket, head) => {
        handshakes.push({ path: request.url ?? '', headers: request.headers });
        const refuse = (status: number, extra = '') =>
            socket.end(`HTTP/1.1 ${status} No\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
        if (options.refuse) {
            return refuse(
                options.refuse.status,
                options.refuse.location ? `Location: ${options.refuse.location}\r\n` : '',
            );
        }
        if (request.url !== '/v1/realtime') {
            return refuse(404);
        }
        if (!authorized(request.headers)) {
            return refuse(403);
        }
        const accept = () =>
            sockets.handleUpgrade(request, socket, head, (ws) => {
                if (options.stopReading) {
                    socket.pause();
                }
                session(ws);
            });
        if (options.delayUpgradeMs) {
            setTimeout(accept, options.delayUpgradeMs);
        } else {
            accept();
        }
    });
    let next = 0;
    let spoken = 0;
    const session = (ws: WebSocket) => {
        sessions.add(ws);
        ws.on('close', () => sessions.delete(ws));
        let id = 0;
        let item: string | undefined;
        let heard: string[] = [];
        let pending = 0;
        let appends = 0;
        let committed = false;
        let turns = 0;
        const send = (event: Record<string, unknown>) => ws.send(JSON.stringify({ event_id: `ev_${++id}`, ...event }));
        const commit = () => {
            if (!item) {
                return;
            }
            const done = item;
            const text = heard.join(' ');
            turns++;
            item = undefined;
            heard = [];
            send({ type: 'input_audio_buffer.speech_stopped', item_id: done });
            send({ type: 'input_audio_buffer.committed', item_id: done });
            send({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: done,
                content_index: 0,
                transcript: options.emptyFinals ? '' : text,
            });
            if (options.staleDelta) {
                send({
                    type: 'conversation.item.input_audio_transcription.delta',
                    item_id: done,
                    content_index: 0,
                    delta: 'stale words',
                    partial: true,
                });
            }
        };
        if (!options.quietOnOpen) {
            send({
                type: 'transcription_session.created',
                session: { model: 'fake', input_audio_format: 'pcm16' },
            });
        }
        if (options.closeAfterOpen) {
            ws.close(options.closeAfterOpen);
            return;
        }
        ws.on('message', (data) => {
            const event = JSON.parse(String(data)) as Record<string, unknown>;
            received.push(event);
            if (event.type === 'input_audio_buffer.append') {
                const bytes = Buffer.from(String(event.audio), 'base64').length;
                audio += bytes;
                appendSizes.push(bytes);
                pending += bytes;
                if (++appends === options.dropAfterAppends) {
                    ws.terminate();
                    return;
                }
                if (options.maxTurns !== undefined && turns >= options.maxTurns) {
                    pending = 0;
                }
                while (pending >= bytesPerWord) {
                    pending -= bytesPerWord;
                    if (!item) {
                        item = `item_${++next}`;
                        send({
                            type: 'input_audio_buffer.speech_started',
                            item_id: item,
                            audio_start_ms: 0,
                        });
                    }
                    heard.push(words[spoken++ % words.length]);
                    send({
                        type: 'conversation.item.input_audio_transcription.delta',
                        item_id: item,
                        content_index: 0,
                        delta: heard.join(' '),
                        partial: true,
                    });
                    if (heard.length >= wordsPerTurn) {
                        commit();
                    }
                }
            } else if (event.type === 'input_audio_buffer.commit') {
                committed = true;
                if (options.errorOnCommit) {
                    send({
                        type: 'error',
                        error: {
                            type: 'invalid_request_error',
                            code: 'input_audio_buffer_commit_empty',
                            message: 'Nothing to commit.',
                        },
                    });
                }
                commit();
            } else if (event.type === 'transcription_session.update' || event.type === 'session.update') {
                if (options.ignoreUpdates) {
                    return;
                }
                if (committed && options.stuckAfterCommit) {
                    return;
                }
                send({ type: 'transcription_session.updated', session: event.session });
            }
        });
    };
    await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    return {
        url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
        handshakes,
        received,
        uploads,
        speeches,
        audioBytes: () => audio,
        appends: appendSizes,
        close: () =>
            new Promise<void>((resolve) => {
                for (const ws of sessions) {
                    ws.terminate();
                }
                http.close(() => resolve());
                http.closeAllConnections();
            }),
    };
}
