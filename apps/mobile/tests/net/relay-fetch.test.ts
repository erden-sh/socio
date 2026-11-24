import { describe, expect, it } from 'vitest';

import { AbortedError, NetworkError, OutsideOriginError, RedirectRefusedError } from '../../src/net/errors';
import { createRelayFetch } from '../../src/net/relay-fetch';

import { answer, fakeFetch, sentHeaders } from './helpers';

// relayFetch: the build's relay origin and nothing else,
// no cookies, no Origin, no redirects, no store, the app's User-Agent.

const RELAY = 'https://relay.example.test';
const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';

describe('relayFetch', () => {
    it('sends JSON to the relay with no credentials, no Origin and no redirects', async () => {
        const fetch = fakeFetch(() => answer(204));
        const relay = createRelayFetch({ fetch, userAgent: USER_AGENT, origin: RELAY });
        const response = await relay('/v1/registrations/abc', { method: 'PUT', json: { secret: 's' } });
        expect(response.status).toBe(204);
        expect(fetch.calls).toEqual([
            {
                url: `${RELAY}/v1/registrations/abc`,
                init: {
                    method: 'PUT',
                    headers: {
                        'content-type': 'application/json',
                        'user-agent': USER_AGENT,
                        'cache-control': 'no-store',
                    },
                    body: '{"secret":"s"}',
                    credentials: 'omit',
                    redirect: 'error',
                    // Its own, for the time limit.
                    signal: expect.any(AbortSignal),
                },
            },
        ]);
        const headers = sentHeaders(fetch.calls[0]);
        expect(headers).not.toHaveProperty('cookie');
        expect(headers).not.toHaveProperty('origin');
    });

    it('refuses anything that leaves the relay before sending', async () => {
        const fetch = fakeFetch();
        const relay = createRelayFetch({ fetch, userAgent: USER_AGENT, origin: RELAY });
        for (const path of ['https://evil.example.test/v1', '//evil.example.test/v1', 'v1/registrations']) {
            await expect(relay(path, { method: 'POST', json: {} })).rejects.toBeInstanceOf(OutsideOriginError);
        }
        expect(fetch.calls).toEqual([]);
        expect(() => createRelayFetch({ fetch, userAgent: USER_AGENT, origin: `${RELAY}/v1` })).toThrow(TypeError);
    });

    it('turns failures into the app’s errors', async () => {
        const offline = createRelayFetch({
            fetch: fakeFetch(() => Promise.reject(new TypeError('Network request failed'))),
            userAgent: USER_AGENT,
            origin: RELAY,
        });
        await expect(offline('/v1/registrations', { method: 'POST', json: {} })).rejects.toBeInstanceOf(NetworkError);
        const redirected = createRelayFetch({
            fetch: fakeFetch(() => Promise.reject(new TypeError('unexpected redirect'))),
            userAgent: USER_AGENT,
            origin: RELAY,
        });
        await expect(redirected('/v1/registrations', { method: 'POST', json: {} })).rejects.toBeInstanceOf(
            RedirectRefusedError,
        );
        const controller = new AbortController();
        controller.abort();
        await expect(
            offline('/v1/registrations', { method: 'POST', json: {}, signal: controller.signal }),
        ).rejects.toBeInstanceOf(AbortedError);
    });

    it('gives up on a relay that never answers, or never finishes its body', async () => {
        // OkHttp on Android has no time limit of its own: a stalled connection must not hold push, or a wipe.
        const seen: (AbortSignal | null | undefined)[] = [];
        const silent = createRelayFetch({
            // Never settles, and doesn't heed its signal either.
            fetch: fakeFetch((_, init) => {
                seen.push(init.signal);
                return new Promise<Response>(() => {});
            }),
            userAgent: USER_AGENT,
            origin: RELAY,
            timeoutMs: 20,
        });
        await expect(silent('/v1/registrations', { method: 'POST', json: {} })).rejects.toBeInstanceOf(NetworkError);
        expect(seen[0]?.aborted).toBe(true);

        const stalled = createRelayFetch({
            fetch: fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 201 })),
            userAgent: USER_AGENT,
            origin: RELAY,
            timeoutMs: 20,
        });
        await expect(stalled('/v1/registrations', { method: 'POST', json: {} })).rejects.toBeInstanceOf(NetworkError);

        // The caller's own abort is still an AbortedError.
        const controller = new AbortController();
        const pending = silent('/v1/registrations', { method: 'POST', json: {}, signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(AbortedError);
    });

    it('hands back the answer with its body read', async () => {
        const relay = createRelayFetch({
            fetch: fakeFetch(() => answer(201, { body: { endpoint: 'e' } })),
            userAgent: USER_AGENT,
            origin: RELAY,
        });
        const response = await relay('/v1/registrations', { method: 'POST', json: {} });
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({ endpoint: 'e' });
    });
});
