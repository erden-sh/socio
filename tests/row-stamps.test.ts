import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backupUserData } from '@socio/data/backup';
import { rowChanges } from '@socio/shared/dataset-views/contract';
import { parseStamp, STAMP_GENERATION } from '@socio/shared/dataset-views/schema';

import { DatasetEngine } from '../src/server/dataspace/engine.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';

// CB-451 step 3b: row stamps, a per-file sequence that never goes back, a
// generation a restore replaces, tombstones, and `changes?since=`.

const MB = 1024 * 1024;
let dir: string;
let runner: QueryRunner;
let engine: DatasetEngine;
let n = 0;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-row-stamps-'));
    runner = new QueryRunner();
    engine = new DatasetEngine(runner);
});
afterAll(() => {
    runner.close();
    rmSync(dir, { recursive: true, force: true });
});

const customers = {
    table: 'customers',
    columns: [
        { name: 'id', type: 'TEXT' as const, primaryKey: true },
        { name: 'name', type: 'TEXT' as const },
        { name: 'city', type: 'TEXT' as const },
    ],
};
/** A new dataset file with Acme's customers table. */
function file(table: Parameters<DatasetEngine['createTable']>[1] = customers) {
    const path = join(dir, `d${++n}.sqlite`);
    engine.create(path);
    engine.createTable(path, table, 10 * MB);
    return path;
}
const value = (token: string) => parseStamp(token)!.value;
const generation = (token: string) => parseStamp(token)!.generation;
const upsert = (path: string, rows: Array<Record<string, unknown>>) =>
    engine.insert(path, 'customers', rows, 10 * MB, ['id'], { writer: 'ada' });
const changes = (path: string, since: string, options: { cursor?: string; limit?: number } = {}) => {
    const page = engine.changes(path, 'customers', since, options);
    // Every answer is the shared contract's (#653).
    rowChanges.parse({ schema: 1, ...page });
    return page;
};

describe('the stamp sequence', () => {
    it('takes one value per write and never goes back, across restarts and history prunes', async () => {
        const path = file();
        const start = engine.stampToken(path);
        expect(STAMP_GENERATION.test(generation(start))).toBe(true);
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const one = engine.stampToken(path);
        expect(value(one)).toBe(value(start) + 1);
        // A write of many rows is one stamp.
        upsert(path, [
            { id: 'c2', name: 'Acme Labs', city: 'Porto' },
            { id: 'c3', name: 'Acme Works', city: 'Faro' },
        ]);
        expect(value(engine.stampToken(path))).toBe(value(one) + 1);
        // Replace and delete rows, so history and `_writes` fill, then prune
        // all of it: the next write id is `max(id) + 1` again, the stamp isn't.
        upsert(path, [{ id: 'c1', name: 'Acme Inc', city: 'Lisbon' }]);
        engine.deleteRows(path, 'customers', [2], { writer: 'ada' });
        // A write that keeps no history: `_writes` gets no row for it.
        upsert(path, [{ id: 'c5', name: 'Ada', city: 'Faro' }]);
        const before = engine.stampToken(path);
        const writeIds = () => {
            const db = new DatabaseSync(path, { readOnly: true });
            try {
                return db.prepare('SELECT count(*) AS n, coalesce(max(id), 0) AS max FROM _writes').get() as {
                    n: number;
                    max: number;
                };
            } finally {
                db.close();
            }
        };
        const used = writeIds().max;
        expect(used).toBeGreaterThan(1);
        const pruned = await engine.pruneHistory(path, Date.now() + 1000, { now: Date.now() + 2 * 86_400_000 });
        expect(pruned.writes).toBeGreaterThan(0);
        // Nothing is left, so the next write id is one a pruned write had.
        expect(writeIds()).toEqual({ n: 0, max: 0 });
        // A restart: a new engine and runner on the same file.
        const later = new QueryRunner();
        try {
            const restarted = new DatasetEngine(later);
            expect(restarted.stampToken(path)).toBe(before);
            restarted.insert(path, 'customers', [{ id: 'c4', name: 'Acme East', city: 'Braga' }], 10 * MB, undefined, {
                writer: 'ada',
            });
            const after = restarted.stampToken(path);
            expect(generation(after)).toBe(generation(before));
            expect(value(after)).toBe(value(before) + 1);
            // The pruned history's writes are still in the changes.
            const page = changes(path, one);
            expect(page.upserts.map((row) => row.key).sort()).toEqual(['"c1"', '"c3"', '"c4"', '"c5"']);
            expect(page.deleted.map((row) => row.key)).toEqual(['"c2"']);
            expect(page.token).toBe(after);
        } finally {
            later.close();
        }
    });

    it('gives concurrent writers one value each, in commit order', async () => {
        const path = file();
        const start = value(engine.stampToken(path));
        const writers = Array.from({ length: 6 }, (_, i) =>
            engine.batch(
                path,
                [
                    [
                        {
                            sql: 'INSERT INTO customers (id, name, city) VALUES (?, ?, ?)',
                            params: [`b${i}`, 'Acme', 'Lisbon'],
                        },
                    ],
                ],
                10 * MB,
                { writer: `ada-${i}`, allowDelete: false, timeoutMs: 10_000 },
            ),
        );
        // In-process writes between the batches. Under load a writer may give
        // up waiting for the lock ("database is locked"); one that does keeps
        // nothing and takes no stamp, so only the committed ones are counted.
        let committed = 0;
        for (let i = 0; i < 3; i++) {
            try {
                upsert(path, [{ id: `w${i}`, name: 'Acme', city: 'Porto' }]);
                committed++;
            } catch (error) {
                expect(String(error)).toMatch(/locked|busy/i);
            }
        }
        for (const outcome of await Promise.allSettled(writers)) {
            if (outcome.status === 'fulfilled') {
                committed++;
            } else {
                expect(String(outcome.reason)).toMatch(/locked|busy/i);
            }
        }
        expect(committed).toBeGreaterThan(1);
        const token = engine.stampToken(path);
        expect(value(token)).toBe(start + committed);
        const page = changes(path, `${generation(token)}.${start}`);
        const stamps = page.upserts.map((row) => value(row.stamp));
        // One distinct stamp per committed write, each in the sequence, no gap.
        expect(page.upserts).toHaveLength(committed);
        expect(new Set(stamps).size).toBe(committed);
        expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
        expect(Math.min(...stamps)).toBe(start + 1);
        expect(Math.max(...stamps)).toBe(start + committed);
    });
});

describe('changes?since=', () => {
    it('answers inserts, updates and tombstones in stamp order, with all fields, history or not', () => {
        for (const history of [true, false]) {
            const path = file({ ...customers, history });
            const t0 = engine.stampToken(path);
            upsert(path, [
                { id: 'c1', name: 'Acme', city: 'Lisbon' },
                { id: 'c2', name: 'Acme Labs', city: 'Porto' },
            ]);
            const t1 = engine.stampToken(path);
            upsert(path, [{ id: 'c1', name: 'Acme Inc', city: 'Lisbon' }]);
            engine.deleteRows(path, 'customers', [2], { writer: 'ada' });
            // The same values again change nothing, so take no stamp on the row.
            upsert(path, [{ id: 'c1', name: 'Acme Inc', city: 'Lisbon' }]);
            const all = changes(path, t0);
            expect(all.upserts).toEqual([
                {
                    key: '"c1"',
                    stamp: `${generation(t0)}.${value(t1) + 1}`,
                    values: { id: 'c1', name: 'Acme Inc', city: 'Lisbon' },
                },
            ]);
            expect(all.deleted).toEqual([{ key: '"c2"', stamp: `${generation(t0)}.${value(t1) + 2}` }]);
            expect(all.next).toBeNull();
            expect(all.token).toBe(engine.stampToken(path));
            // Nothing after the last token.
            expect(changes(path, all.token)).toMatchObject({ upserts: [], deleted: [], next: null });
            // A deleted row inserted again is live again, with the new stamp.
            upsert(path, [{ id: 'c2', name: 'Acme Labs', city: 'Faro' }]);
            const back = changes(path, all.token);
            expect(back.deleted).toEqual([]);
            expect(back.upserts.map((row) => [row.key, row.values.city])).toEqual([['"c2"', 'Faro']]);
        }
    });

    it('sends a changed primary key as a tombstone of the old key and the new row', async () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const t = engine.stampToken(path);
        await engine.batch(path, [[{ sql: "UPDATE customers SET id = 'c9' WHERE id = 'c1'", params: [] }]], 10 * MB, {
            writer: 'ada',
            allowDelete: false,
            timeoutMs: 10_000,
        });
        const page = changes(path, t);
        expect(page.deleted.map((row) => row.key)).toEqual(['"c1"']);
        expect(page.upserts.map((row) => row.key)).toEqual(['"c9"']);
    });

    it('writes composite and numeric keys as the wire’s JCS row keys', () => {
        const path = file({
            table: 'customers',
            columns: [
                { name: 'region', type: 'TEXT', primaryKey: true },
                { name: 'n', type: 'INTEGER', primaryKey: true },
                { name: 'name', type: 'TEXT' },
            ],
        });
        const t = engine.stampToken(path);
        engine.insert(path, 'customers', [{ region: 'eu', n: 7, name: 'Acme' }], 10 * MB);
        expect(changes(path, t).upserts.map((row) => row.key)).toEqual(['["eu",7]']);
        const ints = file({
            table: 'customers',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'logo', type: 'BLOB' },
            ],
        });
        const u = engine.stampToken(ints);
        engine.insert(ints, 'customers', [{ id: 42, logo: { $blob: 'AAE=' } }], 10 * MB);
        expect(changes(ints, u).upserts).toEqual([
            { key: '42', stamp: `${generation(u)}.${value(u) + 1}`, values: { id: 42, logo: { $blob: true } } },
        ]);
    });

    it('answers resync, never an empty page, once a key can’t be named on the wire (blob or NULL)', async () => {
        for (const key of ["x'0102'", 'NULL']) {
            const path = file({
                table: 'customers',
                columns: [
                    { name: 'id', type: 'BLOB', primaryKey: true },
                    { name: 'name', type: 'TEXT' },
                ],
            });
            const t = engine.stampToken(path);
            await engine.batch(
                path,
                [[{ sql: `INSERT INTO customers (id, name) VALUES (${key}, 'Acme')`, params: [] }]],
                10 * MB,
                { writer: 'ada', allowDelete: false, timeoutMs: 10_000 },
            );
            expect(changes(path, t), key).toMatchObject({ resync: true, upserts: [], deleted: [], next: null });
        }
    });

    it('answers resync for integer keys past 2^53, which a client would read as one another', async () => {
        for (const composite of [false, true]) {
            const path = file({
                table: 'customers',
                columns: [
                    { name: 'id', type: 'INTEGER', primaryKey: true },
                    ...(composite ? [{ name: 'region', type: 'TEXT' as const, primaryKey: true }] : []),
                    { name: 'name', type: 'TEXT' },
                ],
            });
            const t = engine.stampToken(path);
            await engine.batch(
                path,
                [
                    [
                        {
                            sql: `INSERT INTO customers (id, ${composite ? 'region, ' : ''}name) VALUES (9007199254740992, ${composite ? "'eu', " : ''}'Acme'), (9007199254740993, ${composite ? "'eu', " : ''}'Ada')`,
                            params: [],
                        },
                    ],
                ],
                10 * MB,
                { writer: 'ada', allowDelete: false, timeoutMs: 10_000 },
            );
            expect(changes(path, t)).toMatchObject({ resync: true, upserts: [], deleted: [] });
            const u = engine.stampToken(path);
            await engine.batch(
                path,
                [[{ sql: 'DELETE FROM customers WHERE id = 9007199254740993', params: [] }]],
                10 * MB,
                {
                    writer: 'ada',
                    allowDelete: true,
                    timeoutMs: 10_000,
                },
            );
            expect(changes(path, u)).toMatchObject({ resync: true, upserts: [], deleted: [] });
        }
        // At the edge of the safe range, keys are named exactly.
        const path = file({
            table: 'customers',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'name', type: 'TEXT' },
            ],
        });
        const t = engine.stampToken(path);
        engine.insert(path, 'customers', [{ id: Number.MAX_SAFE_INTEGER, name: 'Acme' }], 10 * MB);
        expect(changes(path, t).upserts.map((row) => row.key)).toEqual(['9007199254740991']);
    });

    it('keeps a blob key and the text that spells it apart', async () => {
        const path = file({
            table: 'customers',
            columns: [
                { name: 'id', type: 'BLOB', primaryKey: true },
                { name: 'name', type: 'TEXT' },
            ],
        });
        await engine.batch(
            path,
            [[{ sql: "INSERT INTO customers (id, name) VALUES (x'0102', 'Acme'), ('x:0102', 'Ada')", params: [] }]],
            10 * MB,
            { writer: 'ada', allowDelete: false, timeoutMs: 10_000 },
        );
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            expect(db.prepare('SELECT count(*) AS n FROM _stamps_customers WHERE deleted = 0').get()).toEqual({ n: 2 });
        } finally {
            db.close();
        }
    });

    it('restamps every row when a column is added, since each row gains a field', () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const t = engine.stampToken(path);
        engine.addColumn(path, 'customers', { name: 'tier', type: 'TEXT', default: 'gold' }, 10 * MB);
        const page = changes(path, t);
        expect(page.upserts.map((row) => [row.key, row.values.tier])).toEqual([['"c1"', 'gold']]);
        expect(page.token).toBe(engine.stampToken(path));
    });

    it('pages by stamp and key, splitting one write across answers', () => {
        const path = file();
        const t0 = engine.stampToken(path);
        upsert(
            path,
            Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'Acme', city: 'Lisbon' })),
        );
        upsert(path, [{ id: 'c9', name: 'Ada', city: 'Porto' }]);
        const first = changes(path, t0, { limit: 3 });
        expect(first.upserts.map((row) => row.key)).toEqual(['"c0"', '"c1"', '"c2"']);
        expect(first.next).not.toBeNull();
        // A client that stops here goes on from before the split write.
        expect(first.token).toBe(t0);
        // Writes between pages show up later, never lost.
        upsert(path, [{ id: 'c0', name: 'Acme Moved', city: 'Faro' }]);
        const second = changes(path, t0, { limit: 3, cursor: first.next! });
        expect(second.upserts.map((row) => row.key)).toEqual(['"c3"', '"c4"', '"c9"']);
        const third = changes(path, t0, { limit: 3, cursor: second.next! });
        expect(third.upserts.map((row) => [row.key, row.values.city])).toEqual([['"c0"', 'Faro']]);
        expect(third.next).toBeNull();
        expect(third.token).toBe(engine.stampToken(path));
        expect(() => engine.changes(path, 'customers', t0, { cursor: 'nope' })).toThrow(/cursor/);
        expect(() => engine.changes(path, 'customers', 'nope')).toThrow(/since/);
    });

    it('answers resync for tables without a primary key, and for analytical tables', () => {
        const path = file({ table: 'visits', columns: [{ name: 'note', type: 'TEXT' }] });
        engine.insert(path, 'visits', [{ note: 'Acme' }], 10 * MB);
        const t = engine.stampToken(path);
        expect(engine.changes(path, 'visits', t)).toEqual({
            token: t,
            resync: true,
            upserts: [],
            deleted: [],
            next: null,
        });
        engine.createAnalyticalTable(path, {
            table: 'events',
            kind: 'analytical',
            columns: [{ name: 'day', type: 'DATE', notNull: true }],
            partitionBy: { column: 'day', grain: 'day' },
        });
        const u = engine.stampToken(path);
        expect(value(u)).toBe(value(t) + 1);
        expect(engine.changes(path, 'events', u)).toMatchObject({ resync: true, upserts: [] });
        expect(() => engine.changes(path, 'nothing', u)).toThrow(/No table/);
    });

    it('reconciles from a token of another generation, past the file, or below the floor', async () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const t = engine.stampToken(path);
        const g = generation(t);
        const reconcile = { token: t, reconcile: true, upserts: [], deleted: [], next: null };
        expect(changes(path, `other.${value(t) - 1}`)).toEqual(reconcile);
        expect(changes(path, `${g}.${value(t) + 5}`)).toEqual(reconcile);
        // A tombstone pruned: a token from before it can't learn of the delete.
        engine.deleteRows(path, 'customers', [1], { writer: 'ada' });
        upsert(path, [{ id: 'c2', name: 'Ada', city: 'Porto' }]);
        const deletedAt = value(t) + 1;
        const pruned = await engine.pruneHistory(path, null, { tombstonesBefore: Date.now() + 1000 });
        expect(pruned.tombstones).toBe(1);
        const now = engine.stampToken(path);
        expect(changes(path, t)).toEqual({ ...reconcile, token: now });
        // At the floor or above, it is answered: nothing it needs was pruned.
        expect(changes(path, `${g}.${deletedAt}`).upserts.map((row) => row.key)).toEqual(['"c2"']);
    });

    it('reconciles after a table is deleted, so a table made later under its name never mixes in', () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const t = engine.stampToken(path);
        engine.deleteTable(path, 'customers');
        engine.createTable(path, customers, 10 * MB);
        upsert(path, [{ id: 'c2', name: 'Ada', city: 'Porto' }]);
        expect(changes(path, t)).toMatchObject({ reconcile: true, upserts: [] });
        const fresh = engine.stampToken(path);
        upsert(path, [{ id: 'c3', name: 'Ada', city: 'Faro' }]);
        expect(changes(path, fresh).upserts.map((row) => row.key)).toEqual(['"c3"']);
    });
});

describe('generations', () => {
    it('starts a new generation at each restore of a backup, and keeps the rows’ own stamps', async () => {
        // A data space as USER_DATA_DIR holds it.
        const root = join(dir, `space${++n}`);
        const datasets = join(root, 'ada', 'datasets');
        mkdirSync(datasets, { recursive: true });
        const path = join(datasets, 'acme.sqlite');
        engine.create(path);
        engine.createTable(path, customers, 10 * MB);
        upsert(path, [
            { id: 'c1', name: 'Acme', city: 'Lisbon' },
            { id: 'c2', name: 'Acme Labs', city: 'Porto' },
        ]);
        const atBackup = engine.stampToken(path);
        const g1 = generation(atBackup);
        const backups = join(dir, `backups${n}`);
        const backup = await backupUserData(root, backups, 3, new Date());
        // Live writes after the backup, seen by a client at `client`.
        upsert(path, [{ id: 'c2', name: 'Acme Labs', city: 'Faro' }]);
        upsert(path, [{ id: 'c3', name: 'Ada', city: 'Braga' }]);
        const client = engine.stampToken(path);
        const cachedC1 = changes(path, `${g1}.0`).upserts.find((row) => row.key === '"c1"')!.stamp;
        // Restore: the backup's file back in place.
        const restore = () => copyFileSync(join(backup.path, 'ada', 'datasets', 'acme.sqlite'), path);
        restore();
        const restored = engine.stampToken(path);
        const g2 = generation(restored);
        expect(g2).not.toBe(g1);
        expect(value(restored)).toBe(value(atBackup));
        // Writes past the client's token reuse numbers the old generation handed out.
        upsert(path, [{ id: 'c2', name: 'Acme Labs', city: 'Evora' }]);
        upsert(path, [{ id: 'c4', name: 'Ada', city: 'Faro' }]);
        expect(value(engine.stampToken(path))).toBe(value(client));
        expect(changes(path, client)).toMatchObject({ reconcile: true, upserts: [], deleted: [] });
        // From the new generation on, changes answer; the untouched row kept its stamp.
        const since = changes(path, restored);
        expect(since.upserts.map((row) => [row.key, row.values.city, generation(row.stamp)])).toEqual([
            ['"c2"', 'Evora', g2],
            ['"c4"', 'Faro', g2],
        ]);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            const stored = db
                .prepare(
                    "SELECT g.generation || '.' || s.stamp AS stamp FROM _stamps_customers s JOIN _stamp_generations g ON g.id = s.gen WHERE s.key = ?",
                )
                .get('["c1"]') as { stamp: string };
            expect(stored.stamp).toBe(cachedC1);
        } finally {
            db.close();
        }
        // The same backup restored again: another generation still.
        restore();
        const again = engine.stampToken(path);
        expect(generation(again)).not.toBe(g1);
        expect(generation(again)).not.toBe(g2);
    });

    it('gives a copy that is written on its own a generation of its own', () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        const target = join(dir, `copy${++n}.sqlite`);
        engine.copy(path, target);
        expect(generation(engine.stampToken(target))).not.toBe(generation(engine.stampToken(path)));
        expect(value(engine.stampToken(target))).toBe(value(engine.stampToken(path)));
    });

    it('stamps a file from before row stamps on first use, every live row with the first value', () => {
        const path = file();
        upsert(path, [
            { id: 'c1', name: 'Acme', city: 'Lisbon' },
            { id: 'c2', name: 'Ada', city: 'Porto' },
        ]);
        // Back to a file as the engine wrote it before stamps (user_version 1).
        const db = new DatabaseSync(path);
        for (const row of db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_keep_stamp_*'")
            .all()) {
            db.exec(`DROP TRIGGER "${String(row.name)}"`);
        }
        db.exec(
            'DROP TABLE _stamps_customers; DROP TABLE _stamp_seq; DROP TABLE _stamp_generations; ALTER TABLE _writer DROP COLUMN stampFloor; PRAGMA user_version=1;',
        );
        db.close();
        const token = engine.stampToken(path);
        expect(value(token)).toBe(1);
        const page = changes(path, `${generation(token)}.0`);
        expect(page.upserts.map((row) => [row.key, row.stamp])).toEqual([
            ['"c1"', token],
            ['"c2"', token],
        ]);
        upsert(path, [{ id: 'c1', name: 'Acme Inc', city: 'Lisbon' }]);
        expect(changes(path, token).upserts.map((row) => [row.key, value(row.stamp)])).toEqual([['"c1"', 2]]);
    });

    it('keeps row stamps out of the SQLite export, listings and the quota', () => {
        const path = file();
        upsert(path, [{ id: 'c1', name: 'Acme', city: 'Lisbon' }]);
        expect(engine.tables(path).map((table) => table.name)).toEqual(['customers']);
        const target = join(dir, `export${++n}.sqlite`);
        engine.exportCopy(path, target);
        const db = new DatabaseSync(target, { readOnly: true });
        try {
            expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*stamp*'").all()).toEqual([]);
        } finally {
            db.close();
        }
        expect(() => engine.createTable(path, { ...customers, table: '_stamps_x' }, 10 * MB)).toThrow(/reserved/);
    });
});
