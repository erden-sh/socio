import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

// Fault injection: a prior copy that can't be removed after the commit.
const faults = vi.hoisted(() => ({ prior: false }));
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return {
        ...fs,
        rmSync: (path: string, options?: Parameters<typeof fs.rmSync>[1]) => {
            if (faults.prior && String(path).endsWith('.prior')) {
                throw new Error('EBUSY');
            }
            return fs.rmSync(path, options);
        },
    };
});

import { openDatabase } from '@socio/data/open';
import { SecretBox } from '@socio/foundation/keys/secret-box';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import {
    exactMatches,
    idRewriter,
    renameUser,
    renameUserCommand,
    RenameUserError,
} from '../src/server/backup/rename-user.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { LocalObjectStore } from '../src/server/storage/local-store.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const KEYS = { current: randomBytes(32), legacy: 'rename-test-secret-0123456789' };
const TENANT = 'acme';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-rename-user-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

function space(workspace: WorkspaceStore, dir: string, objects?: S3ObjectStore) {
    const data = new DataSpace(workspace.db, {
        dir,
        secret: KEYS,
        approvals: sqliteApprovals(workspace.db),
        workspace,
        ...(objects ? { objects } : {}),
        ...dataSpaceStorage(dir),
        tenantId: TENANT,
    });
    cleanup.push(() => data.close());
    return data;
}

/** A workspace where alice owns rows, keys, JSON, files and credentials. */
async function fixture() {
    const dir = scratch();
    const s3 = await startFakeS3();
    cleanup.push(() => s3.close());
    const objects = () => new S3ObjectStore(s3.settings(), { backoffMs: 1 });
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const db = workspace.db;
    // Members: the id the test renames alice to is 'admin', which a role value of
    // 'admin' would collide with.
    for (const id of ['alice', 'bob']) {
        workspace.recordUser({ id, name: id, role: 'member' });
    }
    db.prepare(
        `INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId, role)
         VALUES ('au1', 'Owner', 'alice@example.invalid', 1, 0, 0, 'alice', 'member')`,
    ).run();
    // Files: one on disk, one in S3, both sealed for alice/<id>.
    const local = space(workspace, dir);
    await local.putFile({ kind: 'user', userId: 'alice' }, 'local.txt', Buffer.from('LOCAL'));
    const remote = space(workspace, dir, objects());
    await remote.probeStorage();
    await remote.putFile({ kind: 'user', userId: 'alice' }, 'remote.txt', Buffer.from('REMOTE'));
    await remote.putFile({ kind: 'user', userId: 'bob' }, 'bob.txt', Buffer.from('BOB'));
    mkdirSync(join(dir, 'alice', 'datasets'), { recursive: true });
    writeFileSync(join(dir, 'alice', 'datasets', 'd1.sqlite'), 'dataset');
    // An append-only audit row, a JSON blob, keys with the id as a segment, prose.
    db.prepare(
        `INSERT INTO access_log(id, at, viewerId, surface, subjectKind, subjectId, content, requestId)
         VALUES ('l1', 1, 'alice', 'people', 'person', 'bob', 0, 'r1')`,
    ).run();
    db.prepare(
        `INSERT INTO agent_runs(threadId, runId, status, events, startedAt, trace) VALUES ('t1', 'run1', 'done', ?, 1, ?)`,
    ).run(
        JSON.stringify([
            { type: 'x', actor: { kind: 'person', id: 'alice' }, note: 'alice asked' },
            { nested: JSON.stringify({ userId: 'alice', dotId: 'd1', sender: 'alice-two' }) },
        ]),
        '{"actingUserId":"alice","big":12345678901234567890}',
    );
    db.prepare('INSERT INTO change_counters(key, n) VALUES (?, ?)').run('memories:alice', 5);
    db.prepare('INSERT INTO change_counters(key, n) VALUES (?, ?)').run('memories:admin', 2);
    db.prepare(
        "INSERT INTO telegram_threads(key, threadId, kind, chatId, createdAt) VALUES ('tg:9:dm#alice~x1', 'th1', 'dm', '9', 1)",
    ).run();
    db.prepare(
        "INSERT INTO workspace_audit(actor, action, targetKind, targetId, detail, createdAt) VALUES ('alice', 'x', 'space', 's1:alice', 'Grant for alice', 1)",
    ).run();
    // MCP credentials name their owner inside the seal.
    const mcpBox = new SecretBox(KEYS, 'mcp-credentials');
    db.prepare(
        `INSERT INTO mcp_connections(id, userId, name, url, authentication, state, secret, createdAt, updatedAt)
         VALUES ('m1', 'alice', 'M', 'https://mcp.example.invalid', 'oauth', 'connected', ?, 1, 1)`,
    ).run(mcpBox.seal({ userId: 'alice', connectionId: 'm1', generation: 1, data: { token: 't' } }));
    const run = (apply: boolean, to = 'admin', db2: DatabaseSync = db) =>
        renameUser({
            db: db2,
            from: 'alice',
            to,
            apply,
            userDataDir: dir,
            files: {
                box: new SecretBox(KEYS, 'data-files'),
                tenantId: TENANT,
                store: (driver) => (driver === 's3' ? objects() : new LocalObjectStore(dir)),
            },
            mcpBox,
        });
    return { dir, s3, objects, workspace, db, run, mcpBox };
}

it('rewrites the id itself, segments of keys and JSON strings, never prose', () => {
    const rewrite = idRewriter('alice', 'admin');
    expect(rewrite('alice')).toBe('admin');
    expect(rewrite('tasks:alice')).toBe('tasks:admin');
    expect(rewrite('tg:1:dm#alice~x')).toBe('tg:1:dm#admin~x');
    expect(rewrite('alice@example.invalid')).toBe('alice@example.invalid');
    expect(rewrite('alice-two')).toBe('alice-two');
    expect(rewrite('malice')).toBe('malice');
    expect(rewrite('signed in as alice today')).toBe('signed in as alice today');
    expect(rewrite('{"userId": "alice", "note": "alice asked", "n": 12345678901234567890}')).toBe(
        '{"userId": "admin", "note": "alice asked", "n": 12345678901234567890}',
    );
    expect(rewrite(JSON.stringify({ inner: JSON.stringify({ userId: 'alice' }) }))).toBe(
        JSON.stringify({ inner: JSON.stringify({ userId: 'admin' }) }),
    );
});

it('dry-runs by counting, changing nothing', async () => {
    const { dir, db, run, s3 } = await fixture();
    const before = new Map(s3.objects);
    const report = await run(false);
    expect(report.applied).toBe(false);
    const columns = Object.fromEntries(report.columns.map((c) => [`${c.table}.${c.column}`, c]));
    expect(columns['users.id']).toMatchObject({ exact: 1 });
    expect(columns['auth_user.appUserId']).toMatchObject({ exact: 1 });
    expect(columns['access_log.viewerId']).toMatchObject({ exact: 1 });
    expect(columns['data_files.ownerUserId']).toMatchObject({ exact: 2 });
    expect(columns['agent_runs.events']).toMatchObject({ embedded: 1 });
    expect(columns['telegram_threads.key']).toMatchObject({ embedded: 1 });
    expect(columns['workspace_audit.targetId']).toMatchObject({ embedded: 1 });
    expect(columns['workspace_audit.detail']).toMatchObject({ prose: 1, embedded: 0 });
    expect(columns['auth_user.email']).toMatchObject({ prose: 1, embedded: 0 });
    expect(report.files).toEqual({ s3: 1, local: 1, missing: 0, unreadable: 0 });
    expect(report.folder?.entries).toBeGreaterThan(0);
    expect(db.prepare("SELECT 1 FROM users WHERE id='alice'").get()).toBeTruthy();
    expect(existsSync(join(dir, 'alice'))).toBe(true);
    expect(existsSync(join(dir, 'admin'))).toBe(false);
    expect(new Map(s3.objects)).toEqual(before);
});

it('renames everywhere, files and credentials included, and leaves no exact match', async () => {
    const { dir, db, run, workspace, objects, mcpBox, s3 } = await fixture();
    const report = await run(true);
    expect(report.applied).toBe(true);
    expect(report.leftovers).toEqual([]);
    expect(exactMatches(db, 'alice')).toEqual([]);
    expect(db.prepare("SELECT id FROM users WHERE id IN ('alice','admin')").all()).toEqual([{ id: 'admin' }]);
    expect(db.prepare("SELECT appUserId, email FROM auth_user WHERE id='au1'").get()).toEqual({
        appUserId: 'admin',
        email: 'alice@example.invalid',
    });
    expect(db.prepare("SELECT viewerId FROM access_log WHERE id='l1'").get()).toEqual({ viewerId: 'admin' });
    // The append-only guard is back.
    expect(() => db.prepare("UPDATE access_log SET viewerId='x' WHERE id='l1'").run()).toThrow(/append-only/);
    const runRow = db.prepare("SELECT events, trace FROM agent_runs WHERE runId='run1'").get() as {
        events: string;
        trace: string;
    };
    const events = JSON.parse(runRow.events);
    expect(events[0]).toEqual({ type: 'x', actor: { kind: 'person', id: 'admin' }, note: 'alice asked' });
    expect(JSON.parse(events[1].nested)).toEqual({ userId: 'admin', dotId: 'd1', sender: 'alice-two' });
    expect(runRow.trace).toBe('{"actingUserId":"admin","big":12345678901234567890}');
    // The counters merge past both values.
    expect(db.prepare("SELECT key, n FROM change_counters WHERE key LIKE 'memories:%'").all()).toEqual([
        { key: 'memories:admin', n: 8 },
    ]);
    expect(db.prepare('SELECT key FROM telegram_threads').get()).toEqual({ key: 'tg:9:dm#admin~x1' });
    expect(db.prepare('SELECT targetId, detail FROM workspace_audit').get()).toEqual({
        targetId: 's1:admin',
        detail: 'Grant for alice',
    });
    // The folder moved, and every file reads back for admin, sealed for admin.
    expect(existsSync(join(dir, 'alice'))).toBe(false);
    expect(readdirSync(join(dir, 'admin', 'datasets'))).toEqual(['d1.sqlite']);
    expect(readdirSync(join(dir, 'admin', 'files')).every((n) => n.endsWith('.bin'))).toBe(true);
    const after = space(workspace, dir, objects());
    expect((await after.getFile({ kind: 'user', userId: 'admin' }, 'local.txt')).data.toString()).toBe('LOCAL');
    expect((await after.getFile({ kind: 'user', userId: 'admin' }, 'remote.txt')).data.toString()).toBe('REMOTE');
    expect((await after.getFile({ kind: 'user', userId: 'bob' }, 'bob.txt')).data.toString()).toBe('BOB');
    expect([...s3.objects.keys()].some((k) => k.includes(`tenants/${TENANT}/users/admin/files/`))).toBe(true);
    const secret = db.prepare("SELECT userId, secret FROM mcp_connections WHERE id='m1'").get() as {
        userId: string;
        secret: string;
    };
    expect(secret.userId).toBe('admin');
    expect(mcpBox.open(secret.secret)).toMatchObject({ userId: 'admin', connectionId: 'm1', data: { token: 't' } });
    // Once is enough: alice is gone.
    await expect(run(true)).rejects.toThrow('No user alice.');
});

it('refuses a taken id, a bad id and a live app, changing nothing', async () => {
    const { dir, db, run } = await fixture();
    await expect(run(true, 'bob')).rejects.toThrow(/taken/);
    await expect(run(true, 'Admin!')).rejects.toThrow(RenameUserError);
    await expect(run(true, 'socio:x')).rejects.toThrow(RenameUserError);
    mkdirSync(join(dir, 'newbie'));
    await expect(run(true, 'newbie')).rejects.toThrow(/exists/);
    db.prepare(
        "INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId) VALUES ('au2', 'X', 'x@example.invalid', 1, 0, 0, 'linked')",
    ).run();
    await expect(run(true, 'linked')).rejects.toThrow(/sign-in account/);
    db.prepare('INSERT INTO runtime_instances(id, startedAt, heartbeatAt, expiresAt) VALUES (?, 0, 0, ?)').run(
        'r1',
        Date.now() + 60_000,
    );
    await expect(run(true)).rejects.toThrow(/stop the app/);
    expect((await run(false)).applied).toBe(false);
    expect(db.prepare("SELECT 1 FROM users WHERE id='alice'").get()).toBeTruthy();
    expect(existsSync(join(dir, 'alice'))).toBe(true);
});

it('rolls everything back when a value can’t be rewritten', async () => {
    const { dir, db, run, s3 } = await fixture();
    // A row whose rewrite collides with another's unique key.
    db.prepare(
        "INSERT INTO telegram_threads(key, threadId, kind, chatId, createdAt) VALUES ('tg:9:dm#admin~x1', 'th2', 'dm', '9', 1)",
    ).run();
    const objectsBefore = s3.objects.size;
    await expect(run(true)).rejects.toThrow(/telegram_threads/);
    expect(db.prepare("SELECT 1 FROM users WHERE id='alice'").get()).toBeTruthy();
    expect(db.prepare("SELECT viewerId FROM access_log WHERE id='l1'").get()).toEqual({ viewerId: 'alice' });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='access_log_no_update'").get()).toEqual({
        n: 1,
    });
    expect(existsSync(join(dir, 'alice', 'datasets', 'd1.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'admin'))).toBe(false);
    // The S3 writes come after the database checks: none happened.
    expect(s3.objects.size).toBe(objectsBefore);
});

it('runs as `backup rename-user`: a dry run by default, --apply, then --leftovers', async () => {
    const dir = scratch();
    const database = testDatabaseFile(join(dir, 'db.sqlite'));
    const setup = new WorkspaceStore(openDatabase(database, {}));
    setup.recordUser({ id: 'alice', name: 'A', role: 'admin' });
    setup.db.prepare('INSERT INTO change_counters(key, n) VALUES (?, 1)').run('tasks:alice');
    setup.close();
    const lines: string[] = [];
    const options = {
        env: { DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
        database,
        userDataDir: join(dir, 'userdata'),
        local: new LocalObjectStore(join(dir, 'userdata')),
        behind: () => false,
        print: (line: string) => lines.push(line),
    };
    await expect(renameUserCommand(['alice', 'admin'], { ...options, behind: () => true })).rejects.toThrow(/schema/);
    expect(await renameUserCommand(['alice', 'admin'], options)).toBe(0);
    expect(lines.join('\n')).toMatch(/Dry run[\s\S]*users\.id\t1\t0\t0[\s\S]*change_counters\.key\t0\t1\t0/);
    expect(await renameUserCommand(['--leftovers', 'alice'], options)).toBe(1);
    await expect(renameUserCommand(['alice'], options)).rejects.toThrow(/Use:/);
    expect(await renameUserCommand(['alice', 'admin', '--apply'], options)).toBe(0);
    expect(lines.at(-1)).toMatch(/no exact alice left/);
    lines.length = 0;
    expect(await renameUserCommand(['--leftovers', 'alice'], options)).toBe(0);
    expect(lines).toEqual(['No text column holds it.']);
});

it('keeps the renamed files when cleanup after the commit fails', async () => {
    const { dir, db, run, workspace, objects } = await fixture();
    faults.prior = true;
    try {
        const report = await run(true);
        expect(report.applied).toBe(true);
        expect(report.warnings.some((w) => w.includes('.prior'))).toBe(true);
    } finally {
        faults.prior = false;
    }
    expect(db.prepare("SELECT 1 FROM users WHERE id='admin'").get()).toBeTruthy();
    expect(existsSync(join(dir, 'alice'))).toBe(false);
    const after = space(workspace, dir, objects());
    expect((await after.getFile({ kind: 'user', userId: 'admin' }, 'local.txt')).data.toString()).toBe('LOCAL');
});

it('renames a numeric id without matching integers, and checks it the same way', async () => {
    const { db } = await fixture();
    db.prepare("UPDATE users SET id='1' WHERE id='bob'").run();
    const report = await renameUser({
        db,
        from: '1',
        to: 'one',
        apply: true,
        userDataDir: scratch(),
        files: { box: new SecretBox(KEYS, 'data-files'), tenantId: TENANT, store: () => undefined },
        mcpBox: new SecretBox(KEYS, 'mcp-credentials'),
    });
    expect(report.applied).toBe(true);
    // Integer columns (emailVerified, counters) hold 1 still; no text column does.
    expect(db.prepare('SELECT count(*) AS n FROM auth_user WHERE emailVerified = 1').get()).toEqual({ n: 1 });
    expect(exactMatches(db, '1')).toEqual([]);
    expect(db.prepare("SELECT 1 FROM users WHERE id='one'").get()).toBeTruthy();
});

it('refuses on a dry run when MCP credentials can’t be opened', async () => {
    const { db, run } = await fixture();
    const other = new SecretBox(
        { current: randomBytes(32), legacy: 'another-secret-0123456789abcdef' },
        'mcp-credentials',
    );
    db.prepare("UPDATE mcp_connections SET secret=? WHERE id='m1'").run(
        other.seal({ userId: 'alice', connectionId: 'm1', generation: 1, data: {} }),
    );
    await expect(run(false)).rejects.toThrow(/can't be opened/);
});

it('keeps the first id as the person seed across renames, and back', async () => {
    const { db, run } = await fixture();
    const seeds = () => db.prepare('SELECT userId, seed FROM person_seeds ORDER BY userId').all();
    expect((await run(false)).seed).toBe('alice');
    expect(seeds()).toEqual([]);
    expect((await run(true)).seed).toBe('alice');
    expect(seeds()).toEqual([{ userId: 'admin', seed: 'alice' }]);
    // Kept on purpose: not a leftover.
    expect(exactMatches(db, 'alice')).toEqual([]);
    const again = (from: string, to: string) =>
        renameUser({
            db,
            from,
            to,
            apply: true,
            userDataDir: scratch(),
            files: { box: new SecretBox(KEYS, 'data-files'), tenantId: TENANT, store: () => undefined },
            mcpBox: new SecretBox(KEYS, 'mcp-credentials'),
        });
    db.prepare('DELETE FROM data_files').run();
    db.prepare('DELETE FROM mcp_connections').run();
    expect((await again('admin', 'root')).seed).toBe('alice');
    expect(seeds()).toEqual([{ userId: 'root', seed: 'alice' }]);
    db.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('taken', 'x')").run();
    await expect(again('root', 'taken')).rejects.toThrow(/person seed/);
    db.prepare("DELETE FROM person_seeds WHERE userId='taken'").run();
    // Back to the first id: no seed needed.
    await again('root', 'alice');
    expect(seeds()).toEqual([]);
    // Someone else who later got a retired id keeps a seed of their own when renamed.
    db.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('owner', 'reused')").run();
    workspaceUser(db, 'reused');
    expect((await again('reused', 'other')).seed).toBe('reused:reused');
    expect(seeds()).toContainEqual({ userId: 'other', seed: 'reused:reused' });
});

function workspaceUser(db: DatabaseSync, id: string) {
    db.prepare("INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES (?, ?, 'member', 0, 0)").run(id, id);
}
