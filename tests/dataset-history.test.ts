import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { type DataActor } from '../src/server/dataspace/contract.js';
import { DatasetEngine } from '../src/server/dataspace/engine.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';
import { DataSpace } from '../src/server/dataspace/space.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-369 Phase H: tables without row history, history kept for a number of
// days and pruned nightly, and Compact file (VACUUM).

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const DAY = 86_400_000;
const items = (history?: boolean) => ({
    table: 'items',
    columns: [
        { name: 'k', type: 'TEXT' as const, primaryKey: true },
        { name: 'v', type: 'INTEGER' as const },
    ],
    ...(history === undefined ? {} : { history }),
});
const open = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    cleanup.push(() => db.isOpen && db.close());
    return db;
};
const count = (path: string, table: string) => {
    const db = open(path);
    try {
        return Number((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n);
    } finally {
        db.close();
    }
};
// History's triggers: row stamps' (`_keep_stamp_*`, CB-451) are kept whatever the history setting.
const triggers = (path: string) => {
    const db = open(path);
    try {
        return db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name NOT GLOB '_keep_stamp_*' ORDER BY name",
            )
            .all()
            .map((row) => String(row.name));
    } finally {
        db.close();
    }
};

function engineFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-history-engine-'));
    const runner = new QueryRunner();
    const engine = new DatasetEngine(runner);
    const path = join(dir, 'd.sqlite');
    engine.create(path);
    cleanup.push(() => {
        runner.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const upsert = (rows: Array<Record<string, unknown>>, writer = 'system') =>
        engine.insert(path, 'items', rows, 2 ** 30, ['k'], { writer });
    return { dir, engine, path, upsert };
}

describe('tables without row history', () => {
    it('makes a table with history: false that keeps nothing it replaces, and adding a column keeps it so', () => {
        const { engine, path, upsert } = engineFixture();
        expect(engine.createTable(path, items(false), 2 ** 30)).toEqual({
            created: true,
            table: 'items',
            history: false,
        });
        expect(triggers(path)).toEqual([]);
        upsert([{ k: 'a', v: 1 }]);
        upsert([{ k: 'a', v: 2 }]);
        expect(engine.withHistoryOf(path, 'items')).toEqual([]);
        engine.addColumn(path, 'items', { name: 'note', type: 'TEXT' }, 2 ** 30);
        expect(triggers(path)).toEqual([]);
        expect(engine.tables(path)[0]).toMatchObject({ name: 'items', history: false });
        // A table made as before keeps history, and says so.
        engine.createTable(path, { ...items(), table: 'kept' }, 2 ** 30);
        expect(engine.tables(path).find((table) => table.name === 'kept')).toMatchObject({ history: true });
    });

    it('switches history off and on: off drops the triggers, on keeps changes from then', () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        upsert([{ k: 'a', v: 1 }]);
        upsert([{ k: 'a', v: 2 }]);
        expect(engine.withHistoryOf(path, 'items')).toHaveLength(1);
        expect(engine.setHistory(path, 'items', false)).toEqual({ table: 'items', history: false, changed: true });
        expect(engine.setHistory(path, 'items', false)).toMatchObject({ changed: false });
        expect(triggers(path)).toEqual([]);
        upsert([{ k: 'a', v: 3 }]);
        // What it kept before stays until a prune.
        expect(engine.withHistoryOf(path, 'items')).toHaveLength(1);
        // A column added while off is in its history once it is on again.
        engine.addColumn(path, 'items', { name: 'note', type: 'TEXT' }, 2 ** 30);
        expect(engine.setHistory(path, 'items', true)).toMatchObject({ history: true, changed: true });
        upsert([{ k: 'a', v: 4, note: 'x' }]);
        const kept = engine.withHistoryOf(path, 'items');
        expect(kept).toHaveLength(2);
        expect(kept[1]!.values).toMatchObject({ v: 3, note: null });
        expect(() => engine.setHistory(path, 'nope', false)).toThrow(/No table "nope"/);
    });
});

describe('pruning', () => {
    it('deletes what a table without history kept, rows older than the cutoff, and unreferenced writes', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        engine.createTable(path, { ...items(), table: 'mart' }, 2 ** 30);
        for (let v = 1; v <= 5; v++) {
            upsert([{ k: 'a', v }], `user-${v}`);
            engine.insert(path, 'mart', [{ k: 'm', v }], 2 ** 30, ['k'], { writer: 'system' });
        }
        expect(engine.withHistoryOf(path, 'items')).toHaveLength(4);
        expect(engine.withHistoryOf(path, 'mart')).toHaveLength(4);
        engine.setHistory(path, 'mart', false);
        // Nothing to prune without a cutoff but the mart's kept rows.
        const now = Date.now();
        expect(await engine.pruneHistory(path, null, { now, chunk: 3 })).toEqual({ rows: 4, writes: 0 });
        expect(engine.withHistoryOf(path, 'mart')).toEqual([]);
        expect(engine.withHistoryOf(path, 'items')).toHaveLength(4);
        // Age the items' kept rows and their writes: two old, two new.
        const db = new DatabaseSync(path);
        db.exec(`UPDATE "_history_items" SET "_replacedAt" = ${now - 40 * DAY} WHERE "_writeId" <= 4`);
        db.exec(`UPDATE "_writes" SET at = ${now - 40 * DAY}`);
        db.close();
        const pruned = await engine.pruneHistory(path, now - 30 * DAY, { now, chunk: 1 });
        expect(pruned.rows).toBe(2);
        // The writes the pruned rows named go; those still named stay.
        expect(pruned.writes).toBeGreaterThan(0);
        const left = engine.withHistoryOf(path, 'items');
        expect(left).toHaveLength(2);
        expect(left.every((row) => row.actor !== null)).toBe(true);
        // A second run finds nothing.
        expect(await engine.pruneHistory(path, now - 30 * DAY, { now })).toEqual({ rows: 0, writes: 0 });
    });

    it('prunes a deleted table’s kept rows by age, never as a table without history', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        upsert([{ k: 'a', v: 1 }]);
        upsert([{ k: 'a', v: 2 }]);
        const { table: kept } = engine.deleteTable(path, 'items');
        expect(engine.withHistoryOf(path, kept)).toHaveLength(1);
        expect(await engine.pruneHistory(path, null)).toEqual({ rows: 0, writes: 0 });
        expect(engine.withHistoryOf(path, kept)).toHaveLength(1);
        expect((await engine.pruneHistory(path, Date.now() + 1000)).rows).toBe(1);
    });

    it('prunes by SQLite’s own row id when a column is called rowid, never newer rows', async () => {
        const { engine, path } = engineFixture();
        engine.createTable(
            path,
            {
                table: 'items',
                columns: [
                    { name: 'k', type: 'TEXT', primaryKey: true },
                    { name: 'rowid', type: 'INTEGER' },
                ],
            },
            2 ** 30,
        );
        const now = Date.now();
        engine.insert(
            path,
            'items',
            [
                { k: 'a', rowid: 7 },
                { k: 'b', rowid: null },
            ],
            2 ** 30,
        );
        engine.insert(
            path,
            'items',
            [
                { k: 'a', rowid: 8 },
                { k: 'b', rowid: 1 },
            ],
            2 ** 30,
            ['k'],
        );
        engine.insert(
            path,
            'items',
            [
                { k: 'a', rowid: 9 },
                { k: 'b', rowid: 2 },
            ],
            2 ** 30,
            ['k'],
        );
        // Two kept versions share a user `rowid` value (7 then 8 for a, null then 1 for b); age only the first two.
        const db = new DatabaseSync(path);
        db.exec(
            `UPDATE "_history_items" SET "_replacedAt" = ${now - 40 * DAY} WHERE "_writeId" = (SELECT min("_writeId") FROM "_history_items")`,
        );
        db.close();
        expect((await engine.pruneHistory(path, now - 30 * DAY, { now, chunk: 1 })).rows).toBe(2);
        expect(engine.withHistoryOf(path, 'items').map((row) => row.values.rowid)).toEqual([8, 1]);
    });

    it('stops deleting a table’s history once it is switched back on between chunks', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        for (let v = 1; v <= 6; v++) {
            upsert([{ k: 'a', v }]);
        }
        engine.setHistory(path, 'items', false);
        const prune = engine.pruneHistory(path, null, { chunk: 2 });
        // The first chunk runs at once; history comes back before the next.
        engine.setHistory(path, 'items', true);
        upsert([{ k: 'a', v: 100 }]);
        await prune;
        // Without a cutoff, nothing kept after it was on again goes.
        expect(engine.withHistoryOf(path, 'items').some((row) => row.values.v === 6)).toBe(true);
    });

    it('drops old batch markers in a dataset without any history', async () => {
        const { engine, path } = engineFixture();
        engine.createTable(path, items(false), 2 ** 30);
        const db = new DatabaseSync(path);
        db.exec(
            `INSERT INTO "_writes" (id, actor, at) VALUES (1, 'batch:old', ${Date.now() - 3 * DAY}), (2, 'batch:new', ${Date.now()})`,
        );
        db.close();
        expect(await engine.pruneHistory(path, null)).toEqual({ rows: 0, writes: 1 });
        expect(await engine.pruneHistory(path, null)).toEqual({ rows: 0, writes: 0 });
    });

    it('drops orphan writes in bounded transactions, however many history tables a file has', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        upsert([{ k: 'a', v: 1 }]);
        upsert([{ k: 'a', v: 2 }]);
        const old = Date.now() - 3 * DAY;
        const db = new DatabaseSync(path);
        db.exec('BEGIN');
        // Hundreds of deleted tables' history (no limit holds them), one naming write 900.
        db.exec(
            Array.from(
                { length: 600 },
                (_, i) =>
                    `CREATE TABLE "_history__deleted_${i}_t" ("_rowid" INTEGER, "_writeId" INTEGER, "_replacedAt" INTEGER, "_change" TEXT);`,
            ).join(''),
        );
        db.exec(`INSERT INTO "_history__deleted_599_t" VALUES (1, 900, ${Date.now()}, 'delete')`);
        db.exec(`UPDATE "_writes" SET at = ${old}`);
        const insert = db.prepare('INSERT INTO "_writes" (id, actor, at) VALUES (?, ?, ?)');
        for (let id = 100; id < 1100; id++) {
            insert.run(id, `batch:${id}`, old);
        }
        db.exec('COMMIT');
        db.close();
        const writes = vi.spyOn(engine as unknown as { write: () => unknown }, 'write');
        const pruned = await engine.pruneHistory(path, null, { chunk: 100 });
        // Every marker but the named one goes; the kept row's own write stays.
        expect(pruned.writes).toBe(999);
        expect(engine.withHistoryOf(path, 'items')[0]!.actor).not.toBeNull();
        // In transactions of at most 100 rows: ten or more of them.
        expect(writes.mock.calls.length).toBeGreaterThanOrEqual(10);
        const check = open(path);
        expect(check.prepare('SELECT count(*) AS n FROM "_writes" WHERE id = 900').get()).toEqual({ n: 1 });
        check.close();
    });

    it('reads history a page at a time and writes nothing when no row is old enough', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        const rows = Array.from({ length: 300 }, (_, i) => ({ k: `k${i}`, v: i }));
        upsert(rows);
        upsert(rows.map((row) => ({ ...row, v: row.v + 1 })));
        const spied = engine as unknown as { read: () => unknown; write: () => unknown };
        const reads = vi.spyOn(spied, 'read');
        const writes = vi.spyOn(spied, 'write');
        expect(await engine.pruneHistory(path, Date.now() - 30 * DAY, { chunk: 100 })).toEqual({ rows: 0, writes: 0 });
        // Three full pages and an empty one, never one whole-table pass, and no transaction.
        expect(reads.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(writes).not.toHaveBeenCalled();
    });

    it('pages writes by id, so recent markers are never one long scan', async () => {
        const { engine, path } = engineFixture();
        engine.createTable(path, items(false), 2 ** 30);
        const db = new DatabaseSync(path);
        db.exec('BEGIN');
        const insert = db.prepare('INSERT INTO "_writes" (id, actor, at) VALUES (?, ?, ?)');
        insert.run(1, 'batch:old', Date.now() - 3 * DAY);
        for (let id = 2; id <= 1000; id++) {
            insert.run(id, `batch:${id}`, Date.now());
        }
        db.exec('COMMIT');
        db.close();
        const reads = vi.spyOn(engine as unknown as { read: () => unknown }, 'read');
        expect(await engine.pruneHistory(path, null, { chunk: 100 })).toEqual({ rows: 0, writes: 1 });
        // Ten pages of 100 (and the last, short one), never one pass over the recent ones.
        expect(reads.mock.calls.length).toBeGreaterThanOrEqual(11);
    });

    it('keeps the writes a table deleted during the cleanup still names', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        for (let v = 1; v <= 5; v++) {
            upsert([{ k: 'a', v }], `user-${v}`);
        }
        const db = new DatabaseSync(path);
        db.exec(`UPDATE "_writes" SET at = ${Date.now() - 3 * DAY}`);
        db.close();
        const spied = engine as unknown as { read: (...args: unknown[]) => unknown };
        const read = spied.read.bind(engine);
        let calls = 0;
        vi.spyOn(spied, 'read').mockImplementation((...args: unknown[]) => {
            // Delete the table between the cleanup's reads.
            if (++calls === 4) {
                engine.deleteTable(path, 'items');
            }
            return read(...args);
        });
        await engine.pruneHistory(path, null, { chunk: 1 });
        const deleted = engine.tables(path).length === 0;
        expect(deleted).toBe(true);
        const history = open(path)
            .prepare("SELECT name FROM sqlite_master WHERE name GLOB '_history__deleted_*'")
            .get() as { name: string };
        const left = engine.withHistoryOf(path, history.name.slice('_history_'.length));
        expect(left).toHaveLength(4);
        expect(left.every((row) => row.actor !== null)).toBe(true);
    });

    it('never counts what a prune freed toward the quota', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        const rows = Array.from({ length: 2000 }, (_, i) => ({ k: `k${i}`, v: i }));
        upsert(rows);
        upsert(rows.map((row) => ({ ...row, v: row.v + 1 })));
        const before = engine.sizes(path);
        await engine.pruneHistory(path, Date.now() + 1000);
        const after = engine.sizes(path);
        expect(after.sizeBytes).toBeLessThanOrEqual(before.sizeBytes);
        // Writes after it, without a VACUUM, still fit a quota just above the live data.
        const options = { sizes: { ...after } };
        expect(() =>
            engine.insert(path, 'items', [{ k: 'new', v: 1 }], before.sizeBytes + 65_536, ['k'], options),
        ).not.toThrow();
    });

    it('never measures the file while it prunes, only once after', async () => {
        const { engine, path, upsert } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        const rows = Array.from({ length: 300 }, (_, i) => ({ k: `k${i}`, v: i }));
        upsert(rows);
        upsert(rows.map((row) => ({ ...row, v: row.v + 1 })));
        const measure = vi.spyOn(engine as unknown as { measure: () => unknown }, 'measure');
        expect((await engine.pruneHistory(path, Date.now() + 1000, { chunk: 100 })).rows).toBe(300);
        expect(measure).not.toHaveBeenCalled();
    });

    it('compacts a file in the runner’s process, giving back the pages a prune freed', async () => {
        const { engine, path } = engineFixture();
        engine.createTable(path, items(), 2 ** 30);
        const rows = Array.from({ length: 1000 }, (_, i) => ({ k: `k${i}`, v: i }));
        engine.insert(path, 'items', rows, 2 ** 30, ['k']);
        engine.insert(
            path,
            'items',
            rows.map((row) => ({ ...row, v: row.v + 1 })),
            2 ** 30,
            ['k'],
        );
        await engine.pruneHistory(path, Date.now() + 1000);
        const before = statSync(path).size;
        const sizes = await engine.vacuum(path, 30_000);
        expect(statSync(path).size).toBeLessThan(before);
        expect(sizes.historyBytes).toBeLessThan(before);
        expect(count(path, 'items')).toBe(1000);
    });
});

function spaceFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-history-space-'));
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const approvals = sqliteApprovals(workspace.db, { dotName: (id) => workspace.dot(id)?.name });
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: 'secret-0123456789abcdef-xyz',
        approvals,
        workspace,
    });
    cleanup.push(() => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const dot = workspace.createDot(
        workspace.dots()[0]!.spaceId,
        'Helper',
        'Helps.',
        false,
        false,
        [workspace.dots()[0]!.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    const actor = { kind: 'dot', userId: 'alice', dotId: dot.id } as const;
    const scratch = () => space.scratch('alice', dot.id)!;
    return { dir, workspace, space, dot, actor, scratch };
}

describe('the data space', () => {
    it('keeps row history for the days its owner sets, refusing anything else', async () => {
        const { space, actor, scratch } = spaceFixture();
        await space.write(actor, undefined, { op: 'create_table', input: items() });
        const id = scratch().id;
        expect(space.updateDataset('alice', id, { historyDays: 30 })).toMatchObject({ historyDays: 30 });
        for (const bad of [0, 3651, 1.5]) {
            expect(() => space.updateDataset('alice', id, { historyDays: bad })).toThrow(/1 to 3,650 days/);
        }
        expect(() => space.updateDataset('bob', id, { historyDays: 7 })).toThrow(/not found/);
        expect(space.updateDataset('alice', id, { historyDays: null })).toMatchObject({ historyDays: null });
        const audit = space.auditFor('alice', { datasetId: id }).map((entry) => entry.detail);
        expect(audit).toContain('row history → 30 days');
        expect(audit).toContain('row history → keep all');
    });

    it('lets the owner switch a table’s history, never a socio’s token', async () => {
        const { space, actor, scratch } = spaceFixture();
        await space.write(actor, undefined, { op: 'create_table', input: items() });
        const id = scratch().id;
        const token: DataActor = { kind: 'token', userId: 'alice', dotId: actor.dotId };
        expect(() => space.setTableHistory(token, id, 'items', false)).toThrow(/Only the dataset’s owner/);
        expect(() => space.setTableHistory({ kind: 'user', userId: 'bob' }, id, 'items', false)).toThrow(/not found/);
        expect(space.setTableHistory({ kind: 'user', userId: 'alice' }, id, 'items', false).result).toMatchObject({
            history: false,
            changed: true,
        });
        expect(space.detailFor('alice', id).tables[0]).toMatchObject({ history: false });
        const actions = space.auditFor('alice', { datasetId: id }).map((entry) => `${entry.action}:${entry.outcome}`);
        expect(actions).toContain('table_history:ok');
    });

    it('prunes nightly as the system and compacts the files their owners asked for', async () => {
        const { space, actor, scratch } = spaceFixture();
        await space.write(actor, undefined, { op: 'create_table', input: items() });
        const rows = Array.from({ length: 300 }, (_, i) => ({ k: `k${i}`, v: i }));
        await space.write(actor, undefined, { op: 'upsert', table: 'items', rows, key: ['k'] });
        await space.write(actor, undefined, {
            op: 'upsert',
            table: 'items',
            rows: rows.map((row) => ({ ...row, v: row.v + 1000 })),
            key: ['k'],
        });
        const id = scratch().id;
        expect(space.detailFor('alice', id).dataset.historyBytes).toBeGreaterThan(0);
        // Nothing is pruned while the dataset keeps all of its history.
        expect(await space.maintainHistory()).toMatchObject({ pruned: 0, compacted: 0 });
        space.updateDataset('alice', id, { historyDays: 1 });
        expect(space.requestCompact('alice', id)).toMatchObject({ compactRequestedAt: expect.any(Number) });
        const result = await space.maintainHistory(Date.now() + 2 * DAY);
        expect(result).toMatchObject({ pruned: 1, rows: 300, compacted: 1, failed: 0 });
        const view = space.detailFor('alice', id).dataset;
        expect(view.compactRequestedAt).toBeNull();
        expect(space.withHistoryRows(id, 'items')).toEqual([]);
        const audit = space.auditFor('alice', { datasetId: id });
        expect(audit.find((entry) => entry.action === 'history_prune')).toMatchObject({
            actorKind: 'system',
            outcome: 'ok',
        });
        expect(audit.find((entry) => entry.action === 'compact')).toMatchObject({ outcome: 'ok' });
        // Asked and taken back: nothing to compact.
        space.requestCompact('alice', id);
        expect(space.requestCompact('alice', id, true)).toMatchObject({ compactRequestedAt: null });
    });

    it('leaves a dataset’s change time to its writes, so retention still counts from them', async () => {
        const { space, actor, scratch, workspace } = spaceFixture();
        await space.write(actor, undefined, { op: 'create_table', input: items() });
        await space.write(actor, undefined, { op: 'upsert', table: 'items', rows: [{ k: 'a', v: 1 }], key: ['k'] });
        await space.write(actor, undefined, { op: 'upsert', table: 'items', rows: [{ k: 'a', v: 2 }], key: ['k'] });
        const id = scratch().id;
        space.updateDataset('alice', id, { historyDays: 1, retentionDays: 7 });
        workspace.db.prepare('UPDATE data_datasets SET updatedAt=? WHERE id=?').run(1_000, id);
        space.requestCompact('alice', id);
        expect(await space.maintainHistory(Date.now() + 2 * DAY)).toMatchObject({ pruned: 1, compacted: 1 });
        expect(space.withDeletedDataset(id)!.updatedAt).toBe(1_000);
        expect(space.applyRetention()).toBe(1);
    });

    it('skips a compaction its owner took back while the run was under way', async () => {
        const { space, actor, scratch } = spaceFixture();
        await space.write(actor, undefined, { op: 'create_table', input: items() });
        const id = scratch().id;
        space.requestCompact('alice', id);
        const vacuum = vi.spyOn(space.engine, 'vacuum');
        const prune = space.engine.pruneHistory.bind(space.engine);
        vi.spyOn(space.engine, 'pruneHistory').mockImplementation(async (...args) => {
            space.requestCompact('alice', id, true);
            return prune(...args);
        });
        expect(await space.maintainHistory()).toMatchObject({ compacted: 0 });
        expect(vacuum).not.toHaveBeenCalled();
    });

    it('runs once a night, in the server’s off-hours', () => {
        const { space } = spaceFixture();
        const at = (hour: number) => new Date(2026, 10, 15, hour, 30).getTime();
        expect(space.historyMaintenanceDue(at(12))).toBe(false);
        expect(space.historyMaintenanceDue(at(3))).toBe(true);
        void space.maintainHistory(at(3));
        expect(space.historyMaintenanceDue(at(4))).toBe(false);
        expect(space.historyMaintenanceDue(at(3) + DAY)).toBe(true);
    });
});
