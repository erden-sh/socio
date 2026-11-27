import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import {
    idTokenSchema,
    INSTALL_HEADER,
    socialLinkBodySchema,
    socialRedeemBodySchema,
    socialStartBodySchema,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import type { SignInFlowDeps, SignInOutcome } from '../src/data';
import {
    appleToken,
    googleToken,
    linkWithSocial,
    type ObtainToken,
    signInWithSocial,
    type TokenRequest,
} from '../src/data/social-sign-in';
import { createAuthedFetch, memoryJarStore, openCookieJar } from '../src/net';
import type { FetchFunction } from '../src/net/fetch-function';
import { AUTH_SESSION_PATH, LOGOUT_PATH, SESSION_PATH, SOCIAL_REDEEM_PATH } from '../src/net/sign-in';
import {
    alreadyLinkedOtherLine,
    invalidTokenLine,
    LAST_METHOD,
    methodOffLine,
    NONCE_LINE,
    notLinkedLine,
    socialProblemLine,
    socialSignInLine,
    START_AGAIN_LINE,
    tooManyLine,
    unavailableLine,
    unlinkQuestion,
} from '../src/net/social-copy';
import {
    providerNonce,
    readSocialLinks,
    signInMethodRows,
    SOCIAL_LINK_PATH,
    SOCIAL_LINKS_PATH,
    SOCIAL_START_PATH,
    type SocialBuild,
    socialUnlinkPath,
    socialWays,
    unlinkSocial,
} from '../src/net/social-sign-in';
import { testAccountsIn, testIdToken } from '../src/net/social-test-token';

import { kill, launch, phone, type Phone, sha256 } from './helpers/store';
import {
    answer,
    cookieValue,
    fakeFetch,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    T0,
} from './net/helpers';

// Google and Apple sign-in (CB-570), under Node: which buttons show, the nonce (Apple's hashed),
// the start with no session, the redeem through `signInAndCommit`, every refusal worded by its code,
// the link and unlink signed in, and the development-only test token. The nonce, the token and the
// server client id are in no log, problem, outcome or stored byte.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const SERVER_CLIENT_ID = '000000000000-web.apps.googleusercontent.test';
const nodeBytes = (length: number) => new Uint8Array(randomBytes(length));

const manifest = (social: ('google' | 'apple')[]) =>
    ({
        id: 'ws_acme',
        methods: { password: true, passkey: false, sheet: false, signInCodes: null, addDevice: false, social },
        policy: { leaseDays: 30, wipeDays: 30 },
    }) as unknown as WorkspaceManifest;

const ANDROID: SocialBuild = { platform: 'android', googleIos: false, apple: false };
const IPHONE: SocialBuild = { platform: 'ios', googleIos: true, apple: true };
const IPHONE_DEV: SocialBuild = { platform: 'ios', googleIos: false, apple: false };

describe('which Google and Apple buttons show', () => {
    it('follows the manifest, the platform and the build', () => {
        const both = manifest(['google', 'apple']);
        expect(socialWays(both, IPHONE)).toEqual(['apple', 'google']);
        // No Apple on Android; Google there needs no client id of the build's.
        expect(socialWays(both, ANDROID)).toEqual(['google']);
        // An iOS build without the iOS client id (development) or the entitlement shows neither.
        expect(socialWays(both, IPHONE_DEV)).toEqual([]);
        expect(socialWays(both, { ...IPHONE, googleIos: false })).toEqual(['apple']);
        expect(socialWays(manifest(['google']), IPHONE)).toEqual(['google']);
        expect(socialWays(manifest([]), IPHONE)).toEqual([]);
        // No manifest (an older server): none.
        expect(socialWays(null, IPHONE)).toEqual([]);
    });

    it('Settings lists what can be linked here and what is linked anywhere, Apple first', () => {
        const linked = [
            { provider: 'apple' as const, linkedAt: '2026-11-20T10:00:00.000Z', email: 'ada@example.test' },
        ];
        expect(signInMethodRows(manifest(['google', 'apple']), linked, ANDROID)).toEqual([
            { provider: 'apple', link: linked[0], canLink: false },
            { provider: 'google', link: null, canLink: true },
        ]);
        expect(signInMethodRows(manifest([]), [], ANDROID)).toEqual([]);
        expect(signInMethodRows(null, [], IPHONE)).toEqual([]);
    });
});

describe('the nonce the phone signs in with', () => {
    it('is the server’s for Google, its SHA-256 in hex for Apple', async () => {
        const nonce = randomBytes(32).toString('base64url');
        expect(await providerNonce('google', nonce, sha256)).toBe(nonce);
        expect(await providerNonce('apple', nonce, sha256)).toBe(createHash('sha256').update(nonce).digest('hex'));
    });
});

interface Account {
    readonly appUserId: string;
    readonly email: string;
    readonly name: string;
    banned: boolean;
}

/**
 * A workspace that answers as the server's routes do: `social/start` issues single-use nonces (a
 * link's bound to its session), `social/redeem` takes the token for a live sign-in nonce, finds the
 * account by the subject's link alone and sets the session cookie, and `social/link`, `links` and
 * `DELETE link/:provider` work on the session's account. The token's subject is its payload's
 * `sub` (the test token's); its nonce must be the start's, hashed for Apple.
 */
function workspace() {
    const ada: Account = { appUserId: 'u-ada', email: 'ada@example.test', name: 'Ada', banned: false };
    const sessions = new Map<string, Account>();
    const nonces = new Map<string, { provider: string; purpose: string; session: string | null; used: boolean }>();
    const links = new Map<string, { provider: string; sub: string; account: Account; email?: string }>();
    const bodies: unknown[] = [];
    const refuse: { start: string | null; redeem: string | null; link: string | null } = {
        start: null,
        redeem: null,
        link: null,
    };
    let issued = 0;
    const STATUS: Record<string, number> = {
        not_linked: 404,
        invalid_token: 401,
        nonce_invalid: 401,
        not_authorized: 401,
        method_off: 403,
        deactivated: 403,
        too_many: 429,
        provider_unavailable: 503,
        already_linked_other: 409,
        last_method: 409,
    };
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(T0), headers: { 'content-type': 'application/json' }, setCookie, body });
    const refusal = (code: string) => json(STATUS[code] ?? 400, { error: 'Server words, never shown.', code });
    const payloadOf = (idToken: string) =>
        JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as { sub: string; nonce: string };
    const tokenNonce = (provider: string, nonce: string) =>
        provider === 'apple' ? createHash('sha256').update(nonce).digest('hex') : nonce;
    const fetch = fakeFetch((url: string, init: FetchRequestInit) => {
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const signedIn = cookie === undefined ? undefined : sessions.get(cookie);
        const body = init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, string>);
        bodies.push(body);
        if (path === SOCIAL_START_PATH) {
            const parsed = socialStartBodySchema.parse(body);
            if (refuse.start !== null) {
                return refusal(refuse.start);
            }
            if (parsed.purpose === 'link' && signedIn === undefined) {
                return refusal('not_authorized');
            }
            const nonce = randomBytes(32).toString('base64url');
            nonces.set(nonce, {
                provider: parsed.provider,
                purpose: parsed.purpose,
                session: parsed.purpose === 'link' ? (cookie ?? null) : null,
                used: false,
            });
            return json(200, {
                nonce,
                expiresAt: new Date(T0 + 300_000).toISOString(),
                ...(parsed.provider === 'google' ? { serverClientId: SERVER_CLIENT_ID } : {}),
            });
        }
        const verified = (provider: string, idToken: string, nonce: string, purpose: string) => {
            const entry = nonces.get(nonce);
            if (!entry || entry.used || entry.provider !== provider || entry.purpose !== purpose) {
                return null;
            }
            if (purpose === 'link' && entry.session !== cookie) {
                return null;
            }
            const payload = payloadOf(idToken);
            if (payload.nonce !== tokenNonce(provider, nonce)) {
                return null;
            }
            entry.used = true;
            return payload.sub;
        };
        if (path === SOCIAL_REDEEM_PATH) {
            const parsed = socialRedeemBodySchema.parse(body);
            if (refuse.redeem !== null) {
                return refusal(refuse.redeem);
            }
            const sub = verified(parsed.provider, parsed.idToken, parsed.nonce, 'signin');
            if (sub === null) {
                return refusal('nonce_invalid');
            }
            const link = links.get(`${parsed.provider}:${sub}`);
            if (!link) {
                return refusal('not_linked');
            }
            if (link.account.banned) {
                return refusal('deactivated');
            }
            issued += 1;
            const token = `tok${issued}.c2ln`;
            sessions.set(token, link.account);
            return json(200, { deviceId: `dev-${issued}` }, [sessionSetCookie(token)]);
        }
        if (path === SESSION_PATH) {
            return json(200, {
                provider: 'betterauth',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                user: signedIn === undefined ? null : { id: signedIn.appUserId, name: signedIn.name, role: 'member' },
            });
        }
        if (path === AUTH_SESSION_PATH) {
            return json(200, signedIn === undefined ? null : { session: {}, user: { email: signedIn.email } });
        }
        if (path === LOGOUT_PATH) {
            if (cookie !== undefined) {
                sessions.delete(cookie);
            }
            return json(200, { ok: true }, [sessionSetCookie('', 0)]);
        }
        if (signedIn === undefined) {
            return refusal('not_authorized');
        }
        if (path === SOCIAL_LINK_PATH && init.method === 'POST') {
            const parsed = socialLinkBodySchema.parse(body);
            if (refuse.link !== null) {
                return refusal(refuse.link);
            }
            const sub = verified(parsed.provider, parsed.idToken, parsed.nonce, 'link');
            if (sub === null) {
                return refusal('nonce_invalid');
            }
            const key = `${parsed.provider}:${sub}`;
            const existing = links.get(key);
            if (existing && existing.account !== signedIn) {
                return refusal('already_linked_other');
            }
            links.set(key, { provider: parsed.provider, sub, account: signedIn, email: `${sub}@example.test` });
            return json(200, {
                provider: parsed.provider,
                linkedAt: new Date(T0).toISOString(),
                email: `${sub}@example.test`,
            });
        }
        if (path === SOCIAL_LINKS_PATH) {
            return json(
                200,
                [...links.values()]
                    .filter((link) => link.account === signedIn)
                    .map((link) => ({
                        provider: link.provider,
                        linkedAt: new Date(T0).toISOString(),
                        email: link.email,
                    })),
            );
        }
        if (path.startsWith(`${SOCIAL_LINK_PATH}/`) && init.method === 'DELETE') {
            const provider = path.slice(SOCIAL_LINK_PATH.length + 1);
            const mine = [...links.entries()].filter(([, link]) => link.account === signedIn);
            const found = mine.find(([, link]) => link.provider === provider);
            if (!found) {
                return refusal('not_linked');
            }
            if (refuse.link === 'last_method') {
                return refusal('last_method');
            }
            links.delete(found[0]);
            return json(200, { ok: true });
        }
        return json(404, { error: 'Not found.' });
    });
    return {
        fetch,
        ada,
        sessions,
        nonces,
        links,
        bodies,
        refuse,
        /** Links `provider`'s subject `sub` to Ada, as a link made earlier did. */
        link(provider: string, sub: string) {
            links.set(`${provider}:${sub}`, { provider, sub, account: ada });
        },
        /** A signed-in jar's session cookie for Ada. */
        session() {
            issued += 1;
            const token = `tok${issued}.c2ln`;
            sessions.set(token, ada);
            return token;
        },
    };
}

let device: Phone;
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-social-')));
    logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(device.root, { recursive: true, force: true });
});

/** Every byte the phone holds, and every log line. */
function everything(): string {
    const files = readdirSync(device.root, { recursive: true, encoding: 'utf8' })
        .map((path) => join(device.root, path))
        .filter((path) => statSync(path).isFile())
        .map((path) => readFileSync(path).toString('latin1'));
    return [...files, ...device.keychain.values(), JSON.stringify(logs.map((spy) => spy.mock.calls))].join('\n');
}

const deps = (store: SignInFlowDeps['store'], server: ReturnType<typeof workspace>) => ({
    store,
    hash: sha256,
    sha256Hex: sha256,
    fetch: server.fetch,
    userAgent: USER_AGENT,
    now: () => T0,
    randomBytes: nodeBytes,
});

/** The test account's token for what the phone's sign-in was asked, and what it was asked. */
function testAccount(account: string, seen: TokenRequest[] = []): ObtainToken {
    return async (request) => {
        seen.push(request);
        return {
            kind: 'token',
            idToken: testIdToken({ variant: 'development', provider: request.provider, account, nonce: request.nonce }),
        };
    };
}

const request = (provider: 'google' | 'apple', obtain: ObtainToken) => ({
    origin: ORIGIN,
    provider,
    logo: null,
    manifest: manifest(['google', 'apple']),
    platform: 'android' as const,
    label: 'Socio app on Android',
    variant: 'development' as const,
    obtain,
});

describe('signing in with Google or Apple', { timeout: 20_000 }, () => {
    it.each(['google', 'apple'] as const)('%s: a linked account signs in and commits', async (provider) => {
        const server = workspace();
        server.link(provider, 'ada-test');
        const { store } = await launch(device, { now: () => T0 });
        const seen: TokenRequest[] = [];
        const outcome = await signInWithSocial(request(provider, testAccount('ada-test', seen)), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'signed', outcome: { kind: 'committed', committed: 'new' } });
        // The phone's sign-in got the start's nonce (Apple's hashed) and, for Google only, the audience.
        const [start] = [...server.nonces.keys()];
        expect(seen).toEqual([
            {
                provider,
                nonce: provider === 'apple' ? createHash('sha256').update(start!).digest('hex') : start,
                serverClientId: provider === 'google' ? SERVER_CLIENT_ID : null,
            },
        ]);
        // The start carried no session and no install id; the redeem, a fresh install id in both places.
        const startCall = server.fetch.calls.find((call) => call.url.endsWith(SOCIAL_START_PATH));
        expect(sentHeaders(startCall).cookie).toBeUndefined();
        expect(
            sentHeaders(startCall)[INSTALL_HEADER.toLowerCase()] ?? sentHeaders(startCall)[INSTALL_HEADER],
        ).toBeUndefined();
        const redeem = server.fetch.calls.find((call) => call.url.endsWith(SOCIAL_REDEEM_PATH));
        const body = socialRedeemBodySchema.parse(JSON.parse(String(redeem?.init.body)));
        expect(body).toMatchObject({ provider, nonce: start, platform: 'android', variant: 'development' });
        expect(idTokenSchema.safeParse(body.idToken).success).toBe(true);
        const rows = await store.registry.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ origin: ORIGIN, personEmail: 'ada@example.test', state: 'ready' });
    });

    it('a cancel in the phone’s sheet shows nothing and sends nothing after the start', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInWithSocial(
            request('google', async () => ({ kind: 'cancelled' })),
            deps(store, server),
        );
        expect(outcome).toEqual({ kind: 'cancelled' });
        expect(server.fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([SOCIAL_START_PATH]);
        expect(await store.registry.list()).toEqual([]);
    });

    describe('going back aborts it: nothing commits, and a session the server gave is signed out', () => {
        const paths = (server: ReturnType<typeof workspace>) =>
            server.fetch.calls.map((call) => new URL(call.url).pathname);

        it('before the redeem: none is sent', async () => {
            const server = workspace();
            server.link('google', 'ada-test');
            const { store } = await launch(device, { now: () => T0 });
            const back = new AbortController();
            const obtain: ObtainToken = async (asked) => {
                const token = await testAccount('ada-test')(asked);
                back.abort();
                return token;
            };
            await expect(
                signInWithSocial({ ...request('google', obtain), signal: back.signal }, deps(store, server)),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(paths(server)).toEqual([SOCIAL_START_PATH]);
            expect(server.sessions.size).toBe(0);
            expect(await store.registry.list()).toEqual([]);
        });

        it('during the redeem: it stops, and with no answer there is no session to sign out', async () => {
            const server = workspace();
            server.link('google', 'ada-test');
            const { store } = await launch(device, { now: () => T0 });
            const back = new AbortController();
            const sent: string[] = [];
            const fetch: FetchFunction = (url, init) => {
                sent.push(new URL(url).pathname);
                if (url.endsWith(SOCIAL_REDEEM_PATH)) {
                    // The person goes back while the redeem is on its way: it never answers.
                    back.abort();
                    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
                }
                return server.fetch(url, init);
            };
            await expect(
                signInWithSocial(
                    { ...request('google', testAccount('ada-test')), signal: back.signal },
                    { ...deps(store, server), fetch },
                ),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(sent).toEqual([SOCIAL_START_PATH, SOCIAL_REDEEM_PATH]);
            expect(server.sessions.size).toBe(0);
            expect(await store.registry.list()).toEqual([]);
        });

        it('after the redeem’s answer, before the commit: no commit, and the staged session is signed out', async () => {
            const server = workspace();
            server.link('google', 'ada-test');
            const { store } = await launch(device, { now: () => T0 });
            const back = new AbortController();
            const byOrigin = store.registry.byOrigin.bind(store.registry);
            // The person check reads the registry once the sign-in is staged: going back lands there.
            vi.spyOn(store.registry, 'byOrigin').mockImplementation(async (origin) => {
                if (paths(server).includes(SOCIAL_REDEEM_PATH)) {
                    back.abort();
                }
                return byOrigin(origin);
            });
            await expect(
                signInWithSocial(
                    { ...request('google', testAccount('ada-test')), signal: back.signal },
                    deps(store, server),
                ),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(paths(server)).toContain(SOCIAL_REDEEM_PATH);
            const logout = server.fetch.calls.find((call) => call.url.endsWith(LOGOUT_PATH));
            expect(sentHeaders(logout).cookie).toMatch(/tok1\.c2ln/);
            expect(server.sessions.size).toBe(0);
            expect(await store.registry.list()).toEqual([]);
        });
    });

    it.each([
        ['no-account', { kind: 'no-account' } as const],
        ['unavailable', { kind: 'unavailable', reason: 'provider' } as const],
        ['failed', { kind: 'failed', reason: 'gid--4' } as const],
    ])('the phone’s sign-in %s is said, and nothing is redeemed', async (_, failure) => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInWithSocial(
            request('google', async () => failure),
            deps(store, server),
        );
        expect(outcome).toEqual({ kind: 'native', failure });
        expect(server.fetch.calls).toHaveLength(1);
    });

    it.each([
        ['not_linked', 'not-linked', (p: 'google' | 'apple') => notLinkedLine(p)],
        ['invalid_token', 'invalid-token', (p: 'google' | 'apple') => invalidTokenLine(p)],
        ['nonce_invalid', 'nonce-invalid', () => NONCE_LINE],
        ['not_authorized', 'not-authorized', () => START_AGAIN_LINE],
        ['method_off', 'social-off', (p: 'google' | 'apple') => methodOffLine(p)],
        ['deactivated', 'deactivated', () => DEACTIVATED_MESSAGE],
        ['too_many', 'rate-limited', () => tooManyLine()],
        ['provider_unavailable', 'provider-unavailable', (p: 'google' | 'apple') => unavailableLine(p)],
    ] as const)('the redeem’s %s is worded by its code, never the server’s text', async (code, kind, line) => {
        for (const provider of ['google', 'apple'] as const) {
            const server = workspace();
            server.refuse.redeem = code;
            const { store } = await launch(device, { now: () => T0 });
            const outcome = await signInWithSocial(request(provider, testAccount('ada-test')), deps(store, server));
            expect(outcome).toMatchObject({ kind: 'signed', outcome: { kind: 'problem', problem: { kind, code } } });
            const problem = (outcome as { outcome: Extract<SignInOutcome, { kind: 'problem' }> }).outcome.problem;
            expect(socialSignInLine(provider, problem)).toBe(line(provider));
            expect(socialSignInLine(provider, problem)).not.toContain('Server words');
            expect(await store.registry.list()).toEqual([]);
            await kill(store);
        }
    });

    it('the given words for not_linked and provider_unavailable', () => {
        expect(notLinkedLine('google')).toBe(
            'No Socio account uses this Google account. Sign in another way, then link it in Settings → Account.',
        );
        expect(notLinkedLine('apple')).toBe(
            'No Socio account uses this Apple account. Sign in another way, then link it in Settings → Account.',
        );
        expect(unavailableLine('google')).toBe("Google sign-in isn't available right now. Sign in another way.");
        expect(unavailableLine('apple')).toBe("Apple sign-in isn't available right now. Sign in another way.");
    });

    it('an account nobody linked is not_linked: no email is ever matched', async () => {
        const server = workspace();
        // ada@example.test is Ada's email, but no link names this subject.
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInWithSocial(request('google', testAccount('ada')), deps(store, server));
        expect(outcome).toMatchObject({
            kind: 'signed',
            outcome: { kind: 'problem', problem: { kind: 'not-linked' } },
        });
    });

    it('a start the server refuses is said by its code', async () => {
        for (const [code, line] of [
            ['method_off', methodOffLine('apple')],
            ['provider_unavailable', unavailableLine('apple')],
            ['too_many', tooManyLine()],
        ] as const) {
            const server = workspace();
            server.refuse.start = code;
            const { store } = await launch(device, { now: () => T0 });
            const outcome = await signInWithSocial(request('apple', testAccount('ada-test')), deps(store, server));
            expect(outcome.kind).toBe('start-refused');
            if (outcome.kind === 'start-refused') {
                expect(socialProblemLine('apple', outcome.problem, 'signin')).toBe(line);
            }
        }
    });

    it('the nonce, the token and the server client id are in no log, problem, outcome or stored byte', async () => {
        const secrets: string[] = [SERVER_CLIENT_ID];
        const outcomes: unknown[] = [];
        for (const redeem of ['not_linked', 'deactivated', null] as const) {
            const server = workspace();
            server.link('google', 'ada-test');
            server.refuse.redeem = redeem;
            const { store } = await launch(device, { now: () => T0 });
            const seen: TokenRequest[] = [];
            const obtain: ObtainToken = async (asked) => {
                const token = await testAccount('ada-test', seen)(asked);
                if (token.kind === 'token') {
                    secrets.push(token.idToken);
                }
                return token;
            };
            outcomes.push(await signInWithSocial(request('google', obtain), deps(store, server)));
            secrets.push(...server.nonces.keys(), ...seen.map((asked) => asked.nonce));
        }
        expect(outcomes.map((outcome) => (outcome as { outcome: { kind: string } }).outcome.kind)).toEqual([
            'problem',
            'problem',
            'committed',
        ]);
        const seen = `${everything()}\n${JSON.stringify(outcomes)}`;
        for (const secret of secrets) {
            expect(seen).not.toContain(secret);
        }
    });
});

describe('linking and unlinking, signed in', () => {
    async function signedInFetch(server: ReturnType<typeof workspace>) {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        await jar.apply(new URL(ORIGIN), [sessionSetCookie(server.session())], httpDate(T0));
        return createAuthedFetch({
            origin: ORIGIN,
            jar,
            fetch: server.fetch,
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
        });
    }

    it.each(['google', 'apple'] as const)('%s: links with a nonce bound to this session', async (provider) => {
        const server = workspace();
        const fetch = await signedInFetch(server);
        const outcome = await linkWithSocial({ fetch, provider, obtain: testAccount('ada-test'), sha256Hex: sha256 });
        expect(outcome).toEqual({
            kind: 'linked',
            link: { provider, linkedAt: new Date(T0).toISOString(), email: 'ada-test@example.test' },
        });
        expect(await readSocialLinks(fetch)).toMatchObject({ kind: 'links', links: [{ provider }] });
        expect(await unlinkSocial(fetch, provider)).toEqual({ ok: true });
        // Already gone is unlinked as asked.
        expect(await unlinkSocial(fetch, provider)).toEqual({ ok: true });
        expect(server.fetch.calls.at(-1)?.url).toBe(`${ORIGIN}${socialUnlinkPath(provider)}`);
    });

    it('words each link refusal by its code', async () => {
        for (const [code, line] of [
            ['already_linked_other', alreadyLinkedOtherLine('google')],
            ['method_off', 'Linking Google is turned off for this workspace.'],
            ['invalid_token', invalidTokenLine('google')],
            ['provider_unavailable', "Google isn't available right now. Try again later."],
        ] as const) {
            const server = workspace();
            server.refuse.link = code;
            const fetch = await signedInFetch(server);
            const outcome = await linkWithSocial({
                fetch,
                provider: 'google',
                obtain: testAccount('x'),
                sha256Hex: sha256,
            });
            expect(outcome.kind).toBe('refused');
            if (outcome.kind === 'refused') {
                expect(socialProblemLine('google', outcome.problem, 'link')).toBe(line);
            }
        }
    });

    it('a Google account already linked to someone else is refused', async () => {
        const server = workspace();
        server.links.set('google:bob-test', {
            provider: 'google',
            sub: 'bob-test',
            account: { appUserId: 'u-bob', email: 'bob@example.test', name: 'Bob', banned: false },
        });
        const fetch = await signedInFetch(server);
        const outcome = await linkWithSocial({
            fetch,
            provider: 'google',
            obtain: testAccount('bob-test'),
            sha256Hex: sha256,
        });
        expect(outcome).toMatchObject({ kind: 'refused', problem: { kind: 'already-linked-other', status: 409 } });
    });

    it('the only way in is never unlinked, and says so', async () => {
        const server = workspace();
        server.link('apple', 'ada-test');
        server.refuse.link = 'last_method';
        const fetch = await signedInFetch(server);
        const done = await unlinkSocial(fetch, 'apple');
        expect(done).toMatchObject({ ok: false, problem: { kind: 'last-method', status: 409 } });
        if (!done.ok) {
            expect(socialProblemLine('apple', done.problem, 'unlink')).toBe(LAST_METHOD);
        }
        expect(LAST_METHOD).toMatch(/^It's your only way to sign in/);
        expect(unlinkQuestion('apple')).toMatchObject({ title: 'Unlink Apple?', confirm: 'Unlink', cancel: 'Cancel' });
    });

    it('an older server without the links is unsupported, and the section hides', async () => {
        const fetch = createAuthedFetch({
            origin: ORIGIN,
            jar: await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 }),
            fetch: fakeFetch(() => answer(404, { body: { error: 'Not found.' } })),
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
        });
        expect(await readSocialLinks(fetch)).toEqual({ kind: 'unsupported' });
    });
});

describe('the development test token', () => {
    it('is made in development builds only', () => {
        expect(testAccountsIn('development')).toBe(true);
        for (const variant of ['preview', 'production', 'anything']) {
            expect(testAccountsIn(variant)).toBe(false);
            expect(() => testIdToken({ variant, provider: 'google', account: 'ada', nonce: 'n' })).toThrow(
                /development builds only/,
            );
        }
        const token = testIdToken({ variant: 'development', provider: 'apple', account: 'Ada-Test', nonce: 'abc' });
        expect(idTokenSchema.safeParse(token).success).toBe(true);
        expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
            sub: 'ada-test',
            nonce: 'abc',
            aud: 'apple',
        });
        expect(() =>
            testIdToken({ variant: 'development', provider: 'google', account: 'no spaces', nonce: 'n' }),
        ).toThrow();
    });

    it('is offered only where the build is development: the binding and the screens read testAccountsIn', () => {
        const app = join(import.meta.dirname, '..');
        const binding = readFileSync(join(app, 'src/platform/social-sign-in.ts'), 'utf8');
        expect(binding).toContain('export const TEST_ACCOUNTS = testAccountsIn(BUILD_VARIANT);');
        expect(binding).toMatch(/testAccount !== null && TEST_ACCOUNTS/);
        for (const screen of ['src/screens/sign-in.tsx', 'src/screens/sign-in-methods.tsx']) {
            const source = readFileSync(join(app, screen), 'utf8');
            expect(source).toMatch(/\{TEST_ACCOUNTS && /);
        }
    });
});

describe('the phone’s own answers', () => {
    it('maps socio-google-signin’s', () => {
        expect(googleToken({ type: 'success', idToken: 'a.b.c' })).toEqual({ kind: 'token', idToken: 'a.b.c' });
        expect(googleToken({ type: 'success' })).toEqual({ kind: 'failed', reason: 'no-token' });
        expect(googleToken({ type: 'cancel' })).toEqual({ kind: 'cancelled' });
        expect(googleToken({ type: 'no-account' })).toEqual({ kind: 'no-account' });
        expect(googleToken({ type: 'unavailable', reason: 'provider' })).toEqual({
            kind: 'unavailable',
            reason: 'provider',
        });
        expect(googleToken({ type: 'failed', reason: 'a sentence with spaces' })).toEqual({
            kind: 'failed',
            reason: 'native',
        });
    });

    it('maps expo-apple-authentication’s, its Cancel by code', async () => {
        expect(await appleToken(async () => ({ identityToken: 'a.b.c' }))).toEqual({ kind: 'token', idToken: 'a.b.c' });
        expect(await appleToken(async () => ({ identityToken: null }))).toEqual({ kind: 'failed', reason: 'no-token' });
        const rejecting = (code: string) => async () => {
            throw Object.assign(new Error('The user canceled.'), { code });
        };
        expect(await appleToken(rejecting('ERR_REQUEST_CANCELED'))).toEqual({ kind: 'cancelled' });
        expect(await appleToken(rejecting('ERR_REQUEST_FAILED'))).toEqual({
            kind: 'failed',
            reason: 'ERR_REQUEST_FAILED',
        });
    });
});
