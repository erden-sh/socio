import { afterEach, describe, expect, it, vi } from 'vitest';

import { AbortedError, NetworkError } from '../../src/net/errors';
import { readSse, SilentStreamError, SSE_SILENCE_MS, type SseFrame } from '../../src/net/read-sse';
import { serverAway } from '../../src/net/reconnect';

import { settle, streamedAnswer } from './helpers';

// readSse against streamed answers shaped as the server's conversationStream
// writes them (src/server/workspace/conversation-stream.ts): AG-UI `data:`
// frames, `cursor` frames with an id, `closed`, and keep-alive comments.

const started = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };
const delta = (text: string) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: text });
const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

function read(stream: ReturnType<typeof streamedAnswer>, options?: Parameters<typeof readSse>[2]) {
    const frames: SseFrame[] = [];
    const done = readSse(stream.response, (frame) => frames.push(frame), options).then(
        () => 'ended' as const,
        (error: unknown) => error,
    );
    return { frames, done };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('readSse', () => {
    it('hands each frame over as it arrives, before the body ends', async () => {
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        stream.push(data(started));
        await settle();
        expect(frames).toEqual([{ kind: 'event', event: started }]);
        stream.push(data(delta('Hel')));
        await settle();
        expect(frames).toHaveLength(2);
        stream.end();
        expect(await done).toBe('ended');
    });

    it('joins a frame split anywhere across chunks, a multi-byte character included', async () => {
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        const text = data(delta('café ☕')) + data(delta('second'));
        const bytes = new TextEncoder().encode(text);
        for (let at = 0; at < bytes.length; at += 3) {
            stream.push(bytes.slice(at, at + 3));
        }
        stream.end();
        expect(await done).toBe('ended');
        expect(frames).toEqual([
            { kind: 'event', event: delta('café ☕') },
            { kind: 'event', event: delta('second') },
        ]);
    });

    it('reads CRLF line endings and multi-line data', async () => {
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        stream.push(`data: {"type":"RUN_STARTED",\r\ndata: "runId":"r1"}\r\n\r\n`);
        stream.push(`event: cursor\r\nid: 7\r\ndata: {"seq":7}\r\n\r\n`);
        stream.end();
        expect(await done).toBe('ended');
        expect(frames).toEqual([
            { kind: 'event', event: { type: 'RUN_STARTED', runId: 'r1' } },
            { kind: 'cursor', seq: 7 },
        ]);
    });

    it('reads cursor frames with their id and closed frames with their reason, and skips names it doesn’t know', async () => {
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        stream.push(data(started));
        stream.push('event: cursor\nid: 12\ndata: {"seq":12}\n\n');
        stream.push('event: later\ndata: {"anything":true}\n\n');
        stream.push(': keep-alive\n\n');
        stream.push('event: closed\ndata: {"reason":"access"}\n\n');
        stream.end();
        expect(await done).toBe('ended');
        expect(frames).toEqual([
            { kind: 'event', event: started },
            { kind: 'cursor', seq: 12 },
            { kind: 'closed', reason: 'access' },
        ]);
    });

    it('stops with a SyntaxError on a data frame that isn’t JSON, or a cursor without a sequence number', async () => {
        for (const bad of ['data: <html>\n\n', 'event: cursor\nid: 3\ndata: {}\n\n', 'event: closed\ndata: {}\n\n']) {
            const stream = streamedAnswer();
            const { frames, done } = read(stream);
            stream.push(bad);
            stream.push(data(started));
            const error = await done;
            expect(error).toBeInstanceOf(SyntaxError);
            expect(frames).toEqual([]);
            expect(stream.cancelled).not.toBeNull();
        }
    });

    it('takes a body that breaks off as a NetworkError, which counts as the server being away', async () => {
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        stream.push(data(started));
        stream.push('data: {"type":"TEXT_MES');
        await settle();
        stream.fail();
        const error = await done;
        expect(error).toBeInstanceOf(NetworkError);
        expect(serverAway(error)).toBe(true);
        expect(frames).toEqual([{ kind: 'event', event: started }]);
    });

    it('stops mid-frame when its signal aborts, with an AbortedError and nothing more handed over', async () => {
        const stream = streamedAnswer();
        const stop = new AbortController();
        const { frames, done } = read(stream, { signal: stop.signal });
        stream.push(data(started));
        stream.push('data: {"type":"TEXT_MESSAGE_CONTENT",');
        await settle();
        stop.abort();
        stream.push('"delta":"x"}\n\n');
        const error = await done;
        expect(error).toBeInstanceOf(AbortedError);
        expect(serverAway(error)).toBe(false);
        expect(frames).toEqual([{ kind: 'event', event: started }]);
        expect(stream.cancelled).not.toBeNull();
    });

    it('doesn’t start reading once its signal has aborted', async () => {
        const stream = streamedAnswer();
        const stop = new AbortController();
        stop.abort();
        expect(await read(stream, { signal: stop.signal }).done).toBeInstanceOf(AbortedError);
    });

    it('gives up after 20 s with no byte, and keep-alive comments hold it open', async () => {
        vi.useFakeTimers();
        const stream = streamedAnswer();
        const { frames, done } = read(stream);
        expect(SSE_SILENCE_MS).toBe(20_000);
        for (let beat = 0; beat < 4; beat++) {
            await vi.advanceTimersByTimeAsync(15_000);
            stream.push(': keep-alive\n\n');
            await vi.advanceTimersByTimeAsync(0);
        }
        stream.push(data(started));
        await vi.advanceTimersByTimeAsync(19_999);
        expect(stream.cancelled).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        const error = await done;
        expect(error).toBeInstanceOf(SilentStreamError);
        expect(error).toBeInstanceOf(NetworkError);
        expect(serverAway(error)).toBe(true);
        expect(frames).toEqual([{ kind: 'event', event: started }]);
        expect(stream.cancelled).toBeInstanceOf(SilentStreamError);
    });

    it('stops when onFrame throws, with its error', async () => {
        const stream = streamedAnswer();
        const oops = new Error('the store is closed');
        const done = readSse(stream.response, () => {
            throw oops;
        }).catch((error: unknown) => error);
        stream.push(data(started));
        expect(await done).toBe(oops);
    });

    it('ends at once for an answer with no body', async () => {
        await expect(readSse(new Response(null, { status: 204 }), () => undefined)).resolves.toBeUndefined();
    });
});
