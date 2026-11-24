import { afterEach, expect, it, vi } from 'vitest';

import { transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { UPLOAD_HEADER } from '@socio/shared/media-types';
import { normalizeTranscribeUrl } from '@socio/shared/voice/transcription';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { transcriptionFromEnv } from '../src/server/voice/transcription.js';
import { VoiceService } from '../src/server/voice/voice.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-101: server dictation through a configurable, OpenAI-compatible
// transcription server. fetch is stubbed; nothing reaches the network.

const LOCAL = 'http://10.20.0.5:8000';
// A keyed server: a key goes only over https (CB-204).
const SECURE = 'https://voice.example.test';
const cleanup: Array<() => unknown> = [];
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
    provider = async () => Response.json({ text: ' Hola, ¿qué tal? ' }),
}: {
    env?: Record<string, string>;
    voiceKey?: string;
    provider?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}) {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => provider(String(url), init));
    vi.stubGlobal('fetch', transport);
    const { store, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            voiceKey,
            voiceModel: 'voice-model',
            voiceName: 'marin',
            transcription: transcriptionFromEnv(env),
            runtimeUrl: '',
        },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'transcription-secret-0123456789abcdef'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
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
    const record = async (user: typeof bob = bob) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user === alice ? 'alice' : 'bob' }),
        });
        return app.request('/api/voice/transcriptions', {
            method: 'POST',
            headers: {
                cookie: login.headers.get('set-cookie')!.split(';')[0],
                'Content-Type': 'application/octet-stream',
                [UPLOAD_HEADER]: '1',
                'X-File-Type': 'audio/webm;codecs=opus',
            },
            body: new Blob([new Uint8Array(32).fill(3)]),
        });
    };
    const available = async () =>
        (
            (await (await bob('/api/workspace')).json()) as {
                setup: { transcription: boolean };
            }
        ).setup.transcription;
    const shown = async () =>
        (
            (await (await bob('/api/state')).json()) as {
                settings: { transcription: unknown };
            }
        ).settings.transcription;
    return { store, transport, alice, bob, record, available, shown };
}

const sent = (transport: ReturnType<typeof vi.fn>, index = 0) => {
    const [url, init] = transport.mock.calls[index] as [string, RequestInit];
    return {
        url,
        headers: init.headers as Record<string, string>,
        form: init.body as FormData,
    };
};

it('reads the environment: OpenAI by default, a lab URL and model when set', () => {
    expect(transcriptionFromEnv({})).toEqual({
        url: 'https://api.openai.com',
        model: 'gpt-4o-mini-transcribe',
        key: undefined,
        streaming: 'auto',
    });
    expect(
        transcriptionFromEnv({
            VOICE_TRANSCRIBE_URL: ' http://stt.lab.internal:8000/v1/ ',
            VOICE_TRANSCRIBE_MODEL: 'Systran/faster-whisper-large-v3',
            VOICE_TRANSCRIBE_API_KEY: '',
        }),
    ).toEqual({
        url: 'http://stt.lab.internal:8000',
        model: 'Systran/faster-whisper-large-v3',
        key: undefined,
        streaming: 'auto',
    });
    const warn = vi.fn();
    expect(transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: 'ftp://lab' }, warn).url).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
});

it('picks the key by URL: VOICE_API_KEY only for OpenAI, none for a lab without one', () => {
    const lab = transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: LOCAL });
    const openai = transcriptionFromEnv({});
    // A lab server: VOICE_API_KEY is never sent there.
    expect(transcriptionProvider({ transcription: lab, voiceKey: 'sk-voice' })).toMatchObject({
        key: 'none',
        secret: undefined,
        available: true,
    });
    expect(transcriptionProvider({ transcription: lab })).toMatchObject({
        key: 'none',
        available: true,
    });
    // OpenAI's URL falls back to VOICE_API_KEY, and needs a key.
    expect(transcriptionProvider({ transcription: openai, voiceKey: 'sk-voice' })).toMatchObject({
        key: 'voice',
        secret: 'sk-voice',
        available: true,
    });
    expect(transcriptionProvider({ transcription: openai })).toMatchObject({
        key: 'none',
        available: false,
    });
    // No transcription config at all: OpenAI's, as before.
    expect(transcriptionProvider({ voiceKey: 'sk-voice' })).toMatchObject({
        url: 'https://api.openai.com',
        key: 'voice',
        available: true,
    });
    // VOICE_TRANSCRIBE_API_KEY wins, at VOICE_TRANSCRIBE_URL's origin.
    const keyed = transcriptionFromEnv({
        VOICE_TRANSCRIBE_URL: SECURE,
        VOICE_TRANSCRIBE_API_KEY: 'lab-key',
    });
    expect(transcriptionProvider({ transcription: keyed, voiceKey: 'sk-voice' })).toMatchObject({
        key: 'transcribe',
        secret: 'lab-key',
        available: true,
    });
    // CB-204: never over plain http to another machine; nothing is sent.
    expect(
        transcriptionProvider({
            transcription: transcriptionFromEnv({
                VOICE_TRANSCRIBE_URL: LOCAL,
                VOICE_TRANSCRIBE_API_KEY: 'lab-key',
            }),
        }),
    ).toMatchObject({ key: 'insecure', secret: undefined, available: false });
    // An unusable URL: unavailable.
    expect(
        transcriptionProvider({
            transcription: transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: 'nope' }),
            voiceKey: 'sk-voice',
        }).available,
    ).toBe(false);
});

it('normalizes base URLs and refuses ones that are not http(s)', () => {
    expect(normalizeTranscribeUrl('https://api.openai.com/')).toBe('https://api.openai.com');
    expect(normalizeTranscribeUrl('http://127.0.0.1:9000/v1')).toBe('http://127.0.0.1:9000');
    expect(normalizeTranscribeUrl('http://[::1]:9000')).toBe('http://[::1]:9000');
    expect(normalizeTranscribeUrl('http://stt.tail1234.ts.net/whisper/')).toBe('http://stt.tail1234.ts.net/whisper');
    for (const bad of [
        '',
        'stt.lab:8000',
        'ftp://stt.lab',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'http://user:pass@stt.lab',
        'http://stt.lab/?key=1',
        'http://stt.lab/#x',
    ]) {
        expect(normalizeTranscribeUrl(bad)).toBeUndefined();
    }
});

it('sends a lab server the standard request, with no Authorization and no language', async () => {
    const { record, transport, available } = await fixture({
        env: {
            VOICE_TRANSCRIBE_URL: LOCAL,
            VOICE_TRANSCRIBE_MODEL: 'whisper-large-v3',
        },
        // Set, and still not sent to the local server.
        voiceKey: 'sk-voice-should-stay-home',
    });
    expect(await available()).toBe(true);
    const response = await record();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hola, ¿qué tal?' });
    const { url, headers, form } = sent(transport);
    expect(url).toBe(`${LOCAL}/v1/audio/transcriptions`);
    expect(headers).toEqual({});
    expect([...form.keys()].sort()).toEqual(['file', 'model', 'response_format']);
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('json');
    expect(form.has('language')).toBe(false);
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.webm');
    expect(file.type).toBe('audio/webm');
});

it("is available with no VOICE_API_KEY at all for a lab server, but not for OpenAI's", async () => {
    const lab = await fixture({ env: { VOICE_TRANSCRIBE_URL: LOCAL } });
    expect(await lab.available()).toBe(true);
    expect((await lab.record()).status).toBe(200);
    cleanup.splice(0).forEach((fn) => fn());

    const openai = await fixture();
    expect(await openai.available()).toBe(false);
    const refused = await openai.record();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/VOICE_API_KEY/);
    expect(openai.transport).not.toHaveBeenCalled();
});

it('uses VOICE_API_KEY for OpenAI, and VOICE_TRANSCRIBE_API_KEY when set', async () => {
    const openai = await fixture({ voiceKey: 'sk-voice' });
    expect((await openai.record()).status).toBe(200);
    expect(sent(openai.transport).url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(sent(openai.transport).headers.Authorization).toBe('Bearer sk-voice');
    expect(sent(openai.transport).form.get('model')).toBe('gpt-4o-mini-transcribe');
    cleanup.splice(0).forEach((fn) => fn());

    const keyed = await fixture({
        env: { VOICE_TRANSCRIBE_URL: SECURE, VOICE_TRANSCRIBE_API_KEY: 'lab-key' },
        voiceKey: 'sk-voice',
    });
    expect((await keyed.record()).status).toBe(200);
    expect(sent(keyed.transport).headers.Authorization).toBe('Bearer lab-key');
});

it('lets only an admin set the server and model, validates them, and applies them', async () => {
    const { alice, bob, store, record, transport, available, shown } = await fixture({ voiceKey: 'sk-voice' });
    // The environment's, with which key it sends; never the key.
    expect(await shown()).toEqual({
        url: 'https://api.openai.com',
        model: 'gpt-4o-mini-transcribe',
        source: 'env',
        key: 'voice',
        streaming: 'auto',
        realtime: false,
    });
    expect(JSON.stringify(await (await bob('/api/state')).json())).not.toContain('sk-voice');

    const lab = { url: `${LOCAL}/v1/`, model: 'whisper-1' };
    expect((await bob('/api/settings', 'PATCH', { transcription: lab })).status).toBe(403);
    for (const bad of [
        { url: 'ftp://stt.lab', model: 'whisper-1' },
        { url: 'not a url', model: 'whisper-1' },
        { url: 'http://admin:pw@stt.lab', model: 'whisper-1' },
        { url: 'http://stt.lab/?token=1', model: 'whisper-1' },
        { url: `${LOCAL}`, model: '' },
        { url: `${LOCAL}`, model: 'white space' },
        { url: `${LOCAL}` },
        { url: `${LOCAL}`, model: 'whisper-1', key: 'secret' },
        'http://stt.lab',
    ]) {
        expect((await alice('/api/settings', 'PATCH', { transcription: bad })).status).toBe(400);
    }
    expect(store.settings().transcription).toBeUndefined();

    expect((await alice('/api/settings', 'PATCH', { transcription: lab })).status).toBe(200);
    expect(store.settings().transcription).toEqual({
        url: LOCAL,
        model: 'whisper-1',
    });
    // VOICE_API_KEY is OpenAI's: not sent to the local server.
    // A plain-http lab elsewhere: recordings go, but no live text (CB-222).
    expect(await shown()).toEqual({
        url: LOCAL,
        model: 'whisper-1',
        source: 'settings',
        key: 'none',
        streaming: 'auto',
        realtime: false,
    });
    expect(await available()).toBe(true);
    expect((await record()).status).toBe(200);
    expect(sent(transport).url).toBe(`${LOCAL}/v1/audio/transcriptions`);
    expect(sent(transport).headers).toEqual({});
    expect(sent(transport).form.get('model')).toBe('whisper-1');

    // Other settings keep it; null goes back to the environment's.
    await alice('/api/settings', 'PATCH', { researchAllowed: false });
    expect(store.settings().transcription).toEqual({
        url: LOCAL,
        model: 'whisper-1',
    });
    expect((await alice('/api/settings', 'PATCH', { transcription: null })).status).toBe(200);
    expect(await shown()).toMatchObject({
        url: 'https://api.openai.com',
        source: 'env',
        key: 'voice',
    });
    expect((await record()).status).toBe(200);
    expect(sent(transport, 1).headers.Authorization).toBe('Bearer sk-voice');
});

it('turns server dictation on when an admin points a keyless server at a lab', async () => {
    const { alice, available } = await fixture();
    expect(await available()).toBe(false);
    await alice('/api/settings', 'PATCH', {
        transcription: { url: LOCAL, model: 'whisper-1' },
    });
    expect(await available()).toBe(true);
    // Pointing it back at OpenAI with no key turns it off again.
    await alice('/api/settings', 'PATCH', {
        transcription: { url: 'https://api.openai.com', model: 'whisper-1' },
    });
    expect(await available()).toBe(false);
});

it('names the host in the server log, not in the error people see', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { record } = await fixture({
        env: { VOICE_TRANSCRIBE_URL: LOCAL },
        provider: async () => new Response('busy', { status: 502 }),
    });
    const response = await record();
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toBe('Voice provider returned HTTP 502. Check voice configuration and quota.');
    expect(error).not.toContain('10.20.0.5');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('10.20.0.5:8000'));
});

it('gives up after the timeout with a clear message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    const config: PlatformConfig = {
        baseUrl: 'https://example.com',
        voiceName: 'marin',
        runtimeUrl: '',
        transcription: transcriptionFromEnv({ VOICE_TRANSCRIBE_URL: LOCAL }),
    };
    // A server that never answers, until the request is aborted.
    const transport = vi.fn<typeof fetch>(
        (_url, init) =>
            new Promise<Response>((_resolve, reject) =>
                init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error)),
            ),
    );
    const voice = new VoiceService(
        {
            workspace,
            store,
            config,
            turn: vi.fn(),
            history: vi.fn(),
            async requireReady() {},
            setup: async () => ({
                voice: false,
                model: true,
                browser: false,
                telegram: 'not_configured' as const,
                missing: [],
            }),
        },
        transport,
    );
    voice.transcriptionTimeoutMs = 1500;
    await expect(voice.transcribe(new Uint8Array(8), 'audio/ogg', new AbortController().signal)).rejects.toThrow(
        'Voice provider took longer than 2 seconds. Try a shorter recording, or dictate on this device.',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/10\.20\.0\.5:8000.*timed out/));
});

it("sends VOICE_TRANSCRIBE_API_KEY only to VOICE_TRANSCRIBE_URL's origin", () => {
    const keyed = transcriptionFromEnv({
        VOICE_TRANSCRIBE_URL: SECURE,
        VOICE_TRANSCRIBE_API_KEY: 'lab-key',
    });
    // The same origin, another path: the key goes.
    expect(
        transcriptionProvider(
            { transcription: keyed },
            { transcription: { url: `${SECURE}/whisper`, model: 'whisper-1' } },
        ),
    ).toMatchObject({ key: 'transcribe', secret: 'lab-key' });
    // Another origin (port, host or scheme): no key, and where it is for.
    for (const url of [`${SECURE}:8443`, 'https://stt.example.test', 'http://voice.example.test']) {
        expect(
            transcriptionProvider(
                { transcription: keyed, voiceKey: 'sk-voice' },
                { transcription: { url, model: 'whisper-1' } },
            ),
        ).toMatchObject({
            key: 'withheld',
            keyHost: 'voice.example.test',
            secret: undefined,
            available: true,
        });
    }
    // VOICE_TRANSCRIBE_URL unset: the key is OpenAI's, and goes only there.
    const openai = transcriptionFromEnv({ VOICE_TRANSCRIBE_API_KEY: 'sk-stt' });
    expect(transcriptionProvider({ transcription: openai })).toMatchObject({
        key: 'transcribe',
        secret: 'sk-stt',
        available: true,
    });
    expect(
        transcriptionProvider({ transcription: openai }, { transcription: { url: LOCAL, model: 'whisper-1' } }),
    ).toMatchObject({
        key: 'withheld',
        keyHost: 'api.openai.com',
        secret: undefined,
    });
});

it("sends the key to an admin's URL at the env origin, and no header elsewhere", async () => {
    const { alice, record, transport, shown } = await fixture({
        env: { VOICE_TRANSCRIBE_URL: SECURE, VOICE_TRANSCRIBE_API_KEY: 'lab-key' },
    });
    await alice('/api/settings', 'PATCH', {
        transcription: { url: `${SECURE}/stt`, model: 'whisper-1' },
    });
    expect((await record()).status).toBe(200);
    expect(sent(transport, 0).url).toBe(`${SECURE}/stt/v1/audio/transcriptions`);
    expect(sent(transport, 0).headers.Authorization).toBe('Bearer lab-key');

    await alice('/api/settings', 'PATCH', {
        transcription: { url: 'http://192.168.1.50:8000', model: 'whisper-1' },
    });
    expect(await shown()).toEqual({
        url: 'http://192.168.1.50:8000',
        model: 'whisper-1',
        source: 'settings',
        key: 'withheld',
        keyHost: 'voice.example.test',
        streaming: 'auto',
        realtime: false,
    });
    expect((await record()).status).toBe(200);
    expect(sent(transport, 1).url).toBe('http://192.168.1.50:8000/v1/audio/transcriptions');
    expect(sent(transport, 1).headers).toEqual({});
});
