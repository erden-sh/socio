import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
    ceilingViolations,
    CODE_USERS_MOVED,
    codeUsersInForce,
    sessionAllowed,
    normalizePolicy,
    policyChanges,
    savedAccessPolicySchema,
    signInInForce,
    type AccessPolicyImpact,
    type AccessPolicyView,
    type SignInCeiling,
    type SignInInForce,
    type StepUpChallenge,
} from '@socio/shared/access-policy';
import type { User } from '@socio/shared/types';

import { appendPolicyAudit } from '../src/server/auth/access-policy-store.js';
import {
    assessSignIn,
    changeDigest,
    hasWayIn,
    type PolicyAccount,
    type PolicySession,
} from '../src/server/auth/access-policy.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { OPEN_PER_ACCOUNT, STEP_UP_SECONDS, StepUpChallenges } from '../src/server/auth/step-up.js';
import { mayRunCode } from '../src/server/gateway/code-users.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const CEILING: SignInCeiling = {
    password: true,
    passkey: true,
    signInLink: false,
    emailLinks: false,
    openSignUp: true,
    providers: [
        { id: 'logto', name: 'Logto' },
        { id: 'google', name: 'Google' },
    ],
    allowedEmails: ['a@example.com', 'b@example.com'],
    allowedDomains: ['example.com'],
    adminEmails: ['boss@example.com'],
};

it('keeps the environment a ceiling when a policy is read: a saved entry the variable lacks never counts', () => {
    expect(signInInForce(CEILING, {})).toEqual({
        password: true,
        passkey: true,
        signInLink: false,
        emailLinks: false,
        openSignUp: true,
        providers: ['logto', 'google'],
        allowedEmails: ['a@example.com', 'b@example.com'],
        allowedDomains: ['example.com'],
        adminEmails: ['boss@example.com'],
    });
    const narrowed = signInInForce(CEILING, {
        password: false,
        openSignUp: false,
        providers: ['google', 'github'],
        allowedEmails: ['b@example.com', 'mallory@evil.example'],
        allowedDomains: [],
    });
    expect(narrowed).toMatchObject({
        password: false,
        openSignUp: false,
        providers: ['google'],
        allowedEmails: ['b@example.com'],
        allowedDomains: [],
        adminEmails: ['boss@example.com'],
    });
    // A method the environment leaves off stays off, whatever is saved.
    expect(signInInForce({ ...CEILING, passkey: false }, { passkey: true } as never).passkey).toBe(false);
    expect(codeUsersInForce(['alice', 'carol'], {})).toEqual(['alice', 'carol']);
    expect(codeUsersInForce(['alice'], { codeUsers: ['alice', 'mallory'] })).toEqual(['alice']);
    expect(codeUsersInForce([], { codeUsers: ['mallory'] })).toEqual([]);
});

it('refuses to save anything beyond the environment, and normalizes what it saves', () => {
    expect(
        ceilingViolations(
            {
                allowedEmails: ['c@example.com'],
                providers: ['github'],
                codeUsers: ['mallory'],
            },
            { signIn: CEILING },
        ),
    ).toEqual([
        'Sign-in provider "github" is not in AUTH_OAUTH_PROVIDERS: the environment is the ceiling, so it can\'t be added here.',
        'Allowed email "c@example.com" is not in AUTH_ALLOWED_EMAILS: the environment is the ceiling, so it can\'t be added here.',
        // Who may run code is a permission now (CB-376): never saved here.
        CODE_USERS_MOVED,
    ]);
    // Mock auth has no sign-in ceiling: no sign-in key may be saved.
    expect(ceilingViolations({ password: false }, { signIn: null })).toHaveLength(1);
    expect(ceilingViolations({ codeUsers: [] }, { signIn: null })).toEqual([CODE_USERS_MOVED]);
    expect(
        normalizePolicy({
            allowedEmails: [' B@Example.com', 'a@example.com', 'b@example.com'],
            allowedDomains: ['@Example.com'],
        }),
    ).toEqual({
        allowedEmails: ['a@example.com', 'b@example.com'],
        allowedDomains: ['example.com'],
    });
    // One digest per change: the same policy written differently, the same.
    expect(changeDigest({ providers: ['b', 'a'] }, 3)).toBe(changeDigest({ providers: ['a', 'b', 'a'] }, 3));
    expect(changeDigest({ providers: ['a'] }, 3)).not.toBe(changeDigest({ providers: ['a'] }, 4));
    expect(
        policyChanges(
            { signIn: signInInForce(CEILING, {}) },
            {
                signIn: signInInForce(CEILING, {
                    passkey: false,
                    providers: ['logto'],
                }),
            },
        ),
    ).toEqual(['Passkeys: off', 'Sign-in providers: removed google']);
});

it('ends sessions only for what the policy turned off, not for what the environment lacks', () => {
    const saved = { passkey: false as const, providers: ['logto'] };
    expect(sessionAllowed('password', saved)).toBe(true);
    expect(sessionAllowed('passkey', saved)).toBe(false);
    // No bot this boot: link sessions go on unless links were turned off.
    expect(sessionAllowed('link', saved)).toBe(true);
    expect(sessionAllowed('link', { signInLink: false })).toBe(false);
    expect(sessionAllowed('provider:logto', saved)).toBe(true);
    expect(sessionAllowed('provider:google', saved)).toBe(false);
    expect(sessionAllowed('provider:google', {})).toBe(true);
    // No method recorded, or one this build doesn't know: nothing says the
    // policy allows it, so it ends (fails closed), whatever the policy.
    expect(sessionAllowed(null, saved)).toBe(false);
    expect(sessionAllowed(undefined, {})).toBe(false);
    expect(sessionAllowed(null, {})).toBe(false);
    expect(sessionAllowed('', {})).toBe(false);
    expect(sessionAllowed('provider:', {})).toBe(false);
    expect(sessionAllowed('device', {})).toBe(false);
});

const account = (id: string, rest: Partial<PolicyAccount> = {}): PolicyAccount => ({
    id,
    appUserId: id,
    name: id,
    email: `${id}@example.com`,
    role: 'member',
    deactivated: false,
    password: false,
    passkeys: 0,
    providers: [],
    linkReachable: false,
    ...rest,
});
const later = Date.now() + 60_000;
const session = (id: string, accountId: string, method: string | null): PolicySession => ({
    id,
    accountId,
    method,
    expiresAt: later,
});

it('refuses a change that would lock out the admin making it, every admin, or the workspace owner', () => {
    const before = signInInForce(CEILING, {});
    const assess = (after: SignInInForce, accounts: PolicyAccount[]) =>
        assessSignIn({
            before,
            after,
            saved: {},
            accounts,
            sessions: [],
            actor: { sessionId: 's-op', accountId: 'op' },
        });
    const op = account('op', { role: 'admin', password: true });
    // No way to sign in at all.
    expect(
        assess(signInInForce({ ...CEILING, signInLink: false }, { password: false, passkey: false, providers: [] }), [
            op,
        ]).refusal,
    ).toBe('Keep at least one way to sign in on.');
    // The admin's only method.
    expect(assess(signInInForce(CEILING, { password: false }), [op]).refusal).toMatch(/without a way to sign in/);
    // They keep a provider, but then no admin could confirm a change.
    const linked = account('op', {
        role: 'admin',
        password: true,
        providers: ['logto'],
    });
    expect(assess(signInInForce(CEILING, { password: false }), [linked]).refusal).toMatch(
        /no admin could confirm a change/,
    );
    // With a passkey they can.
    expect(assess(signInInForce(CEILING, { password: false }), [{ ...linked, passkeys: 1 }]).refusal).toBeNull();
    // A deactivated admin doesn't count as the one who could.
    expect(
        assess(signInInForce(CEILING, { password: false }), [
            linked,
            account('other', { role: 'admin', passkeys: 1, deactivated: true }),
        ]).refusal,
    ).toMatch(/no admin could confirm/);
    // An admin by email rule, with a password, can confirm (CB-390: the
    // role in force, not only the stored one).
    const byRule = account('rule', { password: true, passkeys: 1, emailVerified: true });
    expect(
        assess(signInInForce({ ...CEILING, adminEmails: ['rule@example.com'] }, { passkey: false }), [
            { ...linked, password: false, providers: ['logto'] },
            byRule,
        ]).refusal,
    ).toBeNull();
    // Unconfirmed, the rule doesn't count.
    expect(
        assess(signInInForce({ ...CEILING, adminEmails: ['rule@example.com'] }, { passkey: false }), [
            { ...linked, password: false, providers: ['logto'] },
            { ...byRule, emailVerified: false },
        ]).refusal,
    ).toMatch(/no admin could confirm/);
    // CB-390: another admin can't take the workspace owner's only way in...
    const owner = account('own', { role: 'admin', password: true, owner: true });
    const keeper = { ...linked, passkeys: 1 };
    expect(assess(signInInForce(CEILING, { password: false }), [keeper, owner]).refusal).toMatch(
        /workspace owner without a way to sign in/,
    );
    // ...but a member's they can, and the owner may give up their own.
    expect(
        assess(signInInForce(CEILING, { password: false }), [keeper, { ...owner, owner: false, role: 'member' }])
            .refusal,
    ).toBeNull();
    expect(
        assessSignIn({
            before,
            after: signInInForce(CEILING, { password: false }),
            saved: {},
            accounts: [keeper, { ...owner, providers: ['logto'] }],
            sessions: [],
            actor: { sessionId: 's-own', accountId: 'own' },
        }).refusal,
    ).toBeNull();
});

it('ends the sessions of a method turned off, and of accounts left with no way in', () => {
    const before = signInInForce(CEILING, {});
    const after = signInInForce(CEILING, { password: false });
    const accounts = [
        account('op', { role: 'admin', password: true, passkeys: 1 }),
        account('bob', { password: true }),
        account('kim', { providers: ['logto'], password: true }),
        // An invite not accepted yet: it had no way in, and loses nothing.
        account('new'),
    ];
    const result = assessSignIn({
        before,
        after,
        saved: { password: false },
        accounts,
        sessions: [
            session('s-op-password', 'op', 'password'),
            session('s-op-passkey', 'op', 'passkey'),
            // No method recorded (from before CB-124): these end whatever
            // way in the account still has, kim's included.
            session('s-bob-old', 'bob', null),
            session('s-kim-old', 'kim', null),
            session('s-kim-logto', 'kim', 'provider:logto'),
            { ...session('s-expired', 'bob', 'password'), expiresAt: 1 },
        ],
        actor: { sessionId: 's-op-password', accountId: 'op' },
    });
    expect(result.refusal).toBeNull();
    expect(result.revoke).toEqual(['s-op-password', 's-bob-old', 's-kim-old']);
    expect(result.withoutWayIn.map((entry) => entry.id)).toEqual(['bob']);
    expect(result.signsYouOut).toBe(true);
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'carol', name: 'Carol', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

/** An app on mock auth (loopback development), with `CODE_USERS` (deprecated, CB-376). */
async function fixture(codeUsers = ['alice', 'carol']) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            codeUsers: codeUsers,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    await platform.start();
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    await platform.board.issues.create({ title: 'Fix the import', body: '' }, 'bob');
    return { app, platform, workspace, as };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('is for admins, in their own session: members and API keys get 403 (CB-390)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const carol = await f.as('carol');
    const bob = await f.as('bob');
    const body = { policy: {}, version: 0 };
    // Another admin reads it like the first (CB-390: no operator tier).
    expect((await carol('/access-policy')).status).toBe(200);
    for (const call of [bob]) {
        expect((await call('/access-policy')).status).toBe(403);
        expect((await call('/access-policy/preview', 'POST', body)).status).toBe(403);
        expect((await call('/access-policy/step-up', 'POST', body)).status).toBe(403);
        expect(
            (
                await call('/access-policy', 'PUT', {
                    ...body,
                    stepUp: { id: 'x', confirm: true },
                })
            ).status,
        ).toBe(403);
    }
    // A service account's key (with every scope) can't reach it either.
    const made = await json<{ id: string }>(alice('/service-accounts', 'POST', { name: 'Bot', role: 'admin' }));
    const created = await json<{ token: string }>(
        alice(`/service-accounts/${made.id}/keys`, 'POST', {
            name: 'k',
            scopes: ['issues:read', 'issues:write', 'pages:read'],
            days: 30,
        }),
    );
    const { token } = created;
    const keyed = await f.app.request('/api/access-policy', {
        headers: { authorization: `Bearer ${token}` },
    });
    expect(keyed.status).toBe(403);
    const view = await json<AccessPolicyView>(alice('/access-policy'));
    expect(view).toMatchObject({
        version: 0,
        signIn: null,
        audit: [],
    });
    expect(view).not.toHaveProperty('code');
});

it('uses a mock confirmation once, even for a change it refuses', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    // Mock auth has nothing to narrow: the only policy is the empty one.
    const body = { policy: {}, version: 0 };
    const challenge = await json<StepUpChallenge>(alice('/access-policy/step-up', 'POST', body));
    expect(challenge.methods).toEqual(['confirm']);
    // Without a proof, nothing is saved.
    expect((await alice('/access-policy', 'PUT', body)).status).toBe(400);
    const refused = await alice('/access-policy', 'PUT', { ...body, stepUp: { id: challenge.id, confirm: true } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('Nothing to save: this is the policy in force.');
    // ...and that try used it up.
    const used = await alice('/access-policy', 'PUT', { ...body, stepUp: { id: challenge.id, confirm: true } });
    expect(used.status).toBe(403);
    expect((await used.json()).error).toMatch(/expired or was already used/);
    expect((await json<AccessPolicyView>(alice('/access-policy'))).version).toBe(0);
});

it('refuses code access (now a permission, CB-376) and sign-in methods under mock auth', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    for (const policy of [
        { codeUsers: ['alice'] },
        { codeUsers: [] },
        { password: false },
        { password: true },
        { surprise: 1 },
    ]) {
        const response = await alice('/access-policy/step-up', 'POST', {
            policy,
            version: 0,
        });
        expect(response.status).toBe(400);
    }
    const moved = await alice('/access-policy/preview', 'POST', { policy: { codeUsers: ['alice'] }, version: 0 });
    expect(await moved.json()).toMatchObject({ error: CODE_USERS_MOVED });
    // Saving what is saved already is refused: there is nothing to confirm.
    const same = await json<AccessPolicyImpact>(alice('/access-policy/preview', 'POST', { policy: {}, version: 0 }));
    expect(same.refusal).toBe('Nothing to save: this is the policy in force.');
    expect(same.codeRunsStopped).toBe(0);
});

it('leaves code access to the permission: mock auth lets admins run code, and nobody else', async () => {
    // CODE_USERS lists Bob; under mock auth only admins may run code.
    const f = await fixture(['bob']);
    expect(await mayRunCode(f.platform, 'alice')).toBe(true);
    expect(await mayRunCode(f.platform, 'carol')).toBe(true);
    expect(await mayRunCode(f.platform, 'bob')).toBe(false);
    expect(await mayRunCode(f.platform, 'nobody')).toBe(false);
});

it('keeps its audit append-only', async () => {
    const f = await fixture();
    appendPolicyAudit(f.workspace.db, { actor: 'alice', action: 'reset', detail: 'Back to the environment.' });
    expect(() => f.workspace.db.exec("UPDATE access_policy_audit SET detail = 'nothing'")).toThrow(/append-only/);
    expect(() => f.workspace.db.exec('DELETE FROM access_policy_audit')).toThrow(/append-only/);
});

/** Every file under a directory, recursively. */
function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

it('gives socios and connected agents no tool for the access policy', () => {
    // Only the routes, the app's composition (composition/http/auth.ts mounts
    // them, composition/lifecycle/auth.ts logs the policy at boot), the
    // platform's code list (code-users.ts), the auth provider and its CLI
    // touch it: no tool or MCP module does.
    const allowed = new Set([
        'src/server/auth/access-policy.ts',
        'src/server/auth/access-policy-routes.ts',
        'src/server/composition/http/auth.ts',
        'src/server/platform.ts',
        'src/server/gateway/code-users.ts',
        'src/server/composition/lifecycle/auth.ts',
        'src/server/auth/access-policy-store.ts',
        'src/server/auth/better-auth.ts',
        'src/server/auth/cli.ts',
        'src/server/auth/step-up.ts',
        'src/server/auth/schema.ts',
        // The types types.ts, step-up.ts and access-policy-store.ts held.
        'src/server/auth/contract.ts',
        // The AccessPolicyReader tag's implementation, over readStoredPolicy.
        'src/server/auth/layer.ts',
        // The gateways' sources: the reader for Platform's own constructor, and
        // AccessPolicyReaderLive at the gateways' step.
        'src/server/composition/gateway.ts',
        // The purge's reference map: who last changed the policy is history it keeps.
        'src/server/purge/references.ts',
        // CB-360: admins' person page reads a person's policy changes into their trail.
        'src/server/auth/accounts.ts',
        // CB-352: the sign-in sheet checks the approving session's method against it.
        'src/server/auth/device-sign-in.ts',
    ]);
    const root = join(import.meta.dirname, '..');
    const touching = ['src/server', 'packages/foundation/src', 'packages/data/src']
        .flatMap((dir) => files(join(root, dir)))
        .filter((path) => path.endsWith('.ts'))
        .filter((path) => /access-policy|access_policy/.test(readFileSync(path, 'utf8')))
        .map((path) => path.slice(root.length + 1));
    expect(touching.filter((path) => !allowed.has(path))).toEqual([]);
});

it('keeps step-up challenges few, short-lived and single-use', () => {
    const challenges = new StepUpChallenges();
    const session = { sessionId: 's1', accountId: 'a1' };
    const expected = { session, userId: 'alice', digest: 'd' };
    const made = Array.from(
        { length: OPEN_PER_ACCOUNT + 2 },
        () => challenges.create({ session, userId: 'alice', digest: 'd' }, 1_000).id,
    );
    // The oldest went first.
    expect(challenges.take(made[0], expected, 1_000)).toBeUndefined();
    expect(challenges.take(made[1], expected, 1_000)).toBeUndefined();
    expect(challenges.take(made.at(-1)!, expected, 1_000)).toBeDefined();
    expect(challenges.take(made.at(-1)!, expected, 1_000)).toBeUndefined();
    // Five minutes, then gone.
    const late = challenges.create({ session, userId: 'alice', digest: 'd' }, 0);
    expect(challenges.take(late.id, expected, STEP_UP_SECONDS * 1000 + 1)).toBeUndefined();
});

// CB-352: sign-in links by email, the first opt-in key.
it('keeps sign-in links by email off unless saved on, and only while email is set up', () => {
    const smtp = { ...CEILING, emailLinks: true };
    expect(signInInForce(CEILING, {}).emailLinks).toBe(false);
    expect(signInInForce(smtp, {}).emailLinks).toBe(false);
    expect(signInInForce(smtp, { emailLinks: true }).emailLinks).toBe(true);
    // Saved on, then SMTP taken away: off.
    expect(signInInForce(CEILING, { emailLinks: true }).emailLinks).toBe(false);
    expect(ceilingViolations({ emailLinks: true }, { signIn: CEILING })).toEqual([
        "Sign-in links by email: no email channel delivers sign-in links on this server (it needs SMTP_URL), so it can't be turned on.",
    ]);
    expect(ceilingViolations({ emailLinks: true }, { signIn: smtp })).toEqual([]);
    expect(ceilingViolations({ emailLinks: true }, { signIn: null })).toHaveLength(1);
    // Only `true` can be saved; `false` is what absent means.
    expect(savedAccessPolicySchema.safeParse({ emailLinks: true }).success).toBe(true);
    expect(savedAccessPolicySchema.safeParse({ emailLinks: false }).success).toBe(false);
    expect(normalizePolicy({ emailLinks: true, passkey: false })).toEqual({ passkey: false, emailLinks: true });
});

it('ends email link sessions when email links go off, and only those', () => {
    expect(sessionAllowed('link:email', {})).toBe(false);
    expect(sessionAllowed('link:email', { emailLinks: true })).toBe(true);
    expect(sessionAllowed('link', { emailLinks: true, signInLink: false })).toBe(false);
    expect(sessionAllowed('link', {})).toBe(true);
});

it('counts email as a way in for every account while it is on, and words the change', () => {
    const smtp = { ...CEILING, emailLinks: true };
    const nothingElse = account('only-email');
    expect(hasWayIn(nothingElse, signInInForce(smtp, { emailLinks: true }))).toBe(true);
    expect(hasWayIn(nothingElse, signInInForce(smtp, {}))).toBe(false);
    expect(
        policyChanges({ signIn: signInInForce(smtp, {}) }, { signIn: signInInForce(smtp, { emailLinks: true }) }),
    ).toEqual(['Sign-in links by email: on']);
});

it('binds a step-up to email links being turned on', () => {
    expect(changeDigest({ emailLinks: true }, 3)).not.toBe(changeDigest({}, 3));
});
