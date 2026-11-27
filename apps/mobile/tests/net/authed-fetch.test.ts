import { describe, expect, it } from 'vitest';

import { createAuthedFetch } from '../../src/net/authed-fetch';
import { type CookieJar, type JarStore, memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { AbortedError, NetworkError, OutsideOriginError, RedirectRefusedError } from '../../src/net/errors';
import type { FetchFunction } from '../../src/net/fetch-function';
import { serverAway } from '../../src/net/reconnect';
import type { SessionEnd } from '../../src/net/session';

import {
    answer,
    DAY,
    deferred,
    fakeFetch,
    httpDate,
    MINUTE,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    settle,
    T0,
} from './helpers';

// authedFetch against a fake fetch: only the
// workspace's origin, its headers, Set-Cookie on every status, the 401
// classifier, redirects refused, and the scope's signal.

const USER_AGENT = 'Socio/0.1.0 (iPhone; iOS 26)';

async function setup(
    respond: Parameters<typeof fakeFetch>[0] = () => answer(200, { date: httpDate(T0) }),
    store: JarStore = memoryJarStore(),
) {
    const clock = { now: T0 };
    const jar = await openCookieJar({ origin: ORIGIN, store, now: () => clock.now });
    await jar.apply(new URL(`${ORIGIN}/api/auth/sign-in/email`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
    const scope = new AbortController();
    const fetch = fakeFetch(respond);
    const ends: Array<{ end: SessionEnd; session: string | undefined }> = [];
    const request = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: USER_AGENT,
        signal: scope.signal,
        onUnauthorized: (end) => {
            ends.push({ end, session: jar.session()?.value });
        },
    });
    return { clock, jar, scope, fetch, request, ends };
}

const sessionOf = (jar: CookieJar) => jar.session()?.value;

describe('authedFetch', () => {
    it('refuses any URL off the workspace’s origin before sending anything', async () => {
        const { fetch, request } = await setup();
        for (const url of [
            'https://evil.example.test/api/state',
            'http://brain.example.test/api/state',
            'https://brain.example.test:8443/api/state',
            'https://brain.example.test.evil.example.test/api/state',
            '//evil.example.test/api/state',
            '/\\evil.example.test/api/state',
            'https://ada:secret@brain.example.test/api/state',
            'javascript:alert(1)',
            'http://[::1',
        ]) {
            await expect(request(url), url).rejects.toBeInstanceOf(OutsideOriginError);
        }
        expect(fetch.calls).toEqual([]);
    });

    it('sends a path or a URL on the origin, with its headers, no credentials of the system’s and no redirects', async () => {
        const { fetch, request, scope } = await setup();
        await request('/api/state', { headers: { 'If-None-Match': 'W/"abc"' } });
        await request(`${ORIGIN}/api/workspace?x=1`);
        await request('api/state');
        expect(fetch.calls.map((call) => call.url)).toEqual([
            `${ORIGIN}/api/state`,
            `${ORIGIN}/api/workspace?x=1`,
            `${ORIGIN}/api/state`,
        ]);
        const [get] = fetch.calls;
        expect(get?.init).toEqual({
            method: 'GET',
            headers: {
                accept: 'application/json',
                'if-none-match': 'W/"abc"',
                origin: ORIGIN,
                cookie: `${SESSION}=t1.c2ln%3D`,
                'user-agent': USER_AGENT,
            },
            body: undefined,
            credentials: 'omit',
            redirect: 'error',
            signal: scope.signal,
        });
    });

    it('sends writes as JSON, with Origin, as the edge and Better Auth require', async () => {
        const { fetch, request } = await setup();
        await request('/api/auth/update-user', { method: 'post', json: { name: 'Ada' } });
        const [post] = fetch.calls;
        expect(post?.init.method).toBe('POST');
        expect(post?.init.body).toBe('{"name":"Ada"}');
        expect(sentHeaders(post)).toMatchObject({
            origin: ORIGIN,
            'content-type': 'application/json',
            cookie: `${SESSION}=t1.c2ln%3D`,
        });
        // A caller may ask for something other than JSON back.
        await request('/favicon.png', { headers: { Accept: 'image/*' } });
        expect(sentHeaders(fetch.calls[1]).accept).toBe('image/*');
    });

    it('sends JSON text as it is, as JSON, never beside JSON or on a GET', async () => {
        const { fetch, request } = await setup();
        const text = '{"name":"a.png","data":"aGVsbG8="}';
        await request('/api/issues/41/attachments', { method: 'POST', jsonText: text });
        expect(fetch.calls[0]?.init.body).toBe(text);
        expect(sentHeaders(fetch.calls[0])['content-type']).toBe('application/json');
        await expect(request('/api/state', { jsonText: '{}' })).rejects.toThrow(TypeError);
        await expect(request('/api/issues', { method: 'POST', json: {}, jsonText: '{}' })).rejects.toThrow(TypeError);
        expect(fetch.calls).toHaveLength(1);
    });

    it('lets no caller set its own Cookie, Origin, User-Agent or Content-Type, nor a body on a GET', async () => {
        const { fetch, request } = await setup();
        for (const name of ['Cookie', 'origin', 'User-Agent', 'Content-Type']) {
            await expect(request('/api/state', { headers: { [name]: 'x' } }), name).rejects.toThrow(TypeError);
        }
        await expect(request('/api/state', { json: {} })).rejects.toThrow(TypeError);
        expect(fetch.calls).toEqual([]);
    });

    it('sends no Cookie header when the jar has nothing for the request', async () => {
        const { fetch, request, clock } = await setup();
        clock.now = T0 + 8 * DAY;
        await request('/api/state');
        expect(sentHeaders(fetch.calls[0])).not.toHaveProperty('cookie');
    });

    it.each([200, 304, 401, 500])(
        'applies Set-Cookie on a %i, and stores the jar before the answer comes back',
        async (status) => {
            const store = memoryJarStore();
            let gate: Promise<void> = Promise.resolve();
            const gated: JarStore = {
                read: store.read,
                write: async (value) => {
                    await gate;
                    await store.write(value);
                },
            };
            const { jar, request } = await setup(
                () =>
                    answer(status, {
                        date: httpDate(T0 + DAY),
                        setCookie: [sessionSetCookie('t2'), 'theme=dark; Path=/'],
                    }),
                gated,
            );
            const held = deferred();
            gate = held.promise;
            let answered = false;
            const pending = request('/api/state').then((response) => {
                answered = true;
                return response;
            });
            await settle();
            expect(answered).toBe(false);
            expect(store.value).not.toContain('t2');
            held.resolve();
            expect((await pending).status).toBe(status);
            expect(store.value).toContain('t2');
            expect(sessionOf(jar)).toBe('t2');
            expect(jar.session()?.expiresAt).toBe(T0 + 8 * DAY);
            expect(jar.cookies().map((cookie) => cookie.name)).toEqual([SESSION, 'theme']);
        },
    );

    it('classifies a 401 against the expiry stored before its own clearing cookie applies', async () => {
        const clearing = (date: number) => () =>
            answer(401, {
                date: httpDate(date),
                setCookie: [sessionSetCookie('', 0)],
                body: { error: 'Sign in to continue.', code: 'sign_in' },
            });
        const ended = await setup(clearing(T0 + 3 * DAY));
        expect((await ended.request('/api/state')).status).toBe(401);
        // The callback saw the session still in the jar, then the clearing cookie emptied it.
        expect(ended.ends).toEqual([{ end: 'ended', session: 't1.c2ln%3D' }]);
        expect(ended.jar.session()).toBeNull();

        const expired = await setup(clearing(T0 + 7 * DAY + MINUTE));
        await expired.request('/api/state');
        expect(expired.ends).toEqual([{ end: 'expired', session: 't1.c2ln%3D' }]);

        // With no Date header, the device clock and the stored offset say when.
        const undated = await setup(() => answer(401));
        undated.clock.now = T0 + 7 * DAY + MINUTE;
        await undated.request('/api/state');
        expect(undated.ends.map(({ end }) => end)).toEqual(['expired']);
    });

    it('classifies a 401 by the cookie its request carried, not by the jar when it comes', async () => {
        const held = deferred();
        const { jar, request, ends, fetch } = await setup(async (_url, init) => {
            if (fetch.calls.length === 1) {
                await held.promise;
            }
            return answer(401, {
                date: httpDate(T0 + 7 * DAY + MINUTE),
                setCookie: sentHeaders({ url: '', init }).cookie === undefined ? [] : [sessionSetCookie('', 0)],
            });
        });
        // The first request carries the cookie; the second goes after the server's clearing cookie removed it.
        const first = request('/api/state');
        await settle();
        await jar.apply(new URL(`${ORIGIN}/api/state`), [sessionSetCookie('', 0)], httpDate(T0 + 7 * DAY));
        expect(jar.session()).toBeNull();
        expect(jar.sessionExpiresAt()).toBe(T0 + 7 * DAY);
        await request('/api/state');
        held.resolve();
        await first;
        expect(ends.map(({ end }) => end)).toEqual(['expired', 'expired']);
    });

    it('sends a write once more, body and all, when the jar kept back a cookie the 401’s Date shows live', async () => {
        const answers = [
            answer(401, { date: httpDate(T0 + 60 * MINUTE), body: { error: 'Sign in to continue.', code: 'sign_in' } }),
            answer(200, { date: httpDate(T0 + 60 * MINUTE), body: { status: true } }),
        ];
        const { clock, request, ends, fetch } = await setup(() => answers.shift() ?? answer(500));
        // The device clock set 8 days ahead since the offset was measured.
        clock.now = T0 + 8 * DAY;
        const response = await request('/api/auth/update-user', { method: 'POST', json: { name: 'Bob' } });
        expect(response.status).toBe(200);
        expect(ends).toEqual([]);
        expect(fetch.calls.map((call) => [call.init.method, call.init.body, sentHeaders(call).cookie])).toEqual([
            ['POST', '{"name":"Bob"}', undefined],
            ['POST', '{"name":"Bob"}', `${SESSION}=t1.c2ln%3D`],
        ]);
    });

    it('tells onAnswer each answer with what its request carried, once its Set-Cookie applied', async () => {
        const clock = { now: T0 };
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => clock.now });
        await jar.apply(new URL(`${ORIGIN}/api/state`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
        const answers = [
            answer(304, { date: httpDate(T0 + DAY), setCookie: [sessionSetCookie('t1.c2ln%3D')] }),
            // The device clock 8 days ahead: the jar keeps the cookie back, and the 401's Date shows it live.
            answer(401, { date: httpDate(T0 + DAY), body: { error: 'Sign in to continue.', code: 'sign_in' } }),
            answer(200, { date: httpDate(T0 + DAY), body: {} }),
        ];
        const seen: Array<{ path: string; status: number; cookie: string | null; expiresAt: number | null }> = [];
        const request = createAuthedFetch({
            origin: ORIGIN,
            jar,
            fetch: fakeFetch(() => answers.shift() ?? answer(500)),
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
            onAnswer: ({ url, status, sent }) => {
                seen.push({ path: url.pathname, status, cookie: sent.cookie, expiresAt: jar.sessionExpiresAt() });
            },
        });
        await request('/api/state', { headers: { 'If-None-Match': 'W/"a.b"' } });
        clock.now = T0 + 9 * DAY;
        await request('/api/workspace');
        expect(seen).toEqual([
            // The slide applied before the callback.
            { path: '/api/state', status: 304, cookie: `${SESSION}=t1.c2ln%3D`, expiresAt: T0 + 8 * DAY },
            // Only the answer to the request sent again, with the cookie.
            { path: '/api/workspace', status: 200, cookie: `${SESSION}=t1.c2ln%3D`, expiresAt: T0 + 8 * DAY },
        ]);
    });

    it('sends an anonymous request with no cookie or install id, and lets its answer change nothing (CB-553)', async () => {
        const clock = { now: T0 };
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => clock.now });
        await jar.apply(new URL(`${ORIGIN}/api/state`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
        const answers = [
            answer(200, { date: httpDate(T0 + DAY), setCookie: [sessionSetCookie('other', 0)], body: {} }),
            answer(401, { date: httpDate(T0 + DAY), body: { code: 'session_ended' } }),
        ];
        const fetch = fakeFetch(() => answers.shift() ?? answer(500));
        const seen: Array<string | null> = [];
        const ends: SessionEnd[] = [];
        const request = createAuthedFetch({
            origin: ORIGIN,
            jar,
            fetch,
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
            installId: 'a'.repeat(43),
            onUnauthorized: (end) => {
                ends.push(end);
            },
            onAnswer: ({ sent }) => {
                seen.push(sent.cookie);
            },
        });
        await request('/api/client/compat', { anonymous: true });
        await request('/api/client/compat', { anonymous: true });
        for (const call of fetch.calls) {
            expect(sentHeaders(call).cookie ?? null).toBeNull();
            expect(sentHeaders(call)['x-socio-install'] ?? null).toBeNull();
            expect(sentHeaders(call)['user-agent']).toBe(USER_AGENT);
        }
        // Reported as carrying nothing, the jar and the session untouched, and no session end.
        expect(seen).toEqual([null, null]);
        expect(sessionOf(jar)).toBe('t1.c2ln%3D');
        expect(ends).toEqual([]);
    });

    it('still applies the 401’s Set-Cookie when the callback throws', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(new URL(`${ORIGIN}/api/state`), [sessionSetCookie('t1')], httpDate(T0));
        const request = createAuthedFetch({
            origin: ORIGIN,
            jar,
            fetch: fakeFetch(() => answer(401, { setCookie: [sessionSetCookie('', 0)] })),
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
            onUnauthorized: () => {
                throw new Error('registry unavailable');
            },
        });
        await expect(request('/api/state')).rejects.toThrow('registry unavailable');
        expect(jar.session()).toBeNull();
    });

    it('turns a redirect into its own error, whichever way the fetch reports it', async () => {
        const failures: FetchFunction[] = [
            // expo/fetch, both platforms: FetchRedirectException, wrapped in a FetchError.
            async () => {
                throw new Error("fetch failed: Redirect is not allowed when redirect mode is 'error'");
            },
            // Node's fetch.
            async () => {
                throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
            },
        ];
        for (const fetch of failures) {
            const { jar } = await setup();
            const request = createAuthedFetch({
                origin: ORIGIN,
                jar,
                fetch,
                userAgent: USER_AGENT,
                signal: new AbortController().signal,
            });
            const error = await request('/api/state').catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(RedirectRefusedError);
            expect(serverAway(error)).toBe(false);
        }

        // A 3xx handed back anyway: refused, though its cookies were the workspace's own.
        const handed = await setup(() =>
            answer(302, { headers: { location: '/sign-in' }, setCookie: ['seen=1; Path=/'], date: httpDate(T0) }),
        );
        await expect(handed.request('/api/state')).rejects.toBeInstanceOf(RedirectRefusedError);
        expect(handed.jar.cookies().map((cookie) => cookie.name)).toContain('seen');

        // A redirect followed anyway: refused, and the other origin's cookies never reach the jar.
        const followed = await setup(() => {
            const response = answer(200, { setCookie: [sessionSetCookie('planted')], date: httpDate(T0) });
            Object.defineProperty(response, 'url', { value: 'https://evil.example.test/api/state' });
            Object.defineProperty(response, 'redirected', { value: true });
            return response;
        });
        await expect(followed.request('/api/state')).rejects.toBeInstanceOf(RedirectRefusedError);
        expect(sessionOf(followed.jar)).toBe('t1.c2ln%3D');
    });

    it('reports no answer as a NetworkError, which counts as the server being away', async () => {
        const { request } = await setup(async () => {
            throw new Error('fetch failed: The Internet connection appears to be offline.');
        });
        const error = await request('/api/state').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).cause).toBeInstanceOf(Error);
        expect(serverAway(error)).toBe(true);
    });

    it('stops what is in flight when the scope is disposed, and sends nothing after', async () => {
        const started = deferred();
        const { fetch, request, scope } = await setup(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    started.resolve();
                    // expo/fetch cancels the native request and rejects with a plain FetchError.
                    init.signal?.addEventListener('abort', () =>
                        reject(new Error('fetch failed: Fetch request has been canceled')),
                    );
                }),
        );
        const pending = request('/api/state').catch((caught: unknown) => caught);
        await started.promise;
        scope.abort();
        const error = await pending;
        expect(error).toBeInstanceOf(AbortedError);
        expect((error as AbortedError).name).toBe('AbortError');
        expect(serverAway(error)).toBe(false);

        await expect(request('/api/state')).rejects.toBeInstanceOf(AbortedError);
        expect(fetch.calls).toHaveLength(1);
    });

    it('stops one request with its own signal, leaving the scope and its other requests alone', async () => {
        const started = deferred();
        const { fetch, request } = await setup(
            (_url, init) =>
                new Promise<Response>((resolve, reject) => {
                    started.resolve();
                    if (init.signal?.aborted) {
                        reject(new Error('fetch failed: Fetch request has been canceled'));
                        return;
                    }
                    init.signal?.addEventListener('abort', () =>
                        reject(new Error('fetch failed: Fetch request has been canceled')),
                    );
                    setTimeout(() => resolve(answer(200, { date: httpDate(T0) })), 5);
                }),
        );
        const own = new AbortController();
        const pending = request('/api/test', { method: 'POST', json: {}, signal: own.signal }).catch(
            (caught: unknown) => caught,
        );
        await started.promise;
        own.abort();
        expect(await pending).toBeInstanceOf(AbortedError);
        expect((await request('/api/state')).status).toBe(200);
        await expect(request('/api/state', { signal: own.signal })).rejects.toBeInstanceOf(AbortedError);
        expect(fetch.calls).toHaveLength(2);
    });

    it('lets an answer that comes after the scope closed change nothing, the jar included', async () => {
        const held = deferred<Response>();
        const store = memoryJarStore();
        const { jar, request, scope } = await setup(() => held.promise, store);
        const before = store.value;
        const pending = request('/api/state').catch((caught: unknown) => caught);
        await settle();
        scope.abort();
        await jar.close();
        held.resolve(answer(200, { setCookie: [sessionSetCookie('late')], date: httpDate(T0 + DAY) }));
        expect(await pending).toBeInstanceOf(AbortedError);
        expect(sessionOf(jar)).toBe('t1.c2ln%3D');
        expect(store.value).toBe(before);
    });

    it('takes only its own origin’s jar', async () => {
        const jar = await openCookieJar({ origin: 'https://other.example.test', store: memoryJarStore() });
        expect(() =>
            createAuthedFetch({
                origin: ORIGIN,
                jar,
                fetch: fakeFetch(),
                userAgent: USER_AGENT,
                signal: new AbortController().signal,
            }),
        ).toThrow(TypeError);
    });
});
