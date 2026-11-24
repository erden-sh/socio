import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DbFile, SqlError } from '../../src/data';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

// The test driver itself (tests/helpers/node-sqlite-driver.ts): its fake
// SQLCipher pragmas, and the SqlDriver contract the device driver
// must keep too.

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'socio-driver-'));
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

const file = (): DbFile => ({ directory, name: 'a.db' });
const KEY = `"x'${'4b'.repeat(32)}'"`;
const OTHER = `"x'${'b4'.repeat(32)}'"`;

describe('the node:sqlite test driver', () => {
    it('fakes SQLCipher: the cipher pragmas answer once keyed, and a wrong key fails at the first read', async () => {
        const driver = createNodeSqliteDriver();
        const first = await driver.open(file());
        expect(await first.get('PRAGMA cipher_status')).toEqual({ cipher_status: '0' });
        await first.exec(`PRAGMA key = ${KEY}`);
        expect(await first.get('PRAGMA cipher_status')).toEqual({ cipher_status: '1' });
        expect(await first.get('PRAGMA cipher_version')).toEqual({ cipher_version: '4.17.0 community' });
        await first.exec('CREATE TABLE t (x)');
        await first.close();

        const wrong = await driver.open(file());
        await wrong.exec(`PRAGMA key = ${OTHER}`);
        expect(await wrong.get('PRAGMA cipher_status')).toEqual({ cipher_status: '1' });
        await expect(wrong.get('SELECT count(*) FROM sqlite_master')).rejects.toMatchObject({
            name: 'SqlError',
            message: 'file is not a database',
            resultCode: 26,
        });
        // A pragma that reads no page runs with any key, as in SQLCipher.
        await wrong.exec('PRAGMA busy_timeout = 10');
        await wrong.close();

        const unkeyed = await driver.open(file());
        await expect(unkeyed.all('SELECT * FROM t')).rejects.toThrow('file is not a database');
        await unkeyed.close();
    });

    it('binds a key only once the file has a page: an empty file opens with any key, as SQLCipher’s does', async () => {
        const driver = createNodeSqliteDriver();
        const first = await driver.open(file());
        await first.exec(`PRAGMA key = ${KEY}`);
        expect(await first.get('SELECT count(*) AS tables FROM sqlite_master')).toEqual({ tables: 0 });
        await first.close();
        // Opening made a 0-byte file, and reading it wrote nothing.
        expect(statSync(join(directory, 'a.db')).size).toBe(0);

        const other = await driver.open(file());
        await other.exec(`PRAGMA key = ${OTHER}`);
        expect(await other.get('SELECT count(*) AS tables FROM sqlite_master')).toEqual({ tables: 0 });
        expect(await other.get('PRAGMA page_count')).toEqual({ page_count: 0 });
        await other.exec('CREATE TABLE t (x)');
        await other.close();

        // The key that wrote the first page is the file's.
        const first2 = await driver.open(file());
        await first2.exec(`PRAGMA key = ${KEY}`);
        await expect(first2.get('SELECT count(*) FROM sqlite_master')).rejects.toThrow('file is not a database');
        await first2.close();
        const other2 = await driver.open(file());
        await other2.exec(`PRAGMA key = ${OTHER}`);
        expect(await other2.all('SELECT * FROM t')).toEqual([]);
        await other2.close();
    });

    it('rejects with SqlError and SQLite’s result code', async () => {
        const db = await createNodeSqliteDriver().open(file());
        const error = await db.exec('CREATE TABLE (').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SqlError);
        expect(error).toMatchObject({ resultCode: 1, cause: { code: 'ERR_SQLITE_ERROR' } });
        await db.exec('CREATE TABLE t (x UNIQUE)');
        await db.run('INSERT INTO t VALUES (1)');
        // An extended code (SQLITE_CONSTRAINT_UNIQUE, 2067) gives its primary one, SQLITE_CONSTRAINT.
        await expect(db.run('INSERT INTO t VALUES (1)')).rejects.toMatchObject({ resultCode: 19 });
        await db.close();
    });

    it('answers like SQLite without SQLCipher when told to', async () => {
        const db = await createNodeSqliteDriver({ cipherStatus: null, cipherVersion: null }).open(file());
        await db.exec(`PRAGMA key = ${KEY}`);
        expect(await db.get('PRAGMA cipher_status')).toBeNull();
        expect(await db.all('PRAGMA cipher_version')).toEqual([]);
        await db.close();
    });

    it('runs a transaction alone: a statement from outside waits for it', async () => {
        const db = await createNodeSqliteDriver().open(file());
        await db.exec('CREATE TABLE t (x TEXT)');
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transaction = db.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (?)', ['inside']);
            await gate;
            return (await tx.all<{ x: string }>('SELECT x FROM t')).map((row) => row.x);
        });
        const outside = db.run('INSERT INTO t VALUES (?)', ['outside']);
        release();
        expect(await transaction).toEqual(['inside']);
        await outside;
        expect(await db.all('SELECT x FROM t ORDER BY rowid')).toEqual([{ x: 'inside' }, { x: 'outside' }]);
        await db.close();
    });

    it('rolls a failed transaction back and rethrows its error', async () => {
        const db = await createNodeSqliteDriver().open(file());
        await db.exec('CREATE TABLE t (x TEXT)');
        const failure = new Error('task failed');
        await expect(
            db.transaction(async (tx) => {
                await tx.run('INSERT INTO t VALUES (?)', ['gone']);
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(await db.all('SELECT x FROM t')).toEqual([]);
        expect(await db.run('INSERT INTO t VALUES (?)', ['kept'])).toEqual({ changes: 1, lastInsertRowId: 1 });
        await db.close();
    });

    it('closes once, refuses statements after, and deletes a file only when closed, with its -wal and -shm', async () => {
        const driver = createNodeSqliteDriver();
        const db = await driver.open(file());
        await db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
        expect(existsSync(join(directory, 'a.db-wal'))).toBe(true);
        await expect(driver.delete(file())).rejects.toThrow(/currently open/);
        await db.close();
        await db.close();
        await expect(db.get('SELECT 1')).rejects.toThrow('a.db is closed.');
        await driver.delete(file());
        expect(['a.db', 'a.db-wal', 'a.db-shm'].filter((name) => existsSync(join(directory, name)))).toEqual([]);
        await driver.delete(file());
    });
});
