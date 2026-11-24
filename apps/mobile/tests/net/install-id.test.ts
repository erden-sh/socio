import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INSTALL_HEADER } from '@socio/shared/device-sign-in';

import { createAuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { createPublicFetch } from '../../src/net/public-fetch';
import { createRelayFetch } from '../../src/net/relay-fetch';
import { type SessionEnd, sessionEndOf } from '../../src/net/session';

import { answer, DAY, fakeFetch, httpDate, ORIGIN, sentHeaders, sessionSetCookie, T0 } from './helpers';

// The install id: authedFetch sends it as X-Socio-Install to the workspace's
// origin only, and reads the server's 401 codes from what a request
// that carried it gets back. publicFetch and the relay's fetch never carry it.

const USER_AGENT = 'Socio/0.1.0 (Pixel 4; Android 13)';
const INSTALL = 'Aq3_x-9ZkLmNoPqRsTuVwXyZ0123456789abcdefghi';
const HEADER = INSTALL_HEADER.toLowerCase();

async function setup(respond: Parameters<typeof fakeFetch>[0], installId: string | null = INSTALL) {
    const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
    await jar.apply(new URL(`${ORIGIN}/api/auth/sign-in/email`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
    const fetch = fakeFetch(respond);
    const ends: SessionEnd[] = [];
    const request = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: USER_AGENT,
        signal: new AbortController().signal,
        installId,
        onUnauthorized: (end) => void ends.push(end),
    });
    return { fetch, request, ends, jar };
}

/** A 401 as the server answers it, with the clearing cookie, a day into the session. */
const refused = (code: string | null) =>
    answer(401, {
        date: httpDate(T0 + DAY),
        headers: { 'content-type': 'application/json' },
        setCookie: [sessionSetCookie('', 0)],
        body: code === null ? { error: 'Sign in to continue.' } : { error: 'Signed out.', code },
    });

describe('the install id on the wire', () => {
    it('goes on every request to the workspace, a sign-in and a write included', async () => {
        const { fetch, request } = await setup(() => answer(200, { date: httpDate(T0) }));
        await request('/api/state');
        await request('/api/auth/sign-in/email', { method: 'POST', json: { email: 'a@example.test', password: 'x' } });
        expect(fetch.calls.map((call) => sentHeaders(call)[HEADER])).toEqual([INSTALL, INSTALL]);
    });

    it('never goes off the origin: the request is refused before anything is sent', async () => {
        const { fetch, request } = await setup(() => answer(200));
        await expect(request('https://link.socio.sh/app/w/brain.example.test')).rejects.toThrow(/isn't on/);
        await expect(request('https://relay.example.test/v1/registrations')).rejects.toThrow(/isn't on/);
        expect(fetch.calls).toEqual([]);
    });

    it('is authedFetch’s own: a caller can’t set it, and a copy without one sends none', async () => {
        const { request } = await setup(() => answer(200));
        await expect(request('/api/state', { headers: { 'X-Socio-Install': 'other' } })).rejects.toThrow(TypeError);
        const none = await setup(() => answer(200), null);
        await none.request('/api/state');
        expect(HEADER in sentHeaders(none.fetch.calls[0])).toBe(false);
    });

    it('must be an install id: 43 base64url characters', async () => {
        await expect(setup(() => answer(200), 'not an id')).rejects.toThrow(TypeError);
    });

    it('never goes through publicFetch or the relay’s fetch', async () => {
        const fetch = fakeFetch(() => answer(200, { headers: { 'content-type': 'application/json' }, body: {} }));
        await createPublicFetch({ fetch, userAgent: USER_AGENT })(`${ORIGIN}/.well-known/socio/workspace`);
        await createRelayFetch({ fetch, userAgent: USER_AGENT, origin: 'https://relay.example.test' })(
            '/v1/registrations',
            { method: 'POST', json: {} },
        );
        expect(fetch.calls).toHaveLength(2);
        for (const call of fetch.calls) {
            expect(HEADER in sentHeaders(call)).toBe(false);
        }
    });

    it('is named in src/ by authedFetch alone', () => {
        const src = join(__dirname, '../../src');
        const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) => /\.tsx?$/.test(name));
        const naming = files.filter((name) => {
            const text = readFileSync(join(src, name), 'utf8');
            // The constant, or the name as a string (a comment may say it).
            return text.includes('INSTALL_HEADER') || /['"]x-socio-install['"]/i.test(text);
        });
        expect(naming).toEqual([join('net', 'authed-fetch.ts')]);
    });
});

describe('the server’s 401 codes', () => {
    it.each([
        ['session_expired', 'expired'],
        ['session_ended', 'ended'],
        ['device_revoked', 'device-revoked'],
        ['deactivated', 'deactivated'],
    ] as const)('%s is %s, a day before the stored expiry', async (code, end) => {
        const { request, ends } = await setup(() => refused(code));
        const response = await request('/api/state');
        expect(ends).toEqual([end]);
        // The caller still has the whole body: the code was read from a clone.
        expect(await response.json()).toMatchObject({ code });
    });

    it('without one, the earlier rules stay: a 401 before the stored expiry is Ended', async () => {
        for (const code of [null, 'sign_in', 'something_new']) {
            const { request, ends } = await setup(() => refused(code));
            await request('/api/state');
            expect(ends).toEqual(['ended']);
        }
    });

    it('count only for a request that carried the install id', async () => {
        const { request, ends } = await setup(() => refused('device_revoked'), null);
        await request('/api/state');
        expect(ends).toEqual(['ended']);
    });

    it('a body that isn’t JSON is no code', async () => {
        const { request, ends } = await setup(() => new Response('<html>401</html>', { status: 401 }));
        await request('/api/state');
        expect(ends).toEqual(['ended']);
    });

    it('a withheld cookie’s session_ended stays Expired; the wipes stand', () => {
        expect(sessionEndOf('session_ended', true)).toBe('expired');
        expect(sessionEndOf('device_revoked', true)).toBe('device-revoked');
        expect(sessionEndOf('deactivated', true)).toBe('deactivated');
        expect(sessionEndOf('constructor', false)).toBeNull();
    });

    it('a wiping code is confirmed by one request behind the session check that carries the install id', async () => {
        const { fetch, request, ends } = await setup(() => refused('device_revoked'));
        await request('/api/state');
        expect(ends).toEqual(['device-revoked']);
        expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/state', '/api/auth/devices']);
        expect(sentHeaders(fetch.calls[1])[HEADER]).toBe(INSTALL);
        expect(fetch.calls[1]?.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    });

    it('a wiping code the session check doesn’t repeat only locks', async () => {
        for (const confirm of [
            () => refused('session_ended'),
            () => refused(null),
            () => answer(200, { date: httpDate(T0 + DAY), headers: { 'content-type': 'application/json' }, body: {} }),
            () => {
                throw new Error('fetch failed');
            },
        ]) {
            const { request, ends } = await setup((url) =>
                new URL(url).pathname === '/api/auth/devices' ? confirm() : refused('deactivated'),
            );
            await request('/api/state');
            expect(ends).toEqual(['ended']);
        }
    });

    it('Ended needs no confirmation: nothing more is sent', async () => {
        const { fetch, request } = await setup(() => refused('session_ended'));
        await request('/api/state');
        expect(fetch.calls).toHaveLength(1);
    });

    it('reads a code only from an application/json body', async () => {
        for (const type of ['text/plain', 'text/html', 'application/problem+json']) {
            const { fetch, request, ends } = await setup(
                () =>
                    new Response(JSON.stringify({ code: 'device_revoked' }), {
                        status: 401,
                        headers: { 'content-type': type, date: httpDate(T0 + DAY) },
                    }),
            );
            await request('/api/state');
            expect(ends).toEqual(['ended']);
            expect(fetch.calls).toHaveLength(1);
        }
    });

    it('stops reading a 401 body past 4 KB, without waiting for the rest', async () => {
        const { request, ends } = await setup(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            // 5 KB of a JSON body that never ends.
                            controller.enqueue(
                                new TextEncoder().encode(`{"code":"device_revoked","pad":"${'x'.repeat(5000)}`),
                            );
                        },
                    }),
                    { status: 401, headers: { 'content-type': 'application/json', date: httpDate(T0 + DAY) } },
                ),
        );
        await request('/api/state');
        expect(ends).toEqual(['ended']);
    });
});
