import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import { deviceListSchema, INSTALL_HEADER } from '@socio/shared/device-sign-in';
import { LEAVE_WORKSPACE_PATH } from '@socio/shared/leave-workspace';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { CLI_ACTOR, authCli } from '../src/server/auth/cli.js';
import type { DeviceEnding, SignInLinkSender } from '../src/server/auth/contract.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: the Devices list, signing devices out, and their push subscriptions.
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
    const { app, dispose, workspace } = await makeTestRuntime({
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
        dir,
        workspace,
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
const newInstallId = () => b64(randomBytes(32));
type Brain = Awaited<ReturnType<typeof brain>>;

/** A person signed in on the web and in the app (one device), with a push subscription for it. */
async function phoneOf(b: Brain, email: string, name: string, role: 'member' | 'admin' = 'member') {
    await b.provider.createAccount({ email, name, role, password: PASSWORD });
    const account = b.db.prepare('SELECT id, appUserId FROM auth_user WHERE email = ?').get(email) as {
        id: string;
        appUserId: string;
    };
    const installId = newInstallId();
    const { jar: app } = await b.signIn(email, installId);
    const { jar: web } = await b.signIn(email);
    const appCall = (path: string, init: { body?: unknown; method?: string } = {}) =>
        b.app.request(path, {
            method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
            headers: {
                cookie: app.header,
                [INSTALL_HEADER]: installId,
                'user-agent': APP_UA,
                ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    const endpoint = `https://push.example.com/${b64(randomBytes(9))}`;
    b.db
        .prepare(
            "INSERT INTO notification_push_subscriptions(id, userId, endpoint, p256dh, auth, device, createdAt, failures) VALUES (?, ?, ?, 'k', 'a', 'Socio app', ?, 0)",
        )
        .run(`sub-${installId.slice(0, 8)}`, account.appUserId, endpoint, Date.now());
    expect((await appCall('/api/auth/device/push', { method: 'PUT', body: { endpoint } })).status).toBe(200);
    const deviceId = (b.db.prepare('SELECT id FROM auth_device WHERE userId = ?').get(account.id) as { id: string }).id;
    const pushed = () =>
        (
            b.db
                .prepare('SELECT count(*) AS n FROM notification_push_subscriptions WHERE endpoint = ?')
                .get(endpoint) as { n: number }
        ).n;
    const state = () =>
        (b.db.prepare('SELECT state FROM auth_device WHERE id = ?').get(deviceId) as { state: string }).state;
    return { account, installId, app, web, appCall, endpoint, deviceId, pushed, state };
}

const audits = (b: Brain, deviceId: string) =>
    b.db
        .prepare(
            "SELECT actor, action, detail FROM workspace_audit WHERE targetKind = 'device' AND targetId = ? AND action = 'revoke'",
        )
        .all(deviceId) as { actor: string; action: string; detail: string }[];

describe('the Devices list', () => {
    it('lists the person’s own devices, marks the one asking, and says how it signed in', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        await phoneOf(b, 'bob@example.com', 'Bob');
        const listed = await ada.appCall('/api/auth/devices');
        expect(listed.status).toBe(200);
        const { devices } = deviceListSchema.parse(await listed.json());
        expect(devices).toEqual([
            expect.objectContaining({
                id: ada.deviceId,
                state: 'active',
                signInMethod: 'password',
                current: true,
                platform: 'ios',
            }),
        ]);
        // From the web, the same list, nothing current.
        const fromWeb = deviceListSchema.parse(await (await b.call(ada.web, '/api/auth/devices')).json());
        expect(fromWeb.devices.map((device) => [device.id, device.current])).toEqual([[ada.deviceId, false]]);
        expect((await b.call(new Jar(), '/api/auth/devices')).status).toBe(401);
    });

    it('takes the push endpoint only from the device’s own session, and only https', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        expect(
            (
                await b.call(ada.web, '/api/auth/device/push', {
                    body: { endpoint: 'https://push.example.com/x' },
                    headers: {},
                })
            ).status,
        ).not.toBe(200);
        const web = await b.app.request('/api/auth/device/push', {
            method: 'PUT',
            headers: { cookie: ada.web.header, 'content-type': 'application/json', origin: ORIGIN },
            body: JSON.stringify({ endpoint: 'https://push.example.com/x' }),
        });
        expect(web.status).toBe(403);
        expect(
            (
                await ada.appCall('/api/auth/device/push', {
                    method: 'PUT',
                    body: { endpoint: 'http://push.example.com/x' },
                })
            ).status,
        ).toBe(400);
        expect(b.db.prepare('SELECT pushEndpoint FROM auth_device WHERE id = ?').get(ada.deviceId)).toEqual({
            pushEndpoint: ada.endpoint,
        });
    });
});

describe('signing a device out', () => {
    it('signs one of the person’s devices out, with or without erase: its sessions, its push subscription, audited', async () => {
        for (const [query, state, code] of [
            ['', 'revoked', 'session_ended'],
            ['?erase=1', 'revoked_and_erase', 'device_revoked'],
        ]) {
            const b = await brain();
            const ada = await phoneOf(b, 'ada@example.com', 'Ada');
            const gone = await b.app.request(`/api/auth/devices/${ada.deviceId}${query}`, {
                method: 'DELETE',
                headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            });
            expect(gone.status).toBe(200);
            expect(ada.state()).toBe(state);
            expect(ada.pushed()).toBe(0);
            expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId = ?').get(ada.deviceId)).toEqual(
                { n: 0 },
            );
            expect(audits(b, ada.deviceId)).toEqual([
                {
                    actor: ada.account.appUserId,
                    action: 'revoke',
                    detail: `iPhone; ${state}; from the Devices list in their settings`,
                },
            ]);
            // Refused with its cookie or without one.
            for (const answer of [
                await ada.appCall('/api/rooms'),
                await b.app.request('/api/rooms', { headers: { [INSTALL_HEADER]: ada.installId } }),
            ]) {
                expect(answer.status).toBe(401);
                expect(await answer.json()).toMatchObject({ code });
            }
        }
    });

    it('refuses another person’s device', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        const answer = await b.app.request(`/api/auth/devices/${bob.deviceId}?erase=1`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(answer.status).toBe(404);
        expect(bob.state()).toBe('active');
        expect(bob.pushed()).toBe(1);
        expect((await bob.appCall('/api/rooms')).status).not.toBe(401);
    });

    it('ends devices on sign out everywhere without erasing them, and they can sign in again', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        expect((await b.call(ada.web, '/api/auth/revoke-sessions', { body: {} })).status).toBe(200);
        expect(ada.state()).toBe('active');
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toEqual([
            expect.objectContaining({ detail: 'iPhone; signed_out; signed out everywhere' }),
        ]);
        expect(await (await ada.appCall('/api/rooms')).json()).toMatchObject({ code: 'session_ended' });
        const again = await b.signIn('ada@example.com', ada.installId);
        expect(again.response.status).toBe(200);
    });

    it('signs everything out when the app asks, web sessions included', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const answer = await b.app.request('/api/auth/revoke-sessions', {
            method: 'POST',
            headers: {
                cookie: ada.app.header,
                [INSTALL_HEADER]: ada.installId,
                'user-agent': APP_UA,
                origin: ORIGIN,
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(answer.status).toBe(200);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE userId = ?').get(ada.account.id)).toEqual({
            n: 0,
        });
        expect((await b.call(ada.web, '/api/auth/devices')).status).toBe(401);
        expect(ada.pushed()).toBe(0);
    });

    it('never takes back an erase with a later plain sign-out, from the person or an admin', async () => {
        const b = await brain();
        const admin = await phoneOf(b, 'admin@example.com', 'Admin', 'admin');
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const del = (jar: Jar, path: string) =>
            b.app.request(path, {
                method: 'DELETE',
                headers: { cookie: jar.header, origin: ORIGIN, 'content-type': 'application/json' },
            });
        expect((await del(ada.web, `/api/auth/devices/${ada.deviceId}?erase=1`)).status).toBe(200);
        expect((await del(ada.web, `/api/auth/devices/${ada.deviceId}`)).status).toBe(200);
        expect(ada.state()).toBe('revoked_and_erase');
        expect((await del(admin.web, `/api/accounts/${ada.account.id}/devices/${ada.deviceId}`)).status).toBe(200);
        expect(ada.state()).toBe('revoked_and_erase');
        // One audit row: the later ones changed nothing.
        expect(audits(b, ada.deviceId)).toHaveLength(1);
        const answer = await b.app.request('/api/rooms', { headers: { [INSTALL_HEADER]: ada.installId } });
        expect(await answer.json()).toMatchObject({ code: 'device_revoked' });
    });

    it('leaves a person as they were when the audit fails during deactivation, and a retry finishes it', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const real = { audit: (event: DeviceEnding) => void event, failing: true };
        b.provider.useDeviceEnds({
            audit: () => {
                if (real.failing) {
                    throw new Error('audit down');
                }
            },
            dropPush: async (userId, endpoint) => {
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        await expect(b.provider.deactivate(ada.account.id, 'admin')).rejects.toThrow('audit down');
        expect(b.provider.accounts().find((entry) => entry.id === ada.account.id)?.deactivated).toBe(false);
        expect(ada.state()).toBe('active');
        expect(ada.pushed()).toBe(1);
        real.failing = false;
        await b.provider.deactivate(ada.account.id, 'admin');
        expect(b.provider.accounts().find((entry) => entry.id === ada.account.id)?.deactivated).toBe(true);
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
    });

    const appPost = (b: Brain, phone: Awaited<ReturnType<typeof phoneOf>>, path: string, body: unknown = {}) =>
        b.app.request(path, {
            method: 'POST',
            headers: {
                cookie: phone.app.header,
                [INSTALL_HEADER]: phone.installId,
                'user-agent': APP_UA,
                origin: ORIGIN,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    const sessionsOf = (b: Brain, deviceId: string) =>
        (b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId = ?').get(deviceId) as { n: number }).n;

    it.each(['/api/auth/logout', '/api/auth/sign-out'])(
        'ends the device, its push subscription included, when the app signs out (%s)',
        async (path) => {
            const b = await brain();
            const ada = await phoneOf(b, 'ada@example.com', 'Ada');
            expect((await appPost(b, ada, path)).status).toBe(200);
            expect(sessionsOf(b, ada.deviceId)).toBe(0);
            expect(ada.pushed()).toBe(0);
            expect(ada.state()).toBe('active');
            expect(audits(b, ada.deviceId).map((row) => row.detail)).toEqual([
                'iPhone; signed_out; signed out on the device',
            ]);
            // The web session is untouched.
            expect((await b.call(ada.web, '/api/auth/devices')).status).toBe(200);
        },
    );

    it('ends a device when its last session is revoked, not before', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const own = b.db.prepare('SELECT * FROM auth_session WHERE deviceId = ?').get(ada.deviceId) as Record<
            string,
            unknown
        >;
        const sibling = { ...own, id: `sibling-${b64(randomBytes(6))}`, token: b64(randomBytes(24)) };
        const columns = Object.keys(sibling);
        b.db
            .prepare(`INSERT INTO auth_session(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
            .run(...(Object.values(sibling) as never[]));
        expect(sessionsOf(b, ada.deviceId)).toBe(2);
        const answer = await appPost(b, ada, '/api/auth/revoke-session', { token: sibling.token });
        expect(answer.status).toBe(200);
        // The asking session lives on: the device is still signed in.
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);

        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        const token = (
            b.db.prepare('SELECT token FROM auth_session WHERE deviceId = ?').get(bob.deviceId) as { token: string }
        ).token;
        expect((await appPost(b, bob, '/api/auth/revoke-session', { token })).status).toBe(200);
        expect(sessionsOf(b, bob.deviceId)).toBe(0);
        expect(bob.pushed()).toBe(0);
        expect(audits(b, bob.deviceId)).toHaveLength(1);
    });

    it('keeps a replaced push endpoint to clean up until its subscription is gone', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const next = `https://push.example.com/${b64(randomBytes(9))}`;
        b.db
            .prepare(
                "INSERT INTO notification_push_subscriptions(id, userId, endpoint, p256dh, auth, device, createdAt, failures) VALUES ('sub-next', ?, ?, 'k', 'a', 'Socio app', ?, 0)",
            )
            .run(ada.account.appUserId, next, Date.now());
        let failures = 1;
        b.provider.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId, endpoint) => {
                if (failures-- > 0) {
                    throw new Error('push store down');
                }
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        const put = () => ada.appCall('/api/auth/device/push', { method: 'PUT', body: { endpoint: next } });
        // The old one's removal fails: the new one is taken all the same, and
        // the old one is kept to clean up.
        expect((await put()).status).toBe(200);
        expect(ada.pushed()).toBe(1);
        expect(b.db.prepare('SELECT endpoint FROM auth_device_push_leftover').all()).toEqual([
            { endpoint: ada.endpoint },
        ]);
        const del = await b.app.request(`/api/auth/devices/${ada.deviceId}`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(del.status).toBe(200);
        // Signing out right after cleans up both: the new one and the old.
        expect(
            b.db
                .prepare('SELECT count(*) AS n FROM notification_push_subscriptions WHERE userId = ?')
                .get(ada.account.appUserId),
        ).toEqual({
            n: 0,
        });
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_device_push_leftover').get()).toEqual({ n: 0 });
    });

    it('changes nothing for a session the policy refuses', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        // A web session by an emailed link, with email links off: refused.
        b.db
            .prepare("UPDATE auth_session SET signInMethod = 'link:email' WHERE userId = ? AND deviceId IS NULL")
            .run(ada.account.id);
        const answer = await b.app.request('/api/auth/revoke-sessions', {
            method: 'POST',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(answer.status).toBe(401);
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);
    });

    it('keeps every endpoint accounted for when push changes and a sign-out overlap', async () => {
        // Each overlap is put in order on purpose (a gated audit and sign-in),
        // never left to how concurrent requests happen to interleave: a
        // change can be taken before the sign-out, get past sign-in and then
        // wait for the turn the sign-out holds, or arrive once it is done.
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const [taken, waited, late] = [1, 2, 3].map((n) => {
            const endpoint = `https://push.example.com/${b64(randomBytes(9))}`;
            b.db
                .prepare(
                    "INSERT INTO notification_push_subscriptions(id, userId, endpoint, p256dh, auth, device, createdAt, failures) VALUES (?, ?, ?, 'k', 'a', 'Socio app', ?, 0)",
                )
                .run(`sub-more-${n}`, ada.account.appUserId, endpoint, Date.now());
            return endpoint;
        });
        let release: () => void = () => undefined;
        let auditing: () => void = () => undefined;
        const audited = new Promise<void>((resolve) => (auditing = resolve));
        let first = true;
        b.provider.useDeviceEnds({
            // The first sign-out waits here in Ada's turn, her sessions still live.
            audit: async () => {
                if (first) {
                    first = false;
                    auditing();
                    await new Promise<void>((resolve) => (release = resolve));
                }
            },
            dropPush: async (userId, endpoint) => {
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        const put = (endpoint: string) => ada.appCall('/api/auth/device/push', { method: 'PUT', body: { endpoint } });

        // Taken before the sign-out: it replaces the first endpoint.
        expect((await put(taken)).status).toBe(200);
        const signOut = b.app.request(`/api/auth/devices/${ada.deviceId}`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        await audited;
        // Signed in while the sign-out holds the turn, so it binds after it.
        const resolve = b.provider.resolve.bind(b.provider);
        let signedIn: (user: unknown) => void = () => undefined;
        const passed = new Promise<unknown>((done) => (signedIn = done));
        vi.spyOn(b.provider, 'resolve').mockImplementationOnce(async (...args) => {
            const user = await resolve(...args);
            signedIn(user);
            return user;
        });
        const waiting = put(waited);
        expect(await passed).toMatchObject({ id: ada.account.appUserId });
        release();
        expect((await signOut).status).toBe(200);
        const refusedInTurn = await waiting;
        // Arriving after the sign-out: refused at sign-in.
        const refusedAtSignIn = await put(late);
        for (const answer of [refusedInTurn, refusedAtSignIn]) {
            expect(answer.status).toBe(401);
            expect(await answer.json()).toMatchObject({ code: 'session_ended' });
        }
        // Every endpoint the server took is gone, and the one it refused in
        // the turn (it cleans that up itself); one refused at sign-in never
        // reached it, and stays the app's to drop, as it was told.
        const left = (
            b.db
                .prepare('SELECT endpoint FROM notification_push_subscriptions WHERE userId = ?')
                .all(ada.account.appUserId) as {
                endpoint: string;
            }[]
        ).map((row) => row.endpoint);
        expect(left).toEqual([late]);
        expect(ada.pushed()).toBe(0);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_device_push_leftover').get()).toEqual({ n: 0 });

        // Two changes at once, then a sign-out: each replaced endpoint went.
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        const next = [1, 2].map((n) => {
            const endpoint = `https://push.example.com/${b64(randomBytes(9))}`;
            b.db
                .prepare(
                    "INSERT INTO notification_push_subscriptions(id, userId, endpoint, p256dh, auth, device, createdAt, failures) VALUES (?, ?, ?, 'k', 'a', 'Socio app', ?, 0)",
                )
                .run(`sub-bob-${n}`, bob.account.appUserId, endpoint, Date.now());
            return endpoint;
        });
        const puts = await Promise.all(
            next.map((endpoint) => bob.appCall('/api/auth/device/push', { method: 'PUT', body: { endpoint } })),
        );
        expect(puts.map((answer) => answer.status)).toEqual([200, 200]);
        const revoked = await b.app.request(`/api/auth/devices/${bob.deviceId}`, {
            method: 'DELETE',
            headers: { cookie: bob.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(revoked.status).toBe(200);
        expect(
            b.db
                .prepare('SELECT endpoint FROM notification_push_subscriptions WHERE userId = ?')
                .all(bob.account.appUserId),
        ).toEqual([]);
    });

    it.each(['/api/auth/sign-out', '/api/auth/logout', '/api/auth/revoke-sessions'])(
        'leaves no push subscription when the app subscribes while it signs out (%s)',
        async (path) => {
            const b = await brain();
            for (const subscribeFirst of [true, false]) {
                const ada = await phoneOf(b, `ada-${subscribeFirst}@example.com`, 'Ada');
                b.provider.useDeviceEnds({
                    audit: () => undefined,
                    dropPush: async (userId, endpoint) => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        b.db
                            .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                            .run(userId, endpoint);
                    },
                });
                const subscribe = () =>
                    ada.appCall('/api/notifications/push/subscriptions', {
                        body: {
                            endpoint: `https://fcm.googleapis.com/fcm/send/${b64(randomBytes(9))}`,
                            keys: { p256dh: b64(randomBytes(65)), auth: b64(randomBytes(16)) },
                            installed: true,
                        },
                    });
                const [first, second] = subscribeFirst
                    ? await Promise.all([subscribe(), appPost(b, ada, path)])
                    : await Promise.all([appPost(b, ada, path), subscribe()]);
                const out = subscribeFirst ? second : first;
                expect(out.status).toBe(200);
                expect(sessionsOf(b, ada.deviceId)).toBe(0);
                expect(
                    b.db
                        .prepare('SELECT count(*) AS n FROM notification_push_subscriptions WHERE userId = ?')
                        .get(ada.account.appUserId),
                ).toEqual({ n: 0 });
            }
        },
    );

    it('signs the other devices out when the password changes, and only when it does', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const change = (currentPassword: string) =>
            b.app.request('/api/auth/change-password', {
                method: 'POST',
                headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword: `${PASSWORD}-next`, revokeOtherSessions: true }),
            });
        expect((await change('not the password')).status).not.toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);
        expect((await change(PASSWORD)).status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId).map((row) => row.detail)).toEqual([
            'iPhone; signed_out; the password was changed',
        ]);
    });

    it('signs every device out when the password is reset', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const token = new URL((await b.provider.passwordLink(ada.account.id)).url).searchParams.get('token');
        const reset = await b.app.request('/api/auth/reset-password', {
            method: 'POST',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ token, newPassword: `${PASSWORD}-reset` }),
        });
        expect(reset.status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId).map((row) => row.detail)).toEqual([
            'iPhone; signed_out; the password was reset',
        ]);
    });

    it('drops the push subscription of a device whose sessions went another way (the access policy)', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        b.db.prepare('DELETE FROM auth_session WHERE deviceId = ?').run(ada.deviceId);
        await b.provider.sweepDevicePush();
        expect(ada.pushed()).toBe(0);
        expect(bob.pushed()).toBe(1);
    });

    it('signs every device out when the password is reset with the token in the query', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const token = new URL((await b.provider.passwordLink(ada.account.id)).url).searchParams.get('token')!;
        const reset = await b.app.request(`/api/auth/reset-password?${new URLSearchParams({ token })}`, {
            method: 'POST',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ newPassword: `${PASSWORD}-reset` }),
        });
        expect(reset.status).toBe(200);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toHaveLength(1);
    });

    it('waits for the audit to be written when the workspace’s writer is busy', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        // Another chain's unit of work holds the writer (across microtasks,
        // as one may); what the device looks like as it closes.
        let seen = '';
        const held = sqliteData(b.workspace.db).uow.run(
            async () => {
                for (let turn = 0; turn < 5000; turn++) {
                    await Promise.resolve();
                }
                seen = ada.state();
            },
            { label: 'test hold' },
        );
        const deactivated = b.provider.deactivate(ada.account.id, 'admin');
        await held;
        await deactivated;
        expect(seen).toBe('active');
        expect(ada.state()).toBe('revoked_and_erase');
        expect(audits(b, ada.deviceId)).toHaveLength(1);
    });

    it('still signs devices out and drops their push when the audit fails after a password change or reset', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        b.provider.useDeviceEnds({
            audit: () => {
                throw new Error('audit down');
            },
            dropPush: async (userId, endpoint) => {
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        const changed = await b.app.request('/api/auth/change-password', {
            method: 'POST',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({
                currentPassword: PASSWORD,
                newPassword: `${PASSWORD}-next`,
                revokeOtherSessions: true,
            }),
        });
        expect(changed.status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);

        const token = new URL((await b.provider.passwordLink(bob.account.id)).url).searchParams.get('token');
        const reset = await b.app.request('/api/auth/reset-password', {
            method: 'POST',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ token, newPassword: `${PASSWORD}-reset` }),
        });
        expect(reset.status).toBe(200);
        expect(sessionsOf(b, bob.deviceId)).toBe(0);
        expect(bob.pushed()).toBe(0);
    });

    it('changes nothing when Better Auth refuses the request', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const answer = await b.app.request('/api/auth/revoke-sessions', {
            method: 'POST',
            headers: {
                cookie: ada.app.header,
                [INSTALL_HEADER]: ada.installId,
                'user-agent': APP_UA,
                origin: ORIGIN,
                'content-type': 'application/json',
            },
            body: '{not json',
        });
        expect(answer.status).toBe(400);
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);
        expect((await b.call(ada.web, '/api/auth/devices')).status).toBe(200);
    });

    it('binds a push subscription the app makes to its device, so a sign-out right after removes it', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const next = `https://fcm.googleapis.com/fcm/send/${b64(randomBytes(9))}`;
        const made = await ada.appCall('/api/notifications/push/subscriptions', {
            body: {
                endpoint: next,
                keys: { p256dh: b64(randomBytes(65)), auth: b64(randomBytes(16)) },
                installed: true,
            },
        });
        expect(made.status).toBe(201);
        expect(
            (
                b.db.prepare('SELECT pushEndpoint FROM auth_device WHERE id = ?').get(ada.deviceId) as {
                    pushEndpoint: string;
                }
            ).pushEndpoint,
        ).toBe(next);
        // The one it replaced is gone already.
        expect(ada.pushed()).toBe(0);
        const revoked = await b.app.request(`/api/auth/devices/${ada.deviceId}`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(revoked.status).toBe(200);
        expect(
            b.db.prepare('SELECT count(*) AS n FROM notification_push_subscriptions WHERE endpoint = ?').get(next),
        ).toEqual({
            n: 0,
        });
    });

    it('changes nothing when Better Auth turns a request away for its rate limit', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const change = (currentPassword: string) =>
            b.app.request('/api/auth/change-password', {
                method: 'POST',
                headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword: `${PASSWORD}-next`, revokeOtherSessions: true }),
            });
        let status = 0;
        for (let tries = 0; tries < 12 && status !== 429; tries++) {
            status = (await change('not the password')).status;
        }
        expect(status).toBe(429);
        expect((await change(PASSWORD)).status).toBe(429);
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);
    });

    it('signs the device out on logout whatever its body', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const out = await b.app.request('/api/auth/logout', {
            method: 'POST',
            headers: {
                cookie: ada.app.header,
                [INSTALL_HEADER]: ada.installId,
                'user-agent': APP_UA,
                origin: ORIGIN,
                'content-type': 'application/json',
            },
            body: '{bad',
        });
        expect(out.status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toHaveLength(1);
    });

    it('leaves no device without a session holding a subscription when one signs in during sign out everywhere', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        b.provider.useDeviceEnds({
            audit: () => new Promise((resolve) => setTimeout(resolve, 20)),
            dropPush: async (userId, endpoint) => {
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        const everywhere = b.app.request('/api/auth/revoke-sessions', {
            method: 'POST',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            body: '{}',
        });
        const latecomer = (async () => {
            const installId = newInstallId();
            const { jar } = await b.signIn('ada@example.com', installId);
            return b.app.request('/api/notifications/push/subscriptions', {
                method: 'POST',
                headers: {
                    cookie: jar.header,
                    [INSTALL_HEADER]: installId,
                    'user-agent': APP_UA,
                    origin: ORIGIN,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    endpoint: `https://fcm.googleapis.com/fcm/send/${b64(randomBytes(9))}`,
                    keys: { p256dh: b64(randomBytes(65)), auth: b64(randomBytes(16)) },
                    installed: true,
                }),
            });
        })();
        expect((await everywhere).status).toBe(200);
        await latecomer;
        const orphans = b.db
            .prepare(
                `SELECT s.endpoint FROM notification_push_subscriptions s WHERE s.userId = ? AND NOT EXISTS (
                    SELECT 1 FROM auth_device d JOIN auth_session x ON x.deviceId = d.id
                    WHERE d.pushEndpoint = s.endpoint AND d.state = 'active')`,
            )
            .all(ada.account.appUserId);
        expect(orphans).toEqual([]);
    });

    /** A second session on the phone, as a second sign-in with the same install id makes. */
    const secondSession = (b: Brain, deviceId: string) => {
        const own = b.db.prepare('SELECT * FROM auth_session WHERE deviceId = ?').get(deviceId) as Record<
            string,
            unknown
        >;
        const sibling = { ...own, id: `sibling-${b64(randomBytes(6))}`, token: b64(randomBytes(24)) };
        const columns = Object.keys(sibling);
        b.db
            .prepare(`INSERT INTO auth_session(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
            .run(...(Object.values(sibling) as never[]));
        return sibling as { id: string; token: string };
    };

    it('signs a device out on an admin’s revoke of its last session only, audited as the admin’s', async () => {
        const b = await brain();
        const admin = await phoneOf(b, 'admin@example.com', 'Admin', 'admin');
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const sibling = secondSession(b, ada.deviceId);
        const revoke = (sessionId: string) =>
            b.app.request(`/api/accounts/${ada.account.id}/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: { cookie: admin.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            });
        expect((await revoke(sibling.id)).status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(1);
        expect(ada.pushed()).toBe(1);
        expect(audits(b, ada.deviceId)).toEqual([]);
        const last = (
            b.db.prepare('SELECT id FROM auth_session WHERE deviceId = ?').get(ada.deviceId) as { id: string }
        ).id;
        expect((await revoke(last)).status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toEqual([
            expect.objectContaining({
                actor: admin.account.appUserId,
                detail: 'iPhone; signed_out; an admin ended its last session',
            }),
        ]);
    });

    it('audits a device with two sessions once when sign out everywhere ends both', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        secondSession(b, ada.deviceId);
        const answer = await b.app.request('/api/auth/revoke-sessions', {
            method: 'POST',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(answer.status).toBe(200);
        expect(sessionsOf(b, ada.deviceId)).toBe(0);
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toHaveLength(1);
    });

    it('keeps the push endpoint to clean up when nothing is wired to remove it, then removes it', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        b.provider.useDeviceEnds(undefined as never);
        await b.provider.deactivate(ada.account.id, 'admin');
        expect(ada.pushed()).toBe(1);
        b.provider.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId, endpoint) => {
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        await b.provider.sweepDevicePush();
        expect(ada.pushed()).toBe(0);
    });

    it('signs devices out, audited and unsubscribed, when the command line deactivates a person', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        await authCli(
            ['deactivate', '--email', 'ada@example.com'],
            {
                AUTH_PROVIDER: 'betterauth',
                APP_ORIGIN: ORIGIN,
                SESSION_SECRET: SECRET,
                DATABASE_PATH: b.path,
                BACKUP_DIR: join(b.dir, 'backups'),
            },
            () => undefined,
        );
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toEqual([
            expect.objectContaining({
                actor: CLI_ACTOR,
                detail: 'iPhone; revoked_and_erase; the person was deactivated',
            }),
        ]);
    });

    it('erases a device that signed in while deactivation waited on its audit, even after reactivation', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        let release: () => void = () => undefined;
        let auditing: () => void = () => undefined;
        const audited = new Promise<void>((resolve) => (auditing = resolve));
        let first = true;
        b.provider.useDeviceEnds({
            audit: async () => {
                if (first) {
                    first = false;
                    auditing();
                    await new Promise<void>((resolve) => (release = resolve));
                }
            },
            dropPush: async () => undefined,
        });
        const deactivated = b.provider.deactivate(ada.account.id, 'admin');
        await audited;
        const lateInstall = newInstallId();
        await b.signIn('ada@example.com', lateInstall);
        release();
        await deactivated;
        await b.provider.reactivate(ada.account.id, 'admin');
        const answer = await b.app.request('/api/rooms', { headers: { [INSTALL_HEADER]: lateInstall } });
        expect(answer.status).toBe(401);
        expect(await answer.json()).toMatchObject({ code: 'device_revoked' });
    });

    it('keeps the endpoint the app subscribes last when it changes endpoints at the same time', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        b.provider.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId, endpoint) => {
                await new Promise((resolve) => setTimeout(resolve, 30));
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        const keys = { p256dh: b64(randomBytes(65)), auth: b64(randomBytes(16)) };
        const subscribe = (endpoint: string) =>
            ada.appCall('/api/notifications/push/subscriptions', { body: { endpoint, keys, installed: true } });
        const a = `https://fcm.googleapis.com/fcm/send/${b64(randomBytes(9))}`;
        const bEndpoint = `https://fcm.googleapis.com/fcm/send/${b64(randomBytes(9))}`;
        expect((await subscribe(a)).status).toBe(201);
        // Replacing A with B while A's subscription is renewed.
        const [replaced, renewed] = await Promise.all([subscribe(bEndpoint), subscribe(a)]);
        expect([replaced.status, renewed.status]).toEqual([201, 201]);
        const held = (
            b.db.prepare('SELECT pushEndpoint FROM auth_device WHERE id = ?').get(ada.deviceId) as {
                pushEndpoint: string;
            }
        ).pushEndpoint;
        expect(
            b.db.prepare('SELECT count(*) AS n FROM notification_push_subscriptions WHERE endpoint = ?').get(held),
        ).toEqual({
            n: 1,
        });
    });

    it('tries a failed push cleanup again, without undoing the sign-out', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        let down = true;
        b.provider.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId, endpoint) => {
                if (down) {
                    throw new Error('push store down');
                }
                b.db
                    .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
                    .run(userId, endpoint);
            },
        });
        await b.provider.deactivate(ada.account.id, 'admin');
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(1);
        // Deactivating again finishes it.
        down = false;
        await b.provider.deactivate(ada.account.id, 'admin');
        expect(ada.pushed()).toBe(0);
        expect(
            (
                b.db.prepare('SELECT pushEndpoint FROM auth_device WHERE id = ?').get(ada.deviceId) as {
                    pushEndpoint: unknown;
                }
            ).pushEndpoint,
        ).toBeNull();
    });

    it('writes the audit before anything ends', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const seen: string[] = [];
        b.provider.useDeviceEnds({
            audit: () => {
                seen.push(`audit ${ada.state()} ${ada.pushed()}`);
            },
            dropPush: async () => {
                seen.push(`push ${ada.state()}`);
            },
        });
        await b.app.request(`/api/auth/devices/${ada.deviceId}`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(seen).toEqual(['audit active 1', 'push revoked']);
    });
});

describe('an admin and the person’s devices', () => {
    it('lists and signs out a person’s device, and sign-out of all their sessions ends their devices too', async () => {
        const b = await brain();
        const admin = await phoneOf(b, 'admin@example.com', 'Admin', 'admin');
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const listed = deviceListSchema.parse(
            await (await b.call(admin.web, `/api/accounts/${ada.account.id}/devices`)).json(),
        );
        expect(listed.devices.map((device) => device.id)).toEqual([ada.deviceId]);
        expect((await b.call(ada.web, `/api/accounts/${admin.account.id}/devices`)).status).toBe(403);
        const gone = await b.app.request(`/api/accounts/${ada.account.id}/devices/${ada.deviceId}?erase=1`, {
            method: 'DELETE',
            headers: { cookie: admin.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(gone.status).toBe(200);
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toEqual([
            {
                actor: admin.account.appUserId,
                action: 'revoke',
                detail: 'iPhone; revoked_and_erase; by an admin, from the person page',
            },
        ]);

        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        const all = await b.app.request(`/api/accounts/${bob.account.id}/sessions`, {
            method: 'DELETE',
            headers: { cookie: admin.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(all.status).toBe(200);
        expect(bob.pushed()).toBe(0);
        expect(audits(b, bob.deviceId).map((row) => row.detail)).toEqual([
            'iPhone; signed_out; an admin signed out all their sessions',
        ]);
        expect(await (await bob.appCall('/api/rooms')).json()).toMatchObject({ code: 'session_ended' });
    });

    it('erases every device of a deactivated person and removes their push subscriptions', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        await b.provider.deactivate(ada.account.id, 'admin');
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId)).toEqual([
            expect.objectContaining({
                actor: 'admin',
                detail: 'iPhone; revoked_and_erase; the person was deactivated',
            }),
        ]);
    });
});

// CB-383: a person leaves the workspace on their own.
describe('leaving the workspace', () => {
    const webCall = (b: Brain, jar: Jar, method: 'GET' | 'POST', body?: unknown) =>
        b.app.request(LEAVE_WORKSPACE_PATH, {
            method,
            headers: {
                cookie: jar.header,
                origin: ORIGIN,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    const accountRow = (b: Brain, id: string) =>
        b.db.prepare('SELECT banned, banReason, role FROM auth_user WHERE id = ?').get(id) as {
            banned: number;
            banReason: string | null;
        };

    it('ends a member’s membership, sessions and devices, and keeps the audit', async () => {
        const b = await brain();
        await phoneOf(b, 'olga@example.com', 'Olga', 'admin');
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        expect(await (await webCall(b, ada.web, 'GET')).json()).toEqual({ allowed: true, refusal: null });
        // Without the confirmation nothing changes.
        expect((await webCall(b, ada.web, 'POST', {})).status).toBe(400);
        expect(accountRow(b, ada.account.id).banned).toBeFalsy();

        const left = await webCall(b, ada.web, 'POST', { confirm: 'leave' });
        expect(left.status).toBe(200);
        expect(await left.json()).toEqual({ ok: true });
        expect(accountRow(b, ada.account.id)).toMatchObject({ banned: 1, banReason: 'Left the workspace' });
        expect(b.sessions(ada.account.id)).toEqual([]);
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
        expect(audits(b, ada.deviceId).map((row) => row.detail)).toEqual([
            'iPhone; revoked_and_erase; the person left the workspace',
        ]);
        // The app hears it should erase its copy; the web is signed out.
        expect(await (await ada.appCall('/api/rooms')).json()).toMatchObject({ code: 'deactivated' });
        expect((await webCall(b, ada.web, 'GET')).status).toBe(401);
        // Audited as their own doing; an admin can reactivate them.
        const audit = b.db
            .prepare("SELECT actor, detail FROM workspace_audit WHERE targetKind = 'user' AND action = 'deactivate'")
            .all() as { actor: string; detail: string }[];
        expect(audit).toEqual([
            expect.objectContaining({
                actor: ada.account.appUserId,
                detail: expect.stringContaining('left the workspace on their own'),
            }),
        ]);
        await b.provider.reactivate(ada.account.id, 'admin');
        expect(accountRow(b, ada.account.id).banned).toBeFalsy();
    });

    it('keeps the last admin, and the workspace owner until they hand ownership over (CB-390)', async () => {
        const b = await brain();
        // The only admin is the owner: the first admin is (CB-390).
        const ann = await phoneOf(b, 'ann@example.com', 'Ann', 'admin');
        expect(await (await webCall(b, ann.web, 'GET')).json()).toMatchObject({
            allowed: false,
            refusal: { code: 'owner' },
        });
        const refused = await webCall(b, ann.web, 'POST', { confirm: 'leave' });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: 'owner' });
        expect(accountRow(b, ann.account.id).banned).toBeFalsy();
        expect(ann.state()).toBe('active');

        // With another admin, one of two leaving at once may go; the other stays.
        const ben = await phoneOf(b, 'ben@example.com', 'Ben', 'admin');
        const answers = await Promise.all([
            webCall(b, ann.web, 'POST', { confirm: 'leave' }),
            webCall(b, ben.web, 'POST', { confirm: 'leave' }),
        ]);
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
        const banned = [ann, ben].filter((person) => accountRow(b, person.account.id).banned);
        expect(banned).toHaveLength(1);

        // The workspace owner can't leave, even with another admin left.
        const olga = await phoneOf(b, 'olga@example.com', 'Olga', 'admin');
        const stays = [ann, ben].find((person) => !accountRow(b, person.account.id).banned)!;
        b.provider.ensureOwner();
        const owner = b.provider.ownerAccount()!;
        expect(owner.id).toBe(stays.account.id);
        expect(await (await webCall(b, stays.web, 'GET')).json()).toMatchObject({
            allowed: false,
            refusal: { code: 'owner' },
        });
        expect(await (await webCall(b, stays.web, 'POST', { confirm: 'leave' })).json()).toMatchObject({
            code: 'owner',
        });
        expect(await (await webCall(b, olga.web, 'GET')).json()).toMatchObject({ allowed: true });
    });

    it('is only for a person’s own session', async () => {
        const b = await brain();
        const response = await b.app.request(LEAVE_WORKSPACE_PATH, {
            method: 'POST',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: 'leave' }),
        });
        expect(response.status).toBe(401);
    });
});

// CB-379: the follow-ups to the Devices list.
describe('device follow-ups', () => {
    /** Another process on the same database, as during a start-first rollout. */
    const secondProcess = (b: Brain) => {
        const auth = authFromEnv(
            {
                AUTH_PROVIDER: 'betterauth',
                APP_ORIGIN: ORIGIN,
                SESSION_SECRET: SECRET,
                AUTH_TRUST_PROXY: 'true',
                AUTH_APP_PREVIEW_LINKS: 'true',
            },
            '127.0.0.1',
            { database: b.path, hasher: fastHasher },
        );
        const provider = auth.provider as BetterAuthProvider;
        cleanups.push(() => provider.close());
        return provider;
    };
    const dropFrom = (b: Brain) => async (userId: string, endpoint: string) => {
        b.db
            .prepare('DELETE FROM notification_push_subscriptions WHERE userId = ? AND endpoint = ?')
            .run(userId, endpoint);
    };

    it('drops the push subscription of a device whose session ran out, on its own schedule', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        const token = (
            b.db.prepare('SELECT token FROM auth_session WHERE deviceId = ?').get(ada.deviceId) as { token: string }
        ).token;
        await b.expireIn(token, -60);
        b.provider.startPushSweep(20);
        await vi.waitFor(() => expect(ada.pushed()).toBe(0), { timeout: 5000, interval: 20 });
        expect(bob.pushed()).toBe(1);
        // The device itself is untouched: it says its session expired.
        expect(ada.state()).toBe('active');
        expect(await (await ada.appCall('/api/rooms')).json()).toMatchObject({ code: 'session_expired' });
    });

    it('takes turns with another process on the same database', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const other = secondProcess(b);
        const events: string[] = [];
        let release: () => void = () => undefined;
        let auditing: () => void = () => undefined;
        const audited = new Promise<void>((resolve) => (auditing = resolve));
        b.provider.useDeviceEnds({
            audit: async () => {
                auditing();
                await new Promise<void>((resolve) => (release = resolve));
                events.push('first: audited');
            },
            dropPush: async (userId, endpoint) => {
                events.push('first: push dropped');
                await dropFrom(b)(userId, endpoint);
            },
        });
        other.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId, endpoint) => {
                events.push('second: push dropped');
                await dropFrom(b)(userId, endpoint);
            },
        });
        // The first process deactivates Ada and waits on its audit, in her turn.
        const deactivated = b.provider.deactivate(ada.account.id, 'admin');
        await audited;
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_device_turn').get()).toEqual({ n: 1 });
        // Her device's session goes another way meanwhile; the second
        // process's sweep would drop its push, but waits for her turn.
        b.db.prepare('DELETE FROM auth_session WHERE deviceId = ?').run(ada.deviceId);
        let swept = false;
        const sweep = other.sweepDevicePush().then(() => (swept = true));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(swept).toBe(false);
        expect(events).toEqual([]);
        release();
        await Promise.all([deactivated, sweep]);
        // The first finished whole before the second looked: nothing was left to drop.
        expect(events).toEqual(['first: audited', 'first: push dropped']);
        expect(ada.state()).toBe('revoked_and_erase');
        expect(ada.pushed()).toBe(0);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_device_turn').get()).toEqual({ n: 0 });
    });

    it('ends a sign-in that completes after deactivation’s ban and last device pass', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        // The ban lands between the sign-in's own ban check and its session's
        // insert, as a deactivation in another process can.
        b.db.exec(
            `CREATE TRIGGER ban_on_sign_in AFTER INSERT ON auth_session WHEN NEW.userId = '${ada.account.id}' BEGIN UPDATE auth_user SET banned = 1 WHERE id = NEW.userId; END`,
        );
        const lateInstall = newInstallId();
        const late = await b.signIn('ada@example.com', lateInstall);
        b.db.exec('DROP TRIGGER ban_on_sign_in');
        const lateDevice = b.provider.devices().byInstallId(lateInstall);
        expect(lateDevice).toMatchObject({ state: 'revoked_and_erase' });
        // Its session is gone; the app hears the person was deactivated.
        expect(b.sessions(ada.account.id).filter((session) => session.deviceId === lateDevice!.id)).toEqual([]);
        const answer = await b.app.request('/api/rooms', {
            headers: { cookie: late.jar.header, [INSTALL_HEADER]: lateInstall },
        });
        expect(answer.status).toBe(401);
        expect(await answer.json()).toMatchObject({ code: 'deactivated' });
        expect(audits(b, lateDevice!.id)).toEqual([
            {
                actor: 'system',
                action: 'revoke',
                detail: 'iPhone; revoked_and_erase; it signed in while the person was being deactivated',
            },
        ]);
    });

    it('audits a sign-out on the device after its session is gone, and a failed audit never keeps it signed in', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const seen: number[] = [];
        b.provider.useDeviceEnds({
            audit: () => {
                // Best effort, by design: Better Auth has already ended the session.
                seen.push(
                    (
                        b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId = ?').get(ada.deviceId) as {
                            n: number;
                        }
                    ).n,
                );
                throw new Error('audit down');
            },
            dropPush: dropFrom(b),
        });
        const errors = vi.mocked(console.error);
        const answer = await b.app.request('/api/auth/logout', {
            method: 'POST',
            headers: {
                cookie: ada.app.header,
                [INSTALL_HEADER]: ada.installId,
                'user-agent': APP_UA,
                origin: ORIGIN,
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(answer.status).toBe(200);
        expect(seen).toEqual([0]);
        expect(b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId = ?').get(ada.deviceId)).toEqual({
            n: 0,
        });
        expect(ada.pushed()).toBe(0);
        expect(errors.mock.calls.flat().join('\n')).toContain('Device sign-out audit failed');
        expect(await (await ada.appCall('/api/rooms')).json()).toMatchObject({ code: 'session_ended' });
    });

    it('answers the device codes on GET /api/auth/session for the app, and the web as before', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const session = (headers: Record<string, string | undefined>) =>
            b.app.request('/api/auth/session', {
                headers: Object.fromEntries(
                    Object.entries(headers).filter(([, value]) => value !== undefined),
                ) as Record<string, string>,
            });
        // Signed in, from the app: the view with the person, as before.
        const signedIn = await session({ cookie: ada.app.header, [INSTALL_HEADER]: ada.installId });
        expect(signedIn.status).toBe(200);
        expect(await signedIn.json()).toMatchObject({ provider: 'betterauth', user: { id: ada.account.appUserId } });

        const gone = await b.app.request(`/api/auth/devices/${ada.deviceId}?erase=1`, {
            method: 'DELETE',
            headers: { cookie: ada.web.header, origin: ORIGIN, 'content-type': 'application/json' },
        });
        expect(gone.status).toBe(200);
        // The app's request, with its cookie or without: 401 with the code, the view beside it.
        for (const headers of [
            { cookie: ada.app.header, [INSTALL_HEADER]: ada.installId },
            { [INSTALL_HEADER]: ada.installId },
        ]) {
            const answer = await session(headers);
            expect(answer.status).toBe(401);
            expect(await answer.json()).toMatchObject({
                code: 'device_revoked',
                error: expect.any(String),
                provider: 'betterauth',
                branding: expect.objectContaining({ name: expect.any(String) }),
                user: null,
            });
        }
        // The same code as behind the session check, where the app confirms it today.
        const devices = await b.app.request('/api/auth/devices', {
            headers: { cookie: ada.app.header, [INSTALL_HEADER]: ada.installId },
        });
        expect(devices.status).toBe(401);
        expect(await devices.json()).toMatchObject({ code: 'device_revoked' });
        // The web, and an install id the server doesn't know: 200 and no one, as before.
        for (const headers of [{ cookie: ada.app.header }, {}, { [INSTALL_HEADER]: newInstallId() }]) {
            const answer = await session(headers);
            expect(answer.status).toBe(200);
            const body = (await answer.json()) as Record<string, unknown>;
            expect(body).toMatchObject({ user: null });
            expect(body).not.toHaveProperty('code');
        }
    });
});

describe('closing during a push sweep (CB-379)', () => {
    it('stops the sweep and never opens the database again', async () => {
        const b = await brain();
        const ada = await phoneOf(b, 'ada@example.com', 'Ada');
        const bob = await phoneOf(b, 'bob@example.com', 'Bob');
        b.db.prepare('DELETE FROM auth_session WHERE deviceId IN (?, ?)').run(ada.deviceId, bob.deviceId);
        let release: () => void = () => undefined;
        let dropping: () => void = () => undefined;
        const dropped = new Promise<void>((resolve) => (dropping = resolve));
        const calls: string[] = [];
        b.provider.useDeviceEnds({
            audit: () => undefined,
            dropPush: async (userId) => {
                calls.push(userId);
                dropping();
                await new Promise<void>((resolve) => (release = resolve));
            },
        });
        const sweep = b.provider.sweepDevicePush();
        await dropped;
        b.provider.close();
        release();
        await sweep;
        // The one under way finished its call; nobody else was swept, and nothing reopened.
        expect(calls).toHaveLength(1);
        expect((b.provider as unknown as { db?: unknown }).db).toBeUndefined();
        expect(() => b.provider.devices().listFor(ada.account.id)).toThrow('The auth database is closed.');
    });
});
