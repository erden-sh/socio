import { afterEach, describe, expect, it, vi } from 'vitest';

import { AbortedError } from '../../src/net/errors';
import { PROBE_TIMEOUT_MS, type ProbeResult, probeWorkspace } from '../../src/net/probe';
import { createPublicFetch } from '../../src/net/public-fetch';

import { deferred, fakeFetch } from './helpers';

// The address probe against a
// fake fetch: `GET /api/auth/session` through publicFetch, one redirect at most,
// to the same path over https, and only a sign-in view counts as a workspace.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const SESSION = '/api/auth/session';
const MANIFEST = '/.well-known/socio/workspace';

/** The server's sign-in view with Better Auth (src/server/auth/sign-in-view.ts), signed out. */
const VIEW = {
    provider: 'betterauth',
    branding: { name: 'Acme', logo: '/favicon.svg' },
    methods: {
        passkey: true,
        password: true,
        signUp: false,
        emailReset: true,
        signInLink: false,
        providers: [{ id: 'okta', name: 'Okta' }],
    },
    user: null,
};

const ACME = {
    provider: 'betterauth',
    name: 'Acme',
    logo: '/favicon.svg',
    methods: VIEW.methods,
    manifest: null,
};

/** A JSON answer, as Hono's `c.json` gives it. */
const json = (status: number, body: unknown, contentType = 'application/json; charset=UTF-8') =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

/** A text answer. */
const text = (status: number, body: string, contentType: string) =>
    new Response(body, { status, headers: { 'content-type': contentType } });

/** A redirect, with its Location when given. */
const redirect = (status: number, location?: string) =>
    new Response(null, { status, headers: location === undefined ? {} : { location } });

/** The statuses OkHttp's `Response.isRedirect` is true for, which Android's expo/fetch gives as `redirected`. */
const OKHTTP_REDIRECTS = [300, 301, 302, 303, 307, 308];

/**
 * An answer as a platform's expo/fetch hands it back under `redirect: 'manual'`,
 * with the request's own URL. Android's sets `redirected` on every 3xx OkHttp
 * counts as a redirect, unfollowed as it is (expo's NativeResponse.kt); iOS's
 * only after following one, which it doesn't under 'manual' (NativeResponse.swift).
 */
function asOn(platform: 'Android' | 'iOS', response: Response, url: string): Response {
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', {
        value: platform === 'Android' && OKHTTP_REDIRECTS.includes(response.status),
    });
    return response;
}

type Routes = Record<string, () => Response | Promise<Response>>;

interface ProbeCase {
    variant?: string;
    routes?: Routes;
    known?: string[];
    signal?: AbortSignal;
    serverVersionOk?: (version: string) => boolean;
}

/** Probes `typed` against a fake server that answers `routes` by full URL and fails DNS for anything else. */
async function probe(
    typed: string,
    { variant = 'preview', routes = {}, known = [], signal, serverVersionOk }: ProbeCase = {},
) {
    /** The hosts that answer at all: a host with no route is a DNS failure. */
    const hosts = new Set(Object.keys(routes).map((url) => new URL(url).host));
    const fetch = fakeFetch((url) => {
        const route = routes[url];
        if (route === undefined) {
            // A server without the manifest: a 404, as Hono's notFound answers.
            if (new URL(url).pathname === MANIFEST && hosts.has(new URL(url).host)) {
                return json(404, { error: 'Not found.' });
            }
            throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`);
        }
        return route();
    });
    const asked: string[] = [];
    const result = await probeWorkspace(typed, {
        variant,
        publicFetch: createPublicFetch({ fetch, userAgent: USER_AGENT }),
        isKnown: async (origin) => {
            asked.push(origin);
            return known.includes(origin);
        },
        signal,
        serverVersionOk,
    });
    // These cases are about the session probe: its requests apart from the manifest's, which later cases read in `all`.
    const isManifest = (call: { url: string }) => new URL(call.url).pathname === MANIFEST;
    const sessionCalls = fetch.calls.filter((call) => !isManifest(call));
    return {
        result,
        fetch: { calls: sessionCalls },
        calls: sessionCalls.map((call) => call.url),
        manifestCalls: fetch.calls.filter(isManifest),
        all: fetch.calls.map((call) => call.url),
        asked,
    };
}

const failed = (problem: string, origin: string | null, status: number | null): ProbeResult =>
    ({ kind: 'failed', problem, origin, status }) as ProbeResult;

describe('probeWorkspace finds a workspace', () => {
    it('with a GET of /api/auth/session on the typed origin, with no cookie or Origin, and redirects handed back', async () => {
        const { result, fetch, asked } = await probe('BRAIN.example.test./chats/abc?tab=1#m-9', {
            variant: 'production',
            routes: { [`https://brain.example.test${SESSION}`]: () => json(200, VIEW) },
        });
        expect(result).toEqual({
            kind: 'found',
            address: { origin: 'https://brain.example.test', host: 'brain.example.test' },
            workspace: ACME,
            redirectedFrom: null,
        });
        expect(fetch.calls).toEqual([
            {
                url: `https://brain.example.test${SESSION}`,
                init: {
                    method: 'GET',
                    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                    credentials: 'omit',
                    redirect: 'manual',
                    signal: expect.any(AbortSignal),
                },
            },
        ]);
        expect(asked).toEqual(['https://brain.example.test']);
    });

    it('on any https host, in production, and only once it answers as a Socio workspace', async () => {
        const found = await probe('acme.example.test', {
            variant: 'production',
            routes: { [`https://acme.example.test${SESSION}`]: () => json(200, VIEW) },
        });
        expect(found.result).toEqual({
            kind: 'found',
            address: { origin: 'https://acme.example.test', host: 'acme.example.test' },
            workspace: ACME,
            redirectedFrom: null,
        });
        const notSocio = await probe('brain.example.test.evil.example', {
            variant: 'production',
            routes: {
                [`https://brain.example.test.evil.example${SESSION}`]: () => text(200, '<html></html>', 'text/html'),
            },
        });
        expect(notSocio.result).toEqual(failed('not-socio', 'https://brain.example.test.evil.example', 200));
    });

    it('on a local server over plain http, in development', async () => {
        const { result } = await probe('http://localhost:4352', {
            variant: 'development',
            routes: { [`http://localhost:4352${SESSION}`]: () => json(200, VIEW) },
        });
        expect(result).toMatchObject({ kind: 'found', address: { origin: 'http://localhost:4352' } });
    });

    it('with the mock provider’s view, which has no methods, and without a logo', async () => {
        const { result } = await probe('socio.example.test', {
            routes: {
                [`https://socio.example.test${SESSION}`]: () =>
                    json(200, { provider: 'mock', branding: { name: 'Socio' }, user: null }),
            },
        });
        expect(result).toMatchObject({
            kind: 'found',
            workspace: { provider: 'mock', name: 'Socio', logo: null, methods: null },
        });
    });

    it('reading each method as on only when it says true, and keeping only well-formed providers', async () => {
        const methods = {
            passkey: 'yes',
            password: 1,
            signUp: true,
            providers: [{ id: 'google', name: 'Google' }, { id: 7, name: 'Seven' }, 'okta', null, { id: 'x' }],
        };
        const { result } = await probe('acme.example.test', {
            routes: {
                [`https://acme.example.test${SESSION}`]: () =>
                    json(200, { ...VIEW, branding: { name: 'Acme', logo: 42 }, methods }),
            },
        });
        expect(result).toMatchObject({
            kind: 'found',
            workspace: {
                logo: null,
                methods: {
                    passkey: false,
                    password: false,
                    signUp: true,
                    emailReset: false,
                    signInLink: false,
                    providers: [{ id: 'google', name: 'Google' }],
                },
            },
        });
    });

    it.each(['application/json', 'Application/JSON; charset=utf-8', 'application/vnd.socio+json'])(
        'answered as %s',
        async (contentType) => {
            const { result } = await probe('acme.example.test', {
                routes: { [`https://acme.example.test${SESSION}`]: () => json(200, VIEW, contentType) },
            });
            expect(result).toMatchObject({ kind: 'found', workspace: ACME });
        },
    );
});

describe('probeWorkspace follows one redirect', () => {
    it.each([301, 302, 303, 307, 308])(
        'a %i to the same path on https, and adds the origin where it ends',
        async (status) => {
            const { result, fetch, asked } = await probe('acme.example.test', {
                routes: {
                    [`https://acme.example.test${SESSION}`]: () =>
                        redirect(status, `https://brain.acme.example.test${SESSION}`),
                    [`https://brain.acme.example.test${SESSION}`]: () => json(200, VIEW),
                },
            });
            expect(result).toEqual({
                kind: 'found',
                address: { origin: 'https://brain.acme.example.test', host: 'brain.acme.example.test' },
                workspace: ACME,
                redirectedFrom: 'https://acme.example.test',
            });
            expect(fetch.calls.map((call) => call.url)).toEqual([
                `https://acme.example.test${SESSION}`,
                `https://brain.acme.example.test${SESSION}`,
            ]);
            // The second request is publicFetch's too: no cookie, no Origin, redirects handed back.
            // Each with its own time limit's signal.
            expect(fetch.calls[1]?.init).toEqual({ ...fetch.calls[0]?.init, signal: expect.any(AbortSignal) });
            expect(fetch.calls[1]?.init.signal).not.toBe(fetch.calls[0]?.init.signal);
            expect(asked).toEqual(['https://acme.example.test', 'https://brain.acme.example.test']);
        },
    );

    it('from one host to another, in production', async () => {
        const { result } = await probe('brain.example.test', {
            variant: 'production',
            routes: {
                [`https://brain.example.test${SESSION}`]: () => redirect(308, `https://brain.example.org${SESSION}`),
                [`https://brain.example.org${SESSION}`]: () => json(200, VIEW),
            },
        });
        expect(result).toMatchObject({
            kind: 'found',
            address: { origin: 'https://brain.example.org' },
            redirectedFrom: 'https://brain.example.test',
        });
    });

    it('given as a relative Location, on the same origin', async () => {
        let asks = 0;
        const { result, calls, asked } = await probe('acme.example.test', {
            routes: {
                [`https://acme.example.test${SESSION}`]: () =>
                    asks++ === 0 ? redirect(307, SESSION) : json(200, VIEW),
            },
        });
        expect(result).toMatchObject({
            kind: 'found',
            address: { origin: 'https://acme.example.test' },
            redirectedFrom: 'https://acme.example.test',
        });
        expect(calls).toEqual([`https://acme.example.test${SESSION}`, `https://acme.example.test${SESSION}`]);
        // The registry was asked about that origin once.
        expect(asked).toEqual(['https://acme.example.test']);
    });

    it('given as an unnormalized Location, to the normalized origin', async () => {
        const { result, calls } = await probe('acme.example.test', {
            routes: {
                [`https://acme.example.test${SESSION}`]: () =>
                    redirect(301, 'HTTPS://Brain.Acme.Example.Test.:443/api/auth/./session#top'),
                [`https://brain.acme.example.test${SESSION}`]: () => json(200, VIEW),
            },
        });
        expect(result).toMatchObject({ kind: 'found', address: { origin: 'https://brain.acme.example.test' } });
        expect(calls[1]).toBe(`https://brain.acme.example.test${SESSION}`);
    });
});

describe.each(['Android', 'iOS'] as const)('probeWorkspace on %s’s expo/fetch', (platform) => {
    const FIRST = `https://acme.example.test${SESSION}`;
    const SECOND = `https://brain.acme.example.test${SESSION}`;

    it.each([301, 302, 303, 307, 308])('follows a %i it hands back unfollowed', async (status) => {
        const { result, calls } = await probe('acme.example.test', {
            routes: {
                [FIRST]: () => asOn(platform, redirect(status, SECOND), FIRST),
                [SECOND]: () => asOn(platform, json(200, VIEW), SECOND),
            },
        });
        expect(result).toMatchObject({
            kind: 'found',
            address: { origin: 'https://brain.acme.example.test' },
            redirectedFrom: 'https://acme.example.test',
        });
        expect(calls).toEqual([FIRST, SECOND]);
    });

    it('refuses the second redirect as a second redirect', async () => {
        const { result, calls } = await probe('acme.example.test', {
            routes: {
                [FIRST]: () => asOn(platform, redirect(302, SECOND), FIRST),
                [SECOND]: () => asOn(platform, redirect(302, `https://brain2.acme.example.test${SESSION}`), SECOND),
            },
        });
        expect(result).toEqual(failed('redirect-twice', 'https://brain.acme.example.test', 302));
        expect(calls).toEqual([FIRST, SECOND]);
    });

    it('takes a 300, which it doesn’t follow, for no workspace', async () => {
        const { result } = await probe('acme.example.test', {
            routes: { [FIRST]: () => asOn(platform, redirect(300, SECOND), FIRST) },
        });
        expect(result).toEqual(failed('not-socio', 'https://acme.example.test', 300));
    });

    it('refuses a 3xx that comes from another origin', async () => {
        const { result, calls } = await probe('acme.example.test', {
            routes: { [FIRST]: () => asOn(platform, redirect(302, SECOND), `https://evil.example${SESSION}`) },
        });
        expect(result).toEqual(failed('redirect-invalid', 'https://acme.example.test', 302));
        expect(calls).toEqual([FIRST]);
    });
});

describe('probeWorkspace refuses a redirect', () => {
    it('that leads to a second redirect', async () => {
        const { result, calls } = await probe('acme.example.test', {
            routes: {
                [`https://acme.example.test${SESSION}`]: () =>
                    redirect(302, `https://brain.acme.example.test${SESSION}`),
                [`https://brain.acme.example.test${SESSION}`]: () =>
                    redirect(302, `https://brain2.acme.example.test${SESSION}`),
                [`https://brain2.acme.example.test${SESSION}`]: () => json(200, VIEW),
            },
        });
        expect(result).toEqual(failed('redirect-twice', 'https://brain.acme.example.test', 302));
        expect(calls).toHaveLength(2);

        const loop = await probe('acme.example.test', {
            routes: { [`https://acme.example.test${SESSION}`]: () => redirect(307, SESSION) },
        });
        expect(loop.result).toEqual(failed('redirect-twice', 'https://acme.example.test', 307));
        expect(loop.calls).toHaveLength(2);
    });

    it.each([
        '/api/auth/session/',
        '/api/auth/session?next=/',
        '/sign-in',
        '/',
        `https://brain.acme.example.test/api/auth/sign-in/email`,
        'https://brain.acme.example.test',
    ])('to another path or query (%s)', async (location) => {
        const { result, calls } = await probe('acme.example.test', {
            routes: { [`https://acme.example.test${SESSION}`]: () => redirect(302, location) },
        });
        expect(result).toMatchObject({ kind: 'failed', problem: 'redirect-path', status: 302 });
        expect(calls).toHaveLength(1);
    });

    it('that downgrades to plain http, in every variant, to a local host too', async () => {
        for (const variant of ['production', 'preview', 'development']) {
            const { result, calls } = await probe('brain.example.test', {
                variant,
                routes: {
                    [`https://brain.example.test${SESSION}`]: () =>
                        redirect(301, `http://brain.example.test${SESSION}`),
                },
            });
            expect(result, variant).toEqual(failed('redirect-insecure', 'http://brain.example.test', 301));
            expect(calls).toHaveLength(1);
        }
        const local = await probe('http://localhost:4352', {
            variant: 'development',
            routes: { [`http://localhost:4352${SESSION}`]: () => redirect(302, `http://127.0.0.1:4352${SESSION}`) },
        });
        expect(local.result).toEqual(failed('redirect-insecure', 'http://127.0.0.1:4352', 302));
    });

    it.each(['ftp://brain.acme.example.test/api/auth/session', 'javascript:alert(1)', 'socio://w/abc'])(
        'to a scheme other than https (%s)',
        async (location) => {
            const { result } = await probe('acme.example.test', {
                routes: { [`https://acme.example.test${SESSION}`]: () => redirect(302, location) },
            });
            expect(result).toEqual(failed('redirect-insecure', null, 302));
        },
    );

    it("to a target the build's rules refuse, before asking it anything", async () => {
        const cases: [string, string, string, string | null][] = [
            ['production', `https://ada@evil.example${SESSION}`, 'userinfo', 'https://evil.example'],
            ['production', `https://brain.example.test:8443${SESSION}`, 'port', 'https://brain.example.test:8443'],
            ['preview', `https://ada:secret@evil.example${SESSION}`, 'userinfo', 'https://evil.example'],
            ['development', `https://brain.example.test..${SESSION}`, 'unreadable', 'https://brain.example.test..'],
            ['staging', `https://evil.example:8443${SESSION}`, 'port', 'https://evil.example:8443'],
        ];
        for (const [variant, location, problem, origin] of cases) {
            const { result, calls, asked } = await probe('brain.example.test', {
                variant,
                routes: {
                    [`https://brain.example.test${SESSION}`]: () => redirect(302, location),
                    [location]: () => json(200, VIEW),
                },
            });
            expect(result, location).toEqual(failed(problem, origin, 302));
            expect(calls, location).toEqual([`https://brain.example.test${SESSION}`]);
            expect(asked, location).toEqual(['https://brain.example.test']);
        }
    });

    it('with no Location, or one that is not a URL', async () => {
        for (const location of [undefined, '', '   ', 'https://exa mple.test/api/auth/session', 'http://[bad']) {
            const { result } = await probe('acme.example.test', {
                routes: { [`https://acme.example.test${SESSION}`]: () => redirect(302, location) },
            });
            expect(result, String(location)).toEqual(failed('redirect-invalid', 'https://acme.example.test', 302));
        }
    });

    it('that the fetch followed by itself, despite redirect: manual', async () => {
        const followed = json(200, VIEW);
        Object.defineProperty(followed, 'redirected', { value: true });
        const elsewhere = json(200, VIEW);
        Object.defineProperty(elsewhere, 'url', { value: `https://evil.example${SESSION}` });
        for (const answer of [followed, elsewhere]) {
            const { result } = await probe('acme.example.test', {
                routes: { [`https://acme.example.test${SESSION}`]: () => answer },
            });
            expect(result).toEqual(failed('redirect-invalid', 'https://acme.example.test', 200));
        }
        // Its own URL is fine.
        const same = json(200, VIEW);
        Object.defineProperty(same, 'url', { value: `https://acme.example.test${SESSION}` });
        const { result } = await probe('acme.example.test', {
            routes: { [`https://acme.example.test${SESSION}`]: () => same },
        });
        expect(result).toMatchObject({ kind: 'found' });
    });
});

describe('probeWorkspace finds no workspace', () => {
    const ORIGIN = 'https://acme.example.test';
    const answering = (answer: () => Response) =>
        probe('acme.example.test', { routes: { [`${ORIGIN}${SESSION}`]: answer } });

    it('behind a 403 "Unrecognized host.", as JSON or as text', async () => {
        for (const answer of [
            () => json(403, { error: 'Unrecognized host.' }),
            () => text(403, 'Unrecognized host.', 'text/plain; charset=UTF-8'),
        ]) {
            expect((await answering(answer)).result).toEqual(failed('unrecognized-host', ORIGIN, 403));
        }
        // Any other 403 is no workspace at all.
        for (const answer of [
            () => json(403, { error: 'Cross-origin requests are not allowed.' }),
            () => text(403, '<h1>Forbidden</h1>', 'text/html'),
            () => new Response(null, { status: 403 }),
        ]) {
            expect((await answering(answer)).result).toEqual(failed('not-socio', ORIGIN, 403));
        }
    });

    it('behind HTML, a website or a single-page app’s fallback', async () => {
        const { result } = await answering(() =>
            text(200, '<!doctype html><html><title>Acme</title></html>', 'text/html; charset=utf-8'),
        );
        expect(result).toEqual(failed('not-socio', ORIGIN, 200));
    });

    it('behind a 404, or any status but 200 that isn’t the server failing', async () => {
        for (const status of [404, 400, 401, 410, 418]) {
            expect((await answering(() => json(status, { error: 'Not found.' }))).result).toEqual(
                failed('not-socio', ORIGIN, status),
            );
        }
        for (const status of [204, 300, 304]) {
            expect((await answering(() => new Response(null, { status }))).result).toEqual(
                failed('not-socio', ORIGIN, status),
            );
        }
    });

    it('behind bad JSON', async () => {
        const { result } = await answering(() =>
            text(200, '{"provider": "betterauth", "branding":', 'application/json'),
        );
        expect(result).toEqual(failed('not-socio', ORIGIN, 200));
    });

    it('behind JSON that isn’t a sign-in view', async () => {
        const bodies: unknown[] = [
            null,
            [],
            [VIEW],
            'betterauth',
            {},
            { provider: 'betterauth' },
            { provider: 7, branding: { name: 'Acme' } },
            { provider: 'betterauth', branding: null },
            { provider: 'betterauth', branding: 'Acme' },
            { provider: 'betterauth', branding: { name: 7 } },
            { provider: 'betterauth', branding: { logo: '/favicon.svg' } },
            { ok: true, user: { id: 'u-1' } },
        ];
        for (const body of bodies) {
            expect((await answering(() => json(200, body))).result, JSON.stringify(body)).toEqual(
                failed('not-socio', ORIGIN, 200),
            );
        }
    });

    it('behind a sign-in view that doesn’t say it is JSON', async () => {
        for (const contentType of ['text/plain', 'text/html', 'application/javascript', '']) {
            expect((await answering(() => json(200, VIEW, contentType))).result, contentType).toEqual(
                failed('not-socio', ORIGIN, 200),
            );
        }
    });

    it('while the server or its proxy fails, which is worth trying again', async () => {
        for (const status of [500, 502, 503, 504, 429]) {
            expect((await answering(() => text(status, 'Bad gateway', 'text/plain'))).result).toEqual(
                failed('server-error', ORIGIN, status),
            );
        }
    });

    it('with no answer, or a body that breaks off', async () => {
        expect((await probe('nowhere.example.test')).result).toEqual(
            failed('unreachable', 'https://nowhere.example.test', null),
        );
        const cut = json(200, VIEW);
        Object.defineProperty(cut, 'text', { value: () => Promise.reject(new Error('stream was reset: CANCEL')) });
        expect((await answering(() => cut)).result).toEqual(failed('unreachable', ORIGIN, 200));
    });
});

describe('probeWorkspace and the workspaces on the phone', () => {
    it('reports a typed origin already on the phone, without a request', async () => {
        const { result, calls, asked } = await probe('HTTPS://Brain.Example.Test.:443/chats', {
            variant: 'production',
            known: ['https://brain.example.test'],
        });
        expect(result).toEqual({
            kind: 'known',
            address: { origin: 'https://brain.example.test', host: 'brain.example.test' },
        });
        expect(calls).toEqual([]);
        expect(asked).toEqual(['https://brain.example.test']);
    });

    it('reports a redirect’s target already on the phone, without asking it', async () => {
        const { result, calls, asked } = await probe('acme.example.test', {
            known: ['https://brain.acme.example.test'],
            routes: {
                [`https://acme.example.test${SESSION}`]: () =>
                    redirect(301, `https://brain.acme.example.test${SESSION}`),
            },
        });
        expect(result).toEqual({
            kind: 'known',
            address: { origin: 'https://brain.acme.example.test', host: 'brain.acme.example.test' },
        });
        expect(calls).toEqual([`https://acme.example.test${SESSION}`]);
        expect(asked).toEqual(['https://acme.example.test', 'https://brain.acme.example.test']);
    });

    it('asks only about exact origins: another port or scheme is another workspace', async () => {
        const { result } = await probe('https://localhost:8443', {
            variant: 'development',
            known: ['http://localhost:8443', 'https://localhost'],
            routes: { [`https://localhost:8443${SESSION}`]: () => json(200, VIEW) },
        });
        expect(result).toMatchObject({ kind: 'found', address: { origin: 'https://localhost:8443' } });
    });
});

describe('probeWorkspace refuses a typed address before anything else', () => {
    it.each([
        ['production', 'brain.example.test:8443', 'port'],
        ['production', 'http://localhost:4352', 'insecure'],
        ['preview', 'http://localhost:4352', 'insecure'],
        ['staging', 'http://localhost:4352', 'insecure'],
        ['development', 'https://brain.example.test@evil.example', 'userinfo'],
        ['development', 'ftp://brain.example.test', 'scheme'],
        ['development', 'brain example.test', 'unreadable'],
        ['development', '  ', 'empty'],
    ])('%s: %j is %s, with no request and no registry lookup', async (variant, typed, problem) => {
        const { result, calls, asked } = await probe(typed, { variant });
        expect(result).toEqual(failed(problem, null, null));
        expect(calls).toEqual([]);
        expect(asked).toEqual([]);
    });
});

describe('probeWorkspace stopped', () => {
    it('rejects with AbortedError, before sending or while waiting', async () => {
        const stopped = new AbortController();
        stopped.abort();
        await expect(probe('acme.example.test', { signal: stopped.signal })).rejects.toBeInstanceOf(AbortedError);

        const started = deferred();
        const controller = new AbortController();
        const pending = probe('acme.example.test', {
            signal: controller.signal,
            routes: {
                [`https://acme.example.test${SESSION}`]: () => {
                    started.resolve();
                    return new Promise<Response>((_resolve, reject) => {
                        controller.signal.addEventListener('abort', () =>
                            reject(new Error('fetch failed: Fetch request has been canceled')),
                        );
                    });
                },
            },
        });
        await started.promise;
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(AbortedError);
    });
});

describe('probeWorkspace gives each request a time limit', () => {
    const origin = 'https://acme.example.test';
    afterEach(() => {
        vi.useRealTimers();
    });

    /** An answer that never comes, from a fetch that doesn't heed its signal (OkHttp retrying a dropped host). */
    const never = () => new Promise<Response>(() => {});
    /** `answer` after `ms`. */
    const after = (ms: number, answer: () => Response) => () =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(answer()), ms));

    /** Starts a probe under fake timers and reports whether it has settled. */
    function start(routes: Routes, signal?: AbortSignal) {
        vi.useFakeTimers();
        let settled = false;
        const pending = probe('acme.example.test', { routes, signal });
        void pending.then(
            () => (settled = true),
            () => (settled = true),
        );
        // Keep the rejection handled while the clock runs; the test awaits it later.
        pending.catch(() => {});
        return { pending, settled: () => settled };
    }

    it('ends a manifest request that never answers as unreachable, at the limit', async () => {
        const run = start({ [`${origin}${MANIFEST}`]: never, [`${origin}${SESSION}`]: () => json(200, VIEW) });
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const { result, all } = await run.pending;
        expect(result).toEqual(failed('unreachable', origin, null));
        expect(all).toEqual([`${origin}${MANIFEST}`]);
    });

    it('ends a session request that never answers, or whose body stalls, as unreachable, at the limit', async () => {
        const stalled = json(200, VIEW);
        Object.defineProperty(stalled, 'text', { value: () => new Promise<string>(() => {}) });
        for (const answer of [never, () => Promise.resolve(stalled)]) {
            const run = start({ [`${origin}${SESSION}`]: answer });
            await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
            expect(run.settled()).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect((await run.pending).result).toEqual(failed('unreachable', origin, null));
            vi.useRealTimers();
        }
    });

    it('still finds a slow server that answers each request within the limit', async () => {
        const slow = PROBE_TIMEOUT_MS - 1000;
        const run = start({
            [`${origin}${MANIFEST}`]: after(slow, () => json(404, { error: 'Not found.' })),
            [`${origin}${SESSION}`]: after(slow, () => json(200, VIEW)),
        });
        await vi.advanceTimersByTimeAsync(2 * slow);
        expect((await run.pending).result).toMatchObject({ kind: 'found', workspace: ACME });
    });

    it('gives the redirect’s target a limit of its own, not what is left of the first', async () => {
        const slow = PROBE_TIMEOUT_MS - 1000;
        const target = 'https://brain.acme.example.test';
        const found = start({
            [`${origin}${SESSION}`]: after(slow, () => redirect(302, `${target}${SESSION}`)),
            [`${target}${SESSION}`]: after(slow, () => json(200, VIEW)),
        });
        await vi.advanceTimersByTimeAsync(2 * slow);
        expect((await found.pending).result).toMatchObject({ kind: 'found', address: { origin: target } });
        vi.useRealTimers();

        const silent = start({
            [`${origin}${SESSION}`]: after(slow, () => redirect(302, `${target}${SESSION}`)),
            [`${target}${SESSION}`]: never,
        });
        await vi.advanceTimersByTimeAsync(slow + PROBE_TIMEOUT_MS - 1);
        expect(silent.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await silent.pending).result).toEqual(failed('unreachable', target, null));
    });

    it('still stops at once when the person stops it, before the limit', async () => {
        const controller = new AbortController();
        const run = start({ [`${origin}${MANIFEST}`]: never }, controller.signal);
        await vi.advanceTimersByTimeAsync(1000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(run.settled()).toBe(true);
        await expect(run.pending).rejects.toBeInstanceOf(AbortedError);
    });
});

describe('probeWorkspace and the manifest', () => {
    /** A manifest as the server serves it. */
    const manifest = (origin: string, serverVersion = '0.40.0') => ({
        id: 'ws_7f3a',
        origin,
        name: 'Acme',
        branding: { name: 'Acme', logo: '/favicon.svg' },
        methods: { password: true, passkey: true, sheet: true, signInCodes: 'email', addDevice: true },
        serverVersion,
        protocol: 1,
        policy: { leaseDays: 14, wipeDays: 7, appLock: false, notificationText: true },
    });

    it('reads it first, then the sign-in view, and keeps it with the workspace', async () => {
        const origin = 'https://acme.example.test';
        const { result, all } = await probe('acme.example.test', {
            routes: {
                [`${origin}${MANIFEST}`]: () => json(200, manifest(origin)),
                [`${origin}${SESSION}`]: () => json(200, VIEW),
            },
        });
        expect(all).toEqual([`${origin}${MANIFEST}`, `${origin}${SESSION}`]);
        expect(result).toMatchObject({ kind: 'found', workspace: { ...ACME, manifest: manifest(origin) } });
    });

    it('falls back to the sign-in view on today’s servers: a 404, the web’s page, JSON that isn’t one', async () => {
        const origin = 'https://acme.example.test';
        for (const answer of [
            () => json(404, { error: 'Not found.' }),
            () => text(200, '<!doctype html><title>Socio</title>', 'text/html'),
            () => json(200, { hello: 'world' }),
            () => json(500, { error: 'boom' }),
        ]) {
            const { result, all } = await probe('acme.example.test', {
                routes: { [`${origin}${MANIFEST}`]: answer, [`${origin}${SESSION}`]: () => json(200, VIEW) },
            });
            expect(all).toEqual([`${origin}${MANIFEST}`, `${origin}${SESSION}`]);
            expect(result).toMatchObject({ kind: 'found', workspace: { manifest: null } });
        }
    });

    it('takes no manifest that names another origin, or that came through a redirect', async () => {
        const origin = 'https://acme.example.test';
        for (const answer of [
            () => json(200, manifest('https://evil.example.test')),
            () => redirect(302, `https://evil.example.test${MANIFEST}`),
        ]) {
            const { result } = await probe('acme.example.test', {
                routes: { [`${origin}${MANIFEST}`]: answer, [`${origin}${SESSION}`]: () => json(200, VIEW) },
            });
            expect(result).toMatchObject({ kind: 'found', workspace: { manifest: null } });
        }
    });

    it('reads the redirect target’s manifest when the sign-in view moved there', async () => {
        const target = 'https://brain.acme.example.test';
        const { result, all } = await probe('acme.example.test', {
            routes: {
                [`https://acme.example.test${SESSION}`]: () => redirect(301, `${target}${SESSION}`),
                [`${target}${SESSION}`]: () => json(200, VIEW),
                [`${target}${MANIFEST}`]: () => json(200, manifest(target)),
            },
        });
        expect(all).toEqual([
            `https://acme.example.test${MANIFEST}`,
            `https://acme.example.test${SESSION}`,
            `${target}${SESSION}`,
            `${target}${MANIFEST}`,
        ]);
        expect(result).toMatchObject({
            kind: 'found',
            address: { origin: target },
            workspace: { manifest: { origin: target } },
        });
    });

    it('runs the version check before any sign-in: a server below the minimum is server-outdated', async () => {
        const origin = 'https://acme.example.test';
        const routes = {
            [`${origin}${MANIFEST}`]: () => json(200, manifest(origin, '0.31.9')),
            [`${origin}${SESSION}`]: () => json(200, VIEW),
        };
        const serverVersionOk = (version: string) => version !== '0.31.9';
        expect((await probe('acme.example.test', { routes, serverVersionOk })).result).toEqual(
            failed('server-outdated', origin, null),
        );
        // No manifest, no version to check: the gate after sign-in decides, as before.
        const old = await probe('acme.example.test', {
            routes: { [`${origin}${SESSION}`]: () => json(200, VIEW) },
            serverVersionOk: () => false,
        });
        expect(old.result).toMatchObject({ kind: 'found' });
    });

    it('stops at no answer to the manifest, without asking again', async () => {
        const { result, all } = await probe('acme.example.test');
        expect(result).toEqual(failed('unreachable', 'https://acme.example.test', null));
        expect(all).toEqual([`https://acme.example.test${MANIFEST}`]);
    });

    it('never sends a cookie, an Origin or an install id with it', async () => {
        const origin = 'https://acme.example.test';
        const { manifestCalls } = await probe('acme.example.test', {
            routes: {
                [`${origin}${MANIFEST}`]: () => json(200, manifest(origin)),
                [`${origin}${SESSION}`]: () => json(200, VIEW),
            },
        });
        expect(manifestCalls[0]?.init).toEqual({
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': USER_AGENT },
            credentials: 'omit',
            redirect: 'manual',
            signal: expect.any(AbortSignal),
        });
    });
});
