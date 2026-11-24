import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import {
    APP_VARIANTS,
    INSTALL_HEADER,
    LINK_HOST,
    LINK_STAGING_HOST,
    parseAppLink,
    VARIANT_LINK_PATHS,
} from '@socio/shared/device-sign-in';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import type { DeviceSignInEvent } from '../src/server/auth/contract.js';
import { DEVICE_SESSION_SECONDS } from '../src/server/auth/devices.js';
import { betterAuthSettingsFromEnv } from '../src/server/auth/settings.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: the system sign-in sheet's one-time code.
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

async function brain() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-devices-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
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
    return { app, provider, db, call, signIn, account, sessions, devices, resolve, expireIn, savePolicy };
}

const maxAge = (cookie: string | undefined) => Number(/max-age=(\d+)/i.exec(cookie ?? '')?.[1]);

const b64 = (bytes: Buffer) => bytes.toString('base64url');
/** What the app makes for one sheet sign-in. */
function pkce() {
    const verifier = b64(randomBytes(32));
    return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()), state: b64(randomBytes(16)) };
}

/** The whole sheet up to the code: start, then the web's Continue on a signed-in browser. */
/** Opens the start URL in `browser` (the sheet: the same browser that then approves). */
async function start(b: Brain, browser: Jar, flow: { challenge: string; state: string }, variant = 'production') {
    const query = new URLSearchParams({ challenge: flow.challenge, state: flow.state, platform: 'ios', variant });
    const response = await b.app.request(`/api/auth/device/start?${query}`, {
        // Its own address each time: the start's per-address limit is not under test here.
        headers: { 'x-forwarded-for': `10.9.${randomInt(256)}.${randomInt(256)}`, cookie: browser.header },
    });
    return browser.store(response);
}

async function sheet(b: Brain, web: Jar, flow = pkce(), variant = 'production') {
    const started = await start(b, web, flow, variant);
    expect(started.status).toBe(302);
    const to = new URL(started.headers.get('location')!);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe('/device/continue');
    expect(to.searchParams.get('app')).toBe('1');
    expect(to.searchParams.get('platform')).toBe('ios');
    const request = to.searchParams.get('request')!;
    const approve = await b.call(web, '/api/auth/device/approve', { body: { request } });
    expect(approve.status).toBe(200);
    const { redirect } = (await approve.json()) as { redirect: string };
    const link = parseAppLink(redirect, variant === 'development' ? LINK_STAGING_HOST : LINK_HOST);
    expect(link).toMatchObject({ kind: 'cb', variant, host: new URL(ORIGIN).host });
    const fields = link!.fields as { code: string; state: string };
    expect(fields.state).toBe(flow.state);
    return { ...flow, request, redirect, code: fields.code };
}

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

const deviceSessions = (b: Brain) =>
    b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId IS NOT NULL').get() as { n: number };

const redeem = (b: Brain, body: Record<string, unknown>) =>
    b.call(new Jar(), '/api/auth/device/redeem', {
        body: { installId: b64(randomBytes(32)), label: 'iPhone', variant: 'production', ...body },
    });
type Brain = Awaited<ReturnType<typeof brain>>;

describe('the sign-in sheet', () => {
    it('approves nothing for a session other than the one the Continue page showed', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        const started = await start(b, jar, pkce());
        const request = new URL(started.headers.get('location')!).searchParams.get('request')!;
        const shown = ((await (await b.call(jar, '/api/auth/get-session')).json()) as { session: { id: string } })
            .session.id;
        const other = await b.call(jar, '/api/auth/device/approve', { body: { request, session: 'someone-else' } });
        expect(other.status).toBe(403);
        expect(await other.json()).toMatchObject({ code: 'not_authorized' });
        expect((await b.call(jar, '/api/auth/device/approve', { body: { request, session: shown } })).status).toBe(200);
    });

    it('signs the app in once, as the approving person, by the approving session’s method, for 30 days', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const events: DeviceSignInEvent[] = [];
        b.provider.onDeviceSignIn((event) => {
            events.push(event);
        });
        const { jar: web } = await b.signIn('ada@example.com');
        const flow = await sheet(b, web);
        // The code rides in the fragment, never a query or a path.
        expect(new URL(flow.redirect).search).toBe('');
        expect(new URL(flow.redirect).pathname).not.toContain(flow.code);
        const installId = b64(randomBytes(32));
        const jar = new Jar();
        const response = await b.call(jar, '/api/auth/device/redeem', {
            body: {
                code: flow.code.toLowerCase(),
                verifier: flow.verifier,
                installId,
                label: 'iPhone',
                variant: 'production',
            },
        });
        expect(response.status).toBe(200);
        const { deviceId } = (await response.json()) as { deviceId: string };
        const cookie = response.headers.getSetCookie().find((header) => header.startsWith('cb.session_token='));
        expect(maxAge(cookie)).toBeGreaterThan(DEVICE_SESSION_SECONDS - 60);
        const sessions = b.sessions(ada.id);
        expect(sessions).toHaveLength(2);
        const device = b.db.prepare('SELECT * FROM auth_session WHERE deviceId = ?').get(deviceId) as {
            signInMethod: string;
        };
        expect(device.signInMethod).toBe('password');
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
        expect(b.devices(ada.id)).toMatchObject([
            { id: deviceId, label: 'iPhone', platform: 'ios', variant: 'production' },
        ]);
        await vi.waitFor(() =>
            expect(events).toEqual([expect.objectContaining({ deviceId, label: 'iPhone', method: 'password' })]),
        );
        // The composition's listener: the workspace audit and the person's notice.
        const { appUserId } = b.db.prepare('SELECT appUserId FROM auth_user WHERE id = ?').get(ada.id) as {
            appUserId: string;
        };
        await vi.waitFor(() =>
            expect(
                b.db
                    .prepare(`SELECT actor, action, targetId, detail FROM workspace_audit WHERE targetKind = 'device'`)
                    .all(),
            ).toEqual([{ actor: appUserId, action: 'create', targetId: deviceId, detail: 'iPhone; password' }]),
        );
        await vi.waitFor(() =>
            expect(
                b.db.prepare(`SELECT userId, title FROM notifications WHERE trigger = 'device_sign_in'`).all(),
            ).toEqual([{ userId: appUserId, title: 'New device signed in' }]),
        );
        // Used once.
        const again = await redeem(b, { code: flow.code, verifier: flow.verifier });
        expect(again.status).toBe(400);
        expect(await again.json()).toMatchObject({ code: 'code_invalid' });
    });

    it('answers the address limits in the device contract', async () => {
        const b = await brain();
        let last: Response | undefined;
        for (let i = 0; i < 11; i++) {
            last = await redeem(b, { code: 'ABCD-EFGH-JKMN', verifier: pkce().verifier });
        }
        expect(last!.status).toBe(429);
        expect(await last!.json()).toMatchObject({ code: 'too_many' });
        const flow = pkce();
        const query = new URLSearchParams({
            challenge: flow.challenge,
            state: flow.state,
            platform: 'ios',
            variant: 'production',
        });
        let start: Response | undefined;
        for (let i = 0; i < 21; i++) {
            start = await b.app.request(`/api/auth/device/start?${query}`, {
                headers: { 'x-forwarded-for': '10.8.8.8' },
            });
        }
        expect(start!.status).toBe(429);
        expect(await start!.json()).toMatchObject({ code: 'too_many' });
    });

    // Spike 13: iOS's https callback needs webcredentials for the whole link
    // host, so each build is kept apart only by its own /<variant>/cb path.
    it('sends each build’s sheet to its own callback path on the link host, and its code works for that build only', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        for (const variant of APP_VARIANTS) {
            const flow = await sheet(b, web, pkce(), variant);
            const url = new URL(flow.redirect);
            // Development builds have their own link host: never production's.
            expect(url.origin).toBe(
                variant === 'development' ? 'https://link-staging.socio.sh' : 'https://link.socio.sh',
            );
            expect(url.pathname).toBe(`/${VARIANT_LINK_PATHS[variant]}/cb`);
            const other = APP_VARIANTS.find((entry) => entry !== variant)!;
            const answer = await redeem(b, { code: flow.code, verifier: flow.verifier, variant: other });
            expect(await answer.json()).toMatchObject({ code: 'wrong_variant' });
        }
        // Nothing from the request picks the path or the host: an unknown build is refused at start.
        const flow = pkce();
        const query = new URLSearchParams({
            challenge: flow.challenge,
            state: flow.state,
            platform: 'ios',
            variant: '../evil',
        });
        expect((await b.app.request(`/api/auth/device/start?${query}`)).status).toBe(400);
    });

    it('lets one of two concurrent redeems win', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const flow = await sheet(b, (await b.signIn('ada@example.com')).jar);
        const answers = await Promise.all([0, 1, 2].map(() => redeem(b, { code: flow.code, verifier: flow.verifier })));
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400, 400]);
    });

    it('refuses an expired code', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const flow = await sheet(b, (await b.signIn('ada@example.com')).jar);
        b.db.prepare('UPDATE auth_device_request SET codeExpiresAt = ?').run(Date.now() - 1);
        const answer = await redeem(b, { code: flow.code, verifier: flow.verifier });
        expect(await answer.json()).toMatchObject({ code: 'code_expired' });
    });

    it('burns a code redeemed with the wrong verifier', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const flow = await sheet(b, (await b.signIn('ada@example.com')).jar);
        const wrong = await redeem(b, { code: flow.code, verifier: pkce().verifier });
        expect(await wrong.json()).toMatchObject({ code: 'code_invalid' });
        const right = await redeem(b, { code: flow.code, verifier: flow.verifier });
        expect(await right.json()).toMatchObject({ code: 'code_invalid' });
    });

    it('refuses a code made for another build of the app', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const flow = await sheet(b, (await b.signIn('ada@example.com')).jar, pkce(), 'preview');
        const answer = await redeem(b, { code: flow.code, verifier: flow.verifier, variant: 'production' });
        expect(await answer.json()).toMatchObject({ code: 'wrong_variant' });
    });

    it('refuses the code once the approving browser signed out', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const flow = await sheet(b, web);
        expect((await b.call(web, '/api/auth/logout', { body: {} })).status).toBe(200);
        const answer = await redeem(b, { code: flow.code, verifier: flow.verifier });
        expect(answer.status).toBe(403);
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
    });

    // Login CSRF via leaked start URLs: the challenge, state and request id can
    // reach access logs, so none of them alone lets another browser use them.
    it('refuses a second start with a copied challenge or a copied state, and the victim still signs in', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        await b.account('eve@example.com', 'Eve');
        const victim = pkce();
        const { jar: adaWeb } = await b.signIn('ada@example.com');
        const { jar: eveWeb } = await b.signIn('eve@example.com');
        const first = await start(b, adaWeb, victim);
        expect(first.status).toBe(302);
        const bad = await start(b, eveWeb, { challenge: 'not a challenge', state: victim.state });
        const copiedChallenge = await start(b, eveWeb, { challenge: victim.challenge, state: pkce().state });
        const copiedState = await start(b, eveWeb, { challenge: pkce().challenge, state: victim.state });
        for (const answer of [copiedChallenge, copiedState]) {
            expect(answer.status).toBe(bad.status);
            expect(await answer.json()).toEqual(await bad.clone().json());
        }
        // The victim's own request goes on.
        const request = new URL(first.headers.get('location')!).searchParams.get('request')!;
        const approve = await b.call(adaWeb, '/api/auth/device/approve', { body: { request } });
        const { redirect } = (await approve.json()) as { redirect: string };
        const { code } = parseAppLink(redirect)!.fields as { code: string };
        const signed = await redeem(b, { code, verifier: victim.verifier });
        expect(signed.status).toBe(200);
    });

    it('keeps a challenge and state taken long after their request expired (a replay after cleanup is refused too)', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: eveWeb } = await b.signIn('ada@example.com');
        const victim = pkce();
        expect((await start(b, new Jar(), victim)).status).toBe(302);
        // 21 minutes on: the request is long expired, and another start runs the cleanup.
        b.db
            .prepare('UPDATE auth_device_request SET createdAt = createdAt - ?, expiresAt = expiresAt - ?')
            .run(21 * 60_000, 21 * 60_000);
        expect((await start(b, eveWeb, pkce())).status).toBe(302);
        expect((await start(b, eveWeb, victim)).status).toBe(400);
        expect((await start(b, eveWeb, { challenge: pkce().challenge, state: victim.state })).status).toBe(400);
        // After 30 days the rows go.
        b.db.prepare('UPDATE auth_device_request SET createdAt = createdAt - ?').run(31 * 24 * 60 * 60_000);
        await start(b, eveWeb, pkce());
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_device_request').get()).toEqual({ n: 1 });
    });

    it('lets one browser start two requests and approve both', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const requestOf = (response: Response) =>
            new URL(response.headers.get('location')!).searchParams.get('request')!;
        const first = requestOf(await start(b, web, pkce()));
        const second = requestOf(await start(b, web, pkce()));
        expect((await b.call(web, '/api/auth/device/approve', { body: { request: first } })).status).toBe(200);
        expect((await b.call(web, '/api/auth/device/approve', { body: { request: second } })).status).toBe(200);
    });

    it('lets only the browser that started a request approve it (a request id from a log is not enough)', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        await b.account('eve@example.com', 'Eve');
        const { jar: adaWeb } = await b.signIn('ada@example.com');
        const { jar: eveWeb } = await b.signIn('eve@example.com');
        const first = await start(b, adaWeb, pkce());
        const request = new URL(first.headers.get('location')!).searchParams.get('request')!;
        const stolen = await b.call(eveWeb, '/api/auth/device/approve', { body: { request } });
        expect(stolen.status).toBe(400);
        // The victim's browser still can.
        expect((await b.call(adaWeb, '/api/auth/device/approve', { body: { request } })).status).toBe(200);
        expect(first.headers.getSetCookie().join(';')).toMatch(/socio_device_browser=[^;]+;.*HttpOnly/i);
    });

    it('never logs a start link’s challenge, state or request id, or a code', async () => {
        const lines: string[] = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                lines.push(args.map(String).join(' '));
            });
        }
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const flow = await sheet(b, web);
        await start(b, new Jar(), flow);
        await redeem(b, { code: flow.code, verifier: flow.verifier });
        await redeem(b, { code: flow.code, verifier: flow.verifier });
        const text = lines.join('\n');
        for (const secret of [flow.challenge, flow.state, flow.request, flow.code]) {
            expect(text).not.toContain(secret);
        }
    });

    it('lets signing out win over a redeem already making the session', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const flow = await sheet(b, web);
        const hold = await holdCreateSession(b);
        const redeeming = redeem(b, { code: flow.code, verifier: flow.verifier });
        await hold.inside;
        expect((await b.call(web, '/api/auth/logout', { body: {} })).status).toBe(200);
        hold.resume();
        const answer = await redeeming;
        hold.restore();
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
        expect(deviceSessions(b)).toEqual({ n: 0 });
    });

    it('refuses a person deactivated between approve and redeem', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const flow = await sheet(b, web);
        // Deactivation ends the approving session too; keep one to reach the person check.
        b.db.prepare('UPDATE auth_user SET banned = 1 WHERE id = ?').run(ada.id);
        const answer = await redeem(b, { code: flow.code, verifier: flow.verifier });
        expect(answer.status).toBe(403);
        expect(await answer.json()).toMatchObject({ code: 'BANNED_USER' });
    });

    it('ends the device’s session when the approving session’s method is turned off, and refuses it at redeem', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        // As if the browser had signed in with a passkey.
        b.db.prepare(`UPDATE auth_session SET signInMethod = 'passkey' WHERE userId = ?`).run(ada.id);
        const flow = await sheet(b, web);
        const installId = b64(randomBytes(32));
        const jar = new Jar();
        const response = await b.call(jar, '/api/auth/device/redeem', {
            body: { code: flow.code, verifier: flow.verifier, installId, label: 'Pixel', variant: 'production' },
        });
        expect(response.status).toBe(200);
        const { deviceId } = (await response.json()) as { deviceId: string };
        expect(b.db.prepare('SELECT signInMethod FROM auth_session WHERE deviceId = ?').get(deviceId)).toEqual({
            signInMethod: 'passkey',
        });
        const second = await sheet(b, web);
        b.savePolicy({ passkey: false });
        expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal: 'session_ended' });
        const late = await redeem(b, { code: second.code, verifier: second.verifier });
        expect(await late.json()).toMatchObject({ code: 'method_off' });
    });

    it('approves only on a signed-in session, once per request, and never answers the code to a start', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const flow = pkce();
        const query = new URLSearchParams({
            challenge: flow.challenge,
            state: flow.state,
            platform: 'android',
            variant: 'preview',
        });
        const { jar: web } = await b.signIn('ada@example.com');
        const started = await start(b, web, flow, 'preview');
        const request = new URL(started.headers.get('location')!).searchParams.get('request')!;
        expect((await b.call(new Jar(), '/api/auth/device/approve', { body: { request } })).status).toBe(401);
        expect((await b.call(web, '/api/auth/device/approve', { body: { request } })).status).toBe(200);
        const twice = await b.call(web, '/api/auth/device/approve', { body: { request } });
        expect(twice.status).toBe(400);
        // A start with a plain challenge or an unknown build is refused.
        for (const bad of [
            { ...Object.fromEntries(query), challenge: `${flow.challenge}x` },
            { ...Object.fromEntries(query), variant: 'beta' },
        ]) {
            expect((await b.app.request(`/api/auth/device/start?${new URLSearchParams(bad)}`)).status).toBe(400);
        }
    });

    it('never writes a code or a verifier to a log line', async () => {
        const lines: string[] = [];
        const b = await brain();
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                lines.push(args.map(String).join(' '));
            });
        }
        await b.account('ada@example.com', 'Ada');
        const flow = await sheet(b, (await b.signIn('ada@example.com')).jar);
        await redeem(b, { code: flow.code, verifier: pkce().verifier });
        await redeem(b, { code: flow.code, verifier: flow.verifier });
        const text = lines.join('\n');
        expect(text).not.toContain(flow.code);
        expect(text).not.toContain(flow.verifier);
        const stored = JSON.stringify(b.db.prepare('SELECT * FROM auth_device_request').all());
        expect(stored).not.toContain(flow.code);
    });
});

describe('link hosts per build', () => {
    const settings = (env: Record<string, string>) =>
        betterAuthSettingsFromEnv(
            { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, ...env },
            [ORIGIN],
            SECRET,
            () => '',
            () => ({ scopes: [], labels: {} }),
        );

    it('puts production and preview on AUTH_APP_LINK_HOST and development on AUTH_APP_LINK_HOST_DEV', () => {
        expect(settings({})).toMatchObject({ linkHost: 'link.socio.sh', devLinkHost: 'link-staging.socio.sh' });
        expect(
            settings({ AUTH_APP_LINK_HOST: 'links.bench.test', AUTH_APP_LINK_HOST_DEV: 'dev-links.bench.test:8443' }),
        ).toMatchObject({ linkHost: 'links.bench.test', devLinkHost: 'dev-links.bench.test:8443' });
    });

    it('refuses to boot with development links on the production host', () => {
        expect(() => settings({ AUTH_APP_LINK_HOST_DEV: 'link.socio.sh' })).toThrow(/AUTH_APP_LINK_HOST_DEV/);
        expect(() =>
            settings({ AUTH_APP_LINK_HOST: 'links.bench.test', AUTH_APP_LINK_HOST_DEV: 'links.bench.test' }),
        ).toThrow(/AUTH_APP_LINK_HOST_DEV/);
        expect(() => settings({ AUTH_APP_LINK_HOST_DEV: 'not a host/' })).toThrow(/AUTH_APP_LINK_HOST_DEV/);
        // The same origins with https's default port spelled out.
        expect(() => settings({ AUTH_APP_LINK_HOST_DEV: 'link.socio.sh:443' })).toThrow(/AUTH_APP_LINK_HOST_DEV/);
        expect(() =>
            settings({ AUTH_APP_LINK_HOST: 'links.bench.test:443', AUTH_APP_LINK_HOST_DEV: 'links.bench.test' }),
        ).toThrow(/AUTH_APP_LINK_HOST_DEV/);
        expect(settings({ AUTH_APP_LINK_HOST: 'links.bench.test:443' }).linkHost).toBe('links.bench.test');
    });
});
