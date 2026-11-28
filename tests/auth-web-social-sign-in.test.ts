// Google and Apple on the website, through Socio's sign-in page
// (memos/proposals/cloud/AUTH-WEB-SOCIAL.md). The server starts the flow
// with a nonce bound to this browser by a cookie, the cloud (a fake issuer
// in memory, through the real cloud connection) makes the page and later
// redeems the browser's result for a signed statement. A sign-in finds its
// account only by an existing link and makes a web session; a link is made
// only for the session that started it.
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { workspaceManifestSchema } from '@socio/shared/device-sign-in';

import type { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { WEB_SOCIAL_PENDING_MAX, safeNext } from '../src/server/auth/web-social-sign-in.js';
import { cloudService, socialVerification } from '../src/server/cloud/layer.js';
import { cloudFromEnv } from '../src/server/cloud/settings.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { AUTH_PAGE, fakeIssuer, ISSUER, type FakeIssuer } from './fixtures/fake-cloud-issuer.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'https://brain.example.test';
const PASSWORD = 'correct-horse-battery';
const START = '/api/auth/web/social/start';
const CALLBACK = '/api/auth/web/social/callback';
const COMPLETE = '/api/auth/web/social/complete';
const unescapeHtml = (text: string) =>
    text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
const BINDING = '__Host-socio-social';
const SESSION = '__Host-cb.session_token';
const WEB_CONFIG = { google: { serverClientId: 'test-web-client.apps.example.test', web: true }, apple: { web: true } };

/**
 * A browser's cookies, with its SameSite rules: a cross-site request (the
 * return from Socio's sign-in page, a top-level GET) carries Lax and None
 * cookies, never Strict ones, so no test can pass by sending everything.
 */
class Jar {
    cookies = new Map<string, string>();
    /** Each cookie's SameSite, as set (Lax when it says none, as browsers default). */
    sameSite = new Map<string, 'strict' | 'lax' | 'none'>();
    store(response: Response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1);
            if (!value || /max-age=0/i.test(header)) {
                this.cookies.delete(name);
                this.sameSite.delete(name);
            } else {
                this.cookies.set(name, value);
                const mode = /;\s*samesite=(strict|lax|none)/i.exec(header)?.[1]?.toLowerCase();
                this.sameSite.set(name, (mode as 'strict' | 'lax' | 'none' | undefined) ?? 'lax');
            }
        }
        return response;
    }
    /** The Cookie header for a request from this origin, or a top-level GET from another site. */
    headerFor(site: 'same-origin' | 'cross-site') {
        return [...this.cookies]
            .filter(([name]) => site === 'same-origin' || this.sameSite.get(name) !== 'strict')
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
    get header() {
        return this.headerFor('same-origin');
    }
}

const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

const cleanups: (() => void | Promise<void>)[] = [];
let logs: string[] = [];
beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

/** The cloud connection, enrolled with the fake issuer, as the composition makes it. */
async function cloudSocial(issuer: FakeIssuer, dir: string, enroll: boolean) {
    const store = new Store(testDatabaseFile(join(dir, 'workspace.db')));
    cleanups.push(() => store.close());
    const { token } = issuer.provision();
    const config = {
        cloud: cloudFromEnv({ SOCIO_CLOUD_ISSUER: ISSUER, ...(enroll ? { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } : {}) }),
    };
    const cloud = cloudService({
        config,
        settings: store,
        secrets: store,
        releases: { data: () => ({ version: '0.55.0', commit: 'abc', releases: [] }) },
        host: {
            box: new SecretBox({ current: new Uint8Array(32).fill(7), legacy: SECRET }, 'settings-secrets'),
            origin: ORIGIN,
            notifyAdmins: async () => {},
        },
        transport: issuer.fetch,
    });
    await cloud.work();
    return socialVerification({ config, cloud, transport: issuer.fetch });
}

async function brain(options: { config?: Record<string, unknown>; enroll?: boolean; scopes?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-web-social-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, AUTH_TRUST_PROXY: 'true' },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const provider = auth.provider as BetterAuthProvider;
    const { app, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        app: { config: { mode: 'live' as const, baseUrl: 'https://model.invalid' }, origin: [ORIGIN], auth },
    });
    const issuer = fakeIssuer();
    issuer.scopes = options.scopes ?? 'reports:write social:verify';
    issuer.socialConfig = options.config ?? WEB_CONFIG;
    provider.useSocialVerifier(await cloudSocial(issuer, dir, options.enroll ?? true));
    const db = new DatabaseSync(path);
    cleanups.push(async () => {
        db.close();
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    const call = async (
        jar: Jar,
        path: string,
        init: {
            body?: unknown;
            headers?: Record<string, string>;
            ip?: string;
            /** Where the request comes from, as a browser says and decides its cookies by. */
            site?: 'same-origin' | 'cross-site';
        } = {},
    ) => {
        const site = init.site ?? 'same-origin';
        const cookie = jar.headerFor(site);
        return jar.store(
            await app.request(path, {
                method: init.body === undefined ? 'GET' : 'POST',
                headers: {
                    'x-forwarded-for': init.ip ?? `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
                    'sec-fetch-site': site,
                    ...(init.body === undefined ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
                    ...(cookie ? { cookie } : {}),
                    ...init.headers,
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            }),
        );
    };
    const account = async (email: string, name: string) => {
        await provider.createAccount({ email, name, role: 'member', password: PASSWORD });
        return db.prepare('SELECT id FROM auth_user WHERE email = ?').get(email) as { id: string };
    };
    const signIn = async (email: string) => {
        const jar = new Jar();
        const response = await call(jar, '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
        expect(response.status).toBe(200);
        return jar;
    };
    /** A link as the app makes one, straight in the database. */
    const linkRow = (accountId: string, provider: 'google' | 'apple', sub: string) =>
        db
            .prepare(
                'INSERT INTO auth_account(id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
                randomBytes(8).toString('hex'),
                sub,
                `${provider}-native`,
                accountId,
                new Date().toISOString(),
                new Date().toISOString(),
            );
    const start = async (
        jar: Jar,
        provider: 'google' | 'apple',
        purpose: 'signin' | 'link' = 'signin',
        next?: string,
        ip?: string,
    ) => {
        const response = await call(jar, START, {
            body: { provider, purpose, ...(next === undefined ? {} : { next }) },
            ip,
        });
        return { response, body: (await response.json()) as { url?: string; code?: string; error?: string } };
    };
    /** The browser's return from Socio's sign-in page: a top-level navigation from another site. */
    const landing = (jar: Jar, query: string) =>
        call(jar, `${CALLBACK}?${query}`, { site: 'cross-site', headers: { 'sec-fetch-mode': 'navigate' } });
    /**
     * The browser's return: the cross-site GET (Strict cookies withheld)
     * answers a page of this origin, whose form the browser sends on, from
     * this origin, with every cookie. The page's last answer.
     */
    const back = async (jar: Jar, query: string) => {
        const page = await landing(jar, query);
        expect(page.status).toBe(200);
        const html = await page.text();
        const form = /<form id="continue" method="get" action="([^"]+)">/.exec(html);
        expect(form?.[1]).toBe(COMPLETE);
        const fields = new URLSearchParams(
            [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(
                ([, name, value]) => [name!, unescapeHtml(value!)] as [string, string],
            ),
        );
        return call(jar, `${COMPLETE}?${fields}`, { headers: { 'sec-fetch-mode': 'navigate' } });
    };
    /** Start, sign in at the provider as `sub`, and come back. */
    const flow = async (
        jar: Jar,
        provider: 'google' | 'apple',
        sub: string,
        options: { purpose?: 'signin' | 'link'; next?: string } = {},
    ) => {
        const { response, body } = await start(jar, provider, options.purpose, options.next);
        expect(response.status).toBe(200);
        const r = issuer.completeWeb(body.url!, sub);
        return { r, response: await back(jar, `r=${r}`) };
    };
    const signedIn = async (jar: Jar) =>
        ((await (await call(jar, '/api/auth/session')).json()) as { user: { id: string } | null }).user;
    const savePolicy = (policy: Record<string, unknown>) => {
        db.prepare(
            `INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 1, ?, ?, 'test')
             ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, version = version + 1`,
        ).run(JSON.stringify(policy), Date.now());
    };
    const methods = async () =>
        ((await (await call(new Jar(), '/api/auth/session')).json()) as { methods: { social?: string[] } }).methods;
    const manifest = async () =>
        workspaceManifestSchema.parse(await (await app.request('/.well-known/socio/workspace')).json());
    return {
        app,
        provider,
        issuer,
        db,
        call,
        account,
        signIn,
        linkRow,
        start,
        back,
        landing,
        flow,
        signedIn,
        savePolicy,
        methods,
        manifest,
    };
}
type Brain = Awaited<ReturnType<typeof brain>>;

const location = (response: Response) => {
    const to = new URL(response.headers.get('location')!);
    expect(to.origin).toBe(ORIGIN);
    return to;
};

async function adaLinked(b: Brain, provider: 'google' | 'apple' = 'google') {
    const ada = await b.account('ada@example.com', 'Ada');
    b.linkRow(ada.id, provider, `${provider}-sub-ada`);
    return ada;
}

describe('start', () => {
    it('answers the cloud’s page and sets a binding cookie whose hash alone is stored with the nonce', async () => {
        const b = await brain();
        const jar = new Jar();
        const before = Date.now();
        const { response, body } = await b.start(jar, 'google', 'signin', '/spaces/1?tab=pages');
        expect(response.status).toBe(200);
        expect(body.url).toMatch(new RegExp(`^${AUTH_PAGE}/s\\?t=`));
        const cookie = response.headers.getSetCookie().find((header) => header.startsWith(`${BINDING}=`))!;
        // __Host-: no page on a subdomain can plant one (cookie tossing).
        expect(cookie).toMatch(/; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
        const binding = jar.cookies.get(BINDING)!;
        expect(Buffer.from(binding, 'base64url')).toHaveLength(32);
        const rows = b.db.prepare('SELECT * FROM auth_social_web_nonce').all() as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            provider: 'google',
            purpose: 'web-signin',
            sessionId: null,
            next: '/spaces/1?tab=pages',
            usedAt: null,
        });
        expect(Number(rows[0]!.expiresAt) - before).toBeGreaterThanOrEqual(10 * 60_000);
        expect(Number(rows[0]!.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
        expect(JSON.stringify(rows)).not.toContain(binding);
        // The issuer got the raw nonce, which the row holds only as a hash; no next, no return address.
        const sent = JSON.parse(b.issuer.requests.find((request) => request.path === '/v1/social/web/start')!.body);
        expect(Object.keys(sent).sort()).toEqual(['nonce', 'provider', 'purpose']);
        expect(sent).toMatchObject({ provider: 'google', purpose: 'signin' });
        expect(JSON.stringify(rows)).not.toContain(sent.nonce);
        // The app's nonces are another table, with their own 5 minutes.
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_social_nonce').get()).toEqual({ n: 0 });
    });

    it.each([
        ['an absolute URL', 'https://evil.example.com/'],
        ['a protocol-relative URL', '//evil.example.com/x'],
        ['a backslash', '/\\evil.example.com'],
        ['a backslash later on', '/x\\..\\y'],
        ['a scheme', 'javascript:alert(1)'],
        ['the API', '/api/auth/device/start'],
        ['a control character', '/x\ny'],
        ['nothing like a path', 'spaces'],
        // Normalized, these would be protocol-relative (`//evil…`): checked after normalizing.
        ['a dot segment before //', '/a/..//evil.example.com/path'],
        ['dot segments before //', '/a/b/../..//evil.example.com'],
        ['a percent-encoded //', '/%2F%2Fevil.example.com'],
        ['a percent-encoded backslash', '/%5Cevil.example.com'],
        ['mixed encodings', '/%2f%5cevil.example.com'],
        ['an encoded dot segment before //', '/a/%2e%2e//evil.example.com'],
    ])('stores / for %s as next', async (_, next) => {
        const b = await brain();
        const { response } = await b.start(new Jar(), 'google', 'signin', next);
        expect(response.status).toBe(200);
        expect(b.db.prepare('SELECT next FROM auth_social_web_nonce').get()).toEqual({ next: '/' });
    });

    it.each([
        '/a/..//evil.example.com/path',
        '/%2F%2Fevil.example.com',
        '/%5Cevil.example.com',
        '/a/%2e%2e//evil.example.com',
        '//evil.example.com',
        '/\\evil.example.com',
    ])('never makes %s a path that leaves the origin', (next) => {
        const kept = safeNext(next, ORIGIN);
        expect(new URL(kept, ORIGIN).origin).toBe(ORIGIN);
        expect(kept).toBe('/');
    });

    it('keeps a same-origin path, its query and fragment', () => {
        expect(safeNext('/connect/x?y=1#z', ORIGIN)).toBe('/connect/x?y=1#z');
        expect(safeNext('/a/../b', ORIGIN)).toBe('/b');
        expect(safeNext(undefined, ORIGIN, '/settings')).toBe('/settings');
    });

    it('refuses a sixth start a minute from one address', async () => {
        const b = await brain();
        for (let i = 0; i < 5; i++) {
            expect((await b.start(new Jar(), 'google', 'signin', undefined, '10.9.9.9')).response.status).toBe(200);
        }
        const refused = await b.start(new Jar(), 'google', 'signin', undefined, '10.9.9.9');
        expect(refused.response.status).toBe(429);
        expect(refused.response.headers.get('retry-after')).toBe('60');
        expect(refused.body).toMatchObject({ code: 'too_many' });
        expect((await b.start(new Jar(), 'google', 'signin', undefined, '10.9.9.10')).response.status).toBe(200);
    });

    it(`refuses a start beyond ${WEB_SOCIAL_PENDING_MAX} waiting flows, with no call to the cloud`, async () => {
        const b = await brain();
        const insert = b.db.prepare(
            "INSERT INTO auth_social_web_nonce(nonceHash, bindHash, provider, purpose, next, createdAt, expiresAt) VALUES (?, ?, 'google', 'web-signin', '/', ?, ?)",
        );
        // One transaction: 200 commits are slow on a loaded machine.
        b.db.exec('BEGIN');
        for (let i = 0; i < WEB_SOCIAL_PENDING_MAX; i++) {
            insert.run(`n${i}`, `b${i}`, Date.now(), Date.now() + 60_000);
        }
        b.db.exec('COMMIT');
        const refused = await b.start(new Jar(), 'apple');
        expect(refused.response.status).toBe(429);
        expect(refused.body).toMatchObject({ code: 'too_many' });
        expect(b.issuer.requests.some((request) => request.path === '/v1/social/web/start')).toBe(false);
        // Used ones don't count.
        b.db.prepare("UPDATE auth_social_web_nonce SET usedAt = 1 WHERE nonceHash = 'n0'").run();
        expect((await b.start(new Jar(), 'apple')).response.status).toBe(200);
    });

    it('maps the cloud’s refusals: origin or provider unavailable, and its Retry-After', async () => {
        const b = await brain();
        const answer =
            (status: number, body: unknown, headers: Record<string, string> = {}) =>
            () =>
                new Response(JSON.stringify(body), {
                    status,
                    headers: { 'content-type': 'application/json', ...headers },
                });
        for (const [status, error] of [
            [409, 'origin_unavailable'],
            [422, 'provider_unavailable'],
        ] as const) {
            b.issuer.socialWebStart = answer(status, { error });
            const refused = await b.start(new Jar(), 'google');
            expect(refused.response.status).toBe(503);
            expect(refused.body).toMatchObject({ code: 'provider_unavailable' });
        }
        b.issuer.socialWebStart = answer(429, { error: 'rate_limited' }, { 'retry-after': '42' });
        const limited = await b.start(new Jar(), 'google');
        expect(limited.response.status).toBe(429);
        expect(limited.response.headers.get('retry-after')).toBe('42');
        expect(limited.response.headers.getSetCookie()).toEqual([]);
        // A start that went nowhere leaves nothing waiting.
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_social_web_nonce').get()).toEqual({ n: 0 });
    });

    it('refuses a link without a session, a provider the policy turned off, and a bad body', async () => {
        const b = await brain();
        expect((await b.start(new Jar(), 'google', 'link')).body).toMatchObject({ code: 'not_authorized' });
        b.savePolicy({ apple: false });
        expect((await b.start(new Jar(), 'apple')).body).toMatchObject({ code: 'method_off' });
        const bad = await b.call(new Jar(), START, { body: { provider: 'github', purpose: 'signin' } });
        expect(bad.status).toBe(400);
    });
});

describe('sign-in', () => {
    it.each(['google', 'apple'] as const)(
        'signs a linked person in with %s: a web session with that method, then next',
        async (provider) => {
            const b = await brain();
            const ada = await adaLinked(b, provider);
            const jar = new Jar();
            const { response } = await b.flow(jar, provider, `${provider}-sub-ada`, { next: '/spaces/1?tab=pages' });
            expect(response.status).toBe(302);
            expect(location(response).pathname + location(response).search).toBe('/spaces/1?tab=pages');
            expect(jar.cookies.has(BINDING)).toBe(false);
            expect(jar.cookies.has(SESSION)).toBe(true);
            expect(await b.signedIn(jar)).not.toBeNull();
            const sessions = b.db
                .prepare('SELECT signInMethod, deviceId FROM auth_session WHERE userId = ?')
                .all(ada.id) as { signInMethod: string; deviceId: string | null }[];
            expect(sessions).toEqual([{ signInMethod: provider, deviceId: null }]);
            expect(logs.join('\n')).not.toMatch(/sub-ada|ada@example/);
        },
    );

    it('finds no account by email and makes none: not_linked', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const jar = new Jar();
        const { response } = await b.flow(jar, 'google', 'google-sub-stranger');
        const to = location(response);
        expect(to.pathname).toBe('/');
        expect(to.searchParams.get('error')).toBe('social_not_linked');
        expect(jar.cookies.has(SESSION)).toBe(false);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_user').get()).toEqual({ n: 1 });
    });

    it('refuses a result without this browser’s cookie, or with another browser’s (login CSRF)', async () => {
        const b = await brain();
        await adaLinked(b);
        // The attacker starts and finishes a flow as themselves, then hands the result to a victim.
        const attacker = new Jar();
        const { body } = await b.start(attacker, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const victim = new Jar();
        const bare = await b.back(victim, `r=${r}`);
        expect(location(bare).searchParams.get('error')).toBe('social_nonce_invalid');
        // A victim with a flow of their own: the result names the attacker's nonce, not theirs.
        await b.start(victim, 'google');
        const crossed = await b.back(victim, `r=${r}`);
        expect(location(crossed).searchParams.get('error')).toBe('social_nonce_invalid');
        expect(victim.cookies.has(SESSION)).toBe(false);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 0 });
    });

    it('refuses a statement for another nonce or another provider', async () => {
        const b = await brain();
        await adaLinked(b);
        for (const extra of [{ nonce: 'x'.repeat(43) }, { provider: 'apple' }]) {
            const jar = new Jar();
            const { body } = await b.start(jar, 'google');
            const r = b.issuer.completeWeb(body.url!, 'google-sub-ada', extra);
            const response = await b.back(jar, `r=${r}`);
            expect(location(response).searchParams.get('error')).toMatch(/^social_(nonce_invalid|failed)$/);
            expect(jar.cookies.has(SESSION)).toBe(false);
        }
    });

    it('refuses a statement for another deployment', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada', { aud: 'dep_SOMEONEELSE' });
        const response = await b.back(jar, `r=${r}`);
        expect(location(response).searchParams.get('error')).toBe('social_failed');
        expect(jar.cookies.has(SESSION)).toBe(false);
    });

    it('answers nonce_invalid for a replayed result', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const binding = jar.cookies.get(BINDING)!;
        expect(location(await b.back(jar, `r=${r}`)).searchParams.get('error')).toBeNull();
        // The same browser cookie and result again: the issuer's 422, and the nonce used.
        const again = new Jar();
        again.cookies.set(BINDING, binding);
        expect(location(await b.back(again, `r=${r}`)).searchParams.get('error')).toBe('social_nonce_invalid');
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 1 });
    });

    it('refuses a flow older than 10 minutes', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google', 'signin', '/later');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        b.db.prepare('UPDATE auth_social_web_nonce SET expiresAt = ?').run(Date.now() - 1);
        const response = await b.back(jar, `r=${r}`);
        expect(location(response).pathname).toBe('/later');
        expect(location(response).searchParams.get('error')).toBe('social_nonce_invalid');
        expect(b.issuer.requests.some((request) => request.path === '/v1/social/web/redeem')).toBe(false);
    });

    it.each([
        ['canceled', 'social_canceled'],
        ['provider_unavailable', 'social_provider_unavailable'],
        ['expired', 'social_expired'],
        ['<script>alert(1)</script>', 'social_failed'],
        ['access_denied', 'social_failed'],
    ])('maps ?error=%s to %s, never echoing it, and spends the flow', async (error, code) => {
        const b = await brain();
        const jar = new Jar();
        await b.start(jar, 'google', 'signin', '/here');
        const response = await b.back(jar, `error=${encodeURIComponent(error)}`);
        const to = location(response);
        expect(to.pathname).toBe('/here');
        expect(to.searchParams.get('error')).toBe(code);
        expect(response.headers.get('location')).not.toContain('script');
        expect(jar.cookies.has(BINDING)).toBe(false);
        expect(b.db.prepare('SELECT usedAt FROM auth_social_web_nonce').get()).toEqual({ usedAt: expect.any(Number) });
    });

    it('refuses once the policy turned the provider off meanwhile, and a deactivated person', async () => {
        const b = await brain();
        const ada = await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        b.savePolicy({ google: false });
        expect(location(await b.back(jar, `r=${r}`)).searchParams.get('error')).toBe('social_method_off');
        b.savePolicy({});
        b.db.prepare('UPDATE auth_user SET banned = 1 WHERE id = ?').run(ada.id);
        const other = new Jar();
        const second = await b.start(other, 'google');
        const r2 = b.issuer.completeWeb(second.body.url!, 'google-sub-ada');
        expect(location(await b.back(other, `r=${r2}`)).searchParams.get('error')).toBe('social_deactivated');
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 0 });
    });

    it('can’t be finished through Better Auth’s own handler', async () => {
        const b = await brain();
        const response = await b.call(new Jar(), '/api/auth/web/social/finish', {
            body: { binding: 'x', result: 'y' },
        });
        expect(response.status).toBe(404);
    });
});

describe('the return from Socio’s sign-in page', () => {
    it('answers a page of this origin that redeems nothing yet, without the Strict session cookie', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        const { body } = await b.start(web, 'google', 'link');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        // The cross-site return carries the Lax binding, not the Strict session.
        expect(web.sameSite.get(SESSION)).toBe('strict');
        expect(web.sameSite.get(BINDING)).toBe('lax');
        expect(web.headerFor('cross-site')).toContain(`${BINDING}=`);
        expect(web.headerFor('cross-site')).not.toContain(SESSION);
        const page = await b.landing(web, `r=${r}`);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toMatch(/^text\/html/);
        expect(page.headers.get('cache-control')).toBe('no-store');
        expect(page.headers.get('referrer-policy')).toBe('no-referrer');
        const html = await page.text();
        // Its one script carries the CSP's nonce; no other inline script runs.
        const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
        expect(nonce).toBeTruthy();
        const csp = page.headers.get('content-security-policy')!;
        expect(csp).toContain(`'nonce-${nonce}'`);
        expect(csp).toContain("form-action 'self'");
        expect(html.match(/<script/g)).toHaveLength(1);
        // Without JavaScript, a button.
        expect(html).toContain('<button type="submit">Continue</button>');
        // Nothing redeemed, the binding kept, nothing linked yet.
        expect(b.issuer.requests.some((request) => request.path === '/v1/social/web/redeem')).toBe(false);
        expect(web.cookies.has(BINDING)).toBe(true);
        expect(page.headers.getSetCookie()).toEqual([]);
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
    });

    it('escapes what the return carried', async () => {
        const b = await brain();
        const html = await (
            await b.landing(new Jar(), `error=${encodeURIComponent('"><script>alert(1)</script>')}`)
        ).text();
        expect(html).not.toContain('<script>alert');
        expect(html.match(/<script/g)).toHaveLength(1);
    });

    it('redeems only on this origin’s own request: complete from another site is refused', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const refused = await b.call(jar, `${COMPLETE}?r=${r}`, { site: 'cross-site' });
        expect(refused.status).toBe(403);
        expect(b.issuer.requests.some((request) => request.path === '/v1/social/web/redeem')).toBe(false);
        expect(jar.cookies.has(SESSION)).toBe(false);
        // The flow still finishes from this origin, once.
        const done = await b.back(jar, `r=${r}`);
        expect(location(done).searchParams.get('error')).toBeNull();
        expect(b.issuer.requests.filter((request) => request.path === '/v1/social/web/redeem')).toHaveLength(1);
    });
});

describe('one redeem per flow', () => {
    const redeems = (b: Brain) =>
        b.issuer.requests.filter((request) => request.path === '/v1/social/web/redeem').length;
    /** A raw client's complete with this binding, from its own address unless told. */
    const complete = (b: Brain, binding: string, query: string, ip?: string) => {
        const jar = new Jar();
        jar.cookies.set(BINDING, binding);
        return b.call(jar, `${COMPLETE}?${query}`, { ip });
    };

    it('reaches the cloud once, however often a kept binding comes back with made-up results', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        await b.start(jar, 'google');
        const binding = jar.cookies.get(BINDING)!;
        for (let i = 0; i < 20; i++) {
            const response = await complete(b, binding, `r=${randomBytes(32).toString('base64url')}`);
            expect(location(response).searchParams.get('error')).toBe('social_nonce_invalid');
        }
        expect(redeems(b)).toBe(1);
        expect(b.db.prepare('SELECT redeemStartedAt, usedAt FROM auth_social_web_nonce').get()).toEqual({
            redeemStartedAt: expect.any(Number),
            usedAt: expect.any(Number),
        });
    });

    it('redeems once for two completes at the same time with one binding', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const binding = jar.cookies.get(BINDING)!;
        const answers = await Promise.all([complete(b, binding, `r=${r}`), complete(b, binding, `r=${r}`)]);
        expect(redeems(b)).toBe(1);
        const errors = answers.map((response) => location(response).searchParams.get('error')).sort();
        expect(errors).toEqual(['social_nonce_invalid', null].sort());
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 1 });
    });

    it('stays spent after the cloud refused it: no second call', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const binding = jar.cookies.get(BINDING)!;
        const redeem = b.issuer.socialWebRedeem;
        b.issuer.socialWebRedeem = () =>
            new Response(JSON.stringify({ error: 'result_invalid' }), {
                status: 422,
                headers: { 'content-type': 'application/json' },
            });
        expect(location(await complete(b, binding, `r=${r}`)).searchParams.get('error')).toBe('social_nonce_invalid');
        b.issuer.socialWebRedeem = redeem;
        expect(location(await complete(b, binding, `r=${r}`)).searchParams.get('error')).toBe('social_nonce_invalid');
        expect(redeems(b)).toBe(1);
        // And after the cloud was unreachable, the same.
        const other = new Jar();
        const second = await b.start(other, 'google');
        const r2 = b.issuer.completeWeb(second.body.url!, 'google-sub-ada');
        b.issuer.down = 'network';
        expect(location(await complete(b, other.cookies.get(BINDING)!, `r=${r2}`)).searchParams.get('error')).toBe(
            'social_provider_unavailable',
        );
        b.issuer.down = false;
        expect(location(await complete(b, other.cookies.get(BINDING)!, `r=${r2}`)).searchParams.get('error')).toBe(
            'social_nonce_invalid',
        );
        expect(redeems(b)).toBe(2);
    });

    it('refuses an eleventh complete a minute from one address before anything goes out', async () => {
        const b = await brain();
        await adaLinked(b);
        const jar = new Jar();
        const { body } = await b.start(jar, 'google');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        const binding = jar.cookies.get(BINDING)!;
        for (let i = 0; i < 10; i++) {
            expect((await b.call(new Jar(), `${COMPLETE}?r=x`, { ip: '10.7.7.7' })).status).toBe(302);
        }
        const limited = await complete(b, binding, `r=${r}`, '10.7.7.7');
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        expect(redeems(b)).toBe(0);
        // The flow is untouched: from another address it finishes.
        const done = await complete(b, binding, `r=${r}`, '10.7.7.8');
        expect(location(done).searchParams.get('error')).toBeNull();
        expect(redeems(b)).toBe(1);
    });
});

describe('link from Settings', () => {
    it.each(['google', 'apple'] as const)(
        'links %s to the session that started it, then back to Settings',
        async (provider) => {
            const b = await brain();
            const ada = await b.account('ada@example.com', 'Ada');
            const web = await b.signIn('ada@example.com');
            const { response } = await b.flow(web, provider, `${provider}-sub-ada`, { purpose: 'link' });
            const to = location(response);
            expect(`${to.pathname}${to.hash}`).toBe('/settings/account#sign-in-methods');
            expect(to.searchParams.get('social_link')).toBe('linked');
            expect(b.db.prepare('SELECT purpose, sessionId FROM auth_social_web_nonce').get()).toMatchObject({
                purpose: 'web-link',
                sessionId: expect.any(String),
            });
            expect(
                b.db
                    .prepare('SELECT userId, accountId FROM auth_account WHERE providerId = ?')
                    .all(`${provider}-native`),
            ).toEqual([{ userId: ada.id, accountId: `${provider}-sub-ada` }]);
            // Listed as the app's links are, and the person signs in with it next time.
            const links = (await (await b.call(web, '/api/auth/social/links')).json()) as { provider: string }[];
            expect(links.map((link) => link.provider)).toEqual([provider]);
            const fresh = new Jar();
            await b.flow(fresh, provider, `${provider}-sub-ada`);
            expect(await b.signedIn(fresh)).not.toBeNull();
        },
    );

    it('refuses a link callback in another session, or signed out', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        const { body } = await b.start(web, 'google', 'link');
        const r = b.issuer.completeWeb(body.url!, 'google-sub-ada');
        // The same browser cookie, another session of Ada's.
        const other = await b.signIn('ada@example.com');
        other.cookies.set(BINDING, web.cookies.get(BINDING)!);
        const elsewhere = await b.back(other, `r=${r}`);
        expect(location(elsewhere).searchParams.get('social_link')).toBe('not_authorized');
        // That spent the flow: even its own session can't finish it now.
        expect(location(await b.back(web, `r=${r}`)).searchParams.get('social_link')).toBe('nonce_invalid');
        // Signed out, with a flow of its own.
        const second = await b.start(web, 'google', 'link');
        const r2 = b.issuer.completeWeb(second.body.url!, 'google-sub-ada');
        const signedOut = new Jar();
        signedOut.cookies.set(BINDING, web.cookies.get(BINDING)!);
        expect(location(await b.back(signedOut, `r=${r2}`)).searchParams.get('social_link')).toBe('not_authorized');
        // Neither reached the cloud.
        expect(b.issuer.requests.some((request) => request.path === '/v1/social/web/redeem')).toBe(false);
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
    });

    it('refuses a subject linked to another person', async () => {
        const b = await brain();
        await adaLinked(b);
        await b.account('bob@example.com', 'Bob');
        const bob = await b.signIn('bob@example.com');
        const { response } = await b.flow(bob, 'google', 'google-sub-ada', { purpose: 'link' });
        expect(location(response).searchParams.get('social_link')).toBe('already_linked_other');
    });

    it('never takes a link’s flow for a sign-in, nor a sign-in’s for a link', async () => {
        const b = await brain();
        const ada = await adaLinked(b);
        const web = await b.signIn('ada@example.com');
        // A sign-in flow from a signed-in browser makes no link.
        await b.account('bob@example.com', 'Bob');
        const bob = await b.signIn('bob@example.com');
        const { response: signin } = await b.flow(bob, 'google', 'google-sub-bob', { purpose: 'signin' });
        expect(location(signin).searchParams.get('error')).toBe('social_not_linked');
        expect(location(signin).searchParams.get('social_link')).toBeNull();
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE accountId = 'google-sub-bob'").get()).toEqual(
            { n: 0 },
        );
        // A link flow for a linked subject signs nobody in: it links (here, already linked).
        const before = (
            b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE userId = ?').get(ada.id) as { n: number }
        ).n;
        const { response: link } = await b.flow(web, 'google', 'google-sub-ada', { purpose: 'link' });
        expect(location(link).searchParams.get('social_link')).toBe('linked');
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE userId = ?').get(ada.id)).toEqual({
            n: before,
        });
        // And a web nonce is never an app nonce.
        const { body } = await b.start(new Jar(), 'google');
        const nonce = JSON.parse(
            b.issuer.requests.filter((request) => request.path === '/v1/social/web/start').at(-1)!.body,
        ).nonce as string;
        const response = await b.call(new Jar(), '/api/auth/device/social/redeem', {
            body: {
                provider: 'google',
                idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.google-sub-ada',
                nonce,
                installId: randomBytes(32).toString('base64url'),
                platform: 'ios',
            },
        });
        expect(body.url).toBeDefined();
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'nonce_invalid' });
    });

    it('unlinks from the website as from the app', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        await b.flow(web, 'google', 'google-sub-ada', { purpose: 'link' });
        const response = await b.app.request('/api/auth/social/link/google', {
            method: 'DELETE',
            // As the web client's `api` sends it.
            headers: {
                origin: ORIGIN,
                'sec-fetch-site': 'same-origin',
                'content-type': 'application/json',
                cookie: web.header,
            },
        });
        expect(response.status).toBe(200);
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
    });
});

describe('what the sign-in page offers', () => {
    it('lists the providers the cloud offers for the web, the policy allows, while connected', async () => {
        const b = await brain();
        expect((await b.methods()).social).toEqual(['google', 'apple']);
        b.savePolicy({ apple: false });
        expect((await b.methods()).social).toEqual(['google']);
        const appOnly = await brain({
            config: { google: { serverClientId: 'x.apps.example.test' }, apple: { web: true } },
        });
        expect((await appOnly.methods()).social).toEqual(['apple']);
        expect((await appOnly.start(new Jar(), 'google')).body).toMatchObject({ code: 'provider_unavailable' });
        const disconnected = await brain({ enroll: false });
        expect((await disconnected.methods()).social).toEqual([]);
        const unscoped = await brain({ scopes: 'reports:write' });
        expect((await unscoped.methods()).social).toEqual([]);
        expect((await unscoped.start(new Jar(), 'google')).body).toMatchObject({ code: 'provider_unavailable' });
    });

    it('leaves the app’s manifest as it was: every provider the cloud verifies, web or not', async () => {
        const b = await brain({ config: { google: { serverClientId: 'x.apps.example.test' }, apple: {} } });
        expect((await b.methods()).social).toEqual([]);
        expect((await b.manifest()).methods.social).toEqual(['google', 'apple']);
    });
});
