import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DbFile, type OpenFailure, openEncrypted, SqlError, SQLITE_BUSY, StoreOpenError } from '../../src/data';
import { createNodeSqliteDriver, type NodeSqliteDriverOptions } from '../helpers/node-sqlite-driver';

// The fail-closed open (src/data/open.ts)
// on real SQLite files, with SQLCipher's pragmas faked
// (tests/helpers/node-sqlite-driver.ts).

const KEY = '3c'.repeat(32);
const OTHER_KEY = 'a7'.repeat(32);

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'socio-open-'));
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

const file = (): DbFile => ({ directory, name: 'cache.db' });
const path = () => join(directory, 'cache.db');
/** The main file's size, 0 when there's none: a refused open writes nothing. */
const size = () => (existsSync(path()) ? statSync(path()).size : 0);

/** A file made through openEncrypted with `key`, holding one table and row, closed. */
async function existing(key = KEY): Promise<void> {
    const { db } = await openEncrypted(createNodeSqliteDriver(), file(), key);
    await db.exec('CREATE TABLE t (x TEXT)');
    await db.run('INSERT INTO t VALUES (?)', ['kept']);
    await db.close();
}

/** Skips `PRAGMA busy_timeout`, so a lock fails at once instead of after 5 s. */
const noBusyWait = (sql: string) => (/^PRAGMA busy_timeout/i.test(sql.trim()) ? [] : undefined);

/** What openEncrypted rejects with. */
async function refusal(promise: Promise<unknown>): Promise<StoreOpenError> {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StoreOpenError);
    return error as StoreOpenError;
}

describe('openEncrypted', () => {
    it('keys the file, checks the cipher, reads it, sets auto-vacuum and then WAL, in that order', async () => {
        const driver = createNodeSqliteDriver();
        const { db, created } = await openEncrypted(driver, file(), KEY);
        expect(created).toBe(true);
        expect(driver.log).toEqual([
            `cache.db: PRAGMA key = "x'${KEY}'"`,
            'cache.db: PRAGMA busy_timeout = 5000',
            'cache.db: PRAGMA cipher_status',
            'cache.db: PRAGMA cipher_version',
            'cache.db: SELECT count(*) AS tables FROM sqlite_master',
            'cache.db: PRAGMA page_count',
            'cache.db: PRAGMA auto_vacuum = INCREMENTAL',
            'cache.db: PRAGMA auto_vacuum',
            'cache.db: PRAGMA journal_mode = WAL',
        ]);
        // A statement waits out another connection's lock instead of failing at once.
        expect(await db.get('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
        await db.close();
        expect(driver.openPaths()).toEqual([]);
    });

    it('gives a new file incremental auto-vacuum (2) and WAL, which last (real SQLite)', async () => {
        await existing();
        const raw = new DatabaseSync(path());
        try {
            expect(raw.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
            expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
            expect(raw.prepare('SELECT x FROM t').all()).toEqual([{ x: 'kept' }]);
        } finally {
            raw.close();
        }
    });

    it('must set auto-vacuum before WAL: after it, SQLite keeps 0 on a new file', () => {
        // Why step 4 comes before step 5: journal_mode=WAL writes page 1.
        const raw = new DatabaseSync(path());
        try {
            raw.exec('PRAGMA journal_mode = WAL');
            raw.exec('PRAGMA auto_vacuum = INCREMENTAL');
            raw.exec('CREATE TABLE t (x TEXT)');
            expect(raw.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
        } finally {
            raw.close();
        }
    });

    it('leaves the auto-vacuum mode of a file with pages alone', async () => {
        await existing();
        const driver = createNodeSqliteDriver();
        const { db, created } = await openEncrypted(driver, file(), KEY);
        expect(created).toBe(false);
        expect(driver.log.filter((line) => line.includes('auto_vacuum'))).toEqual([]);
        expect(await db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
        await db.close();
    });

    it('takes the key in either case', async () => {
        await existing(KEY);
        const { db } = await openEncrypted(createNodeSqliteDriver(), file(), KEY.toUpperCase());
        expect(await db.all('SELECT x FROM t')).toEqual([{ x: 'kept' }]);
        await db.close();
    });

    it.each([
        ['empty', ''],
        ['too short', '3c'.repeat(31)],
        ['too long', '3c'.repeat(33)],
        ['not hex', 'zz'.repeat(32)],
        ['a passphrase', 'correct horse battery staple'],
        ['SQL around a key', `${'3c'.repeat(31)}'"; PRAGMA key = "x'00`],
    ])('refuses a key that is %s before opening anything', async (_, key) => {
        const driver = createNodeSqliteDriver();
        const error = await refusal(openEncrypted(driver, file(), key));
        expect(error).toMatchObject({ failure: 'invalid-key', file: file() });
        expect(driver.log).toEqual([]);
        expect(existsSync(path())).toBe(false);
    });

    const autoVacuumReadsZero = (sql: string) =>
        /^PRAGMA auto_vacuum$/i.test(sql.trim()) ? [{ auto_vacuum: 0 }] : undefined;
    const journalStaysDelete = (sql: string) => (/journal_mode/i.test(sql) ? [{ journal_mode: 'delete' }] : undefined);
    const journalLocked = (sql: string) => {
        if (/journal_mode/i.test(sql)) {
            throw new SqlError('database is locked', SQLITE_BUSY);
        }
        return undefined;
    };
    // Steps 1 to 3 fail before anything is written: a build without SQLCipher
    // never writes a plaintext page. Steps 4 and 5 come after the key is
    // proven, and setting auto_vacuum writes page 1, encrypted on a device.
    const failures: [string, OpenFailure, NodeSqliteDriverOptions, 'writes nothing' | 'keyed'][] = [
        [
            'the driver can’t open it',
            'open-failed',
            { openError: new Error('unable to open database file') },
            'writes nothing',
        ],
        ['PRAGMA key fails', 'key-failed', { keyError: new Error('out of memory') }, 'writes nothing'],
        [
            'the build has no SQLCipher (neither pragma answers)',
            'no-cipher',
            { cipherStatus: null, cipherVersion: null },
            'writes nothing',
        ],
        ['cipher_status is 0', 'no-cipher', { cipherStatus: '0' }, 'writes nothing'],
        ['cipher_status answers no row', 'no-cipher', { cipherStatus: null }, 'writes nothing'],
        ['cipher_version is empty', 'no-cipher', { cipherVersion: '' }, 'writes nothing'],
        ['cipher_version answers no row', 'no-cipher', { cipherVersion: null }, 'writes nothing'],
        ['auto_vacuum doesn’t read back 2', 'auto-vacuum', { intercept: autoVacuumReadsZero }, 'keyed'],
        ['journal_mode doesn’t become wal', 'wal', { intercept: journalStaysDelete }, 'keyed'],
        ['another connection’s lock outlasts the busy timeout at WAL', 'busy', { intercept: journalLocked }, 'keyed'],
    ];

    it.each(failures)('refuses a new file when %s, and closes it', async (_, failure, options, writes) => {
        const driver = createNodeSqliteDriver(options);
        const error = await refusal(openEncrypted(driver, file(), KEY));
        expect(error).toMatchObject({ failure, file: file(), name: 'StoreOpenError' });
        expect(error.message).toMatch(/^cache\.db: /);
        expect(driver.openPaths()).toEqual([]);
        if (writes === 'writes nothing') {
            expect(size()).toBe(0);
        }
    });

    it('refuses a file opened with another key at the sqlite_master read, and leaves it as it was', async () => {
        const keys = new Map<string, string>();
        const { db } = await openEncrypted(createNodeSqliteDriver({ keys }), file(), KEY);
        await db.exec('CREATE TABLE t (x TEXT)');
        await db.close();
        const before = readFileSync(path());

        const driver = createNodeSqliteDriver({ keys });
        const error = await refusal(openEncrypted(driver, file(), OTHER_KEY));
        expect(error).toMatchObject({ failure: 'wrong-key', file: file() });
        expect(error.cause).toBeInstanceOf(SqlError);
        expect(error.cause).toMatchObject({ resultCode: 26, message: 'file is not a database' });
        // The cipher checks passed, as SQLCipher's do for any key; the first read failed.
        expect(driver.log.at(-1)).toBe('cache.db: SELECT count(*) AS tables FROM sqlite_master');
        expect(driver.openPaths()).toEqual([]);
        expect(readFileSync(path()).equals(before)).toBe(true);

        const again = await openEncrypted(driver, file(), KEY);
        expect(again.created).toBe(false);
        await again.db.close();
    });

    // Only SQLITE_NOTADB says the key is wrong, and the remedy for a wrong key is
    // deleting the files: nothing else that fails the read may look like it.
    it('reports a lock at the sqlite_master read as busy, not wrong-key, and leaves the file as it was', async () => {
        await existing();
        const before = readFileSync(path());
        const holder = new DatabaseSync(path());
        try {
            holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
            const driver = createNodeSqliteDriver({ intercept: noBusyWait });
            const error = await refusal(openEncrypted(driver, file(), KEY));
            expect(error).toMatchObject({ failure: 'busy', file: file() });
            expect(error.cause).toMatchObject({ resultCode: SQLITE_BUSY, message: 'database is locked' });
            expect(driver.log.at(-1)).toBe('cache.db: SELECT count(*) AS tables FROM sqlite_master');
            expect(driver.openPaths()).toEqual([]);
            holder.exec('ROLLBACK');
        } finally {
            holder.close();
        }
        expect(readFileSync(path()).equals(before)).toBe(true);
        const again = await openEncrypted(createNodeSqliteDriver(), file(), KEY);
        expect(await again.db.all('SELECT x FROM t')).toEqual([{ x: 'kept' }]);
        await again.db.close();
    });

    it('reports a damaged page as damaged, not wrong-key, and leaves the file as it was (real SQLite)', async () => {
        await existing();
        const damaged = readFileSync(path());
        damaged[100] = 0xff; // page 1's b-tree header: no such page type
        writeFileSync(path(), damaged);

        const driver = createNodeSqliteDriver();
        const error = await refusal(openEncrypted(driver, file(), KEY));
        expect(error).toMatchObject({ failure: 'damaged', file: file() });
        expect(error.cause).toMatchObject({ resultCode: 11, message: 'database disk image is malformed' });
        expect(driver.openPaths()).toEqual([]);
        expect(readFileSync(path()).equals(damaged)).toBe(true);
    });

    it.each([
        ['an I/O error', new SqlError('disk I/O error', 10)],
        ['a full disk', new SqlError('database or disk is full', 13)],
        ['an error with no result code', new Error('file is not a database')],
    ])('reports %s at the sqlite_master read as read-failed', async (_, failure) => {
        await existing();
        const before = readFileSync(path());
        const driver = createNodeSqliteDriver({
            intercept: (sql) => {
                if (/sqlite_master/.test(sql)) {
                    throw failure;
                }
                return undefined;
            },
        });
        const error = await refusal(openEncrypted(driver, file(), KEY));
        expect(error).toMatchObject({ failure: 'read-failed', file: file() });
        expect(error.cause).toBe(failure);
        expect(driver.openPaths()).toEqual([]);
        expect(readFileSync(path()).equals(before)).toBe(true);
    });

    it('leaves no key behind when it refuses a new file: the empty file it made is new to any key, as in SQLCipher', async () => {
        const keys = new Map<string, string>();
        const refused = await refusal(openEncrypted(createNodeSqliteDriver({ keys, cipherStatus: '0' }), file(), KEY));
        expect(refused.failure).toBe('no-cipher');
        expect(existsSync(path()) && size()).toBe(0);

        const { db, created } = await openEncrypted(createNodeSqliteDriver({ keys }), file(), OTHER_KEY);
        expect(created).toBe(true);
        await db.close();
    });
});
