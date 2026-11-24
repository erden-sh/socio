import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { INSTALL_HEADER, parseAppLink } from '@socio/shared/device-sign-in';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import type { SignInLinkSender } from '../src/server/auth/contract.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: sign-in codes the app asks for, by Telegram or email.
// CB-352: the app's devices, install ids and 30-day device sessions.

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';
const APP_UA = 'Socio/0.6.1 (iPhone; iOS 26)';

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

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

async function brain(env: Record<string, string> = {}) {
    const mails: { to: string; subject: string; text: string }[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'cb-devices-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
            AUTH_APP_PREVIEW_LINKS: 'true',
            ...env,
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher, mailer: { send: async (message) => void mails.push(message) } },
    );
    const provider = auth.provider as BetterAuthProvider;
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const { app, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        app: { config: { mode: 'live' as const, baseUrl: 'https://model.invalid' }, origin: [ORIGIN], auth },
    });
    const db = new DatabaseSync(path);
    cleanups.push(async () => {
        db.close();
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    const call = async (jar: Jar, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
        jar.store(
            await app.request(path, {
                method: init.body === undefined ? 'GET' : 'POST',
                headers: {
                    origin: ORIGIN,
                    'x-forwarded-for': clientIp,
                    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...init.headers,
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            }),
        );
    /** A password sign-in, from the app when `installId` is given. */
    const signIn = async (email: string, installId?: string, jar = new Jar()) => {
        const response = await call(jar, '/api/auth/sign-in/email', {
            body: { email, password: PASSWORD },
            headers: installId ? { [INSTALL_HEADER]: installId, 'user-agent': APP_UA } : {},
        });
        expect(response.status).toBe(200);
        return { jar, response };
    };
    const account = async (email: string, name: string) => {
        await provider.createAccount({ email, name, role: 'member', password: PASSWORD });
        return db.prepare('SELECT id FROM auth_user WHERE email = ?').get(email) as { id: string };
    };
    const sessions = (accountId: string) =>
        db
            .prepare('SELECT token, deviceId, expiresAt FROM auth_session WHERE userId = ? ORDER BY createdAt')
            .all(accountId) as { token: string; deviceId: string | null; expiresAt: string | number }[];
    const devices = (accountId: string) =>
        db.prepare('SELECT * FROM auth_device WHERE userId = ? ORDER BY createdAt').all(accountId) as Record<
            string,
            unknown
        >[];
    /** The app's request, through the provider's resolve. */
    const resolve = async (jar: Jar, installId?: string) => {
        const request = new Request(`${ORIGIN}/api/rooms`, {
            headers: {
                ...(jar.header ? { cookie: jar.header } : {}),
                ...(installId ? { [INSTALL_HEADER]: installId } : {}),
            },
        });
        const cookies: string[] = [];
        const user = await provider.resolve(request, (name, value) => {
            if (name === 'Set-Cookie') {
                cookies.push(value);
            }
        });
        for (const cookie of cookies) {
            jar.store(new Response(null, { headers: [['set-cookie', cookie]] }));
        }
        return { user, cookies, refusal: provider.deviceRefusal(request) };
    };
    /** Moves a session's expiry, as time passing would. */
    const expireIn = async (token: string, seconds: number) => {
        const context = await (await provider.auth()).$context;
        await context.internalAdapter.updateSession(token, { expiresAt: new Date(Date.now() + seconds * 1000) });
    };
    /** Saves the access policy as an operator would (the store's row). */
    const savePolicy = (policy: Record<string, unknown>) => {
        db.prepare(
            `INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 1, ?, ?, 'test')
             ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, version = version + 1`,
        ).run(JSON.stringify(policy), Date.now());
    };
    /** Fake channels: a Telegram that reaches the linked, and email (reaches everyone). */
    const sent: { via: string; userId: string; link: { kind?: string; code?: string; openUrl?: string } }[] = [];
    const linked = new Set<string>();
    /** Every channel lookup, to show none runs before the answer is out. */
    const lookups: string[] = [];
    /** Which Telegram account each app user is linked to (relinking changes it). */
    const telegramOf = new Map<string, string>();
    const sender = (via: 'telegram' | 'email'): SignInLinkSender => ({
        via,
        canDeliver: (userId) => {
            lookups.push(userId);
            return via === 'email' || linked.has(userId);
        },
        recipient: (userId) =>
            via === 'email' ? `mail:${userId}` : linked.has(userId) ? (telegramOf.get(userId) ?? 'tg-1') : null,
        deliver: async (userId, link) => {
            sent.push({ via, userId, link: link as never });
        },
    });
    // Email is the provider's own channel over the mailer; this is Telegram.
    provider.useSignInLinks([sender('telegram')]);
    const appUserId = (accountId: string) =>
        (db.prepare('SELECT appUserId FROM auth_user WHERE id = ?').get(accountId) as { appUserId: string }).appUserId;
    return {
        app,
        provider,
        db,
        call,
        signIn,
        account,
        sessions,
        devices,
        resolve,
        expireIn,
        savePolicy,
        sent,
        linked,
        telegramOf,
        lookups,
        mails,
        appUserId,
        path,
        env: auth,
    };
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');
function pkce() {
    const verifier = b64(randomBytes(32));
    return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}
type Brain = Awaited<ReturnType<typeof brain>>;

const ask = (b: Brain, email: string, flow = pkce(), ip = '10.7.7.7') =>
    b.call(new Jar(), '/api/auth/device/code', {
        body: { email, challenge: flow.challenge, platform: 'ios', variant: 'preview' },
        headers: { 'x-forwarded-for': ip },
    });
const redeemCode = (b: Brain, body: Record<string, unknown>, jar = new Jar(), ip?: string) =>
    b.call(jar, '/api/auth/device/code/redeem', {
        body: { installId: b64(randomBytes(32)), label: 'iPhone', variant: 'preview', ...body },
        ...(ip ? { headers: { 'x-forwarded-for': ip } } : {}),
    });
const wrongCode = 'ZZZZ-ZZZZ';

/** Holds the next session creation until `resume()`; `inside` resolves once it started. */
async function holdCreateSession(b: Brain) {
    const adapter = (await (await b.provider.auth()).$context).internalAdapter;
    const make = adapter.createSession.bind(adapter);
    let reached!: () => void;
    const inside = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const spy = vi.spyOn(adapter, 'createSession').mockImplementation(async (...args) => {
        reached();
        await held;
        return make(...args);
    });
    return { inside, resume, restore: () => spy.mockRestore() };
}

describe('sign-in codes', () => {
    it('sends a code to the linked Telegram and signs the app in with it, as a link session', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const flow = pkce();
        const answer = await ask(b, 'ada@example.com', flow);
        const { requestId } = (await answer.json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        const [message] = b.sent;
        expect(message).toMatchObject({ via: 'telegram', link: { kind: 'code' } });
        const link = parseAppLink(message.link.openUrl!);
        expect(link).toMatchObject({ kind: 'c', variant: 'preview', fields: { code: message.link.code } });
        const installId = b64(randomBytes(32));
        const jar = new Jar();
        const signed = await redeemCode(
            b,
            { requestId, code: message.link.code, verifier: flow.verifier, installId },
            jar,
        );
        expect(signed.status).toBe(200);
        const { deviceId } = (await signed.json()) as { deviceId: string };
        expect(b.db.prepare('SELECT signInMethod FROM auth_session WHERE deviceId = ?').get(deviceId)).toEqual({
            signInMethod: 'link',
        });
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
    });

    it('answers an unknown email exactly as a known one: a request id, the same tries, the same refusals', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const run = async (email: string, ip: string) => {
            const started = performance.now();
            const answer = await ask(b, email, pkce(), ip);
            const took = performance.now() - started;
            const body = (await answer.json()) as { requestId: string };
            const tries: string[] = [];
            for (let i = 0; i < 6; i++) {
                const reply = await redeemCode(
                    b,
                    { requestId: body.requestId, code: wrongCode, verifier: pkce().verifier },
                    new Jar(),
                    ip,
                );
                tries.push(`${reply.status} ${((await reply.json()) as { code: string }).code}`);
            }
            return { status: answer.status, keys: Object.keys(body), took, tries };
        };
        const known = await run('ada@example.com', '10.1.1.1');
        const unknown = await run('nobody@example.com', '10.1.1.2');
        expect(unknown.status).toBe(known.status);
        expect(unknown.keys).toEqual(known.keys);
        expect(unknown.tries).toEqual(known.tries);
        expect(known.tries).toEqual([...Array(5).fill('400 code_invalid'), '429 too_many']);
        // The same speed: the send runs after the answer.
        // Fresh accounts, so every known sample is one that really sends.
        const fresh = new Set<string>();
        for (let i = 0; i < 8; i++) {
            const person = await b.account(`p${i}@example.com`, `P${i}`);
            fresh.add(b.appUserId(person.id));
            b.linked.add(b.appUserId(person.id));
        }
        const times = async (emails: string[]) => {
            const out: number[] = [];
            for (const [i, email] of emails.entries()) {
                const started = performance.now();
                await ask(b, email, pkce(), `10.2.${email.length}.${i}`);
                out.push(performance.now() - started);
            }
            return out.sort((x, y) => x - y)[4];
        };
        const knownMedian = await times([...Array(8).keys()].map((i) => `p${i}@example.com`));
        const unknownMedian = await times([...Array(8).keys()].map((i) => `nobody${i}@example.com`));
        await vi.waitFor(() => expect(b.sent.filter((message) => fresh.has(message.userId))).toHaveLength(8));
        expect(Math.abs(knownMedian - unknownMedian)).toBeLessThan(Math.max(knownMedian, unknownMedian) * 0.75 + 15);
    });

    it('takes 5 tries per request, counted in the database across a restart, then the right code fails too', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        for (let i = 0; i < 3; i++) {
            await redeemCode(b, { requestId, code: wrongCode, verifier: flow.verifier });
        }
        // Another server on the same database (a restart, a failover).
        const other = authFromEnv(
            { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, AUTH_TRUST_PROXY: 'true' },
            '127.0.0.1',
            { database: b.path, hasher: fastHasher },
        ).provider as BetterAuthProvider;
        cleanups.push(() => other.close());
        const call = async (code: string) => {
            const response = await (
                await other.auth()
            ).handler(
                new Request(`${ORIGIN}/api/auth/device/code/redeem`, {
                    method: 'POST',
                    headers: { origin: ORIGIN, 'content-type': 'application/json' },
                    body: JSON.stringify({
                        requestId,
                        code,
                        verifier: flow.verifier,
                        installId: b64(randomBytes(32)),
                        label: 'x',
                        variant: 'preview',
                    }),
                }),
            );
            return response.status;
        };
        expect(await call(wrongCode)).toBe(400);
        expect(await call(wrongCode)).toBe(400);
        expect(await call(b.sent[0].link.code!)).toBe(429);
    });

    it('burns the code when the right one comes with another verifier', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        const code = b.sent[0].link.code!;
        expect(await (await redeemCode(b, { requestId, code, verifier: pkce().verifier })).json()).toMatchObject({
            code: 'code_invalid',
        });
        expect((await redeemCode(b, { requestId, code, verifier: flow.verifier })).status).toBe(400);
    });

    it('refuses a Telegram code once that Telegram no longer reaches the account', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        b.linked.delete(b.appUserId(ada.id));
        const answer = await redeemCode(b, { requestId, code: b.sent[0].link.code, verifier: flow.verifier });
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
    });

    it('refuses a code sent to a Telegram since unlinked, even once another Telegram is linked', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const user = b.appUserId(ada.id);
        b.linked.add(user);
        b.telegramOf.set(user, 'tg-old');
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        // The old Telegram is unlinked (perhaps lost) and a new one linked before the code expires.
        b.telegramOf.set(user, 'tg-new');
        const answer = await redeemCode(b, { requestId, code: b.sent[0].link.code, verifier: flow.verifier });
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId IS NOT NULL').get()).toEqual({
            n: 0,
        });
    });

    it('refuses a code whose Telegram is relinked while its session is being made', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const user = b.appUserId(ada.id);
        b.linked.add(user);
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        const hold = await holdCreateSession(b);
        const redeeming = redeemCode(b, { requestId, code: b.sent[0].link.code, verifier: flow.verifier });
        await hold.inside;
        b.telegramOf.set(user, 'tg-new');
        hold.resume();
        const answer = await redeeming;
        hold.restore();
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
        expect(answer.headers.get('set-cookie') ?? '').not.toMatch(/session_token=[^;]+/);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId IS NOT NULL').get()).toEqual({
            n: 0,
        });
    });

    it('sends a development build its code link on the development link host, never production’s', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const flow = pkce();
        const answer = await b.call(new Jar(), '/api/auth/device/code', {
            body: { email: 'ada@example.com', challenge: flow.challenge, platform: 'android', variant: 'development' },
            headers: { 'x-forwarded-for': '10.6.6.6' },
        });
        expect(answer.status).toBe(200);
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
        expect(new URL(b.sent[0].link.openUrl!).origin).toBe('https://link-staging.socio.sh');
    });

    it('looks the account up and sends only after the answer is out', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const answer = await ask(b, 'ada@example.com');
        expect(answer.status).toBe(200);
        expect(b.lookups).toEqual([]);
        expect(b.sent).toEqual([]);
        await vi.waitFor(() => expect(b.sent).toHaveLength(1));
    });

    it('switches to email when an admin turns email links on, as link:email sessions, which turning them off ends', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        b.savePolicy({ emailLinks: true });
        const flow = pkce();
        const { requestId } = (await (await ask(b, 'ada@example.com', flow)).json()) as { requestId: string };
        await vi.waitFor(() => expect(b.mails).toHaveLength(1));
        // By email, not Telegram, though Telegram is linked.
        expect(b.sent).toEqual([]);
        expect(b.mails[0].to).toBe('ada@example.com');
        const code = /code: ([A-Z0-9-]+)/.exec(b.mails[0].text)![1];
        const installId = b64(randomBytes(32));
        const jar = new Jar();
        const signed = await redeemCode(b, { requestId, code, verifier: flow.verifier, installId }, jar);
        const { deviceId } = (await signed.json()) as { deviceId: string };
        expect(b.db.prepare('SELECT signInMethod FROM auth_session WHERE deviceId = ?').get(deviceId)).toEqual({
            signInMethod: 'link:email',
        });
        b.savePolicy({});
        expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal: 'session_ended' });
    });

    it('sends nothing to a deactivated account, or one no channel reaches', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        await b.account('bob@example.com', 'Bob');
        b.linked.add(b.appUserId(ada.id));
        await b.provider.deactivate(ada.id, 'test');
        expect((await ask(b, 'ada@example.com')).status).toBe(200);
        expect((await ask(b, 'bob@example.com')).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(b.sent).toEqual([]);
    });

    it('limits requests per address and codes per account, and never logs a code or an email', async () => {
        const lines: string[] = [];
        const b = await brain();
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                lines.push(args.map(String).join(' '));
            });
        }
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await ask(b, 'ada@example.com', pkce(), '10.3.3.3')).status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
        await vi.waitFor(() => expect(b.sent.length).toBeGreaterThan(0));
        await new Promise((resolve) => setTimeout(resolve, 200));
        // 3 codes per account per 15 minutes.
        expect(b.sent).toHaveLength(3);
        const text = lines.join('\n');
        expect(text).not.toContain('ada@example.com');
        for (const message of b.sent) {
            expect(text).not.toContain(message.link.code!);
        }
        expect(JSON.stringify(b.db.prepare('SELECT * FROM auth_device_code').all())).not.toContain('ada@example.com');
    });
});
