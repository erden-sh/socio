import { afterEach, expect, it, vi } from 'vitest';

import { UPLOAD_HEADER } from '@socio/shared/media-types';
import {
    DICTATION_LIMITS,
    availableDictation,
    chooseDictation,
    dictationAllowedFromEnv,
} from '@socio/shared/voice/dictation';
import {
    DICTATION_LANGUAGES,
    DICTATION_LANGUAGE_OPTIONS,
    dictationLanguageHint,
} from '@socio/shared/voice/dictation-languages';
import type { DictationLanguage } from '@socio/shared/voice/dictation-languages';

import { insertDictation } from '../../packages/client/src/modules/voice/use-dictation.js';
import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { realtimeTranscription } from '../../src/server/voice/transcription.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// CB-101: dictation's per-person preference, the admin's allowance and
// the server's transcription endpoint. The voice provider is a stub: the
// test never reaches the network (tests/setup/egress-guard.ts).

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.unstubAllGlobals();
});

async function fixture({
    voiceKey = 'test-voice-key',
    provider = async () => Response.json({ text: '  Hello there  ' }),
}: {
    voiceKey?: string;
    provider?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}) {
    // The app's VoiceService takes the global fetch when it is made.
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => provider(String(url), init));
    vi.stubGlobal('fetch', transport);
    const { store, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
            voiceKey: voiceKey || undefined,
            voiceModel: 'voice-model',
            voiceName: 'marin',
            dictationMethods: 'both',
            runtimeUrl: '',
        },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'dictation-secret-0123456789abcdef'),
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
        return (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
            app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined || body instanceof Uint8Array ? {} : { 'Content-Type': 'application/json' }),
                    ...headers,
                },
                ...(body === undefined
                    ? {}
                    : {
                          body:
                              body instanceof Uint8Array
                                  ? new Blob([body as Uint8Array<ArrayBuffer>])
                                  : JSON.stringify(body),
                      }),
            });
    };
    return {
        app,
        store,
        workspace,
        transport,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

const recording = (bytes = 64) => new Uint8Array(bytes).fill(7);
const audioHeaders = (type = 'audio/webm;codecs=opus') => ({
    'Content-Type': 'application/octet-stream',
    [UPLOAD_HEADER]: '1',
    'X-File-Type': type,
});

it('lets a member set their own dictation preference, and only theirs', async () => {
    const { alice, bob } = await fixture();
    expect(await (await bob('/api/preferences')).json()).toEqual({
        dictation: null,
    });
    const saved = await bob('/api/preferences', 'PATCH', { dictation: 'server' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ dictation: 'server' });
    // It follows them: the shell's workspace view carries it.
    const view = (await (await bob('/api/workspace')).json()) as {
        preferences: unknown;
    };
    expect(view.preferences).toEqual({ dictation: 'server' });
    // Someone else's are their own.
    expect(await (await alice('/api/preferences')).json()).toEqual({
        dictation: null,
    });
    // Back to asking.
    await bob('/api/preferences', 'PATCH', { dictation: null });
    expect(await (await bob('/api/preferences')).json()).toEqual({
        dictation: null,
    });
});

it('refuses bad preference values with 400', async () => {
    const { bob } = await fixture();
    for (const bad of [
        { dictation: 'cloud' },
        { dictation: 1 },
        { dictation: 'device', theme: 'dark' },
        'device',
        null,
    ]) {
        expect((await bob('/api/preferences', 'PATCH', bad)).status).toBe(400);
    }
    expect(await (await bob('/api/preferences')).json()).toEqual({
        dictation: null,
    });
});

it("shows the server's dictation methods until an admin allows only one", async () => {
    const { alice, bob, store } = await fixture();
    const allowed = async () =>
        (
            (await (await bob('/api/state')).json()) as {
                settings: { dictationMethods: unknown };
            }
        ).settings.dictationMethods;
    expect(await allowed()).toBe('both');
    expect((await bob('/api/settings', 'PATCH', { dictationMethods: 'device' })).status).toBe(403);
    expect((await alice('/api/settings', 'PATCH', { dictationMethods: 'cloud' })).status).toBe(400);
    expect((await alice('/api/settings', 'PATCH', { dictationMethods: 'device' })).status).toBe(200);
    expect(await allowed()).toBe('device');
    expect(store.settings().dictationMethods).toBe('device');
});

it('transcribes a recording through the voice provider', async () => {
    const { bob, transport } = await fixture();
    const response = await bob('/api/voice/transcriptions', 'POST', recording(), audioHeaders());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Hello there' });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-voice-key');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.webm');
    expect(file.type).toBe('audio/webm');
    expect(file.size).toBe(64);
});

it('needs a signed-in person, the upload header and an audio type', async () => {
    const { app, bob, transport } = await fixture();
    expect(
        (
            await app.request('/api/voice/transcriptions', {
                method: 'POST',
                headers: audioHeaders(),
                body: recording(),
            })
        ).status,
    ).toBe(401);
    // Without the header a cross-site form can't send.
    const plain: Record<string, string> = audioHeaders();
    delete plain[UPLOAD_HEADER];
    expect((await bob('/api/voice/transcriptions', 'POST', recording(), plain)).status).toBe(415);
    expect((await bob('/api/voice/transcriptions', 'POST', recording(), audioHeaders('image/png'))).status).toBe(415);
    expect((await bob('/api/voice/transcriptions', 'POST', new Uint8Array(), audioHeaders())).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
});

it('refuses a recording over the size limit before the provider', async () => {
    const { bob, transport } = await fixture();
    const response = await bob(
        '/api/voice/transcriptions',
        'POST',
        recording(DICTATION_LIMITS.maxBytes + 1),
        audioHeaders(),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toMatch(/5 MB/);
    expect(transport).not.toHaveBeenCalled();
});

it('says when the provider fails or voice is not set up', async () => {
    const failing = await fixture({
        provider: async () => new Response('quota', { status: 429 }),
    });
    const response = await failing.bob('/api/voice/transcriptions', 'POST', recording(), audioHeaders('audio/mp4'));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
        'Voice provider returned HTTP 429. Check voice configuration and quota.',
    );
    cleanup.splice(0).forEach((fn) => fn());

    const unset = await fixture({ voiceKey: '' });
    const workspace = (await (await unset.bob('/api/workspace')).json()) as {
        setup: { transcription: boolean };
    };
    expect(workspace.setup.transcription).toBe(false);
    const refused = await unset.bob('/api/voice/transcriptions', 'POST', recording(), audioHeaders());
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/VOICE_API_KEY/);
    expect(unset.transport).not.toHaveBeenCalled();
});

it('offers only the ways that work, and asks only when both do', () => {
    expect(availableDictation({ device: false, server: false })).toEqual([]);
    expect(availableDictation({ device: true, server: false })).toEqual(['device']);
    expect(availableDictation({ device: true, server: true })).toEqual(['device', 'server']);
    expect(availableDictation({ device: true, server: true, allowed: 'server' })).toEqual(['server']);
    expect(availableDictation({ device: false, server: true, allowed: 'device' })).toEqual([]);

    expect(chooseDictation([], 'device')).toBeNull();
    expect(chooseDictation(['server'], null)).toBe('server');
    // The only way that works wins over a preference it can't meet.
    expect(chooseDictation(['server'], 'device')).toBe('server');
    expect(chooseDictation(['device', 'server'], null)).toBe('ask');
    expect(chooseDictation(['device', 'server'], 'server')).toBe('server');

    expect(dictationAllowedFromEnv({})).toBe('both');
    expect(dictationAllowedFromEnv({ DICTATION_METHODS: ' Device ' })).toBe('device');
    expect(dictationAllowedFromEnv({ DICTATION_METHODS: 'cloud' })).toBe('both');
});

it('puts dictated text at the cursor, spaced, within the length', () => {
    expect(insertDictation('', 'Hello')).toEqual({ value: 'Hello', caret: 5 });
    expect(insertDictation('Hi', 'there')).toEqual({
        value: 'Hi there',
        caret: 8,
    });
    // At the cursor, between words.
    expect(insertDictation('Hi friend', 'there', 2, 2)).toEqual({
        value: 'Hi there friend',
        caret: 8,
    });
    // Over a selection, before punctuation.
    expect(insertDictation('Hi you.', 'there', 3, 6).value).toBe('Hi there.');
    expect(insertDictation('abc', 'defgh', 3, 3, 6).value).toBe('abc de');
});

it('stores onboarding only for the signed-in person and merges guide PATCHes without discarding dictation or another guide', async () => {
    const { alice, bob } = await fixture();
    const progress = { version: 1, status: 'dismissed', stepId: 'welcome' };
    expect(
        (
            await alice('/api/preferences', 'PATCH', {
                dictation: 'device',
                onboarding: { 'getting-started': progress },
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await alice('/api/preferences', 'PATCH', {
                onboarding: {
                    improvements: { ...progress, status: 'completed', stepId: 'follow' },
                },
            })
        ).status,
    ).toBe(200);
    const saved = await (await alice('/api/preferences')).json();
    expect(saved.dictation).toBe('device');
    expect(saved.onboarding['getting-started']).toEqual(progress);
    expect(saved.onboarding.improvements.status).toBe('completed');
    expect(await (await bob('/api/preferences')).json()).toEqual({
        dictation: null,
    });
    for (const bad of [
        { userId: 'alice', onboarding: { 'getting-started': progress } },
        { onboarding: { unknown: progress } },
        {
            onboarding: {
                'getting-started': { ...progress, token: 'never-store-secrets' },
            },
        },
        { onboarding: { 'getting-started': { ...progress, version: -1 } } },
    ]) {
        expect((await bob('/api/preferences', 'PATCH', bad)).status).toBe(400);
    }
});

// CB-221: each person's dictation language, a hint to the transcription
// server. Auto sends none, so the server detects the language.

it('offers socio-voice’s languages but Nynorsk and Javanese, by name', () => {
    const codes = Object.keys(DICTATION_LANGUAGES);
    expect(codes).toHaveLength(98);
    expect(codes).not.toContain('nn');
    expect(codes).not.toContain('jw');
    for (const code of ['en', 'fr', 'zh', 'no', 'yue', 'haw', 'es']) {
        expect(codes).toContain(code);
    }
    const names = DICTATION_LANGUAGE_OPTIONS.map((option) => option.name);
    expect(names[0]).toBe('Afrikaans');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(dictationLanguageHint('fr')).toBe('fr');
    for (const bad of ['jw', 'nn', 'auto', 'FR', 'fr-FR', '', null, 1, {}]) {
        expect(dictationLanguageHint(bad)).toBeUndefined();
    }
    // A realtime session's transcription: the language only when offered.
    expect(realtimeTranscription('m', 'fr')).toEqual({
        model: 'm',
        language: 'fr',
    });
    expect(realtimeTranscription('m')).toEqual({ model: 'm' });
    expect(realtimeTranscription('m', 'jw' as DictationLanguage)).toEqual({
        model: 'm',
    });
});

it('saves a dictation language for the person only, and checks it', async () => {
    const { alice, bob } = await fixture();
    const saved = await bob('/api/preferences', 'PATCH', {
        dictationLanguage: 'yue',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
        dictation: null,
        dictationLanguage: 'yue',
    });
    // It follows them, and leaves the other preferences alone.
    await bob('/api/preferences', 'PATCH', { dictation: 'server' });
    expect(((await (await bob('/api/workspace')).json()) as { preferences: unknown }).preferences).toEqual({
        dictation: 'server',
        dictationLanguage: 'yue',
    });
    // Alice's is still Auto.
    expect(await (await alice('/api/preferences')).json()).toEqual({
        dictation: null,
    });
    for (const bad of [
        { dictationLanguage: 'jw' },
        { dictationLanguage: 'nn' },
        { dictationLanguage: 'xx' },
        { dictationLanguage: 'FR' },
        { dictationLanguage: 'auto' },
        { dictationLanguage: 1 },
        { dictationLanguage: ['fr'] },
    ]) {
        expect((await bob('/api/preferences', 'PATCH', bad)).status).toBe(400);
    }
    expect(((await (await bob('/api/preferences')).json()) as Record<string, unknown>).dictationLanguage).toBe('yue');
    // Back to Auto.
    await bob('/api/preferences', 'PATCH', { dictationLanguage: null });
    expect(((await (await bob('/api/preferences')).json()) as Record<string, unknown>).dictationLanguage).toBeNull();
});

it('sends the person’s language with a recording, and none with Auto', async () => {
    const { alice, bob, transport, workspace } = await fixture();
    const sent = async (as: typeof bob) => {
        transport.mockClear();
        const response = await as('/api/voice/transcriptions', 'POST', recording(), audioHeaders());
        expect(response.status).toBe(200);
        expect(transport).toHaveBeenCalledTimes(1);
        const form = transport.mock.calls[0][1]?.body as FormData;
        expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
        return form;
    };
    // Auto: no language field at all.
    expect((await sent(bob)).has('language')).toBe(false);
    await bob('/api/preferences', 'PATCH', { dictationLanguage: 'fr' });
    expect((await sent(bob)).get('language')).toBe('fr');
    // Bob's choice is his: Alice's recordings still go without one.
    expect((await sent(alice)).has('language')).toBe(false);
    // A header or query can't pick a language for the request.
    transport.mockClear();
    await alice('/api/voice/transcriptions?language=de', 'POST', recording(), {
        ...audioHeaders(),
        'X-Language': 'de',
    });
    expect((transport.mock.calls[0][1]!.body as FormData).has('language')).toBe(false);
    // A stored code that is no longer offered is Auto, never sent.
    workspace.setPreferences('alice', {
        dictationLanguage: 'jw' as DictationLanguage,
    });
    expect((await sent(alice)).has('language')).toBe(false);
    // Back to Auto.
    await bob('/api/preferences', 'PATCH', { dictationLanguage: null });
    expect((await sent(bob)).has('language')).toBe(false);
});
