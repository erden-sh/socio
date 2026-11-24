import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { backupUserData } from '@socio/data/backup';
import { DataError } from '@socio/foundation/dataspace/data-error';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { DatasetEngine, MAX_INDEXES } from '../src/server/dataspace/engine.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { guardWrites } from '../src/server/dataspace/sql.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/** Secondary indexes on datasets (CB-355). */

const MB = 1024 * 1024;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function engineFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-indexes-'));
    const runner = new QueryRunner();
    const engine = new DatasetEngine(runner);
    cleanup.push(() => {
        runner.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, 'd.sqlite');
    engine.create(path);
    // The shape of the case that timed out on a deployment: observations checked
    // against snapshots by listing, with no index leading on listing_id.
    engine.createTable(
        path,
        {
            table: 'observations',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'listing_id', type: 'TEXT' },
            ],
        },
        10 * MB,
    );
    engine.createTable(
        path,
        {
            table: 'snapshots',
            columns: [
                { name: 'taken_at', type: 'TEXT' },
                { name: 'listing_id', type: 'TEXT' },
                { name: 'rating', type: 'REAL' },
            ],
        },
        10 * MB,
    );
    engine.insert(
        path,
        'observations',
        Array.from({ length: 200 }, (_, i) => ({ id: i, listing_id: `l${i % 50}` })),
        10 * MB,
    );
    engine.insert(
        path,
        'snapshots',
        Array.from({ length: 100 }, (_, i) => ({ taken_at: `2026-11-0${i % 9}`, listing_id: `l${i}`, rating: i })),
        10 * MB,
    );
    return { dir, engine, path };
}

const SLOW =
    'SELECT count(*) FROM observations o WHERE EXISTS (SELECT 1 FROM snapshots d WHERE d.listing_id = o.listing_id)';
const SNAPSHOT_LOOKUP = "SELECT rating FROM snapshots d WHERE listing_id = 'l1'";
const plan = (path: string, sql: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
            .map((row) => row.detail)
            .join('\n');
    } finally {
        db.close();
    }
};

it('creates a declared index the query planner uses, and lists it with the table', async () => {
    const { engine, path } = engineFixture();
    // Without it, every run scans, or builds a throwaway automatic index.
    expect(plan(path, SLOW)).toMatch(/SCAN d\b|AUTOMATIC/);
    expect(plan(path, SNAPSHOT_LOOKUP)).toBe('SCAN d');
    expect(
        engine.createIndex(
            path,
            'snapshots',
            { name: 'snapshots_by_listing', columns: ['listing_id', 'taken_at'] },
            10 * MB,
        ),
    ).toEqual({
        created: true,
        table: 'snapshots',
        index: 'snapshots_by_listing',
        columns: ['listing_id', 'taken_at'],
        unique: false,
    });
    expect(plan(path, SLOW)).toMatch(/SEARCH d (EXISTS )?USING COVERING INDEX snapshots_by_listing \(listing_id=\?\)/);
    expect(plan(path, SNAPSHOT_LOOKUP)).toBe('SEARCH d USING INDEX snapshots_by_listing (listing_id=?)');
    // The data API's queries (read-only, in the runner) get the same answer.
    const result = await engine.query(path, SLOW, [], { maxRows: 10, maxBytes: 65536, timeoutMs: 5000 });
    expect(result.rows).toEqual([[200]]);
    const snapshots = engine.tables(path).find((table) => table.name === 'snapshots')!;
    expect(snapshots.indexes).toEqual([
        { name: 'snapshots_by_listing', columns: ['listing_id', 'taken_at'], unique: false },
    ]);
    // A PRIMARY KEY's own index isn't a declared one.
    expect(engine.tables(path).find((table) => table.name === 'observations')!.indexes).toEqual([]);
    // Quietly again with ifNotExists and the same definition; a conflict otherwise.
    expect(
        engine.createIndex(
            path,
            'snapshots',
            { name: 'snapshots_by_listing', columns: ['listing_id', 'taken_at'], ifNotExists: true },
            10 * MB,
        ),
    ).toMatchObject({ created: false });
    expect(() =>
        engine.createIndex(
            path,
            'snapshots',
            { name: 'snapshots_by_listing', columns: ['rating'], ifNotExists: true },
            10 * MB,
        ),
    ).toThrow(/exists already/);
    expect(() =>
        engine.createIndex(path, 'snapshots', { name: 'again', columns: ['LISTING_ID', 'taken_at'] }, 10 * MB),
    ).toThrow(/already has this index, as "snapshots_by_listing"/);
    // Dropping it gives the plan its scan back.
    expect(engine.dropIndex(path, 'snapshots', 'snapshots_by_listing')).toEqual({
        dropped: true,
        table: 'snapshots',
        index: 'snapshots_by_listing',
    });
    // Without it, every run scans, or builds a throwaway automatic index.
    expect(plan(path, SLOW)).toMatch(/SCAN d\b|AUTOMATIC/);
    expect(plan(path, SNAPSHOT_LOOKUP)).toBe('SCAN d');
    expect(() => engine.dropIndex(path, 'snapshots', 'snapshots_by_listing')).toThrow(/No index/);
});

it('validates names and columns against the schema, and caps indexes per table', () => {
    const { engine, path } = engineFixture();
    const create = (index: Parameters<DatasetEngine['createIndex']>[2], table = 'snapshots') =>
        engine.createIndex(path, table, index, 10 * MB);
    const refused = (index: Parameters<DatasetEngine['createIndex']>[2], message: RegExp, table = 'snapshots') => {
        let error: unknown;
        try {
            create(index, table);
        } catch (caught) {
            error = caught;
        }
        expect(error, JSON.stringify(index)).toBeInstanceOf(DataError);
        expect((error as Error).message).toMatch(message);
    };
    refused({ name: 'x', columns: ['nope'] }, /Column "nope" is not in "snapshots"/);
    refused({ name: 'x', columns: ['rating', 'Rating'] }, /each column once/);
    refused({ name: 'bad name', columns: ['rating'] }, /Invalid index name/);
    refused({ name: 'x"; DROP TABLE snapshots; --', columns: ['rating'] }, /Invalid index name/);
    refused({ name: 'x', columns: ['rating) WHERE (1'] }, /Invalid column name/);
    refused({ name: 'sqlite_autoindex_snapshots_9', columns: ['rating'] }, /Invalid index name/);
    for (const name of ['_history_x', '_deleted_x', '_keep_x', '_writes']) {
        refused({ name, columns: ['rating'] }, /reserved/);
    }
    // Names are one namespace per dataset: a table's, or another table's index.
    refused({ name: 'observations', columns: ['rating'] }, /taken in this dataset \(by a table\)/);
    create({ name: 'by_listing', columns: ['listing_id'] }, 'observations');
    refused({ name: 'BY_LISTING', columns: ['rating'] }, /taken in this dataset \(by a index on "observations"\)/);
    refused({ name: 'x', columns: ['rating'] }, /No table "nope"/, 'nope');
    refused({ name: 'x', columns: ['rating'] }, /No table "_writes"/, '_writes');
    // An index of another table can't be dropped through this one.
    expect(() => engine.dropIndex(path, 'snapshots', 'by_listing')).toThrow(/No index/);
    // Every ordered pick of the table's columns is a different index.
    const columns = ['taken_at', 'listing_id', 'rating'];
    const orders: string[][] = [];
    const pick = (chosen: string[]) => {
        if (chosen.length) {
            orders.push(chosen);
        }
        for (const column of columns.filter((name) => !chosen.includes(name))) {
            pick([...chosen, column]);
        }
    };
    pick([]);
    for (const [i, order] of orders.slice(0, MAX_INDEXES).entries()) {
        create({ name: `i${i}`, columns: order });
    }
    refused({ name: 'one_more', columns: orders[MAX_INDEXES] }, /at most 10 indexes/);
    // The other table's count is its own.
    create({ name: 'by_listing_and_id', columns: ['listing_id', 'id'] }, 'observations');
});

it('enforces a unique index and lets upserts key on it', () => {
    const { engine, path } = engineFixture();
    expect(() =>
        engine.createIndex(
            path,
            'observations',
            { name: 'one_per_listing', columns: ['listing_id'], unique: true },
            10 * MB,
        ),
    ).toThrow(/UNIQUE constraint failed/);
    engine.createIndex(path, 'snapshots', { name: 'one_per_listing', columns: ['listing_id'], unique: true }, 10 * MB);
    expect(engine.tables(path).find((table) => table.name === 'snapshots')!.indexes).toEqual([
        { name: 'one_per_listing', columns: ['listing_id'], unique: true },
    ]);
    expect(() => engine.insert(path, 'snapshots', [{ listing_id: 'l1' }], 10 * MB)).toThrow(/UNIQUE/);
    engine.insert(path, 'snapshots', [{ listing_id: 'l1', rating: 4.5 }], 10 * MB, ['listing_id']);
    expect(engine.tables(path).find((table) => table.name === 'snapshots')!.rowCount).toBe(100);
});

it('counts an index toward the quota', () => {
    const { engine, path } = engineFixture();
    const before = engine.sizes(path);
    expect(() =>
        engine.createIndex(path, 'snapshots', { name: 'big', columns: ['taken_at', 'listing_id'] }, before.sizeBytes),
    ).toThrow(/full/);
    expect(engine.tables(path).find((table) => table.name === 'snapshots')!.indexes).toEqual([]);
    engine.createIndex(path, 'snapshots', { name: 'big', columns: ['taken_at', 'listing_id'] }, 10 * MB);
    expect(engine.sizes(path).sizeBytes).toBeGreaterThan(before.sizeBytes);
    expect(engine.sizes(path).historyBytes).toBe(before.historyBytes);
});

it('keeps arbitrary index DDL out of every other write mode', () => {
    const { engine, path } = engineFixture();
    // A UNIQUE column's automatic index: SQLite's own, never a declared one.
    engine.createTable(path, { table: 'tagged', columns: [{ name: 'tag', unique: true }] }, 10 * MB);
    const autoindex = 'sqlite_autoindex_tagged_1';
    const exists = () => {
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
            return !!reader.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(autoindex);
        } finally {
            reader.close();
        }
    };
    expect(exists()).toBe(true);
    expect(engine.tables(path).find((table) => table.name === 'tagged')!.indexes).toEqual([]);
    expect(() => engine.dropIndex(path, 'tagged', autoindex)).toThrow(/Invalid index name/);
    const db = new DatabaseSync(path);
    cleanup.push(() => db.close());
    const as = guardWrites(db);
    expect(() => as('index', () => db.exec(`DROP INDEX ${autoindex}`))).toThrow(/not authorized|cannot be dropped/);
    expect(exists()).toBe(true);
    for (const mode of ['ddl', 'dml'] as const) {
        expect(() => as(mode, () => db.exec('CREATE INDEX sneaky ON snapshots (rating)')), mode).toThrow(
            /not authorized/,
        );
    }
    // The index mode makes and drops indexes on dataset tables, nothing else.
    as('index', () => db.exec('CREATE INDEX fine ON snapshots (rating)'));
    for (const sql of [
        'CREATE TABLE t (a)',
        'DROP TABLE snapshots',
        'DELETE FROM snapshots',
        'INSERT INTO snapshots (rating) VALUES (1)',
        'CREATE INDEX h ON _writes (actor)',
        'CREATE INDEX h ON _history_snapshots (rating)',
        'CREATE TRIGGER x AFTER INSERT ON snapshots BEGIN SELECT 1; END',
        'CREATE VIEW v AS SELECT 1',
    ]) {
        expect(() => as('index', () => db.exec(sql)), sql).toThrow(/not authorized/);
    }
    as('index', () => db.exec('DROP INDEX fine'));
});

it('drops a deleted table’s indexes, so a new table takes the name and the index names', () => {
    const { engine, path } = engineFixture();
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    engine.deleteTable(path, 'snapshots');
    engine.createTable(path, { table: 'snapshots', columns: [{ name: 'listing_id' }] }, 10 * MB);
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    expect(engine.tables(path).find((table) => table.name === 'snapshots')!.indexes).toEqual([
        { name: 'by_listing', columns: ['listing_id'], unique: false },
    ]);
});

it('keeps indexes in copies and exports', () => {
    const { dir, engine, path } = engineFixture();
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    const copy = join(dir, 'copy.sqlite');
    engine.copy(path, copy);
    expect(plan(copy, SLOW)).toMatch(/INDEX by_listing/);
    const exported = join(dir, 'export.sqlite');
    engine.exportCopy(path, exported);
    expect(plan(exported, SLOW)).toMatch(/INDEX by_listing/);
});

function spaceFixture(limits: ConstructorParameters<typeof DataSpace>[1]['limits'] = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-indexes-space-'));
    const workspace = new WorkspaceStore(testDatabase());
    for (const [id, name, role] of [
        ['alice', 'Alice', 'admin'],
        ['bob', 'Bob', 'member'],
    ] as const) {
        workspace.recordUser({ id, name, role });
    }
    const approvals = sqliteApprovals(workspace.db, { dotName: (id) => workspace.dot(id)?.name });
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: 'secret-0123456789abcdef-xyz',
        approvals,
        workspace,
        limits,
    });
    cleanup.push(() => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const dot = workspace.dots()[0];
    return { dir, workspace, approvals, space, dot };
}

it('lets a socio index its dataset, shows it in describe, and moves, backs up and audits it', async () => {
    const f = spaceFixture();
    const socio = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id };
    const dataset = f.space.createDataset('alice', { name: 'Marketplace' });
    f.space.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'write' });
    await f.space.write(socio, dataset.id, {
        op: 'create_table',
        input: { table: 'snapshots', columns: [{ name: 'listing_id' }, { name: 'rating', type: 'REAL' }] },
    });
    await f.space.write(socio, dataset.id, {
        op: 'create_table',
        input: { table: 'notes', columns: [{ name: 'text' }] },
    });
    const created = await f.space.write(socio, dataset.id, {
        op: 'create_index',
        table: 'snapshots',
        index: { name: 'by_listing', columns: ['listing_id'] },
    });
    expect(created).toMatchObject({ status: 'done', result: { created: true, index: 'by_listing' } });
    expect(f.space.describe(socio, dataset.id).tables.find((table) => table.name === 'snapshots')!.indexes).toEqual([
        { name: 'by_listing', columns: ['listing_id'], unique: false },
    ]);
    // A read-only socio can't.
    f.space.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'read' });
    await expect(
        f.space.write(socio, dataset.id, { op: 'drop_index', table: 'snapshots', name: 'by_listing' }),
    ).rejects.toThrow();
    // The owner may, in the app; nobody else.
    expect(() =>
        f.space.ownerIndexWrite('bob', dataset.id, { op: 'drop_index', table: 'snapshots', name: 'by_listing' }),
    ).toThrow(/not found/);
    f.space.ownerIndexWrite('alice', dataset.id, {
        op: 'create_index',
        table: 'notes',
        index: { name: 'notes_by_text', columns: ['text'] },
    });
    const audit = f.space.auditFor('alice', { datasetId: dataset.id });
    expect(audit.filter((entry) => entry.action === 'create_index').map((entry) => entry.detail)).toEqual(
        expect.arrayContaining(['index snapshots on listing_id', 'index notes on text']),
    );
    // Backups (and the off-site copy, which seals the backup's bytes) keep them.
    const backups = mkdtempSync(join(tmpdir(), 'cb-data-indexes-backup-'));
    cleanup.push(() => rmSync(backups, { recursive: true, force: true }));
    const backup = await backupUserData(f.dir, backups, 2);
    expect(plan(join(backup.path, 'alice', 'datasets', `${dataset.id}.sqlite`), SNAPSHOT_LOOKUP)).toMatch(
        /INDEX by_listing/,
    );
    // A mini app's promotion moves a table with its indexes, and leaves the rest.
    const moved = f.space.moveToNewDataset('alice', dataset.id, { name: 'Promoted', tables: ['snapshots'] });
    expect(f.space.detailFor('alice', moved.id).tables).toMatchObject([
        { name: 'snapshots', indexes: [{ name: 'by_listing', columns: ['listing_id'], unique: false }] },
    ]);
    expect(f.space.detailFor('alice', dataset.id).tables).toMatchObject([
        { name: 'notes', indexes: [{ name: 'notes_by_text' }] },
    ]);
    expect(plan(f.space.datasetPath({ id: moved.id, ownerUserId: 'alice' }), SNAPSHOT_LOOKUP)).toMatch(
        /INDEX by_listing/,
    );
});

it('asks before indexing a dataset shared with a Space', async () => {
    const f = spaceFixture();
    const socio = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id };
    const dataset = f.space.createDataset('alice', { name: 'Shared' });
    f.space.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'write' });
    await f.space.write(socio, dataset.id, {
        op: 'create_table',
        input: { table: 'snapshots', columns: [{ name: 'listing_id' }] },
    });
    f.space.updateDataset('alice', dataset.id, { sharedSpaceId: f.dot.spaceId });
    const pending = await f.space.write(socio, dataset.id, {
        op: 'create_index',
        table: 'snapshots',
        index: { name: 'by_listing', columns: ['listing_id'] },
    });
    expect(pending.status).toBe('pending_approval');
    expect(f.space.detailFor('alice', dataset.id).tables[0].indexes).toEqual([]);
});

/** The planner's statistics rows, by table and index (`sqlite_stat1`). */
const stats = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const found = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get();
        return found
            ? (
                  db.prepare('SELECT tbl, idx FROM sqlite_stat1 ORDER BY tbl, idx').all() as Array<{
                      tbl: string;
                      idx: string | null;
                  }>
              ).map((row) => `${row.tbl}${row.idx ? `.${row.idx}` : ''}`)
            : [];
    } finally {
        db.close();
    }
};

it('runs ANALYZE on one table or every dataset table, never the engine’s own', async () => {
    const { engine, path } = engineFixture();
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    expect(stats(path)).toEqual([]);
    expect(engine.analyze(path, 'snapshots', 10 * MB)).toEqual({ analyzed: ['snapshots'] });
    expect(stats(path)).toEqual(['snapshots.by_listing']);
    expect(engine.analyze(path, undefined, 10 * MB)).toEqual({ analyzed: ['observations', 'snapshots'] });
    expect(stats(path)).toEqual(['observations', 'snapshots.by_listing']);
    expect(() => engine.analyze(path, 'nope', 10 * MB)).toThrow(/No table "nope"/);
    expect(() => engine.analyze(path, '_writes', 10 * MB)).toThrow(DataError);
    // The data API's read-only queries still plan with the index, and can't
    // read the statistics as a table.
    const result = await engine.query(path, SNAPSHOT_LOOKUP, [], { maxRows: 10, maxBytes: 65536, timeoutMs: 5000 });
    expect(result.rows).toEqual([[1]]);
    expect(plan(path, SNAPSHOT_LOOKUP)).toMatch(/INDEX by_listing/);
    await expect(
        engine.query(path, 'SELECT * FROM sqlite_stat1', [], { maxRows: 10, maxBytes: 65536, timeoutMs: 5000 }),
    ).rejects.toThrow();
    // Statistics never get in the way of the other declared changes.
    expect(engine.dropIndex(path, 'snapshots', 'by_listing')).toMatchObject({ dropped: true });
    expect(stats(path)).toEqual(['observations']);
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    engine.analyze(path, undefined, 10 * MB);
    engine.deleteTable(path, 'snapshots');
    expect(engine.tables(path).map((table) => table.name)).toEqual(['observations']);
    engine.insert(path, 'observations', [{ id: 1000, listing_id: 'x' }], 10 * MB);
    expect(engine.analyze(path, undefined, 10 * MB)).toEqual({ analyzed: ['observations'] });
});

it('keeps ANALYZE to its own mode, on dataset tables only', () => {
    const { engine, path } = engineFixture();
    engine.createIndex(path, 'snapshots', { name: 'by_listing', columns: ['listing_id'] }, 10 * MB);
    const db = new DatabaseSync(path);
    cleanup.push(() => db.close());
    const as = guardWrites(db);
    for (const mode of ['ddl', 'dml', 'index'] as const) {
        expect(() => as(mode, () => db.exec('ANALYZE main.snapshots')), mode).toThrow(/not authorized/);
    }
    for (const sql of [
        'ANALYZE',
        'ANALYZE main',
        'ANALYZE main._writes',
        'ANALYZE main._history_snapshots',
        'CREATE TABLE t (a)',
        'CREATE TABLE sqlite_stat9 (a)',
        'INSERT INTO snapshots (rating) VALUES (1)',
        'DELETE FROM snapshots',
        'CREATE INDEX sneaky ON snapshots (rating)',
        'DROP TABLE snapshots',
    ]) {
        expect(() => as('analyze', () => db.exec(sql)), sql).toThrow(/not authorized|reserved/);
    }
    as('analyze', () => db.exec('ANALYZE main.snapshots'));
    as('analyze', () => db.exec('ANALYZE main.by_listing'));
    // Rows and the statistics table stay out of reach of row writes.
    expect(() => as('dml', () => db.exec('DELETE FROM sqlite_stat1'))).toThrow(/not authorized|may not be modified/);
    expect(() => as('dml', () => db.exec("INSERT INTO sqlite_stat1 VALUES ('snapshots', null, '1')"))).toThrow(
        /not authorized|may not be modified/,
    );
});

it('lets a socio, an app and the owner analyze a dataset, within the per-minute budget and without approval', async () => {
    const f = spaceFixture({ statementsPerMinute: 6 });
    const socio = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id };
    const dataset = f.space.createDataset('alice', { name: 'Marketplace' });
    f.space.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'write' });
    await f.space.write(socio, dataset.id, {
        op: 'create_table',
        input: { table: 'snapshots', columns: [{ name: 'listing_id' }] },
    });
    await f.space.write(socio, dataset.id, {
        op: 'create_index',
        table: 'snapshots',
        index: { name: 'by_listing', columns: ['listing_id'] },
    });
    await f.space.write(socio, dataset.id, { op: 'insert', table: 'snapshots', rows: [{ listing_id: 'l1' }] });
    // Shared with a Space: ANALYZE changes no data anyone sees, so no approval.
    f.space.updateDataset('alice', dataset.id, { sharedSpaceId: f.dot.spaceId });
    expect(await f.space.write(socio, dataset.id, { op: 'analyze', table: 'snapshots' })).toMatchObject({
        status: 'done',
        result: { analyzed: ['snapshots'] },
    });
    expect(await f.space.write(socio, dataset.id, { op: 'analyze' })).toMatchObject({
        status: 'done',
        result: { analyzed: ['snapshots'] },
    });
    // A read-only socio can't: the sixth operation, still within the budget.
    f.space.setGrant('alice', { dotId: f.dot.id, datasetId: dataset.id, access: 'read' });
    await expect(f.space.write(socio, dataset.id, { op: 'analyze' })).rejects.toThrow(/may only read "Marketplace"/);
    // The seventh this minute is over the budget (checked before access).
    await expect(f.space.write(socio, dataset.id, { op: 'analyze' })).rejects.toThrow(/Too many data operations/);
    // The owner may, in the app; nobody else.
    expect(f.space.ownerIndexWrite('alice', dataset.id, { op: 'analyze', table: 'snapshots' })).toMatchObject({
        status: 'done',
        result: { analyzed: ['snapshots'] },
    });
    expect(() => f.space.ownerIndexWrite('bob', dataset.id, { op: 'analyze' })).toThrow(/not found/);
    const audit = f.space.auditFor('alice', { datasetId: dataset.id });
    expect(
        audit.filter((entry) => entry.action === 'analyze' && entry.outcome === 'ok').map((entry) => entry.detail),
    ).toEqual(expect.arrayContaining(['analyze snapshots', 'analyze every table']));
    expect(stats(f.space.datasetPath({ id: dataset.id, ownerUserId: 'alice' }))).toEqual(['snapshots.by_listing']);
});
