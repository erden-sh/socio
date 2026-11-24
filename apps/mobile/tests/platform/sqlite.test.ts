import { describe, expect, it, vi } from 'vitest';

import { isBusy, openEncrypted, resultCode, SqlError, StoreOpenError } from '../../src/data';
import { createExpoSqliteDriver, type ExpoSqlite, sqlErrorFrom } from '../../src/platform/sqlite';

// The store's SqlDriver on expo-sqlite (src/platform/sqlite.ts), against a fake
// expo-sqlite that behaves as 58.0.15's native side does where the driver
// depends on it: a connection per open, a delete that throws while any
// connection to the path is open, and errors whose message carries
// "Error code N". Whether SQLCipher really encrypts is the device check
// (Diagnostics).

// The real module loads React Native; the driver gets the fake below instead.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(), deleteDatabaseAsync: vi.fn() }));

const DIRECTORY = 'file:///data/user/0/app/files/socio/ab';
const CACHE = { directory: DIRECTORY, name: 'cache.db' };
const USER = { directory: DIRECTORY, name: 'user.db' };
const KEY = '3c'.repeat(32);

interface FakeOptions {
    /** Answers a statement's rows, or throws as SQLite would; undefined answers none. */
    readonly answer?: (sql: string) => unknown;
    /** Runs before a statement answers, so a test can hold it. */
    readonly before?: (sql: string) => Promise<void> | void;
}

/** A fake expo-sqlite, with a log of every call in order, and the paths on "disk". */
function fakeSqlite(options: FakeOptions = {}) {
    const log: string[] = [];
    const open = new Map<string, number>();
    const onDisk = new Set<string>();
    const statement =
        (name: string, isClosed: () => boolean, rows: (answer: unknown) => unknown) =>
        async (sql: string, params?: unknown) => {
            if (isClosed()) {
                throw new Error('Access to closed resource');
            }
            log.push(
                `${name}: ${sql}${params === undefined || (Array.isArray(params) && params.length === 0) ? '' : ` ${JSON.stringify(params)}`}`,
            );
            await options.before?.(sql);
            return rows(options.answer?.(sql));
        };
    const sqlite: ExpoSqlite = {
        openDatabaseAsync: vi.fn(async (name: string, openOptions?: object, directory?: string) => {
            const path = `${directory}/${name}`;
            log.push(`open ${name} ${JSON.stringify(openOptions)}`);
            open.set(path, (open.get(path) ?? 0) + 1);
            onDisk.add(path);
            let closed = false;
            const isClosed = () => closed;
            return {
                execAsync: statement(name, isClosed, () => undefined),
                runAsync: statement(name, isClosed, () => ({ changes: 1, lastInsertRowId: 7 })),
                getFirstAsync: statement(name, isClosed, (rows) => (Array.isArray(rows) ? (rows[0] ?? null) : null)),
                getAllAsync: statement(name, isClosed, (rows) => (Array.isArray(rows) ? rows : [])),
                closeAsync: async () => {
                    if (closed) {
                        throw new Error('Access to closed resource');
                    }
                    closed = true;
                    open.set(path, (open.get(path) ?? 1) - 1);
                    log.push(`close ${name}`);
                },
                withExclusiveTransactionAsync: () => {
                    throw new Error('A second connection has no key.');
                },
                withTransactionAsync: () => {
                    throw new Error('Other statements would land inside it.');
                },
            } as never;
        }) as never,
        deleteDatabaseAsync: vi.fn(async (name: string, directory?: string) => {
            const path = `${directory}/${name}`;
            if ((open.get(path) ?? 0) > 0) {
                throw new Error(
                    `Unable to delete database '${path}' that is currently open. Close it prior to deletion.`,
                );
            }
            if (!onDisk.delete(path)) {
                throw new Error(`Database '${path}' not found`);
            }
            log.push(`delete ${name}`);
        }) as never,
    };
    const files = {
        exists: async (path: string) => onDisk.has(path),
        remove: async (path: string) => {
            log.push(`remove ${path.slice(DIRECTORY.length + 1)}`);
        },
    };
    return { sqlite, files, log, onDisk, driver: createExpoSqliteDriver({ files, sqlite }) };
}

/** A promise and the function that settles it. */
function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

describe("expo-sqlite's errors", () => {
    it('carry SQLite’s result code from the message, as Android words it', () => {
        const native = new Error(
            "Call to function 'NativeStatement.finalizeAsync' has been rejected.\n→ Caused by: Error code 26: file is not a database",
        );
        const error = sqlErrorFrom(native);
        expect(error).toBeInstanceOf(SqlError);
        expect(resultCode(error)).toBe(26);
        expect((error as SqlError).message).toBe(native.message);
        expect((error as SqlError).cause).toBe(native);
    });

    it('carry it from the bare form some iOS statements throw, and keep the primary code of an extended one', () => {
        expect(isBusy(sqlErrorFrom(new Error('Error code 5')))).toBe(true);
        expect(resultCode(sqlErrorFrom(new Error('Error code 2067: UNIQUE constraint failed: t.x')))).toBe(19);
        expect(resultCode(sqlErrorFrom('Error code 11: database disk image is malformed'))).toBe(11);
    });

    it('leave an error with no code as it is, and a SqlError as it is', () => {
        const closed = new Error('Access to closed resource');
        expect(sqlErrorFrom(closed)).toBe(closed);
        const coded = new SqlError('busy', 5);
        expect(sqlErrorFrom(coded)).toBe(coded);
        expect(sqlErrorFrom(new Error('Error codes are not here'))).toBeInstanceOf(Error);
        expect(resultCode(sqlErrorFrom(new Error('Error codes are not here')))).toBeUndefined();
    });

    it('reach open.ts with their code, so a wrong key reads as one', async () => {
        const { driver, log } = fakeSqlite({
            answer: (sql) => {
                if (sql === 'PRAGMA cipher_status') {
                    return [{ cipher_status: '1' }];
                }
                if (sql === 'PRAGMA cipher_version') {
                    return [{ cipher_version: '4.17.0 community' }];
                }
                if (sql.includes('sqlite_master')) {
                    throw new Error(
                        "Call to function 'NativeStatement.runAsync' has been rejected.\n→ Caused by: Error code 26: file is not a database",
                    );
                }
                return undefined;
            },
        });
        const failure = await openEncrypted(driver, CACHE, KEY).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(StoreOpenError);
        expect((failure as StoreOpenError).failure).toBe('wrong-key');
        // The key, the pragmas and the read went over one connection, which the refusal closed.
        expect(log.filter((line) => line.startsWith('open') || line.startsWith('close'))).toEqual([
            'open cache.db {"useNewConnection":true}',
            'close cache.db',
        ]);
    });
});

describe('the expo-sqlite driver', () => {
    it('opens every file on a connection of its own, in its directory', async () => {
        const { driver, sqlite } = fakeSqlite();
        const first = await driver.open(CACHE);
        const second = await driver.open(CACHE);
        expect(first).not.toBe(second);
        expect(sqlite.openDatabaseAsync).toHaveBeenCalledTimes(2);
        expect(sqlite.openDatabaseAsync).toHaveBeenCalledWith('cache.db', { useNewConnection: true }, DIRECTORY);
        // Closing one leaves the other working.
        await first.close();
        await expect(second.get('SELECT 1')).resolves.toBeNull();
    });

    it('binds values and answers rows and run results', async () => {
        const { driver, log } = fakeSqlite({ answer: () => [{ x: 'a' }, { x: 'b' }] });
        const db = await driver.open(CACHE);
        expect(await db.run('INSERT INTO t VALUES (?, ?)', ['a', null])).toEqual({ changes: 1, lastInsertRowId: 7 });
        expect(await db.get('SELECT x FROM t')).toEqual({ x: 'a' });
        expect(await db.all('SELECT x FROM t WHERE x > ?', ['']).then((rows) => rows.length)).toBe(2);
        expect(log).toContain('cache.db: INSERT INTO t VALUES (?, ?) ["a",null]');
    });

    it('keeps every other statement out of a transaction until it ends, on the same connection', async () => {
        const hold = deferred();
        const { driver, log, sqlite } = fakeSqlite({
            before: (sql) => (sql === 'UPDATE t SET x = 1' ? hold.promise : undefined),
        });
        const db = await driver.open(CACHE);
        const transaction = db.transaction(async (tx) => {
            await tx.run('UPDATE t SET x = 1');
            return 'done';
        });
        const outside = db.run('UPDATE t SET x = 2');
        await vi.waitFor(() => expect(log).toContain('cache.db: UPDATE t SET x = 1'));
        expect(log).not.toContain('cache.db: UPDATE t SET x = 2');
        hold.resolve();
        await expect(transaction).resolves.toBe('done');
        await outside;
        expect(log.slice(1)).toEqual([
            'cache.db: BEGIN IMMEDIATE',
            'cache.db: UPDATE t SET x = 1',
            'cache.db: COMMIT',
            'cache.db: UPDATE t SET x = 2',
        ]);
        expect(sqlite.openDatabaseAsync).toHaveBeenCalledOnce();
    });

    it('rolls a failed transaction back, rethrows its error, and goes on with the next statement', async () => {
        const { driver, log } = fakeSqlite();
        const db = await driver.open(CACHE);
        const failure = new Error('the task failed');
        await expect(
            db.transaction(async (tx) => {
                await tx.run('UPDATE t SET x = 1');
                throw failure;
            }),
        ).rejects.toBe(failure);
        await db.run('UPDATE t SET x = 2');
        expect(log.slice(1)).toEqual([
            'cache.db: BEGIN IMMEDIATE',
            'cache.db: UPDATE t SET x = 1',
            'cache.db: ROLLBACK',
            'cache.db: UPDATE t SET x = 2',
        ]);
    });

    it('closes after the statements queued before it, once, and refuses statements afterwards', async () => {
        const hold = deferred();
        const { driver, log } = fakeSqlite({ before: (sql) => (sql === 'SELECT slow' ? hold.promise : undefined) });
        const db = await driver.open(CACHE);
        const slow = db.get('SELECT slow');
        const closing = db.close();
        await Promise.resolve();
        expect(log).not.toContain('close cache.db');
        hold.resolve();
        await slow;
        await closing;
        await db.close();
        expect(log.filter((line) => line === 'close cache.db')).toHaveLength(1);
        await expect(db.get('SELECT 1')).rejects.toThrow('cache.db: the connection is closed.');
    });

    it('closes its connections to a file before deleting it, which expo-sqlite refuses while one is open', async () => {
        const { driver, log, onDisk } = fakeSqlite();
        const cache = await driver.open(CACHE);
        await driver.open(CACHE);
        const user = await driver.open(USER);
        await driver.delete(CACHE);
        expect(log.slice(3)).toEqual([
            'close cache.db',
            'close cache.db',
            'delete cache.db',
            'remove cache.db-wal',
            'remove cache.db-shm',
            'remove cache.db-journal',
        ]);
        expect(onDisk.has(`${DIRECTORY}/cache.db`)).toBe(false);
        await expect(cache.get('SELECT 1')).rejects.toThrow('closed');
        // Another file's connection stays open.
        await expect(user.get('SELECT 1')).resolves.toBeNull();
    });

    it('deletes a missing file quietly, removing only what is left beside it', async () => {
        const { driver, log, sqlite } = fakeSqlite();
        await expect(driver.delete(USER)).resolves.toBeUndefined();
        expect(sqlite.deleteDatabaseAsync).not.toHaveBeenCalled();
        expect(log).toEqual(['remove user.db-wal', 'remove user.db-shm', 'remove user.db-journal']);
    });

    it('passes a failed delete on with its message', async () => {
        const { driver, sqlite } = fakeSqlite();
        await driver.open(CACHE);
        vi.mocked(sqlite.deleteDatabaseAsync).mockRejectedValueOnce(
            new Error("Unable to delete the database file for 'cache.db' database"),
        );
        await expect(driver.delete(CACHE)).rejects.toThrow('Unable to delete the database file');
    });
});
