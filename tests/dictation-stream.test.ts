import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import tls from 'node:tls';

import { createAdaptorServer } from '@hono/node-server';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import type { DictationStreamEvent } from '@socio/shared/voice/dictation';
import { realtimeUrl } from '@socio/shared/voice/transcription';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { SESSION_COOKIE, createSessionValue } from '../src/server/auth/session.js';
import { DictationStreams, STREAM_LIMITS, dictationUpgrade } from '../src/server/voice/dictation-stream.js';
import { transcriptionFromEnv } from '../src/server/voice/transcription.js';

import { startFakeRealtime, type FakeRealtimeOptions } from './fixtures/fake-realtime.js';
import { LOOPBACK_TLS } from './fixtures/loopback-tls.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-222: live text while dictating. The composer's socket reaches this
// server through the app's checks; the relay talks to a loopback fake of
// socio-voice's realtime socket (fixtures/fake-realtime.ts). Nothing
// leaves this machine (tests/setup/egress-guard.ts).

const KEY = 'socio-voice-0123456789abcdef';
const SECRET = 'stream-secret-0123456789abcdef';
const limits = { ...STREAM_LIMITS };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    Object.assign(STREAM_LIMITS, limits);
    vi.restoreAllMocks();
});

async function fixture({
    fake: fakeOptions = { token: KEY },
    env,
}: {
    fake?: FakeRealtimeOptions;
    env?: (fakeUrl: string) => Record<string, string>;
} = {}) {
    const fake = await startFakeRealtime(fakeOptions);
    cleanup.push(fake.close);
    const { store, platform, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            voiceModel: 'voice-model',
            voiceName: 'marin',
            transcription: transcriptionFromEnv(
                env?.(fake.url) ?? {
                    VOICE_TRANSCRIBE_URL: fake.url,
                    VOICE_TRANSCRIBE_MODEL: 'parakeet-tdt-0.6b-v3',
                    VOICE_TRANSCRIBE_API_KEY: KEY,
                },
            ),
            runtimeUrl: '',
            sessionSecret: 'session-secret-0123456789abcdef',
        },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const server = createAdaptorServer({
        fetch: app.fetch,
        hostname: '127.0.0.1',
    }) as Server;
    server.on('upgrade', (request, socket, head) => {
        if (!dictationUpgrade((r, e) => app.fetch(r, e))(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const cookieOf = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return login.headers.get('set-cookie')!.split(';')[0];
    };
    const api = async (userId: string, path: string, method = 'GET', body?: unknown) =>
        app.request(path, {
            method,
            headers: {
                cookie: await cookieOf(userId),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { fake, origin, app, store, platform, cookieOf, api };
}

/** The composer's socket, as a browser opens it, and everything it gets. */
async function open(
    origin: string,
    headers: Record<string, string> = {},
): Promise<{
    socket: WebSocket;
    events: DictationStreamEvent[];
    frames: string[];
    handshake: string;
    closed: Promise<void>;
}> {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/voice/realtime`, {
        headers: { origin, ...headers },
    });
    cleanup.push(() => socket.terminate());
    const events: DictationStreamEvent[] = [];
    const frames: string[] = [];
    let handshake = '';
    socket.on('upgrade', (response) => {
        handshake = JSON.stringify(response.headers);
    });
    socket.on('message', (data) => {
        frames.push(String(data));
        events.push(JSON.parse(String(data)) as DictationStreamEvent);
    });
    const closed = new Promise<void>((resolve) => socket.on('close', resolve));
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return { socket, events, frames, handshake, closed };
}

/** The status a refused handshake gets. */
async function refused(origin: string, headers: Record<string, string> = {}) {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/voice/realtime`, {
        headers: { origin, ...headers },
    });
    cleanup.push(() => socket.terminate());
    return new Promise<number>((resolve, reject) => {
        socket.on('unexpected-response', (request, response) => {
            resolve(response.statusCode ?? 0);
            request.destroy();
        });
        socket.on('open', () => reject(new Error('The socket opened.')));
        socket.on('error', () => {});
    });
}

const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('Timed out waiting.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};
const word = () => Buffer.alloc(3200, 1);
const texts = (events: DictationStreamEvent[], type: 'partial' | 'final') =>
    events.flatMap((event) => (event.type === type ? [(event as { text: string }).text] : []));

it('derives the realtime socket from the transcription URL, wss or loopback only', () => {
    expect(realtimeUrl('https://voice.example.test')).toBe('wss://voice.example.test/v1/realtime');
    expect(realtimeUrl('http://127.0.0.1:8000/stt')).toBe('ws://127.0.0.1:8000/stt/v1/realtime');
    const socket = (env: Record<string, string>, streaming?: 'off' | 'on') =>
        transcriptionProvider(
            { transcription: transcriptionFromEnv(env), voiceKey: 'sk-test' },
            streaming ? { transcriptionStreaming: streaming } : {},
        ).realtimeUrl;
    expect(socket({ VOICE_TRANSCRIBE_URL: 'https://stt.lab' })).toBe('wss://stt.lab/v1/realtime');
    expect(
        socket({
            VOICE_TRANSCRIBE_URL: 'http://localhost:9000',
            VOICE_TRANSCRIBE_API_KEY: KEY,
        }),
    ).toBe('ws://localhost:9000/v1/realtime');
    // Plain ws to another machine: never, with a key or without one.
    expect(socket({ VOICE_TRANSCRIBE_URL: 'http://10.20.0.5:8000' })).toBe(undefined);
    // OpenAI's batch API, and an admin's off, record and then send.
    expect(socket({})).toBe(undefined);
    expect(socket({ VOICE_TRANSCRIBE_URL: 'https://stt.lab' }, 'off')).toBe(undefined);
    expect(
        socket({
            VOICE_TRANSCRIBE_URL: 'https://stt.lab',
            VOICE_TRANSCRIBE_STREAMING: 'off',
        }),
    ).toBe(undefined);
    expect(
        socket(
            {
                VOICE_TRANSCRIBE_URL: 'https://stt.lab',
                VOICE_TRANSCRIBE_STREAMING: 'off',
            },
            'on',
        ),
    ).toBe('wss://stt.lab/v1/realtime');
});

it('streams partial text, then the final text replaces it', async () => {
    const { fake, origin, cookieOf } = await fixture();
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    for (let i = 0; i < 4; i++) {
        socket.send(word());
    }
    await until(() => texts(events, 'partial').length === 4);
    // The whole text so far each time: the server's turn ends after three
    // words, and the fourth opens the next.
    expect(texts(events, 'partial')).toEqual(['hello', 'hello from', 'hello from the', 'hello from the fake']);
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(texts(events, 'final')).toEqual(['hello from the fake']);
    // 16 kHz pcm16 asked for, the audio passed on as it came.
    expect(fake.received[0]).toMatchObject({
        type: 'transcription_session.update',
        session: {
            input_audio_format: 'pcm16',
            input_audio_sample_rate: 16000,
            input_audio_transcription: { model: 'parakeet-tdt-0.6b-v3' },
        },
    });
    expect(fake.audioBytes()).toBe(4 * 3200);
    expect(fake.received.map((event) => event.type)).toContain('input_audio_buffer.commit');
});

it('sends the key only to the realtime URL it is bound to, never to the browser', async () => {
    const { fake, origin, cookieOf, api } = await fixture();
    const { socket, events, frames, handshake, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    await until(() => texts(events, 'partial').length === 1);
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(fake.handshakes).toHaveLength(1);
    expect(fake.handshakes[0].path).toBe('/v1/realtime');
    expect(fake.handshakes[0].headers.authorization).toBe(`Bearer ${KEY}`);
    // Only in the header: no subprotocol, no query, no cookie of the person's.
    expect(fake.handshakes[0].headers['sec-websocket-protocol']).toBeUndefined();
    expect(fake.handshakes[0].headers.cookie).toBeUndefined();
    // The browser gets the text and nothing of the server's.
    expect(frames.join('\n')).not.toContain(KEY);
    expect(handshake).not.toContain(KEY);
    for (const frame of frames) {
        expect(Object.keys(JSON.parse(frame)).sort()).toEqual(
            JSON.parse(frame).type === 'ready' ? ['type'] : ['text', 'type'],
        );
    }
    const state = await (await api('bob', '/api/state')).text();
    expect(state).not.toContain(KEY);

    // An admin's server at another origin gets no key: the env key is for
    // its own URL (CB-204), so the keyed fake turns the socket down.
    const other = await startFakeRealtime({ token: KEY });
    cleanup.push(other.close);
    await api('alice', '/api/settings', 'PATCH', {
        transcription: { url: other.url, model: 'whisper-1' },
    });
    const second = await open(origin, { cookie: await cookieOf('bob') });
    await second.closed;
    expect(second.events).toEqual([{ type: 'unavailable' }]);
    expect(other.handshakes).toHaveLength(1);
    expect(other.handshakes[0].headers.authorization).toBeUndefined();
});

it('uses an admin’s key for the exact URL it was set for', async () => {
    const keyed = await startFakeRealtime({ token: 'admin-key-0123456789' });
    cleanup.push(keyed.close);
    const { origin, cookieOf, api } = await fixture({
        env: () => ({}),
    });
    await api('alice', '/api/settings', 'PATCH', {
        transcription: { url: keyed.url, model: 'whisper-1' },
    });
    const saved = await api('alice', '/api/settings', 'PATCH', {
        transcriptionKey: { key: 'admin-key-0123456789', url: keyed.url },
    });
    expect(saved.status).toBe(200);
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(texts(events, 'final')).toEqual(['hello']);
    expect(keyed.handshakes[0].headers.authorization).toBe('Bearer admin-key-0123456789');
});

it('never follows a redirect, and doesn’t take one for a missing socket', async () => {
    const elsewhere = await startFakeRealtime({ token: KEY });
    cleanup.push(elsewhere.close);
    const { fake, origin, cookieOf } = await fixture({
        fake: {
            token: KEY,
            refuse: { status: 302, location: `${elsewhere.url}/v1/realtime` },
        },
    });
    const cookie = await cookieOf('bob');
    const first = await open(origin, { cookie });
    await first.closed;
    expect(first.events).toEqual([{ type: 'unavailable' }]);
    expect(fake.handshakes).toHaveLength(1);
    // The key never went where the redirect pointed.
    expect(elsewhere.handshakes).toHaveLength(0);
    // Tried again next time: a redirect isn't "no socket here".
    const again = await open(origin, { cookie });
    await again.closed;
    expect(fake.handshakes).toHaveLength(2);
    expect(elsewhere.handshakes).toHaveLength(0);
});

it('remembers only a missing socket, says so in setup, and forgets on a settings change', async () => {
    const options: FakeRealtimeOptions = { token: KEY };
    const { fake, origin, cookieOf, api } = await fixture({ fake: options });
    const cookie = await cookieOf('bob');
    const streaming = async () =>
        (
            (await (await api('bob', '/api/workspace')).json()) as {
                setup: { transcriptionStreaming: boolean };
            }
        ).setup.transcriptionStreaming;
    const attempt = async () => {
        const session = await open(origin, { cookie });
        await session.closed;
        return session.events;
    };
    // A refused key (401, or socio-voice's 1008 as 403, before or after
    // accepting) and a server that is down are tried again every time.
    for (const status of [401, 403, 502, 503]) {
        options.refuse = { status };
        expect(await attempt()).toEqual([{ type: 'unavailable' }]);
        expect(await streaming()).toBe(true);
    }
    options.refuse = undefined;
    options.closeAfterOpen = 1008;
    expect((await attempt()).at(-1)).toEqual({ type: 'unavailable' });
    expect(await streaming()).toBe(true);
    options.closeAfterOpen = undefined;
    const tried = fake.handshakes.length;
    // No socket there (404, 405, 426): record, then send, for a while.
    for (const status of [404, 405, 426]) {
        options.refuse = { status };
        expect(await attempt()).toEqual([{ type: 'unavailable' }]);
        expect(await streaming()).toBe(false);
        expect(await refused(origin, { cookie })).toBe(409);
        // An admin's change to the transcription settings forgets it.
        await api('alice', '/api/settings', 'PATCH', {
            transcriptionStreaming: 'auto',
        });
        expect(await streaming()).toBe(true);
    }
    expect(fake.handshakes.length).toBe(tried + 3);
    // `on` never remembers.
    await api('alice', '/api/settings', 'PATCH', {
        transcriptionStreaming: 'on',
    });
    await attempt();
    await attempt();
    expect(fake.handshakes.length).toBe(tried + 5);
});

it('refuses the socket when live text is off or the server is plain http elsewhere', async () => {
    const { origin, cookieOf, api } = await fixture();
    const cookie = await cookieOf('bob');
    await api('alice', '/api/settings', 'PATCH', {
        transcriptionStreaming: 'off',
    });
    const setup = async () =>
        (
            (await (await api('bob', '/api/workspace')).json()) as {
                setup: { transcription: boolean; transcriptionStreaming: boolean };
            }
        ).setup;
    expect(await setup()).toMatchObject({
        transcription: true,
        transcriptionStreaming: false,
    });
    expect(await refused(origin, { cookie })).toBe(409);
    await api('alice', '/api/settings', 'PATCH', {
        transcriptionStreaming: null,
    });
    expect((await setup()).transcriptionStreaming).toBe(true);
    // A keyless lab server over plain http on another machine: recordings
    // still go there, but no socket does (the egress guard would fail this).
    await api('alice', '/api/settings', 'PATCH', {
        transcription: { url: 'http://10.20.0.5:8000', model: 'whisper-1' },
    });
    expect(await setup()).toMatchObject({
        transcription: true,
        transcriptionStreaming: false,
    });
    expect(await refused(origin, { cookie })).toBe(409);
});

it('says live text is unavailable when the server drops the socket mid-way', async () => {
    const { origin, cookieOf } = await fixture({
        fake: { token: KEY, dropAfterAppends: 2 },
    });
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    socket.send(word());
    await closed;
    expect(events.at(-1)).toEqual({ type: 'unavailable' });
    expect(texts(events, 'final')).toEqual([]);
});

it('gives up on a final text that never comes', async () => {
    STREAM_LIMITS.finalMs = 100;
    const { origin, cookieOf } = await fixture({
        fake: { token: KEY, stuckAfterCommit: true },
    });
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(events.at(-1)).toEqual({ type: 'unavailable' });
});

it('ends a session at its length and audio limits', async () => {
    STREAM_LIMITS.maxMs = 300;
    const { fake, origin, cookieOf } = await fixture();
    const cookie = await cookieOf('bob');
    const timed = await open(origin, { cookie });
    await until(() => timed.events.some((event) => event.type === 'ready'));
    timed.socket.send(word());
    // No Done: the limit ends it as if pressed, with the text so far.
    await timed.closed;
    expect(texts(timed.events, 'final')).toEqual(['hello']);

    Object.assign(STREAM_LIMITS, limits, { maxBytes: 3 * 3200 });
    const long = await open(origin, { cookie });
    await until(() => long.events.some((event) => event.type === 'ready'));
    for (let i = 0; i < 5; i++) {
        long.socket.send(word());
    }
    await long.closed;
    // Audio past the limit is not passed on.
    expect(fake.audioBytes()).toBe(3200 + 3 * 3200);
    expect(texts(long.events, 'final')).toEqual(['from the fake']);
});

it('keeps one session per person, and a cap on everyone’s', async () => {
    STREAM_LIMITS.total = 1;
    const { origin, cookieOf } = await fixture();
    const bob = await cookieOf('bob');
    const first = await open(origin, { cookie: bob });
    await until(() => first.events.some((event) => event.type === 'ready'));
    // Bob again (another tab): the older session ends.
    const second = await open(origin, { cookie: bob });
    await first.closed;
    await until(() => second.events.some((event) => event.type === 'ready'));
    // Someone else waits for a free one.
    expect(await refused(origin, { cookie: await cookieOf('alice') })).toBe(429);
    second.socket.close();
    await second.closed;
});

it('opens only for a signed-in member of this workspace, from its own pages', async () => {
    const { fake, origin, cookieOf } = await fixture();
    // Signed out.
    expect(await refused(origin)).toBe(401);
    // Signed in elsewhere: a session for someone who isn't a member here.
    const stranger = `${SESSION_COOKIE}=${encodeURIComponent(createSessionValue(SECRET, 'mallory'))}`;
    expect(await refused(origin, { cookie: stranger })).toBe(401);
    // A member's cookie, from another site's page.
    const cookie = await cookieOf('bob');
    expect(await refused(origin, { cookie, origin: 'https://evil.example' })).toBe(403);
    expect(await refused(origin, { cookie, 'sec-fetch-site': 'same-site' })).toBe(403);
    // None of them reached the transcription server.
    expect(fake.handshakes).toHaveLength(0);
    // Not a WebSocket: nothing to upgrade.
    const plain = await fetch(`${origin}/api/voice/realtime`, {
        headers: { cookie },
    });
    expect(plain.status).toBe(426);
});

it('passes small frames on in appends of at least 100 ms, the rest with Done', async () => {
    const { fake, origin, cookieOf } = await fixture();
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    // 13 frames of 10 ms each, then one shorter last one.
    for (let i = 0; i < 13; i++) {
        socket.send(Buffer.alloc(320, 1));
    }
    socket.send(Buffer.alloc(100, 1));
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(fake.audioBytes()).toBe(13 * 320 + 100);
    // One append of 3,200 bytes at least, then the rest with Done.
    expect(fake.appends).toEqual([3200, 1060]);
    expect(fake.received.map((event) => event.type).slice(-2)).toEqual([
        'input_audio_buffer.commit',
        'transcription_session.update',
    ]);
    expect(texts(events, 'final')).toEqual(['hello']);
});

it('ends a flood of tiny frames as if Done were pressed', async () => {
    const { fake, origin, cookieOf } = await fixture();
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    for (let i = 0; i < 2000; i++) {
        socket.send(Buffer.alloc(2, 1));
    }
    await closed;
    // The first tiny frame went with the rest; the second ended it.
    expect(fake.audioBytes()).toBe(3202);
    expect(texts(events, 'final')).toEqual(['hello']);
});

it('holds audio in one buffer while the server is slow to answer', async () => {
    const { fake, origin, cookieOf } = await fixture({
        fake: { token: KEY, delayUpgradeMs: 300 },
    });
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    // Six seconds of audio in 10 ms frames, all before the server answers.
    for (let i = 0; i < 600; i++) {
        socket.send(Buffer.alloc(320, 1));
    }
    await until(() => events.some((event) => event.type === 'ready'));
    expect(fake.handshakes).toHaveLength(1);
    // Passed on at once, in appends of at most 2 s.
    await until(() => fake.audioBytes() === 600 * 320);
    expect(fake.appends).toEqual([65536, 65536, 60928]);
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(texts(events, 'final').length).toBe(1);
});

it('takes no new session while the server drains, and a stop ends those open', async () => {
    const { origin, cookieOf, platform } = await fixture();
    const cookie = await cookieOf('bob');
    const session = await open(origin, { cookie });
    await until(() => session.events.some((event) => event.type === 'ready'));
    platform.drain();
    expect(await refused(origin, { cookie })).toBe(409);
    await platform.stop();
    await session.closed;
    expect(session.events.at(-1)).toEqual({ type: 'unavailable' });
});

it('ends a session whose server falls behind', async () => {
    STREAM_LIMITS.maxBufferedBytes = 64 * 1024;
    STREAM_LIMITS.maxBytes = 64 * 1024 * 1024;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { origin, cookieOf } = await fixture({
        fake: { token: KEY, stopReading: true },
    });
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    const frame = Buffer.alloc(60 * 1024, 1);
    let gone = false;
    void closed.then(() => (gone = true));
    for (let sent = 0; !gone && sent < 48 * 1024 * 1024; sent += frame.length) {
        socket.send(frame);
        if (sent % (1024 * 1024) === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    }
    await closed;
    expect(events.at(-1)).toEqual({ type: 'unavailable' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Voice: live text at 127\.0\.0\.1:\d+ fell behind\.$/));
});

it('limits how often one person starts live text', async () => {
    STREAM_LIMITS.startsPerMinute = 2;
    const { origin, cookieOf } = await fixture();
    const bob = await cookieOf('bob');
    for (let i = 0; i < 2; i++) {
        const session = await open(origin, { cookie: bob });
        session.socket.close();
        await session.closed;
    }
    expect(await refused(origin, { cookie: bob })).toBe(429);
    // Someone else's are their own.
    const alice = await open(origin, { cookie: await cookieOf('alice') });
    alice.socket.close();
    await alice.closed;
});

it('refuses while paused, and a pause ends the sessions open', async () => {
    const { origin, cookieOf, api } = await fixture();
    const cookie = await cookieOf('bob');
    const session = await open(origin, { cookie });
    await until(() => session.events.some((event) => event.type === 'ready'));
    await api('alice', '/api/settings', 'PATCH', { paused: true });
    await session.closed;
    expect(session.events.at(-1)).toEqual({ type: 'unavailable' });
    expect(await refused(origin, { cookie })).toBe(503);
});

it('refuses a service key', async () => {
    const { origin, api } = await fixture();
    const made = (await (
        await api('alice', '/api/service-accounts', 'POST', {
            name: 'Agent',
            role: 'member',
        })
    ).json()) as { id: string };
    const key = (await (
        await api('alice', `/api/service-accounts/${made.id}/keys`, 'POST', {
            name: 'k',
            scopes: ['issues:read'],
            days: 90,
        })
    ).json()) as { token: string };
    expect(key.token).toMatch(/^cbk_/);
    expect(await refused(origin, { authorization: `Bearer ${key.token}` })).toBe(403);
});

it('ends a session on an oversize frame, and finishes on a half sample', async () => {
    const { origin, cookieOf } = await fixture();
    const cookie = await cookieOf('bob');
    const big = await open(origin, { cookie });
    await until(() => big.events.some((event) => event.type === 'ready'));
    const code = new Promise<number>((resolve) => big.socket.on('close', (value) => resolve(value)));
    big.socket.send(Buffer.alloc(STREAM_LIMITS.maxFrameBytes + 2));
    expect(await code).toBe(1009);

    const odd = await open(origin, { cookie });
    await until(() => odd.events.some((event) => event.type === 'ready'));
    odd.socket.send(word());
    odd.socket.send(Buffer.alloc(3));
    await odd.closed;
    expect(texts(odd.events, 'final')).toEqual(['hello']);
});

it('says live text is unavailable when the server can’t be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closedPort = await new Promise<number>((resolve) => {
        const probe = createNetServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolve(port));
        });
    });
    const { origin, cookieOf } = await fixture({
        env: () => ({ VOICE_TRANSCRIBE_URL: `http://127.0.0.1:${closedPort}` }),
    });
    const cookie = await cookieOf('bob');
    const session = await open(origin, { cookie });
    await session.closed;
    expect(session.events).toEqual([{ type: 'unavailable' }]);
    expect(warn).toHaveBeenCalledWith(`Voice: live text at 127.0.0.1:${closedPort} failed (Error).`);
    // Not remembered: the next one tries again.
    const again = await open(origin, { cookie });
    await again.closed;
    expect(again.events).toEqual([{ type: 'unavailable' }]);
});

it('streams over wss with the key to a TLS server', async () => {
    const defaults = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...defaults, LOOPBACK_TLS.cert]);
    cleanup.push(() => tls.setDefaultCACertificates(defaults));
    const { fake, origin, cookieOf } = await fixture({
        fake: { token: KEY, tls: LOOPBACK_TLS },
    });
    expect(fake.url).toMatch(/^https:/);
    const { socket, events, closed } = await open(origin, {
        cookie: await cookieOf('bob'),
    });
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(word());
    socket.send(JSON.stringify({ type: 'done' }));
    await closed;
    expect(texts(events, 'final')).toEqual(['hello']);
    expect(fake.handshakes[0].headers.authorization).toBe(`Bearer ${KEY}`);
});

it('ignores a late delta, passes on an empty final, and goes on after an error event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options: FakeRealtimeOptions = {
        token: KEY,
        staleDelta: true,
        errorOnCommit: true,
    };
    const { origin, cookieOf } = await fixture({ fake: options });
    const cookie = await cookieOf('bob');
    const first = await open(origin, { cookie });
    await until(() => first.events.some((event) => event.type === 'ready'));
    for (let i = 0; i < 4; i++) {
        first.socket.send(word());
    }
    await until(() => texts(first.events, 'partial').length === 4);
    first.socket.send(JSON.stringify({ type: 'done' }));
    await first.closed;
    // The late "stale words" never showed.
    expect(texts(first.events, 'partial').join(' ')).not.toContain('stale');
    expect(texts(first.events, 'final')).toEqual(['hello from the fake']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sent an error \(input_audio_buffer_commit_empty\)\.$/));

    // An empty final text goes as it is: the composer sends the recording.
    options.emptyFinals = true;
    const second = await open(origin, { cookie });
    await until(() => second.events.some((event) => event.type === 'ready'));
    second.socket.send(word());
    second.socket.send(JSON.stringify({ type: 'done' }));
    await second.closed;
    expect(texts(second.events, 'final')).toEqual(['']);
});

it('records, then sends, for a server that doesn’t answer the session update (auto)', async () => {
    STREAM_LIMITS.answerMs = 100;
    const options: FakeRealtimeOptions = { token: KEY, ignoreUpdates: true };
    const { fake, origin, cookieOf, api } = await fixture({ fake: options });
    const cookie = await cookieOf('bob');
    // It said `...created`: it speaks the protocol, only slowly. Not remembered.
    const slow = await open(origin, { cookie });
    await slow.closed;
    expect(slow.events.at(-1)).toEqual({ type: 'unavailable' });
    // Silent from the start: another dialect, remembered.
    options.quietOnOpen = true;
    const session = await open(origin, { cookie });
    await session.closed;
    expect(session.events.at(-1)).toEqual({ type: 'unavailable' });
    expect(await refused(origin, { cookie })).toBe(409);
    expect(fake.handshakes).toHaveLength(2);
    // `on` waits for it instead (up to the final text's limit).
    await api('alice', '/api/settings', 'PATCH', {
        transcriptionStreaming: 'on',
    });
    const on = await open(origin, { cookie });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(on.socket.readyState).toBe(WebSocket.OPEN);
    on.socket.close();
    await on.closed;
});

it('answers 400 to a handshake without a Host', async () => {
    const { origin } = await fixture();
    const { port } = new URL(origin);
    const reply = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), '127.0.0.1', () =>
            socket.write(
                'GET /api/voice/realtime HTTP/1.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
            ),
        );
        let data = '';
        socket.on('data', (chunk) => (data += String(chunk)));
        socket.on('close', () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
});

it('checks the total again when a session starts, after concurrent handshakes', async () => {
    STREAM_LIMITS.total = 1;
    const { fake } = await fixture();
    const streams = new DictationStreams(() => {});
    const provider = transcriptionProvider({
        transcription: transcriptionFromEnv({
            VOICE_TRANSCRIBE_URL: fake.url,
            VOICE_TRANSCRIBE_API_KEY: KEY,
        }),
    });
    // Both admitted before either started.
    expect(streams.admit(provider, 'alice')).toBeUndefined();
    expect(streams.admit(provider, 'bob')).toBeUndefined();
    const browser = () => {
        const socket = Object.assign(new EventEmitter(), {
            readyState: WebSocket.OPEN as number,
            sent: [] as string[],
            send(data: string) {
                socket.sent.push(data);
            },
            close(code?: number) {
                socket.readyState = WebSocket.CLOSED;
                socket.emit('close', code);
            },
            terminate() {
                socket.close();
            },
        });
        return socket;
    };
    const first = browser();
    const second = browser();
    streams.start(first as unknown as WebSocket, 'alice', provider);
    streams.start(second as unknown as WebSocket, 'bob', provider);
    expect(streams.open).toBe(1);
    expect(second.sent).toEqual([JSON.stringify({ type: 'unavailable' })]);
    expect(second.readyState).toBe(WebSocket.CLOSED);
    streams.closeAll();
    expect(streams.open).toBe(0);
});

it('sends the person’s dictation language in the session, and none with Auto (CB-221)', async () => {
    const { fake, origin, cookieOf, api } = await fixture();
    const updates = () =>
        fake.received.filter((event) => event.type === 'transcription_session.update') as Array<{
            session: { input_audio_transcription: Record<string, unknown> };
        }>;
    const session = async (userId: string) => {
        const before = updates().length;
        const { socket, events, closed } = await open(origin, {
            cookie: await cookieOf(userId),
        });
        await until(() => events.some((event) => event.type === 'ready'));
        socket.send(word());
        socket.send(JSON.stringify({ type: 'done' }));
        await closed;
        // The opening update and the one after Done.
        const sent = updates().slice(before);
        expect(sent).toHaveLength(2);
        return sent.map((update) => update.session.input_audio_transcription);
    };
    expect(
        (
            await api('bob', '/api/preferences', 'PATCH', {
                dictationLanguage: 'haw',
            })
        ).status,
    ).toBe(200);
    expect(await session('bob')).toEqual([
        { model: 'parakeet-tdt-0.6b-v3', language: 'haw' },
        { model: 'parakeet-tdt-0.6b-v3', language: 'haw' },
    ]);
    // Alice never chose: Auto, no language key at all.
    for (const transcription of await session('alice')) {
        expect(transcription).toEqual({ model: 'parakeet-tdt-0.6b-v3' });
    }
    // A language in the socket's URL is not taken.
    const { socket, events, closed } = await (async () => {
        const before = updates().length;
        const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/voice/realtime?language=fr`, {
            headers: { origin, cookie: await cookieOf('alice') },
        });
        cleanup.push(() => socket.terminate());
        const events: DictationStreamEvent[] = [];
        socket.on('message', (data) => events.push(JSON.parse(String(data)) as DictationStreamEvent));
        const closed = new Promise<number>((resolve) => socket.on('close', () => resolve(before)));
        await new Promise<void>((resolve) => socket.once('open', resolve));
        return { socket, events, closed };
    })();
    await until(() => events.some((event) => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'done' }));
    const before = await closed;
    for (const update of updates().slice(before)) {
        expect(update.session.input_audio_transcription).toEqual({
            model: 'parakeet-tdt-0.6b-v3',
        });
    }
    // Back to Auto.
    await api('bob', '/api/preferences', 'PATCH', { dictationLanguage: null });
    for (const transcription of await session('bob')) {
        expect(transcription).not.toHaveProperty('language');
    }
});
