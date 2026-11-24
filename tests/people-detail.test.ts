import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { Account } from '@socio/shared/auth';
import type { PersonDetail, PersonTrail } from '@socio/shared/people';
import type { ServiceAccountView } from '@socio/shared/service-accounts';

import { parseTrailBefore } from '../src/server/auth/accounts.js';
import type { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-360: the person page's server. Admins read one person's
// detail and audit trail, sign out one device, and remove revoked
// service keys for good. Fake people only; no outside service is called.

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

/** An app on Better Auth with a fresh database: Ada (admin), Bob (member), Olga (admin). */
async function brain() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-people-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
            AUTH_OAUTH_PROVIDERS: '',
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const provider = auth.provider as BetterAuthProvider;
    const { app, platform, workspace, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        beforeApp: ({ workspace }) => {
            workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
            workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
        },
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
        { body, userAgent, ...init }: Omit<RequestInit, 'body'> & { body?: unknown; userAgent?: string } = {},
    ) =>
        jar.store(
            await app.request(path, {
                ...init,
                ...(body === undefined ? {} : { method: init.method ?? 'POST' }),
                headers: {
                    origin: ORIGIN,
                    'x-forwarded-for': clientIp,
                    ...(userAgent ? { 'user-agent': userAgent } : {}),
                    ...(body === undefined && !init.method ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...(init.headers as Record<string, string> | undefined),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
        );
    const signIn = async (email: string, userAgent?: string) => {
        const jar = new Jar();
        const response = await call(jar, '/api/auth/sign-in/email', { body: { email, password: PASSWORD }, userAgent });
        expect(response.status).toBe(200);
        return jar;
    };
    await provider.createAccount({ email: 'ada@example.com', name: 'Ada', role: 'admin', password: PASSWORD });
    await provider.createAccount({
        email: 'bob@example.com',
        name: 'Bob',
        role: 'member',
        userId: 'bob',
        password: PASSWORD,
    });
    await provider.createAccount({ email: 'olga@example.com', name: 'Olga', role: 'admin', password: PASSWORD });
    const accounts = provider.accounts();
    const find = (email: string) => accounts.find((account) => account.email === email)!;
    return {
        provider,
        platform,
        workspace,
        path,
        call,
        signIn,
        ada: find('ada@example.com'),
        bob: find('bob@example.com'),
        olga: find('olga@example.com'),
    };
}

it("shows admins one person's detail: roster fields, devices, sign-in and reach, never a secret", async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const bobLaptop = await b.signIn('bob@example.com', 'Laptop browser');
    await b.signIn('bob@example.com', 'Phone browser');
    // Bob's reach: an open Space with a member row, a members-only one, a
    // plain open one, a key he made, a connected agent and a Telegram link.
    const team = b.workspace.createSpace('Team', '');
    const secret = b.workspace.createSpace('Secret', '');
    const open = b.workspace.createSpace('Open', '');
    await b.workspace.spaceAccess.setRole(team.id, 'alice', 'bob', 'member');
    await b.workspace.spaceAccess.setRole(secret.id, 'alice', 'bob', 'editor');
    const db = new DatabaseSync(b.path);
    db.prepare('INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES (?, 1, ?, ?)').run(
        secret.id,
        'alice',
        Date.now(),
    );
    db.prepare('INSERT INTO telegram_links(telegramUserId, userId, username, linkedAt) VALUES (?, ?, ?, ?)').run(
        '4242',
        'bob',
        'bob_tg',
        1_700_000_000_000,
    );
    const ci = b.platform.serviceAccounts.create({ name: 'CI', role: 'member' }, 'bob');
    const made = b.platform.serviceAccounts.createKey(
        ci.id,
        { name: 'deploys', scopes: ['issues:read'], days: 30 },
        'bob',
    );
    b.platform.agentGrants.create({
        userId: 'bob',
        authUserId: b.bob.id,
        clientId: 'https://agent.example/client-metadata',
        clientName: 'Example Agent',
        clientDomain: 'agent.example',
        label: 'Example Agent on a laptop',
        scopes: ['issues:read'],
        resource: `${ORIGIN}/mcp`,
        redirectUri: 'http://localhost:3000/callback',
    });

    const response = await b.call(adaJar, `/api/accounts/${b.bob.id}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const detail = JSON.parse(text) as PersonDetail;
    expect(detail.person).toMatchObject({
        id: b.bob.id,
        userId: 'bob',
        name: 'Bob',
        email: 'bob@example.com',
        role: 'member',
        status: 'active',
        sessions: 2,
        reach: { keysMade: 1, connectedAgents: 1, telegram: true, codeAccess: false },
    });
    expect(detail.signIn).toMatchObject({ password: true, passkeys: [], providers: [] });
    expect(detail.signIn.sessions.map((session) => session.userAgent).sort()).toEqual([
        'Laptop browser',
        'Phone browser',
    ]);
    for (const session of detail.signIn.sessions) {
        expect(Object.keys(session).sort()).toEqual(
            ['createdAt', 'expiresAt', 'id', 'ip', 'renewedAt', 'signInMethod', 'userAgent'].sort(),
        );
        expect(session.signInMethod).toBe('password');
        expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    }
    const access = detail.access!;
    const level = (id: string) => access.spaces.find((space) => space.id === id);
    expect(level(team.id)).toEqual({ id: team.id, name: 'Team', level: 'member', membersOnly: false });
    expect(level(secret.id)).toEqual({ id: secret.id, name: 'Secret', level: 'editor', membersOnly: true });
    expect(level(open.id)).toEqual({ id: open.id, name: 'Open', level: 'everyone', membersOnly: false });
    expect(access.keysMade).toEqual([
        {
            keyId: made.key.id,
            name: 'deploys',
            hint: made.key.hint,
            accountId: ci.id,
            account: 'CI',
            createdAt: made.key.createdAt,
            expiresAt: made.key.expiresAt,
            lastUsedAt: null,
            revokedAt: null,
        },
    ]);
    expect(access.connectedAgents).toEqual([
        expect.objectContaining({
            clientName: 'Example Agent',
            scopes: ['issues:read'],
            createdAt: expect.any(Number),
        }),
    ]);
    expect(access).toMatchObject({
        socioGrants: [],
        appsOwned: [],
        codeAccess: false,
        telegram: { username: 'bob_tg', linkedAt: 1_700_000_000_000 },
    });

    // No session token, key hash or full key anywhere in it.
    const tokens = db.prepare('SELECT token FROM auth_session').all() as { token: string }[];
    const hashes = db.prepare('SELECT hash FROM service_keys').all() as { hash: string }[];
    db.close();
    for (const value of [...tokens.map((row) => row.token), ...hashes.map((row) => row.hash), made.token]) {
        expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/"(token|hash|password_hash|secret)"/);

    // Members get nothing; admins see every account, other admins' too (CB-390).
    expect((await b.call(bobLaptop, `/api/accounts/${b.bob.id}`)).status).toBe(403);
    expect((await b.call(adaJar, `/api/accounts/${b.olga.id}`)).status).toBe(200);
    expect((await b.call(adaJar, '/api/accounts/nobody')).status).toBe(404);
    const olgaJar = await b.signIn('olga@example.com');
    const olga = (await (await b.call(olgaJar, `/api/accounts/${b.olga.id}`)).json()) as PersonDetail;
    expect(olga.person).toMatchObject({ id: b.olga.id, role: 'admin' });
    // The roster route still answers as before.
    expect((await b.call(adaJar, '/api/accounts/roster')).status).toBe(200);
});

it('signs out one device of a person, audited, and leaves the others signed in', async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const laptop = await b.signIn('bob@example.com', 'Laptop browser');
    const phone = await b.signIn('bob@example.com', 'Phone browser');
    const olgaJar = await b.signIn('olga@example.com');
    const detail = (await (await b.call(adaJar, `/api/accounts/${b.bob.id}`)).json()) as PersonDetail;
    const laptopSession = detail.signIn.sessions.find((session) => session.userAgent === 'Laptop browser')!;
    const adasSession = ((await (await b.call(adaJar, `/api/accounts/${b.ada.id}`)).json()) as PersonDetail).signIn
        .sessions[0]!;
    const olgasSession = ((await (await b.call(olgaJar, `/api/accounts/${b.olga.id}`)).json()) as PersonDetail).signIn
        .sessions[0]!;

    // Members can't; another person's session is not found under Bob; an
    // admin can't touch the workspace owner's (CB-390).
    const owner = new DatabaseSync(b.path);
    owner.prepare('UPDATE auth_workspace_owner SET accountId = ? WHERE id = 1').run(b.olga.id);
    owner.close();
    expect(
        (await b.call(laptop, `/api/accounts/${b.bob.id}/sessions/${laptopSession.id}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect(
        (await b.call(adaJar, `/api/accounts/${b.bob.id}/sessions/${adasSession.id}`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect((await b.call(adaJar, `/api/accounts/${b.bob.id}/sessions/nope`, { method: 'DELETE' })).status).toBe(404);
    expect(
        (await b.call(adaJar, `/api/accounts/${b.olga.id}/sessions/${olgasSession.id}`, { method: 'DELETE' })).status,
    ).toBe(403);

    const out = await b.call(adaJar, `/api/accounts/${b.bob.id}/sessions/${laptopSession.id}`, { method: 'DELETE' });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect((await b.call(laptop, '/api/state')).status).toBe(401);
    expect((await b.call(phone, '/api/state')).status).toBe(200);
    const after = (await (await b.call(adaJar, `/api/accounts/${b.bob.id}`)).json()) as PersonDetail;
    expect(after.signIn.sessions.map((session) => session.userAgent)).toEqual(['Phone browser']);
    // Ada's own session is untouched.
    expect((await b.call(adaJar, '/api/state')).status).toBe(200);
    await vi.waitFor(() =>
        expect(b.workspace.auditOf('user', 'bob')).toEqual([
            expect.objectContaining({
                actor: b.ada.userId,
                action: 'revoke',
                detail: 'a session of Bob (Laptop browser)',
            }),
        ]),
    );
    // It is in Bob's trail, with Ada's name.
    const trail = (await (await b.call(adaJar, `/api/accounts/${b.bob.id}/audit`)).json()) as PersonTrail;
    expect(trail.lines).toEqual([
        expect.objectContaining({
            source: 'workspace',
            actorId: b.ada.userId,
            actorName: 'Ada',
            action: 'revoke',
            detail: 'Revoked a session of Bob (Laptop browser)',
        }),
    ]);
});

it("pages a person's trail across the four audit sources, newest first, with a stable cursor", async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const bobJar = await b.signIn('bob@example.com');
    const db = new DatabaseSync(b.path);
    const base = 1_700_000_000_000;
    const workspaceLine = db.prepare(
        'INSERT INTO workspace_audit(actor, action, targetKind, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const policyLine = db.prepare('INSERT INTO access_policy_audit(at, actor, action, detail) VALUES (?, ?, ?, ?)');
    const socioLine = db.prepare(
        'INSERT INTO actor_audit(at, correlationId, phase, decision, reason, personId, socioId, actorBy, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const roomLine = db.prepare(
        'INSERT INTO room_events(roomId, actor, action, targetKind, targetId, outcome, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // Four lines at the same millisecond, one per source, and more around them.
    workspaceLine.run(b.ada.userId, 'deactivate', 'user', 'bob', 'Bob; ended 1 mini app session(s)', base + 5);
    policyLine.run(base + 5, 'bob', 'change', 'sign-in methods');
    socioLine.run(
        base + 5,
        'c1',
        'revoke',
        null,
        'person_deactivated',
        'bob',
        'socio-1',
        b.ada.userId,
        'gateway:model',
    );
    roomLine.run('room-1', 'bob', 'leave', 'person', 'bob', 'ok', '', base + 5);
    workspaceLine.run('alice', 'create', 'space_member', 'space-1:bob', 'role member', base + 9);
    workspaceLine.run('alice', 'update', 'space_member', 'space-1:bobby', 'role member', base + 9);
    workspaceLine.run('bob', 'unlink', 'telegram_link', 'bob', 'Telegram user 1', base + 1);
    workspaceLine.run('alice', 'revoke', 'agent_grant', 'g-1', 'Example Agent for bob', base + 2);
    workspaceLine.run('alice', 'revoke', 'agent_grant', 'g-2', 'Example Agent for bobby', base + 2);
    roomLine.run('room-1', 'alice', 'invite', 'person', 'bob', 'ok', '', base + 3);
    roomLine.run('room-1', 'alice', 'invite', 'person', 'carl', 'ok', '', base + 3);
    socioLine.run(base + 4, 'c2', 'decision', 'deny', 'scope', 'bob', 'socio-1', null, 'app:notes');
    socioLine.run(base + 4, 'c3', 'decision', 'deny', 'scope', 'carl', 'socio-1', null, 'app:notes');
    policyLine.run(base + 7, 'carl', 'change', 'not Bob');
    db.close();

    const all: PersonTrail['lines'] = [];
    const pages: number[] = [];
    let before: string | null = '';
    while (before !== null) {
        const query: string = before ? `?limit=3&before=${encodeURIComponent(before)}` : '?limit=3';
        const response = await b.call(adaJar, `/api/accounts/${b.bob.id}/audit${query}`);
        expect(response.status).toBe(200);
        const page = (await response.json()) as PersonTrail;
        all.push(...page.lines);
        pages.push(page.lines.length);
        before = page.next;
    }
    expect(pages).toEqual([3, 3, 3]);
    expect(all.map((line) => [line.at - base, line.source])).toEqual([
        [9, 'workspace'],
        [5, 'workspace'],
        [5, 'access_policy'],
        [5, 'socio_access'],
        [5, 'room'],
        [4, 'socio_access'],
        [3, 'room'],
        [2, 'workspace'],
        [1, 'workspace'],
    ]);
    expect(new Set(all.map((line) => line.id)).size).toBe(all.length);
    expect(all[0]).toEqual({
        id: expect.stringMatching(/^workspace:\d+$/),
        at: base + 9,
        source: 'workspace',
        actorId: 'alice',
        actorName: 'Alice',
        action: 'create',
        detail: 'Added Bob in Space space-1: role member',
    });
    expect(all.find((line) => line.source === 'access_policy')).toMatchObject({
        actorName: 'Bob',
        detail: 'Changed the access policy: sign-in methods',
    });
    expect(all.find((line) => line.action === 'revoke' && line.source === 'socio_access')).toMatchObject({
        actorName: 'Ada',
        detail: 'Socio access revoke: socio socio-1, for gateway:model (person deactivated)',
    });
    expect(all.find((line) => line.action === 'decision:deny')).toMatchObject({
        actorId: 'system',
        actorName: 'Socio',
    });
    expect(all.find((line) => line.action === 'invite')).toMatchObject({
        actorName: 'Alice',
        detail: 'Invite Bob in room room-1',
    });
    expect(all.find((line) => line.action === 'deactivate')!.detail).toBe(
        'Deactivated Bob; ended 1 mini app session(s)',
    );

    // A time as `before`: strictly older lines.
    const older = (await (
        await b.call(adaJar, `/api/accounts/${b.bob.id}/audit?before=${base + 5}`)
    ).json()) as PersonTrail;
    expect(older.lines.map((line) => line.at - base)).toEqual([4, 3, 2, 1]);
    expect(older.next).toBeNull();

    // Bad pages and members; other admins' trails are open to admins (CB-390).
    for (const query of ['?limit=0', '?limit=201', '?limit=x', '?before=nope', '?before=1.other.2']) {
        expect((await b.call(adaJar, `/api/accounts/${b.bob.id}/audit${query}`)).status, query).toBe(400);
    }
    expect((await b.call(bobJar, `/api/accounts/${b.bob.id}/audit`)).status).toBe(403);
    expect((await b.call(adaJar, `/api/accounts/${b.olga.id}/audit`)).status).toBe(200);
    expect((await b.call(adaJar, '/api/accounts/nobody/audit')).status).toBe(404);
});

it('reads trail cursors and times, and refuses anything else', () => {
    expect(parseTrailBefore('1700000000000.room.12')).toEqual({ at: 1_700_000_000_000, source: 'room', id: 12 });
    expect(parseTrailBefore('1700000000000')).toEqual({ at: 1_700_000_000_000 });
    expect(parseTrailBefore('1700000000000.rooms.12')).toBeUndefined();
    expect(parseTrailBefore('-1')).toBeUndefined();
    expect(parseTrailBefore('1.room.')).toBeUndefined();
});

it('removes a revoked service key for good, audited by name and id; refuses live and unknown keys', async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const bobJar = await b.signIn('bob@example.com');
    const keys = b.platform.serviceAccounts;
    const ci = keys.create({ name: 'CI', role: 'member' }, b.ada.userId);
    const live = keys.createKey(ci.id, { name: 'deploys', scopes: ['issues:read'], days: 30 }, b.ada.userId);
    const old = keys.createKey(ci.id, { name: 'old', scopes: ['issues:read'], days: 30 }, b.ada.userId);
    const lapsed = keys.createKey(ci.id, { name: 'lapsed', scopes: ['issues:read'], days: 30 }, b.ada.userId);
    const db = new DatabaseSync(b.path);
    db.prepare('UPDATE service_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1000, lapsed.key.id);
    const remove = (jar: Jar, keyId: string, account = ci.id) =>
        b.call(jar, `/api/service-accounts/${account}/keys/${keyId}/record`, { method: 'DELETE' });

    expect((await remove(bobJar, live.key.id)).status).toBe(403);
    // Live, and expired but never revoked: revoke first.
    const refused = await remove(adaJar, live.key.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'Revoke this key before deleting it for good.' });
    expect((await remove(adaJar, lapsed.key.id)).status).toBe(409);
    expect((await remove(adaJar, 'nope')).status).toBe(404);
    expect((await remove(adaJar, old.key.id, 'svc_nobody')).status).toBe(404);

    // Revoking is unchanged: the key stays listed, revoked.
    const revoked = await b.call(adaJar, `/api/service-accounts/${ci.id}/keys/${old.key.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as ServiceAccountView).keys.find((key) => key.id === old.key.id)?.revokedAt).toEqual(
        expect.any(Number),
    );
    // Under another account, the key is unknown.
    const other = keys.create({ name: 'Other', role: 'member' }, b.ada.userId);
    expect((await remove(adaJar, old.key.id, other.id)).status).toBe(404);

    const removed = await remove(adaJar, old.key.id);
    expect(removed.status).toBe(200);
    const view = (await removed.json()) as ServiceAccountView;
    // Keys made in the same millisecond tie on createdAt, so compare as a set.
    expect(view.keys.map((key) => key.name).sort()).toEqual(['deploys', 'lapsed']);
    expect(db.prepare('SELECT count(*) AS n FROM service_keys WHERE id=?').get(old.key.id)).toEqual({ n: 0 });
    expect((await remove(adaJar, old.key.id)).status).toBe(404);
    await vi.waitFor(() =>
        expect(b.workspace.auditOf('service_key', old.key.id)).toEqual([
            {
                actor: b.ada.userId,
                action: 'delete',
                targetKind: 'service_key',
                targetId: old.key.id,
                detail: `CI / old (${old.key.id})`,
                createdAt: expect.any(Number),
            },
        ]),
    );
    const line = JSON.stringify(b.workspace.auditOf('service_key', old.key.id));
    expect(line).not.toContain(old.key.hint);
    db.close();
    // The live key still works.
    const whoami = await b.call(new Jar(), '/api/service/whoami', {
        headers: { authorization: `Bearer ${live.token}` },
    });
    expect(whoami.status).toBe(200);
});

it('lists an admin as editor of every Space they can read, with the Account fields', async () => {
    const b = await brain();
    const adaJar = await b.signIn('ada@example.com');
    const detail = (await (await b.call(adaJar, `/api/accounts/${b.ada.id}`)).json()) as PersonDetail;
    const account: Account = detail.person;
    expect(account).toMatchObject({ id: b.ada.id, name: 'Ada', role: 'admin', password: true });
    expect(detail.access).not.toBeNull();
    expect(detail.access!.spaces.every((space) => space.level === 'editor')).toBe(true);
});
