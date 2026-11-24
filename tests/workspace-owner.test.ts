import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { StepUpChallenge } from '@socio/shared/access-policy';
import type { Account } from '@socio/shared/auth';
import { LEAVE_WORKSPACE_PATH } from '@socio/shared/leave-workspace';

import type { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { authCli } from '../src/server/auth/cli.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-390: one admin
// tier and the workspace
// owner. Fake people only;
// no outside service is
// called.

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';

/** Cookies across requests, as a browser keeps them. */
class Jar {
    private cookies = new Map<string, string>();
    store(response: Response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const index = pair!.indexOf('=');
            const name = pair!.slice(0, index).trim();
            const value = pair!.slice(index + 1);
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

/**
 * An app on Better Auth: Ada (admin, made first), Olga (admin) and Bob
 * (member), then the boot step, which records the owner.
 */
async function brain(env: Record<string, string> = {}, prepare?: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-owner-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
            AUTH_OAUTH_PROVIDERS: '',
            ...env,
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const provider = auth.provider as BetterAuthProvider;
    const { app, workspace, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        app: { config: { mode: 'live', baseUrl: 'https://model.invalid' }, origin: [ORIGIN], auth },
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
                    origin: ORIGIN,
                    'x-forwarded-for': clientIp,
                    ...(body === undefined && !init.method ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
        );
    const signIn = async (email: string) => {
        const jar = new Jar();
        const response = await call(jar, '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
        expect(response.status).toBe(200);
        return jar;
    };
    await provider.createAccount({ email: 'ada@example.com', name: 'Ada', role: 'admin', password: PASSWORD });
    await provider.createAccount({ email: 'olga@example.com', name: 'Olga', role: 'admin', password: PASSWORD });
    await provider.createAccount({ email: 'bob@example.com', name: 'Bob', role: 'member', password: PASSWORD });
    prepare?.(path);
    const lines = await provider.start();
    const find = (email: string) => provider.accounts().find((account) => account.email === email)!;
    const db = new DatabaseSync(path);
    cleanups.push(() => db.close());
    return { app, provider, workspace, path, db, call, signIn, find, lines };
}

/** "Make owner": the step-up challenge, then the transfer with its proof. */
async function makeOwner(b: Awaited<ReturnType<typeof brain>>, jar: Jar, target: Account, confirmName = target.name) {
    const begin = await b.call(jar, `/api/accounts/${target.id}/owner/step-up`, { body: {} });
    if (begin.status !== 200) {
        return begin;
    }
    const challenge = (await begin.json()) as StepUpChallenge;
    return b.call(jar, `/api/accounts/${target.id}/owner`, {
        body: { confirmName, stepUp: { id: challenge.id, password: PASSWORD } },
    });
}

it('makes the first admin the owner as soon as there is one, audited, and lists who it is', async () => {
    const b = await brain();
    expect(b.find('ada@example.com').owner).toBe(true);
    expect(b.find('olga@example.com').owner).toBe(false);
    const ada = b.find('ada@example.com');
    expect(b.workspace.auditOf('workspace_owner', ada.userId).at(-1)?.detail).toMatch(/workspace owner: Ada/);
    const listed = (await (await b.call(await b.signIn('olga@example.com'), '/api/accounts')).json()) as {
        accounts: Account[];
    };
    expect(listed.accounts.filter((account) => account.owner).map((account) => account.email)).toEqual([
        'ada@example.com',
    ]);
    // A second boot changes nothing.
    expect(await b.provider.start()).toEqual([]);
});

it("keeps other admins off the owner's account, but lets them look and manage everyone else", async () => {
    const b = await brain();
    const olga = await b.signIn('olga@example.com');
    const ada = b.find('ada@example.com');
    const bob = b.find('bob@example.com');
    expect((await b.call(olga, `/api/accounts/${ada.id}`)).status).toBe(200);
    for (const [path, init] of [
        [`/api/accounts/${ada.id}`, { method: 'PATCH', body: { role: 'member' } }],
        [`/api/accounts/${ada.id}/deactivate`, { body: {} }],
        [`/api/accounts/${ada.id}`, { method: 'DELETE' }],
        [`/api/accounts/${ada.id}/password-link`, { body: {} }],
        [`/api/accounts/${ada.id}/sessions`, { method: 'DELETE' }],
        [`/api/accounts/${ada.id}/purge/step-up`, { body: {} }],
        [`/api/accounts/${ada.id}/purge`, { body: { apply: false } }],
        [`/api/accounts/${ada.id}/transfer`, { body: { to: bob.id } }],
    ] as const) {
        const response = await b.call(olga, path, init as never);
        expect(response.status, path).toBe(403);
        expect(((await response.json()) as { error: string }).error).toMatch(/workspace owner/);
    }
    expect(b.find('ada@example.com')).toMatchObject({ role: 'admin', deactivated: false, owner: true });
    // Admins manage every other account, other admins' included (no operator tier).
    expect((await b.call(olga, `/api/accounts/${bob.id}/password-link`, { body: {} })).status).toBe(200);
    const ada2 = await b.signIn('ada@example.com');
    const olgaAccount = b.find('olga@example.com');
    expect(
        (await b.call(ada2, `/api/accounts/${olgaAccount.id}`, { method: 'PATCH', body: { role: 'member' } })).status,
    ).toBe(200);
});

it("refuses the owner's own demotion, deactivation and leaving until they hand ownership over", async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const ada = b.find('ada@example.com');
    const demoted = await b.call(adaJar, `/api/accounts/${ada.id}`, { method: 'PATCH', body: { role: 'member' } });
    expect(demoted.status).toBe(400);
    expect(((await demoted.json()) as { error: string }).error).toMatch(/Make another admin the owner first/);
    expect((await b.call(adaJar, `/api/accounts/${ada.id}/deactivate`, { body: {} })).status).toBe(400);
    const check = (await (await b.call(adaJar, LEAVE_WORKSPACE_PATH)).json()) as {
        allowed: boolean;
        refusal: { code: string } | null;
    };
    expect(check).toMatchObject({ allowed: false, refusal: { code: 'owner' } });
    const left = await b.call(adaJar, LEAVE_WORKSPACE_PATH, { body: { confirm: 'leave' } });
    expect(left.status).toBe(409);
    expect(b.find('ada@example.com')).toMatchObject({ role: 'admin', deactivated: false, owner: true });
    // Another admin, not the owner, may leave: an admin remains.
    const olga = await b.signIn('olga@example.com');
    expect(((await (await b.call(olga, LEAVE_WORKSPACE_PATH)).json()) as { allowed: boolean }).allowed).toBe(true);
});

it('hands ownership over with Make owner: only the owner, only to an active admin, in person with a step-up', async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const olgaJar = await b.signIn('olga@example.com');
    const ada = b.find('ada@example.com');
    const olga = b.find('olga@example.com');
    const bob = b.find('bob@example.com');
    // Not the owner.
    expect((await makeOwner(b, olgaJar, olga)).status).toBe(403);
    // Not a member, and not themselves.
    expect((await makeOwner(b, adaJar, bob)).status).toBe(403);
    expect((await makeOwner(b, adaJar, ada)).status).toBe(403);
    // The name must match.
    expect((await makeOwner(b, adaJar, olga, 'olga')).status).toBe(400);
    const done = await makeOwner(b, adaJar, olga);
    expect(done.status).toBe(200);
    expect(((await done.json()) as Account).owner).toBe(true);
    expect(b.find('olga@example.com').owner).toBe(true);
    // The previous owner stays an admin, and is now an ordinary one.
    expect(b.find('ada@example.com')).toMatchObject({ role: 'admin', owner: false });
    expect(b.workspace.auditOf('workspace_owner', olga.userId).at(-1)).toMatchObject({
        action: 'transfer',
        actor: ada.userId,
        detail: 'workspace.owner.transferred: from Ada to Olga',
    });
    expect(
        (await b.call(olgaJar, `/api/accounts/${ada.id}`, { method: 'PATCH', body: { role: 'member' } })).status,
    ).toBe(200);
    // Ada, no longer the owner, can't take it back.
    expect((await makeOwner(b, adaJar, ada)).status).toBe(403);
});

it('passes ownership on when the shell deactivates the owner; the app never can', async () => {
    const b = await brain();
    const ada = b.find('ada@example.com');
    expect(b.provider.deactivationRefusal(ada)).toMatch(/workspace owner/);
    expect(b.provider.deactivationRefusal(ada, { shell: true })).toBeUndefined();
    await b.provider.deactivate(ada.id, 'cli');
    expect(b.find('ada@example.com')).toMatchObject({ deactivated: true, owner: false });
    expect(b.find('olga@example.com').owner).toBe(true);
    // The last admin still stays, from the shell too.
    expect(b.provider.deactivationRefusal(b.find('olga@example.com'), { shell: true })).toBe(
        'Keep at least one admin.',
    );
});

it('reads a stored operator as an admin, and lets flag rules for operators reach admins too', async () => {
    const b = await brain({}, (path) => {
        const db = new DatabaseSync(path);
        db.prepare(`UPDATE auth_user SET role = 'operator' WHERE email = 'olga@example.com'`).run();
        db.prepare(
            `INSERT INTO flag_rules(scope, scopeId, flag, enabled, roles, people, locked, optIn, updatedBy, updatedAt) VALUES ('tenant', 'default', 'smoke-flag', 0, '["operator"]', '[]', 0, 0, 'ada', 1)`,
        ).run();
        db.close();
    });
    // Stored as it was, so a previous release still serving keeps guarding
    // it; read as an admin here.
    expect(b.db.prepare(`SELECT role FROM auth_user WHERE email = 'olga@example.com'`).get()).toEqual({
        role: 'operator',
    });
    expect(b.find('olga@example.com').role).toBe('admin');
    const olga = await b.signIn('olga@example.com');
    expect((await b.call(olga, '/api/accounts')).status).toBe(200);
    expect(b.db.prepare(`SELECT roles FROM flag_rules WHERE flag = 'smoke-flag'`).get()).toEqual({
        roles: '["operator","admin"]',
    });
    expect(b.lines.join('\n')).toMatch(/name admins too/);
    // Idempotent.
    expect(await b.provider.start()).toEqual([]);
});

it('migrates a database with operators: admins, one audit line each, and the owner chosen deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-owner-migrate-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const db = new DatabaseSync(path);
    // As the previous release left it: version 15, operators, no owner.
    db.exec(`DROP TABLE auth_workspace_owner; DELETE FROM schema_migrations WHERE module = 'auth' AND version = 16;`);
    const insert = db.prepare(
        `INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId, role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    insert.run(
        'a-gone',
        'Gone',
        'gone@example.com',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        'gone',
        'operator',
        1,
    );
    insert.run(
        'a-op',
        'Olga',
        'olga@example.com',
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
        'olga',
        'operator',
        0,
    );
    insert.run(
        'a-ada',
        'Ada',
        'ada@example.com',
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
        'ada',
        'admin',
        0,
    );
    insert.run(
        'a-bob',
        'Bob',
        'bob@example.com',
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z',
        'bob',
        'member',
        0,
    );
    db.prepare(
        `INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES ('olga', 'Olga', 'operator', 1, 1)`,
    ).run();
    db.close();
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const after = new DatabaseSync(path);
    cleanups.push(() => after.close());
    // Stored values stay for the previous release (expand only).
    expect(after.prepare(`SELECT id, role FROM auth_user ORDER BY id`).all()).toEqual([
        { id: 'a-ada', role: 'admin' },
        { id: 'a-bob', role: 'member' },
        { id: 'a-gone', role: 'operator' },
        { id: 'a-op', role: 'operator' },
    ]);
    // The earliest-created active admin; the deactivated former operator is skipped.
    expect(after.prepare(`SELECT accountId FROM auth_workspace_owner`).all()).toEqual([{ accountId: 'a-op' }]);
    expect(
        after
            .prepare(
                `SELECT targetKind, targetId, detail FROM workspace_audit WHERE targetKind IN ('user', 'workspace_owner') ORDER BY id`,
            )
            .all(),
    ).toEqual([
        { targetKind: 'user', targetId: 'gone', detail: 'operator role retired; now admin' },
        { targetKind: 'user', targetId: 'olga', detail: 'operator role retired; now admin' },
        {
            targetKind: 'workspace_owner',
            targetId: 'olga',
            detail: 'workspace owner: the earliest-created active admin',
        },
    ]);
});

it('makes the first admin from AUTH_FIRST_ADMIN_EMAIL, reads the old name as an alias, and never while an admin exists', async () => {
    const make = async (env: Record<string, string>) => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-owner-first-'));
        const path = join(dir, 'brain.sqlite');
        migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
        const auth = authFromEnv(
            {
                AUTH_PROVIDER: 'betterauth',
                APP_ORIGIN: ORIGIN,
                SESSION_SECRET: SECRET,
                AUTH_OAUTH_PROVIDERS: '',
                ...env,
            },
            '127.0.0.1',
            { database: path, hasher: fastHasher },
        );
        const provider = auth.provider as BetterAuthProvider;
        cleanups.push(() => {
            provider.close();
            rmSync(dir, { recursive: true, force: true });
        });
        return { provider, warnings: auth.warnings };
    };
    const fresh = await make({ AUTH_FIRST_ADMIN_EMAIL: 'Fran@Example.com' });
    expect(fresh.warnings.join('\n')).not.toMatch(/AUTH_OPERATOR/);
    expect((await fresh.provider.start()).join('\n')).toMatch(
        /created the first admin's account \(AUTH_FIRST_ADMIN_EMAIL\)/,
    );
    expect(fresh.provider.accounts()).toMatchObject([{ email: 'fran@example.com', role: 'admin', owner: true }]);
    // The former name still works, with a warning.
    const alias = await make({ AUTH_OPERATOR_EMAIL: 'olga@example.com' });
    expect(alias.warnings.join('\n')).toMatch(/AUTH_OPERATOR_EMAIL renamed to AUTH_FIRST_ADMIN_EMAIL/);
    expect((await alias.provider.start()).join('\n')).toMatch(/\(AUTH_OPERATOR_EMAIL\)/);
    expect(alias.provider.accounts()).toMatchObject([{ email: 'olga@example.com', role: 'admin', owner: true }]);
    // The new name wins over the old.
    const both = await make({ AUTH_FIRST_ADMIN_EMAIL: 'fran@example.com', AUTH_OPERATOR_EMAIL: 'olga@example.com' });
    expect(both.warnings.join('\n')).toMatch(/ignored: AUTH_FIRST_ADMIN_\* is set/);
    await both.provider.start();
    expect(both.provider.accounts().map((account) => account.email)).toEqual(['fran@example.com']);
    // An admin exists already: nothing is made or promoted.
    const taken = await make({ AUTH_FIRST_ADMIN_EMAIL: 'bob@example.com' });
    await taken.provider.createAccount({ email: 'ada@example.com', name: 'Ada', role: 'admin', password: PASSWORD });
    await taken.provider.createAccount({ email: 'bob@example.com', name: 'Bob', role: 'member', password: PASSWORD });
    await taken.provider.start();
    expect(taken.provider.accounts().map((account) => [account.email, account.role, account.owner])).toEqual([
        ['ada@example.com', 'admin', true],
        ['bob@example.com', 'member', false],
    ]);
});

it('makes the first admin to appear after boot the owner at once, by any way in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-owner-late-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, AUTH_OAUTH_PROVIDERS: '' },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const provider = auth.provider as BetterAuthProvider;
    cleanups.push(() => {
        provider.close();
        rmSync(dir, { recursive: true, force: true });
    });
    expect(await provider.start()).toEqual([]);
    // A member first: no owner yet.
    await provider.createAccount({ email: 'bob@example.com', name: 'Bob', role: 'member', password: PASSWORD });
    expect(provider.ownerAccount()).toBeUndefined();
    // Bob promoted (as an admin by email rule or group would be): the owner now.
    const db = new DatabaseSync(path);
    cleanups.push(() => db.close());
    const context = await (await provider.auth()).$context;
    await context.internalAdapter.updateUser(provider.accounts()[0]!.id, { role: 'admin' });
    expect(provider.ownerAccount()?.email).toBe('bob@example.com');
    // A later admin doesn't take it.
    await provider.createAccount({ email: 'ada@example.com', name: 'Ada', role: 'admin', password: PASSWORD });
    expect(provider.ownerAccount()?.email).toBe('bob@example.com');
});

it('tells every admin in the app when the shell deactivates the owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-owner-cli-'));
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
    expect(await run('create-user', '--email', 'ada@example.com', '--name', 'Ada')).toMatch(/Created admin/);
    await run('create-user', '--email', 'olga@example.com', '--name', 'Olga');
    expect(await run('list')).toMatch(/ada@example.com\tadmin \(owner\)/);
    const out = await run('deactivate', '--email', 'ada@example.com');
    expect(out).toMatch(/Workspace owner: Olga/);
    expect(await run('list')).toMatch(/olga@example.com\tadmin \(owner\)/);
    const db = new DatabaseSync(env.DATABASE_PATH);
    cleanups.push(() => db.close());
    const notices = db.prepare(`SELECT title, body FROM notification_in_app`).all() as {
        title: string;
        body: string;
    }[];
    expect(notices).toEqual([
        { title: 'New workspace owner', body: 'Olga is now the workspace owner: Ada is no longer an active admin.' },
    ]);
});
