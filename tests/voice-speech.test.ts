import { expect, it, vi } from 'vitest';

import { callsSetup, speechProvider, voiceBackend } from '@socio/foundation/voice/speech-provider';
import { callSocketUrl, transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { speechPieces, spokenText, voiceBackendFromEnv } from '@socio/shared/voice/voice-call';

import { transcriptionFromEnv } from '../src/server/voice/transcription.js';
import { SpeechError, synthesize, voiceCallsFromEnv } from '../src/server/voice/voice-speech.js';

// CB-265: self-hosted calls' settings and speech, without a server.

const KEY = 'speech-key-0123456789';

it('reads VOICE_BACKEND and VOICE_SPEECH_*, warning about unusable values', () => {
    const warn = vi.fn();
    expect(voiceBackendFromEnv({})).toBe('cloud');
    expect(voiceBackendFromEnv({ VOICE_BACKEND: ' Self-Hosted ' })).toBe('self-hosted');
    const env = voiceCallsFromEnv(
        {
            VOICE_BACKEND: 'local',
            VOICE_SPEECH_URL: 'http://10.0.0.5:8007/v1',
            VOICE_SPEECH_API_KEY: KEY,
        },
        warn,
    );
    expect(env.backend).toBe('cloud');
    expect(env.speech).toEqual({
        url: 'http://10.0.0.5:8007',
        model: 'kokoro',
        voice: 'auto',
        key: KEY,
    });
    // An unknown backend, and a key that would go in the clear.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.join(' ')).not.toContain(KEY);
});

it('sends a speech key only to the origin it is bound to, over https', () => {
    const env = voiceCallsFromEnv({
        VOICE_SPEECH_URL: 'https://voice-agent.lab',
        VOICE_SPEECH_API_KEY: KEY,
    }).speech;
    const transcription = {
        url: 'https://voice.lab',
        secret: 'transcription-key',
    };
    expect(speechProvider(env, {}, transcription)).toMatchObject({
        url: 'https://voice-agent.lab',
        key: 'speech',
        secret: KEY,
        available: true,
    });
    // An admin's URL elsewhere: no key from the environment.
    expect(
        speechProvider(env, { voiceSpeech: { url: 'https://other.lab', model: 'm', voice: 'v' } }, transcription),
    ).toMatchObject({
        key: 'withheld',
        keyHost: 'voice-agent.lab',
        secret: undefined,
    });
    // The transcription server's own origin: its key in force.
    expect(
        speechProvider(
            undefined,
            { voiceSpeech: { url: 'https://voice.lab/tts', model: 'm', voice: 'v' } },
            transcription,
        ),
    ).toMatchObject({ key: 'transcription', secret: 'transcription-key' });
    // A key never goes over plain http to another machine.
    expect(
        speechProvider(
            voiceCallsFromEnv({
                VOICE_SPEECH_URL: 'http://voice-agent.lab',
                VOICE_SPEECH_API_KEY: KEY,
            }).speech,
            {},
        ),
    ).toMatchObject({ key: 'insecure', secret: undefined, available: false });
    // Keyless on the LAN is fine; an empty URL means the device speaks.
    expect(speechProvider(voiceCallsFromEnv({ VOICE_SPEECH_URL: 'http://10.0.0.5:8880' }).speech, {})).toMatchObject({
        key: 'none',
        available: true,
    });
    expect(speechProvider(env, { voiceSpeech: { url: '', model: 'm', voice: 'v' } })).toMatchObject({
        url: undefined,
        available: false,
    });
});

it('takes an admin’s backend over the environment’s', () => {
    const env = voiceCallsFromEnv({ VOICE_BACKEND: 'self-hosted' });
    expect(voiceBackend(env, {})).toEqual({
        backend: 'self-hosted',
        source: 'env',
    });
    expect(voiceBackend(env, { voiceBackend: 'cloud' })).toEqual({
        backend: 'cloud',
        source: 'settings',
    });
    expect(voiceBackend(undefined, { voiceBackend: null })).toEqual({
        backend: 'cloud',
        source: 'env',
    });
});

it('runs self-hosted calls only on a realtime socket it may use', () => {
    const provider = (env: Record<string, string>) =>
        transcriptionProvider({ transcription: transcriptionFromEnv(env) });
    expect(callSocketUrl(provider({ VOICE_TRANSCRIBE_URL: 'https://voice.lab' }))).toBe('wss://voice.lab/v1/realtime');
    // Live dictation off doesn't turn calls off.
    expect(
        callSocketUrl(
            provider({
                VOICE_TRANSCRIBE_URL: 'https://voice.lab',
                VOICE_TRANSCRIBE_STREAMING: 'off',
            }),
        ),
    ).toBe('wss://voice.lab/v1/realtime');
    // OpenAI's batch API, and plain ws to another machine: no.
    expect(callSocketUrl(provider({}))).toBeUndefined();
    expect(callSocketUrl(provider({ VOICE_TRANSCRIBE_URL: 'http://10.0.0.5:8006' }))).toBeUndefined();
    const setup = (env: Record<string, string>, cloud = false) =>
        callsSetup({
            cloud,
            model: true,
            env: voiceCallsFromEnv(env),
            settings: {},
            transcription: provider(env),
        });
    expect(setup({ VOICE_BACKEND: 'self-hosted' }, true)).toEqual({
        voice: false,
        voiceBackend: 'self-hosted',
        voiceCloud: true,
        voiceSpeech: false,
    });
    expect(
        setup({
            VOICE_BACKEND: 'self-hosted',
            VOICE_TRANSCRIBE_URL: 'https://voice.lab',
            VOICE_SPEECH_URL: 'https://voice.lab',
        }),
    ).toEqual({
        voice: true,
        voiceBackend: 'self-hosted',
        voiceCloud: false,
        voiceSpeech: true,
    });
});

it('speaks a reply without markdown, code or links, cut at a sentence', () => {
    expect(
        spokenText(
            '## Plan\n\n- **First**, read [the doc](https://x.y/z).\n- Then run `pnpm test`:\n\n```sh\nrm -rf /\n```\nSee https://example.com too.',
        ),
    ).toBe('Plan First, read the doc. Then run pnpm test: (code in the chat) See (link in the chat) too.');
    const long = 'This is one sentence. '.repeat(100);
    const spoken = spokenText(long, 200);
    expect(spoken.length).toBeLessThan(240);
    expect(spoken).toMatch(/sentence\. The rest is in the chat\.$/);
    const pieces = speechPieces('First one. Second one is here. Third! And a fourth?', 25);
    expect(pieces[0]).toBe('First one.');
    expect(pieces.join(' ')).toBe('First one. Second one is here. Third! And a fourth?');
    expect(speechPieces('x'.repeat(1000), 100).every((p) => p.length <= 200)).toBe(true);
});

it('never follows a redirect with the key, and refuses non-audio answers', async () => {
    const provider = speechProvider(
        voiceCallsFromEnv({
            VOICE_SPEECH_URL: 'https://voice-agent.lab',
            VOICE_SPEECH_API_KEY: KEY,
        }).speech,
        {},
    );
    const drain = async (transport: typeof fetch) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of synthesize(provider, 'Hello.', new AbortController().signal, transport)) {
            chunks.push(chunk);
        }
        return chunks;
    };
    const redirect = vi.fn<typeof fetch>(
        async () =>
            new Response(null, {
                status: 302,
                headers: { location: 'https://elsewhere.example/' },
            }),
    );
    await expect(drain(redirect)).rejects.toThrow(SpeechError);
    expect(redirect).toHaveBeenCalledTimes(1);
    const [url, init] = redirect.mock.calls[0];
    expect(url).toBe('https://voice-agent.lab/v1/audio/speech');
    expect(init?.redirect).toBe('manual');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    await expect(drain(async () => Response.json({ error: 'no' }))).rejects.toThrow(/not audio/);
    const audio = await drain(
        async () =>
            new Response(new Uint8Array([1, 2, 3, 4]), {
                headers: { 'Content-Type': 'audio/pcm' },
            }),
    );
    expect(Buffer.concat(audio)).toEqual(Buffer.from([1, 2, 3, 4]));
});
