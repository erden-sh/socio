import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { DataError } from '@socio/foundation/dataspace/data-error';

import { DatasetEngine, DatasetFileMissingError } from '../src/server/dataspace/engine.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';
import { singleQuery } from '../src/server/dataspace/sql.js';

let dir: string;
let runner: QueryRunner;
let engine: DatasetEngine;
let path: string;
const MB = 1024 * 1024;
const caps = { maxRows: 500, maxBytes: 256 * 1024, timeoutMs: 5000 };

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-data-engine-'));
    runner = new QueryRunner();
    engine = new DatasetEngine(runner);
    path = join(dir, 'd.sqlite');
    engine.create(path);
    engine.createTable(
        path,
        {
            table: 'prices',
            columns: [
                { name: 'sku', type: 'TEXT', primaryKey: true },
                { name: 'price', type: 'REAL' },
                { name: 'seen', type: 'DATETIME' },
            ],
        },
        10 * MB,
    );
    engine.insert(
        path,
        'prices',
        Array.from({ length: 40 }, (_, i) => ({
            sku: `s${i}`,
            price: i * 1.5,
            seen: '2026-10-08',
        })),
        10 * MB,
    );
});
afterAll(() => {
    runner.close();
    rmSync(dir, { recursive: true, force: true });
});

const refused = async (sql: string, params: Array<string | number> = []) => {
    const error = await engine.query(path, sql, params, caps).then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error, sql).toBeInstanceOf(DataError);
    return (error as DataError).message;
};

it('runs read-only queries with bound parameters', async () => {
    const result = await engine.query(
        path,
        'SELECT sku, price FROM prices WHERE price > ? ORDER BY price DESC LIMIT 2;',
        [50],
        caps,
    );
    expect(result.columns).toEqual(['sku', 'price']);
    expect(result.rows).toEqual([
        ['s39', 58.5],
        ['s38', 57],
    ]);
    const cte = await engine.query(
        path,
        'WITH cheap AS (SELECT * FROM prices WHERE price < 3) SELECT count(*) FROM cheap',
        [],
        caps,
    );
    expect(cte.rows).toEqual([[2]]);
    // A parameter is a value, never SQL.
    const injection = await engine.query(path, 'SELECT count(*) FROM prices WHERE sku = ?', ["x' OR '1'='1"], caps);
    expect(injection.rows).toEqual([[0]]);
});

it('refuses ATTACH, PRAGMA, writes, file and extension functions, and more than one statement', async () => {
    expect(await refused("ATTACH DATABASE '/tmp/x.sqlite' AS x")).toMatch(/read-only SELECT/);
    expect(await refused('PRAGMA journal_mode=WAL')).toMatch(/read-only SELECT/);
    expect(await refused("VACUUM INTO '/tmp/copy.sqlite'")).toMatch(/read-only SELECT/);
    expect(await refused("SELECT 1; ATTACH '/tmp/x' AS x")).toMatch(/one statement/);
    expect(await refused('SELECT 1; SELECT 2')).toMatch(/one statement/);
    expect(await refused('WITH x AS (SELECT 1) DELETE FROM prices')).toMatch(/Not allowed|read-only/);
    expect(await refused("SELECT load_extension('/tmp/evil.so')")).toMatch(/Not allowed/);
    expect(await refused("SELECT * FROM pragma_table_info('prices')")).toMatch(/Not allowed/);
    expect(await refused('SELECT zeroblob(1000000000)')).toMatch(/Not allowed/);
    expect(await refused("SELECT readfile('/etc/passwd')")).toMatch(/Not allowed|failed/);
    // A ; inside a string or comment is not a second statement.
    const ok = await engine.query(path, "SELECT ';' AS a -- ; ATTACH\n", [], caps);
    expect(ok.rows).toEqual([[';']]);
    expect(singleQuery('select 1 ;  ')).toBe('select 1 ');
});

it('caps rows and bytes', async () => {
    const rows = await engine.query(path, 'SELECT * FROM prices', [], {
        ...caps,
        maxRows: 5,
    });
    expect(rows.rows).toHaveLength(5);
    expect(rows.truncated).toBe(true);
    const bytes = await engine.query(
        path,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n LIMIT 1000) SELECT printf('%.100c', 'x') FROM n",
        [],
        { ...caps, maxRows: 1000, maxBytes: 2000 },
    );
    expect(bytes.truncated).toBe(true);
    expect(bytes.rows.length).toBeLessThan(25);
});

it('stops a query that runs too long, and keeps serving', async () => {
    const started = Date.now();
    const message = await engine
        .query(path, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT count(*) FROM n', [], {
            ...caps,
            timeoutMs: 400,
        })
        .then(
            () => '',
            (e: Error) => e.message,
        );
    expect(message).toMatch(/longer than 0.4 s/);
    expect(Date.now() - started).toBeLessThan(4000);
    expect((await engine.query(path, 'SELECT count(*) FROM prices', [], caps)).rows).toEqual([[40]]);
});

it('builds schema and rows from validated names only', () => {
    expect(() =>
        engine.createTable(path, { table: 'x"; DROP TABLE prices; --', columns: [{ name: 'a' }] }, 10 * MB),
    ).toThrow(/Invalid table name/);
    expect(() => engine.createTable(path, { table: 'sqlite_x', columns: [{ name: 'a' }] }, 10 * MB)).toThrow(
        /Invalid table name/,
    );
    expect(() => engine.insert(path, 'prices', [{ nope: 1 }], 10 * MB)).toThrow(/not in "prices"/);
    engine.addColumn(path, 'prices', { name: 'currency', type: 'TEXT', notNull: true, default: 'EUR' }, 10 * MB);
    expect(() => engine.addColumn(path, 'prices', { name: 'n', notNull: true }, 10 * MB)).toThrow(/needs a default/);
    const upsert = engine.insert(path, 'prices', [{ sku: 's1', price: 99 }], 10 * MB, ['sku']);
    expect(upsert.changes).toBe(1);
    const table = engine.tables(path).find((t) => t.name === 'prices')!;
    expect(table.rowCount).toBe(40);
    expect(table.columns.map((c) => c.name)).toEqual(['sku', 'price', 'seen', 'currency']);
    expect(engine.rows(path, 'prices', 1, 1).rows).toEqual([['s1', 99, '2026-10-08', 'EUR']]);
    expect(engine.csv(path, 'prices').split('\r\n')[0]).toBe('sku,price,seen,currency');
});

it('enforces the size quota in SQLite itself', () => {
    const small = join(dir, 'small.sqlite');
    engine.create(small);
    engine.createTable(small, { table: 't', columns: [{ name: 'v', type: 'TEXT' }] }, 64 * 1024);
    const big = 'x'.repeat(20_000);
    expect(() =>
        engine.insert(
            small,
            't',
            Array.from({ length: 10 }, () => ({ v: big })),
            64 * 1024,
        ),
    ).toThrow(/full/);
    // The failed insert rolled back as a whole.
    expect(engine.tables(small)[0].rowCount).toBe(0);
});

it('deletes shared rows into history and keeps repeated table deletions separate', async () => {
    const shared = join(dir, 'shared.sqlite');
    engine.create(shared);
    const create = () =>
        engine.createTable(
            shared,
            {
                table: 'items',
                columns: [{ name: 'title', type: 'TEXT' }],
            },
            10 * MB,
        );
    create();
    engine.insert(shared, 'items', [{ title: 'first' }, { title: 'second' }], 10 * MB);
    const rows = engine.rows(shared, 'items', 0, 20, { rowids: true });
    expect(rows.rowids).toHaveLength(2);
    expect(engine.deleteRows(shared, 'items', [rows.rowids![0]], { writer: 'bob' })).toEqual({ deleted: 1 });
    expect(engine.rows(shared, 'items', 0, 20).rows).toEqual([['second']]);
    const first = engine.deleteTable(shared, 'items', 123, { writer: 'bob' });
    create();
    const second = engine.deleteTable(shared, 'items', 123, { writer: 'alice' });
    expect(second.table).not.toBe(first.table);
    expect(engine.tables(shared)).toEqual([]);
    await expect(engine.query(shared, `SELECT * FROM "${first.table}"`, [], caps)).rejects.toThrow();
});

it('does not expose unsafe or unavailable row identifiers for deletion', () => {
    const special = join(dir, 'rowids.sqlite');
    engine.create(special);
    const db = new DatabaseSync(special);
    db.exec(`CREATE TABLE huge (title TEXT); INSERT INTO huge(rowid,title) VALUES (9007199254740993,'unsafe');
    CREATE TABLE shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT); INSERT INTO shadowed VALUES ('x','y','z');
    CREATE TABLE keyed (id TEXT PRIMARY KEY) WITHOUT ROWID; INSERT INTO keyed VALUES ('a');`);
    db.close();
    for (const table of ['huge', 'shadowed', 'keyed']) {
        expect(engine.rows(special, table, 0, 10, { rowids: true }).rowids, table).toBeUndefined();
    }
});

it('fails a missing dataset file with a typed error and never creates it (CB-340)', async () => {
    const gone = join(dir, 'gone', 'missing.sqlite');
    const write = () => engine.createTable(gone, { table: 't', columns: [{ name: 'a' }] }, 10 * MB);
    expect(write).toThrow(DatasetFileMissingError);
    expect(() => engine.insert(gone, 't', [{ a: 1 }], 10 * MB)).toThrow(DatasetFileMissingError);
    expect(() => engine.tables(gone)).toThrow(DatasetFileMissingError);
    expect(() => engine.rows(gone, 't', 0, 10)).toThrow(DatasetFileMissingError);
    expect(() => engine.copy(gone, join(dir, 'copy.sqlite'))).toThrow(DatasetFileMissingError);
    await expect(engine.query(gone, 'SELECT 1', [], caps)).rejects.toThrow(DatasetFileMissingError);
    try {
        write();
    } catch (error) {
        expect(error).toBeInstanceOf(DataError);
        expect((error as DatasetFileMissingError).status).toBe(503);
        expect((error as DatasetFileMissingError).code).toBe('dataset_file_missing');
        expect((error as Error).message).not.toContain(dir);
    }
    expect(existsSync(gone)).toBe(false);
});

it('still creates a brand-new dataset file (CB-340)', () => {
    const fresh = join(dir, 'new', 'fresh.sqlite');
    engine.create(fresh);
    expect(existsSync(fresh)).toBe(true);
    expect(engine.tables(fresh)).toEqual([]);
});

it('exports CSV with formulas written as text, in text and in bytes, and numbers as they are', () => {
    const csvPath = join(dir, 'csv-guard.sqlite');
    engine.create(csvPath);
    engine.createTable(
        csvPath,
        {
            table: 'cells',
            columns: [
                { name: 'label', type: 'TEXT' },
                { name: 'amount', type: 'INTEGER' },
                { name: 'raw', type: 'BLOB' },
            ],
        },
        10 * MB,
    );
    engine.insert(
        csvPath,
        'cells',
        [
            { label: '=HYPERLINK("https://example.com")', amount: -5, raw: null },
            { label: '@cmd', amount: 3, raw: null },
            { label: 'plain', amount: null, raw: null },
        ],
        10 * MB,
    );
    const db = new DatabaseSync(csvPath);
    db.prepare('UPDATE cells SET raw = ? WHERE label = ?').run(new Uint8Array([0xfb, 0xff, 0xbf]), 'plain');
    db.close();
    expect(engine.csv(csvPath, 'cells')).toBe(
        'label,amount,raw\r\n' +
            '"\'=HYPERLINK(""https://example.com"")",-5,\r\n' +
            "'@cmd,3,\r\n" +
            "plain,,'+/+/\r\n",
    );
});
