import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type {
    AccessPolicyImpact,
    AccessPolicySaved,
    AccessPolicyView,
    StepUpChallenge,
} from '@socio/shared/access-policy';
import type { AuthSession } from '@socio/shared/auth';

import { writeStoredPolicy } from '../src/server/auth/access-policy-store.js';
import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { authCli } from '../src/server/auth/cli.js';
import type { Mailer } from '../src/server/auth/mailer.js';
import { STEP_UP_FAILURES } from '../src/server/auth/step-up.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { FakeOidc } from './fixtures/fake-oidc.js';
import { SoftAuthenticator } from './fixtures/soft-authenticator.js';
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
}

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

/** An app on Better Auth with a fresh database. */
async function brain(env: Record<string, string> = {}, mailer?: Mailer) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-access-policy-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const origin = env.APP_ORIGIN ?? ORIGIN;
    const fullEnv = {
        AUTH_PROVIDER: 'betterauth',
        APP_ORIGIN: origin,
        SESSION_SECRET: SECRET,
        AUTH_TRUST_PROXY: 'true',
        ...env,
    };
    const auth = authFromEnv(fullEnv, '127.0.0.1', {
        database: path,
        hasher: fastHasher,
        ...(mailer ? { mailer } : {}),
    });
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid' };
    const provider = auth.provider as BetterAuthProvider;
    // Better Auth opens the app's file by its path; the runtime shares it.
    const { app, platform, workspace, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: config.baseUrl },
        app: { config, origin: [origin], auth },
    });
    cleanups.push(async () => {
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    const call = async (
        jar: Jar,
        path: string,
        { body, ...init }: Omit<RequestInit, 'body'> & { body?: unknown } = {},
    ) =>
        jar.store(
            await app.request(path, {
                ...init,
                ...(body === undefined ? {} : { method: init.method ?? 'POST' }),
                headers: {
                    origin,
                    'x-forwarded-for': clientIp,
                    ...(body === undefined && !init.method ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
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
    /** An account, signed in with its password. */
    const person = async (email: string, role: 'admin' | 'member') => {
        await provider.createAccount({
            email,
            name: email.split('@')[0],
            role,
            password: PASSWORD,
        });
        const { jar, response } = await signIn(email);
        expect(response.status).toBe(200);
        return jar;
    };
    const session = async (jar: Jar) => (await (await call(jar, '/api/auth/session')).json()) as AuthSession;
    const view = async (jar: Jar) => (await (await call(jar, '/api/access-policy')).json()) as AccessPolicyView;
    /** A challenge for the change, then the proof `proof(challenge)` makes. */
    const change = async (
        jar: Jar,
        policy: Record<string, unknown>,
        proof: (challenge: StepUpChallenge) => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({
            password: PASSWORD,
        }),
        version?: number,
    ) => {
        const body = { policy, version: version ?? (await view(jar)).version };
        const challenge = (await (await call(jar, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
        return call(jar, '/api/access-policy', {
            method: 'PUT',
            body: {
                ...body,
                stepUp: { id: challenge.id, ...(await proof(challenge)) },
            },
        });
    };
    return {
        app,
        auth,
        provider,
        platform,
        workspace,
        path,
        env: fullEnv,
        call,
        signIn,
        person,
        session,
        view,
        change,
    };
}

/** Registers a passkey on the signed-in account; returns the authenticator. */
async function addPasskey(b: Awaited<ReturnType<typeof brain>>, jar: Jar) {
    const authenticator = new SoftAuthenticator(ORIGIN);
    const options = (await (await b.call(jar, '/api/auth/passkey/generate-register-options')).json()) as {
        challenge: string;
    };
    const registered = await b.call(jar, '/api/auth/passkey/verify-registration', {
        body: { response: authenticator.register(options), name: 'Laptop' },
    });
    expect(registered.status).toBe(200);
    return authenticator;
}

/** Signs in with the passkey in a new browser. */
async function passkeySignIn(b: Awaited<ReturnType<typeof brain>>, authenticator: SoftAuthenticator) {
    const jar = new Jar();
    const challenge = (await (await b.call(jar, '/api/auth/passkey/generate-authenticate-options')).json()) as {
        challenge: string;
    };
    const response = await b.call(jar, '/api/auth/passkey/verify-authentication', {
        body: { response: authenticator.authenticate(challenge) },
    });
    return { jar, response };
}

it('shows the environment as the ceiling and refuses anything beyond it', async () => {
    const b = await brain({
        AUTH_ALLOWED_EMAILS: 'a@example.com,b@example.com',
        AUTH_ALLOWED_DOMAINS: 'example.com',
        AUTH_ADMIN_EMAILS: 'boss@example.com',
    });
    const op = await b.person('op@example.com', 'admin');
    const view = await b.view(op);
    expect(view.signIn).toEqual({
        ceiling: {
            password: true,
            passkey: true,
            signInLink: false,
            emailLinks: false,
            openSignUp: false,
            providers: [],
            allowedEmails: ['a@example.com', 'b@example.com'],
            allowedDomains: ['example.com'],
            adminEmails: ['boss@example.com'],
        },
        inForce: {
            password: true,
            passkey: true,
            signInLink: false,
            emailLinks: false,
            openSignUp: false,
            providers: [],
            allowedEmails: ['a@example.com', 'b@example.com'],
            allowedDomains: ['example.com'],
            adminEmails: ['boss@example.com'],
        },
    });
    for (const policy of [
        { allowedEmails: ['c@example.com'] },
        { allowedDomains: ['evil.example'] },
        { adminEmails: ['op@example.com'] },
        { providers: ['logto'] },
        { openSignUp: true },
        { password: true },
    ]) {
        const refused = await b.call(op, '/api/access-policy/step-up', {
            body: { policy, version: 0 },
        });
        expect(refused.status).toBe(400);
    }
    // A row edited by hand to add an email: it still doesn't count.
    writeStoredPolicy(b.workspace.db, 0, { allowedEmails: ['b@example.com', 'mallory@evil.example'] }, 'test');
    expect((await b.view(op)).signIn?.inForce.allowedEmails).toEqual(['b@example.com']);
});

it('confirms with the password, once per challenge; a wrong one is audited, five lock step-up and tell every admin', async () => {
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com,b@example.com' });
    const op = await b.person('op@example.com', 'admin');
    await b.person('ada@example.com', 'admin');
    const notices = () =>
        b.workspace.db
            .prepare("SELECT userId, title FROM notifications WHERE trigger='access_policy' ORDER BY rowid")
            .all() as { userId: string; title: string }[];
    const policy = { allowedEmails: ['a@example.com'] };
    const challenge = (await (
        await b.call(op, '/api/access-policy/step-up', {
            body: { policy, version: 0 },
        })
    ).json()) as StepUpChallenge;
    expect(challenge.methods).toEqual(['password']);
    const wrong = await b.call(op, '/api/access-policy', {
        method: 'PUT',
        body: {
            policy,
            version: 0,
            stepUp: { id: challenge.id, password: 'nope-nope-nope' },
        },
    });
    expect(wrong.status).toBe(403);
    // That challenge is used up, even with the right password now.
    const again = await b.call(op, '/api/access-policy', {
        method: 'PUT',
        body: {
            policy,
            version: 0,
            stepUp: { id: challenge.id, password: PASSWORD },
        },
    });
    expect(again.status).toBe(403);
    const saved = await b.change(op, policy);
    expect(saved.status).toBe(200);
    const result = (await saved.json()) as AccessPolicySaved;
    expect(result.view.signIn?.inForce.allowedEmails).toEqual(['a@example.com']);
    expect(result.view.audit.map(({ action, stepUp }) => [action, stepUp])).toEqual([
        ['change', 'password'],
        ['step_up_failed', null],
    ]);
    // Every admin and operator got the notice, signed in since boot or not.
    expect(notices().map(({ title }) => title)).toEqual(['Access policy changed', 'Access policy changed']);

    // Four more wrong ones lock step-up (five in the window), and say so.
    let last: Response | undefined;
    for (let i = 1; i < STEP_UP_FAILURES; i++) {
        last = await b.change(op, { allowedEmails: [] }, () => ({
            password: 'still-wrong-password',
        }));
    }
    expect(last!.status).toBe(429);
    const locked = await b.change(op, { allowedEmails: [] });
    expect(locked.status).toBe(429);
    expect((await b.view(op)).audit[0]).toMatchObject({
        action: 'step_up_locked',
    });
    expect(
        notices()
            .slice(2)
            .map(({ title }) => title),
    ).toEqual(['Access policy: confirmations failing', 'Access policy: confirmations failing']);
    expect((await b.view(op)).version).toBe(1);
});

it('confirms with a passkey that signs this challenge, for this origin', async () => {
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com,b@example.com' });
    const op = await b.person('op@example.com', 'admin');
    const authenticator = await addPasskey(b, op);
    const policy = { allowedEmails: ['a@example.com'] };
    const body = { policy, version: 0 };
    const challenge = (await (await b.call(op, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
    expect(challenge.methods).toEqual(['password', 'passkey']);
    expect(challenge.passkey).toMatchObject({
        rpId: 'localhost',
        userVerification: 'required',
        allowCredentials: [{ id: Buffer.from(authenticator.credentialId).toString('base64url') }],
    });
    // Signed for another site: refused.
    const forged = await b.call(op, '/api/access-policy', {
        method: 'PUT',
        body: {
            ...body,
            stepUp: {
                id: challenge.id,
                passkey: authenticator.authenticate(challenge.passkey as { challenge: string }, 'https://evil.example'),
            },
        },
    });
    expect(forged.status).toBe(403);
    const saved = await b.change(op, policy, (next) => ({
        passkey: authenticator.authenticate(next.passkey as { challenge: string }),
    }));
    expect(saved.status).toBe(200);
    expect((await b.view(op)).audit[0]).toMatchObject({ stepUp: 'passkey' });
});

it('binds a challenge to its session and its change', async () => {
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com,b@example.com' });
    const op = await b.person('op@example.com', 'admin');
    const { jar: other } = await b.signIn('op@example.com');
    const body = { policy: { allowedEmails: ['a@example.com'] }, version: 0 };
    const challenge = (await (await b.call(op, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
    // The same operator's other session can't use it.
    const elsewhere = await b.call(other, '/api/access-policy', {
        method: 'PUT',
        body: { ...body, stepUp: { id: challenge.id, password: PASSWORD } },
    });
    expect(elsewhere.status).toBe(403);
    const second = (await (await b.call(op, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
    // Nor another change.
    const swapped = await b.call(op, '/api/access-policy', {
        method: 'PUT',
        body: {
            policy: { allowedEmails: [] },
            version: 0,
            stepUp: { id: second.id, password: PASSWORD },
        },
    });
    expect(swapped.status).toBe(403);
    // A mock-style confirmation is no proof here.
    const third = (await (await b.call(op, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
    const confirmed = await b.call(op, '/api/access-policy', {
        method: 'PUT',
        body: { ...body, stepUp: { id: third.id, confirm: true } },
    });
    expect(confirmed.status).toBe(403);
    expect((await b.view(op)).version).toBe(0);
});

it('is for admins only: members get 403 (CB-390: every admin, not an operator tier)', async () => {
    const b = await brain();
    await b.person('op@example.com', 'admin');
    const ada = await b.person('ada@example.com', 'admin');
    const bob = await b.person('bob@example.com', 'member');
    expect((await b.call(ada, '/api/access-policy')).status).toBe(200);
    for (const jar of [bob]) {
        expect((await b.call(jar, '/api/access-policy')).status).toBe(403);
        expect(
            (
                await b.call(jar, '/api/access-policy/step-up', {
                    body: { policy: { passkey: false }, version: 0 },
                })
            ).status,
        ).toBe(403);
        expect(
            (
                await b.call(jar, '/api/access-policy', {
                    method: 'PUT',
                    body: {
                        policy: { passkey: false },
                        version: 0,
                        stepUp: { id: 'x', password: PASSWORD },
                    },
                })
            ).status,
        ).toBe(403);
    }
});

it('refuses a change that would lock the admin making it out', async () => {
    const b = await brain();
    const op = await b.person('op@example.com', 'admin');
    const preview = (await (
        await b.call(op, '/api/access-policy/preview', {
            body: { policy: { password: false }, version: 0 },
        })
    ).json()) as AccessPolicyImpact;
    expect(preview.refusal).toMatch(/without a way to sign in/);
    const refused = await b.change(op, { password: false });
    expect(refused.status).toBe(400);
    expect((await b.change(op, { password: false, passkey: false })).status).toBe(400);
    // With a passkey, password sign-in can go: it signs this session out.
    await addPasskey(b, op);
    const ready = (await (
        await b.call(op, '/api/access-policy/preview', {
            body: { policy: { password: false }, version: 0 },
        })
    ).json()) as AccessPolicyImpact;
    expect(ready).toMatchObject({ refusal: null, signsYouOut: true });
    expect((await b.view(op)).version).toBe(0);
});

it('ends the sessions that no longer qualify, refuses the method at once, and checks every request', async () => {
    const b = await brain();
    const op = await b.person('op@example.com', 'admin');
    const authenticator = await addPasskey(b, op);
    const { jar: opPasskey, response } = await passkeySignIn(b, authenticator);
    expect(response.status).toBe(200);
    const bob = await b.person('bob@example.com', 'member');
    const preview = (await (
        await b.call(opPasskey, '/api/access-policy/preview', {
            body: { policy: { password: false }, version: 0 },
        })
    ).json()) as AccessPolicyImpact;
    expect(preview).toMatchObject({
        changes: ['Email and password: off'],
        refusal: null,
        // The operator's password session and Bob's.
        sessionsEnded: 2,
        withoutWayIn: [{ name: 'bob', email: 'bob@example.com' }],
        signsYouOut: false,
    });
    const saved = await b.change(opPasskey, { password: false }, (challenge) => ({
        passkey: authenticator.authenticate(challenge.passkey as { challenge: string }),
    }));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as AccessPolicySaved).impact.sessionsEnded).toBe(2);
    expect((await b.session(bob)).user).toBeNull();
    expect((await b.session(op)).user).toBeNull();
    const kept = await b.session(opPasskey);
    expect(kept.user?.role).toBe('admin');
    expect(kept.methods).toMatchObject({ password: false, passkey: true });
    // Password sign-in is refused, with a reason.
    const { response: refused } = await b.signIn('bob@example.com');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'METHOD_OFF' });
    expect((await b.view(opPasskey)).audit[0]).toMatchObject({
        action: 'change',
        sessionsEnded: 2,
    });

    // A session made by a method that is off by the time it is used (a
    // sign-in racing the change) is refused at its next request.
    const c = await brain();
    const op2 = await c.person('op@example.com', 'admin');
    await addPasskey(c, op2);
    const racer = await c.person('kim@example.com', 'member');
    expect((await c.session(racer)).user).not.toBeNull();
    writeStoredPolicy(c.workspace.db, 0, { password: false }, 'test');
    expect((await c.session(racer)).user).toBeNull();
});

it('takes the admin role from an email taken off AUTH_ADMIN_EMAILS at the next request', async () => {
    const b = await brain({ AUTH_ADMIN_EMAILS: 'dee@example.com' });
    const op = await b.person('op@example.com', 'admin');
    const dee = await b.person('dee@example.com', 'member');
    expect((await b.session(dee)).user?.role).toBe('admin');
    expect((await b.call(dee, '/api/accounts')).status).toBe(200);
    expect((await b.change(op, { adminEmails: [] })).status).toBe(200);
    expect((await b.session(dee)).user?.role).toBe('member');
    expect((await b.call(dee, '/api/accounts')).status).toBe(403);
    // An operator is never demoted by a list.
    expect((await b.session(op)).user?.role).toBe('admin');
});

it('turns sign-in links off: none is sent, and the sign-in screen stops offering them', async () => {
    const b = await brain();
    const op = await b.person('op@example.com', 'admin');
    const bob = await b.person('bob@example.com', 'member');
    const deliver = vi.fn(async () => {});
    b.provider.useSignInLinks([{ via: 'telegram', canDeliver: () => true, recipient: () => 'tg-1', deliver }]);
    expect((await b.session(bob)).methods?.signInLink).toBe(true);
    expect((await b.change(op, { signInLink: false })).status).toBe(200);
    expect((await b.session(bob)).methods?.signInLink).toBe(false);
    const asked = await b.call(new Jar(), '/api/auth/sign-in-link', {
        body: { email: 'bob@example.com' },
    });
    expect(asked.status).toBe(200);
    const account = b.provider.accounts().find((entry) => entry.email === 'bob@example.com')!;
    const sent = await b.call(op, `/api/accounts/${account.id}/sign-in-link`, {
        body: {},
    });
    expect(sent.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliver).not.toHaveBeenCalled();
});

it('has a break glass on the server: the CLI clears the saved policy, audited as cli', async () => {
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com' });
    const op = await b.person('op@example.com', 'admin');
    expect((await b.change(op, { allowedEmails: [] })).status).toBe(200);
    const lines: string[] = [];
    const env = {
        ...b.env,
        DATABASE_PATH: b.path,
        BACKUP_DIR: join(b.path, '..', 'backups'),
    };
    await authCli(['access-policy'], env, (line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/^Access policy: version 1, saved .* narrows allowedEmails\.$/);
    await authCli(['access-policy-reset'], env, (line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/^Cleared the saved access policy/);
    const view = await b.view(op);
    expect(view).toMatchObject({ version: 2, saved: {} });
    expect(view.signIn?.inForce.allowedEmails).toEqual(['a@example.com']);
    expect(view.audit[0]).toMatchObject({
        action: 'reset',
        actor: 'cli',
        stepUp: 'cli',
    });
});

/** How each of the account's sessions began, as stored. */
const methodsOf = (b: Awaited<ReturnType<typeof brain>>, email: string) =>
    (
        b.workspace.db
            .prepare(
                'SELECT s.signInMethod AS method FROM auth_session s JOIN auth_user u ON u.id = s.userId WHERE u.email = ? ORDER BY s.createdAt',
            )
            .all(email) as { method: string | null }[]
    ).map((row) => row.method);

it('counts confirmations before checking them, so a burst of guesses cannot outrun the lock', async () => {
    // Spied before Better Auth takes the hasher in.
    const verify = vi.spyOn(fastHasher, 'verify');
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com' });
    const op = await b.person('op@example.com', 'admin');
    verify.mockClear();
    const body = { policy: { allowedEmails: [] }, version: 0 };
    const challenges = await Promise.all(
        Array.from(
            { length: STEP_UP_FAILURES + 3 },
            async () => (await b.call(op, '/api/access-policy/step-up', { body })).json() as Promise<StepUpChallenge>,
        ),
    );
    const statuses = (
        await Promise.all(
            challenges.map((challenge) =>
                b.call(op, '/api/access-policy', {
                    method: 'PUT',
                    body: {
                        ...body,
                        stepUp: { id: challenge.id, password: 'a-wrong-guess-here' },
                    },
                }),
            ),
        )
    ).map((response) => response.status);
    // Five were checked; the rest were refused unchecked.
    expect(verify).toHaveBeenCalledTimes(STEP_UP_FAILURES);
    expect(statuses.filter((status) => status === 403)).toHaveLength(STEP_UP_FAILURES - 1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    // A new challenge says so and offers nothing to confirm with.
    const locked = (await (await b.call(op, '/api/access-policy/step-up', { body })).json()) as StepUpChallenge;
    expect(locked.methods).toEqual([]);
    expect(locked.reason).toMatch(/Too many failed confirmations/);
});

it('reads what it knows of a saved policy a newer version wrote', async () => {
    const b = await brain({ AUTH_ALLOWED_EMAILS: 'a@example.com,b@example.com' });
    const op = await b.person('op@example.com', 'admin');
    b.workspace.db
        .prepare('INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 7, ?, 1, ?)')
        .run(JSON.stringify({ allowedEmails: ['a@example.com'], futureKey: true }), 'later-version');
    const view = await b.view(op);
    expect(view).toMatchObject({ version: 7, unreadable: false });
    expect(view.signIn?.inForce.allowedEmails).toEqual(['a@example.com']);
});

it('records how each session began, and a password change keeps it', async () => {
    const b = await brain();
    const op = await b.person('op@example.com', 'admin');
    const authenticator = await addPasskey(b, op);
    const { jar } = await passkeySignIn(b, authenticator);
    expect(methodsOf(b, 'op@example.com')).toEqual(['password', 'passkey']);
    const changed = await b.call(jar, '/api/auth/change-password', {
        body: {
            currentPassword: PASSWORD,
            newPassword: 'another-horse-battery',
            revokeOtherSessions: true,
        },
    });
    expect(changed.status).toBe(200);
    // The passkey session's replacement is still a passkey session.
    expect(methodsOf(b, 'op@example.com')).toEqual(['passkey']);
    expect((await b.session(jar)).user?.role).toBe('admin');
});

it('ends a session with no recorded method, and makes none from a way in it does not know', async () => {
    const b = await brain();
    const op = await b.person('op@example.com', 'admin');
    const authenticator = await addPasskey(b, op);
    const { jar: opPasskey } = await passkeySignIn(b, authenticator);
    // Bob has a passkey too, so turning passwords off leaves him a way in.
    const bob = await b.person('bob@example.com', 'member');
    await addPasskey(b, bob);
    // His session from before CB-124: no method recorded.
    b.workspace.db
        .prepare(
            "UPDATE auth_session SET signInMethod = NULL WHERE userId = (SELECT id FROM auth_user WHERE email = 'bob@example.com')",
        )
        .run();
    expect(methodsOf(b, 'bob@example.com')).toEqual([null]);
    // Nothing says the policy allows it, so it is over at its next request.
    expect((await b.session(bob)).user).toBeNull();
    expect(methodsOf(b, 'bob@example.com')).toEqual([]);

    // One the previous release made after auth migration 7 ran (a password
    // change under way in a start-first upgrade): Better Auth's own
    // endpoints check no policy, so it ends before reaching them.
    const kim = await b.person('kim@example.com', 'member');
    b.workspace.db
        .prepare(
            "UPDATE auth_session SET signInMethod = NULL WHERE userId = (SELECT id FROM auth_user WHERE email = 'kim@example.com')",
        )
        .run();
    const changed = await b.call(kim, '/api/auth/change-password', {
        body: { currentPassword: PASSWORD, newPassword: 'another-horse-battery' },
    });
    expect(changed.status).toBe(401);
    expect(methodsOf(b, 'kim@example.com')).toEqual([]);
    expect((await b.signIn('kim@example.com')).response.status).toBe(200);

    // A session made outside every route the hook knows is refused.
    const context = (await b.provider.auth()).$context;
    const internal = (await context).internalAdapter;
    const opId = (
        b.workspace.db.prepare("SELECT id FROM auth_user WHERE email = 'op@example.com'").get() as { id: string }
    ).id;
    const before = methodsOf(b, 'op@example.com');
    await expect(internal.createSession(opId)).resolves.toBeFalsy();
    expect(methodsOf(b, 'op@example.com')).toEqual(before);
    expect(methodsOf(b, 'op@example.com')).not.toContain(null);
    expect((await b.session(opPasskey)).user?.role).toBe('admin');
});

it('ends a session with no recorded method before Better Auth reads it, over https too', async () => {
    const b = await brain({ APP_ORIGIN: 'https://localhost:4310' });
    const kim = await b.person('kim@example.com', 'member');
    expect(kim.has('__Host-cb.session_token')).toBe(true);
    b.workspace.db.prepare('UPDATE auth_session SET signInMethod = NULL').run();
    const changed = await b.call(kim, '/api/auth/change-password', {
        body: { currentPassword: PASSWORD, newPassword: 'another-horse-battery' },
    });
    expect(changed.status).toBe(401);
    expect(methodsOf(b, 'kim@example.com')).toEqual([]);
});

it('turns a sign-in provider off: its sessions end and its sign-ins are refused', async () => {
    const fake = await new FakeOidc().start();
    cleanups.push(() => fake.stop());
    const b = await brain({
        AUTH_OAUTH_PROVIDERS: 'logto',
        AUTH_OAUTH_LOGTO_ISSUER: fake.issuer,
        AUTH_OAUTH_LOGTO_CLIENT_ID: fake.clientId,
        AUTH_OAUTH_LOGTO_CLIENT_SECRET: fake.clientSecret,
        AUTH_OAUTH_LOGTO_NAME: 'Logto',
        AUTH_ALLOWED_DOMAINS: 'example.com',
    });
    const op = await b.person('op@example.com', 'admin');
    fake.claims = {
        name: 'Kim',
        email: 'kim@example.com',
        email_verified: true,
    };
    const viaLogto = async () => {
        const jar = new Jar();
        const start = await b.call(jar, '/api/auth/sign-in/social', {
            body: { provider: 'logto', callbackURL: '/', errorCallbackURL: '/' },
        });
        if (start.status !== 200) {
            return { jar, start };
        }
        const { url } = (await start.json()) as { url: string };
        const authorize = await fetch(url, { redirect: 'manual' });
        const back = new URL(authorize.headers.get('location')!);
        const response = jar.store(
            await b.app.request(`${ORIGIN}${back.pathname}${back.search}`, {
                headers: { cookie: jar.header, 'sec-fetch-site': 'cross-site' },
            }),
        );
        return { jar, start, response };
    };
    const kim = await viaLogto();
    expect((await b.session(kim.jar)).user?.name).toBe('Kim');
    expect(methodsOf(b, 'kim@example.com')).toEqual(['provider:logto']);
    const preview = (await (
        await b.call(op, '/api/access-policy/preview', {
            body: { policy: { providers: [] }, version: 0 },
        })
    ).json()) as AccessPolicyImpact;
    expect(preview).toMatchObject({
        changes: ['Sign-in providers: removed logto'],
        sessionsEnded: 1,
        withoutWayIn: [{ name: 'Kim', email: 'kim@example.com' }],
    });
    expect((await b.change(op, { providers: [] })).status).toBe(200);
    expect((await b.session(kim.jar)).user).toBeNull();
    expect((await b.session(op)).methods?.providers).toEqual([]);
    const again = await viaLogto();
    expect(again.start.status).toBe(403);
    // A callback already under way comes back to the sign-in screen.
    const callback = await b.app.request(`${ORIGIN}/api/auth/callback/logto?code=x&state=y`, {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/?error=METHOD_OFF`);
});

// CB-352: email links are a way in only once something delivers them.
it('offers email links where SMTP is set up (the email channel), never as a way in without it', async () => {
    const none = await brain();
    const noneOp = await none.person('op@example.com', 'admin');
    expect((await none.view(noneOp)).signIn?.ceiling.emailLinks).toBe(false);
    const refused = await none.call(noneOp, '/api/access-policy/preview', {
        body: { policy: { emailLinks: true }, version: 0 },
    });
    expect(JSON.stringify(await refused.json())).toContain('no email channel delivers sign-in links');
    // SMTP set up (no mail is sent here): the email channel is wired.
    const b = await brain({ SMTP_URL: 'smtp://mail.invalid:587', SMTP_FROM: 'Socio <socio@mail.invalid>' });
    const op = await b.person('op@example.com', 'admin');
    const view = await b.view(op);
    expect(view.signIn?.ceiling.emailLinks).toBe(true);
    // Email isn't the Telegram bot.
    expect(view.signIn?.ceiling.signInLink).toBe(false);
});

// CB-352: email as a sign-in channel.
describe('sign-in links by email', () => {
    type Mail = { to: string; subject: string; text: string };
    async function withEmail() {
        const mails: Mail[] = [];
        const b = await brain({}, { send: async (message) => void mails.push(message) });
        const telegram = vi.fn(async () => {});
        // Telegram reaches bob only.
        b.provider.useSignInLinks([
            {
                via: 'telegram',
                canDeliver: (userId) => userId === bobUser(),
                recipient: () => 'tg-bob',
                deliver: telegram,
            },
        ]);
        const op = await b.person('op@example.com', 'admin');
        const bob = await b.person('bob@example.com', 'member');
        // Kim has no password and no Telegram: email is her only way in.
        await b.provider.createAccount({ email: 'kim@example.com', name: 'Kim Lee', role: 'member' });
        const accountOf = (email: string) => b.provider.accounts().find((entry) => entry.email === email)!;
        const bobUser = () => accountOf('bob@example.com').userId;
        const ask = (email: string) =>
            b.call(new Jar(), '/api/auth/sign-in-link', {
                body: { email },
                headers: { 'x-forwarded-for': `10.4.${Math.floor(Math.random() * 250)}.${mails.length}` },
            });
        const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
        const tokenOf = (mail: Mail) => new URL(/https?:\/\/\S+/.exec(mail.text)![0]).searchParams.get('token')!;
        const use = (token: string, jar = new Jar()) =>
            b.call(
                jar,
                `/api/auth/magic-link/verify?${new URLSearchParams({ token, callbackURL: '/', errorCallbackURL: '/' })}`,
                {
                    headers: { 'sec-fetch-site': 'same-origin' },
                },
            );
        const methodOf = (email: string) =>
            (
                b.workspace.db
                    .prepare(
                        'SELECT s.signInMethod AS method FROM auth_session s JOIN auth_user u ON u.id = s.userId WHERE u.email = ? ORDER BY s.createdAt DESC',
                    )
                    .get(email) as { method: string } | undefined
            )?.method;
        return { ...b, mails, telegram, op, bob, ask, settle, tokenOf, use, methodOf, accountOf };
    }

    it('sends links by Telegram only while email links are off', async () => {
        const t = await withEmail();
        expect((await t.view(t.op)).signIn?.ceiling.emailLinks).toBe(true);
        expect((await t.ask('bob@example.com')).status).toBe(200);
        expect((await t.ask('kim@example.com')).status).toBe(200);
        await t.settle();
        expect(t.telegram).toHaveBeenCalledTimes(1);
        expect(t.mails).toEqual([]);
    });

    it('sends every account its link by email once on, signing in as link:email, with nothing but the address and the link', async () => {
        const t = await withEmail();
        expect((await t.change(t.op, { emailLinks: true })).status).toBe(200);
        expect((await t.session(new Jar())).methods?.signInLink).toBe(true);
        await t.ask('kim@example.com');
        await t.ask('bob@example.com');
        await vi.waitFor(() => expect(t.mails).toHaveLength(2));
        // Email first, even for bob, whom Telegram reaches.
        expect(t.telegram).not.toHaveBeenCalled();
        const [kim] = t.mails;
        expect(kim.to).toBe('kim@example.com');
        expect(kim.text).not.toContain('Kim Lee');
        expect(kim.text).toContain(`${ORIGIN}/sign-in-link?token=`);
        const jar = new Jar();
        expect((await t.use(t.tokenOf(kim), jar)).status).toBe(302);
        expect((await t.session(jar)).user?.name).toBe('Kim Lee');
        expect(t.methodOf('kim@example.com')).toBe('link:email');
        // The admin's "Send sign-in link" says email.
        const { accounts: people } = (await (await t.call(t.op, '/api/accounts')).json()) as {
            accounts: { email: string; signInLinkVia: string | null }[];
        };
        expect(people.find((person) => person.email === 'bob@example.com')?.signInLinkVia).toBe('email');
    });

    it('never lets an emailed link pass as a Telegram one: not on a previous version, nor with its prefix taken off', async () => {
        const t = await withEmail();
        expect((await t.change(t.op, { emailLinks: true })).status).toBe(200);
        await t.ask('bob@example.com');
        await vi.waitFor(() => expect(t.mails).toHaveLength(1));
        const token = t.tokenOf(t.mails[0]);
        expect(token.startsWith('e.')).toBe(true);
        // A previous version, without the envelope, straight into Better Auth:
        // neither the link as sent nor with its prefix taken off is a token it has.
        for (const given of [token, token.slice(2)]) {
            const old = await (
                await t.provider.auth()
            ).handler(
                new Request(
                    `${ORIGIN}/api/auth/magic-link/verify?${new URLSearchParams({ token: given, callbackURL: '/' })}`,
                ),
            );
            expect(old.headers.getSetCookie().join(';')).not.toMatch(/session_token=[^;]/);
        }
        // A tampered envelope gets nowhere either.
        const tampered = new Jar();
        await t.use(`${token.slice(0, -4)}AAAA`, tampered);
        expect((await t.session(tampered)).user).toBeNull();
        // This version with the prefix taken off.
        const stripped = new Jar();
        await t.use(token.slice(2), stripped);
        expect((await t.session(stripped)).user).toBeNull();
        // The link as sent still works, as link:email.
        const jar = new Jar();
        await t.use(token, jar);
        expect((await t.session(jar)).user?.name).toBe('bob');
        expect(t.methodOf('bob@example.com')).toBe('link:email');
    });

    it('lets an admin send a sign-in link by email with Telegram links off', async () => {
        const t = await withEmail();
        expect((await t.change(t.op, { emailLinks: true, signInLink: false })).status).toBe(200);
        const kim = t.accountOf('kim@example.com');
        const sent = await t.call(t.op, `/api/accounts/${kim.id}/sign-in-link`, { body: {} });
        expect(sent.status).toBe(200);
        expect(await sent.json()).toMatchObject({ via: 'email' });
        await vi.waitFor(() => expect(t.mails.map((mail) => mail.to)).toEqual(['kim@example.com']));
    });

    it('strands and signs out an account whose only way in was email when email links go off', async () => {
        const t = await withEmail();
        expect((await t.change(t.op, { emailLinks: true })).status).toBe(200);
        await t.ask('kim@example.com');
        await t.ask('kim@example.com');
        await vi.waitFor(() => expect(t.mails).toHaveLength(2));
        const jar = new Jar();
        await t.use(t.tokenOf(t.mails[0]), jar);
        expect((await t.session(jar)).user?.name).toBe('Kim Lee');
        const preview = (await (
            await t.call(t.op, '/api/access-policy/preview', {
                body: { policy: {}, version: (await t.view(t.op)).version },
            })
        ).json()) as AccessPolicyImpact;
        expect(preview.withoutWayIn).toEqual([{ name: 'Kim Lee', email: 'kim@example.com' }]);
        expect((await t.change(t.op, {})).status).toBe(200);
        expect((await t.session(jar)).user).toBeNull();
        // Her other emailed link no longer works, and no new one goes out.
        const late = await t.use(t.tokenOf(t.mails[1]));
        expect(new URL(late.headers.get('location')!, ORIGIN).searchParams.get('error')).toBeTruthy();
        await t.ask('kim@example.com');
        await t.settle();
        expect(t.mails).toHaveLength(2);
    });
});
