import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';

import { ATTEMPTS_PER_APP } from '../src/server/apps/domain/attempts.js';
import type { AppRegistration, AppVersion } from '../src/server/apps/domain/repositories.js';
import { sqliteAppRepositories } from '../src/server/apps/infra/sqlite/index.js';
import { appsTables } from '../src/server/apps/infra/sqlite/schema.js';
import { appsSchema } from '../src/server/apps/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The mini apps repository contract (CB-110): what any implementation of
 * `apps/domain/repositories.ts` must keep, run against the SQLite one,
 * and the drift check of its Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function context() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [appsSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteAppRepositories(data) };
}

const registration = (fields: Partial<AppRegistration> = {}): AppRegistration => ({
    id: 'tracker-alice',
    slug: 'tracker',
    name: 'Tracker',
    description: 'Tracks things.',
    dotId: 'dot-1',
    ownerUserId: 'alice',
    port: 3000,
    datasets: ['scratch'],
    startCommand: 'bun run server.ts',
    createdAt: 10,
    updatedAt: 10,
    ...fields,
});

const version = (fields: Partial<AppVersion> = {}): AppVersion => ({
    appId: 'tracker-alice',
    version: 1,
    manifest: {
        name: 'Tracker',
        description: '',
        entry: 'server.ts',
        datasets: [{ id: 'scratch', access: 'write' }],
        egress: [],
    } as unknown as AppVersion['manifest'],
    bundlePath: 'apps/tracker-alice/bundles/v1.cbapp',
    sha256: 'abc',
    sizeBytes: 12,
    files: 1,
    fileList: [{ path: 'server.ts', size: 12, sha256: 'def' }],
    createdByDotId: 'dot-1',
    createdAt: 20,
    ...fields,
});

const attempt = (n: number, fields: Partial<RuntimeAttempt> = {}): RuntimeAttempt => ({
    id: `boot:${n}`,
    version: 1,
    kind: 'start',
    state: 'failed',
    startedAt: n,
    upAt: null,
    endedAt: n,
    exit: { reason: 'exit', code: 1, signal: null, message: `Ended ${n}.` },
    lines: [`line ${n}`],
    dropped: 0,
    ...fields,
});

/** The stored app, as raw rows: the registry's sync reads see these. */
const row = (db: DatabaseSync, id: string) =>
    db.prepare('SELECT * FROM apps WHERE id=?').get(id) as Record<string, unknown> | undefined;

it('mirrors the migrated apps tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, appsTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(8);
    expect(appsTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, appsTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE app_grants ADD COLUMN note TEXT');
    expect(schemaDrift(db, appsTables)).toEqual([expect.stringContaining('note')]);
});

it('registers an app, and re-registering keeps all but its details', async () => {
    const { db, repos } = context();
    await repos.apps.register(registration());
    expect(row(db, 'tracker-alice')).toEqual({
        id: 'tracker-alice',
        slug: 'tracker',
        name: 'Tracker',
        description: 'Tracks things.',
        dotId: 'dot-1',
        ownerUserId: 'alice',
        port: 3000,
        datasets: '["scratch"]',
        public: 0,
        sharedSpaceId: null,
        startCommand: 'bun run server.ts',
        status: 'ephemeral',
        liveVersion: null,
        previousVersion: null,
        config: '{}',
        promotedAt: null,
        createdAt: 10,
        updatedAt: 10,
        deletedAt: null,
        deletedBy: null,
        deletedWith: null,
        deletedLabel: null,
    });
    await repos.apps.setStatus('tracker-alice', 'packaged', 15);
    await repos.apps.share('tracker-alice', 'space-1', 16);
    await repos.apps.register(
        registration({
            slug: 'ignored',
            name: 'Tracker 2',
            description: 'Better.',
            port: 3001,
            datasets: ['ds-1', 'scratch'],
            startCommand: null,
            createdAt: 99,
            updatedAt: 30,
        }),
    );
    expect(row(db, 'tracker-alice')).toMatchObject({
        slug: 'tracker',
        name: 'Tracker 2',
        description: 'Better.',
        port: 3001,
        datasets: '["ds-1","scratch"]',
        startCommand: null,
        status: 'packaged',
        sharedSpaceId: 'space-1',
        createdAt: 10,
        updatedAt: 30,
    });
});

it('finds the live development app holding a port on a computer', async () => {
    const { repos } = context();
    await repos.apps.register(registration());
    expect(await repos.apps.portHolder('dot-1', 3000, 'other')).toBe('tracker-alice');
    // Itself, another port or computer: free.
    expect(await repos.apps.portHolder('dot-1', 3000, 'tracker-alice')).toBeUndefined();
    expect(await repos.apps.portHolder('dot-1', 3001, 'other')).toBeUndefined();
    expect(await repos.apps.portHolder('dot-2', 3000, 'other')).toBeUndefined();
    // Packaged still counts; promoted runs in the runtime, not the computer.
    await repos.apps.setStatus('tracker-alice', 'packaged', 11);
    expect(await repos.apps.portHolder('dot-1', 3000, 'other')).toBe('tracker-alice');
    await repos.apps.setStatus('tracker-alice', 'promoted', 12);
    expect(await repos.apps.portHolder('dot-1', 3000, 'other')).toBeUndefined();
    await repos.apps.setStatus('tracker-alice', 'ephemeral', 13);
    await repos.apps.retire('tracker-alice', 'deleted-1', {
        at: 14,
        by: 'alice',
        with: null,
    });
    expect(await repos.apps.portHolder('dot-1', 3000, 'other')).toBeUndefined();
});

it('promotes, sets versions and retires an app under a new id', async () => {
    const { db, repos } = context();
    await repos.apps.register(registration());
    await repos.apps.setVersions('tracker-alice', 1, 9, 15);
    await repos.apps.promote('tracker-alice', { version: 2, config: { TITLE: 'Hi' } }, 20);
    expect(row(db, 'tracker-alice')).toMatchObject({
        status: 'promoted',
        liveVersion: 2,
        previousVersion: null,
        config: '{"TITLE":"Hi"}',
        promotedAt: 20,
        updatedAt: 20,
    });
    await repos.apps.setVersions('tracker-alice', 3, 2, 30);
    expect(row(db, 'tracker-alice')).toMatchObject({
        liveVersion: 3,
        previousVersion: 2,
        updatedAt: 30,
    });
    await repos.apps.retire('tracker-alice', 'deleted-1', {
        at: 40,
        by: 'alice',
        with: 'dot:dot-1',
    });
    expect(row(db, 'tracker-alice')).toBeUndefined();
    expect(row(db, 'deleted-1')).toMatchObject({
        deletedLabel: 'tracker-alice',
        deletedAt: 40,
        deletedBy: 'alice',
        deletedWith: 'dot:dot-1',
        updatedAt: 30,
    });
    // Deleted already: it stays under the id it is kept under.
    await repos.apps.retire('deleted-1', 'deleted-2', {
        at: 50,
        by: 'alice',
        with: null,
    });
    expect(row(db, 'deleted-2')).toBeUndefined();
});

it('keeps sessions by hash and ends them by app, person or one', async () => {
    const { repos } = context();
    const session = (hash: string, appId: string, userId: string, at = 10) => ({
        hash,
        appId,
        userId,
        createdAt: at,
        expiresAt: at + 100,
    });
    await repos.sessions.add(session('h1', 'a', 'alice'), 10);
    await repos.sessions.add(session('h2', 'a', 'bob'), 10);
    await repos.sessions.add(session('h3', 'b', 'bob'), 10);
    expect(await repos.sessions.byHash('h1')).toEqual(session('h1', 'a', 'alice'));
    expect(await repos.sessions.countLive('a', 50)).toBe(2);
    expect(await repos.sessions.countLive('a', 110)).toBe(0);
    // A new one forgets every expired one.
    await repos.sessions.add(session('h4', 'b', 'carol', 110), 110);
    expect(await repos.sessions.byHash('h1')).toBeUndefined();
    expect(await repos.sessions.countLive('b', 120)).toBe(1);
    for (const item of [
        session('h1', 'a', 'alice', 120),
        session('h2', 'a', 'bob', 120),
        session('h3', 'b', 'bob', 120),
    ]) {
        await repos.sessions.add(item, 120);
    }
    await repos.sessions.removeForAppExcept('a', 'alice');
    expect(await repos.sessions.byHash('h2')).toBeUndefined();
    expect(await repos.sessions.byHash('h1')).toBeDefined();
    await repos.sessions.remove('h1');
    expect(await repos.sessions.countLive('a', 130)).toBe(0);
    await repos.sessions.add(session('h5', 'a', 'bob', 120), 120);
    expect(await repos.sessions.removeOf('bob')).toEqual({
        apps: expect.arrayContaining(['a', 'b']),
        ended: 2,
    });
    expect(await repos.sessions.removeOf('bob')).toEqual({ apps: [], ended: 0 });
    await repos.sessions.removeForApp('b');
    expect(await repos.sessions.byHash('h4')).toBeUndefined();
});

it('keeps versions with their manifests and re-keys the listed ones', async () => {
    const { repos } = context();
    await repos.versions.add(version({ version: 2, createdAt: 30 }));
    await repos.versions.add(version());
    await repos.versions.add(version({ appId: 'other' }));
    const versions = await repos.versions.forApp('tracker-alice');
    expect(versions.map((item) => item.version)).toEqual([1, 2]);
    expect(versions[0]).toEqual(version());
    await expect(repos.versions.add(version())).rejects.toThrow();
    await repos.versions.rekey('tracker-alice', 'deleted-1', [
        { version: 1, bundlePath: 'apps/deleted-1/bundles/v1.cbapp' },
    ]);
    expect(await repos.versions.forApp('deleted-1')).toEqual([
        version({
            appId: 'deleted-1',
            bundlePath: 'apps/deleted-1/bundles/v1.cbapp',
        }),
    ]);
    expect((await repos.versions.forApp('tracker-alice')).map((item) => item.version)).toEqual([2]);
});

it('replaces an app’s grants as a whole, the last per dataset winning', async () => {
    const { repos } = context();
    const grant = (datasetId: string, ref: string, createdByPromotion = false) =>
        ({ datasetId, ref, access: 'read', createdByPromotion }) as const;
    await repos.grants.replace('a', [grant('d1', 'one', true)], 10);
    await repos.grants.replace('b', [grant('d1', 'one')], 10);
    await repos.grants.replace('a', [grant('d2', 'b-ref'), grant('d3', 'a-ref'), grant('d2', 'again', true)], 20);
    expect(await repos.grants.forApp('a')).toEqual([
        {
            appId: 'a',
            datasetId: 'd3',
            ref: 'a-ref',
            access: 'read',
            createdByPromotion: false,
            createdAt: 20,
        },
        {
            appId: 'a',
            datasetId: 'd2',
            ref: 'again',
            access: 'read',
            createdByPromotion: true,
            createdAt: 20,
        },
    ]);
    await repos.grants.rekey('a', 'deleted-1');
    expect(await repos.grants.forApp('a')).toEqual([]);
    expect((await repos.grants.forApp('deleted-1')).map((g) => g.datasetId)).toEqual(['d3', 'd2']);
    expect(await repos.grants.forApp('b')).toHaveLength(1);
    await repos.grants.replace('b', [], 30);
    expect(await repos.grants.forApp('b')).toEqual([]);
});

it('keeps the newest attempts per app, running ones whatever their age', async () => {
    const { db, repos } = context();
    const many = Array.from({ length: ATTEMPTS_PER_APP + 3 }, (_, i) =>
        attempt(i + 1, i === 0 ? { state: 'running', exit: null } : {}),
    );
    await repos.attempts.sync('app', 'boot', many);
    const numbers = (
        db.prepare('SELECT attempt FROM app_attempts WHERE appId=? ORDER BY attempt').all('app') as Array<{
            attempt: number;
        }>
    ).map((item) => item.attempt);
    // The first is running (kept); the next two are past the ceiling.
    expect(numbers[0]).toBe(1);
    expect(numbers[1]).toBe(4);
    expect(numbers).toHaveLength(ATTEMPTS_PER_APP + 1);
});

it('prunes as the retention says: older than its days and past its count', async () => {
    const { db, repos } = context();
    const day = 86_400_000;
    const now = 100 * day;
    // App a: 8 attempts, ended a day apart, the oldest still running; app b:
    // 2 old ones, within the count; app c: a recent one.
    await repos.attempts.sync(
        'a',
        'boot',
        Array.from({ length: 8 }, (_, i) =>
            attempt(i + 1, {
                startedAt: (90 + i) * day,
                endedAt: i === 0 ? null : (90 + i) * day + 1,
                ...(i === 0 ? { state: 'running', exit: null } : {}),
            }),
        ),
        now,
    );
    await repos.attempts.sync('b', 'boot', [attempt(1, { startedAt: day }), attempt(2, { startedAt: 2 * day })], now);
    await repos.attempts.sync('c', 'boot', [attempt(1, { startedAt: now })], now);
    const retention = { days: 5, attempts: 2 };
    // What the window-function DELETE this replaces would have dropped.
    const expected = db
        .prepare(
            `SELECT appId, attempt FROM app_attempts WHERE state<>'running' AND COALESCE(endedAt, startedAt) < ? AND EXISTS (SELECT 1 FROM (SELECT appId, attempt, ROW_NUMBER() OVER (PARTITION BY appId ORDER BY attempt DESC) AS n FROM app_attempts) AS ranked WHERE ranked.appId=app_attempts.appId AND ranked.attempt=app_attempts.attempt AND ranked.n > ?) ORDER BY appId, attempt`,
        )
        .all(now - retention.days * day, retention.attempts)
        .map((item) => `${String(item.appId)}:${Number(item.attempt)}`);
    expect(expected).toEqual(['a:2', 'a:3', 'a:4', 'a:5']);
    expect(await repos.attempts.prune(retention, now)).toBe(expected.length);
    const left = db
        .prepare('SELECT appId, attempt FROM app_attempts ORDER BY appId, attempt')
        .all()
        .map((item) => `${String(item.appId)}:${Number(item.attempt)}`);
    expect(left).toEqual(['a:1', 'a:6', 'a:7', 'a:8', 'b:1', 'b:2', 'c:1']);
    expect(await repos.attempts.prune(retention, now)).toBe(0);
});

it('finds attempts, counts OOMs per socio and re-keys them', async () => {
    const { repos } = context();
    await repos.apps.register(registration());
    await repos.attempts.sync('tracker-alice', 'boot', [
        attempt(1, {
            exit: { reason: 'oom', code: null, signal: null, message: 'OOM' },
        }),
        attempt(2, { version: 2, endedAt: null, state: 'running', exit: null }),
        attempt(3, {
            exit: { reason: 'oom', code: null, signal: null, message: 'OOM' },
        }),
    ]);
    expect((await repos.attempts.find('tracker-alice'))?.attempt).toBe(3);
    expect((await repos.attempts.find('tracker-alice', { version: 2 }))?.attempt).toBe(2);
    expect(await repos.attempts.find('tracker-alice', { attempt: 1 })).toMatchObject({
        attempt: 1,
        reason: 'oom',
        lines: ['line 1'],
    });
    expect(await repos.attempts.find('tracker-alice', { attempt: 9 })).toBeUndefined();
    expect((await repos.attempts.list('tracker-alice', 2)).map((item) => item.attempt)).toEqual([3, 2]);
    expect(await repos.attempts.oomsByDot(0, 100)).toEqual([{ dotId: 'dot-1', count: 2, lastAt: 3 }]);
    expect(await repos.attempts.oomsByDot(2, 3)).toEqual([]);
    await repos.attempts.rekey('tracker-alice', 'deleted-1');
    expect(await repos.attempts.list('tracker-alice')).toEqual([]);
    expect(await repos.attempts.list('deleted-1')).toHaveLength(3);
});

it('rolls back every repository write in a failed unit of work', async () => {
    const { db, uow, repos } = context();
    await expect(
        uow.run(
            async () => {
                await repos.apps.register(registration());
                await repos.versions.add(version());
                await repos.grants.replace(
                    'tracker-alice',
                    [
                        {
                            datasetId: 'd1',
                            ref: 'one',
                            access: 'read',
                            createdByPromotion: true,
                        },
                    ],
                    10,
                );
                await repos.attempts.sync('tracker-alice', 'boot', [attempt(1)]);
                throw new Error('Nope');
            },
            { label: 'promote' },
        ),
    ).rejects.toThrow('Nope');
    expect(row(db, 'tracker-alice')).toBeUndefined();
    expect(await repos.versions.forApp('tracker-alice')).toEqual([]);
    expect(await repos.grants.forApp('tracker-alice')).toEqual([]);
    expect(await repos.attempts.list('tracker-alice')).toEqual([]);
    expect(db.isTransaction).toBe(false);
});
