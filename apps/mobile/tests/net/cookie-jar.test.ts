import { describe, expect, it } from 'vitest';

import { createAuthedFetch } from '../../src/net/authed-fetch';
import { type CookieJar, type JarStore, memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { setCookieHeaders } from '../../src/net/fetch-function';
import { type SessionEnd, sessionCookieName } from '../../src/net/session';
import { splitSetCookie } from '../../src/net/set-cookie';

import {
    answer,
    betterAuthServer,
    clocks,
    cookieValue,
    DAY,
    deferred,
    fakeFetch,
    httpDate,
    LOCAL_ORIGIN,
    MINUTE,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    settle,
    T0,
} from './helpers';

// The cookie jar, with injected
// clocks: the session slides with daily use, a 401's clearing cookie empties
// it, iOS's joined Set-Cookie reads as separate cookies, the __Host- rules hold,
// and expiry follows the server's clock when the device's is off.

const STATE = new URL(`${ORIGIN}/api/state`);
const SIGN_IN = new URL(`${ORIGIN}/api/auth/sign-in/email`);

/**
 * A workspace on a Better Auth server: its jar, its authedFetch and what each
 * 401 meant. `hold` may hold the server's handling of the nth call (from 0).
 */
async function workspace(
    clock: ReturnType<typeof clocks>,
    store: JarStore = memoryJarStore(),
    hold: (call: number) => Promise<void> | undefined = () => undefined,
) {
    const server = betterAuthServer(clock);
    const jar = await openCookieJar({ origin: ORIGIN, store, now: clock.device });
    const ends: SessionEnd[] = [];
    let calls = 0;
    const fetch = fakeFetch(async (url, init) => {
        await hold(calls++);
        return server.handle(url, init);
    });
    const request = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: 'Socio/0.1.0 (iPhone; iOS 26)',
        signal: new AbortController().signal,
        onUnauthorized: (end) => {
            ends.push(end);
        },
    });
    return { server, jar, ends, fetch, request };
}

describe('the cookie jar', () => {
    it('stays signed in through daily use on days 1 to 8, as the session slides', async () => {
        const clock = clocks();
        const { server, jar, request, ends } = await workspace(clock);
        expect((await request('/api/auth/sign-in/email', { method: 'POST', json: {} })).status).toBe(200);
        for (let day = 1; day <= 8; day++) {
            clock.server = T0 + day * DAY + 5 * MINUTE;
            const response = await request('/api/state');
            expect(response.status, `day ${day}`).toBe(200);
            // The slide landed: the jar's expiry is the server's, a week from today.
            expect(jar.session()?.expiresAt, `day ${day}`).toBe(server.session?.expiresAt);
            expect(jar.session()?.expiresAt).toBe(clock.server + 7 * DAY);
        }
        expect(ends).toEqual([]);
    });

    it('expires after a week without use: the cookie stops going, and the 401 means expired', async () => {
        const clock = clocks();
        const { jar, request, ends } = await workspace(clock);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        clock.server = T0 + 7 * DAY + MINUTE;
        expect(jar.cookieHeader(STATE)).toBeNull();
        expect((await request('/api/state')).status).toBe(401);
        expect(ends).toEqual(['expired']);
    });

    it('keeps the session’s expiry when update-user sets the cookie again without sliding it', async () => {
        const clock = clocks();
        const { server, jar, request, ends } = await workspace(clock);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        // A name change 20 hours in: the server answers Max-Age=604800, but its session still ends at T0 + 7 days.
        clock.server = T0 + 20 * 60 * MINUTE;
        expect((await request('/api/auth/update-user', { method: 'POST', json: { name: 'Bob' } })).status).toBe(200);
        expect(server.session?.expiresAt).toBe(T0 + 7 * DAY);
        expect(jar.session()?.expiresAt).toBe(T0 + 7 * DAY);
        // The same name again (a no-op update-user) changes nothing either.
        clock.server += MINUTE;
        await request('/api/auth/update-user', { method: 'POST', json: { name: 'Bob' } });
        expect(jar.session()?.expiresAt).toBe(T0 + 7 * DAY);

        // Idle past the server's expiry: a 401 there is Expired, which stays readable, never Ended.
        clock.server = T0 + 7 * DAY + 2 * 60 * MINUTE;
        expect((await request('/api/state')).status).toBe(401);
        expect(ends).toEqual(['expired']);
    });

    it('takes a slide, a new token, a move earlier and a delete as they come', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        // A day later or more is a slide, a second short of it too: Date headers are whole seconds.
        await jar.apply(STATE, [sessionSetCookie('t1')], httpDate(T0 + DAY - 1000));
        expect(jar.session()?.expiresAt).toBe(T0 + 8 * DAY - 1000);
        await jar.apply(STATE, [sessionSetCookie('t1')], httpDate(T0 + DAY));
        expect(jar.session()?.expiresAt).toBe(T0 + 8 * DAY - 1000);
        await jar.apply(STATE, [sessionSetCookie('t1')], httpDate(T0 + 2 * DAY - 1000));
        expect(jar.session()?.expiresAt).toBe(T0 + 9 * DAY - 1000);
        // Less than a day later, for the same token, is a cookie set again: the expiry stays.
        await jar.apply(STATE, [sessionSetCookie('t1')], httpDate(T0 + 3 * DAY - 2 * MINUTE));
        expect(jar.session()?.expiresAt).toBe(T0 + 9 * DAY - 1000);
        expect(jar.sessionExpiresAt()).toBe(T0 + 9 * DAY - 1000);
        // A new token is a new session, whenever it comes.
        await jar.apply(SIGN_IN, [sessionSetCookie('t2')], httpDate(T0 + DAY + MINUTE));
        expect(jar.session()).toMatchObject({ value: 't2', expiresAt: T0 + 8 * DAY + MINUTE });
        // An earlier expiry for the same token is the server's word.
        await jar.apply(STATE, [sessionSetCookie('t2', 3600)], httpDate(T0 + DAY + 2 * MINUTE));
        expect(jar.session()?.expiresAt).toBe(T0 + DAY + 62 * MINUTE);
        await jar.apply(STATE, [sessionSetCookie('', 0)], httpDate(T0 + DAY + 3 * MINUTE));
        expect(jar.session()).toBeNull();
        // The delete leaves the session's last known expiry, for the 401s still to come.
        expect(jar.sessionExpiresAt()).toBe(T0 + DAY + 62 * MINUTE);
        // Other cookies aren't sessions: they take every Max-Age.
        await jar.apply(STATE, ['theme=dark; Max-Age=60; Path=/'], httpDate(T0));
        await jar.apply(STATE, ['theme=dark; Max-Age=120; Path=/'], httpDate(T0));
        expect(jar.cookies().find((cookie) => cookie.name === 'theme')?.expiresAt).toBe(T0 + 120_000);
    });

    it('is emptied by a 401 with a clearing cookie, which means ended before the expiry', async () => {
        const clock = clocks();
        const store = memoryJarStore();
        const { server, jar, request, ends } = await workspace(clock, store);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        clock.server = T0 + 3 * DAY;
        server.end();
        const response = await request('/api/state');
        expect(response.status).toBe(401);
        expect(ends).toEqual(['ended']);
        expect(jar.cookies()).toEqual([]);
        expect(jar.cookieHeader(STATE)).toBeNull();
        // And stored so: a jar opened again from the store is empty too.
        const reopened = await openCookieJar({ origin: ORIGIN, store, now: clock.device });
        expect(reopened.cookies()).toEqual([]);
    });

    it("reads iOS's joined Set-Cookie as separate cookies, Expires commas and all", async () => {
        const clock = clocks();
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: clock.device });
        const signIn = answer(200, {
            joined: true,
            date: httpDate(T0),
            setCookie: [
                sessionSetCookie('t1.c2ln%3D'),
                '__Host-cb.dont_remember=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure',
                'theme=dark; Expires=Thursday, 03-Dec-26 09:00:00 GMT; Path=/',
            ],
        });
        expect(signIn.headers.get('set-cookie')).toContain(
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure, theme=dark',
        );
        await jar.apply(SIGN_IN, setCookieHeaders(signIn.headers), signIn.headers.get('date'));
        expect(jar.cookieHeader(STATE)).toBe(`${SESSION}=t1.c2ln%3D; theme=dark`);
        expect(jar.session()?.expiresAt).toBe(T0 + 7 * DAY);

        // Logout's three clearing cookies, joined.
        const logout = [SESSION, '__Host-cb.session_data', '__Host-cb.dont_remember']
            .map((name) => `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`)
            .join(', ');
        await jar.apply(new URL(`${ORIGIN}/api/auth/logout`), splitSetCookie(logout), httpDate(T0));
        expect(jar.cookieHeader(STATE)).toBe('theme=dark');
        expect(jar.session()).toBeNull();
    });

    it('holds __Host- cookies to their rules: https, Secure, Path=/, no Domain', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(
            SIGN_IN,
            [
                sessionSetCookie('good'),
                '__Host-no-secure=1; Path=/',
                '__Host-no-path=1; Secure',
                '__Host-domain=1; Secure; Path=/; Domain=brain.example.test',
                '__Host-sub-path=1; Secure; Path=/api',
            ],
            httpDate(T0),
        );
        expect(jar.cookies().map((cookie) => cookie.name)).toEqual([SESSION]);
        // A clearing cookie without Secure clears nothing.
        await jar.apply(STATE, [`${SESSION}=; Max-Age=0; Path=/`], httpDate(T0));
        expect(jar.session()?.value).toBe('good');

        // Over http (a local server) the name has no prefix, and a __Host- cookie can't be set.
        const local = await openCookieJar({ origin: LOCAL_ORIGIN, store: memoryJarStore(), now: () => T0 });
        expect(local.sessionCookie).toBe('cb.session_token');
        await local.apply(
            new URL(`${LOCAL_ORIGIN}/api/auth/sign-in/email`),
            ['cb.session_token=t1; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict', sessionSetCookie('t2')],
            httpDate(T0),
        );
        expect(local.cookieHeader(new URL(`${LOCAL_ORIGIN}/api/state`))).toBe('cb.session_token=t1');
    });

    it.each([
        ['10 minutes fast', 10 * MINUTE],
        ['10 minutes slow', -10 * MINUTE],
    ])('keeps expiry on the server’s clock with the device clock %s', async (_label, skew) => {
        const clock = clocks(T0, skew);
        const store = memoryJarStore();
        const { server, jar, request, ends } = await workspace(clock, store);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        expect(jar.session()?.expiresAt).toBe(T0 + 7 * DAY);

        // A minute before the server's expiry, the cookie still goes, even after a relaunch.
        clock.server = T0 + 7 * DAY - MINUTE;
        const relaunched = await openCookieJar({ origin: ORIGIN, store, now: clock.device });
        expect(relaunched.cookieHeader(STATE)).toBe(`${SESSION}=${server.session?.token}`);
        expect(relaunched.serverNow()).toBe(clock.server);

        // A minute after, it doesn't.
        clock.server = T0 + 7 * DAY + MINUTE;
        expect(relaunched.cookieHeader(STATE)).toBeNull();

        // A 401 just before the expiry is an ended session, one just after an expired one.
        const before = clocks(T0, skew);
        const early = await workspace(before);
        await early.request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        before.server = T0 + 7 * DAY - MINUTE;
        early.server.end();
        await early.request('/api/state');
        clock.server = T0 + 7 * DAY + MINUTE;
        await request('/api/state');
        expect([...early.ends, ...ends]).toEqual(['ended', 'expired']);
    });

    it('sends the request again when the device clock jumped ahead and the jar kept a live cookie back', async () => {
        const clock = clocks();
        const { server, request, ends, fetch } = await workspace(clock);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        // The date set 8 days ahead by hand, an hour later: the jar's clock says the cookie expired.
        clock.server = T0 + 60 * MINUTE;
        clock.skew = 8 * DAY - 60 * MINUTE;
        const response = await request('/api/state');
        // The server's 401 without a cookie set the offset right, and the same request went again, with it.
        expect(response.status).toBe(200);
        expect(ends).toEqual([]);
        expect(fetch.calls.map((call) => cookieValue(sentHeaders(call).cookie, SESSION))).toEqual([
            undefined,
            undefined,
            server.session?.token,
        ]);
    });

    it('never calls a 401 ended when the jar kept the session cookie back, even if the clock keeps jumping', async () => {
        const clock = clocks();
        const store = memoryJarStore();
        // Each write (the offset, put right by the 401) finds the device clock 8 days ahead again.
        const jumping: JarStore = {
            read: store.read,
            write: async (value) => {
                await store.write(value);
                clock.skew += 8 * DAY;
            },
        };
        const { request, ends, fetch } = await workspace(clock, jumping);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        clock.server = T0 + 60 * MINUTE;
        clock.skew = 8 * DAY;
        expect((await request('/api/state')).status).toBe(401);
        // Sent once more, held back again: the server never saw the cookie, so it can't have ended it.
        expect(fetch.calls).toHaveLength(3);
        expect(ends).toEqual(['expired']);
    });

    it('stays Expired on the next 401s after the clearing cookie, with the device clock behind', async () => {
        const clock = clocks();
        const store = memoryJarStore();
        const { jar, request, ends } = await workspace(clock, store);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        // The device clock an hour behind: the jar still sends the cookie 10 minutes past the server's expiry.
        clock.skew = -60 * MINUTE;
        clock.server = T0 + 7 * DAY + 10 * MINUTE;
        await request('/api/state');
        expect(jar.session()).toBeNull();
        await request('/api/state');
        expect(ends).toEqual(['expired', 'expired']);
        // The session's last expiry is stored, so a relaunch reads it the same way.
        const relaunched = await workspace(clock, store);
        await relaunched.request('/api/state');
        expect(relaunched.ends).toEqual(['expired']);
        // Only clear() forgets it.
        await relaunched.jar.clear();
        await relaunched.request('/api/state');
        expect(relaunched.ends).toEqual(['expired', 'ended']);
    });

    it('classifies concurrent 401s by the cookie each request carried', async () => {
        const clock = clocks();
        // The second and third answers come only after the one before has cleared the cookie.
        const held = [deferred(), deferred()];
        const { request, ends } = await workspace(clock, memoryJarStore(), (call) => held[call - 2]?.promise);
        await request('/api/auth/sign-in/email', { method: 'POST', json: {} });
        clock.skew = -60 * MINUTE;
        clock.server = T0 + 7 * DAY + 10 * MINUTE;
        const answers = [request('/api/state'), request('/api/workspace'), request('/api/notices')];
        await answers[0];
        held[0]?.resolve();
        await answers[1];
        held[1]?.resolve();
        await answers[2];
        expect(ends).toEqual(['expired', 'expired', 'expired']);
    });

    it('judges expiry with the stored offset when an answer has no Date header', async () => {
        const clock = clocks(T0, 10 * MINUTE);
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: clock.device });
        await jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        clock.server = T0 + DAY;
        await jar.apply(STATE, [sessionSetCookie('t1')], null);
        expect(jar.session()?.expiresAt).toBe(T0 + 8 * DAY);
        expect(jar.serverNow()).toBe(T0 + DAY);
        expect(jar.serverNow(httpDate(T0 + 2 * DAY))).toBe(T0 + 2 * DAY);
    });

    it('is written to its store before apply resolves, writes landing in order', async () => {
        const writes: string[] = [];
        const held = deferred();
        const store: JarStore = {
            read: async () => null,
            write: async (value) => {
                await held.promise;
                writes.push(value);
            },
        };
        const jar = await openCookieJar({ origin: ORIGIN, store, now: () => T0 });
        let done = 0;
        const first = jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0)).then(() => (done += 1));
        const second = jar.apply(STATE, ['theme=dark; Path=/'], httpDate(T0)).then(() => (done += 1));
        // The next request already sends the new cookies, though they aren't stored yet.
        expect(jar.cookieHeader(STATE)).toBe(`${SESSION}=t1; theme=dark`);
        await settle();
        expect(done).toBe(0);
        held.resolve();
        await Promise.all([first, second]);
        expect(writes.map((text) => (JSON.parse(text) as { cookies: unknown[] }).cookies.length)).toEqual([1, 2]);
    });

    it('writes nothing for an answer that changes nothing', async () => {
        const store = memoryJarStore();
        let writes = 0;
        const counting: JarStore = {
            read: store.read,
            write: async (value) => {
                writes += 1;
                await store.write(value);
            },
        };
        const jar = await openCookieJar({ origin: ORIGIN, store: counting, now: () => T0 });
        await jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        await jar.apply(STATE, [], httpDate(T0 + 1000));
        await jar.apply(STATE, ['gone=; Max-Age=0'], httpDate(T0 + 2000));
        expect(writes).toBe(1);
        // A clock that moved a minute or more is written, for the next launch.
        await jar.apply(STATE, [], httpDate(T0 - MINUTE));
        expect(writes).toBe(2);
    });

    it('rejects when its store fails, keeps the cookies, and stores them with the next answer', async () => {
        const store = memoryJarStore();
        let failing = true;
        const flaky: JarStore = {
            read: store.read,
            write: async (value) => {
                if (failing) {
                    throw new Error('keychain unavailable');
                }
                await store.write(value);
            },
        };
        const jar = await openCookieJar({ origin: ORIGIN, store: flaky, now: () => T0 });
        await expect(jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0))).rejects.toThrow(
            'keychain unavailable',
        );
        expect(jar.session()?.value).toBe('t1');
        expect(store.value).toBeNull();
        failing = false;
        // An answer with no Set-Cookie still writes, since the store is behind.
        await jar.apply(STATE, [], httpDate(T0));
        expect(store.value).toContain('t1');
    });

    it.each([
        ['clear()', (jar: CookieJar) => jar.clear()],
        ['close()', (jar: CookieJar) => jar.close()],
    ])('writes the jar on %s after a failed write, so a cleared session never comes back', async (_label, end) => {
        const store = memoryJarStore();
        let failing = false;
        const flaky: JarStore = {
            read: store.read,
            write: async (value) => {
                if (failing) {
                    throw new Error('keychain unavailable');
                }
                await store.write(value);
            },
        };
        const jar = await openCookieJar({ origin: ORIGIN, store: flaky, now: () => T0 });
        await jar.apply(SIGN_IN, [sessionSetCookie('tok')], httpDate(T0));
        // The 401's clearing cookie comes while the keychain fails: memory is empty, the store still has tok.
        failing = true;
        await expect(jar.apply(STATE, [sessionSetCookie('', 0)], httpDate(T0))).rejects.toThrow('keychain');
        expect(jar.session()).toBeNull();
        failing = false;
        await end(jar);
        const reopened = await openCookieJar({ origin: ORIGIN, store, now: () => T0 });
        expect(reopened.session()).toBeNull();
    });

    it('still closes when its last write fails again, so a wipe can go ahead', async () => {
        const jar = await openCookieJar({
            origin: ORIGIN,
            store: {
                read: async () => null,
                write: async () => {
                    throw new Error('keychain unavailable');
                },
            },
            now: () => T0,
        });
        await expect(jar.apply(SIGN_IN, [sessionSetCookie('tok')], httpDate(T0))).rejects.toThrow('keychain');
        await expect(jar.close()).resolves.toBeUndefined();
    });

    it('sends each cookie only where its path and Secure flag allow, longer paths first', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(SIGN_IN, ['all=1; Path=/', 'auth=2; Path=/api/auth', 'sign=3'], httpDate(T0));
        expect(jar.cookieHeader(SIGN_IN)).toBe('sign=3; auth=2; all=1');
        expect(jar.cookieHeader(STATE)).toBe('all=1');
        // Never to another origin, nor to the same host over http.
        expect(jar.cookieHeader(new URL('https://evil.example.test/'))).toBeNull();
        await expect(jar.apply(new URL('https://evil.example.test/'), ['x=1'], null)).rejects.toThrow(
            /takes no cookies from/,
        );
    });

    it('replaces a cookie by name and path, and keeps at most 50, the session cookie last to go', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(SIGN_IN, [sessionSetCookie('t1'), 'a=1; Path=/', 'a=2; Path=/api'], httpDate(T0));
        await jar.apply(STATE, ['a=3; Path=/'], httpDate(T0));
        expect(jar.cookies().map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual([
            `${SESSION}=t1`,
            'a=3',
            'a=2',
        ]);
        const many = Array.from({ length: 60 }, (_, index) => `c${index}=1; Path=/`);
        await jar.apply(STATE, many, httpDate(T0));
        expect(jar.cookies()).toHaveLength(50);
        expect(jar.session()?.value).toBe('t1');
        expect(jar.cookies().at(-1)?.name).toBe('c59');
    });

    it('opens what its store holds, empty on unreadable contents, and refuses another origin’s', async () => {
        const first = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await first.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        const copy = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(first.serialize()), now: () => T0 });
        expect(copy.cookies()).toEqual(first.cookies());

        for (const text of ['', 'not json', '[]', '{"v":2,"origin":"x","offset":0,"cookies":[]}']) {
            const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(text), now: () => T0 });
            expect(jar.cookies(), text).toEqual([]);
        }
        const bad = JSON.stringify({
            v: 1,
            origin: ORIGIN,
            offset: 0,
            cookies: [{ name: 'a', value: 1, path: '/', secure: false, expiresAt: null }],
        });
        expect((await openCookieJar({ origin: ORIGIN, store: memoryJarStore(bad) })).cookies()).toEqual([]);

        await expect(
            openCookieJar({ origin: 'https://other.example.test', store: memoryJarStore(first.serialize()) }),
        ).rejects.toThrow(/holds https:\/\/brain\.example\.test's cookies/);
        await expect(openCookieJar({ origin: `${ORIGIN}/`, store: memoryJarStore() })).rejects.toThrow(TypeError);
    });

    it('takes no cookies once closed, after its last write is done', async () => {
        const held = deferred();
        const store = memoryJarStore();
        const slow: JarStore = {
            read: store.read,
            write: async (value) => {
                await held.promise;
                await store.write(value);
            },
        };
        const jar = await openCookieJar({ origin: ORIGIN, store: slow, now: () => T0 });
        const applied = jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        let closed = false;
        const closing = jar.close().then(() => (closed = true));
        await settle();
        expect(closed).toBe(false);
        held.resolve();
        await Promise.all([applied, closing]);
        expect(store.value).toContain('t1');
        await expect(jar.apply(STATE, ['a=1'], null)).rejects.toThrow(/closed/);
        await expect(jar.clear()).rejects.toThrow(/closed/);
    });

    it('clears, and stores the empty jar', async () => {
        const store = memoryJarStore();
        const jar = await openCookieJar({ origin: ORIGIN, store, now: () => T0 });
        await jar.apply(SIGN_IN, [sessionSetCookie('t1')], httpDate(T0));
        await jar.clear();
        expect(jar.cookies()).toEqual([]);
        expect((await openCookieJar({ origin: ORIGIN, store })).cookies()).toEqual([]);
    });

    it('names the session cookie as Better Auth does on each scheme', () => {
        expect(sessionCookieName(ORIGIN)).toBe('__Host-cb.session_token');
        expect(sessionCookieName(LOCAL_ORIGIN)).toBe('cb.session_token');
    });
});
