import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import {
    APP_POLICY_DEFAULTS,
    appPolicyFromEnv,
    DEVICE_PROTOCOL,
    INSTALL_HEADER,
    WORKSPACE_MANIFEST_PATH,
    workspaceManifestSchema,
} from '@socio/shared/device-sign-in';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import type { SignInLinkSender } from '../src/server/auth/contract.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: the workspace manifest and the session check's 401 codes.
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
    vi.unstubAllEnvs();
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
    /** Whether the fake bot is online. */
    const telegramRunning = { on: true };
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
        available: () => telegramRunning.on,
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
        telegramRunning,
        appUserId,
        path,
        env: auth,
    };
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const newInstallId = () => b64(randomBytes(32));
type Brain = Awaited<ReturnType<typeof brain>>;
const manifest = async (b: Brain, headers: Record<string, string> = {}) => {
    const response = await b.app.request(WORKSPACE_MANIFEST_PATH, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('max-age=60');
    return workspaceManifestSchema.parse(await response.json());
};
/** An app request to a session-checked route, as `jar` and with `installId`. */
const appRequest = (b: Brain, jar: Jar, installId?: string) =>
    b.app.request('/api/rooms', {
        headers: {
            ...(jar.header ? { cookie: jar.header } : {}),
            ...(installId ? { [INSTALL_HEADER]: installId, 'user-agent': APP_UA } : {}),
        },
    });

describe('the workspace manifest', () => {
    it('describes the workspace and its ways in, publicly, the same with or without a cookie', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        const anonymous = await manifest(b);
        expect(anonymous).toMatchObject({
            id: b.provider.workspaceId(),
            origin: ORIGIN,
            name: 'Socio',
            branding: { name: 'Socio', logo: '/favicon.svg' },
            protocol: DEVICE_PROTOCOL,
            methods: { password: true, sheet: true, signInCodes: 'telegram', addDevice: true },
            policy: { leaseDays: 30, wipeDays: 30, appLock: false, notificationText: true },
        });
        expect(anonymous.serverVersion).toMatch(/\d/);
        expect(await manifest(b, { cookie: jar.header })).toEqual(anonymous);
        // No cookie is set or read.
        const response = await b.app.request(WORKSPACE_MANIFEST_PATH, { headers: { cookie: jar.header } });
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('says how sign-in codes go: email while on, Telegram while its bot runs, else none', async () => {
        const b = await brain();
        expect((await manifest(b)).methods.signInCodes).toBe('telegram');
        b.telegramRunning.on = false;
        expect((await manifest(b)).methods.signInCodes).toBeNull();
        b.savePolicy({ emailLinks: true });
        expect((await manifest(b)).methods.signInCodes).toBe('email');
        b.telegramRunning.on = true;
        b.savePolicy({ emailLinks: true, signInLink: false });
        expect((await manifest(b)).methods.signInCodes).toBe('email');
        b.savePolicy({ signInLink: false });
        expect((await manifest(b)).methods.signInCodes).toBeNull();
    });

    it('follows the policy for passwords and passkeys, and offers Add a device only where links can be made', async () => {
        const b = await brain({ AUTH_APP_PREVIEW_LINKS: 'false' });
        b.savePolicy({ passkey: false });
        expect((await manifest(b)).methods).toMatchObject({ password: true, passkey: false, addDevice: false });
        b.savePolicy({});
        expect((await manifest(b)).methods).toMatchObject({ password: true, passkey: true });
    });
});

// CB-379: the app's policy, admin-editable over the environment's.
describe('the app’s policy in the manifest', () => {
    const patch = (b: Brain, jar: Jar, body: unknown) =>
        b.app.request('/api/settings', {
            method: 'PATCH',
            headers: { cookie: jar.header, origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const adminWeb = async (b: Brain) => {
        await b.provider.createAccount({
            email: 'admin@example.com',
            name: 'Admin',
            role: 'admin',
            password: PASSWORD,
        });
        return (await b.signIn('admin@example.com')).jar;
    };

    it('gives an admin’s choices, each over the app’s default, and in the state', async () => {
        const b = await brain();
        const admin = await adminWeb(b);
        expect((await patch(b, admin, { appPolicy: { leaseDays: 14, appLock: true } })).status).toBe(200);
        expect((await manifest(b)).policy).toEqual({
            leaseDays: 14,
            wipeDays: 30,
            appLock: true,
            notificationText: true,
        });
        // The ones left out stay as they are.
        expect((await patch(b, admin, { appPolicy: { wipeDays: 7, notificationText: false } })).status).toBe(200);
        expect((await manifest(b)).policy).toEqual({
            leaseDays: 14,
            wipeDays: 7,
            appLock: true,
            notificationText: false,
        });
        const state = (await (await b.call(admin, '/api/state')).json()) as { settings: { appPolicy: unknown } };
        expect(state.settings.appPolicy).toEqual({
            leaseDays: 14,
            wipeDays: 7,
            appLock: true,
            notificationText: false,
        });
    });

    it('keeps both of two partial changes saved at once', async () => {
        const b = await brain();
        const admin = await adminWeb(b);
        const answers = await Promise.all([
            patch(b, admin, { appPolicy: { leaseDays: 14 } }),
            patch(b, admin, { appPolicy: { notificationText: false } }),
        ]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        expect((await manifest(b)).policy).toEqual({
            leaseDays: 14,
            wipeDays: 30,
            appLock: false,
            notificationText: false,
        });
    });

    it('refuses values the app can’t hold, and members', async () => {
        const b = await brain();
        const admin = await adminWeb(b);
        for (const appPolicy of [
            { leaseDays: 0 },
            { leaseDays: 366 },
            { wipeDays: 6 },
            { leaseDays: 1.5 },
            { appLock: 'yes' },
            { other: true },
        ]) {
            expect((await patch(b, admin, { appPolicy })).status).toBe(400);
        }
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        expect((await patch(b, jar, { appPolicy: { leaseDays: 10 } })).status).toBe(403);
        expect((await manifest(b)).policy).toEqual(APP_POLICY_DEFAULTS);
    });

    it('takes the environment’s defaults, under an admin’s', async () => {
        vi.stubEnv('AUTH_APP_LEASE_DAYS', '10');
        vi.stubEnv('AUTH_APP_WIPE_DAYS', '20');
        vi.stubEnv('AUTH_APP_LOCK', 'true');
        vi.stubEnv('AUTH_APP_NOTIFICATION_TEXT', 'off');
        const b = await brain();
        expect((await manifest(b)).policy).toEqual({
            leaseDays: 10,
            wipeDays: 20,
            appLock: true,
            notificationText: false,
        });
        const admin = await adminWeb(b);
        expect((await patch(b, admin, { appPolicy: { appLock: false } })).status).toBe(200);
        expect((await manifest(b)).policy).toEqual({
            leaseDays: 10,
            wipeDays: 20,
            appLock: false,
            notificationText: false,
        });
    });

    it('stops at a variable that isn’t one', () => {
        expect(appPolicyFromEnv({})).toEqual(APP_POLICY_DEFAULTS);
        expect(() => appPolicyFromEnv({ AUTH_APP_LEASE_DAYS: 'thirty' })).toThrow(/AUTH_APP_LEASE_DAYS/);
        expect(() => appPolicyFromEnv({ AUTH_APP_WIPE_DAYS: '3' })).toThrow(/from 7 to 365/);
        expect(() => appPolicyFromEnv({ AUTH_APP_LOCK: 'maybe' })).toThrow(/AUTH_APP_LOCK must be true or false/);
    });
});

describe('the session check’s 401 codes', () => {
    it('keeps the web’s 401 as it was', async () => {
        const b = await brain();
        const answer = await appRequest(b, new Jar());
        expect(answer.status).toBe(401);
        expect(await answer.json()).toEqual({ error: 'Sign in to continue.', code: 'sign_in' });
    });

    it('tells the app its session expired', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        await b.expireIn(b.sessions(ada.id)[0].token, -60);
        b.db.prepare('UPDATE auth_device SET sessionExpiresAt = ?').run(Date.now() - 60_000);
        const answer = await appRequest(b, jar, installId);
        expect(answer.status).toBe(401);
        expect(await answer.json()).toMatchObject({ code: 'session_expired' });
    });

    it('tells the app its session ended, or its device was signed out (with erase)', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        b.db.prepare('DELETE FROM auth_session WHERE userId = ?').run(ada.id);
        expect(await (await appRequest(b, jar, installId)).json()).toMatchObject({ code: 'session_ended' });
        for (const [state, code] of [
            ['revoked', 'session_ended'],
            ['revoked_and_erase', 'device_revoked'],
        ]) {
            b.db.prepare('UPDATE auth_device SET state = ?').run(state);
            const answer = await appRequest(b, new Jar(), installId);
            expect(answer.status).toBe(401);
            expect(await answer.json()).toMatchObject({ code });
        }
    });

    it('tells the app its person was deactivated', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        await b.provider.deactivate(ada.id, 'test');
        expect(await (await appRequest(b, jar, installId)).json()).toMatchObject({ code: 'deactivated' });
    });
});
