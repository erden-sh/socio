import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { openDatabase } from '@socio/data/open';
import { signInLinkMessage } from '@socio/foundation/auth/sign-in-links';
import { INSTALL_HEADER, parseAppLink } from '@socio/shared/device-sign-in';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { authCli } from '../src/server/auth/cli.js';
import type { SignInLinkSender } from '../src/server/auth/contract.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { openCoreStore } from '../src/server/composition/core-store.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: invites on the link domain, and "Send me a link for the app".
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
        app: {
            config: { mode: 'live' as const, baseUrl: 'https://model.invalid' },
            origin: [env.APP_ORIGIN ?? ORIGIN],
            auth,
        },
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
                    origin: env.APP_ORIGIN ?? ORIGIN,
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

/** A provider alone (no app), for its invite links: `env` over the defaults. */
async function inviter(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-invites-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const provider = authFromEnv(
        { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, ...env },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    ).provider as BetterAuthProvider;
    cleanups.push(() => {
        provider.close();
        rmSync(dir, { recursive: true, force: true });
    });
    await provider.createAccount({ email: 'kim@example.com', name: 'Kim', role: 'member' });
    const id = provider.accounts().find((entry) => entry.email === 'kim@example.com')!.id;
    return { provider, invite: async () => new URL((await provider.passwordLink(id)).url) };
}

describe('invite links', () => {
    it('stays the web’s own link unless the workspace turned app invites on', async () => {
        const { invite } = await inviter({ APP_ORIGIN: 'https://brain.example.com' });
        const url = await invite();
        expect(`${url.origin}${url.pathname}`).toBe('https://brain.example.com/reset-password');
    });

    it('goes on the link domain for the production app, with the token only in the fragment', async () => {
        const { invite } = await inviter({ APP_ORIGIN: 'https://brain.example.com', AUTH_APP_INVITE_LINKS: 'true' });
        const url = await invite();
        expect(`${url.origin}${url.pathname}`).toBe('https://link.socio.sh/app/i/brain.example.com');
        expect(url.search).toBe('');
        expect(parseAppLink(url.href)).toMatchObject({ kind: 'i', variant: 'production', host: 'brain.example.com' });
        expect((parseAppLink(url.href)!.fields as { t: string }).t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it('never puts a port in a production invite: such a workspace keeps the web’s link', async () => {
        const { invite } = await inviter({
            APP_ORIGIN: 'https://brain.example.com:8443',
            AUTH_APP_INVITE_LINKS: 'true',
        });
        const url = await invite();
        expect(`${url.origin}${url.pathname}`).toBe('https://brain.example.com:8443/reset-password');
    });

    it('makes preview invites with AUTH_APP_PREVIEW_LINKS, port and all', async () => {
        const { invite } = await inviter({
            APP_ORIGIN: 'https://preview.example.com:8443',
            AUTH_APP_INVITE_LINKS: 'true',
            AUTH_APP_PREVIEW_LINKS: 'true',
        });
        const url = await invite();
        expect(parseAppLink(url.href)).toMatchObject({
            kind: 'i',
            variant: 'preview',
            host: 'preview.example.com:8443',
        });
    });

    it('keeps the web’s link where the link page can’t forward: plain http, or a host it doesn’t take', async () => {
        for (const origin of ['http://localhost:4310', 'https://[::1]']) {
            const { invite } = await inviter({
                APP_ORIGIN: origin,
                AUTH_APP_INVITE_LINKS: 'true',
                AUTH_APP_PREVIEW_LINKS: 'true',
            });
            const url = await invite();
            expect(`${url.origin}${url.pathname}`).toBe(`${origin}/reset-password`);
        }
    });

    it('takes an admin’s saved choice over the environment from the command line too', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-invites-cli-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const path = join(dir, 'brain.sqlite');
        const env = (on: boolean) => ({
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: 'https://brain.example.com',
            SESSION_SECRET: SECRET,
            DATABASE_PATH: path,
            BACKUP_DIR: join(dir, 'backups'),
            AUTH_APP_INVITE_LINKS: on ? 'true' : 'false',
        });
        const run = async (on: boolean, ...args: string[]) => {
            const lines: string[] = [];
            await authCli(args, env(on), (line) => lines.push(line));
            return lines.join('\n');
        };
        await run(true, 'create-user', '--email', 'kim@example.com', '--name', 'Kim');
        const save = async (appInviteLinks: boolean) => {
            const connection = openDatabase(path);
            const store = openCoreStore(connection);
            try {
                await store.slices.settings.updateSettings({ appInviteLinks });
            } finally {
                store.close();
                if (connection.isOpen) {
                    connection.close();
                }
            }
        };
        await save(false);
        expect(await run(true, 'password-link', '--email', 'kim@example.com')).toContain(
            'https://brain.example.com/reset-password?token=',
        );
        await save(true);
        expect(await run(false, 'password-link', '--email', 'kim@example.com')).toContain(
            'https://link.socio.sh/app/i/brain.example.com#',
        );
    });

    it('takes an admin’s saved choice over the environment', async () => {
        const on = await inviter({ APP_ORIGIN: 'https://brain.example.com', AUTH_APP_INVITE_LINKS: 'true' });
        on.provider.useSavedInviteLinks(() => false);
        expect((await on.invite()).origin).toBe('https://brain.example.com');
        const off = await inviter({ APP_ORIGIN: 'https://brain.example.com' });
        off.provider.useSavedInviteLinks(() => true);
        expect((await off.invite()).origin).toBe('https://link.socio.sh');
    });
});

describe('“Send me a link for the app”', () => {
    it('sends the workspace’s app link by the person’s channel, with no code, as limited as sign-in links', async () => {
        const b = await brain({ AUTH_APP_INVITE_LINKS: 'true', APP_ORIGIN: 'https://localhost:4310' });
        const ada = await b.account('ada@example.com', 'Ada');
        b.linked.add(b.appUserId(ada.id));
        const { jar } = await b.signIn('ada@example.com');
        const send = () => b.call(jar, '/api/auth/device/send-link', { body: {} });
        const first = await send();
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ via: 'telegram' });
        expect(b.sent).toHaveLength(1);
        const link = b.sent[0].link as { kind: string; url: string };
        expect(link.kind).toBe('app');
        expect(parseAppLink(link.url)).toMatchObject({
            kind: 'w',
            variant: 'preview',
            host: 'localhost:4310',
            fields: {},
        });
        const text = signInLinkMessage(link as never);
        expect(text).toContain(link.url);
        expect(text).not.toMatch(/code|token|#t=|#c=/i);
        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(429);
        expect((await b.call(new Jar(), '/api/auth/device/send-link', { body: {} })).status).toBe(401);
    });

    it('refuses where the workspace sends no app links', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        expect((await b.call(jar, '/api/auth/device/send-link', { body: {} })).status).toBe(409);
        expect(await (await b.call(jar, '/api/auth/device/app-link')).json()).toEqual({ url: null });
    });

    it('gives the signed-in web the workspace’s app link for “Get the app”, with no code', async () => {
        const b = await brain({ AUTH_APP_INVITE_LINKS: 'true', APP_ORIGIN: 'https://localhost:4310' });
        await b.account('ada@example.com', 'Ada');
        const { jar } = await b.signIn('ada@example.com');
        const answer = await b.call(jar, '/api/auth/device/app-link');
        expect(answer.status).toBe(200);
        const { url } = (await answer.json()) as { url: string };
        expect(new URL(url).hash).toBe('');
        expect(parseAppLink(url)).toMatchObject({ kind: 'w', variant: 'preview', host: 'localhost:4310', fields: {} });
        expect((await b.call(new Jar(), '/api/auth/device/app-link')).status).toBe(401);
    });
});
