import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { type DataActor } from '../src/server/dataspace/contract.js';
import { DataSpace } from '../src/server/dataspace/space.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { memoryTmpdir } from './helpers/memory-tmpdir.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// A write that replaces a dataset row keeps the old one, with who and when, in
// the same file; nobody sees it yet.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

// A person's own socio: its scratch is the user's own (a company socio's
// is its shared dataset, CB-337).
const personalDot = (workspace: WorkspaceStore, spaceId: string, ownerId = 'alice') =>
    workspace.createDot(spaceId, 'Helper', 'Helps.', false, false, [spaceId], null, false, null, false, ownerId);

function fixture(limits = {}) {
    const dir = mkdtempSync(join(memoryTmpdir(), 'cb-row-history-'));
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const approvals = sqliteApprovals(workspace.db, {
        dotName: (id) => workspace.dot(id)?.name,
    });
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
    const dot = personalDot(workspace, workspace.dots()[0]!.spaceId);
    const actor: DataActor = { kind: 'dot', userId: 'alice', dotId: dot.id };
    const token: DataActor = { kind: 'token', userId: 'alice', dotId: dot.id };
    const write = async (op: Parameters<DataSpace['write']>[2], as: DataActor = actor) => {
        const result = await space.write(as as Exclude<DataActor, { kind: 'user' }>, undefined, op);
        expect(result.status).toBe('done');
        return result;
    };
    const scratch = () => space.scratch('alice', dot.id)!;
    return { dir, workspace, space, dot, actor, token, write, scratch };
}
const items = {
    table: 'items',
    columns: [
        { name: 'k', type: 'TEXT' as const, primaryKey: true },
        { name: 'v', type: 'INTEGER' as const },
    ],
};
const upsert = (rows: Array<Record<string, unknown>>) => ({
    op: 'upsert' as const,
    table: 'items',
    rows,
    key: ['k'],
});
const open = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    cleanup.push(() => db.isOpen && db.close());
    return db;
};
const names = (db: DatabaseSync, type: string) =>
    db
        .prepare('SELECT name FROM sqlite_master WHERE type=? ORDER BY name')
        .all(type)
        .map((row) => String(row.name));

it('keeps the row an upsert replaces, with who and when; inserts and unchanged rows keep nothing', async () => {
    const f = fixture();
    await f.write({ op: 'create_table', input: items });
    await f.write({
        op: 'insert',
        table: 'items',
        rows: [
            { k: 'a', v: 1 },
            { k: 'b', v: 2 },
        ],
    });
    const id = f.scratch().id;
    expect(f.space.withHistoryRows(id, 'items')).toEqual([]);
    // An upsert of the same values, and one that only adds a key: nothing.
    await f.write(
        upsert([
            { k: 'a', v: 1 },
            { k: 'c', v: 3 },
        ]),
    );
    expect(f.space.withHistoryRows(id, 'items')).toEqual([]);
    const before = Date.now();
    await f.write(upsert([{ k: 'a', v: 10 }]));
    await f.write(
        upsert([
            { k: 'a', v: 11 },
            { k: 'b', v: 20 },
        ]),
        f.token,
    );
    const after = Date.now();
    const kept = f.space.withHistoryRows(id, 'items');
    expect(
        kept.map(({ change, actor, values, writeId }) => ({
            change,
            actor,
            values,
            writeId,
        })),
    ).toEqual([
        {
            change: 'update',
            actor: `dot:${f.dot.id}`,
            values: { k: 'a', v: 1 },
            writeId: 1,
        },
        {
            change: 'update',
            actor: `dot:${f.dot.id}`,
            values: { k: 'a', v: 10 },
            writeId: 2,
        },
        {
            change: 'update',
            actor: `dot:${f.dot.id}`,
            values: { k: 'b', v: 2 },
            writeId: 2,
        },
    ]);
    for (const row of kept) {
        expect(row.replacedAt).toBeGreaterThanOrEqual(before);
        expect(row.replacedAt).toBeLessThanOrEqual(after);
        expect(row.rowid).toBeGreaterThan(0);
    }
    // The live table has only the latest values.
    const live = await f.space.query(f.actor, undefined, 'SELECT k, v FROM items ORDER BY k');
    expect(live.rows).toEqual([
        ['a', 11],
        ['b', 20],
        ['c', 3],
    ]);
    // One `_writes` row per write that replaced rows, none for the others.
    const db = open(f.space.datasetPath(f.scratch()));
    expect(db.prepare('SELECT id, actor FROM _writes ORDER BY id').all()).toEqual([
        { id: 1, actor: `dot:${f.dot.id}` },
        { id: 2, actor: `dot:${f.dot.id}` },
    ]);
    // A delete, which no path makes today, would be kept too.
    db.close();
    const raw = new DatabaseSync(f.space.datasetPath(f.scratch()));
    raw.exec("DELETE FROM items WHERE k='c'");
    raw.close();
    expect(f.space.withHistoryRows(id, 'items').at(-1)).toMatchObject({
        change: 'delete',
        values: { k: 'c', v: 3 },
    });
});

it('keeps the history table in step with added columns', async () => {
    const f = fixture();
    await f.write({ op: 'create_table', input: items });
    await f.write(upsert([{ k: 'a', v: 1 }]));
    await f.write({
        op: 'add_column',
        table: 'items',
        column: { name: 'note', type: 'TEXT' },
    });
    await f.write(upsert([{ k: 'a', note: 'first' }]));
    await f.write(upsert([{ k: 'a', v: 2, note: 'second' }]));
    const db = open(f.space.datasetPath(f.scratch()));
    expect(
        db
            .prepare("SELECT name, type FROM pragma_table_info('_history_items')")
            .all()
            .map((row) => `${String(row.name)} ${String(row.type)}`),
    ).toEqual([
        '_rowid INTEGER',
        '_writeId INTEGER',
        '_replacedAt INTEGER',
        '_change TEXT',
        'k TEXT',
        'v INTEGER',
        'note TEXT',
    ]);
    expect(f.space.withHistoryRows(f.scratch().id, 'items').map((row) => row.values)).toEqual([
        { k: 'a', v: 1, note: null },
        { k: 'a', v: 1, note: 'first' },
    ]);
    // History's own names are reserved.
    await expect(f.write({ op: 'add_column', table: 'items', column: { name: '_writeId' } })).rejects.toThrow(
        /reserved/,
    );
    await expect(f.write({ op: 'create_table', input: { ...items, table: '_History_x' } })).rejects.toThrow(/reserved/);
    await expect(f.write({ op: 'create_table', input: { ...items, table: '_writes' } })).rejects.toThrow(/reserved/);
});

it('hides history from describe, lists, the Data page, queries, exports and the quota', async () => {
    const f = fixture();
    await f.write({ op: 'create_table', input: items });
    await f.write({
        op: 'insert',
        table: 'items',
        rows: Array.from({ length: 50 }, (_, i) => ({ k: `k${i}`, v: i })),
    });
    for (let round = 1; round <= 4; round++) {
        await f.write(
            upsert(
                Array.from({ length: 50 }, (_, i) => ({
                    k: `k${i}`,
                    v: i + round * 100,
                })),
            ),
        );
    }
    const row = f.scratch();
    expect(f.space.withHistoryRows(row.id, 'items')).toHaveLength(200);
    // Describe, the Dot's list and the Data page see one table.
    expect(f.space.describe(f.actor).tables.map((t) => t.name)).toEqual(['items']);
    expect(f.space.list(f.actor)[0].tables).toBe(1);
    expect(f.space.detailFor('alice', row.id).tables.map((t) => t.name)).toEqual(['items']);
    expect(() => f.space.rowsFor('alice', row.id, '_history_items', 0, 50)).toThrow(/No table/);
    expect(() => f.space.csvFor('alice', row.id, '_history_items')).toThrow(/No table/);
    // Queries, for a Dot, a token and the user (a view on a page runs as them).
    for (const as of [f.actor, f.token, { kind: 'user' as const, userId: 'alice' }]) {
        for (const sql of [
            'SELECT * FROM _history_items',
            'SELECT * FROM "_HISTORY_ITEMS"',
            'SELECT * FROM _writes',
            'SELECT * FROM _writer',
            // Row stamps (CB-451) are the engine's too.
            'SELECT * FROM _stamps_items',
            'SELECT * FROM _stamp_seq',
            'SELECT k FROM items WHERE k IN (SELECT k FROM _history_items)',
        ]) {
            await expect(f.space.query(as, row.id, sql), sql).rejects.toThrow(/Not allowed/);
        }
    }
    expect((await f.space.query(f.actor, row.id, 'SELECT count(*) FROM items')).rows).toEqual([[50]]);
    // Writes can't reach them either.
    await expect(f.write({ op: 'insert', table: '_history_items', rows: [{ k: 'x' }] })).rejects.toThrow(/No table/);
    await expect(f.write({ op: 'insert', table: '_writes', rows: [{ actor: 'x', at: 1 }] })).rejects.toThrow(
        /No table/,
    );
    // The SQLite export has the dataset's tables only, and works on its own.
    const exported = join(f.dir, 'export.sqlite');
    writeFileSync(exported, f.space.sqliteFor('alice', row.id).bytes);
    const copy = open(exported);
    expect(names(copy, 'table')).toEqual(['items']);
    expect(names(copy, 'trigger')).toEqual([]);
    expect(copy.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 0,
    });
    expect(copy.prepare('SELECT count(*) AS n FROM items').get()).toEqual({
        n: 50,
    });
    // The quota counts the file without its history; operators see it apart.
    const file = open(f.space.datasetPath(row));
    // History's pages, and the text its tables and triggers add to the schema.
    const history =
        Number(
            (
                file
                    .prepare(
                        "SELECT sum(pgsize) AS b FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name IN ('_history_items', '_writes', '_writer', '_stamps_items', '_stamp_seq', '_stamp_generations'))",
                    )
                    .get() as { b: number }
            ).b,
        ) +
        Number(
            (
                file
                    .prepare(
                        "SELECT sum(length(sql)) AS b FROM sqlite_master WHERE type <> 'index' AND name IN ('_history_items', '_writes', '_writer', '_keep_update_items', '_keep_delete_items', '_stamps_items', '_stamp_seq', '_stamp_generations', '_keep_stamp_insert_items', '_keep_stamp_update_items', '_keep_stamp_delete_items')",
                    )
                    .get() as { b: number }
            ).b,
        );
    const stored = f.space.withDeletedDataset(row.id)!;
    expect(history).toBeGreaterThan(8192);
    expect(stored.historyBytes).toBe(history);
    const pages = Number((file.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
    expect(stored.sizeBytes).toBe(pages * 4096 - history);
    expect(f.space.usage('alice').datasetBytes).toBe(stored.sizeBytes);
    expect(f.space.describe(f.actor).sizeBytes).toBe(stored.sizeBytes);
    expect(f.space.usageAll().find((u) => u.userId === 'alice')).toMatchObject({
        datasetBytes: stored.sizeBytes,
        historyBytes: history,
    });
});

it('gives history its own room: upserts that only replace rows never fill a dataset', async () => {
    const f = fixture({ datasetMaxBytes: 64 * 1024 });
    await f.write({
        op: 'create_table',
        input: { ...items, columns: [...items.columns, { name: 'text' }] },
    });
    const rows = (round: number) =>
        Array.from({ length: 20 }, (_, i) => ({
            k: `k${i}`,
            v: round,
            text: 'x'.repeat(400),
        }));
    await f.write(upsert(rows(0)));
    const live = f.scratch().sizeBytes;
    // 40 rounds keep 800 rows of about 420 bytes: five times the dataset's cap.
    for (let round = 1; round <= 40; round++) {
        await f.write(upsert(rows(round)));
    }
    const row = f.scratch();
    expect(row.historyBytes).toBeGreaterThan(5 * 64 * 1024);
    expect(row.sizeBytes).toBe(live);
    expect(f.space.withHistoryRows(row.id, 'items')).toHaveLength(800);
    // New rows still meet the cap.
    await expect(
        f.write({
            op: 'insert',
            table: 'items',
            rows: Array.from({ length: 200 }, (_, i) => ({
                k: `n${i}`,
                text: 'y'.repeat(400),
            })),
        }),
    ).rejects.toThrow(/full/);
    expect(f.scratch().sizeBytes).toBe(live);
    // Filled to the cap with new rows, it still takes an upsert that replaces
    // all of them: this call's history doesn't take the tables' room.
    let added = 0;
    for (;;) {
        const batch = Array.from({ length: 5 }, (_, i) => ({
            k: `m${added + i}`,
            text: 'z'.repeat(400),
        }));
        const result = await f.space
            .write(f.actor as Exclude<DataActor, { kind: 'user' }>, undefined, {
                op: 'insert',
                table: 'items',
                rows: batch,
            })
            .catch((error: Error) => error);
        if (result instanceof Error) {
            expect(result.message).toMatch(/full/);
            break;
        }
        added += batch.length;
    }
    expect(f.scratch().sizeBytes).toBeGreaterThan(48 * 1024);
    expect(f.scratch().sizeBytes).toBeLessThanOrEqual(64 * 1024);
    const all = Array.from({ length: added }, (_, i) => ({
        k: `m${i}`,
        v: 1,
        text: 'w'.repeat(400),
    }));
    await f.write(upsert(all));
    expect(f.space.withHistoryRows(row.id, 'items')).toHaveLength(800 + added);
    // Sizes that weren't recorded (as if the server stopped between a write
    // and its bookkeeping) are measured again, not taken as live bytes.
    const exact = f.scratch();
    f.workspace.db.prepare('UPDATE data_datasets SET sizeBytes=0, historyBytes=0 WHERE id=?').run(row.id);
    await f.write(upsert(all.map((item) => ({ ...item, v: 2 }))));
    expect(f.scratch().sizeBytes).toBe(exact.sizeBytes);
    expect(f.scratch().historyBytes).toBeGreaterThan(exact.historyBytes);
});

it('moves history with its table when a promotion moves tables, and keeps it through retention and deletes', async () => {
    const f = fixture();
    await f.write({ op: 'create_table', input: items });
    await f.write({ op: 'create_table', input: { ...items, table: 'other' } });
    await f.write(upsert([{ k: 'a', v: 1 }]));
    await f.write(upsert([{ k: 'a', v: 2 }]));
    await f.write({
        op: 'upsert',
        table: 'other',
        rows: [{ k: 'o', v: 1 }],
        key: ['k'],
    });
    await f.write({
        op: 'upsert',
        table: 'other',
        rows: [{ k: 'o', v: 2 }],
        key: ['k'],
    });
    const source = f.scratch();
    const moved = f.space.moveToNewDataset('alice', source.id, {
        name: 'App data',
        tables: ['items'],
    });
    expect(f.space.withHistoryRows(moved.id, 'items').map((r) => r.values)).toEqual([{ k: 'a', v: 1 }]);
    expect(f.space.withHistoryRows(moved.id, 'other')).toEqual([]);
    expect(f.space.withHistoryRows(source.id, 'items')).toEqual([]);
    expect(f.space.withHistoryRows(source.id, 'other').map((r) => r.values)).toEqual([{ k: 'o', v: 1 }]);
    const target = open(f.space.datasetPath(f.space.withDeletedDataset(moved.id)!));
    expect(names(target, 'table')).toEqual([
        '_history_items',
        '_stamp_generations',
        '_stamp_seq',
        '_stamps_items',
        '_writer',
        '_writes',
        'items',
    ]);
    expect(names(target, 'trigger')).toEqual([
        '_keep_delete_items',
        '_keep_stamp_delete_items',
        '_keep_stamp_insert_items',
        '_keep_stamp_update_items',
        '_keep_update_items',
    ]);
    // The moved table keeps history in its new dataset.
    f.space.setGrant('alice', {
        dotId: f.dot.id,
        datasetId: moved.id,
        access: 'write',
    });
    await f.space.write(f.actor, moved.id, upsert([{ k: 'a', v: 3 }]));
    expect(f.space.withHistoryRows(moved.id, 'items').map((r) => r.values.v)).toEqual([1, 2]);
    // Retention hides the dataset; its file and history stay.
    f.space.updateDataset('alice', moved.id, { retentionDays: 7 });
    expect(f.space.applyRetention(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(f.space.withDeletedDataset(moved.id)!.deletedAt).not.toBeNull();
    expect(f.space.withHistoryRows(moved.id, 'items')).toHaveLength(2);
    f.space.deleteDataset('alice', source.id);
    expect(f.space.withHistoryRows(source.id, 'other')).toHaveLength(1);
});

it('gives a dataset from before row history its history on its next write', async () => {
    const f = fixture();
    const dataset = f.space.createDataset('alice', { name: 'Old prices' });
    // A file as the engine wrote it before: no history, user_version 0.
    const path = f.space.datasetPath(f.space.withDeletedDataset(dataset.id)!);
    const old = new DatabaseSync(path);
    old.exec(
        "CREATE TABLE prices (sku TEXT PRIMARY KEY, price REAL); CREATE TABLE log (line TEXT); INSERT INTO prices VALUES ('s1', 1.5), ('s2', 2.5);",
    );
    old.close();
    expect(names(open(path), 'table')).toEqual(['log', 'prices']);
    f.space.setGrant('alice', {
        dotId: f.dot.id,
        datasetId: dataset.id,
        access: 'write',
    });
    // Reads don't change the file.
    expect(f.space.describe(f.actor, dataset.id).tables.map((t) => t.name)).toEqual(['log', 'prices']);
    await f.space.write(f.actor, dataset.id, {
        op: 'upsert',
        table: 'prices',
        rows: [{ sku: 's1', price: 1.75 }],
        key: ['sku'],
    });
    const db = open(path);
    // Row history, then row stamps (CB-451): `prices` has a key, `log` none.
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(names(db, 'table')).toEqual([
        '_history_log',
        '_history_prices',
        '_stamp_generations',
        '_stamp_seq',
        '_stamps_prices',
        '_writer',
        '_writes',
        'log',
        'prices',
    ]);
    expect(names(db, 'trigger')).toEqual([
        '_keep_delete_log',
        '_keep_delete_prices',
        '_keep_stamp_delete_prices',
        '_keep_stamp_insert_prices',
        '_keep_stamp_update_prices',
        '_keep_update_log',
        '_keep_update_prices',
    ]);
    expect(f.space.withHistoryRows(dataset.id, 'prices')).toMatchObject([
        {
            change: 'update',
            actor: `dot:${f.dot.id}`,
            values: { sku: 's1', price: 1.5 },
        },
    ]);
    // A table without a key keeps updates too (no tool makes one today).
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE log SET line='b'");
    raw.exec("INSERT INTO log VALUES ('a'); UPDATE log SET line='b'");
    raw.close();
    expect(f.space.withHistoryRows(dataset.id, 'log').map((r) => r.values)).toEqual([{ line: 'a' }]);
    expect(f.space.describe(f.actor, dataset.id).tables.map((t) => t.name)).toEqual(['log', 'prices']);
});
