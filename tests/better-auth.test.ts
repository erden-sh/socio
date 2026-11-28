import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getMigrations } from 'better-auth/db/migration';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { StepUpChallenge } from '@socio/shared/access-policy';
import {
    DEACTIVATED_MESSAGE,
    type Account,
    type AssetTransfer,
    type AuthSession,
    type DeactivationImpact,
    type PasswordLink,
    type PersonAssets,
    type PersonPurgePlan,
    type PersonPurgeResult,
    type RosterPerson,
} from '@socio/shared/auth';
import { DEFAULT_BRANDING } from '@socio/shared/branding';
import type { IssueAssignees, IssueDetail } from '@socio/shared/issues/issue-types';
import type { Role } from '@socio/shared/types';

import { activeUser, DEACTIVATED_SCHEDULE } from '../src/server/auth/accounts.js';
import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { CLI_ACTOR, authCli } from '../src/server/auth/cli.js';
import { SIGN_IN_LINK_SENT, type AccountEvent } from '../src/server/auth/contract.js';
import type { Mailer } from '../src/server/auth/mailer.js';
import { createSessionValue } from '../src/server/auth/session.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { ASSIGNEE_DEACTIVATED } from '../src/server/issues/store.js';
import { schemas } from '../src/server/modules/index.js';
import type { Claim } from '../src/server/schedules/contract.js';
import { scheduledTaskExecutor } from '../src/server/schedules/scheduled.js';
import { TelegramChannel, UNLINKED_REPLY } from '../src/server/telegram/telegram-channel.js';
import { telegramSignInLinks } from '../src/server/telegram/telegram-sign-in.js';

import { FakeOidc } from './fixtures/fake-oidc.js';
import { fakeTelegram } from './fixtures/fake-telegram.js';
import { SoftAuthenticator } from './fixtures/soft-authenticator.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';

/** Cookies across requests, as a browser keeps them. */
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
    has(name: string) {
        return this.cookies.has(name);
    }
    get(name: string) {
        return this.cookies.get(name);
    }
    /** A cookie the browser got from elsewhere (a subdomain's page). */
    set(name: string, value: string) {
        this.cookies.set(name, value);
    }
}

const cleanups: (() => void | Promise<void>)[] = [];
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

/**
 * Real scrypt costs about 90 ms of CPU per hash; the tests sign in dozens of
 * times, so they hash cheaply, except where `realHashing` checks scrypt.
 */
const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

/** An app on Better Auth with a fresh database holding mock-era users. */
async function brain(env: Record<string, string> = {}, mailer?: Mailer, { realHashing = false } = {}) {
    const origin = env.APP_ORIGIN ?? ORIGIN;
    const dir = mkdtempSync(join(tmpdir(), 'cb-betterauth-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            // Rate limits count per client address, in one store per process:
            // each test app gets its own address.
            AUTH_TRUST_PROXY: 'true',
            ...env,
        },
        '127.0.0.1',
        { database: path, mailer, ...(realHashing ? {} : { hasher: fastHasher }) },
    );
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid' };
    const provider = auth.provider as BetterAuthProvider;
    // Better Auth opens the app's file by its path; the runtime shares it.
    const { app, platform, workspace, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: config.baseUrl },
        // Users from the mock-auth days, with data under their ids.
        beforeApp: ({ workspace }) => {
            workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
            workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
        },
        app: { config, origin: [origin], auth },
    });
    cleanups.push(async () => {
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    /** A browser-like request: same-origin, JSON, with the jar's cookies. */
    const call = async (
        jar: Jar,
        path: string,
        { body, ...init }: Omit<RequestInit, 'body'> & { body?: unknown } = {},
    ) =>
        jar.store(
            await app.request(origin === ORIGIN ? path : `${origin}${path}`, {
                ...init,
                ...(body === undefined ? {} : { method: init.method ?? 'POST' }),
                headers: {
                    origin,
                    'x-forwarded-for': clientIp,
                    ...(body === undefined && !init.method ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...(init.headers as Record<string, string> | undefined),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
        );
    const signIn = async (email: string, password = PASSWORD, jar = new Jar()) => {
        const response = await call(jar, '/api/auth/sign-in/email', {
            body: { email, password },
        });
        return { jar, response };
    };
    const session = async (jar: Jar) => (await (await call(jar, '/api/auth/session')).json()) as AuthSession;
    return {
        app,
        origin,
        /** The session cookie's name in the browser. */
        sessionCookie: provider.cookies.sessionCookie,
        auth,
        provider,
        platform,
        workspace,
        path,
        call,
        signIn,
        session,
    };
}
type Brain = Awaited<ReturnType<typeof brain>>;

const admin = async (b: Brain, email = 'ada@example.com') => {
    await b.provider.createAccount({
        email,
        name: 'Ada',
        role: 'admin',
        password: PASSWORD,
    });
    return (await b.signIn(email)).jar;
};

it('builds its instance in the boot warm-up, not on the first request with a session cookie', async () => {
    const build = vi.spyOn(BetterAuthProvider.prototype as unknown as { build: () => unknown }, 'build');
    const b = await brain({ AUTH_OAUTH_PROVIDERS: '' });
    await b.provider.warm();
    const built = build.mock.calls.length;
    expect(built).toBeGreaterThan(0);
    // A stale cookie makes Better Auth look the session up: no build then.
    const jar = new Jar();
    const response = await b.call(jar, '/api/auth/session', {
        headers: { cookie: `${b.sessionCookie}=stale.0123456789` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as AuthSession).toMatchObject({ user: null });
    await b.provider.warm();
    expect(build.mock.calls.length).toBe(built);
});

it('keeps its tables in migrations that match what Better Auth expects', async () => {
    const b = await brain({ AUTH_OAUTH_PROVIDERS: '' });
    const { toBeCreated, toBeAdded } = await getMigrations((await b.provider.auth()).options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
});

it('signs in with email and password: a Strict HttpOnly session for the linked app user, then out', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const b = await brain({}, undefined, { realHashing: true });
    await b.provider.createAccount({
        email: 'Ada@Example.com',
        name: 'Ada',
        role: 'admin',
        password: PASSWORD,
    });
    const wrong = await b.signIn('ada@example.com', 'not-the-password');
    expect(wrong.response.status).toBe(401);
    expect(await wrong.response.json()).toMatchObject({
        error: expect.any(String),
    });

    const { jar, response } = await b.signIn('ada@example.com');
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith('cb.session_token='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(cookie).not.toContain('Secure');
    const session = await b.session(jar);
    expect(session).toEqual({
        provider: 'betterauth',
        branding: DEFAULT_BRANDING,
        user: {
            id: expect.stringMatching(/^u-[0-9a-f]{12}$/),
            name: 'Ada',
            role: 'admin',
        },
        methods: {
            passkey: true,
            password: true,
            signUp: false,
            emailReset: false,
            signInLink: false,
            providers: [],
        },
    });
    expect((await b.call(jar, '/api/state')).status).toBe(200);
    // The app's users table knows the account's app user.
    expect(b.workspace.users().map((user) => user.id)).toContain(session.user!.id);
    expect(b.provider.users()).toEqual([session.user]);

    const logout = await b.call(jar, '/api/auth/logout', { body: {} });
    expect(logout.status).toBe(200);
    expect(jar.has('cb.session_token')).toBe(false);
    const after = await b.call(jar, '/api/state');
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'sign_in' });
    // Passwords are stored as scrypt hashes (hex salt and key), never plain.
    const db = new DatabaseSync(b.path, { readOnly: true });
    const { password } = db.prepare("SELECT password FROM auth_account WHERE providerId='credential'").get() as {
        password: string;
    };
    db.close();
    expect(password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    // Better Auth made no outbound request of its own (no telemetry).
    expect(fetch).not.toHaveBeenCalled();
});

it('marks session cookies Secure behind https', async () => {
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: 'https://brain.example.com',
            SESSION_SECRET: SECRET,
        },
        '0.0.0.0',
        { database: ':memory:' },
    );
    expect(auth.secureCookies).toBe(true);
    const options = (await (auth.provider as BetterAuthProvider).auth()).options;
    expect(options.advanced?.useSecureCookies).toBe(true);
    (auth.provider as BetterAuthProvider).close();
});

const HTTPS = 'https://brain.example.com';
const HOST_SESSION = '__Host-cb.session_token';
const cookieNames = (response: Response) => response.headers.getSetCookie().map((header) => header.split('=')[0]);

it('uses __Host- session cookies over https: Secure, Path=/, no Domain', async () => {
    const b = await brain({ APP_ORIGIN: HTTPS });
    expect(b.sessionCookie).toBe(HOST_SESSION);
    await b.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'admin',
        password: PASSWORD,
    });
    const { jar, response } = await b.signIn('ada@example.com');
    expect(response.status).toBe(200);
    const names = cookieNames(response);
    expect(names).toContain(HOST_SESSION);
    expect(names.some((name) => name.startsWith('__Secure-'))).toBe(false);
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith(`${HOST_SESSION}=`))!;
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/domain=/i);
    expect((await b.session(jar)).user?.name).toBe('Ada');
    expect((await b.call(jar, '/api/state')).status).toBe(200);
});

it('ignores __Secure-cb.* and cb.* cookies a subdomain could toss, over https', async () => {
    const b = await brain({ APP_ORIGIN: HTTPS });
    for (const [email, name] of [
        ['ada@example.com', 'Ada'],
        ['mallory@example.com', 'Mallory'],
    ]) {
        await b.provider.createAccount({
            email,
            name,
            role: 'member',
            password: PASSWORD,
        });
    }
    const victim = (await b.signIn('ada@example.com')).jar;
    // A valid, signed session of the attacker's, planted under the names a
    // page on x.brain.example.com can set with Domain=brain.example.com.
    const planted = (await b.signIn('mallory@example.com')).jar.get(HOST_SESSION)!;
    expect(planted).toBeTruthy();
    for (const name of ['__Secure-cb.session_token', 'cb.session_token']) {
        // Next to the person's own __Host- cookie: theirs wins, always.
        const tossed = new Jar();
        tossed.set(name, planted);
        tossed.set(HOST_SESSION, victim.get(HOST_SESSION)!);
        expect((await b.session(tossed)).user?.name).toBe('Ada');
        expect((await b.call(tossed, '/api/state')).status).toBe(200);
        // Alone (signed out, or a browser that never signed in): no session.
        const alone = new Jar();
        alone.set(name, planted);
        expect((await b.session(alone)).user).toBeNull();
        expect((await b.call(alone, '/api/state')).status).toBe(401);
        // Better Auth's own endpoints don't see it either.
        const direct = await b.call(alone, '/api/auth/get-session');
        expect(await direct.json()).toBeNull();
    }
    // The other cookies Better Auth keeps (here the "don't remember me"
    // marker) are read from __Host- names only, too.
    const marker = new Jar();
    marker.set('__Secure-cb.dont_remember', 'true');
    expect((await b.session(marker)).user).toBeNull();
});

it('signs out over https by clearing the __Host- cookies', async () => {
    const b = await brain({ APP_ORIGIN: HTTPS });
    const jar = await admin(b);
    expect(jar.has(HOST_SESSION)).toBe(true);
    const logout = await b.call(jar, '/api/auth/logout', { body: {} });
    expect(logout.status).toBe(200);
    const cleared = logout.headers.getSetCookie().find((header) => header.startsWith(`${HOST_SESSION}=`))!;
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('Path=/');
    expect(cookieNames(logout).some((name) => name.startsWith('__Secure-'))).toBe(false);
    expect(jar.has(HOST_SESSION)).toBe(false);
    expect((await b.call(jar, '/api/state')).status).toBe(401);
    // Better Auth's own sign-out endpoint, through the same wrapper.
    const again = (await b.signIn('ada@example.com')).jar;
    const signOut = await b.call(again, '/api/auth/sign-out', { body: {} });
    expect(signOut.status).toBe(200);
    expect(cookieNames(signOut)).toContain(HOST_SESSION);
    expect(again.has(HOST_SESSION)).toBe(false);
    expect((await b.call(again, '/api/state')).status).toBe(401);
});

it('renews the __Host- cookie on a sliding refresh over https', async () => {
    const b = await brain({ APP_ORIGIN: HTTPS });
    const jar = await admin(b);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: now + 2 * 24 * 60 * 60 * 1000 });
    try {
        const response = await b.call(jar, '/api/state');
        expect(response.status).toBe(200);
        expect(cookieNames(response)).toContain(HOST_SESSION);
        expect(cookieNames(response).some((name) => name.startsWith('__Secure-'))).toBe(false);
    } finally {
        vi.useRealTimers();
    }
});

it('keeps the passkey challenge on a __Host- cookie over https', async () => {
    const b = await brain({ APP_ORIGIN: HTTPS });
    const jar = await admin(b);
    const authenticator = new SoftAuthenticator(HTTPS);
    const options = await b.call(jar, '/api/auth/passkey/generate-register-options');
    expect(cookieNames(options)).toContain('__Host-cb.better-auth-passkey');
    const registered = await b.call(jar, '/api/auth/passkey/verify-registration', {
        body: {
            response: authenticator.register((await options.json()) as { challenge: string }),
            name: 'Laptop',
        },
    });
    expect(registered.status).toBe(200);
    const browser = new Jar();
    const challenge = (await (await b.call(browser, '/api/auth/passkey/generate-authenticate-options')).json()) as {
        challenge: string;
    };
    const signedIn = await b.call(browser, '/api/auth/passkey/verify-authentication', {
        body: { response: authenticator.authenticate(challenge) },
    });
    expect(signedIn.status).toBe(200);
    expect(browser.has(HOST_SESSION)).toBe(true);
});

it('keeps http (local development) on the cookie names it had', async () => {
    const b = await brain();
    expect(b.sessionCookie).toBe('cb.session_token');
    const jar = await admin(b);
    expect(jar.has('cb.session_token')).toBe(true);
    expect(jar.has(HOST_SESSION)).toBe(false);
    expect((await b.call(jar, '/api/state')).status).toBe(200);
    // A __Host- cookie means nothing over http.
    const other = new Jar();
    other.set(HOST_SESSION, jar.get('cb.session_token')!);
    expect((await b.call(other, '/api/state')).status).toBe(401);
});

it('is invite-only unless AUTH_OPEN_SIGNUP is set', async () => {
    const closed = await brain();
    const jar = new Jar();
    const refused = await closed.call(jar, '/api/auth/sign-up/email', {
        body: { email: 'eve@example.com', password: PASSWORD, name: 'Eve' },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
        code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    });
    expect(closed.provider.accounts()).toEqual([]);

    const open = await brain({ AUTH_OPEN_SIGNUP: 'true' });
    expect((await open.session(new Jar())).methods?.signUp).toBe(true);
    const joined = await open.call(jar, '/api/auth/sign-up/email', {
        body: { email: 'eve@example.com', password: PASSWORD, name: 'Eve' },
    });
    expect(joined.status).toBe(200);
    expect((await open.session(jar)).user).toEqual({
        id: expect.stringMatching(/^u-/),
        name: 'Eve',
        role: 'member',
    });
    // A sign-up can't choose its role or app user.
    for (const field of [{ role: 'admin' }, { appUserId: 'alice' }]) {
        const sneaky = await open.call(new Jar(), '/api/auth/sign-up/email', {
            body: {
                email: 'mal@example.com',
                password: PASSWORD,
                name: 'Mal',
                ...field,
            },
        });
        expect(sneaky.status).toBe(400);
        expect(await sneaky.json()).toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
    }
    expect(open.provider.accounts().map((a) => a.email)).toEqual(['eve@example.com']);
});

it('lets admins invite with a one-time password link, linking an existing user', async () => {
    const b = await brain();
    const adminJar = await admin(b);
    const created = await b.call(adminJar, '/api/accounts', {
        body: {
            email: 'bob@example.com',
            name: 'Bob',
            role: 'member',
            userId: 'bob',
        },
    });
    expect(created.status).toBe(201);
    const { account, link } = (await created.json()) as {
        account: Account;
        link: PasswordLink;
    };
    expect(account).toMatchObject({
        userId: 'bob',
        role: 'member',
        emailVerified: true,
        password: false,
    });
    expect(link.emailed).toBe(false);
    const token = new URL(link.url).searchParams.get('token')!;
    expect(link.url).toBe(`${ORIGIN}/reset-password?token=${token}`);
    // Linking the same app user twice is refused.
    const twice = await b.call(adminJar, '/api/accounts', {
        body: {
            email: 'bobby@example.com',
            name: 'Bob',
            role: 'member',
            userId: 'bob',
        },
    });
    expect(twice.status).toBe(400);

    const set = await b.call(new Jar(), '/api/auth/reset-password', {
        body: { token, newPassword: PASSWORD },
    });
    expect(set.status).toBe(200);
    const reused = await b.call(new Jar(), '/api/auth/reset-password', {
        body: { token, newPassword: 'another-password-1' },
    });
    expect(reused.status).toBe(400);
    const bob = (await b.signIn('bob@example.com')).jar;
    expect((await b.session(bob)).user).toEqual({
        id: 'bob',
        name: 'Bob',
        role: 'member',
    });

    // Members don't manage accounts.
    expect((await b.call(bob, '/api/accounts')).status).toBe(403);
    const list = (await (await b.call(adminJar, '/api/accounts')).json()) as {
        accounts: Account[];
        unlinked: { id: string }[];
    };
    expect(list.accounts.map((a) => a.userId)).toContain('bob');
    expect(list.unlinked.map((u) => u.id)).toEqual(['alice']);
});

it('sets roles, keeps one admin, revokes sessions and deactivates', async () => {
    const b = await brain();
    const adminJar = await admin(b);
    await b.provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        password: PASSWORD,
    });
    const accounts = b.provider.accounts();
    const ada = accounts.find((a) => a.email === 'ada@example.com')!;
    const bobAccount = accounts.find((a) => a.email === 'bob@example.com')!;
    const demote = await b.call(adminJar, `/api/accounts/${ada.id}`, {
        method: 'PATCH',
        body: { role: 'member' },
    });
    expect(demote.status).toBe(400);
    expect((await b.call(adminJar, `/api/accounts/${ada.id}`, { method: 'DELETE' })).status).toBe(400);

    const bob = (await b.signIn('bob@example.com')).jar;
    const promote = await b.call(adminJar, `/api/accounts/${bobAccount.id}`, {
        method: 'PATCH',
        body: { role: 'admin' },
    });
    expect(await promote.json()).toMatchObject({ role: 'admin' });
    expect((await b.session(bob)).user?.role).toBe('admin');

    const revoke = await b.call(adminJar, `/api/accounts/${bobAccount.id}/sessions`, {
        method: 'DELETE',
    });
    expect(revoke.status).toBe(200);
    expect((await b.call(bob, '/api/state')).status).toBe(401);

    const fresh = await b.call(adminJar, `/api/accounts/${bobAccount.id}/password-link`, { body: {} });
    expect(((await fresh.json()) as PasswordLink).url).toContain('/reset-password?token=');

    // The old Remove (DELETE) deactivates: the account stays, signed out.
    const events: AccountEvent[] = [];
    b.provider.onAccountChange((event) => void events.push(event));
    const bobAgain = (await b.signIn('bob@example.com')).jar;
    const remove = await b.call(adminJar, `/api/accounts/${bobAccount.id}`, {
        method: 'DELETE',
    });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toMatchObject({
        email: 'bob@example.com',
        deactivated: true,
    });
    expect(events).toEqual([
        {
            action: 'deactivate',
            userId: bobAccount.userId,
            name: 'Bob',
            by: ada.userId,
        },
    ]);
    expect((await b.call(bobAgain, '/api/state')).status).toBe(401);
    expect((await b.signIn('bob@example.com')).response.status).toBe(403);
    expect(b.provider.accounts().map((a) => [a.email, a.deactivated])).toEqual([
        ['ada@example.com', false],
        ['bob@example.com', true],
    ]);
});

it('makes verified AUTH_ADMIN_EMAILS admins, and only verified ones', async () => {
    const b = await brain({
        AUTH_ADMIN_EMAILS: 'Ada@example.com, eve@example.com',
        AUTH_OPEN_SIGNUP: 'true',
    });
    await b.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'member',
        password: PASSWORD,
    });
    const ada = (await b.signIn('ada@example.com')).jar;
    expect((await b.session(ada)).user?.role).toBe('admin');
    const account = b.provider.accounts()[0];
    expect(account.adminByRule).toBe(true);
    const demote = await b.call(ada, `/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: { role: 'member' },
    });
    expect(demote.status).toBe(400);
    // A self-service sign-up has an unverified email (no SMTP): no admin.
    const eve = new Jar();
    await b.call(eve, '/api/auth/sign-up/email', {
        body: { email: 'eve@example.com', password: PASSWORD, name: 'Eve' },
    });
    expect((await b.session(eve)).user?.role).toBe('member');
});

it('turns mock sign-in off, and honours no owner token', async () => {
    const b = await brain({
        OWNER_TOKEN: 'owner-token-0123456789-abcdef',
        MOCK_USERS: '[{"id":"alice","name":"Alice","role":"admin"}]',
    });
    expect(b.auth).not.toHaveProperty('ownerToken');
    expect(b.auth.warnings.join(' ')).toMatch(/OWNER_TOKEN is no longer used/);
    expect(b.auth.warnings.join(' ')).toMatch(/MOCK_USERS/);
    const jar = new Jar();
    expect((await b.call(jar, '/api/auth/mock/users')).status).toBe(404);
    expect((await b.call(jar, '/api/auth/mock/login', { body: { userId: 'alice' } })).status).toBe(404);
    // No owner-token prompt: the API asks for sign-in, token or not.
    const state = await b.call(jar, '/api/state', {
        headers: { authorization: 'Bearer owner-token-0123456789-abcdef' },
    });
    expect(await state.json()).toMatchObject({ code: 'sign_in' });
    // A mock session cookie, even one signed with the same secret, is nobody.
    const forged = await b.app.request('/api/state', {
        headers: { cookie: `cb_session=${createSessionValue(SECRET, 'alice')}` },
    });
    expect(forged.status).toBe(401);
});

it('validates Better Auth settings at startup', () => {
    const start = (env: Record<string, string>, host = '127.0.0.1') =>
        authFromEnv(
            {
                AUTH_PROVIDER: 'betterauth',
                APP_ORIGIN: ORIGIN,
                SESSION_SECRET: SECRET,
                ...env,
            },
            host,
            { database: ':memory:', read: () => 'file-secret' },
        );
    expect(() => start({ APP_ORIGIN: `${ORIGIN},http://127.0.0.1:4310` })).toThrow(/one browser origin/);
    expect(() => start({ SESSION_SECRET: '' }, '0.0.0.0')).toThrow(/SESSION_SECRET/);
    expect(() => start({ AUTH_PASSWORD: 'false', AUTH_PASSKEY: 'false' })).toThrow(/sign-in method/);
    expect(() => start({ AUTH_OAUTH_PROVIDERS: 'Bad Id' })).toThrow(/provider id/);
    expect(() => start({ AUTH_OAUTH_PROVIDERS: 'logto' })).toThrow(/ISSUER/);
    expect(() =>
        start({
            AUTH_OAUTH_PROVIDERS: 'logto',
            AUTH_OAUTH_LOGTO_ISSUER: 'http://auth.example.com/oidc',
            AUTH_OAUTH_LOGTO_CLIENT_ID: 'id',
        }),
    ).toThrow(/https/);
    expect(() => start({ AUTH_LINK_USERS: '{"alice":"not-an-email"}' })).toThrow(/AUTH_LINK_USERS/);
    expect(() => start({ AUTH_ADMIN_EMAILS: 'nobody' })).toThrow(/AUTH_ADMIN_EMAILS/);
    expect(() => start({ SMTP_URL: 'smtp://mail.example.com' })).toThrow(/SMTP_FROM/);
    const ok = start({
        AUTH_OAUTH_PROVIDERS: 'logto,google',
        AUTH_OAUTH_LOGTO_ISSUER: 'https://auth.example.com/oidc/',
        AUTH_OAUTH_LOGTO_CLIENT_ID: 'brain',
        AUTH_OAUTH_LOGTO_CLIENT_SECRET_FILE: '/run/secrets/logto',
        AUTH_OAUTH_LOGTO_NAME: 'Logto',
        AUTH_OAUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
        AUTH_OAUTH_GOOGLE_CLIENT_ID: 'google-client',
    });
    const provider = ok.provider as BetterAuthProvider;
    expect(provider.signInMethods().providers).toEqual([
        { id: 'logto', name: 'Logto' },
        { id: 'google', name: 'google' },
    ]);
    expect(provider.navigationPaths).toEqual([
        '/api/auth/callback/logto',
        '/api/auth/callback/google',
        // Connected agents (CB-90) open the authorization from anywhere.
        '/api/auth/oauth2/authorize',
        // The app's sign-in sheet opens it straight from the app (CB-352).
        '/api/auth/device/start',
    ]);
    provider.close();
});

it('registers a passkey for a signed-in user and signs in with it', async () => {
    const b = await brain();
    const jar = await admin(b);
    const authenticator = new SoftAuthenticator(ORIGIN);
    const options = (await (await b.call(jar, '/api/auth/passkey/generate-register-options')).json()) as {
        challenge: string;
        rp: { id: string };
    };
    expect(options.rp.id).toBe('localhost');
    const registered = await b.call(jar, '/api/auth/passkey/verify-registration', {
        body: { response: authenticator.register(options), name: 'Laptop' },
    });
    expect(registered.status).toBe(200);
    expect(b.provider.accounts()[0].passkeys).toBe(1);
    const { user } = await b.session(jar);
    await b.call(jar, '/api/auth/logout', { body: {} });

    const browser = new Jar();
    const challenge = (await (await b.call(browser, '/api/auth/passkey/generate-authenticate-options')).json()) as {
        challenge: string;
    };
    const signedIn = await b.call(browser, '/api/auth/passkey/verify-authentication', {
        body: { response: authenticator.authenticate(challenge) },
    });
    expect(signedIn.status).toBe(200);
    expect((await b.session(browser)).user).toEqual(user);

    // An assertion made for another site, or replayed, signs no one in.
    for (const response of [
        authenticator.authenticate(
            (await (await b.call(new Jar(), '/api/auth/passkey/generate-authenticate-options')).json()) as {
                challenge: string;
            },
            'https://evil.example',
        ),
        authenticator.authenticate(challenge),
    ]) {
        const other = new Jar();
        await b.call(other, '/api/auth/passkey/generate-authenticate-options');
        const refused = await b.call(other, '/api/auth/passkey/verify-authentication', { body: { response } });
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(other.has('cb.session_token')).toBe(false);
    }
});

it('turns passkeys off with AUTH_PASSKEY=false', async () => {
    const b = await brain({ AUTH_PASSKEY: 'false' });
    const jar = await admin(b);
    expect((await b.call(jar, '/api/auth/passkey/generate-register-options')).status).toBe(404);
    expect((await b.session(jar)).methods?.passkey).toBe(false);
});

it('rate limits sign-in attempts per client address', async () => {
    const b = await brain({ AUTH_TRUST_PROXY: 'true' });
    const attempt = (ip: string) =>
        b.call(new Jar(), '/api/auth/sign-in/email', {
            body: { email: 'nobody@example.com', password: 'wrong-password' },
            headers: { 'x-forwarded-for': `198.51.100.1, ${ip}` },
        });
    for (let i = 0; i < 30; i++) {
        expect((await attempt('203.0.113.9')).status).toBe(401);
    }
    const limited = await attempt('203.0.113.9');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: expect.any(String) });
    expect((await attempt('203.0.113.10')).status).toBe(401);
});

it('refuses cross-site and cross-origin sign-in requests', async () => {
    const b = await brain();
    await b.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'admin',
        password: PASSWORD,
    });
    const body = JSON.stringify({ email: 'ada@example.com', password: PASSWORD });
    for (const headers of [
        { origin: 'https://evil.example' },
        { origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) {
        const response = await b.app.request('/api/auth/sign-in/email', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body,
        });
        expect(response.status).toBe(403);
        expect(response.headers.getSetCookie()).toEqual([]);
    }
});

it('slides the session: a day later a request renews the cookie', async () => {
    const b = await brain();
    const jar = await admin(b);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: now + 2 * 24 * 60 * 60 * 1000 });
    try {
        const response = await b.call(jar, '/api/state');
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('cb.session_token='))).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

it('emails password links when SMTP is configured', async () => {
    const sent: { to: string; text: string }[] = [];
    const b = await brain({}, { send: async (message) => void sent.push(message) });
    const adminJar = await admin(b);
    expect((await b.session(new Jar())).methods?.emailReset).toBe(true);
    const created = await b.call(adminJar, '/api/accounts', {
        body: { email: 'bob@example.com', name: 'Bob', role: 'member' },
    });
    expect(((await created.json()) as { link: PasswordLink }).link.emailed).toBe(true);
    expect(sent[0].to).toBe('bob@example.com');

    const request = await b.call(new Jar(), '/api/auth/request-password-reset', {
        body: { email: 'ada@example.com', redirectTo: '/reset-password' },
    });
    expect(request.status).toBe(200);
    const token = /reset-password\?token=([\w-]+)/.exec(sent[1].text)![1];
    const reset = await b.call(new Jar(), '/api/auth/reset-password', {
        body: { token, newPassword: 'a-brand-new-password' },
    });
    expect(reset.status).toBe(200);
    // Resetting signs the account out everywhere.
    expect((await b.call(adminJar, '/api/state')).status).toBe(401);
    expect((await b.signIn('ada@example.com', 'a-brand-new-password')).response.status).toBe(200);
});

it('creates the first admin and password links from the command line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-auth-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = {
        AUTH_PROVIDER: 'betterauth',
        APP_ORIGIN: ORIGIN,
        SESSION_SECRET: SECRET,
        DATABASE_PATH: join(dir, 'brain.sqlite'),
        BACKUP_DIR: join(dir, 'backups'),
    };
    const run = async (...args: string[]) => {
        const lines: string[] = [];
        await authCli(args, env, (line) => lines.push(line));
        return lines.join('\n');
    };
    const created = await run('create-user', '--email', 'ada@example.com', '--name', 'Ada');
    expect(created).toMatch(/Created admin ada@example.com \(user u-/);
    expect(created).toContain(`${ORIGIN}/reset-password?token=`);
    writeFileSync(join(dir, 'password'), `${PASSWORD}\n`);
    const smoke = await run(
        'create-user',
        '--email',
        'smoke-member@example.com',
        '--role',
        'member',
        '--password-file',
        join(dir, 'password'),
    );
    expect(smoke).not.toContain('token=');
    expect(await run('password-link', '--email', 'ADA@example.com')).toContain('/reset-password?token=');
    const list = await run('list');
    // The first admin is the workspace owner (CB-390).
    expect(list).toMatch(/ada@example.com\tadmin \(owner\)/);
    expect(list).toMatch(/smoke-member@example.com\tmember\tuser u-\w+\tpassword/);
    await expect(run('password-link', '--email', 'nobody@example.com')).rejects.toThrow(/No account/);
    expect(await run('create-user', '--email', 'olga@example.com', '--name', 'Olga', '--role', 'admin')).toMatch(
        /Created admin olga@example.com/,
    );
    // The retired role is refused with a message that names the change (CB-390).
    await expect(run('create-user', '--email', 'x@example.com', '--role', 'operator')).rejects.toThrow(
        /operator role was retired: use --role admin/,
    );
    await expect(run('create-user', '--email', 'x@example.com', '--role', 'owner')).rejects.toThrow(
        /--role admin\|member/,
    );
    await expect(authCli(['list'], { ...env, AUTH_PROVIDER: 'mock' }, () => {})).rejects.toThrow(
        /AUTH_PROVIDER=betterauth/,
    );
});

// Generic OAuth/OIDC against a local fake issuer.
let fake: FakeOidc;
const oauthEnv = (env: Record<string, string> = {}) => ({
    AUTH_OAUTH_PROVIDERS: 'logto',
    AUTH_OAUTH_LOGTO_ISSUER: fake.issuer,
    AUTH_OAUTH_LOGTO_CLIENT_ID: fake.clientId,
    AUTH_OAUTH_LOGTO_CLIENT_SECRET: fake.clientSecret,
    AUTH_OAUTH_LOGTO_NAME: 'Logto',
    AUTH_OAUTH_LOGTO_GROUPS_CLAIM: 'roles',
    AUTH_OAUTH_LOGTO_ADMIN_GROUP: 'brain-admin',
    AUTH_ALLOWED_DOMAINS: 'example.com',
    ...env,
});
async function withFake() {
    fake = await new FakeOidc().start();
    cleanups.push(() => fake.stop());
}

/** Sign in → the fake issuer's authorize endpoint → back to the callback. */
async function oauth(b: Brain, { callback = (url: URL) => url, jar = new Jar(), withoutCookies = false } = {}) {
    const start = await b.call(jar, '/api/auth/sign-in/social', {
        body: { provider: 'logto', callbackURL: '/', errorCallbackURL: '/' },
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = await fetch(url, { redirect: 'manual' });
    const back = callback(new URL(authorize.headers.get('location')!));
    // The issuer is another site: the browser says so, and it must still work.
    const response = jar.store(
        await b.app.request(`${b.origin}${back.pathname}${back.search}`, {
            headers: {
                ...(withoutCookies ? {} : { cookie: jar.header }),
                'sec-fetch-site': 'cross-site',
            },
        }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!, b.origin);
    return {
        jar,
        location,
        error: location.searchParams.get('error'),
        signedIn: jar.has(b.sessionCookie),
    };
}

it('signs in with OAuth/OIDC (code + PKCE + nonce), admin by group', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    fake.claims = {
        name: 'Ada Admin',
        email: 'ada@example.com',
        email_verified: true,
        roles: ['brain-admin'],
    };
    const { jar, location, signedIn } = await oauth(b);
    expect(signedIn).toBe(true);
    expect(location.href).toBe(`${ORIGIN}/`);
    const authorize = fake.requests.find((r) => r.path === '/auth')!.params;
    expect(Object.fromEntries(authorize)).toMatchObject({
        response_type: 'code',
        client_id: fake.clientId,
        redirect_uri: `${ORIGIN}/api/auth/callback/logto`,
        code_challenge_method: 'S256',
        nonce: expect.any(String),
    });
    expect(authorize.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['openid', 'profile', 'email']));
    const session = await b.session(jar);
    expect(session.user).toEqual({
        id: expect.stringMatching(/^u-/),
        name: 'Ada Admin',
        role: 'admin',
    });
    expect(session.methods?.providers).toEqual([{ id: 'logto', name: 'Logto' }]);
    expect(b.provider.accounts()[0].providers).toEqual(['logto']);
    // Signing in again finds the same account.
    const again = await oauth(b);
    expect((await b.session(again.jar)).user).toEqual(session.user);
    expect(b.provider.accounts()).toHaveLength(1);
});

it('keeps the OAuth state on __Host- cookies over https', async () => {
    await withFake();
    const b = await brain({ ...oauthEnv(), APP_ORIGIN: HTTPS });
    fake.claims = {
        name: 'Ada',
        email: 'ada@example.com',
        email_verified: true,
        roles: [],
    };
    const jar = new Jar();
    const { signedIn, location } = await oauth(b, { jar });
    expect(signedIn).toBe(true);
    expect(location.href).toBe(`${HTTPS}/`);
    expect(fake.requests.find((r) => r.path === '/auth')!.params.get('redirect_uri')).toBe(
        `${HTTPS}/api/auth/callback/logto`,
    );
    expect((await b.session(jar)).user?.name).toBe('Ada');
});

it('maps OAuth identities to members and refuses the uninvited', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    fake.sub = 'sub-bea';
    fake.claims = { name: 'Bea', email: 'bea@example.com', email_verified: true };
    const bea = await oauth(b);
    expect((await b.session(bea.jar)).user?.role).toBe('member');

    for (const claims of [
        // Outside the allowed domain.
        { email: 'eve@elsewhere.test', email_verified: true },
        // In the domain, but the issuer doesn't vouch for the address.
        { email: 'mal@example.com', email_verified: false },
    ]) {
        fake.sub = `sub-${claims.email}`;
        fake.claims = { name: 'Someone', ...claims };
        const refused = await oauth(b);
        expect(refused.signedIn).toBe(false);
        expect(refused.error).toBe('not_invited');
        expect(refused.location.origin + refused.location.pathname).toBe(`${ORIGIN}/`);
    }
    expect(b.provider.accounts().map((a) => a.email)).toEqual(['bea@example.com']);
});

it('reads groups from userinfo when the ID token lacks them', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    fake.claims = { name: 'Ada', email: 'ada@example.com', email_verified: true };
    fake.userinfo = { roles: ['brain-admin'] };
    const { jar } = await oauth(b);
    expect((await b.session(jar)).user?.role).toBe('admin');
    expect(fake.count('/me')).toBe(1);
});

it('refuses a callback with a wrong state or without its state cookie', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    fake.claims = {
        email: 'ada@example.com',
        email_verified: true,
        roles: ['brain-admin'],
    };
    const tampered = await oauth(b, {
        callback: (url) => {
            url.searchParams.set('state', 'forged-state');
            return url;
        },
    });
    expect(tampered.signedIn).toBe(false);
    expect(tampered.error).toBe('state_mismatch');
    // The state cookie belongs to the browser that started the sign-in.
    const elsewhere = await oauth(b, { withoutCookies: true });
    expect(elsewhere.signedIn).toBe(false);
    expect(elsewhere.error).toBe('state_mismatch');
    expect(b.provider.accounts()).toEqual([]);
});

it('refuses ID tokens with a wrong nonce, audience, issuer or signature', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    const good = {
        email: 'ada@example.com',
        email_verified: true,
        roles: ['brain-admin'],
    };
    for (const setup of [
        () => (fake.claims = { ...good, nonce: 'another-nonce' }),
        () => (fake.claims = { ...good, aud: 'another-client' }),
        () => (fake.claims = { ...good, iss: 'http://127.0.0.1:1/oidc' }),
        () => (fake.claims = { ...good, exp: Math.floor(Date.now() / 1000) - 600 }),
        () => {
            fake.claims = good;
            fake.tamper = (token) => `${token.slice(0, -4)}AAAA`;
        },
    ]) {
        fake.tamper = undefined;
        setup();
        const error = vi.mocked(console.error);
        error.mockClear();
        const refused = await oauth(b);
        expect(refused.signedIn).toBe(false);
        expect(refused.error).toBe('unable_to_get_user_info');
        expect(error).toHaveBeenCalledWith(
            'Auth: Provider "logto": id_token failed verification against the discovery JWKS or expected nonce',
        );
    }
    expect(b.provider.accounts()).toEqual([]);
});

it('links OAuth sign-ins to existing users by verified email', async () => {
    await withFake();
    const b = await brain(
        oauthEnv({
            AUTH_LINK_USERS: '{"alice":"alice@corp.test"}',
            AUTH_ALLOWED_DOMAINS: '',
        }),
    );
    // AUTH_LINK_USERS: alice's mock-era data and role carry over.
    fake.sub = 'sub-alice';
    fake.claims = {
        name: 'Alice A.',
        email: 'Alice@corp.test',
        email_verified: true,
    };
    const alice = await oauth(b);
    expect((await b.session(alice.jar)).user).toEqual({
        id: 'alice',
        name: 'Alice A.',
        role: 'admin',
    });
    // An account an admin created (linked to bob) gets the OAuth sign-in.
    await b.provider.createAccount({
        email: 'bob@corp.test',
        name: 'Bob',
        role: 'member',
        userId: 'bob',
    });
    fake.sub = 'sub-bob';
    fake.claims = {
        name: 'Bob B.',
        email: 'bob@corp.test',
        email_verified: true,
    };
    const bob = await oauth(b);
    expect((await b.session(bob.jar)).user).toMatchObject({
        id: 'bob',
        role: 'member',
    });
    // An unverified address never links.
    fake.sub = 'sub-impostor';
    fake.claims = { email: 'bob@corp.test', email_verified: false };
    expect((await oauth(b)).signedIn).toBe(false);
    expect(b.provider.accounts().find((a) => a.userId === 'bob')!.providers).toEqual(['logto']);
});

it('retries discovery when the issuer was down at startup', async () => {
    await withFake();
    fake.down = true;
    const b = await brain(oauthEnv());
    const first = await b.call(new Jar(), '/api/auth/sign-in/social', {
        body: { provider: 'logto', callbackURL: '/' },
    });
    expect(first.status).toBe(404);
    expect(await first.json()).toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    fake.down = false;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    const retried = await b.call(new Jar(), '/api/auth/sign-in/social', {
        body: { provider: 'logto', callbackURL: '/' },
    });
    expect(retried.status).toBe(200);
    vi.mocked(Date.now).mockRestore();
    fake.claims = {
        email: 'ada@example.com',
        email_verified: true,
        roles: ['brain-admin'],
    };
    expect((await oauth(b)).signedIn).toBe(true);
});

it('keeps OAuth redirects on this origin', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    const response = await b.call(new Jar(), '/api/auth/sign-in/social', {
        body: { provider: 'logto', callbackURL: 'https://evil.example/' },
    });
    expect(response.status).toBe(403);
    warn.mockClear();
});

it('keeps mock auth the default, with its picker', async () => {
    const auth = authFromEnv({}, '127.0.0.1');
    expect(auth.provider.kind).toBe('mock');
    expect(auth.provider.signInMethods).toBeUndefined();
    expect(auth.provider.navigationPaths).toBeUndefined();
});

it('sends account email through the configured SMTP server', async () => {
    // A loopback SMTP server that accepts one message.
    const { createServer } = await import('node:net');
    const received: string[] = [];
    const server = createServer((socket) => {
        let data = false;
        let buffer = '';
        socket.write('220 fake ESMTP\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            let index;
            while ((index = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (data) {
                    if (line === '.') {
                        data = false;
                        socket.write('250 queued\r\n');
                    } else {
                        received.push(line);
                    }
                } else if (/^(EHLO|HELO)/i.test(line)) {
                    socket.write('250 fake\r\n');
                } else if (/^DATA/i.test(line)) {
                    data = true;
                    socket.write('354 go\r\n');
                } else if (/^QUIT/i.test(line)) {
                    socket.end('221 bye\r\n');
                } else {
                    socket.write('250 ok\r\n');
                }
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => void server.close());
    const port = (server.address() as { port: number }).port;
    const { smtpMailer } = await import('../src/server/auth/mailer.js');
    await smtpMailer({
        url: `smtp://127.0.0.1:${port}`,
        from: 'Socio <brain@example.com>',
    }).send({
        to: 'bob@example.com',
        subject: 'Your Socio account',
        text: 'Set your password here: http://localhost:4310/reset-password?token=t',
    });
    const message = received.join('\n');
    expect(message).toContain('To: bob@example.com');
    expect(message).toContain('Subject: Your Socio account');
    expect(message).toContain('reset-password?token=t');
});

it("doesn't let people change their own role, app user or email", async () => {
    const b = await brain();
    await b.provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        password: PASSWORD,
    });
    const bob = (await b.signIn('bob@example.com')).jar;
    const before = (await b.session(bob)).user;
    for (const body of [{ role: 'admin' }, { appUserId: 'alice' }, { email: 'alice@example.com' }]) {
        const response = await b.call(bob, '/api/auth/update-user', { body });
        expect(response.status).toBe(400);
    }
    // The name is theirs to change.
    expect((await b.call(bob, '/api/auth/update-user', { body: { name: 'Robert' } })).status).toBe(200);
    expect((await b.session(bob)).user).toEqual({ ...before, name: 'Robert' });
    expect((await b.call(bob, '/api/auth/delete-user', { body: {} })).status).toBe(404);
});

// --- One admin tier (CB-390) ---------------------------------------------------

it('has one admin tier: admins manage every account, and the operator role is refused', async () => {
    const b = await brain();
    // Ada first: the first admin is the workspace owner.
    for (const [name, role] of [
        ['ada', 'admin'],
        ['olga', 'admin'],
        ['bea', 'member'],
    ] as [string, Role][]) {
        await b.provider.createAccount({ email: `${name}@example.com`, name, role, password: PASSWORD });
    }
    const id = (email: string) => b.provider.accounts().find((a) => a.email === email)!.id;
    const olga = (await b.signIn('olga@example.com')).jar;
    const ada = (await b.signIn('ada@example.com')).jar;
    // Ada manages another admin's account like anyone's.
    expect((await b.call(ada, `/api/accounts/${id('olga@example.com')}/password-link`, { body: {} })).status).toBe(200);
    const demoted = await b.call(ada, `/api/accounts/${id('olga@example.com')}`, {
        method: 'PATCH',
        body: { role: 'member' },
    });
    expect(await demoted.json()).toMatchObject({ role: 'member' });
    expect((await b.session(olga)).user?.role).toBe('member');
    // No one can grant or invite the retired role: 400, "Unknown role".
    const granted = await b.call(ada, `/api/accounts/${id('bea@example.com')}`, {
        method: 'PATCH',
        body: { role: 'operator' },
    });
    expect(granted.status).toBe(400);
    expect(await granted.json()).toEqual({ error: 'Unknown role.' });
    expect(
        (await b.call(ada, '/api/accounts', { body: { email: 'oz@example.com', name: 'Oz', role: 'operator' } }))
            .status,
    ).toBe(400);
    // Keep at least one admin; the owner stays one.
    const last = await b.call(ada, `/api/accounts/${id('ada@example.com')}`, {
        method: 'PATCH',
        body: { role: 'member' },
    });
    expect(last.status).toBe(400);
    expect(await last.json()).toEqual({
        error: 'The workspace owner stays an active admin. Make another admin the owner first.',
    });
    const gone = await b.call(ada, `/api/accounts/${id('ada@example.com')}`, { method: 'DELETE' });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({ error: 'Keep at least one admin.' });
    // Olga, now a member, can't touch the owner's account in any case.
    expect((await b.call(olga, `/api/accounts/${id('ada@example.com')}`)).status).toBe(403);
});

it('reads a stored operator as an admin', async () => {
    const b = await brain();
    await b.provider.createAccount({ email: 'olga@example.com', name: 'Olga', role: 'admin', password: PASSWORD });
    const olga = (await b.signIn('olga@example.com')).jar;
    new DatabaseSync(b.path).prepare(`UPDATE auth_user SET role = 'operator'`).run();
    expect((await b.session(olga)).user?.role).toBe('admin');
    expect(b.provider.accounts()[0].role).toBe('admin');
    expect((await b.call(olga, '/api/accounts')).status).toBe(200);
});

it("doesn't let an admin group or email demote an admin", async () => {
    await withFake();
    const b = await brain(oauthEnv({ AUTH_ADMIN_EMAILS: 'ada@example.com' }));
    await b.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'admin',
    });
    fake.claims = {
        name: 'Ada',
        email: 'ada@example.com',
        email_verified: true,
        roles: ['brain-admin'],
    };
    const { jar, signedIn } = await oauth(b);
    expect(signedIn).toBe(true);
    expect((await b.session(jar)).user?.role).toBe('admin');
    expect(b.provider.accounts()[0].role).toBe('admin');
});

it('creates the first admin at boot, once, linked to the app user, and makes them the owner', async () => {
    const b = await brain({
        AUTH_FIRST_ADMIN_EMAIL: 'Olga@Example.com',
        AUTH_FIRST_ADMIN_LINK: 'alice',
    });
    const lines = await b.provider.start();
    expect(lines.join('\n')).toMatch(/created the first admin's account/);
    // Local logs only, and even they don't spell the address out.
    expect(lines.join('\n')).not.toContain('olga@');
    expect(b.provider.accounts()).toEqual([
        expect.objectContaining({
            email: 'olga@example.com',
            userId: 'alice',
            name: 'Alice',
            role: 'admin',
            owner: true,
            emailVerified: true,
            password: false,
            passkeys: 0,
        }),
    ]);
    expect(b.provider.users()).toEqual([{ id: 'alice', name: 'Alice', role: 'admin' }]);
    for (const user of b.provider.users()) {
        b.workspace.recordUser(user);
    }
    expect(b.workspace.users().find((u) => u.id === 'alice')?.role).toBe('admin');
    // Idempotent: a restart changes nothing.
    expect(await b.provider.start()).toEqual([]);
    expect(b.provider.accounts()).toHaveLength(1);
    // Once an admin exists, it is never recreated, even after a change of
    // email in the settings (an owner is recorded for the one there is).
    const other = await brain({ AUTH_FIRST_ADMIN_EMAIL: 'someone@example.com' });
    await other.provider.createAccount({
        email: 'olga@example.com',
        name: 'Olga',
        role: 'admin',
    });
    expect((await other.provider.start()).join('\n')).not.toMatch(/first admin/);
    expect(other.provider.accounts()).toHaveLength(1);
});

it('makes an existing verified account the first admin, never an unverified one or a taken link', async () => {
    const verified = await brain({ AUTH_FIRST_ADMIN_EMAIL: 'ada@example.com' });
    await verified.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'member',
        userId: 'alice',
    });
    expect((await verified.provider.start()).join('\n')).toMatch(
        /made the AUTH_FIRST_ADMIN_EMAIL account \(user alice\) the first admin/,
    );
    expect(verified.provider.accounts()[0]).toMatchObject({ role: 'admin', owner: true });

    // A self-service sign-up with the first admin's address proves nothing.
    const open = await brain({
        AUTH_FIRST_ADMIN_EMAIL: 'ada@example.com',
        AUTH_OPEN_SIGNUP: 'true',
    });
    await open.call(new Jar(), '/api/auth/sign-up/email', {
        body: { email: 'ada@example.com', password: PASSWORD, name: 'Not Ada' },
    });
    expect((await open.provider.start()).join('\n')).toMatch(/unconfirmed email, so it was not made the first admin/);
    expect(open.provider.accounts()[0].role).toBe('member');

    // The app user to link already belongs to another account.
    const taken = await brain({
        AUTH_FIRST_ADMIN_EMAIL: 'olga@example.com',
        AUTH_FIRST_ADMIN_LINK: 'alice',
    });
    await taken.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'member',
        userId: 'alice',
    });
    expect((await taken.provider.start()).join('\n')).toMatch(/alice \(AUTH_FIRST_ADMIN_LINK\) is already linked/);
    expect(taken.provider.accounts().map((a) => a.email)).toEqual(['ada@example.com']);

    // A fresh database: the linked id needs no users row yet.
    const fresh = await brain({
        AUTH_FIRST_ADMIN_EMAIL: 'olga@example.com',
        AUTH_FIRST_ADMIN_LINK: 'carol',
    });
    await fresh.provider.start();
    expect(fresh.provider.accounts()[0]).toMatchObject({
        userId: 'carol',
        name: 'olga',
        role: 'admin',
    });
});

it('validates the first admin settings, under either name', () => {
    const start = (env: Record<string, string>) =>
        authFromEnv(
            {
                AUTH_PROVIDER: 'betterauth',
                APP_ORIGIN: ORIGIN,
                SESSION_SECRET: SECRET,
                ...env,
            },
            '127.0.0.1',
            { database: ':memory:' },
        );
    expect(() => start({ AUTH_FIRST_ADMIN_EMAIL: 'not-an-email' })).toThrow('AUTH_FIRST_ADMIN_EMAIL');
    expect(() => start({ AUTH_FIRST_ADMIN_LINK: 'alice' })).toThrow(
        'AUTH_FIRST_ADMIN_LINK needs AUTH_FIRST_ADMIN_EMAIL',
    );
    expect(() => start({ AUTH_FIRST_ADMIN_EMAIL: 'olga@example.com', AUTH_FIRST_ADMIN_LINK: 'A!' })).toThrow(
        'AUTH_FIRST_ADMIN_LINK must be an app user id',
    );
    expect(() => start({ AUTH_OPERATOR_EMAIL: 'not-an-email' })).toThrow('AUTH_OPERATOR_EMAIL');
    // Mock auth ignores it, and says so.
    expect(authFromEnv({ AUTH_FIRST_ADMIN_EMAIL: 'olga@example.com' }, '127.0.0.1').warnings).toContainEqual(
        expect.stringMatching(/AUTH_FIRST_ADMIN_EMAIL is used with/),
    );
    expect(authFromEnv({ AUTH_OPERATOR_EMAIL: 'olga@example.com' }, '127.0.0.1').warnings).toContainEqual(
        expect.stringMatching(/AUTH_OPERATOR_EMAIL is used with/),
    );
});

// --- One-time sign-in links by Telegram ------------------------------------

const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012';

/** await brain() with a running bot on a fake Bot API, delivering sign-in links. */
async function withTelegram(env: Record<string, string> = {}) {
    const b = await brain(env);
    const bot = await fakeTelegram();
    const runner = new LocalAgentRunner(testDatabase());
    const store = new Store(testDatabase());
    const channel = new TelegramChannel({
        settings: { token: BOT_TOKEN, allowedChatIds: [] },
        runner,
        store,
        workspace: b.workspace,
        ...telegramServices({
            store,
            workspace: b.workspace,
            config: {
                baseUrl: 'https://model.invalid',
                voiceName: 'marin',
                runtimeUrl: '',
            },
            runner,
        }),
        // As the server wires it: deactivated people are not users.
        isUser: activeUser(b.provider),
        apiRoot: bot.apiRoot,
    });
    b.platform.useTelegram(channel);
    await channel.start();
    b.provider.useSignInLinks([telegramSignInLinks(b.platform)]);
    cleanups.push(
        () => bot.close(),
        () => runner.close(),
        () => channel.stop(),
    );
    // bob (linked to Telegram user 4242) and alice (no Telegram link).
    await b.provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        userId: 'bob',
    });
    await b.provider.createAccount({
        email: 'ada@example.com',
        name: 'Ada',
        role: 'admin',
        userId: 'alice',
        password: PASSWORD,
    });
    await b.workspace.telegram.redeem((await b.workspace.telegram.createCode('bob')).code, '4242');
    // CB-352: who a code reaches, so a relink to another Telegram kills it.
    const sender = telegramSignInLinks(b.platform);
    expect(await sender.recipient('bob')).toBe('4242');
    expect(await sender.recipient('alice')).toBeNull();
    const dms = () => bot.calls.filter((call) => call.method === 'sendMessage' && call.body.chat_id === 4242);
    /** "Send me a sign-in link" from a client address. */
    const ask = (email: string, ip = '198.51.100.20') =>
        b.call(new Jar(), '/api/auth/sign-in-link', {
            body: { email },
            headers: { 'x-forwarded-for': ip },
        });
    /** The link in the nth DM, and its token. */
    const link = async (count: number) => {
        await bot.waitFor(() => dms().length >= count);
        const text = String(dms()[count - 1].body.text);
        const url = new URL(/https?:\/\/\S+/.exec(text)![0]);
        return { text, url, token: url.searchParams.get('token')! };
    };
    /** Opens the link's page and presses Continue: the verify request. */
    const use = async (token: string, jar = new Jar()) => {
        const response = await b.call(
            jar,
            `/api/auth/magic-link/verify?${new URLSearchParams({ token, callbackURL: '/', errorCallbackURL: '/' })}`,
            { headers: { 'sec-fetch-site': 'same-origin' } },
        );
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get('location')!, ORIGIN);
        return { jar, location, error: location.searchParams.get('error') };
    };
    const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));
    return { ...b, bot, channel, dms, ask, link, use, quiet };
}

it('DMs a one-time sign-in link to the linked Telegram, without the email', async () => {
    const t = await withTelegram();
    expect((await t.session(new Jar())).methods?.signInLink).toBe(true);
    const asked = await t.ask('Bob@Example.com');
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: true, message: SIGN_IN_LINK_SENT });
    const { text, url, token } = await t.link(1);
    // The link and a one-line note; never the address, nor anything about it.
    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toMatch(/bob@|example\.com|@/i);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/sign-in-link`);
    expect(t.dms()[0].body.link_preview_options).toEqual({ is_disabled: true });
    // The token is stored hashed, never as sent.
    const db = new DatabaseSync(t.path, { readOnly: true });
    const stored = db
        .prepare("SELECT identifier FROM auth_verification WHERE identifier LIKE 'magic-link:%'")
        .all() as { identifier: string }[];
    db.close();
    expect(stored).toHaveLength(1);
    expect(stored[0].identifier).not.toContain(token);

    // A cross-site navigation straight to the verify endpoint is refused,
    // and leaves the link usable.
    const crossSite = await t.app.request(`/api/auth/magic-link/verify?token=${token}&callbackURL=/`, {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);

    const first = await t.use(token);
    expect(first.error).toBeNull();
    expect(first.location.href).toBe(`${ORIGIN}/`);
    expect((await t.session(first.jar)).user).toEqual({
        id: 'bob',
        name: 'Bob',
        role: 'member',
    });
    // Single use.
    const again = await t.use(token);
    expect(again.error).toBe('INVALID_TOKEN');
    expect(again.jar.has('cb.session_token')).toBe(false);
});

it('answers the same whether or not a link can be sent, and sends only when it can', async () => {
    const t = await withTelegram();
    const answers = [];
    // No such account; an account without Telegram; one that can receive.
    for (const [email, ip] of [
        ['nobody@example.com', '198.51.100.31'],
        ['ada@example.com', '198.51.100.32'],
        ['bob@example.com', '198.51.100.33'],
    ]) {
        const response = await t.ask(email, ip);
        answers.push({ status: response.status, body: await response.json() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    await t.link(1);
    await t.quiet();
    expect(t.dms()).toHaveLength(1);
    expect(t.bot.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    // The public magic-link endpoint is not mounted: no way around the checks.
    const direct = await t.call(new Jar(), '/api/auth/sign-in/magic-link', {
        body: { email: 'bob@example.com', callbackURL: '/' },
    });
    expect(direct.status).toBe(404);
});

it('expires sign-in links after 15 minutes', async () => {
    const t = await withTelegram();
    await t.ask('bob@example.com');
    const { token } = await t.link(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60 * 1000 });
    try {
        const late = await t.use(token);
        expect(late.error).toBe('INVALID_TOKEN');
        expect(late.jar.has('cb.session_token')).toBe(false);
    } finally {
        vi.useRealTimers();
    }
});

it('rate limits sign-in links per client address and per account', async () => {
    const t = await withTelegram();
    // Per account: three links in 15 minutes, whoever asks; then silence,
    // with the same answer.
    for (let i = 0; i < 4; i++) {
        const response = await t.ask('bob@example.com', `198.51.100.${40 + i}`);
        expect(await response.json()).toEqual({
            ok: true,
            message: SIGN_IN_LINK_SENT,
        });
    }
    await t.link(3);
    await t.quiet();
    expect(t.dms()).toHaveLength(3);
    // Per client address: five requests, then 429 (for any address asked).
    for (let i = 0; i < 5; i++) {
        expect((await t.ask(`p${i}@example.com`, '203.0.113.50')).status).toBe(200);
    }
    expect((await t.ask('p9@example.com', '203.0.113.50')).status).toBe(429);
    expect((await t.ask('p9@example.com', '203.0.113.51')).status).toBe(200);
    // A new window, a new link.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60 * 1000 });
    try {
        await t.ask('bob@example.com', '198.51.100.60');
        await t.link(4);
    } finally {
        vi.useRealTimers();
    }
});

it('lets admins send a sign-in link by Telegram, never showing it', async () => {
    const t = await withTelegram();
    const ada = (await t.signIn('ada@example.com')).jar;
    const accounts = (
        (await (await t.call(ada, '/api/accounts')).json()) as {
            accounts: Account[];
        }
    ).accounts;
    const bob = accounts.find((a) => a.email === 'bob@example.com')!;
    const own = accounts.find((a) => a.email === 'ada@example.com')!;
    expect(bob.signInLinkVia).toBe('telegram');
    expect(own.signInLinkVia).toBeNull();
    const sent = await t.call(ada, `/api/accounts/${bob.id}/sign-in-link`, {
        body: {},
    });
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as Record<string, unknown>;
    expect(body).toEqual({ via: 'telegram', expiresAt: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('token');
    const { token } = await t.link(1);
    const bobJar = (await t.use(token)).jar;
    expect((await t.session(bobJar)).user?.id).toBe('bob');
    // No Telegram: use a password link instead.
    const none = await t.call(ada, `/api/accounts/${own.id}/sign-in-link`, {
        body: {},
    });
    expect(none.status).toBe(409);
    // Members can't.
    expect((await t.call(bobJar, `/api/accounts/${bob.id}/sign-in-link`, { body: {} })).status).toBe(403);
    // A stopped bot sends nothing.
    await t.channel.stop();
    expect((await t.call(ada, `/api/accounts/${bob.id}/sign-in-link`, { body: {} })).status).toBe(409);
    await t.ask('bob@example.com', '198.51.100.70');
    await t.quiet();
    expect(t.dms()).toHaveLength(1);
});

it('answers a polled view’s tag with 401 once the session is revoked, and 200 after a role change', async () => {
    // Live updates step 1: a 304 comes after the session check, and the
    // version holds the session's role.
    const b = await brain();
    const adminJar = await admin(b);
    await b.provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        password: PASSWORD,
    });
    const bobAccount = b.provider.accounts().find((a) => a.email === 'bob@example.com')!;
    const bob = (await b.signIn('bob@example.com')).jar;
    const poll = (tag: string) => b.call(bob, '/api/workspace', { headers: { 'If-None-Match': tag } });
    const first = await b.call(bob, '/api/workspace');
    const tag = first.headers.get('etag')!;
    expect((await poll(tag)).status).toBe(304);
    const promote = await b.call(adminJar, `/api/accounts/${bobAccount.id}`, {
        method: 'PATCH',
        body: { role: 'admin' },
    });
    expect(promote.status).toBe(200);
    const promoted = await poll(tag);
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { user: { role: Role } }).user.role).toBe('admin');
    const revoke = await b.call(adminJar, `/api/accounts/${bobAccount.id}/sessions`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);
    expect((await poll(promoted.headers.get('etag')!)).status).toBe(401);
});

// --- Deactivation instead of removal --------------------------------------

/** await brain() with an admin (Ada) and Bob, a member linked to app user bob. */
async function withBob(b: Brain) {
    const adminJar = await admin(b);
    await b.provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        userId: 'bob',
        password: PASSWORD,
    });
    const accounts = b.provider.accounts();
    return {
        adminJar,
        ada: accounts.find((a) => a.email === 'ada@example.com')!,
        bob: accounts.find((a) => a.userId === 'bob')!,
    };
}

/** A GET a link opens refused for a deactivated person: the sign-in screen says why. */
const toldDeactivated = (response: Response) => {
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/`);
    expect(location.searchParams.get('error')).toBe('BANNED_USER');
    expect(response.headers.getSetCookie()).toEqual([]);
};

it('deactivates a person: sessions end, sign-in is refused, their content stays named; reactivating lets them in again', async () => {
    const b = await brain();
    const { adminJar, ada, bob } = await withBob(b);
    const laptop = (await b.signIn('bob@example.com')).jar;
    const phone = (await b.signIn('bob@example.com')).jar;
    const filed = await b.call(laptop, '/api/issues', {
        body: { title: 'The printer jams on A3' },
    });
    expect(filed.status).toBe(201);
    const { issue } = (await filed.json()) as { issue: { number: number } };
    await b.call(laptop, `/api/issues/${issue.number}/comments`, {
        body: { body: 'Every morning.' },
    });

    const off = await b.call(adminJar, `/api/accounts/${bob.id}/deactivate`, {
        body: {},
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
        id: bob.id,
        userId: 'bob',
        deactivated: true,
        signInLinkVia: null,
    });
    // Every session ended at once.
    for (const jar of [laptop, phone]) {
        expect((await b.call(jar, '/api/state')).status).toBe(401);
    }
    // The password is right, and still no session.
    const refused = await b.signIn('bob@example.com');
    expect(refused.response.status).toBe(403);
    expect(await refused.response.json()).toEqual({
        error: DEACTIVATED_MESSAGE,
        code: 'BANNED_USER',
    });
    expect(refused.jar.has('cb.session_token')).toBe(false);
    // Not a user who may act (Telegram, schedules), but still named.
    expect(b.provider.users().map((user) => user.id)).not.toContain('bob');
    expect(activeUser(b.provider)('bob')).toBe(false);
    expect(b.workspace.users().find((user) => user.id === 'bob')).toMatchObject({
        name: 'Bob',
    });
    const detail = (await (await b.call(adminJar, `/api/issues/${issue.number}`)).json()) as {
        issue: { reporterId: string };
        comments: { authorId: string }[];
        users: Record<string, string>;
    };
    expect(detail.issue.reporterId).toBe('bob');
    expect(detail.comments.map((comment) => comment.authorId)).toEqual(['bob']);
    expect(detail.users.bob).toBe('Bob');
    // No links for a deactivated person; deactivating again changes nothing.
    for (const path of ['password-link', 'sign-in-link']) {
        const link = await b.call(adminJar, `/api/accounts/${bob.id}/${path}`, {
            body: {},
        });
        expect(link.status).toBe(409);
        expect(await link.json()).toEqual({
            error: 'This person is deactivated. Reactivate them first.',
        });
    }
    expect(
        (
            await b.call(adminJar, `/api/accounts/${bob.id}/deactivate`, {
                body: {},
            })
        ).status,
    ).toBe(200);
    expect(b.workspace.auditOf('user', 'bob')).toEqual([
        expect.objectContaining({
            actor: ada.userId,
            action: 'deactivate',
            targetKind: 'user',
            targetId: 'bob',
            detail: 'Bob',
        }),
    ]);

    const on = await b.call(adminJar, `/api/accounts/${bob.id}/reactivate`, {
        body: {},
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ deactivated: false });
    // Sign-in again, not the old sessions.
    expect((await b.call(laptop, '/api/state')).status).toBe(401);
    const back = await b.signIn('bob@example.com');
    expect(back.response.status).toBe(200);
    expect((await b.session(back.jar)).user).toEqual({
        id: 'bob',
        name: 'Bob',
        role: 'member',
    });
    expect(activeUser(b.provider)('bob')).toBe(true);
    expect(b.workspace.auditOf('user', 'bob').map((entry) => entry.action)).toEqual(['deactivate', 'reactivate']);
    // Members manage no one.
    for (const action of ['deactivate', 'reactivate']) {
        expect(
            (
                await b.call(back.jar, `/api/accounts/${ada.id}/${action}`, {
                    body: {},
                })
            ).status,
        ).toBe(403);
    }
});

it("doesn't serve Better Auth's admin endpoints: accounts change only through the guarded routes", async () => {
    const b = await brain();
    const { adminJar, bob } = await withBob(b);
    for (const path of [
        'ban-user',
        'unban-user',
        'impersonate-user',
        'remove-user',
        'set-role',
        'set-user-password',
        'list-users',
    ]) {
        const response = await b.call(adminJar, `/api/auth/admin/${path}`, {
            body: { userId: bob.id },
        });
        expect(response.status, path).toBe(404);
    }
    expect(b.provider.accounts().find((a) => a.id === bob.id)).toMatchObject({
        deactivated: false,
        role: 'member',
    });
});

it('refuses a deactivated person a passkey sign-in', async () => {
    const b = await brain();
    const { bob } = await withBob(b);
    const jar = (await b.signIn('bob@example.com')).jar;
    const authenticator = new SoftAuthenticator(ORIGIN);
    const options = (await (await b.call(jar, '/api/auth/passkey/generate-register-options')).json()) as {
        challenge: string;
        rp: { id: string };
    };
    await b.call(jar, '/api/auth/passkey/verify-registration', {
        body: { response: authenticator.register(options), name: 'Laptop' },
    });
    await b.provider.deactivate(bob.id, 'alice');
    // The passkey is kept, for a reactivation, and signs no one in.
    expect(b.provider.accounts().find((a) => a.id === bob.id)?.passkeys).toBe(1);
    const browser = new Jar();
    const challenge = (await (await b.call(browser, '/api/auth/passkey/generate-authenticate-options')).json()) as {
        challenge: string;
    };
    const refused = await b.call(browser, '/api/auth/passkey/verify-authentication', {
        body: { response: authenticator.authenticate(challenge) },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
        error: DEACTIVATED_MESSAGE,
        code: 'BANNED_USER',
    });
    expect(browser.has('cb.session_token')).toBe(false);
});

it('refuses a deactivated person an OAuth sign-in', async () => {
    await withFake();
    const b = await brain(oauthEnv());
    fake.claims = {
        name: 'Bea',
        email: 'bea@example.com',
        email_verified: true,
    };
    const first = await oauth(b);
    expect(first.signedIn).toBe(true);
    const [bea] = b.provider.accounts();
    await b.provider.deactivate(bea.id, 'alice');
    expect((await b.call(first.jar, '/api/state')).status).toBe(401);
    const again = await oauth(b);
    expect(again.signedIn).toBe(false);
    expect(again.error).toBe('BANNED_USER');
    // No second account for the same person either.
    expect(b.provider.accounts()).toHaveLength(1);
});

it('refuses a deactivated person the email confirmation that would sign them in', async () => {
    const sent: { to: string; text: string }[] = [];
    const b = await brain({ AUTH_OPEN_SIGNUP: 'true' }, { send: async (message) => void sent.push(message) });
    await admin(b);
    const joined = await b.call(new Jar(), '/api/auth/sign-up/email', {
        body: { email: 'eve@example.com', password: PASSWORD, name: 'Eve' },
    });
    expect(joined.status).toBe(200);
    const confirm = sent.find((message) => message.to === 'eve@example.com')!;
    const url = new URL(/https?:\/\/\S+/.exec(confirm.text)![0]);
    const eve = b.provider.accounts().find((a) => a.email === 'eve@example.com')!;
    await b.provider.deactivate(eve.id, 'alice');
    const jar = new Jar();
    toldDeactivated(
        await b.call(jar, `${url.pathname}${url.search}`, {
            headers: { 'sec-fetch-site': 'same-origin' },
        }),
    );
    expect((await b.session(jar)).user).toBeNull();
});

it('refuses a deactivated person sign-in links, and their Telegram link stops acting for them', async () => {
    const t = await withTelegram();
    const bob = (await t.provider.listedAccounts()).find((a) => a.userId === 'bob')!;
    expect(bob.signInLinkVia).toBe('telegram');
    await t.ask('bob@example.com', '198.51.100.40');
    const { token } = await t.link(1);
    await t.provider.deactivate(bob.id, 'alice');
    // A link sent before is refused, and new ones aren't sent.
    toldDeactivated(
        await t.call(
            new Jar(),
            `/api/auth/magic-link/verify?${new URLSearchParams({ token, callbackURL: '/', errorCallbackURL: '/' })}`,
            { headers: { 'sec-fetch-site': 'same-origin' } },
        ),
    );
    await t.ask('bob@example.com', '198.51.100.41');
    await t.quiet();
    expect(t.dms()).toHaveLength(1);
    expect((await t.provider.listedAccounts()).find((a) => a.id === bob.id)).toMatchObject({
        signInLinkVia: null,
    });
    // The Telegram link is kept, but the bot treats the account as unlinked.
    expect(await t.workspace.telegram.userFor('4242')).toBe('bob');
    t.bot.message({
        text: 'hello',
        chat: { id: 4242, type: 'private' },
        from: { id: 4242 },
    });
    await t.bot.waitFor((c) => c.method === 'sendMessage' && c.body.chat_id === 4242 && c.body.text === UNLINKED_REPLY);
});

it('keeps the last active admin; deactivated ones are not counted (CB-390: one admin tier)', async () => {
    const b = await brain();
    for (const [email, name, role] of [
        ['olga@example.com', 'Olga', 'admin'],
        ['otto@example.com', 'Otto', 'admin'],
        ['ada@example.com', 'Ada', 'admin'],
    ] as const) {
        await b.provider.createAccount({ email, name, role, password: PASSWORD });
    }
    const olga = (await b.signIn('olga@example.com')).jar;
    const ada = (await b.signIn('ada@example.com')).jar;
    const id = (email: string) => b.provider.accounts().find((a) => a.email === email)!.id;
    // An admin deactivates another admin.
    expect((await b.call(ada, `/api/accounts/${id('otto@example.com')}/deactivate`, { body: {} })).status).toBe(200);
    expect((await b.call(olga, `/api/accounts/${id('ada@example.com')}/deactivate`, { body: {} })).status).toBe(200);
    // Olga is the only active admin left.
    const own = `/api/accounts/${id('olga@example.com')}`;
    const self = await b.call(olga, `${own}/deactivate`, { body: {} });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: 'Keep at least one admin.' });
    // Olga, the first admin, is also the owner (CB-390).
    const stepDown = await b.call(olga, own, { method: 'PATCH', body: { role: 'member' } });
    expect(await stepDown.json()).toEqual({
        error: 'The workspace owner stays an active admin. Make another admin the owner first.',
    });
    // A deactivated admin's role is no guard: demoting Ada is fine.
    const demote = await b.call(olga, `/api/accounts/${id('ada@example.com')}`, {
        method: 'PATCH',
        body: { role: 'member' },
    });
    expect(await demote.json()).toMatchObject({ role: 'member', deactivated: true });
    // With Otto back, Otto may go, and the owner still may not.
    await b.call(olga, `/api/accounts/${id('otto@example.com')}/reactivate`, { body: {} });
    expect((await b.call(olga, `${own}/deactivate`, { body: {} })).status).toBe(400);
    expect((await b.call(olga, `/api/accounts/${id('otto@example.com')}/deactivate`, { body: {} })).status).toBe(200);
});

it('keeps at least one active admin when the others are deactivated', async () => {
    const b = await brain();
    const adaJar = await admin(b);
    await b.provider.createAccount({
        email: 'carl@example.com',
        name: 'Carl',
        role: 'admin',
        password: PASSWORD,
    });
    const id = (email: string) => b.provider.accounts().find((a) => a.email === email)!.id;
    await b.call(adaJar, `/api/accounts/${id('carl@example.com')}/deactivate`, {
        body: {},
    });
    const own = `/api/accounts/${id('ada@example.com')}`;
    for (const response of [
        await b.call(adaJar, `${own}/deactivate`, { body: {} }),
        await b.call(adaJar, own, { method: 'DELETE' }),
    ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: 'Keep at least one admin.',
        });
    }
    // Ada is the first admin, so the owner: her own demotion says so (CB-390).
    const demote = await b.call(adaJar, own, { method: 'PATCH', body: { role: 'member' } });
    expect(demote.status).toBe(400);
    expect(await demote.json()).toEqual({
        error: 'The workspace owner stays an active admin. Make another admin the owner first.',
    });
});

it('ends what acts for a deactivated person: the keys they made, their mini app sessions and schedules, their subscriptions', async () => {
    const b = await brain();
    const { adminJar, ada } = await withBob(b);
    await b.provider.createAccount({
        email: 'carl@example.com',
        name: 'Carl',
        role: 'admin',
        password: PASSWORD,
    });
    const carl = b.provider.accounts().find((a) => a.email === 'carl@example.com')!;
    // Carl signs in: the workspace knows his name (the key list's "made by").
    const carlJar = (await b.signIn('carl@example.com')).jar;
    expect((await b.call(carlJar, '/api/state')).status).toBe(200);
    const keys = b.platform.serviceAccounts;
    const ci = keys.create({ name: 'CI', role: 'member' }, carl.userId);
    const carlsKey = keys.createKey(ci.id, { name: 'deploys', scopes: ['issues:read'], days: 30 }, carl.userId);
    const adasKey = keys.createKey(ci.id, { name: 'reports', scopes: ['issues:read'], days: 30 }, ada.userId);
    const whoami = (token: string) =>
        b.app.request('/api/service/whoami', {
            headers: { authorization: `Bearer ${token}` },
        });
    expect((await whoami(carlsKey.token)).status).toBe(200);
    // A repeating task of Carl's, and one of Bob's.
    const store = b.platform.store;
    const report = await store.createTask('Weekly report', 3600, carl.userId);
    const other = await store.createTask('Bob’s digest', 3600, 'bob');
    // Sessions on mini apps' origins, Carl's and Bob's.
    const db = new DatabaseSync(b.path);
    const later = Date.now() + 3_600_000;
    for (const [hash, userId] of [
        ['h1', carl.userId],
        ['h2', 'bob'],
    ]) {
        db.prepare('INSERT INTO app_sessions VALUES (?, ?, ?, ?, ?)').run(
            hash,
            'tracker--dot',
            userId,
            Date.now(),
            later,
        );
    }
    const forget = vi.spyOn(b.platform.inference, 'forgetUser');
    // A second account whose only live key is Carl's: it stops working (CB-360).
    const bot = keys.create({ name: 'Bot', role: 'member' }, ada.userId);
    const botKey = keys.createKey(bot.id, { name: 'nightly', scopes: ['issues:read'], days: 30 }, carl.userId);
    expect((await whoami(botKey.token)).status).toBe(200);

    // The preview (CB-360) says what the deactivation below does, and changes nothing.
    const preview = await b.call(adminJar, `/api/accounts/${carl.id}/deactivation-impact`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
        accountId: carl.id,
        name: 'Carl',
        refusal: null,
        deactivated: false,
        sessions: 1,
        keys: [
            expect.objectContaining({ account: 'Bot', name: 'nightly', accountId: bot.id, lastLiveKey: true }),
            expect.objectContaining({ account: 'CI', name: 'deploys', accountId: ci.id, lastLiveKey: false }),
        ],
        connectedAgents: 0,
        socioGrants: 0,
        appSessions: 1,
        pluginAccess: 0,
        scheduledTasks: 1,
        jobRuns: 0,
        subscriptionConnections: 0,
        mcpConnections: 0,
        rooms: { handedOver: 0, archived: 0 },
        appsOwned: 0,
        owned: { schedules: 1 },
    });
    expect((await whoami(botKey.token)).status).toBe(200);
    expect(keys.get(ci.id).keys.every((key) => !key.revokedAt)).toBe(true);
    // The key list names who made each key. Sorted: the two keys are made in
    // the same millisecond on a fast run, and the list breaks that tie by
    // their random ids.
    expect(
        keys
            .get(ci.id)
            .keys.map((key) => [key.name, key.createdByName])
            .sort(),
    ).toEqual([
        ['deploys', 'Carl'],
        ['reports', 'Ada'],
    ]);

    const off = await b.call(adminJar, `/api/accounts/${carl.id}/deactivate`, {
        body: {},
    });
    expect(off.status).toBe(200);
    // The key Carl made stops (revoked, kept); Ada's still works.
    expect((await whoami(carlsKey.token)).status).toBe(401);
    expect((await whoami(adasKey.token)).status).toBe(200);
    expect(
        keys
            .get(ci.id)
            .keys.map((key) => [key.name, !!key.revokedAt])
            .sort(),
    ).toEqual([
        ['deploys', true],
        ['reports', false],
    ]);
    expect(
        db
            .prepare('SELECT userId FROM app_sessions ORDER BY userId')
            .all()
            .map((row) => row.userId),
    ).toEqual(['bob']);
    db.close();
    // Paused and kept, saying why; Bob's untouched.
    expect(await store.task(report.id)).toMatchObject({
        status: 'paused',
        error: DEACTIVATED_SCHEDULE,
        nextRunAt: null,
    });
    expect((await store.task(other.id))?.status).toBe('queued');
    // Due work that slips through is refused for its owner.
    const execute = scheduledTaskExecutor(b.platform, activeUser(b.provider));
    await expect(
        execute(
            { ...report, kind: 'job', jobId: 'nightly', lease: 'l' } as Claim,
            [],
            new AbortController().signal,
            () => {},
        ),
    ).rejects.toThrow('This schedule’s owner no longer has access.');
    expect(forget).toHaveBeenCalledWith(carl.userId);
    expect(b.workspace.auditOf('user', carl.userId)).toEqual([
        expect.objectContaining({
            actor: ada.userId,
            action: 'deactivate',
            detail: 'Carl; revoked keys they made: CI / deploys, Bot / nightly; ended 1 mini app session(s); paused 1 scheduled task(s)',
        }),
    ]);
    // Afterwards nothing is left to end.
    const after = (await (await b.call(adminJar, `/api/accounts/${carl.id}/deactivation-impact`)).json()) as {
        deactivated: boolean;
        keys: unknown[];
        appSessions: number;
    };
    expect(after).toMatchObject({ deactivated: true, keys: [], appSessions: 0, scheduledTasks: 0 });
});

it("gives admins a roster: each person's status, last use, sign-in methods, invite and reach (CB-360)", async () => {
    const b = await brain();
    const { adminJar, bob } = await withBob(b);
    const bobJar = (await b.signIn('bob@example.com')).jar;
    // Invited: an account with a password link, never used.
    const invited = await b.call(adminJar, '/api/accounts', {
        body: { email: 'finn@example.com', name: 'Finn', role: 'member' },
    });
    expect(invited.status).toBe(201);
    const finn = ((await invited.json()) as { account: Account }).account;
    await b.provider.createAccount({ email: 'eve@example.com', name: 'Eve', role: 'member', password: PASSWORD });
    const eve = b.provider.accounts().find((a) => a.email === 'eve@example.com')!;
    await b.call(adminJar, `/api/accounts/${eve.id}/deactivate`, { body: {} });
    const key = b.platform.serviceAccounts.create({ name: 'CI', role: 'member' }, 'bob');
    b.platform.serviceAccounts.createKey(key.id, { name: 'deploys', scopes: ['issues:read'], days: 30 }, 'bob');

    // The boot writes every account into the app's users table: that is no use.
    b.workspace.recordUser({ id: finn.userId, name: 'Finn', role: 'member' });
    // Bob made a signed-in request, then every session of his ended: still active.
    expect((await b.call(bobJar, '/api/state')).status).toBe(200);
    expect((await b.call(adminJar, `/api/accounts/${bob.id}/sessions`, { method: 'DELETE' })).status).toBe(200);
    const bobJar2 = (await b.signIn('bob@example.com')).jar;
    // A reset Finn asked for after the invite, already expired: the newest link counts.
    const db = new DatabaseSync(b.path);
    const invite = db
        .prepare(
            "SELECT createdAt, expiresAt FROM auth_verification WHERE value=? AND identifier LIKE 'reset-password:%'",
        )
        .get(finn.id) as { createdAt: unknown; expiresAt: unknown };
    const later = (value: unknown, ms: number) =>
        typeof value === 'number' ? value + ms : new Date(Date.parse(String(value)) + ms).toISOString();
    db.prepare(
        'INSERT INTO auth_verification(id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
        'reset-later',
        'reset-password:later',
        finn.id,
        later(invite.createdAt, -1000) as string,
        later(invite.createdAt, 1000) as string,
        later(invite.createdAt, 1000) as string,
    );
    // Finn and Eve created in the same instant: the roster still lists them in the order they were added.
    db.prepare('UPDATE auth_user SET createdAt=(SELECT createdAt FROM auth_user WHERE email=?) WHERE email=?').run(
        'finn@example.com',
        'eve@example.com',
    );
    db.close();

    expect((await b.call(bobJar2, '/api/accounts/roster')).status).toBe(403);
    expect((await b.call(bobJar2, `/api/accounts/${bob.id}/deactivation-impact`)).status).toBe(403);
    const response = await b.call(adminJar, '/api/accounts/roster');
    expect(response.status).toBe(200);
    const { people } = (await response.json()) as { people: RosterPerson[] };
    const by = (email: string) => people.find((person) => person.email === email)!;
    expect(people.map((person) => [person.email, person.status])).toEqual([
        ['ada@example.com', 'active'],
        ['bob@example.com', 'active'],
        ['finn@example.com', 'invited'],
        ['eve@example.com', 'deactivated'],
    ]);
    expect(by('bob@example.com')).toMatchObject({
        role: 'member',
        password: true,
        passkeys: 0,
        sessions: 1,
        invite: null,
        reach: { keysMade: 1, connectedAgents: 0, socioGrants: 0, appsOwned: 0, codeAccess: false, telegram: false },
    });
    expect(Date.parse(by('bob@example.com').lastActiveAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(by('bob@example.com').reach!.spaces).toBeGreaterThan(0);
    expect(by('finn@example.com')).toMatchObject({ id: finn.id, password: false, sessions: 0, lastActiveAt: null });
    expect(by('finn@example.com').invite).toEqual({ expiresAt: expect.any(String), expired: true });
    expect(Date.parse(by('finn@example.com').invite!.expiresAt)).toBeLessThan(Date.now());
    expect(by('eve@example.com')).toMatchObject({ deactivated: true, sessions: 0 });

    // The last admin's preview says it would be refused.
    const ada = by('ada@example.com');
    expect(await (await b.call(adminJar, `/api/accounts/${ada.id}/deactivation-impact`)).json()).toMatchObject({
        refusal: 'Keep at least one admin.',
        sessions: 1,
    });
    expect((await b.call(adminJar, '/api/accounts/nobody/deactivation-impact')).status).toBe(404);
});

it('leaves deactivated people out of the assignee picker and gives them no new issues; their assignments stay named', async () => {
    const b = await brain();
    const { adminJar, bob } = await withBob(b);
    const file = (body: Record<string, unknown>) =>
        b.call(adminJar, '/api/issues', { body: { status: 'open', ...body } });
    const kept = (
        (await (await file({ title: 'Bob’s', assigneeId: 'bob' })).json()) as {
            issue: { number: number };
        }
    ).issue.number;
    const other = (
        (await (await file({ title: 'Other' })).json()) as {
            issue: { number: number };
        }
    ).issue.number;
    const assignees = async () => (await (await b.call(adminJar, '/api/issues/assignees')).json()) as IssueAssignees;
    expect((await assignees()).users.map((user) => user.id)).toContain('bob');
    expect((await assignees()).deactivated).toEqual([]);

    await b.call(adminJar, `/api/accounts/${bob.id}/deactivate`, { body: {} });
    const picker = await assignees();
    expect(picker.users.map((user) => user.id)).not.toContain('bob');
    expect(picker.deactivated).toEqual([{ id: 'bob', name: 'Bob' }]);
    // No new issue for Bob, filed or changed.
    const refusedNew = await file({ title: 'New', assigneeId: 'bob' });
    expect(refusedNew.status).toBe(400);
    expect(await refusedNew.json()).toEqual({ error: ASSIGNEE_DEACTIVATED });
    const refusedPatch = await b.call(adminJar, `/api/issues/${other}`, {
        method: 'PATCH',
        body: { assigneeId: 'bob' },
    });
    expect(refusedPatch.status).toBe(400);
    // His issue stays his, named, and can still change.
    const patched = await b.call(adminJar, `/api/issues/${kept}`, {
        method: 'PATCH',
        body: { status: 'in_progress' },
    });
    expect(patched.status).toBe(200);
    const detail = (await (await b.call(adminJar, `/api/issues/${kept}`)).json()) as IssueDetail;
    expect(detail.issue).toMatchObject({
        assigneeId: 'bob',
        status: 'in_progress',
    });
    expect(detail.users.bob).toBe('Bob');

    await b.call(adminJar, `/api/accounts/${bob.id}/reactivate`, { body: {} });
    expect((await assignees()).users.map((user) => user.id)).toContain('bob');
    expect(
        (
            await b.call(adminJar, `/api/issues/${other}`, {
                method: 'PATCH',
                body: { assigneeId: 'bob' },
            })
        ).status,
    ).toBe(200);
});

it('deactivates and reactivates from the command line, with the routes’ guards and audit', async () => {
    const b = await brain();
    const { adminJar } = await withBob(b);
    const bobJar = (await b.signIn('bob@example.com')).jar;
    await b.call(bobJar, '/api/workspace');
    const mcp = b.platform.mcpConnections;
    const connection = await mcp.create('bob', {
        name: 'Personal fixture',
        url: 'https://mcp.example.test/mcp',
    });
    await mcp.saveCredentials('bob', connection.id, connection.generation, {
        tokens: 'local fixture only',
    });
    await mcp.repository.saveCatalog(
        'bob',
        connection.id,
        connection.generation,
        [
            {
                name: 'fixture',
                description: 'Local fixture',
                inputSchema: { type: 'object' },
                supported: true,
                fingerprint: 'f'.repeat(64),
            },
        ],
        'c'.repeat(64),
        Date.now(),
    );
    await mcp.grant('bob', connection.id, {
        generation: connection.generation,
        catalogRevision: 'c'.repeat(64),
        dotId: b.workspace.dotsFor('bob')[0].id,
        tools: ['fixture'],
    });
    await mcp.repository.createOAuth({
        stateHash: 'local-state',
        connectionId: connection.id,
        userId: 'bob',
        generation: connection.generation,
        cookieHash: 'local-cookie',
        secret: mcp.encrypt('bob', connection.id, connection.generation, {
            verifier: 'fixture',
        }),
        state: 'pending',
        expiresAt: Date.now() + 600000,
        createdAt: Date.now(),
    });
    const keys = b.platform.serviceAccounts;
    const ci = keys.create({ name: 'CI', role: 'member' }, 'bob');
    const bobsKey = keys.createKey(ci.id, { name: 'deploys', scopes: ['issues:read'], days: 30 }, 'bob');
    const digest = await b.platform.store.createTask('Digest', 3600, 'bob');
    const db = new DatabaseSync(b.path);
    db.prepare('INSERT INTO app_sessions VALUES (?, ?, ?, ?, ?)').run(
        'h1',
        'tracker--dot',
        'bob',
        Date.now(),
        Date.now() + 3_600_000,
    );
    db.close();
    const dir = mkdtempSync(join(tmpdir(), 'cb-auth-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = {
        AUTH_PROVIDER: 'betterauth',
        APP_ORIGIN: ORIGIN,
        SESSION_SECRET: SECRET,
        DATABASE_PATH: b.path,
        BACKUP_DIR: join(dir, 'backups'),
    };
    const run = async (...args: string[]) => {
        const lines: string[] = [];
        await authCli(args, env, (line) => lines.push(line));
        return lines.join('\n');
    };

    expect(await run('deactivate', '--email', 'BOB@example.com')).toBe(
        'Deactivated bob@example.com (user bob): Bob; revoked keys they made: CI / deploys; ended 1 mini app session(s); paused 1 scheduled task(s).',
    );
    // As from People: signed out, refused, and what acted for him ended.
    expect((await b.call(bobJar, '/api/state')).status).toBe(401);
    expect((await b.signIn('bob@example.com')).response.status).toBe(403);
    expect(
        (
            await b.app.request('/api/service/whoami', {
                headers: { authorization: `Bearer ${bobsKey.token}` },
            })
        ).status,
    ).toBe(401);
    expect(await b.platform.store.task(digest.id)).toMatchObject({
        status: 'paused',
        error: DEACTIVATED_SCHEDULE,
    });
    expect(b.workspace.isDeactivated('bob')).toBe(true);
    expect(mcp.repository.owned('bob', connection.id)).toMatchObject({
        generation: connection.generation + 1,
        state: 'disconnected',
        secret: null,
        catalog: '[]',
    });
    expect(mcp.repository.grants('bob', connection.id)).toEqual([]);
    expect(mcp.repository.oauth('bob', 'local-state')).toBeUndefined();
    expect(await run('list')).toMatch(/bob@example.com\tmember \(deactivated\)\tuser bob/);
    expect(await run('deactivate', '--email', 'bob@example.com')).toBe('bob@example.com is deactivated already.');
    // The guards: Ada is the only active admin.
    await expect(run('deactivate', '--email', 'ada@example.com')).rejects.toThrow('Keep at least one admin.');
    await expect(run('reactivate', '--email', 'nobody@example.com')).rejects.toThrow('No account with that email.');
    expect(b.provider.accounts().find((a) => a.email === 'ada@example.com')).toMatchObject({ deactivated: false });

    expect(await run('reactivate', '--email', 'bob@example.com')).toBe('Reactivated bob@example.com (user bob).');
    expect((await b.signIn('bob@example.com')).response.status).toBe(200);
    expect(mcp.get('bob', connection.id)).toMatchObject({
        state: 'disconnected',
        tools: [],
    });
    expect(mcp.credentials('bob', connection.id, connection.generation + 1)).toBeUndefined();
    expect(await run('reactivate', '--email', 'bob@example.com')).toBe('bob@example.com is active already.');
    expect(b.workspace.auditOf('user', 'bob').map(({ actor, action }) => `${actor} ${action}`)).toEqual([
        `${CLI_ACTOR} deactivate`,
        `${CLI_ACTOR} reactivate`,
    ]);
    // The admin still manages accounts as before.
    expect((await b.call(adminJar, '/api/accounts')).status).toBe(200);
});

it('refuses user ids kept for socios’ shared areas (socio:…) wherever users are made', async () => {
    // Accounts an admin makes, linked to an app user.
    const b = await brain();
    const adminJar = await admin(b);
    const created = await b.call(adminJar, '/api/accounts', {
        body: {
            email: 'odd@example.com',
            name: 'Odd',
            role: 'member',
            userId: 'socio:abc',
        },
    });
    expect(created.status).toBe(400);
    // Links set at startup, and mock users.
    const start = (env: Record<string, string>) =>
        authFromEnv({ APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, ...env }, '127.0.0.1', {
            database: ':memory:',
            read: () => 'file-secret',
        });
    expect(() =>
        start({
            AUTH_PROVIDER: 'betterauth',
            AUTH_LINK_USERS: '{"socio:abc":"odd@example.com"}',
        }),
    ).toThrow(/AUTH_LINK_USERS/);
    expect(() =>
        start({
            MOCK_USERS: '[{"id":"socio:abc","name":"Odd","role":"admin"}]',
        }),
    ).toThrow(/MOCK_USERS/);
    // And the users table itself.
    const workspace = new WorkspaceStore(testDatabase());
    expect(() => workspace.recordUser({ id: 'socio:abc', name: 'Odd', role: 'member' })).toThrow(/socio:/);
    expect(workspace.users().some((user) => user.id === 'socio:abc')).toBe(false);
    workspace.close();
});

it('lists what a person owns, hands it to another active person, then lets an admin remove them for good (CB-360)', async () => {
    // The purge's copy goes to BACKUP_DIR as the backups read it (trimmed,
    // backupDirFromEnv), not to a folder of its own beside the database.
    const backups = mkdtempSync(join(tmpdir(), 'cb-purge-backups-'));
    cleanups.push(() => {
        vi.unstubAllEnvs();
        rmSync(backups, { recursive: true, force: true });
    });
    vi.stubEnv('BACKUP_DIR', `  ${backups}  `);
    const b = await brain();
    const adaJar = await admin(b);
    for (const [email, name, role] of [
        ['ola@example.com', 'Ola', 'admin'],
        ['carl@example.com', 'Carl', 'member'],
        ['dana@example.com', 'Dana', 'member'],
        ['eve@example.com', 'Eve', 'member'],
    ] as const) {
        await b.provider.createAccount({ email, name, role, password: PASSWORD });
    }
    const account = (email: string) => b.provider.accounts().find((a) => a.email === email)!;
    const [ola, carl, dana, eve] = ['ola', 'carl', 'dana', 'eve'].map((n) => account(`${n}@example.com`));
    const olaJar = (await b.signIn('ola@example.com')).jar;
    const danaJar = (await b.signIn('dana@example.com')).jar;
    const json = async <T>(response: Response | Promise<Response>, status = 200) => {
        const r = await response;
        expect(r.status).toBe(status);
        return (await r.json()) as T;
    };
    // Carl's work: a personal socio, a file in his data space, a memory.
    const dot = b.workspace.dots()[0];
    b.workspace.createDot(
        dot.spaceId,
        'Helper',
        'Helps.',
        false,
        false,
        [dot.spaceId],
        null,
        false,
        null,
        false,
        carl.userId,
    );
    await b.platform.data.putFile({ kind: 'user', userId: carl.userId }, 'notes/plan.md', Buffer.from('carl plan'));
    await b.platform.data.putFile({ kind: 'user', userId: dana.userId }, 'notes/plan.md', Buffer.from('dana plan'));
    const writer = new DatabaseSync(b.path);
    writer
        .prepare("INSERT INTO memories (id, text, createdAt, userId) VALUES ('m-carl', 'Acme renews in May.', ?, ?)")
        .run(Date.now(), carl.userId);
    writer.close();

    const assets = await json<PersonAssets>(b.call(adaJar, `/api/accounts/${carl.id}/assets`));
    expect(assets).toMatchObject({ accountId: carl.id, name: 'Carl' });
    expect(Object.fromEntries(assets.kinds.map((kind) => [kind.kind, kind.count]))).toEqual({
        apps: 0,
        schedules: 0,
        socios: 1,
        spaces: 0,
        data: 1,
        conversations: 0,
        memories: 1,
    });
    expect(assets.kinds.find((kind) => kind.kind === 'data')!.items).toEqual([
        { id: expect.any(String), name: 'notes/plan.md', type: 'file', deleted: false },
    ]);
    expect((await b.call(danaJar, `/api/accounts/${carl.id}/assets`)).status).toBe(403);
    expect((await b.call(danaJar, `/api/accounts/${carl.id}/transfer`, { body: { to: dana.id } })).status).toBe(403);

    // The new owner: someone else, active, not a deactivated person.
    const transfer = (body: unknown) => b.call(adaJar, `/api/accounts/${carl.id}/transfer`, { body });
    expect((await transfer({ to: carl.id })).status).toBe(400);
    expect((await transfer({ to: 'nobody' })).status).toBe(400);
    expect((await transfer({ to: dana.id, kinds: ['keys'] })).status).toBe(400);
    expect((await b.call(adaJar, `/api/accounts/${eve.id}/deactivate`, { body: {} })).status).toBe(200);
    expect(await json<{ error: string }>(transfer({ to: eve.id }), 400)).toEqual({
        error: 'The new owner is deactivated: choose an active person.',
    });

    // Deactivated, Carl still owns it all; the preview says so.
    expect((await b.call(adaJar, `/api/accounts/${carl.id}/deactivate`, { body: {} })).status).toBe(200);
    const impact = await json<DeactivationImpact>(b.call(adaJar, `/api/accounts/${carl.id}/deactivation-impact`));
    expect(impact.owned).toEqual({ socios: 1, data: 1, memories: 1 });

    const moved = await json<AssetTransfer>(transfer({ to: dana.id }));
    expect(moved.from).toEqual({ accountId: carl.id, name: 'Carl' });
    expect(moved.to).toEqual({ accountId: dana.id, name: 'Dana' });
    expect(Object.fromEntries(moved.kinds.map((kind) => [kind.kind, kind.moved]))).toMatchObject({
        socios: { socios: 1 },
        data: { files: 1, filesRenamed: 1 },
        memories: { memories: 1 },
    });
    const dataNotes = moved.kinds.find((kind) => kind.kind === 'data')!.notes;
    expect(dataNotes).toContain('File notes/plan.md is now notes/plan 2.md: the new owner has a file there.');
    const danaActor = { kind: 'user' as const, userId: dana.userId };
    expect((await b.platform.data.getFile(danaActor, 'notes/plan 2.md')).data.toString()).toBe('carl plan');
    expect((await b.platform.data.getFile(danaActor, 'notes/plan.md')).data.toString()).toBe('dana plan');
    const after = await json<PersonAssets>(b.call(adaJar, `/api/accounts/${carl.id}/assets`));
    expect(after.kinds.every((kind) => kind.count === 0)).toBe(true);
    expect(b.workspace.auditOf('user', dana.userId)).toEqual([
        expect.objectContaining({ action: 'transfer', detail: expect.stringContaining('received from Carl') }),
    ]);

    // Remove permanently: admins (CB-390), in person, with the dry run first.
    const purge = (jar: Jar, id: string, body: unknown) => b.call(jar, `/api/accounts/${id}/purge`, { body });
    expect((await purge(adaJar, carl.id, { apply: false })).status).toBe(200);
    // A scheduled task of Dana's: what she owns as a schedule, which a
    // transfer moves, and not a second blocker of its own.
    const tasks = new DatabaseSync(b.path);
    tasks
        .prepare(
            "INSERT INTO tasks (id, prompt, status, createdAt, updatedAt, userId, dotId) VALUES ('t-dana', 'Weekly report', 'active', ?, ?, ?, ?)",
        )
        .run(Date.now(), Date.now(), dana.userId, dot.id);
    tasks.close();
    const active = await json<PersonPurgePlan>(purge(olaJar, dana.id, { apply: false }));
    expect(active.refusals).toEqual([
        'Deactivate them first.',
        'They still own schedules 1, socios 1, data 2, memories 1: transfer it to someone first.',
    ]);
    const self = await json<PersonPurgePlan>(purge(olaJar, ola.id, { apply: false }));
    expect(self.refusals[0]).toBe('You can’t remove yourself.');

    const plan = await json<PersonPurgePlan>(purge(olaJar, carl.id, { apply: false }));
    expect(plan).toMatchObject({ accountId: carl.id, name: 'Carl', refusals: [], targets: { users: 1 } });
    expect(plan.tables).toEqual(expect.arrayContaining([{ table: 'auth_user', rows: 1 }]));
    expect((await purge(olaJar, carl.id, { apply: true })).status).toBe(400);
    expect((await purge(olaJar, carl.id, { apply: true, confirmName: 'carl' })).status).toBe(400);
    expect((await purge(olaJar, carl.id, { apply: true, confirmName: 'Carl' })).status).toBe(401);
    const challenge = await json<StepUpChallenge>(
        b.call(olaJar, `/api/accounts/${carl.id}/purge/step-up`, { body: {} }),
    );
    expect(challenge.methods).toContain('password');
    // A challenge for another person's removal doesn't confirm this one.
    const other = await json<StepUpChallenge>(b.call(olaJar, `/api/accounts/${eve.id}/purge/step-up`, { body: {} }));
    expect(
        (
            await purge(olaJar, carl.id, {
                apply: true,
                confirmName: 'Carl',
                stepUp: { id: other.id, password: PASSWORD },
            })
        ).status,
    ).toBe(403);
    // Reactivated while the operator confirmed: refused, and the challenge is spent.
    const pending = await json<StepUpChallenge>(b.call(olaJar, `/api/accounts/${carl.id}/purge/step-up`, { body: {} }));
    expect((await b.call(adaJar, `/api/accounts/${carl.id}/reactivate`, { body: {} })).status).toBe(200);
    expect(
        await json<{ error: string }>(
            purge(olaJar, carl.id, {
                apply: true,
                confirmName: 'Carl',
                stepUp: { id: pending.id, password: PASSWORD },
            }),
            409,
        ),
    ).toEqual({ error: 'Deactivate them first.' });
    // And under the write lock: an active person is never removed, even past the route's checks.
    await expect(b.provider['purger']!.apply(carl.userId, ola.userId, { name: 'Carl' })).rejects.toThrow(
        'no longer deactivated',
    );
    expect(b.provider.accounts().some((a) => a.id === carl.id)).toBe(true);
    expect((await b.call(adaJar, `/api/accounts/${carl.id}/deactivate`, { body: {} })).status).toBe(200);
    const done = await json<PersonPurgeResult>(
        purge(olaJar, carl.id, { apply: true, confirmName: 'Carl', stepUp: { id: challenge.id, password: PASSWORD } }),
    );
    expect(done).toMatchObject({ accountId: carl.id, name: 'Carl', cleanup: { files: 0, objects: 0 } });
    expect(done.rows).toBeGreaterThan(1);
    expect(done.backup).toMatch(/purge-\d{8}-\d{6}(-\d+)?$/);
    expect(dirname(done.backup)).toBe(backups);
    expect(b.provider.accounts().some((a) => a.id === carl.id)).toBe(false);
    const reader = new DatabaseSync(b.path, { readOnly: true });
    expect(
        reader.prepare("SELECT actor FROM workspace_audit WHERE action='remove' AND targetKind='purge'").all(),
    ).toEqual([{ actor: ola.userId }]);
    // History stays: the transfer's audit line still names Carl's id.
    expect(
        reader
            .prepare("SELECT COUNT(*) AS n FROM workspace_audit WHERE action='transfer' AND targetId=?")
            .get(carl.userId),
    ).toEqual({ n: 1 });
    reader.close();
});
