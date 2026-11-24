// Groups (CB-376): who may run code is the `code:run` permission of Better
// Auth's organization plugin. Admins have it; members get it from a group
// admins make under Settings → People → Groups. The checks go through the
// gateways' `mayRunCode`, as coding sessions and the gateways ask.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import type { Group } from '@socio/shared/groups';
import type { PersonDetail } from '@socio/shared/people';

import { writeStoredPolicy } from '../src/server/auth/access-policy-store.js';
import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import { WORKSPACE_ORGANIZATION_ID } from '../src/server/auth/groups.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { CODE_USERS_DEPRECATED, codeUsersFromEnv } from '../src/server/composition/config.js';
import { mayRunCode } from '../src/server/gateway/code-users.js';
import { schemas } from '../src/server/modules/index.js';

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
async function brain() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-groups-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        { AUTH_PROVIDER: 'betterauth', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, AUTH_TRUST_PROXY: 'true' },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const provider = auth.provider as BetterAuthProvider;
    const { app, platform, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        app: { config: { mode: 'live', baseUrl: 'https://model.invalid' }, origin: [ORIGIN], auth },
    });
    cleanups.push(async () => {
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    await provider.start();
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
    /** An account, signed in with its password: its account id, app user id and browser. */
    const person = async (email: string, role: 'admin' | 'member') => {
        const accountId = await provider.createAccount({ email, name: email.split('@')[0]!, role, password: PASSWORD });
        const jar = new Jar();
        const response = await call(jar, '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
        expect(response.status).toBe(200);
        const userId = provider.accounts().find((account) => account.id === accountId)!.userId;
        return { accountId, userId, jar };
    };
    const may = (userId: string) => mayRunCode(platform, userId);
    const memberRole = (accountId: string) =>
        (
            provider['database']()
                .prepare('SELECT role FROM auth_member WHERE organizationId=? AND userId=?')
                .get(WORKSPACE_ORGANIZATION_ID, accountId) as { role: string } | undefined
        )?.role;
    return { app, provider, platform, path, call, person, may, memberRole };
}
type Brain = Awaited<ReturnType<typeof brain>>;

/** An admin makes a group with these permissions; returns it. */
async function makeGroup(b: Brain, jar: Jar, name: string, permissions: string[] = ['code:run']) {
    const response = await b.call(jar, '/api/groups', { body: { name, permissions } });
    expect(response.status).toBe(201);
    return (await response.json()) as Group;
}
const join_ = (b: Brain, jar: Jar, groupId: string, accountId: string) =>
    b.call(jar, `/api/groups/${groupId}/members/${accountId}`, { method: 'PUT' });

it('lets admins and operators run code without a group, and nobody else', async () => {
    const b = await brain();
    const operator = await b.person('op@example.com', 'admin');
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    expect(await b.may(operator.userId)).toBe(true);
    expect(await b.may(admin.userId)).toBe(true);
    // A member without a group may not; nor may someone with no account.
    expect(await b.may(member.userId)).toBe(false);
    expect(await b.may('nobody')).toBe(false);
    // Every account is a member of the hidden workspace organization, its base role following Socio's.
    expect([b.memberRole(operator.accountId), b.memberRole(admin.accountId), b.memberRole(member.accountId)]).toEqual([
        'admin',
        'admin',
        'member',
    ]);
});

it('lets a member in a group with "Run code" run code, and only while the group gives it', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const other = await b.person('ola@example.com', 'member');
    const coders = await makeGroup(b, admin.jar, 'Coders');
    const readers = await makeGroup(b, admin.jar, 'Readers', []);
    expect(coders).toMatchObject({ name: 'Coders', permissions: ['code:run'], members: [] });
    expect(coders.id).toMatch(/^g-[0-9a-f]{12}$/);
    // A group without the permission gives nothing.
    expect((await join_(b, admin.jar, readers.id, other.accountId)).status).toBe(200);
    expect(await b.may(other.userId)).toBe(false);
    const joined = await join_(b, admin.jar, coders.id, member.accountId);
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as Group).members.map((entry) => entry.userId)).toEqual([member.userId]);
    // Membership is the comma-separated member role.
    expect(b.memberRole(member.accountId)).toBe(`member,${coders.id}`);
    expect(await b.may(member.userId)).toBe(true);
    // Choosing permissions: taking "Run code" off the group revokes it, putting it back gives it again.
    const off = await b.call(admin.jar, `/api/groups/${coders.id}`, { method: 'PATCH', body: { permissions: [] } });
    expect(off.status).toBe(200);
    expect(await b.may(member.userId)).toBe(false);
    await b.call(admin.jar, `/api/groups/${coders.id}`, { method: 'PATCH', body: { permissions: ['code:run'] } });
    expect(await b.may(member.userId)).toBe(true);
    // A rename keeps the members and the permission.
    const renamed = await b.call(admin.jar, `/api/groups/${coders.id}`, {
        method: 'PATCH',
        body: { name: 'Builders' },
    });
    expect(await renamed.json()).toMatchObject({ id: coders.id, name: 'Builders', permissions: ['code:run'] });
    expect(await b.may(member.userId)).toBe(true);
    // Their page lists their groups.
    const detail = (await (await b.call(admin.jar, `/api/accounts/${member.accountId}`)).json()) as PersonDetail;
    expect(detail.groups).toEqual([{ id: coders.id, name: 'Builders', permissions: ['code:run'] }]);
    expect(detail.access?.codeAccess).toBe(true);
    // Names are unique, case aside.
    expect((await b.call(admin.jar, '/api/groups', { body: { name: 'builders' } })).status).toBe(409);
});

it('reads every group a person is in, past the adapter’s 100-row default', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const other = await b.person('ola@example.com', 'member');
    // 100 groups first, that give nothing; Ola is in every one of them.
    for (let n = 1; n <= 100; n += 1) {
        const empty = b.provider.groups().create(`Empty ${n}`, []);
        b.provider.groups().setMembership(other.accountId, empty.id, true);
    }
    // The 101st gives "Run code".
    const coders = await makeGroup(b, admin.jar, 'Coders');
    expect((await join_(b, admin.jar, coders.id, member.accountId)).status).toBe(200);
    expect(await b.may(member.userId)).toBe(true);
    // In 101 groups, the last the one that gives it.
    expect(await b.may(other.userId)).toBe(false);
    await join_(b, admin.jar, coders.id, other.accountId);
    expect(await b.may(other.userId)).toBe(true);
    // And still revoked at once.
    await b.call(admin.jar, `/api/groups/${coders.id}/members/${member.accountId}`, { method: 'DELETE' });
    expect(await b.may(member.userId)).toBe(false);
});

it('revokes at once when an admin takes the person out of the group', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const group = await makeGroup(b, admin.jar, 'Coders');
    await join_(b, admin.jar, group.id, member.accountId);
    expect(await b.may(member.userId)).toBe(true);
    const removed = await b.call(admin.jar, `/api/groups/${group.id}/members/${member.accountId}`, {
        method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Group).members).toEqual([]);
    // The very next check: no cache to wait out.
    expect(await b.may(member.userId)).toBe(false);
    expect(b.memberRole(member.accountId)).toBe('member');
});

it('revokes at once when the group is deleted, and takes it off everyone', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const keep = await makeGroup(b, admin.jar, 'Other', []);
    const group = await makeGroup(b, admin.jar, 'Coders');
    await join_(b, admin.jar, keep.id, member.accountId);
    await join_(b, admin.jar, group.id, member.accountId);
    expect(await b.may(member.userId)).toBe(true);
    expect((await b.call(admin.jar, `/api/groups/${group.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await b.may(member.userId)).toBe(false);
    expect(b.memberRole(member.accountId)).toBe(`member,${keep.id}`);
    const list = (await (await b.call(admin.jar, '/api/groups')).json()) as { groups: Group[] };
    expect(list.groups.map((entry) => entry.name)).toEqual(['Other']);
    expect((await b.call(admin.jar, `/api/groups/${group.id}`, { method: 'DELETE' })).status).toBe(404);
});

it('keeps the member role’s base in step with Socio’s role, groups kept', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const group = await makeGroup(b, admin.jar, 'Other', []);
    await join_(b, admin.jar, group.id, member.accountId);
    // Promoted: an admin, so they may run code, groups kept.
    expect(
        (await b.call(admin.jar, `/api/accounts/${member.accountId}`, { method: 'PATCH', body: { role: 'admin' } }))
            .status,
    ).toBe(200);
    expect(b.memberRole(member.accountId)).toBe(`admin,${group.id}`);
    expect(await b.may(member.userId)).toBe(true);
    // Demoted: back to member, and the permission goes with it.
    await b.call(admin.jar, `/api/accounts/${member.accountId}`, { method: 'PATCH', body: { role: 'member' } });
    expect(b.memberRole(member.accountId)).toBe(`member,${group.id}`);
    expect(await b.may(member.userId)).toBe(false);
    // A deactivated person may not run code, whatever their groups.
    const coders = await makeGroup(b, admin.jar, 'Coders');
    await join_(b, admin.jar, coders.id, member.accountId);
    expect(await b.may(member.userId)).toBe(true);
    await b.provider.deactivate(member.accountId, admin.userId);
    expect(await b.may(member.userId)).toBe(false);
});

it('refuses the Groups routes to members, and bad input to admins', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const group = await makeGroup(b, admin.jar, 'Coders');
    const attempts: [string, Omit<RequestInit, 'body'> & { body?: unknown }][] = [
        ['/api/groups', {}],
        ['/api/groups', { body: { name: 'Mine', permissions: ['code:run'] } }],
        [`/api/groups/${group.id}`, { method: 'PATCH', body: { name: 'Mine' } }],
        [`/api/groups/${group.id}`, { method: 'DELETE' }],
        [`/api/groups/${group.id}/members/${member.accountId}`, { method: 'PUT' }],
        [`/api/groups/${group.id}/members/${member.accountId}`, { method: 'DELETE' }],
    ];
    for (const [path, init] of attempts) {
        expect((await b.call(member.jar, path, init as never)).status).toBe(403);
        expect((await b.call(new Jar(), path, init as never)).status).toBe(401);
    }
    expect(await b.may(member.userId)).toBe(false);
    // Admins: an unknown permission, a static role's id, an unknown account.
    expect((await b.call(admin.jar, '/api/groups', { body: { name: 'X', permissions: ['code:write'] } })).status).toBe(
        400,
    );
    expect((await b.call(admin.jar, '/api/groups/admin/members/x', { method: 'PUT' })).status).toBe(404);
    expect((await b.call(admin.jar, `/api/groups/${group.id}/members/no-such-account`, { method: 'PUT' })).status).toBe(
        404,
    );
});

it('never serves the organization plugin’s endpoints on the public /api/auth mount', async () => {
    const b = await brain();
    const admin = await b.person('ada@example.com', 'admin');
    const member = await b.person('mo@example.com', 'member');
    const group = await makeGroup(b, admin.jar, 'Coders');
    for (const jar of [admin.jar, member.jar]) {
        for (const [path, body] of [
            ['/api/auth/organization/list', undefined],
            ['/api/auth/organization/list-roles?organizationId=workspace', undefined],
            ['/api/auth/organization/has-permission', { permissions: { code: ['run'] } }],
            [
                '/api/auth/organization/create-role',
                { role: 'mine', permission: { code: ['run'] }, organizationId: 'workspace' },
            ],
            [
                '/api/auth/organization/update-member-role',
                { memberId: 'x', role: `member,${group.id}`, organizationId: 'workspace' },
            ],
            ['/api/auth/organization/create', { name: 'Mine', slug: 'mine' }],
            ['/api/auth//organization/create', { name: 'Mine', slug: 'mine' }],
            ['/api/auth/Organization/create', { name: 'Mine', slug: 'mine' }],
        ] as const) {
            const response = await b.call(jar, path, body === undefined ? {} : { body });
            expect(response.status, path).toBe(404);
        }
    }
    expect(await b.may(member.userId)).toBe(false);
    const roles = b.provider['database']().prepare('SELECT COUNT(*) AS n FROM auth_organization_role').get() as {
        n: number;
    };
    expect(roles.n).toBe(1);
});

it('seeds a "Code" group once from CODE_USERS as narrowed under Settings → Access, with its non-admins', async () => {
    const b = await brain();
    const ada = await b.person('ada@example.com', 'admin');
    const bob = await b.person('bob@example.com', 'member');
    const carol = await b.person('carol@example.com', 'member');
    expect(await b.may(bob.userId)).toBe(false);
    // CODE_USERS lists all three and a ghost; an operator kept all but Carol
    // under Settings → Access before groups (CB-124).
    const ceiling = [ada.userId, bob.userId, carol.userId, 'ghost'];
    writeStoredPolicy(b.provider['database'](), 0, { codeUsers: [ada.userId, bob.userId, 'ghost'] }, 'cli');
    const lines = await b.provider.seedCodeGroup(ceiling);
    expect(lines).toEqual([
        'Groups: made the “Code” group from CODE_USERS, with 1 person(s); admins may run code without it.',
        'Groups: 1 CODE_USERS id(s) have no account and were not added to a group.',
    ]);
    const groups = (await (await b.call(ada.jar, '/api/groups')).json()) as { groups: Group[] };
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]).toMatchObject({ name: 'Code', permissions: ['code:run'] });
    // Only the non-admin in force: Ada is an admin, Carol was taken off the list.
    expect(groups.groups[0]!.members.map((entry) => entry.userId)).toEqual([bob.userId]);
    expect(await b.may(bob.userId)).toBe(true);
    expect(await b.may(carol.userId)).toBe(false);
    // Once: a second boot changes nothing, even after the group is deleted.
    expect(await b.provider.seedCodeGroup(ceiling)).toEqual([]);
    await b.call(ada.jar, `/api/groups/${groups.groups[0]!.id}`, { method: 'DELETE' });
    expect(await b.provider.seedCodeGroup(ceiling)).toEqual([]);
    expect(((await (await b.call(ada.jar, '/api/groups')).json()) as { groups: Group[] }).groups).toEqual([]);
    expect(await b.may(bob.userId)).toBe(false);
});

it('seeds nothing, once, when CODE_USERS lists nobody', async () => {
    const b = await brain();
    const ada = await b.person('ada@example.com', 'admin');
    expect(await b.provider.seedCodeGroup([])).toEqual([]);
    // Recorded as done: a CODE_USERS set later doesn't make a group.
    const bob = await b.person('bob@example.com', 'member');
    expect(await b.provider.seedCodeGroup([bob.userId])).toEqual([]);
    expect(((await (await b.call(ada.jar, '/api/groups')).json()) as { groups: Group[] }).groups).toEqual([]);
});

it('warns that CODE_USERS is deprecated when it is set', () => {
    const warn = vi.fn();
    expect(codeUsersFromEnv({ CODE_USERS: 'alice, bob' }, warn)).toEqual(['alice', 'bob']);
    expect(warn).toHaveBeenCalledWith(CODE_USERS_DEPRECATED);
    warn.mockClear();
    expect(codeUsersFromEnv({}, warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
});
