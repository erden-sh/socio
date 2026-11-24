import { afterEach, expect, it, vi } from 'vitest';

import type { CreatedServiceKey, ServiceAccountView } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { scopeAllows } from '../src/server/service-accounts/service-accounts.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const CONFIG: PlatformConfig = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: 'service-accounts-test-secret-0123456789',
};
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, platform, workspace, dispose } = await makeTestRuntime({
        config: CONFIG,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
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
    /** A request with a bearer key, and whatever headers a hostile page adds. */
    const withKey =
        (token: string, extra: Record<string, string> = {}) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    ...extra,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    return { app, platform, workspace, as, withKey };
}

async function account(
    admin: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['as']>>,
    role: 'member' | 'admin',
    scopes: string[],
) {
    const made = (await (
        await admin('/service-accounts', 'POST', {
            name: `Claude (${role})`,
            role,
            description: 'The lead agent',
        })
    ).json()) as ServiceAccountView;
    const response = await admin(`/service-accounts/${made.id}/keys`, 'POST', {
        name: 'laptop',
        scopes,
        days: 90,
    });
    expect(response.status).toBe(201);
    return { account: made, ...((await response.json()) as CreatedServiceKey) };
}

it('lets admins alone manage service accounts, never as operators, and shows a key once', async () => {
    const { as, workspace } = await fixture();
    const alice = await as('alice');
    const bob = await as('bob');
    expect((await bob('/service-accounts')).status).toBe(403);
    expect((await bob('/service-accounts', 'POST', { name: 'X', role: 'member' })).status).toBe(403);
    expect((await alice('/service-accounts', 'POST', { name: 'X', role: 'operator' })).status).toBe(400);
    const { account: made, token, key } = await account(alice, 'admin', ['issues:read', 'issues:write']);
    expect(made.id).toMatch(/^svc_/);
    expect(token).toMatch(/^cbk_[\w-]{43}$/);
    expect(key).toMatchObject({
        name: 'laptop',
        scopes: ['issues:read', 'issues:write'],
        hint: token.slice(4, 10),
        lastUsedAt: null,
        revokedAt: null,
    });
    // Listed without the token or its hash; the database holds the hash only.
    const listed = await (await alice('/service-accounts')).text();
    expect(listed).not.toContain(token);
    expect(listed).not.toContain('hash');
    const rows = JSON.stringify(workspace.db.prepare('SELECT * FROM service_keys').all());
    expect(rows).not.toContain(token);
    expect(rows).not.toContain(token.slice(4));
    // No scopes, or a lifetime not on offer: refused.
    for (const body of [
        { name: 'k', scopes: [], days: 90 },
        { name: 'k', scopes: ['chat'], days: 90 },
        { name: 'k', scopes: ['issues:read'], days: 7 },
    ]) {
        expect((await alice(`/service-accounts/${made.id}/keys`, 'POST', body)).status).toBe(400);
    }
    // It is in the users list (for attribution) but nobody can sign in as it.
    expect(workspace.users().map((user) => user.id)).toContain(made.id);
});

it('reaches only what its scopes allow, whatever a browser would add', async () => {
    const { app, as, withKey } = await fixture();
    const alice = await as('alice');
    const reader = await account(alice, 'admin', ['issues:read']);
    // Cross-site headers don't matter for a bearer key (no cookie rides along).
    const key = withKey(reader.token, {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
    });
    const whoami = await key('/service/whoami');
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({
        account: { id: reader.account.id, name: 'Claude (admin)', role: 'admin' },
        key: { name: 'laptop', scopes: ['issues:read'] },
    });
    expect((await key('/issues')).status).toBe(200);
    for (const [path, method] of [
        ['/issues', 'POST'],
        ['/workspace', 'GET'],
        ['/state', 'GET'],
        ['/service-accounts', 'GET'],
        ['/accounts', 'GET'],
        ['/auth/mock/users', 'GET'],
        ['/copilotkit/info', 'GET'],
        ['/conversations', 'POST'],
        ['/inference', 'GET'],
        ['/issues/import', 'POST'],
    ]) {
        const response = await key(path, method, method === 'GET' ? undefined : {});
        expect([path, response.status]).toEqual([path, 403]);
    }
    const refused = await key('/issues', 'POST', { title: 'Nope' });
    expect(await refused.json()).toMatchObject({ code: 'scope' });
    // People's requests are unchanged: cross-site with a cookie is refused.
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(
        (
            await app.request('/api/issues', {
                headers: { cookie, 'Sec-Fetch-Site': 'cross-site' },
            })
        ).status,
    ).toBe(403);
    // A key on a host the app doesn't serve: refused like any request.
    const elsewhere = await app.request('http://evil.example/api/issues', {
        headers: { Authorization: `Bearer ${reader.token}` },
    });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ error: 'Unrecognized host.' });
});

it('files and changes issues as the account, within its role', async () => {
    const { as, withKey } = await fixture();
    const alice = await as('alice');
    const member = await account(alice, 'member', ['issues:read', 'issues:write']);
    const admin = await account(alice, 'admin', ['issues:read', 'issues:write']);
    const asMember = withKey(member.token);
    const filed = await asMember('/issues', 'POST', {
        title: 'Filed by an agent',
        body: 'From a script.',
    });
    expect(filed.status).toBe(201);
    const issue =
        ((await filed.json()) as { issue?: { number: number; reporterId: string } }).issue ??
        (
            (await (await asMember('/issues')).json()) as {
                issues: { number: number; reporterId: string }[];
            }
        ).issues[0];
    expect(issue.reporterId).toBe(member.account.id);
    // A member account can't close it; an admin account can.
    expect((await asMember(`/issues/${issue.number}`, 'PATCH', { status: 'done' })).status).toBe(403);
    const asAdmin = withKey(admin.token);
    expect((await asAdmin(`/issues/${issue.number}`, 'PATCH', { status: 'done' })).status).toBe(200);
    expect(
        (
            await asAdmin(`/issues/${issue.number}/comments`, 'POST', {
                body: 'Fixed in abc123.',
            })
        ).status,
    ).toBe(201);
    // People see who filed it.
    const seen = (await (await alice(`/issues/${issue.number}`)).json()) as {
        users: Record<string, string>;
    };
    expect(seen.users[member.account.id]).toBe('Claude (member)');
});

it('stops a key once it is revoked, expired or its account disabled', async () => {
    const { as, withKey, workspace } = await fixture();
    const alice = await as('alice');
    const one = await account(alice, 'admin', ['issues:read']);
    const two = await account(alice, 'admin', ['issues:read']);
    expect((await withKey(one.token)('/issues')).status).toBe(200);
    // Its use is recorded.
    const used = ((await (await alice('/service-accounts')).json()) as ServiceAccountView[]).find(
        (entry) => entry.id === one.account.id,
    )!.keys[0];
    expect(used.lastUsedAt).toBeGreaterThan(0);
    await alice(`/service-accounts/${one.account.id}/keys/${one.key.id}`, 'DELETE');
    const revoked = await withKey(one.token)('/issues');
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: 'bad_key' });
    workspace.db.prepare('UPDATE service_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1, two.key.id);
    expect((await withKey(two.token)('/issues')).status).toBe(401);
    // A new key, then the account disabled: every key stops.
    const fresh = (await (
        await alice(`/service-accounts/${two.account.id}/keys`, 'POST', {
            name: 'again',
            scopes: ['issues:read'],
            days: 30,
        })
    ).json()) as CreatedServiceKey;
    expect((await withKey(fresh.token)('/issues')).status).toBe(200);
    await alice(`/service-accounts/${two.account.id}`, 'DELETE');
    expect((await withKey(fresh.token)('/issues')).status).toBe(401);
    expect(
        (
            await alice(`/service-accounts/${two.account.id}/keys`, 'POST', {
                name: 'no',
                scopes: ['issues:read'],
                days: 30,
            })
        ).status,
    ).toBe(409);
    // Made up, or someone else's prefix: not a key.
    expect((await withKey('cbk_made-up')('/issues')).status).toBe(401);
});

it('never resolves a service account as an operator and limits each key per minute', async () => {
    const { platform, workspace } = await fixture();
    const accounts = platform.serviceAccounts;
    const made = accounts.create({ name: 'Bot', role: 'admin' }, 'alice');
    const { token, key } = accounts.createKey(made.id, { name: 'k', scopes: ['issues:read'], days: 30 }, 'alice');
    expect(accounts.resolve(token)?.user.role).toBe('admin');
    workspace.db.prepare("UPDATE users SET role='operator' WHERE id=?").run(made.id);
    expect(accounts.resolve(token)).toBeUndefined();
    for (let i = 0; i < 300; i++) {
        expect(accounts.take(key.id, 1_000)).toBe(true);
    }
    expect(accounts.take(key.id, 1_000)).toBe(false);
    expect(accounts.take(key.id, 61_001)).toBe(true);
});

it('maps scopes to routes, and nothing else', () => {
    expect(scopeAllows(['issues:read'], 'GET', '/api/issues/12')).toBe(true);
    expect(scopeAllows(['issues:read'], 'HEAD', '/api/issues')).toBe(true);
    expect(scopeAllows(['issues:read'], 'GET', '/api/issue-attachments/a1')).toBe(true);
    expect(scopeAllows(['issues:read'], 'PATCH', '/api/issues/12')).toBe(false);
    expect(scopeAllows(['issues:write'], 'PATCH', '/api/issues/12')).toBe(true);
    expect(scopeAllows(['issues:write'], 'POST', '/api/issues/import')).toBe(false);
    expect(scopeAllows(['issues:write'], 'DELETE', '/api/issues/12')).toBe(false);
    expect(scopeAllows(['pages:read'], 'GET', '/api/spaces/s1/pages/p1')).toBe(true);
    expect(scopeAllows(['pages:read'], 'PUT', '/api/spaces/s1/pages/p1')).toBe(false);
    // The light lists: the palette's titles and the sidebar's tree.
    expect(scopeAllows(['pages:read'], 'GET', '/api/pages/titles')).toBe(true);
    expect(scopeAllows(['pages:read'], 'GET', '/api/spaces/s1/page-tree')).toBe(true);
    expect(scopeAllows(['issues:read'], 'GET', '/api/issues/titles')).toBe(true);
    expect(scopeAllows(['issues:read'], 'GET', '/api/pages/titles')).toBe(false);
    expect(scopeAllows(['pages:read'], 'GET', '/api/issues/titles')).toBe(false);
    expect(scopeAllows([], 'GET', '/api/service/whoami')).toBe(true);
    expect(scopeAllows(['issues:read'], 'GET', '/api/issues/../workspace')).toBe(false);
});
