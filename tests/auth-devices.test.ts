import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { AuthSession } from '@socio/shared/auth';
import { INSTALL_HEADER } from '@socio/shared/device-sign-in';

import { forwardHeaders } from '../src/server/apps/proxy.js';
import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { DEVICE_SESSION_SECONDS, deviceFromUserAgent, Devices, installIdHash } from '../src/server/auth/devices.js';
import { authSchema } from '../src/server/auth/schema.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: the app's devices, install ids and 30-day device sessions.

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60;
const WEB_SECONDS = 7 * DAY;
const APP_UA = 'Socio/0.6.1 (iPhone; iOS 26)';

const newInstallId = () => randomBytes(32).toString('base64url');

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
    return { app, provider, db, call, signIn, account, sessions, devices, resolve, expireIn };
}

const toMs = (value: string | number) => (typeof value === 'number' ? value : Date.parse(value));
const maxAge = (cookie: string | undefined) => Number(/max-age=(\d+)/i.exec(cookie ?? '')?.[1]);
const sessionCookie = (response: Response) =>
    response.headers.getSetCookie().find((header) => header.startsWith('cb.session_token='));

describe('device sessions', () => {
    it('leaves a web sign-in as it was: seven days, no device', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { response } = await b.signIn('ada@example.com');
        expect(maxAge(sessionCookie(response))).toBe(WEB_SECONDS);
        const [session] = b.sessions(ada.id);
        expect(session.deviceId).toBeNull();
        expect(toMs(session.expiresAt) - Date.now()).toBeLessThanOrEqual(WEB_SECONDS * 1000);
        expect(b.devices(ada.id)).toEqual([]);
    });

    it('attaches a password sign-in from the app to its device, for 30 days, and the cookie says so', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar, response } = await b.signIn('ada@example.com', installId);
        const age = maxAge(sessionCookie(response));
        expect(age).toBeGreaterThan(DEVICE_SESSION_SECONDS - 60);
        expect(age).toBeLessThanOrEqual(DEVICE_SESSION_SECONDS);
        const [device] = b.devices(ada.id);
        expect(device).toMatchObject({ label: 'iPhone', platform: 'ios', variant: null, state: 'active' });
        expect(device.installIdHash).toBe(createHash('sha256').update(installId).digest('base64url'));
        expect(device.installIdHash).not.toBe(installId);
        const [session] = b.sessions(ada.id);
        expect(session.deviceId).toBe(device.id);
        expect(Math.abs(toMs(session.expiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(60_000);
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
    });

    it('never stores, answers or echoes the install id', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar, response } = await b.signIn('ada@example.com', installId);
        expect(await response.clone().text()).not.toContain(installId);
        expect([...response.headers].flat().join('\n')).not.toContain(installId);
        const session = await b.call(jar, '/api/auth/session', { headers: { [INSTALL_HEADER]: installId } });
        expect(await session.text()).not.toContain(installId);
        for (const table of ['auth_device', 'auth_session', 'auth_user', 'auth_account', 'auth_verification']) {
            const rows = b.db.prepare(`SELECT * FROM ${table}`).all();
            expect(JSON.stringify(rows), table).not.toContain(installId);
        }
        expect(b.devices(ada.id)).toHaveLength(1);
    });

    it('is not passed on to workspace apps and plugins by their proxy', () => {
        const installId = newInstallId();
        const headers = forwardHeaders(
            [
                ['X-Socio-Install', installId],
                ['accept', 'text/html'],
            ],
            { host: 'app.example', protocol: 'https:' },
        );
        expect(headers.accept).toBe('text/html');
        expect(JSON.stringify(headers)).not.toContain(installId);
    });

    it('slides a device session back to 30 days at most once a day, cookie included', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        // Fresh: nothing to renew.
        expect((await b.resolve(jar, installId)).cookies).toEqual([]);
        // Two days later.
        await b.expireIn(b.sessions(ada.id)[0].token, DEVICE_SESSION_SECONDS - 2 * DAY);
        const renewed = await b.resolve(jar, installId);
        expect(renewed.user).not.toBeNull();
        expect(renewed.cookies).toHaveLength(1);
        expect(renewed.cookies[0]).toMatch(/^cb\.session_token=/);
        expect(renewed.cookies[0]).toContain('HttpOnly');
        expect(renewed.cookies[0]).toContain('SameSite=Strict');
        expect(maxAge(renewed.cookies[0])).toBe(DEVICE_SESSION_SECONDS);
        const [device] = b.devices(ada.id);
        expect(Math.abs(Number(device.sessionExpiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(
            60_000,
        );
        const [session] = b.sessions(ada.id);
        expect(Math.abs(toMs(session.expiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(60_000);
        // The renewed cookie still signs in, and doesn't renew again the same day.
        const again = await b.resolve(jar, installId);
        expect(again.user?.name).toBe('Ada');
        expect(again.cookies).toEqual([]);
    });

    it('never renews a device session signed in without “remember me” into a lasting cookie', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const jar = new Jar();
        const response = await b.call(jar, '/api/auth/sign-in/email', {
            body: { email: 'ada@example.com', password: PASSWORD, rememberMe: false },
            headers: { [INSTALL_HEADER]: installId, 'user-agent': APP_UA },
        });
        expect(response.status).toBe(200);
        expect(sessionCookie(response)).not.toMatch(/max-age/i);
        await b.expireIn(b.sessions(ada.id)[0].token, DEVICE_SESSION_SECONDS - 2 * DAY);
        const later = await b.resolve(jar, installId);
        expect(later.user?.name).toBe('Ada');
        expect(later.cookies.filter((cookie) => /max-age=[1-9]/i.test(cookie))).toEqual([]);
    });

    it('records a password change’s new device session on the device', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        await b.expireIn(b.sessions(ada.id)[0].token, 20 * DAY);
        b.db.prepare('UPDATE auth_device SET sessionExpiresAt = ?').run(Date.now() + 20 * DAY * 1000);
        const changed = await b.call(jar, '/api/auth/change-password', {
            body: { currentPassword: PASSWORD, newPassword: 'another-horse-battery', revokeOtherSessions: true },
            headers: { [INSTALL_HEADER]: installId },
        });
        expect(changed.status).toBe(200);
        const [session] = b.sessions(ada.id);
        const [device] = b.devices(ada.id);
        expect(session.deviceId).toBe(device.id);
        expect(Math.abs(toMs(session.expiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(60_000);
        expect(Math.abs(Number(device.sessionExpiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(
            60_000,
        );
    });

    it('renews to 30 days, not seven, when Better Auth renews a device session itself', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        // Within Better Auth's own window (its seven days less a day).
        await b.expireIn(b.sessions(ada.id)[0].token, 3 * DAY);
        const response = await b.call(jar, '/api/auth/session', { headers: { [INSTALL_HEADER]: installId } });
        expect(((await response.json()) as AuthSession).user?.name).toBe('Ada');
        const cookies = response.headers.getSetCookie().filter((header) => header.startsWith('cb.session_token='));
        expect(cookies).toHaveLength(1);
        expect(maxAge(cookies[0])).toBeGreaterThan(DEVICE_SESSION_SECONDS - 60);
        const [session] = b.sessions(ada.id);
        expect(Math.abs(toMs(session.expiresAt) - Date.now() - DEVICE_SESSION_SECONDS * 1000)).toBeLessThan(60_000);
    });

    it('renews a web session to seven days, as before', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        await b.expireIn(b.sessions(ada.id)[0].token, 3 * DAY);
        const response = await b.call(jar, '/api/auth/session');
        expect(maxAge(sessionCookie(response))).toBe(WEB_SECONDS);
        const [session] = b.sessions(ada.id);
        expect(Math.abs(toMs(session.expiresAt) - Date.now() - WEB_SECONDS * 1000)).toBeLessThan(60_000);
    });

    it('treats a malformed install id as none', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { response } = await b.signIn('ada@example.com', 'not-an-install-id');
        expect(maxAge(sessionCookie(response))).toBe(WEB_SECONDS);
        expect(b.devices(ada.id)).toEqual([]);
    });
});

describe('one install id, one person', () => {
    it('keeps one device row for one person signing in again', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        await b.signIn('ada@example.com', installId);
        await b.signIn('ada@example.com', installId);
        expect(b.devices(ada.id)).toHaveLength(1);
        expect(new Set(b.sessions(ada.id).map((session) => session.deviceId)).size).toBe(1);
    });

    it('gives another person’s sign-in its own row, and leaves the first person’s sessions as they are', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const bob = await b.account('bob@example.com', 'Bob');
        const installId = newInstallId();
        const first = await b.signIn('ada@example.com', installId);
        const second = await b.signIn('bob@example.com', installId);
        const [adaDevice] = b.devices(ada.id);
        const [bobDevice] = b.devices(bob.id);
        // Only the id moved: Ada's row and session stay, still active.
        expect(adaDevice).toMatchObject({ installIdHash: null, state: 'active', endedAt: null });
        expect(bobDevice.installIdHash).toBe(installIdHash(installId));
        expect(bobDevice.id).not.toBe(adaDevice.id);
        expect(b.sessions(ada.id).map((session) => session.deviceId)).toEqual([adaDevice.id]);
        expect((await b.resolve(first.jar, installId)).user?.name).toBe('Ada');
        expect((await b.resolve(second.jar, installId)).user?.name).toBe('Bob');
    });

    it('leaves the first person signed in when another person’s sign-in on the install id is refused', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const carol = await b.account('carol@example.com', 'Carol');
        await b.account('bob@example.com', 'Bob');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        const [before] = b.devices(ada.id);
        const headers = { [INSTALL_HEADER]: installId, 'user-agent': APP_UA };
        // A wrong password, an unknown account and a deactivated one.
        const wrong = await b.call(new Jar(), '/api/auth/sign-in/email', {
            body: { email: 'bob@example.com', password: 'not-the-password' },
            headers,
        });
        expect(wrong.status).toBe(401);
        const unknown = await b.call(new Jar(), '/api/auth/sign-in/email', {
            body: { email: 'nobody@example.com', password: PASSWORD },
            headers,
        });
        expect(unknown.status).toBe(401);
        await b.provider.deactivate(carol.id, 'test');
        const banned = await b.call(new Jar(), '/api/auth/sign-in/email', {
            body: { email: 'carol@example.com', password: PASSWORD },
            headers,
        });
        expect(banned.status).toBe(403);
        expect(b.devices(carol.id)).toEqual([]);
        expect(b.devices(ada.id)).toEqual([before]);
        expect(b.sessions(ada.id)).toHaveLength(1);
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
    });

    it('keeps both people signed in when two sign-ins on one install id race', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const bob = await b.account('bob@example.com', 'Bob');
        const installId = newInstallId();
        const [first, second] = await Promise.all([
            b.signIn('ada@example.com', installId),
            b.signIn('bob@example.com', installId),
        ]);
        expect((await b.resolve(first.jar, installId)).user?.name).toBe('Ada');
        expect((await b.resolve(second.jar, installId)).user?.name).toBe('Bob');
        const holders = b.db.prepare('SELECT count(*) AS n FROM auth_device WHERE installIdHash IS NOT NULL').get() as {
            n: number;
        };
        expect(holders.n).toBe(1);
        expect([...b.devices(ada.id), ...b.devices(bob.id)]).toHaveLength(2);
    });

    it('gives a signed-out device a new row when its person signs in on it again', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        await b.signIn('ada@example.com', installId);
        b.db.prepare(`UPDATE auth_device SET state = 'revoked'`).run();
        const { jar } = await b.signIn('ada@example.com', installId);
        const rows = b.devices(ada.id);
        expect(rows.map((row) => row.state)).toEqual(['revoked', 'active']);
        expect(rows[0].installIdHash).toBeNull();
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
    });
});

describe('why a request from the app was refused', () => {
    it('leaves a session made without an install id as it is, with or without one later', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        // A signed-out device's install id, too: the session isn't that device's.
        const revokedId = newInstallId();
        await b.signIn('ada@example.com', revokedId);
        b.db.prepare(`UPDATE auth_device SET state = 'revoked'`).run();
        for (const installId of [undefined, newInstallId(), revokedId]) {
            expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
            const session = await b.call(jar, '/api/auth/session', {
                headers: installId ? { [INSTALL_HEADER]: installId } : {},
            });
            expect(((await session.json()) as AuthSession).user?.name).toBe('Ada');
        }
        // Never bound afterwards: still no device, and no new device rows.
        expect(b.sessions(ada.id).filter((session) => session.deviceId === null)).toHaveLength(1);
        expect(b.devices(ada.id)).toHaveLength(1);
    });

    it('says nothing for a request without an install id', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        b.db.prepare('DELETE FROM auth_session').run();
        expect(await b.resolve(jar)).toMatchObject({ user: null, refusal: null });
    });

    it('refuses a signed-out device with or without a live session', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        // "Sign out this device" locks the app as an ended session does; "Sign
        // out and erase" has it erase its copy.
        for (const [state, refusal] of [
            ['revoked', 'session_ended'],
            ['revoked_and_erase', 'device_revoked'],
        ]) {
            b.db.prepare('UPDATE auth_device SET state = ?').run(state);
            expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal });
            expect(await b.resolve(new Jar(), installId)).toMatchObject({ user: null, refusal });
        }
        // Its session's own device signed out, whatever install id comes with it:
        // the session ends.
        expect(await b.resolve(jar)).toMatchObject({ user: null });
        expect(b.sessions(ada.id)).toHaveLength(0);
    });

    it('keeps a signed-out device’s cookie out of Better Auth’s own endpoints', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        b.db.prepare(`UPDATE auth_device SET state = 'revoked'`).run();
        const update = await b.call(jar, '/api/auth/update-user', { body: { name: 'Mallory' } });
        expect(update.status).toBe(401);
        expect(b.db.prepare('SELECT name FROM auth_user WHERE id = ?').get(ada.id)).toEqual({ name: 'Ada' });
        expect(b.sessions(ada.id)).toHaveLength(0);
        // Signing in again on it still works, as a new device.
        const again = await b.signIn('ada@example.com', installId);
        expect((await b.resolve(again.jar, installId)).user?.name).toBe('Ada');
    });

    it('tells an expired session from one that ended', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        const token = b.sessions(ada.id)[0].token;
        await b.expireIn(token, -60);
        b.db.prepare('UPDATE auth_device SET sessionExpiresAt = ?').run(Date.now() - 60_000);
        expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal: 'session_expired' });
        // Better Auth deleted the row on that look; the next one still says expired.
        expect(b.sessions(ada.id)).toHaveLength(0);
        expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal: 'session_expired' });
        // And so does the app, whose jar dropped the expired cookie.
        expect(await b.resolve(new Jar(), installId)).toMatchObject({ user: null, refusal: 'session_expired' });

        const again = await b.signIn('ada@example.com', installId);
        b.db.prepare('DELETE FROM auth_session WHERE userId = ?').run(ada.id);
        expect(await b.resolve(again.jar, installId)).toMatchObject({ user: null, refusal: 'session_ended' });
        expect(await b.resolve(new Jar(), installId)).toMatchObject({ user: null, refusal: 'session_ended' });
    });

    it('says a deactivated person was deactivated', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const installId = newInstallId();
        const { jar } = await b.signIn('ada@example.com', installId);
        await b.provider.deactivate(ada.id, 'test');
        expect(await b.resolve(jar, installId)).toMatchObject({ user: null, refusal: 'deactivated' });
        // Its cookie gone too (expired in the app's jar), the install id still says so.
        expect(await b.resolve(new Jar(), installId)).toMatchObject({ user: null, refusal: 'deactivated' });
    });
});

describe('the device table', () => {
    it('writes lastSeenAt at most once an hour per device', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const devices = new Devices(() => b.db);
        const id = devices.attach(
            newInstallId(),
            ada.id,
            deviceFromUserAgent('Socio/1.0 (Android; Android 16)'),
            1_000,
        );
        const seen = () =>
            (b.db.prepare('SELECT lastSeenAt FROM auth_device WHERE id = ?').get(id) as { lastSeenAt: number })
                .lastSeenAt;
        devices.touch(id, 1_000 + 30 * 60_000);
        expect(seen()).toBe(1_000);
        devices.touch(id, 1_000 + 61 * 60_000);
        expect(seen()).toBe(1_000 + 61 * 60_000);
    });

    it('names a device from the app’s User-Agent only', () => {
        expect(deviceFromUserAgent('Socio/0.1.0 (iPad; iOS 26)')).toEqual({
            label: 'iPad',
            platform: 'ios',
            variant: null,
        });
        expect(deviceFromUserAgent('Socio/0.1.0 (Android; Android 16)')).toEqual({
            label: 'Android',
            platform: 'android',
            variant: null,
        });
        expect(deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')).toEqual({
            label: 'Socio app',
            platform: null,
            variant: null,
        });
    });
});

describe('auth migration 8', () => {
    it('migrates a version 7 database with sessions in it, which the previous release can still write', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-devices-v6-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const path = join(dir, 'brain.sqlite');
        const v6 = schemas.map((set) =>
            set.id === 'auth' ? { ...set, migrations: authSchema.migrations!.slice(0, 7) } : set,
        );
        expect(authSchema.migrations![7]).toMatchObject({ version: 8, phase: 'expand' });
        migrateDatabase(path, v6, { backupDirectory: join(dir, 'backups') });
        const at = new Date().toISOString();
        const insertSession = (db: DatabaseSync, id: string) =>
            db
                .prepare(
                    'INSERT INTO auth_session(id, expiresAt, token, createdAt, updatedAt, userId, signInMethod) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(id, at, `token-${id}`, at, at, 'acc', 'password');
        let db = new DatabaseSync(path);
        db.prepare(
            'INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
        ).run('acc', 'Ada', 'ada@example.com', at, at);
        insertSession(db, 's1');
        db.close();

        migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
        db = new DatabaseSync(path);
        try {
            const workspace = db.prepare('SELECT id FROM auth_workspace').all() as { id: string }[];
            expect(workspace).toHaveLength(1);
            expect(workspace[0].id).toMatch(/^w_[0-9a-f]{32}$/);
            expect(() =>
                db.prepare('INSERT INTO auth_workspace(id, createdAt) VALUES (?, 1)').run('w_other'),
            ).toThrow();
            expect(db.prepare('SELECT id, deviceId FROM auth_session').all()).toEqual([{ id: 's1', deviceId: null }]);
            // The previous release's session insert, with v6's columns only.
            insertSession(db, 's2');
            expect(db.prepare('SELECT count(*) AS n FROM auth_session').get()).toEqual({ n: 2 });
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO auth_device(id, installIdHash, userId, label, state, createdAt) VALUES ('d', 'h', 'acc', 'x', 'lost', 1)`,
                    )
                    .run(),
            ).toThrow();
        } finally {
            db.close();
        }
        // The id stays put across boots.
        migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
        const again = new DatabaseSync(path);
        expect(new Devices(() => again).workspaceId()).toMatch(/^w_[0-9a-f]{32}$/);
        again.close();
    });

    it('gives the provider the workspace id', async () => {
        const b = await brain();
        const id = b.provider.workspaceId();
        expect(id).toMatch(/^w_[0-9a-f]{32}$/);
        expect(b.provider.workspaceId()).toBe(id);
    });
});
