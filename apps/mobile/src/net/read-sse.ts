import { createParser } from 'eventsource-parser';

import { ROOM_STREAM_CLOSED, ROOM_STREAM_CURSOR, type RoomStreamCloseReason } from '@socio/shared/rooms/rooms';

import { AbortedError, NetworkError } from './errors';

// Reading a server-sent event stream: a run's answer (`POST
// /api/copilotkit/agent/:dotId/run`) and a conversation's follow stream (`GET
// /api/conversations/:id/stream`), whose frames are `conversationStream`'s on
// the server:
// - an unnamed `data:` frame is one AG-UI event, as JSON;
// - `event: cursor` (with the run's sequence number in `id:` and `data`) once
//   each finished run is delivered, so `?after=` resumes after it;
// - `event: closed` with the reason the server ended the stream;
// - `: keep-alive` comments after 15 s of silence (`STREAM_KEEP_ALIVE_MS`).
// The body is read as it arrives, through `eventsource-parser`, never buffered
// whole. 20 s with no byte at all (a keep-alive comment counts) means the
// stream is dead behind a proxy that holds it open: that is a
// SilentStreamError, a NetworkError, so `serverAway` and the reconnect treat
// it as a dropped connection. A body that breaks off is a NetworkError, as
// `read-body.ts` maps whole bodies; once `signal` aborts, an AbortedError.
// A spike showed expo/fetch's reader hands chunks over live on both
// platforms and that its signal stops a read within milliseconds.

/** Silence after which a stream counts as dead: past the server's 15 s keep-alive. */
export const SSE_SILENCE_MS = 20_000;

/** One frame of a stream, read. */
export type SseFrame =
    /** An AG-UI event, parsed but not checked. */
    | { readonly kind: 'event'; readonly event: unknown }
    /** A finished run was delivered: resume after `seq`. */
    | { readonly kind: 'cursor'; readonly seq: number }
    /** The server ended the stream, and why (a reason this build may not know yet). */
    | { readonly kind: 'closed'; readonly reason: RoomStreamCloseReason | (string & {}) };

export interface ReadSseOptions {
    /** Stops the read: it rejects with AbortedError. */
    readonly signal?: AbortSignal;
    /** Silence before the stream counts as dead, `SSE_SILENCE_MS` by default. */
    readonly silenceMs?: number;
}

/** No byte came for `silenceMs`: the stream is taken as dropped. */
export class SilentStreamError extends NetworkError {
    override name = 'SilentStreamError';

    constructor(
        url: string,
        readonly silenceMs: number,
    ) {
        super(url);
        this.message = `No word from ${url || 'the server'} for ${Math.round(silenceMs / 1000)} s.`;
    }
}

/**
 * Reads `response`'s body as server-sent events, handing each frame to
 * `onFrame` as it arrives. Resolves when the server ends the body. Rejects
 * with SilentStreamError, NetworkError (the body broke off), AbortedError
 * (`signal`), the SyntaxError of a `data:` frame that isn't JSON or a named
 * frame that isn't what the server sends, or what `onFrame` throws; the read
 * stops each time. Named frames it doesn't know are skipped. It doesn't check
 * the status or the content type: the caller does, before reading.
 */
export async function readSse(
    response: Response,
    onFrame: (frame: SseFrame) => void,
    options: ReadSseOptions = {},
): Promise<void> {
    const { signal, silenceMs = SSE_SILENCE_MS } = options;
    const url = response.url;
    if (signal?.aborted) {
        throw new AbortedError(url, signal.reason);
    }
    const body = response.body;
    if (body === null) {
        return;
    }
    const reader = body.getReader();
    let stopped: Error | null = null;
    const stop = (error: Error) => {
        if (stopped === null) {
            stopped = error;
            reader.cancel(error).catch(() => {
                // The stream is gone either way.
            });
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new SilentStreamError(url, silenceMs)), silenceMs);
    };
    const onAbort = () => stop(new AbortedError(url, signal?.reason));
    signal?.addEventListener('abort', onAbort, { once: true });

    const parser = createParser({
        onEvent: (message) => {
            if (stopped !== null) {
                return;
            }
            try {
                const frame = readFrame(message.event, message.data);
                if (frame !== null) {
                    onFrame(frame);
                }
            } catch (error) {
                stop(error instanceof Error ? error : new Error(String(error)));
            }
        },
    });
    const decoder = new TextDecoder();
    arm();
    try {
        for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (error) {
                if (stopped !== null) {
                    break;
                }
                if (signal?.aborted) {
                    throw new AbortedError(url, signal.reason);
                }
                throw new NetworkError(url, error);
            }
            if (stopped !== null) {
                break;
            }
            if (chunk.done) {
                parser.feed(decoder.decode());
                break;
            }
            arm();
            parser.feed(decoder.decode(chunk.value, { stream: true }));
            if (stopped !== null) {
                break;
            }
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
    if (stopped !== null) {
        throw stopped;
    }
}

/** A frame as the app sees it, or null for a named frame it doesn't know. */
function readFrame(event: string | undefined, data: string): SseFrame | null {
    if (event === undefined || event === 'message') {
        return { kind: 'event', event: JSON.parse(data) as unknown };
    }
    if (event === ROOM_STREAM_CURSOR) {
        const seq = (JSON.parse(data) as { seq?: unknown } | null)?.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
            throw new SyntaxError(`A cursor frame without a sequence number: ${data.slice(0, 100)}`);
        }
        return { kind: 'cursor', seq };
    }
    if (event === ROOM_STREAM_CLOSED) {
        const reason = (JSON.parse(data) as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string') {
            throw new SyntaxError(`A closed frame without a reason: ${data.slice(0, 100)}`);
        }
        return { kind: 'closed', reason };
    }
    return null;
}
