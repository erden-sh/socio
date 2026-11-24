import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { sqliteData } from '@socio/data/open';

import { sqliteServiceAccountRepositories } from '../src/server/service-accounts/infra/sqlite/index.js';
import { serviceAccountTables } from '../src/server/service-accounts/infra/sqlite/schema.js';
import { ServiceAccounts } from '../src/server/service-accounts/service-accounts.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The service accounts repository contract (CB-110): what any
 * implementation of `service-accounts/domain/repositories.ts` must keep,
 * run against the SQLite one, and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn());
    vi.restoreAllMocks();
});

function context() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const data = sqliteData(workspace.db);
    return {
        db: workspace.db,
        uow: data.uow,
        repos: sqliteServiceAccountRepositories(data),
    };
}

const all = (db: WorkspaceStore['db'], sql: string) => db.prepare(sql).all();

const key = {
    id: 'k1',
    userId: 'svc_1',
    name: 'CI',
    hint: 'abcdef',
    hash: 'h1',
    scopes: ['issues:read' as const],
    createdAt: 10,
    createdBy: 'alice',
    expiresAt: 1_000,
};

it('mirrors the migrated users, accounts and keys tables', () => {
    const { db } = context();
    expect(schemaDrift(db, serviceAccountTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE service_keys ADD COLUMN note TEXT');
    expect(schemaDrift(db, serviceAccountTables)).toEqual([expect.stringContaining('note')]);
});

it('makes an account with its user, changes and disables it', () => {
    const { db, repos } = context();
    repos.accounts.insertNow({
        userId: 'svc_1',
        name: 'Robot',
        role: 'member',
        description: 'Files issues.',
        createdAt: 10,
        createdBy: 'alice',
    });
    expect(all(db, "SELECT * FROM users WHERE id='svc_1'")).toEqual([
        {
            id: 'svc_1',
            name: 'Robot',
            role: 'member',
            createdAt: 10,
            lastSeenAt: 10,
        },
    ]);
    repos.accounts.updateNow('svc_1', {
        name: 'Bot',
        role: 'admin',
        description: '',
    });
    repos.accounts.disableNow('svc_1', 20);
    // A disabled account keeps the time it was disabled.
    repos.accounts.disableNow('svc_1', 30);
    expect(all(db, "SELECT name, role FROM users WHERE id='svc_1'")).toEqual([{ name: 'Bot', role: 'admin' }]);
    expect(all(db, 'SELECT * FROM service_accounts')).toEqual([
        {
            userId: 'svc_1',
            description: '',
            createdAt: 10,
            createdBy: 'alice',
            disabledAt: 20,
        },
    ]);
});

it('stores a key as the raw columns did and revokes live keys only', () => {
    const { db, repos } = context();
    repos.keys.insertNow(key);
    repos.keys.insertNow({ ...key, id: 'k2', hash: 'h2' });
    repos.keys.insertNow({ ...key, id: 'k3', hash: 'h3', userId: 'svc_2' });
    expect(all(db, "SELECT * FROM service_keys WHERE id='k1'")).toEqual([
        {
            ...key,
            scopes: '["issues:read"]',
            lastUsedAt: null,
            lastUsedIp: null,
            revokedAt: null,
        },
    ]);
    // Another account's key isn't this one's to revoke.
    expect(repos.keys.revokeNow('k3', 20, 'svc_1')).toBe(false);
    expect(repos.keys.revokeNow('k1', 20, 'svc_1')).toBe(true);
    expect(repos.keys.revokeNow('k1', 30)).toBe(false);
    repos.keys.revokeAllNow('svc_1', 40);
    expect(all(db, 'SELECT id, revokedAt FROM service_keys ORDER BY id')).toEqual([
        { id: 'k1', revokedAt: 20 },
        { id: 'k2', revokedAt: 40 },
        { id: 'k3', revokedAt: null },
    ]);
});

it('records a key’s use at once, or queued behind an open unit of work', async () => {
    const { db, uow, repos } = context();
    repos.keys.insertNow(key);
    repos.keys.recordUse('k1', 50, '10.0.0.1');
    expect(all(db, 'SELECT lastUsedAt, lastUsedIp FROM service_keys')).toEqual([
        { lastUsedAt: 50, lastUsedIp: '10.0.0.1' },
    ]);
    let release!: () => void;
    const held = uow.run(() => new Promise<void>((resolve) => (release = resolve)), { label: 'held' });
    await Promise.resolve();
    // Neither joins the unit nor fails: it waits its turn.
    repos.keys.recordUse('k1', 60, null);
    expect(all(db, 'SELECT lastUsedAt FROM service_keys')).toEqual([{ lastUsedAt: 50 }]);
    release();
    await held;
    await vi.waitFor(() =>
        expect(all(db, 'SELECT lastUsedAt, lastUsedIp FROM service_keys')).toEqual([
            { lastUsedAt: 60, lastUsedIp: null },
        ]),
    );
});

it('keeps the service’s behavior: create, key, resolve, disable', () => {
    const { db } = context();
    const accounts = new ServiceAccounts(db);
    const account = accounts.create({ name: 'Robot', role: 'member', description: 'Files.' }, 'alice');
    const { token } = accounts.createKey(account.id, { name: 'CI', scopes: ['issues:read'], days: 30 }, 'alice');
    expect(accounts.resolve(token, '10.0.0.9')?.user.id).toBe(account.id);
    expect(accounts.get(account.id).keys[0]).toMatchObject({
        scopes: ['issues:read'],
        lastUsedIp: '10.0.0.9',
    });
    expect(accounts.revokeKeysMadeBy('alice')).toEqual([{ name: 'CI', account: 'Robot' }]);
    expect(accounts.resolve(token)).toBeUndefined();
    expect(accounts.disable(account.id).disabledAt).toEqual(expect.any(Number));
});
