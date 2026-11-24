import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, expect, it, vi } from 'vitest';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import { transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { UPLOAD_HEADER } from '@socio/shared/media-types';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';
import { keySafeUrl } from '@socio/shared/voice/transcription';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { transcriptionFromEnv } from '../src/server/voice/transcription.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-204: a key for an admin's own transcription server, set in Settings.
// fetch is stubbed (or reaches only loopback); nothing reaches the network.

const realFetch = globalThis.fetch;
const SECURE = 'https://voice.example.test';
const KEY = 'socio-voice-0123456789abcdef';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function fixture({
    env = {},
    voiceKey,
    provider = async () => Response.json({ text: 'hola' }),
}: {
    env?: Record<string, string | undefined>;
    voiceKey?: string;
    provider?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}) {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => provider(String(url), init));
    vi.stubGlobal('fetch', transport);
    const platformConfig = {
        baseUrl: 'https://model.invalid/v1',
        apiKey: 'unused',
        model: 'qwen-test',
        voiceKey,
        voiceModel: 'voice-model',
        voiceName: 'marin',
        transcription: transcriptionFromEnv(env),
        runtimeUrl: '',
        sessionSecret: 'session-secret-0123456789abcdef',
    };
    const { store, workspace, platform, app, dispose } = await makeTestRuntime({
        config: platformConfig,
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'transcription-secret-0123456789abcdef'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const login = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    const as = async (userId: string) => {
        const cookie = await login(userId);
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const alice = await as('alice');
    const bob = await as('bob');
    const record = async () =>
        app.request('/api/voice/transcriptions', {
            method: 'POST',
            headers: {
                cookie: await login('bob'),
                'Content-Type': 'application/octet-stream',
                [UPLOAD_HEADER]: '1',
                'X-File-Type': 'audio/webm',
            },
            body: new Blob([new Uint8Array(16).fill(1)]),
        });
    const shown = async () =>
        (
            (await (await alice('/api/state')).json()) as {
                settings: { transcription: Record<string, unknown> };
            }
        ).settings.transcription;
    const sealed = () =>
        store.connection.prepare('SELECT name, value, url FROM secret_settings').all() as {
            name: string;
            value: string;
            url: string | null;
        }[];
    /** Sets the key for the URL the admin sees (CB-204). */
    const setKey = (key: string, url: string, extra = {}) =>
        alice('/api/settings', 'PATCH', {
            ...extra,
            transcriptionKey: { key, url },
        });
    const authorization = (index = 0) =>
        (transport.mock.calls[index]?.[1]?.headers as Record<string, string>)?.Authorization;
    return {
        store,
        workspace,
        platform,
        platformConfig,
        setKey,
        transport,
        alice,
        bob,
        record,
        shown,
        sealed,
        authorization,
    };
}

it('sends the key set in Settings to that server only, as a bearer token', async () => {
    const { alice, bob, record, shown, transport, authorization, setKey } = await fixture({ voiceKey: 'sk-voice' });
    await alice('/api/settings', 'PATCH', {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    // Only an admin sets it.
    expect(
        (
            await bob('/api/settings', 'PATCH', {
                transcriptionKey: { key: KEY, url: SECURE },
            })
        ).status,
    ).toBe(403);
    for (const bad of [
        { key: '', url: SECURE },
        { key: 'two words', url: SECURE },
        { key: 'x'.repeat(4097), url: SECURE },
        { key: 42, url: SECURE },
        { key: KEY },
        { key: KEY, url: 'not a url' },
        { key: KEY, url: SECURE, extra: 1 },
        KEY,
    ]) {
        expect((await alice('/api/settings', 'PATCH', { transcriptionKey: bad })).status).toBe(400);
    }
    expect((await setKey(` ${KEY} `, `${SECURE}/v1/`)).status).toBe(200);
    expect(await shown()).toEqual({
        url: SECURE,
        model: 'whisper-1',
        source: 'settings',
        key: 'settings',
        keySaved: true,
        streaming: 'auto',
        realtime: true,
    });
    expect((await record()).status).toBe(200);
    expect(transport.mock.calls[0][0]).toBe(`${SECURE}/v1/audio/transcriptions`);
    expect(authorization()).toBe(`Bearer ${KEY}`);
    // And a redirect is never followed with the header.
    expect(transport.mock.calls[0][1]?.redirect).toBe('manual');
});

it('never shows the key: not in the state, the workspace, the reply or settings', async () => {
    const { alice, bob, store, platform, setKey } = await fixture({
        voiceKey: 'sk-v',
    });
    await alice('/api/settings', 'PATCH', {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    const reply = await setKey(KEY, SECURE);
    expect(await reply.text()).not.toContain(KEY);
    for (const as of [alice, bob]) {
        for (const path of ['/api/state', '/api/workspace']) {
            const text = await (await as(path)).text();
            expect(text).not.toContain(KEY);
            expect(text).not.toContain('sk-v');
        }
    }
    expect(JSON.stringify(store.settings())).not.toContain(KEY);
    expect(JSON.stringify(await platform.setup())).not.toContain(KEY);
});

it('seals it in the database, bound to its URL, and counts it for the data key', async () => {
    const { sealed, store, platform, setKey } = await fixture();
    await setKey(KEY, SECURE, {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    const rows = sealed();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(TRANSCRIPTION_KEY_SETTING);
    // The URL it is for, beside it: not secret.
    expect(rows[0].url).toBe(SECURE);
    expect(rows[0].value).toMatch(/^v[12]\./);
    expect(rows[0].value).not.toContain(KEY);
    expect(Buffer.from(rows[0].value.slice(3), 'base64url').toString('latin1')).not.toContain(KEY);
    const raw = store.connection.prepare('SELECT value FROM settings').get() as {
        value: string;
    };
    expect(raw.value).not.toContain(KEY);
    expect(platform.transcriptionKeys.read()).toEqual({ key: KEY, url: SECURE });
    // The data key's status counts it (sealed under the key in use).
    expect(platform.transcriptionKeys.sealStates()).toMatchObject({ current: 1 });
    expect(await platform.dataKeyStatus()).toMatchObject({ unknown: 0 });
});

it('clears the key when the URL changes, and keeps it for a model change', async () => {
    const { alice, sealed, shown, record, authorization, setKey } = await fixture({ voiceKey: 'sk-voice' });
    const save = (url: string, model = 'whisper-1') =>
        alice('/api/settings', 'PATCH', { transcription: { url, model } });
    await save(SECURE);
    await setKey(KEY, SECURE);
    await save(SECURE, 'whisper-large-v3');
    expect(await shown()).toMatchObject({ key: 'settings', keySaved: true });
    // A new host: the key is gone, and nothing is sent there.
    await save('https://stt.example.net');
    expect(sealed()).toEqual([]);
    expect(await shown()).toEqual({
        url: 'https://stt.example.net',
        model: 'whisper-1',
        source: 'settings',
        key: 'none',
        streaming: 'auto',
        realtime: true,
    });
    expect((await record()).status).toBe(200);
    expect(authorization(0)).toBeUndefined();
    // Even a path on the same host clears it.
    await setKey(KEY, 'https://stt.example.net');
    await save('https://stt.example.net/other');
    expect(sealed()).toEqual([]);
    // Back to the server's default (OpenAI's): cleared, and OpenAI gets only
    // VOICE_API_KEY.
    await setKey(KEY, 'https://stt.example.net/other');
    expect((await alice('/api/settings', 'PATCH', { transcription: null })).status).toBe(200);
    expect(sealed()).toEqual([]);
    expect((await record()).status).toBe(200);
    expect(authorization(1)).toBe('Bearer sk-voice');
    // A new URL with a new key in one change: the key is for the new URL.
    await setKey('second-key', SECURE, {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    expect(await shown()).toMatchObject({ url: SECURE, key: 'settings' });
    // Clear removes it.
    await alice('/api/settings', 'PATCH', { transcriptionKey: null });
    expect(sealed()).toEqual([]);
    expect(await shown()).not.toHaveProperty('keySaved');
});

it('sends a key only to the URL it was set for, never to OpenAI or another origin', () => {
    const lab = transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: SECURE });
    const savedKey = { key: KEY, url: SECURE };
    expect(transcriptionProvider({ transcription: lab, savedKey })).toMatchObject({
        key: 'settings',
        secret: KEY,
        available: true,
    });
    // The URL in force moved without clearing it (the environment changed):
    // withheld, and where it is for.
    for (const url of ['https://voice.example.test:8443', 'https://evil.example', `${SECURE}/other`]) {
        expect(
            transcriptionProvider({ transcription: lab, savedKey }, { transcription: { url, model: 'whisper-1' } }),
        ).toMatchObject({
            key: 'withheld',
            keyHost: 'voice.example.test',
            secret: undefined,
        });
    }
    // OpenAI's URL in force: only VOICE_API_KEY goes there.
    expect(
        transcriptionProvider({
            transcription: transcriptionFromEnv({}),
            voiceKey: 'sk-voice',
            savedKey,
        }),
    ).toMatchObject({ key: 'voice', secret: 'sk-voice' });
    // Unless an admin set it for OpenAI's URL itself.
    expect(
        transcriptionProvider({
            transcription: transcriptionFromEnv({}),
            voiceKey: 'sk-voice',
            savedKey: { key: KEY, url: 'https://api.openai.com' },
        }),
    ).toMatchObject({ key: 'settings', secret: KEY });
});

it('never sends a key over plain http to another machine', async () => {
    expect(keySafeUrl('https://stt.lab')).toBe(true);
    for (const url of ['http://localhost:9000', 'http://127.0.0.1:9000', 'http://127.8.9.10', 'http://[::1]:9000']) {
        expect(keySafeUrl(url)).toBe(true);
    }
    for (const url of [
        'http://10.20.0.5:8000',
        'http://stt.lab',
        'http://localhost.example.com',
        'http://127.0.0.1.example.com',
        'ftp://127.0.0.1',
    ]) {
        expect(keySafeUrl(url)).toBe(false);
    }

    const { alice, sealed, shown, setKey } = await fixture();
    await alice('/api/settings', 'PATCH', {
        transcription: { url: 'http://10.20.0.5:8000', model: 'whisper-1' },
    });
    const refused = await setKey(KEY, 'http://10.20.0.5:8000');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/only over https/);
    expect(sealed()).toEqual([]);
    // Loopback is fine over http.
    await setKey(KEY, 'http://127.0.0.1:9000', {
        transcription: { url: 'http://127.0.0.1:9000', model: 'whisper-1' },
    });
    expect(await shown()).toMatchObject({ key: 'settings', keySaved: true });
    cleanup.splice(0).forEach((fn) => void fn());

    // The environment's key at a plain-http URL: a warning at start, a clear
    // error naming the environment's fix, and the recording isn't sent
    // without it either.
    const warn = vi.fn();
    transcriptionFromEnv(
        {
            VOICE_TRANSCRIBE_URL: 'http://10.20.0.5:8000',
            VOICE_TRANSCRIBE_API_KEY: 'lab-key',
        },
        warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VOICE_TRANSCRIBE_API_KEY is sent only over https'));
    for (const url of [SECURE, 'http://127.0.0.1:9000', 'http://10.20.0.5:8000']) {
        transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: url }, warn);
    }
    transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: SECURE, VOICE_TRANSCRIBE_API_KEY: 'k' }, warn);
    expect(warn).toHaveBeenCalledOnce();
    const env = await fixture({
        env: {
            VOICE_TRANSCRIBE_URL: 'http://10.20.0.5:8000',
            VOICE_TRANSCRIBE_API_KEY: 'lab-key',
        },
    });
    expect(await env.shown()).toMatchObject({ key: 'insecure' });
    const response = await env.record();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
        'Voice setup required: VOICE_TRANSCRIBE_API_KEY is sent only over https (or to this machine). Set an https VOICE_TRANSCRIBE_URL, or unset VOICE_TRANSCRIBE_API_KEY.',
    );
    expect(env.transport).not.toHaveBeenCalled();
    cleanup.splice(0).forEach((fn) => void fn());

    // A URL saved in Settings at the environment key's plain-http origin:
    // the error names both fixes.
    const mixed = await fixture({
        env: {
            VOICE_TRANSCRIBE_URL: 'http://10.20.0.5:8000',
            VOICE_TRANSCRIBE_API_KEY: 'lab-key',
        },
    });
    await mixed.alice('/api/settings', 'PATCH', {
        transcription: { url: 'http://10.20.0.5:8000/stt', model: 'whisper-1' },
    });
    expect(await mixed.shown()).toMatchObject({
        source: 'settings',
        key: 'insecure',
        insecureKey: 'transcribe',
    });
    const both = await mixed.record();
    expect(both.status).toBe(503);
    expect(((await both.json()) as { error: string }).error).toBe(
        'Voice setup required: VOICE_TRANSCRIBE_API_KEY applies to this URL and is sent only over https (or to this machine). An admin changes the URL to https in Settings → General → Transcription, or VOICE_TRANSCRIBE_API_KEY is unset.',
    );
    expect(mixed.transport).not.toHaveBeenCalled();
});

it('does not follow a redirect to another origin with the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Record<string, IncomingHttpHeaders[]> = { a: [], b: [] };
    const listen = (name: 'a' | 'b', answer: (response: ServerResponse) => void) =>
        new Promise<number>((resolve) => {
            const server = createServer((request, response) => {
                seen[name].push(request.headers);
                request.resume();
                request.on('end', () => answer(response));
            });
            server.listen(0, '127.0.0.1', () => {
                cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
                resolve((server.address() as AddressInfo).port);
            });
        });
    // B, another origin (its own port), would answer; A redirects to it.
    const b = await listen('b', (response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ text: 'leaked' }));
    });
    const a = await listen('a', (response) => {
        response.statusCode = 307;
        response.setHeader('Location', `http://127.0.0.1:${b}/v1/audio/transcriptions`);
        response.end();
    });
    const { record, setKey } = await fixture({
        provider: (url, init) => realFetch(url, init),
    });
    await setKey(KEY, `http://127.0.0.1:${a}`, {
        transcription: { url: `http://127.0.0.1:${a}`, model: 'whisper-1' },
    });
    const response = await record();
    expect(response.status).toBe(503);
    // Said as a refused redirect, not as a server that didn't answer.
    expect(((await response.json()) as { error: string }).error).toMatch(
        /^Voice provider redirected the request, which is refused/,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/127\.0\.0\.1:\d+ \(whisper-1\) redirected \(refused\)/));
    expect(seen.a).toHaveLength(1);
    expect(seen.a[0].authorization).toBe(`Bearer ${KEY}`);
    expect(seen.b).toEqual([]);
});

it('takes the environment default from a _FILE secret, under the key set in Settings', async () => {
    const env: Record<string, string | undefined> = {
        VOICE_TRANSCRIBE_URL: SECURE,
        VOICE_TRANSCRIBE_API_KEY_FILE: '/run/secrets/voice_transcribe_key',
    };
    loadSecretFiles(env, (path) => (path === '/run/secrets/voice_transcribe_key' ? 'env-key\n' : ''));
    expect(env.VOICE_TRANSCRIBE_API_KEY).toBe('env-key');
    const { alice, record, shown, authorization, setKey } = await fixture({
        env,
    });
    expect(await shown()).toEqual({
        url: SECURE,
        model: 'gpt-4o-mini-transcribe',
        source: 'env',
        key: 'transcribe',
        streaming: 'auto',
        realtime: true,
    });
    expect((await record()).status).toBe(200);
    expect(authorization(0)).toBe('Bearer env-key');
    // An admin's key for the same server takes its place; cleared, the
    // environment's is back.
    await setKey(KEY, SECURE);
    expect((await record()).status).toBe(200);
    expect(authorization(1)).toBe(`Bearer ${KEY}`);
    await alice('/api/settings', 'PATCH', { transcriptionKey: null });
    expect((await record()).status).toBe(200);
    expect(authorization(2)).toBe('Bearer env-key');
});

it('says when the saved key cannot be opened, and blocks only its own URL', async () => {
    const { alice, store, shown, record, transport, authorization } = await fixture({ voiceKey: 'sk-voice' });
    await alice('/api/settings', 'PATCH', {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    // Sealed under a data key this server doesn't have.
    const unreadable = (url: string) =>
        store.updateSettings({}, () => ({
            [TRANSCRIPTION_KEY_SETTING]: { value: 'v2.0123456789abcdef.AAAA', url },
        }));
    await unreadable(SECURE);
    expect(await shown()).toMatchObject({ key: 'unreadable', keySaved: true });
    const response = await record();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/can’t be opened/);
    expect(transport).not.toHaveBeenCalled();
    // For another URL (the environment's moved under it): that one alone.
    await unreadable('https://old.example');
    expect(await shown()).toMatchObject({
        key: 'withheld',
        keyHost: 'old.example',
        keySaved: true,
    });
    expect((await record()).status).toBe(200);
    expect(authorization(0)).toBeUndefined();
    // OpenAI with VOICE_API_KEY, and a keyless server, still work.
    expect(
        transcriptionProvider({
            transcription: transcriptionFromEnv({}),
            voiceKey: 'sk-voice',
            savedKey: { unreadable: true, url: SECURE },
        }),
    ).toMatchObject({ key: 'voice', secret: 'sk-voice', available: true });
    expect(
        transcriptionProvider(
            { savedKey: { unreadable: true, url: SECURE } },
            { transcription: { url: 'https://lab.example', model: 'whisper-1' } },
        ),
    ).toMatchObject({ key: 'withheld', available: true });
});

it('refuses a key for a URL that is not the one in force (409), saving nothing', async () => {
    const { alice, store, sealed, setKey } = await fixture();
    await alice('/api/settings', 'PATCH', {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    // A stale tab still showing OpenAI's.
    const stale = await setKey(KEY, 'https://api.openai.com');
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/URL has changed/);
    expect(sealed()).toEqual([]);
    // With a URL change in the same request: the key's URL must be the new
    // one, else nothing at all is saved.
    expect(
        (
            await setKey(KEY, SECURE, {
                transcription: { url: 'https://stt.example.net', model: 'whisper-1' },
            })
        ).status,
    ).toBe(409);
    expect(store.settings().transcription?.url).toBe(SECURE);
    expect(sealed()).toEqual([]);
    expect((await setKey(KEY, SECURE)).status).toBe(200);
    expect(sealed()).toHaveLength(1);
});

it('refuses a key when no usable URL is in force, and says so', async () => {
    const { sealed, setKey } = await fixture({
        env: { VOICE_TRANSCRIBE_URL: 'ftp://stt.lab' },
    });
    const refused = await setKey(KEY, SECURE);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
        'No usable transcription URL is in force: save one first, then set the key.',
    );
    expect(sealed()).toEqual([]);
});

it('never leaves a key bound to another URL when a URL change and a key race', async () => {
    for (const keyFirst of [true, false]) {
        const { alice, store, sealed, setKey, record, authorization } = await fixture();
        await alice('/api/settings', 'PATCH', {
            transcription: { url: SECURE, model: 'whisper-1' },
        });
        const move = () =>
            alice('/api/settings', 'PATCH', {
                transcription: { url: 'https://stt.example.net', model: 'whisper-1' },
            });
        const key = () => setKey(KEY, SECURE);
        const [first, second] = await Promise.all(keyFirst ? [key(), move()] : [move(), key()]);
        const keyed = keyFirst ? first : second;
        // In order, the key saves and the move clears it (200), or the move
        // saves and the key is refused (409); either may win under load.
        expect([200, 409]).toContain(keyed.status);
        expect((keyFirst ? second : first).status).toBe(200);
        expect(store.settings().transcription?.url).toBe('https://stt.example.net');
        // Saved first and cleared by the move, or refused: either way none.
        expect(sealed()).toEqual([]);
        expect((await record()).status).toBe(200);
        expect(authorization(0)).toBeUndefined();
        for (const fn of cleanup.splice(0).reverse()) {
            await fn();
        }
    }
});

it('seals the key again under a new data key, through the store and the platform', async () => {
    const { store, platformConfig, sealed, setKey, alice } = await fixture();
    await setKey(KEY, SECURE, {
        transcription: { url: SECURE, model: 'whisper-1' },
    });
    const before = sealed()[0];
    expect(before.value).toMatch(/^v1\./);
    // The same database, now with a data key: a second runtime over the
    // first one's connection, which stays open.
    const current = Buffer.alloc(32, 7);
    const second = await makeTestRuntime({
        database: store.connection,
        config: { ...platformConfig, dataKeys: { current } },
    });
    cleanup.push(second.dispose);
    const { platform } = second;
    expect(await platform.dataKeyStatus()).toMatchObject({ legacy: 1 });
    // The admin's data-key status follows it live (its `seals` counter).
    const seals = () => store.counters.read(['seals']);
    const counted = seals();
    await platform.resealData();
    expect(seals()).not.toBe(counted);
    const after = sealed()[0];
    expect(after.value).toMatch(/^v2\./);
    expect(after.value).not.toBe(before.value);
    expect(after.url).toBe(SECURE);
    expect(await platform.dataKeyStatus()).toMatchObject({
        legacy: 0,
        previous: 0,
        unknown: 0,
    });
    expect(platform.transcriptionKeys.read()).toEqual({ key: KEY, url: SECURE });
    // Again: nothing left to do. A key replaced meanwhile isn't overwritten.
    await platform.resealData();
    expect(sealed()[0].value).toBe(after.value);
    expect(await store.replaceSecretSetting(TRANSCRIPTION_KEY_SETTING, before.value, 'v2.stale')).toBe(false);
    expect(sealed()[0].value).toBe(after.value);
    expect((await alice('/api/state')).status).toBe(200);
});
