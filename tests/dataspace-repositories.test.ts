import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import type { DataFile } from '../src/server/dataspace/contract.js';
import type { DataAuditRecord, DataGrant, NewDataset } from '../src/server/dataspace/domain/repositories.js';
import { sqliteDataSpaceRepositories } from '../src/server/dataspace/infra/sqlite/index.js';
import { dataTables } from '../src/server/dataspace/infra/sqlite/schema.js';
import { dataSchema } from '../src/server/dataspace/migrations.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The data space repository contract (CB-110): what any implementation of
 * `dataspace/domain/repositories.ts` must keep, run against the SQLite one,
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
    migrate(db, [dataSchema]);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteDataSpaceRepositories(data) };
}

const rows = (db: DatabaseSync, sql: string, ...params: string[]) => db.prepare(sql).all(...params);
const one = (db: DatabaseSync, sql: string, ...params: string[]) => db.prepare(sql).get(...params);

const dataset = (fields: Partial<NewDataset> = {}): NewDataset => ({
    id: 'd1',
    ownerUserId: 'alice',
    name: 'Prices',
    description: '',
    createdByDotId: null,
    scratchForDotId: null,
    createdAt: 10,
    updatedAt: 10,
    ...fields,
});

const grant = (fields: Partial<DataGrant> = {}): DataGrant => ({
    id: 'g1',
    ownerUserId: 'alice',
    dotId: 'dot-1',
    datasetId: null,
    folder: 'reports/',
    access: 'read',
    createdBy: 'alice',
    createdAt: 10,
    ...fields,
});

const file = (fields: Partial<DataFile> = {}): DataFile => ({
    id: 'f1',
    ownerUserId: 'alice',
    path: 'reports/a.txt',
    size: 3,
    storedSize: 35,
    mediaType: 'text/plain',
    createdByDotId: null,
    createdAt: 10,
    updatedAt: 10,
    storage: 'local',
    name: null,
    sealKey: 'k1',
    ...fields,
});

const audit = (fields: Partial<DataAuditRecord> = {}): DataAuditRecord => ({
    id: 'a1',
    ownerUserId: 'alice',
    actorKind: 'dot',
    actorId: 'dot-1',
    dotId: 'dot-1',
    datasetId: null,
    target: 'scratch',
    action: 'query',
    outcome: 'ok',
    detail: null,
    createdAt: 10,
    area: null,
    threadId: 't1',
    byUserId: null,
    ...fields,
});

it('mirrors the migrated data space tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, dataTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND name <> 'schema_readers' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(dataTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // Every module's migrations together leave them as mirrored.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, dataTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE data_files ADD COLUMN digest TEXT');
    expect(schemaDrift(db, dataTables)).toEqual([expect.stringContaining('digest')]);
});

it('adds datasets empty, with the migration’s defaults', () => {
    const { db, repos } = context();
    repos.datasets.insertNow(dataset({ description: 'Weekly prices' }));
    expect(one(db, 'SELECT * FROM data_datasets WHERE id=?', 'd1')).toEqual({
        ...dataset({ description: 'Weekly prices' }),
        dotDeletedAt: null,
        sharedSpaceId: null,
        retentionDays: null,
        sizeBytes: 0,
        historyBytes: 0,
        historyDays: null,
        compactRequestedAt: null,
        analyticalBytes: 0,
        tableCount: 0,
        deletedAt: null,
        deletedBy: null,
        deletedWith: null,
        spaceParentId: null,
        spacePosition: null,
        spaceAddedAt: null,
    });
    repos.datasets.updateNow('d1', {
        name: 'Prices 2',
        description: 'Daily',
        retentionDays: 30,
        sharedSpaceId: 'space-1',
    });
    expect(one(db, 'SELECT * FROM data_datasets WHERE id=?', 'd1')).toMatchObject({
        name: 'Prices 2',
        description: 'Daily',
        retentionDays: 30,
        sharedSpaceId: 'space-1',
        // Settings aren't a change to its data.
        updatedAt: 10,
    });
});

it('moves the live datasets under pages that left a Space, keeping their keys (CB-451)', () => {
    const { db, repos } = context();
    const place = (id: string, spaceParentId: string | null, sharedSpaceId = 'space-1') => {
        repos.datasets.insertNow(dataset({ id }));
        repos.datasets.updateNow(id, {
            name: id,
            description: '',
            retentionDays: null,
            historyDays: null,
            sharedSpaceId,
            spaceParentId,
            spacePosition: `k-${id}`,
            spaceAddedAt: 5,
        });
    };
    place('under-a', 'page-a');
    place('under-b', 'page-b');
    place('under-c', 'page-c');
    place('elsewhere', 'page-a', 'space-2');
    place('gone', 'page-a');
    repos.datasets.markDeletedNow('gone', { at: 20, by: 'alice', with: null });
    expect(repos.datasets.reparentNow('space-1', ['page-a', 'page-b'], 'page-root')).toBe(2);
    expect(repos.datasets.reparentNow('space-1', [], null)).toBe(0);
    expect(rows(db, 'SELECT id, spaceParentId, spacePosition FROM data_datasets ORDER BY id')).toEqual([
        { id: 'elsewhere', spaceParentId: 'page-a', spacePosition: 'k-elsewhere' },
        { id: 'gone', spaceParentId: 'page-a', spacePosition: 'k-gone' },
        { id: 'under-a', spaceParentId: 'page-root', spacePosition: 'k-under-a' },
        { id: 'under-b', spaceParentId: 'page-root', spacePosition: 'k-under-b' },
        { id: 'under-c', spaceParentId: 'page-c', spacePosition: 'k-under-c' },
    ]);
});

it('makes one live scratch dataset per user and Dot; a deleted one makes room', () => {
    const { db, repos } = context();
    const scratch = (id: string, ownerUserId = 'alice') => dataset({ id, ownerUserId, scratchForDotId: 'dot-1' });
    expect(repos.datasets.insertScratchNow(scratch('s1'))).toBe(true);
    // Made meanwhile: the first one stays.
    expect(repos.datasets.insertScratchNow(scratch('s2'))).toBe(false);
    // Another user's own.
    expect(repos.datasets.insertScratchNow(scratch('s3', 'bob'))).toBe(true);
    repos.datasets.markDeletedNow('s1', { at: 20, by: 'alice', with: null });
    expect(repos.datasets.insertScratchNow(scratch('s4'))).toBe(true);
    expect(rows(db, 'SELECT id FROM data_datasets WHERE ownerUserId=? AND deletedAt IS NULL', 'alice')).toEqual([
        { id: 's4' },
    ]);
});

it('hides a deleted dataset once, keeps its stamp, and removes only a discarded one', () => {
    const { db, repos } = context();
    repos.datasets.insertNow(dataset());
    repos.datasets.insertNow(dataset({ id: 'd2' }));
    repos.datasets.markDeletedNow('d1', {
        at: 20,
        by: 'system',
        with: 'job:j1',
    });
    repos.datasets.markDeletedNow('d1', { at: 30, by: 'alice', with: null });
    expect(one(db, 'SELECT * FROM data_datasets WHERE id=?', 'd1')).toMatchObject({
        deletedAt: 20,
        deletedBy: 'system',
        deletedWith: 'job:j1',
    });
    repos.datasets.removeNow('d2');
    expect(one(db, 'SELECT id FROM data_datasets WHERE id=?', 'd2')).toBe(undefined);
});

it('marks a deleted Dot’s scratch datasets once', () => {
    const { db, repos } = context();
    repos.datasets.insertScratchNow(dataset({ scratchForDotId: 'dot-1' }));
    repos.datasets.insertScratchNow(dataset({ id: 'd2', ownerUserId: 'bob', scratchForDotId: 'dot-1' }));
    repos.datasets.insertNow(dataset({ id: 'd3', createdByDotId: 'dot-1' }));
    expect(repos.datasets.markDotDeletedNow('dot-1', 50)).toBe(2);
    expect(repos.datasets.markDotDeletedNow('dot-1', 60)).toBe(0);
    expect(rows(db, 'SELECT id, dotDeletedAt FROM data_datasets ORDER BY id')).toEqual([
        { id: 'd1', dotDeletedAt: 50 },
        { id: 'd2', dotDeletedAt: 50 },
        { id: 'd3', dotDeletedAt: null },
    ]);
});

it('records sizes and audit rows at once when the connection is free', () => {
    const { db, repos } = context();
    repos.datasets.insertNow(dataset());
    repos.datasets.recordSizes('d1', { sizeBytes: 4096, historyBytes: 512, tableCount: 2 }, 40);
    expect(
        one(db, 'SELECT sizeBytes, historyBytes, tableCount, updatedAt FROM data_datasets WHERE id=?', 'd1'),
    ).toEqual({
        sizeBytes: 4096,
        historyBytes: 512,
        tableCount: 2,
        updatedAt: 40,
    });
    repos.audit.record(audit());
    expect(rows(db, 'SELECT * FROM data_audit')).toEqual([audit()]);
});

it('queues sizes and audit rows behind another chain’s unit, in order, and keeps them when it fails', async () => {
    const { db, uow, repos } = context();
    repos.datasets.insertNow(dataset());
    let release!: () => void;
    const held = uow.run(
        async () => {
            await new Promise<void>((resolve) => (release = resolve));
            throw new Error('another chain failed');
        },
        { label: 'another chain' },
    );
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    // Neither makes its caller wait, nor writes inside the other unit.
    repos.audit.record(audit({ id: 'a1' }));
    repos.datasets.recordSizes('d1', { sizeBytes: 1, historyBytes: 0, tableCount: 1 }, 41);
    repos.audit.record(audit({ id: 'a2', createdAt: 11 }));
    expect(rows(db, 'SELECT id FROM data_audit')).toEqual([]);
    release();
    await expect(held).rejects.toThrow('another chain failed');
    // A unit started now runs after them.
    await uow.run(async () => {}, { label: 'after the queue' });
    expect(rows(db, 'SELECT id FROM data_audit ORDER BY rowid')).toEqual([{ id: 'a1' }, { id: 'a2' }]);
    expect(one(db, 'SELECT tableCount, updatedAt FROM data_datasets WHERE id=?', 'd1')).toEqual({
        tableCount: 1,
        updatedAt: 41,
    });
});

it('sets a grant per target: the one there keeps its id and creation, and takes the access', () => {
    const { db, repos } = context();
    expect(repos.grants.setNow(grant())).toBe('g1');
    expect(
        repos.grants.setNow(
            grant({
                id: 'g2',
                access: 'write',
                createdBy: 'approval',
                createdAt: 20,
            }),
        ),
    ).toBe('g1');
    expect(rows(db, 'SELECT * FROM data_grants')).toEqual([grant({ access: 'write', createdBy: 'approval' })]);
    // Another target, Dot or user: a grant of its own.
    expect(repos.grants.setNow(grant({ id: 'g3', folder: null, datasetId: 'd1' }))).toBe('g3');
    expect(repos.grants.setNow(grant({ id: 'g4', dotId: 'dot-2' }))).toBe('g4');
    expect(repos.grants.setNow(grant({ id: 'g5', ownerUserId: 'bob' }))).toBe('g5');
    expect(rows(db, 'SELECT id FROM data_grants ORDER BY id')).toHaveLength(4);
});

it('ends a dataset’s and a deleted Dot’s grants, saying which', () => {
    const { db, repos } = context();
    repos.grants.setNow(grant({ id: 'g1', datasetId: 'd1', folder: null }));
    repos.grants.setNow(grant({ id: 'g2', datasetId: 'd1', folder: null, dotId: 'dot-2' }));
    repos.grants.setNow(grant({ id: 'g3', ownerUserId: 'bob' }));
    repos.grants.setNow(grant({ id: 'g4', folder: 'other/' }));
    expect(repos.grants.removeForDatasetNow('d1').map((g) => [g.id, g.dotId, g.access])).toEqual([
        ['g1', 'dot-1', 'read'],
        ['g2', 'dot-2', 'read'],
    ]);
    expect(repos.grants.removeForDatasetNow('d1')).toEqual([]);
    expect(repos.grants.removeForDotNow('dot-1').sort()).toEqual(['alice', 'bob']);
    expect(rows(db, 'SELECT id FROM data_grants')).toEqual([]);
});

it('revokes only the user’s own grant', async () => {
    const { repos } = context();
    repos.grants.setNow(grant());
    expect(await repos.grants.remove('bob', 'g1')).toBeUndefined();
    expect(await repos.grants.remove('alice', 'g1')).toEqual(grant());
    expect(await repos.grants.remove('alice', 'g1')).toBeUndefined();
});

it('moves folder grants by folder, merging into one already there, and ends them under a folder only', async () => {
    const { db, repos } = context();
    repos.grants.setNow(grant({ id: 'g1', folder: 'a/b/', access: 'write' }));
    repos.grants.setNow(grant({ id: 'g2', folder: 'a/b/x/' }));
    repos.grants.setNow(grant({ id: 'g3', folder: 'z/' }));
    repos.grants.setNow(grant({ id: 'g4', folder: 'ab/' }));
    repos.grants.setNow(grant({ id: 'g5', folder: 'a/b/', ownerUserId: 'bob' }));
    const moved = await repos.grants.moveFolders('alice', 'a/b/', 'z/');
    expect(moved.map((g) => [g.id, g.folder, g.to, g.mergedInto])).toEqual([
        ['g1', 'a/b/', 'z/', 'read'],
        ['g2', 'a/b/x/', 'z/x/', undefined],
    ]);
    expect(
        rows(db, 'SELECT id, folder, access, createdAt FROM data_grants WHERE ownerUserId=? ORDER BY folder', 'alice'),
    ).toEqual([
        { id: 'g4', folder: 'ab/', access: 'read', createdAt: 10 },
        { id: 'g3', folder: 'z/', access: 'read', createdAt: 10 },
        { id: 'g2', folder: 'z/x/', access: 'read', createdAt: 10 },
    ]);
    // `z/` and under it, never `ab/` or another user's.
    expect((await repos.grants.removeUnder('alice', 'z/')).map((g) => g.id)).toEqual(['g3', 'g2']);
    expect(await repos.grants.removeUnder('alice', 'a/')).toEqual([]);
    expect(rows(db, 'SELECT id FROM data_grants ORDER BY id')).toEqual([{ id: 'g4' }, { id: 'g5' }]);
});

it('reads live files, and deleted ones only when asked', async () => {
    const { repos } = context();
    await repos.files.insert(file());
    const stored = {
        ...file(),
        deletedAt: null,
        deletedBy: null,
        deletedWith: null,
    };
    expect(await repos.files.at('alice', 'reports/a.txt')).toEqual(stored);
    expect(await repos.files.at('bob', 'reports/a.txt')).toBeUndefined();
    expect(await repos.files.byId('f1')).toEqual(stored);
    await repos.files.markDeleted('f1', { at: 20, by: 'dot:dot-1', with: null });
    await repos.files.markDeleted('f1', { at: 30, by: 'alice', with: null });
    expect(await repos.files.at('alice', 'reports/a.txt')).toBeUndefined();
    expect(await repos.files.byId('f1')).toBeUndefined();
    expect(await repos.files.withDeleted('f1')).toMatchObject({
        deletedAt: 20,
        deletedBy: 'dot:dot-1',
    });
    // The path is free again; a version is born deleted.
    await repos.files.insert(file({ id: 'f2' }));
    await repos.files.insert(
        file({
            id: 'v1',
            deletedAt: 25,
            deletedBy: 'alice',
            deletedWith: 'file:f2',
        }),
    );
    expect((await repos.files.at('alice', 'reports/a.txt'))?.id).toBe('f2');
});

it('replaces, retypes and moves a file, keeping its display name unless told', async () => {
    const { repos } = context();
    await repos.files.insert(file({ name: 'Report A.txt' }));
    await repos.files.replaceContent(
        'f1',
        {
            size: 5,
            storedSize: 37,
            mediaType: 'text/markdown',
            storage: 's3',
            sealKey: 'k2',
        },
        null,
        20,
    );
    expect(await repos.files.byId('f1')).toMatchObject({
        size: 5,
        storedSize: 37,
        mediaType: 'text/markdown',
        storage: 's3',
        sealKey: 'k2',
        name: 'Report A.txt',
        updatedAt: 20,
    });
    await repos.files.retype('f1', 'text/plain', 'A.txt', 30);
    expect(await repos.files.byId('f1')).toMatchObject({
        size: 5,
        mediaType: 'text/plain',
        name: 'A.txt',
        updatedAt: 30,
    });
    await repos.files.move('f1', 'reports/old/a.txt', 40, false);
    expect(await repos.files.byId('f1')).toMatchObject({
        path: 'reports/old/a.txt',
        name: 'A.txt',
        updatedAt: 40,
    });
    await repos.files.move('f1', 'reports/b.txt', 50, true);
    expect(await repos.files.byId('f1')).toMatchObject({
        path: 'reports/b.txt',
        name: null,
    });
});

it('moves a folder’s live files only', async () => {
    const { repos } = context();
    await repos.files.insert(file({ id: 'f1', path: 'a/1.txt' }));
    await repos.files.insert(file({ id: 'f2', path: 'a/b/2.txt' }));
    await repos.files.insert(file({ id: 'f3', path: 'ab/3.txt' }));
    await repos.files.insert(file({ id: 'f4', path: 'a/4.txt', deletedAt: 5, deletedBy: 'alice' }));
    const under = await repos.files.under('alice', 'a/');
    expect(under).toEqual([
        { id: 'f1', path: 'a/1.txt' },
        { id: 'f2', path: 'a/b/2.txt' },
    ]);
    await repos.files.moveLive(
        [...under, { id: 'f4', path: 'a/4.txt' }].map((row) => ({
            id: row.id,
            path: `z/${row.path.slice(2)}`,
        })),
        60,
    );
    expect(await repos.files.under('alice', 'z/')).toEqual([
        { id: 'f1', path: 'z/1.txt' },
        { id: 'f2', path: 'z/b/2.txt' },
    ]);
    expect(await repos.files.withDeleted('f4')).toMatchObject({
        path: 'a/4.txt',
        updatedAt: 10,
    });
});

it('marks a file moved to S3 only while it is local, deleted or not, and records a new seal', async () => {
    const { repos } = context();
    await repos.files.insert(file({ id: 'f1' }));
    await repos.files.insert(file({ id: 'f2', path: 'reports/b.txt', deletedAt: 5, deletedBy: 'alice' }));
    await repos.files.insert(file({ id: 'f3', path: 'reports/c.txt', storage: 's3' }));
    for (const id of ['f1', 'f2', 'f3']) {
        await repos.files.markMoved(id, 's3');
    }
    expect(await repos.files.withDeleted('f2')).toMatchObject({ storage: 's3' });
    expect(await repos.files.byId('f1')).toMatchObject({
        storage: 's3',
        updatedAt: 10,
    });
    // One already moved isn't marked again (a local → local no-op stays one).
    await repos.files.markMoved('f3', 'local');
    expect(await repos.files.byId('f3')).toMatchObject({ storage: 's3' });
    await repos.files.recordSeal('f2', 'k9', 77);
    expect(await repos.files.withDeleted('f2')).toMatchObject({
        sealKey: 'k9',
        storedSize: 77,
        updatedAt: 10,
    });
});

it('rolls a unit’s file and grant writes back together', async () => {
    const { uow, repos } = context();
    repos.grants.setNow(grant({ folder: 'a/' }));
    await repos.files.insert(file({ path: 'a/1.txt' }));
    await expect(
        uow.run(async () => {
            await repos.files.moveLive([{ id: 'f1', path: 'z/1.txt' }], 20);
            await repos.grants.moveFolders('alice', 'a/', 'z/');
            await repos.files.insert(file({ id: 'f2', path: 'z/2.txt' }));
            throw new Error('nope');
        }),
    ).rejects.toThrow('nope');
    expect((await repos.files.byId('f1'))?.path).toBe('a/1.txt');
    expect(await repos.files.byId('f2')).toBeUndefined();
    expect((await repos.grants.remove('alice', 'g1'))?.folder).toBe('a/');
});
