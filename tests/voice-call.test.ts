import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { SENDER_METADATA } from '@socio/shared/types';
import { SPOKEN_TURN_NOTE, type CallStreamEvent } from '@socio/shared/voice/voice-call';

import type { PendingListener } from '../src/server/approvals/contract.js';
import { ApprovalService } from '../src/server/approvals/service.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { dictationUpgrade } from '../src/server/voice/dictation-stream.js';
import { transcriptionFromEnv } from '../src/server/voice/transcription.js';
import { voiceCallsFromEnv } from '../src/server/voice/voice-speech.js';

import { startFakeRealtime, type FakeRealtimeOptions } from './fixtures/fake-realtime.js';
import { completion } from './fixtures/model-stream.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-265: a self-hosted voice call, end to end. The browser's socket
// reaches this server through the app's checks; the call relays it to a
// loopback fake of socio-voice (fixtures/fake-realtime.ts: its realtime
// transcription socket and its speech endpoint); each thing said is a
// turn of the socio through the real runner, with only the model's HTTP
// endpoint mocked. Nothing leaves this machine (tests/setup/egress-guard.ts).

const KEY = 'socio-voice-0123456789abcdef';
const SECRET = 'call-secret-0123456789abcdef';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

async function fixture({
    fake: fakeOptions = { token: KEY, speech: {} },
    env,
    reply = 'Sure, **here** it is: see [the page](https://example.com/x). A second sentence follows.',
    paused = false,
}: {
    fake?: FakeRealtimeOptions;
    env?: (fakeUrl: string) => Record<string, string>;
    reply?: string;
    paused?: boolean;
} = {}) {
    const fake = await startFakeRealtime(fakeOptions);
    cleanup.push(fake.close);
    const real = globalThis.fetch.bind(globalThis);
    const model: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (!String(url).startsWith('https://model.invalid')) {
            return real(url as string, init);
        }
        if (String(init?.body).includes('Write a short title')) {
            return Response.json({
                choices: [{ message: { content: '"A title."' } }],
            });
        }
        model.push(String(init?.body));
        return completion({ role: 'assistant', content: reply });
    });
    const vars = env?.(fake.url) ?? {
        VOICE_TRANSCRIBE_URL: fake.url,
        VOICE_TRANSCRIBE_MODEL: 'parakeet-tdt-0.6b-v3',
        VOICE_TRANSCRIBE_API_KEY: KEY,
        VOICE_BACKEND: 'self-hosted',
        VOICE_SPEECH_URL: fake.url,
    };
    // The listeners for approvals, as the graph registers them: the calls'
    // (built with the runtime) and the Telegram notice's (idle, with no
    // Telegram).
    const pending: PendingListener[] = [];
    const onPending = ApprovalService.prototype.onPending;
    vi.spyOn(ApprovalService.prototype, 'onPending').mockImplementation(function (this: ApprovalService, listener) {
        pending.push(listener);
        onPending.call(this, listener);
    });
    const { store, workspace, platform, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            voiceName: 'marin',
            voiceKey: vars.VOICE_API_KEY,
            voiceModel: vars.VOICE_MODEL,
            transcription: transcriptionFromEnv(vars),
            voiceCalls: voiceCallsFromEnv(vars),
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
    if (paused) {
        await store.updateSettings({ paused: true });
    }
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
    // Bob's chat with the first socio.
    await cookieOf('bob');
    const thread = await platform.createConversation(workspace.dots()[0].id, 'Call', 'bob');
    return {
        pending,
        fake,
        origin,
        app,
        store,
        platform,
        workspace,
        cookieOf,
        api,
        model,
        thread,
    };
}

/** The call's socket, as the browser opens it, and everything it gets. */
async function open(origin: string, id: string, cookie: string) {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/voice/call?id=${encodeURIComponent(id)}`, {
        headers: { origin, cookie },
    });
    cleanup.push(() => socket.terminate());
    const events: CallStreamEvent[] = [];
    const audio: Buffer[] = [];
    socket.on('message', (data, binary) => {
        if (binary) {
            audio.push(data as Buffer);
        } else {
            events.push(JSON.parse(String(data)) as CallStreamEvent);
        }
    });
    const closed = new Promise<void>((resolve) => socket.on('close', resolve));
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return { socket, events, audio, closed };
}

const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('Timed out waiting.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};
const word = () => Buffer.alloc(3200, 1);
const of = <T extends CallStreamEvent['type']>(events: CallStreamEvent[], type: T) =>
    events.filter((event): event is Extract<CallStreamEvent, { type: T }> => event.type === type);

async function startCall(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.api('bob', '/api/voice/calls', 'POST', {
        threadId: f.thread.id,
    });
    expect(response.status).toBe(201);
    const { id, backend } = (await response.json()) as {
        id: string;
        backend: string;
    };
    expect(backend).toBe('self-hosted');
    return id;
}

it('runs a spoken turn through the socio and speaks the reply from the speech server', async () => {
    const f = await fixture();
    const setup = (await (await f.api('bob', '/api/workspace')).json()) as {
        setup: Record<string, unknown>;
    };
    expect(setup.setup).toMatchObject({
        voice: true,
        voiceBackend: 'self-hosted',
        voiceCloud: false,
        voiceSpeech: true,
    });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    expect(of(call.events, 'ready')[0].speech).toBe(true);
    expect(f.workspace.call(id).status).toBe('active');
    // The key goes to the transcription server's socket, and nothing else of Bob's.
    expect(f.fake.handshakes[0].path).toBe('/v1/realtime');
    expect(f.fake.handshakes[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(f.fake.handshakes[0].headers)).not.toContain('bob');
    expect(f.fake.received[0]).toMatchObject({
        type: 'transcription_session.update',
        session: {
            input_audio_format: 'pcm16',
            input_audio_sample_rate: 16_000,
            turn_detection: { type: 'server_vad' },
        },
    });
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'spoken').length === 1);
    expect(of(call.events, 'partial').map((e) => e.text)).toEqual(['hello', 'hello from', 'hello from the']);
    expect(of(call.events, 'heard')).toEqual([{ type: 'heard', text: 'hello from the' }]);
    // The turn: the person's words, theirs, with the spoken-turn note for
    // the model only.
    expect(f.model).toHaveLength(1);
    expect(f.model[0]).toContain('hello from the');
    expect(f.model[0]).toContain(SPOKEN_TURN_NOTE.slice(0, 40));
    const messages = await f.platform.runner.messages(f.thread.id);
    const said = messages.find((message) => message.role === 'user');
    expect(said?.content).toBe('hello from the');
    expect((said as { metadata?: Record<string, unknown> }).metadata?.[SENDER_METADATA]).toBe('bob');
    expect(messages.at(-1)?.role).toBe('assistant');
    // Spoken without markdown or links, from the speech server, with the
    // transcription key (the same origin) and in pieces.
    const reply = of(call.events, 'reply')[0];
    expect(reply).toEqual({
        type: 'reply',
        audio: true,
        text: 'Sure, here it is: see the page. A second sentence follows.',
    });
    expect(f.fake.speeches.length).toBeGreaterThanOrEqual(1);
    expect(f.fake.speeches[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(f.fake.speeches[0].body).toMatchObject({
        model: 'kokoro',
        voice: 'auto',
        response_format: 'pcm',
    });
    // Whole 16-bit samples only, though the server's chunks were odd.
    expect(call.audio.length).toBeGreaterThan(0);
    expect(call.audio.every((chunk) => chunk.length % 2 === 0)).toBe(true);
    // Hanging up keeps the server's transcript; no receipt turn follows.
    const ended = await f.api('bob', `/api/voice/calls/${id}/end`, 'POST', {
        transcript: 'whatever the browser says',
    });
    expect(ended.status).toBe(200);
    const saved = f.workspace.call(id);
    expect(saved.status).toBe('ended');
    expect(saved.transcript).toContain('You: hello from the');
    expect(saved.transcript).toContain(': Sure, **here** it is');
    await call.closed;
    expect(f.model).toHaveLength(1);
});

it('lets only the call’s owner open its socket', async () => {
    const f = await fixture();
    const id = await startCall(f);
    const socket = new WebSocket(`${f.origin.replace('http', 'ws')}/api/voice/call?id=${id}`, {
        headers: { origin: f.origin, cookie: await f.cookieOf('alice') },
    });
    cleanup.push(() => socket.terminate());
    const status = await new Promise<number>((resolve) => {
        socket.on('unexpected-response', (request, response) => {
            resolve(response.statusCode ?? 0);
            request.destroy();
        });
        socket.on('error', () => {});
    });
    expect(status).toBe(404);
    expect(f.fake.handshakes).toHaveLength(0);
    // And a call that isn't self-hosted (or is gone) is told, not relayed.
    const missing = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(missing.events, 'ready').length === 1);
    const again = await open(f.origin, id, await f.cookieOf('bob'));
    await again.closed;
    expect(of(again.events, 'ended')[0]?.reason).toMatch(/ended/);
});

it('ends cleanly with a clear reason when the voice server is down', async () => {
    const f = await fixture({
        fake: { token: KEY, refuse: { status: 502 } },
        env: (url) => ({
            VOICE_TRANSCRIBE_URL: url,
            VOICE_TRANSCRIBE_API_KEY: KEY,
            VOICE_BACKEND: 'self-hosted',
            VOICE_API_KEY: 'sk-cloud-fallback',
            VOICE_MODEL: 'gpt-realtime',
        }),
    });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await call.closed;
    expect(of(call.events, 'ready')).toHaveLength(0);
    expect(of(call.events, 'ended')[0].reason).toMatch(/isn’t answering/);
    const saved = f.workspace.call(id);
    expect(saved.status).toBe('failed');
    expect(saved.error).toMatch(/isn’t answering/);
    // Nothing went anywhere else, and the person may pick cloud voice.
    expect(f.model).toHaveLength(0);
    const setup = (await (await f.api('bob', '/api/workspace')).json()) as {
        setup: Record<string, unknown>;
    };
    expect(setup.setup).toMatchObject({ voice: true, voiceCloud: true });
    // A new call can start: the failed one doesn't block it.
    await startCall(f);
});

it('names the key when the voice server refuses it', async () => {
    const f = await fixture({
        env: (url) => ({
            VOICE_TRANSCRIBE_URL: url,
            VOICE_TRANSCRIBE_API_KEY: 'wrong-key-0123456789',
            VOICE_BACKEND: 'self-hosted',
        }),
    });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await call.closed;
    expect(of(call.events, 'ended')[0].reason).toMatch(/refused Socio’s key/);
});

it('falls back to the device’s voice when the speech server fails', async () => {
    const f = await fixture({ fake: { token: KEY, speech: { status: 500 } } });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'say').length === 1);
    expect(of(call.events, 'say')[0].text).toContain('Sure, here it is');
    expect(of(call.events, 'notice')[0].text).toMatch(/this device speaks/);
    // The next reply goes straight to the device.
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'reply').length === 2);
    expect(of(call.events, 'reply')[1].audio).toBe(false);
    expect(f.fake.speeches).toHaveLength(1);
    expect(call.audio).toHaveLength(0);
});

it('speaks on the device when no speech server is set', async () => {
    const f = await fixture({
        env: (url) => ({
            VOICE_TRANSCRIBE_URL: url,
            VOICE_TRANSCRIBE_API_KEY: KEY,
            VOICE_BACKEND: 'self-hosted',
        }),
    });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    expect(of(call.events, 'ready')[0].speech).toBe(false);
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'reply').length === 1);
    expect(of(call.events, 'reply')[0].audio).toBe(false);
    expect(f.fake.speeches).toHaveLength(0);
});

it('stops speaking when the person talks over the reply', async () => {
    const f = await fixture({
        fake: { token: KEY, speech: { gapMs: 2000, bytes: 48_000 } },
    });
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => call.audio.length > 0);
    // The fake hears a new turn start: the reply's speech is cut short.
    call.socket.send(word());
    await until(() => of(call.events, 'speech').length === 2);
    await until(() => of(call.events, 'spoken').length === 1);
    await until(() => f.fake.speeches[0]?.aborted === true);
    expect(f.fake.speeches).toHaveLength(1);
});

it('refuses a call while paused, and a member can’t change the backend', async () => {
    const f = await fixture({ paused: true });
    const response = await f.api('bob', '/api/voice/calls', 'POST', {
        threadId: f.thread.id,
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('Socio is paused.');
    expect(f.fake.handshakes).toHaveLength(0);
    const member = await f.api('bob', '/api/settings', 'PATCH', {
        voiceBackend: 'cloud',
    });
    expect(member.status).toBe(403);
});

it('lets an admin pick the backend and speech server over the environment', async () => {
    const f = await fixture();
    const save = (body: unknown) => f.api('alice', '/api/settings', 'PATCH', body);
    expect((await save({ voiceBackend: 'cloud' })).status).toBe(200);
    expect((await save({ voiceSpeech: { url: 'ftp://x', model: 'k', voice: 'a' } })).status).toBe(400);
    expect(
        (
            await save({
                voiceSpeech: {
                    url: 'https://speech.lab/v1',
                    model: 'tts-1',
                    voice: 'alloy',
                },
            })
        ).status,
    ).toBe(200);
    const state = (await (await f.api('alice', '/api/state')).json()) as {
        settings: Record<string, unknown>;
    };
    expect(state.settings.voiceCalls).toEqual({
        backend: 'cloud',
        backendSource: 'settings',
        speech: {
            url: 'https://speech.lab',
            model: 'tts-1',
            voice: 'alloy',
            source: 'settings',
            // Another origin than the transcription server's: no key goes there.
            key: 'none',
        },
    });
    // Cloud in force, and not set up: no calls; the call button says so.
    const setup = (await (await f.api('bob', '/api/workspace')).json()) as {
        setup: Record<string, unknown>;
    };
    expect(setup.setup).toMatchObject({ voice: false, voiceBackend: 'cloud' });
    // Back to the environment's.
    await save({ voiceBackend: null, voiceSpeech: null });
    const back = (await (await f.api('alice', '/api/state')).json()) as {
        settings: { voiceCalls: { backend: string; speech: { source: string } } };
    };
    expect(back.settings.voiceCalls.backend).toBe('self-hosted');
    expect(back.settings.voiceCalls.speech.source).toBe('env');
});

it('tells the caller when a turn asks for an approval in this chat', async () => {
    const f = await fixture();
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    const view = { summary: 'Create the dataset “Leads”' } as Parameters<(typeof f.pending)[number]>[0];
    for (const listener of f.pending) {
        listener(view, { userId: 'bob', threadId: 'another-chat' });
    }
    for (const listener of f.pending) {
        listener(view, { userId: 'bob', threadId: f.thread.id });
    }
    await until(() => of(call.events, 'notice').length === 1);
    expect(of(call.events, 'notice')[0].text).toBe(
        'Approval needed: Create the dataset “Leads”. Approve or deny it in the chat; your socio carries on there once you decide.',
    );
});

it('counts spoken turns against the chat’s message rate, as typed ones', async () => {
    const f = await fixture();
    // One message a minute (CB-211): the second thing said is turned away.
    expect(
        (
            await f.api('alice', '/api/settings', 'PATCH', {
                limits: { roomMessagesPerMinute: 1 },
            })
        ).status,
    ).toBe(200);
    const id = await startCall(f);
    const call = await open(f.origin, id, await f.cookieOf('bob'));
    await until(() => of(call.events, 'ready').length === 1);
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'reply').length === 1);
    for (let i = 0; i < 3; i++) {
        call.socket.send(word());
    }
    await until(() => of(call.events, 'notice').length === 1);
    expect(of(call.events, 'notice')[0].text).toMatch(
        /^That turn didn’t work: This chat got too many messages in the last minute/,
    );
    expect(f.model).toHaveLength(1);
});

it('sends the caller’s dictation language to the call’s socket, and none with Auto (CB-221)', async () => {
    const f = await fixture();
    const transcription = () =>
        (
            f.fake.received.filter((event) => event.type === 'transcription_session.update') as Array<{
                session: { input_audio_transcription: Record<string, unknown> };
            }>
        ).map((update) => update.session.input_audio_transcription);
    const call = async () => {
        const id = await startCall(f);
        const opened = await open(f.origin, id, await f.cookieOf('bob'));
        await until(() => of(opened.events, 'ready').length === 1);
        expect(
            (
                await f.api('bob', `/api/voice/calls/${id}/end`, 'POST', {
                    transcript: '',
                })
            ).status,
        ).toBe(200);
        await opened.closed;
    };
    // Auto: no language key at all.
    await call();
    expect(transcription()).toEqual([{ model: 'parakeet-tdt-0.6b-v3' }]);
    // Another person's choice doesn't reach Bob's call.
    await f.api('alice', '/api/preferences', 'PATCH', {
        dictationLanguage: 'de',
    });
    await call();
    expect(transcription()[1]).toEqual({ model: 'parakeet-tdt-0.6b-v3' });
    await f.api('bob', '/api/preferences', 'PATCH', { dictationLanguage: 'es' });
    await call();
    expect(transcription()[2]).toEqual({
        model: 'parakeet-tdt-0.6b-v3',
        language: 'es',
    });
});
