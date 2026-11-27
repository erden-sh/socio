// CB-570: the Socio app's native Google and Apple sign-in. The server issues
// single-use nonces; a token is accepted only with one of them, for its
// provider and purpose; an account is found only by its link (provider and
// subject), never by email, and never made. The verifier here stands in for
// Socio's cloud services (tests/cloud-social.test.ts covers that one).
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { INSTALL_HEADER, workspaceManifestSchema } from '@socio/shared/device-sign-in';

import { assessSignIn } from '../src/server/auth/access-policy.js';
import type { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import type { SocialVerifier } from '../src/server/auth/contract.js';
import { DEVICE_SESSION_SECONDS } from '../src/server/auth/devices.js';
import { betterAuthSettingsFromEnv } from '../src/server/auth/settings.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';
const WEB_CLIENT = 'test-web-client.apps.example.test';

class Jar {
    private cookies = new Map<string, string>();
    store(response: Response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1);
            if (!value || /max-age=0/i.test(header)) {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
        return response;
    }
    get header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

/** An ID token as the platform makes one; the fake verifier reads its subject from the last segment. */
const idToken = (sub: string) => `eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.${sub}`;

type Verdict = Awaited<ReturnType<SocialVerifier['verify']>>;

/** Socio's cloud services, as the server sees them through the adapter. */
class FakeVerifier implements SocialVerifier {
    offer: Awaited<ReturnType<SocialVerifier['config']>> = { google: { serverClientId: WEB_CLIENT }, apple: {} };
    calls: Parameters<SocialVerifier['verify']>[0][] = [];
    email?: string;
    /** Overrides the verdict. */
    answer?: (input: Parameters<SocialVerifier['verify']>[0]) => Verdict;
    delayMs = 0;
    async config() {
        return this.offer;
    }
    async verify(input: Parameters<SocialVerifier['verify']>[0]): Promise<Verdict> {
        this.calls.push(input);
        if (this.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        return (
            this.answer?.(input) ?? {
                ok: true,
                provider: input.provider,
                sub: input.idToken.split('.').pop()!,
                nonce: input.nonce,
                ...(this.email ? { email: this.email, emailVerified: true } : {}),
            }
        );
    }
}

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

async function brain({ inject = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-social-'));
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
    const verifier = new FakeVerifier();
    if (inject) {
        provider.useSocialVerifier(verifier);
    }
    const db = new DatabaseSync(path);
    cleanups.push(async () => {
        db.close();
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    /** Each call from its own address unless told: the per-address limits are tested on their own. */
    const call = async (
        jar: Jar,
        path: string,
        init: { body?: unknown; method?: string; headers?: Record<string, string>; ip?: string } = {},
    ) =>
        jar.store(
            await app.request(path, {
                method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
                headers: {
                    origin: ORIGIN,
                    'x-forwarded-for': init.ip ?? `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`,
                    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...init.headers,
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            }),
        );
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
    const start = async (provider: 'google' | 'apple', purpose: 'signin' | 'link', jar = new Jar(), ip?: string) => {
        const response = await call(jar, '/api/auth/device/social/start', { body: { provider, purpose }, ip });
        return {
            response,
            body: (await response.json()) as { nonce: string; expiresAt: string; serverClientId?: string },
        };
    };
    const redeem = async (body: Record<string, unknown>, jar = new Jar(), ip?: string) => {
        const installId = randomBytes(32).toString('base64url');
        const response = await call(jar, '/api/auth/device/social/redeem', {
            body: { installId, platform: 'ios', label: 'Ada’s iPhone', ...body },
            headers: { [INSTALL_HEADER]: installId },
            ip,
        });
        return { response, body: (await response.json()) as Record<string, unknown>, jar, installId };
    };
    const link = async (jar: Jar, body: Record<string, unknown>) => {
        const response = await call(jar, '/api/auth/social/link', { body });
        return { response, body: (await response.json()) as Record<string, unknown> };
    };
    /** Links `sub` to the account signed in on `jar`, through the routes. */
    const linked = async (jar: Jar, provider: 'google' | 'apple', sub: string) => {
        const { body } = await start(provider, 'link', jar);
        const made = await link(jar, { provider, idToken: idToken(sub), nonce: body.nonce });
        expect(made.response.status).toBe(200);
        return made.body;
    };
    const savePolicy = (policy: Record<string, unknown>) => {
        db.prepare(
            `INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 1, ?, ?, 'test')
             ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, version = version + 1`,
        ).run(JSON.stringify(policy), Date.now());
    };
    const manifest = async () =>
        workspaceManifestSchema.parse(await (await app.request('/.well-known/socio/workspace')).json());
    return { app, provider, verifier, db, call, account, signIn, start, redeem, link, linked, savePolicy, manifest };
}
type Brain = Awaited<ReturnType<typeof brain>>;

/** Ada, with a password, linked to Google as `google-sub-ada`. */
async function adaLinked(b: Brain, provider: 'google' | 'apple' = 'google') {
    const ada = await b.account('ada@example.com', 'Ada');
    const web = await b.signIn('ada@example.com');
    await b.linked(web, provider, `${provider}-sub-ada`);
    return { ada, web };
}

describe('start', () => {
    it('answers a 32-byte nonce for 5 minutes, stores only its hash, and Google’s server client id', async () => {
        const b = await brain();
        const before = Date.now();
        const { response, body } = await b.start('google', 'signin');
        expect(response.status).toBe(200);
        expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(body.nonce, 'base64url')).toHaveLength(32);
        expect(body.serverClientId).toBe(WEB_CLIENT);
        const expires = Date.parse(body.expiresAt);
        expect(expires).toBeGreaterThanOrEqual(before + 5 * 60_000);
        expect(expires).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
        const rows = b.db.prepare('SELECT * FROM auth_social_nonce').all() as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ provider: 'google', purpose: 'signin', sessionId: null, usedAt: null });
        expect(JSON.stringify(rows)).not.toContain(body.nonce);
    });

    it('gives Apple no client id', async () => {
        const b = await brain();
        const { response, body } = await b.start('apple', 'signin');
        expect(response.status).toBe(200);
        expect(body).not.toHaveProperty('serverClientId');
    });

    it('binds a sign-in nonce to no session, even from a signed-in browser, and a link nonce to the session', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        await b.start('google', 'signin', web);
        await b.start('google', 'link', web);
        const session = b.db.prepare('SELECT id FROM auth_session WHERE userId = ?').get(ada.id) as { id: string };
        expect(b.db.prepare('SELECT purpose, sessionId FROM auth_social_nonce ORDER BY purpose DESC').all()).toEqual([
            { purpose: 'signin', sessionId: null },
            { purpose: 'link', sessionId: session.id },
        ]);
    });

    it('refuses a link start without a session, and a bad body', async () => {
        const b = await brain();
        const { response, body } = await b.start('google', 'link');
        expect(response.status).toBe(401);
        expect(body).toMatchObject({ code: 'not_authorized' });
        const bad = await b.call(new Jar(), '/api/auth/device/social/start', { body: { provider: 'github' } });
        expect(bad.status).toBe(400);
    });

    it('answers provider_unavailable while the cloud can’t verify, or doesn’t offer the provider', async () => {
        const b = await brain();
        b.verifier.offer = null;
        const off = await b.start('google', 'signin');
        expect(off.response.status).toBe(503);
        expect(off.body).toMatchObject({ code: 'provider_unavailable' });
        b.verifier.offer = { apple: {} };
        expect((await b.start('google', 'signin')).response.status).toBe(503);
        expect((await b.start('apple', 'signin')).response.status).toBe(200);
    });

    it('is limited per address, like the other device starts', async () => {
        const b = await brain();
        const ip = '10.77.0.1';
        for (let i = 0; i < 20; i++) {
            expect((await b.start('google', 'signin', new Jar(), ip)).response.status).toBe(200);
        }
        const limited = await b.start('google', 'signin', new Jar(), ip);
        expect(limited.response.status).toBe(429);
        expect(limited.body).toMatchObject({ code: 'too_many' });
    });
});

describe('redeem', () => {
    it('signs a linked person in with Google: the device session /device/redeem makes, as `google`', async () => {
        const b = await brain();
        const { ada } = await adaLinked(b);
        const { body: started } = await b.start('google', 'signin');
        const { response, body, jar, installId } = await b.redeem({
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(response.status).toBe(200);
        expect(Object.keys(body)).toEqual(['deviceId']);
        const cookie = response.headers.getSetCookie().find((header) => header.startsWith('cb.session_token='));
        expect(Number(/max-age=(\d+)/i.exec(cookie ?? '')?.[1])).toBeGreaterThan(DEVICE_SESSION_SECONDS - 5);
        const session = b.db
            .prepare('SELECT signInMethod, deviceId FROM auth_session WHERE userId = ? AND deviceId IS NOT NULL')
            .get(ada.id) as { signInMethod: string; deviceId: string };
        expect(session).toEqual({ signInMethod: 'google', deviceId: body.deviceId });
        expect(b.db.prepare('SELECT label, platform FROM auth_device WHERE id = ?').get(String(body.deviceId))).toEqual(
            {
                label: 'Ada’s iPhone',
                platform: 'ios',
            },
        );
        // The session works for the app.
        const user = await b.provider.resolve(
            new Request(`${ORIGIN}/api/rooms`, { headers: { cookie: jar.header, [INSTALL_HEADER]: installId } }),
        );
        expect(user?.name).toBe('Ada');
        // The verifier got the raw nonce.
        expect(b.verifier.calls.at(-1)).toEqual({
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
    });

    it('signs a linked person in with Apple', async () => {
        const b = await brain();
        await adaLinked(b, 'apple');
        const { body: started } = await b.start('apple', 'signin');
        const { response } = await b.redeem({
            provider: 'apple',
            idToken: idToken('apple-sub-ada'),
            nonce: started.nonce,
            label: undefined,
        });
        expect(response.status).toBe(200);
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_session WHERE signInMethod = 'apple'").get()).toEqual({
            n: 1,
        });
    });

    it('never matches an email: a token whose email is an account’s, but with no link, is not_linked', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        b.verifier.email = 'ada@example.com';
        const accounts = b.db.prepare('SELECT count(*) AS n FROM auth_user').get();
        const { body: started } = await b.start('google', 'signin');
        const { response, body } = await b.redeem({
            provider: 'google',
            idToken: idToken('google-sub-unknown'),
            nonce: started.nonce,
        });
        expect(response.status).toBe(404);
        expect(body).toMatchObject({ code: 'not_linked' });
        // No account made, no session.
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_user').get()).toEqual(accounts);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 0 });
        // And the nonce is used up.
        expect(
            (await b.redeem({ provider: 'google', idToken: idToken('google-sub-unknown'), nonce: started.nonce }))
                .response.status,
        ).toBe(401);
    });

    it('takes a subject linked to Google only for Google', async () => {
        const b = await brain();
        await adaLinked(b, 'google');
        const { body: started } = await b.start('apple', 'signin');
        const { response } = await b.redeem({
            provider: 'apple',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(response.status).toBe(404);
    });

    it.each([
        ['invalid_token', 401],
        ['too_many', 429],
        ['provider_unavailable', 503],
        ['nonce_invalid', 401],
    ] as const)('answers the verifier’s %s as %i', async (code, status) => {
        const b = await brain();
        await adaLinked(b);
        b.verifier.answer = () => ({ ok: false, code });
        const { body: started } = await b.start('google', 'signin');
        const { response, body } = await b.redeem({
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(response.status).toBe(status);
        expect(body).toMatchObject({ code, error: expect.any(String) });
        // Nothing from the token in the answer.
        expect(JSON.stringify(body)).not.toContain('google-sub-ada');
    });

    it('refuses a verdict for another provider or nonce than asked as invalid_token', async () => {
        const b = await brain();
        await adaLinked(b);
        for (const answer of [
            (input: { nonce: string }) => ({
                ok: true as const,
                provider: 'apple' as const,
                sub: 'google-sub-ada',
                nonce: input.nonce,
            }),
            () => ({ ok: true as const, provider: 'google' as const, sub: 'google-sub-ada', nonce: 'x'.repeat(43) }),
        ]) {
            b.verifier.answer = answer;
            const { body: started } = await b.start('google', 'signin');
            const { response, body } = await b.redeem({
                provider: 'google',
                idToken: idToken('google-sub-ada'),
                nonce: started.nonce,
            });
            expect(response.status).toBe(401);
            expect(body).toMatchObject({ code: 'invalid_token' });
        }
    });

    describe('the nonce', () => {
        const refused = async (b: Brain, nonce: unknown, provider: 'google' | 'apple' = 'google') => {
            const calls = b.verifier.calls.length;
            const { response, body } = await b.redeem({ provider, idToken: idToken('google-sub-ada'), nonce });
            expect(response.status).toBe(401);
            expect(body).toMatchObject({ code: 'nonce_invalid' });
            // Refused before anything is sent out.
            expect(b.verifier.calls.length).toBe(calls);
        };

        it('must be there', async () => {
            const b = await brain();
            await adaLinked(b);
            await refused(b, undefined);
        });

        it('must be one this server issued: another server’s is refused', async () => {
            const a = await brain();
            const other = await brain();
            await adaLinked(a);
            await refused(a, randomBytes(32).toString('base64url'));
            const { body: elsewhere } = await other.start('google', 'signin');
            await refused(a, elsewhere.nonce);
        });

        it('must not have expired', async () => {
            const b = await brain();
            await adaLinked(b);
            const { body: started } = await b.start('google', 'signin');
            b.db.prepare('UPDATE auth_social_nonce SET expiresAt = ?').run(Date.now() - 1);
            await refused(b, started.nonce);
        });

        it('works once', async () => {
            const b = await brain();
            await adaLinked(b);
            const { body: started } = await b.start('google', 'signin');
            expect(
                (await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce }))
                    .response.status,
            ).toBe(200);
            await refused(b, started.nonce);
        });

        it('is for the provider it was issued for', async () => {
            const b = await brain();
            await adaLinked(b, 'apple');
            const { body: started } = await b.start('google', 'signin');
            await refused(b, started.nonce, 'apple');
        });

        it('is for a sign-in: a link nonce is refused', async () => {
            const b = await brain();
            const { web } = await adaLinked(b);
            const { body: started } = await b.start('google', 'link', web);
            await refused(b, started.nonce);
        });

        it('lets exactly one of two redeems at once sign in', async () => {
            const b = await brain();
            await adaLinked(b);
            b.verifier.delayMs = 20;
            const { body: started } = await b.start('google', 'signin');
            const both = await Promise.all([
                b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce }),
                b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce }),
            ]);
            expect(both.map(({ response }) => response.status).sort()).toEqual([200, 401]);
            expect(both.find(({ response }) => response.status === 401)?.body).toMatchObject({ code: 'nonce_invalid' });
            expect(b.db.prepare("SELECT count(*) AS n FROM auth_session WHERE signInMethod = 'google'").get()).toEqual({
                n: 1,
            });
        });
    });

    it('is refused while the access policy turns the method off, and turning it off ends its sessions', async () => {
        const b = await brain();
        await adaLinked(b);
        const { body: started } = await b.start('google', 'signin');
        const signedIn = await b.redeem({
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(signedIn.response.status).toBe(200);
        const { body: second } = await b.start('google', 'signin');
        b.savePolicy({ google: false });
        const off = await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: second.nonce });
        expect(off.response.status).toBe(403);
        expect(off.body).toMatchObject({ code: 'method_off' });
        const start = await b.start('google', 'signin');
        expect(start.response.status).toBe(403);
        expect(start.body).toMatchObject({ code: 'method_off' });
        // The session it made is over at its next request.
        const request = new Request(`${ORIGIN}/api/rooms`, {
            headers: { cookie: signedIn.jar.header, [INSTALL_HEADER]: signedIn.installId },
        });
        expect(await b.provider.resolve(request)).toBeNull();
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_session WHERE signInMethod = 'google'").get()).toEqual({
            n: 0,
        });
        // Apple is still on.
        expect((await b.start('apple', 'signin')).response.status).toBe(200);
    });

    it('ends google sessions in the policy’s save, as it does other methods’', () => {
        const inForce = {
            password: true,
            passkey: false,
            signInLink: false,
            emailLinks: false,
            openSignUp: false,
            google: true,
            apple: true,
            providers: [],
            allowedEmails: [],
            allowedDomains: [],
            adminEmails: [],
        };
        const account = {
            id: 'a1',
            appUserId: 'ada',
            name: 'Ada',
            email: 'ada@example.com',
            role: 'admin',
            deactivated: false,
            password: true,
            passkeys: 0,
            providers: ['google-native'],
            linkReachable: false,
        };
        const sessions = [
            { id: 's-google', accountId: 'a1', method: 'google', expiresAt: Date.now() + 60_000 },
            { id: 's-apple', accountId: 'a1', method: 'apple', expiresAt: Date.now() + 60_000 },
            { id: 's-password', accountId: 'a1', method: 'password', expiresAt: Date.now() + 60_000 },
        ];
        const assessed = assessSignIn({
            before: inForce,
            after: { ...inForce, google: false },
            saved: { google: false },
            accounts: [account],
            sessions,
            actor: null,
        });
        expect(assessed.revoke).toEqual(['s-google']);
    });

    it('refuses a deactivated person', async () => {
        const b = await brain();
        const { ada } = await adaLinked(b);
        await b.provider.deactivate(ada.id, 'system');
        const { body: started } = await b.start('google', 'signin');
        const { response, body } = await b.redeem({
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(response.status).toBe(403);
        expect(body).toMatchObject({ code: 'deactivated' });
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE userId = ?').get(ada.id)).toEqual({ n: 0 });
    });

    it('is limited per address, like /device/redeem', async () => {
        const b = await brain();
        const ip = '10.78.0.1';
        let last: Awaited<ReturnType<Brain['redeem']>> | undefined;
        for (let i = 0; i < 11; i++) {
            last = await b.redeem(
                { provider: 'google', idToken: idToken('google-sub-ada'), nonce: 'n'.repeat(43) },
                new Jar(),
                ip,
            );
            if (i < 10) {
                expect(last.response.status).toBe(401);
            }
        }
        expect(last!.response.status).toBe(429);
        expect(last!.body).toMatchObject({ code: 'too_many' });
    });
});

describe('links', () => {
    it('links Google to the signed-in account, keeping the token’s email for display', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        b.verifier.email = 'ada.personal@example.com';
        const made = await b.linked(web, 'google', 'google-sub-ada');
        expect(made).toEqual({ provider: 'google', linkedAt: expect.any(String), email: 'ada.personal@example.com' });
        expect(
            b.db.prepare("SELECT accountId, userId FROM auth_account WHERE providerId = 'google-native'").all(),
        ).toEqual([{ accountId: 'google-sub-ada', userId: ada.id }]);
        const listed = await b.call(web, '/api/auth/social/links');
        expect(await listed.json()).toEqual([made]);
    });

    it('answers 200 with no change when already linked to this account, 409 when to another', async () => {
        const b = await brain();
        const { ada, web } = await adaLinked(b);
        const again = await b.linked(web, 'google', 'google-sub-ada');
        expect(again).toMatchObject({ provider: 'google' });
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 1 },
        );
        await b.account('bob@example.com', 'Bob');
        const bob = await b.signIn('bob@example.com');
        const { body: started } = await b.start('google', 'link', bob);
        const taken = await b.link(bob, {
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(taken.response.status).toBe(409);
        expect(taken.body).toMatchObject({ code: 'already_linked_other' });
        expect(b.db.prepare("SELECT userId FROM auth_account WHERE providerId = 'google-native'").all()).toEqual([
            { userId: ada.id },
        ]);
    });

    it('needs a nonce issued to this same session for a link', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        const otherBrowser = await b.signIn('ada@example.com');
        const fromOther = await b.start('google', 'link', otherBrowser);
        const refusedOther = await b.link(web, {
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: fromOther.body.nonce,
        });
        expect(refusedOther.response.status).toBe(401);
        expect(refusedOther.body).toMatchObject({ code: 'nonce_invalid' });
        // A sign-in nonce, even this session's, is no link nonce.
        const signin = await b.start('google', 'signin', web);
        const refusedSignin = await b.link(web, {
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: signin.body.nonce,
        });
        expect(refusedSignin.response.status).toBe(401);
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
        expect(b.verifier.calls).toEqual([]);
    });

    it('needs a signed-in session', async () => {
        const b = await brain();
        const response = await b.call(new Jar(), '/api/auth/social/link', {
            body: { provider: 'google', idToken: idToken('google-sub-ada'), nonce: 'n'.repeat(43) },
        });
        expect(response.status).toBe(401);
    });

    it('unlinks, but never the last way to sign in', async () => {
        const b = await brain();
        const { ada, web } = await adaLinked(b);
        await b.linked(web, 'apple', 'apple-sub-ada');
        const gone = await b.call(web, '/api/auth/social/link/apple', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
        });
        expect(gone.status).toBe(200);
        expect(await (await b.call(web, '/api/auth/social/links')).json()).toEqual([
            { provider: 'google', linkedAt: expect.any(String) },
        ]);
        // With the password gone, Google is all that's left.
        b.db.prepare("DELETE FROM auth_account WHERE userId = ? AND providerId = 'credential'").run(ada.id);
        const last = await b.call(web, '/api/auth/social/link/google', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
        });
        expect(last.status).toBe(409);
        expect(await last.json()).toMatchObject({ code: 'last_method' });
        expect(
            (
                await b.call(web, '/api/auth/social/link/google', {
                    method: 'DELETE',
                    headers: { 'content-type': 'application/json' },
                })
            ).status,
        ).toBe(409);
        expect(
            (
                await b.call(web, '/api/auth/social/link/apple', {
                    method: 'DELETE',
                    headers: { 'content-type': 'application/json' },
                })
            ).status,
        ).toBe(404);
    });

    describe('a link counts as a way in only while its provider is offered', () => {
        const del = (b: Brain, jar: Jar, provider: string) =>
            b.call(jar, `/api/auth/social/link/${provider}`, {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
            });
        /** Ada with Google and Apple links and nothing else. */
        const linksOnly = async (b: Brain) => {
            const { ada, web } = await adaLinked(b, 'google');
            await b.linked(web, 'apple', 'apple-sub-ada');
            b.db.prepare("DELETE FROM auth_account WHERE userId = ? AND providerId = 'credential'").run(ada.id);
            return web;
        };

        it('refuses to unlink Google when Apple, the only other way, isn’t offered now', async () => {
            const b = await brain();
            const web = await linksOnly(b);
            b.verifier.offer = { google: { serverClientId: WEB_CLIENT } };
            const refused = await del(b, web, 'google');
            expect(refused.status).toBe(409);
            expect(await refused.json()).toMatchObject({ code: 'last_method' });
            // While Apple is offered, Google can go.
            b.verifier.offer = { google: { serverClientId: WEB_CLIENT }, apple: {} };
            expect((await del(b, web, 'google')).status).toBe(200);
        });

        it('refuses to unlink either when the cloud can’t say what it offers', async () => {
            const b = await brain();
            const web = await linksOnly(b);
            b.verifier.offer = null;
            for (const provider of ['google', 'apple']) {
                const refused = await del(b, web, provider);
                expect(refused.status).toBe(409);
                expect(await refused.json()).toMatchObject({ code: 'last_method' });
            }
        });

        it('refuses when the access policy turned the other one off', async () => {
            const b = await brain();
            const web = await linksOnly(b);
            b.savePolicy({ apple: false });
            expect((await del(b, web, 'google')).status).toBe(409);
        });

        it('lets a person with a password unlink Google while the cloud is down', async () => {
            const b = await brain();
            const { web } = await adaLinked(b);
            b.verifier.offer = null;
            expect((await del(b, web, 'google')).status).toBe(200);
        });
    });

    it('keeps Better Auth’s own unlink closed to these links, by the account row’s id as it takes it', async () => {
        const b = await brain();
        const { ada, web } = await adaLinked(b);
        const row = b.db
            .prepare("SELECT id FROM auth_account WHERE userId = ? AND providerId = 'google-native'")
            .get(ada.id) as { id: string };
        const direct = await b.call(web, '/api/auth/unlink-account', { body: { accountId: row.id } });
        expect(direct.status).toBe(404);
        expect(await b.call(web, '/api/auth/unlink-account', { body: { providerId: 'google-native' } })).toHaveProperty(
            'status',
            404,
        );
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_account WHERE id = ?').get(row.id)).toEqual({ n: 1 });
    });

    it('ends the sessions an unlinked provider made, and only those', async () => {
        const b = await brain();
        const { ada, web } = await adaLinked(b);
        const { body: started } = await b.start('google', 'signin');
        expect(
            (await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce })).response
                .status,
        ).toBe(200);
        const methods = () =>
            (
                b.db
                    .prepare('SELECT signInMethod FROM auth_session WHERE userId = ? ORDER BY signInMethod')
                    .all(ada.id) as { signInMethod: string }[]
            ).map((row) => row.signInMethod);
        expect(methods()).toEqual(['google', 'password']);
        const gone = await b.call(web, '/api/auth/social/link/google', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
        });
        expect(gone.status).toBe(200);
        expect(methods()).toEqual(['password']);
    });

    it('replaces a link with a new account’s, ending the sessions the old one made', async () => {
        const b = await brain();
        const { ada, web } = await adaLinked(b);
        const { body: started } = await b.start('google', 'signin');
        expect(
            (await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce })).response
                .status,
        ).toBe(200);
        await b.linked(web, 'google', 'google-sub-ada-new');
        expect(b.db.prepare("SELECT accountId FROM auth_account WHERE providerId = 'google-native'").all()).toEqual([
            { accountId: 'google-sub-ada-new' },
        ]);
        expect(
            b.db
                .prepare("SELECT count(*) AS n FROM auth_session WHERE userId = ? AND signInMethod = 'google'")
                .get(ada.id),
        ).toEqual({ n: 0 });
        // The old subject signs in no more.
        const { body: again } = await b.start('google', 'signin');
        expect(
            (await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: again.nonce })).response
                .status,
        ).toBe(404);
    });

    it('links nothing when the session ends while the cloud verifies', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        const { body: started } = await b.start('google', 'link', web);
        b.verifier.answer = (input) => {
            // Revoked meanwhile (a sign-out everywhere, an admin's revoke).
            b.db.prepare('DELETE FROM auth_session WHERE userId = ?').run(ada.id);
            return { ok: true, provider: input.provider, sub: 'google-sub-mallory', nonce: input.nonce };
        };
        const refused = await b.link(web, {
            provider: 'google',
            idToken: idToken('google-sub-mallory'),
            nonce: started.nonce,
        });
        expect(refused.response.status).toBe(401);
        expect(refused.body).toMatchObject({ code: 'not_authorized' });
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
    });

    it('links nothing when the method is turned off while the cloud verifies', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const web = await b.signIn('ada@example.com');
        const { body: started } = await b.start('google', 'link', web);
        b.verifier.answer = (input) => {
            b.savePolicy({ google: false });
            return { ok: true, provider: input.provider, sub: 'google-sub-ada', nonce: input.nonce };
        };
        const refused = await b.link(web, {
            provider: 'google',
            idToken: idToken('google-sub-ada'),
            nonce: started.nonce,
        });
        expect(refused.response.status).toBe(403);
        expect(refused.body).toMatchObject({ code: 'method_off' });
        expect(b.db.prepare("SELECT count(*) AS n FROM auth_account WHERE providerId = 'google-native'").get()).toEqual(
            { n: 0 },
        );
    });
});

describe('the manifest', () => {
    it('lists a provider only while the verifier offers it and the access policy allows it', async () => {
        const b = await brain();
        expect((await b.manifest()).methods.social).toEqual(['google', 'apple']);
        b.savePolicy({ apple: false });
        expect((await b.manifest()).methods.social).toEqual(['google']);
        b.verifier.offer = { apple: {} };
        expect((await b.manifest()).methods.social).toEqual([]);
        b.verifier.offer = null;
        b.savePolicy({});
        expect((await b.manifest()).methods.social).toEqual([]);
    });
});

it('logs no token, subject or email', async () => {
    const b = await brain();
    b.verifier.email = 'ada.personal@example.com';
    await adaLinked(b);
    const { body: started } = await b.start('google', 'signin');
    await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce });
    await b.redeem({ provider: 'google', idToken: idToken('google-sub-ada'), nonce: started.nonce });
    expect(logs.join('\n')).not.toMatch(/google-sub-ada|ada\.personal|eyJ/);
    expect(logs.join('\n')).not.toContain(started.nonce);
});

describe('the wiring', () => {
    it('uses the cloud connection’s verifier, which offers nothing while the server isn’t connected', async () => {
        const b = await brain({ inject: false });
        expect((await b.manifest()).methods.social).toEqual([]);
        const { response, body } = await b.start('google', 'signin');
        expect(response.status).toBe(503);
        expect(body).toMatchObject({ code: 'provider_unavailable' });
    });

    it('keeps the links’ provider ids from the generic OAuth providers', () => {
        for (const id of ['google-native', 'apple-native']) {
            expect(() =>
                betterAuthSettingsFromEnv(
                    {
                        AUTH_OAUTH_PROVIDERS: id,
                        [`AUTH_OAUTH_${id.toUpperCase().replace('-', '_')}_ISSUER`]: 'https://id.example.com',
                        [`AUTH_OAUTH_${id.toUpperCase().replace('-', '_')}_CLIENT_ID`]: 'client',
                    },
                    [ORIGIN],
                    SECRET,
                    () => '',
                    () => ({ scopes: [], labels: {} }),
                ),
            ).toThrow(/reserved/);
        }
    });
});
