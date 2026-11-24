import { describe, expect, it } from 'vitest';

import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { AbortedError, NetworkError } from '../../src/net/errors';
import { createPublicFetch } from '../../src/net/public-fetch';

import { answer, deferred, fakeFetch, httpDate, ORIGIN, sentHeaders, sessionSetCookie, T0 } from './helpers';

// publicFetch: the address probe and
// logos, with no cookies, no Origin, and redirects handed back.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const PROBE = `${ORIGIN}/api/auth/session`;

describe('publicFetch', () => {
    it('never sends a Cookie or an Origin, and hands a redirect back as it came', async () => {
        const fetch = fakeFetch(() =>
            answer(302, { headers: { location: 'https://brain.example.test/api/auth/session' } }),
        );
        const request = createPublicFetch({ fetch, userAgent: USER_AGENT });
        const response = await request('https://Brain.Example.Test:443/api/auth/session', {
            headers: { Accept: 'application/json' },
        });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://brain.example.test/api/auth/session');
        expect(fetch.calls).toEqual([
            {
                url: PROBE,
                init: {
                    method: 'GET',
                    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                    credentials: 'omit',
                    redirect: 'manual',
                    signal: undefined,
                },
            },
        ]);
        const headers = sentHeaders(fetch.calls[0]);
        expect(headers).not.toHaveProperty('cookie');
        expect(headers).not.toHaveProperty('origin');
    });

    it('refuses a Cookie or Origin from its caller, and URLs it won’t send to, before sending', async () => {
        const fetch = fakeFetch();
        const request = createPublicFetch({ fetch, userAgent: USER_AGENT });
        for (const name of ['Cookie', 'cookie', 'Origin', 'User-Agent']) {
            await expect(request(PROBE, { headers: { [name]: 'x' } }), name).rejects.toThrow(TypeError);
        }
        for (const url of [
            '/api/auth/session',
            'ftp://brain.example.test/',
            'https://ada:secret@brain.example.test/',
        ]) {
            await expect(request(url), url).rejects.toThrow(TypeError);
        }
        expect(fetch.calls).toEqual([]);
    });

    it('leaves the workspace’s jar alone, whatever Set-Cookie its answer carries', async () => {
        const store = memoryJarStore();
        const jar = await openCookieJar({ origin: ORIGIN, store, now: () => T0 });
        await jar.apply(new URL(PROBE), [sessionSetCookie('t1')], httpDate(T0));
        const stored = store.value;
        const request = createPublicFetch({
            fetch: fakeFetch(() =>
                answer(200, { setCookie: [sessionSetCookie('planted')], body: { provider: 'betterauth' } }),
            ),
            userAgent: USER_AGENT,
        });
        expect((await request(PROBE)).status).toBe(200);
        expect(jar.session()?.value).toBe('t1');
        expect(store.value).toBe(stored);
    });

    it('reports no answer as a NetworkError, and a stop as an AbortedError', async () => {
        const offline = createPublicFetch({
            fetch: fakeFetch(async () => {
                throw new Error('fetch failed: Unable to resolve host "brain.example.test"');
            }),
            userAgent: USER_AGENT,
        });
        await expect(offline(PROBE)).rejects.toBeInstanceOf(NetworkError);

        const started = deferred();
        const request = createPublicFetch({
            fetch: fakeFetch(
                (_url, init) =>
                    new Promise<Response>((_resolve, reject) => {
                        started.resolve();
                        init.signal?.addEventListener('abort', () =>
                            reject(new Error('fetch failed: Fetch request has been canceled')),
                        );
                    }),
            ),
            userAgent: USER_AGENT,
        });
        const controller = new AbortController();
        const pending = request(PROBE, { signal: controller.signal });
        await started.promise;
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(AbortedError);
        await expect(request(PROBE, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    });
});
