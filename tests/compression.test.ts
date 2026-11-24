import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import { COMPRESS_MIN_BYTES, compression } from '@socio/foundation/http/compression';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';

import { Runner } from './helpers/runners.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Responses are gzipped in the app, never streams, files, ranges, HEAD or sign-in.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const GZIP = { 'Accept-Encoding': 'gzip, deflate, br, zstd' };
const big = { items: Array.from({ length: 200 }, (_, i) => `item ${i}`) };
const gunzip = (response: Response) => new Response(response.body!.pipeThrough(new DecompressionStream('gzip'))).text();

/** A stream that sends `first`, then waits for `release()` to end. */
function gated(first: string, last: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(encoder.encode(first));
            await released;
            controller.enqueue(encoder.encode(last));
            controller.close();
        },
    });
    return { body, release };
}

/** Reads the first chunk, leaving the rest to the reader. */
async function firstChunk(response: Response) {
    const reader = response.body!.getReader();
    const first = await reader.read();
    return { reader, text: new TextDecoder().decode(first.value) };
}

/** Ends the event streams `/events` opened, oldest first. */
const streams: Array<() => void> = [];

function small() {
    const app = new Hono();
    app.use('*', compression());
    app.get('/big', (c) => {
        c.header('Cache-Control', 'no-store');
        c.header('Set-Cookie', 'a=1; Path=/', { append: true });
        c.header('Set-Cookie', 'b=2; Path=/', { append: true });
        return c.json(big);
    });
    app.get('/small', (c) => c.json({ ok: true }));
    app.get('/text', (c) => c.text('x'.repeat(4000)));
    app.get('/file', (c) => {
        c.header('Content-Disposition', 'attachment; filename="notes.txt"');
        return c.text('x'.repeat(4000));
    });
    app.get('/image', (c) => {
        c.header('Content-Type', 'image/png');
        return c.body(new Uint8Array(4000));
    });
    app.get('/api/auth/get-session', (c) => c.json(big));
    app.get('/events', () => {
        const { body, release } = gated(`data: ${'x'.repeat(2000)}\n\n`, 'data: end\n\n');
        streams.push(release);
        return new Response(body, {
            headers: { 'Content-Type': 'text/event-stream' },
        });
    });
    app.get('/page', () => {
        const { body, release } = gated(`<!DOCTYPE html><p>${'shell '.repeat(400)}</p>`, '<p>end</p>');
        release();
        return new Response(body, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    });
    return app;
}
it('gzips JSON and text from 1 kB when asked, keeping headers, with Vary: Accept-Encoding', async () => {
    const app = small();
    const response = await app.request('/big', { headers: GZIP });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(JSON.parse(await gunzip(response))).toEqual(big);
    const text = await app.request('/text', { headers: GZIP });
    expect(text.headers.get('content-encoding')).toBe('gzip');
    expect(await gunzip(text)).toBe('x'.repeat(4000));
    // A streamed page too, once it is past the threshold.
    const page = await app.request('/page', { headers: GZIP });
    expect(page.headers.get('content-encoding')).toBe('gzip');
    expect(await gunzip(page)).toMatch(/^<!DOCTYPE html>.*<p>end<\/p>$/);
});

it('sends the same answer plainly when gzip is not asked for, or the answer is small', async () => {
    const app = small();
    for (const headers of [
        {} as Record<string, string>,
        { 'Accept-Encoding': 'identity' },
        { 'Accept-Encoding': 'gzip;q=0, br' },
    ]) {
        const response = await app.request('/big', { headers });
        expect(response.headers.get('content-encoding')).toBeNull();
        // Caches still learn the answer depends on the header.
        expect(response.headers.get('vary')).toBe('Accept-Encoding');
        expect(await response.json()).toEqual(big);
    }
    const tiny = await app.request('/small', { headers: GZIP });
    expect(tiny.headers.get('content-encoding')).toBeNull();
    expect(tiny.headers.get('vary')).toBeNull();
    expect(tiny.headers.get('content-length')).toBe('11');
    expect(await tiny.json()).toEqual({ ok: true });
    expect(COMPRESS_MIN_BYTES).toBe(1024);
});

it('never compresses HEAD, ranges, stored files, media or sign-in', async () => {
    const app = small();
    const cases: Array<[string, RequestInit]> = [
        ['/big', { method: 'HEAD', headers: GZIP }],
        ['/big', { headers: { ...GZIP, Range: 'bytes=0-99' } }],
        ['/file', { headers: GZIP }],
        ['/image', { headers: GZIP }],
        ['/api/auth/get-session', { headers: GZIP }],
    ];
    for (const [path, init] of cases) {
        const response = await app.request(path, init);
        expect(response.headers.get('content-encoding'), path).toBeNull();
        expect(response.headers.get('vary'), path).toBeNull();
    }
});

it('passes an event stream through at once, uncompressed', async () => {
    const app = small();
    const response = await app.request('/events', { headers: GZIP });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const { reader, text } = await firstChunk(response);
    // The first event arrived while the stream is still open.
    expect(text).toMatch(/^data: x+\n\n$/);
    streams.shift()!();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe('data: end\n\n');
    expect((await reader.read()).done).toBe(true);
});

const USERS: User[] = [{ id: 'alice', name: 'Alice', role: 'member' }];
const SECRET = 'secret-0123456789abcdef-xyz';

it('streams a turn from the chat runtime as it happens, never compressed or held back', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const realFetch = globalThis.fetch.bind(globalThis);
    // The model answers the first words, then waits.
    const model = gated(
        `data: ${JSON.stringify({
            id: 'c',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'm',
            choices: [
                {
                    index: 0,
                    delta: { role: 'assistant', content: 'First words.' },
                    finish_reason: null,
                },
            ],
        })}\n\n`,
        `data: ${JSON.stringify({
            id: 'c',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://model.invalid/')) {
            return realFetch(input, init);
        }
        if (String(init?.body).includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        return new Response(model.body, {
            headers: { 'Content-Type': 'text/event-stream' },
        });
    });
    const dir = mkdtempSync(join(tmpdir(), 'cb-compress-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let scheduler!: Runner;
    const { workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            sessionSecret: SECRET,
            data: { userDataDir: dir },
        },
        beforeApp: ({ workspace }) => {
            for (const user of USERS) {
                workspace.recordUser(user);
            }
        },
        app: {
            // The scheduler is held here, to stop it.
            runner: (store) => (scheduler = new Runner(store, { mode: 'live', baseUrl: '' })),
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0]!;
    cleanup.push(() => {
        model.release();
        scheduler.stop();
    });
    workspace.bindThread('chat', dot.id, 'Chat', 'alice');
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    // The shell's JSON from the same app is compressed.
    const workspaceAnswer = await app.request('/api/workspace', {
        headers: { cookie, ...GZIP },
    });
    expect(workspaceAnswer.status).toBe(200);
    expect(workspaceAnswer.headers.get('content-encoding')).toBe('gzip');
    expect(JSON.parse(await gunzip(workspaceAnswer))).toHaveProperty('dots');

    const response = await app.request(`/api/copilotkit/agent/${dot.id}/run`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json', ...GZIP },
        body: JSON.stringify({
            threadId: 'chat',
            runId: 'run-1',
            messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
        }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('content-encoding')).toBeNull();
    // The words the model sent so far arrive while it is still answering.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('First words.')) {
        const read = await reader.read();
        expect(read.done).toBe(false);
        seen += decoder.decode(read.value, { stream: true });
    }
    expect(seen).not.toContain('RUN_FINISHED');
    model.release();
    for (;;) {
        const read = await reader.read();
        if (read.done) {
            break;
        }
        seen += decoder.decode(read.value, { stream: true });
    }
    expect(seen).toContain('RUN_FINISHED');
});
