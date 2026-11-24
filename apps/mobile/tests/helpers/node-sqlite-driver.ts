import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    type DbFile,
    type SqlConnection,
    type SqlDriver,
    SqlError,
    SQLITE_NOTADB,
    type SqlParams,
    type SqlRow,
    type SqlRunResult,
    type SqlStatements,
} from '../../src/data/driver';

// The store's SqlDriver on Node's node:sqlite, for tests: real SQLite (3.54 in
// Node 26.13) on real files, with SQLCipher's pragmas faked, since Node has no
// codec. Files stay plain SQLite on disk; whether the app's files are really
// encrypted is a device check.
//
// The fake follows SQLCipher 4.17 as expo-sqlite vendors it:
// - `PRAGMA key = …` is accepted. A file takes the key of the connection that
//   writes its first page; until then (a 0-byte file, no -wal) it has no page
//   to check, so any key, or none, reads it as a new file, as in SQLCipher.
//   Once it has a page, a connection with another key, or none, fails at its
//   first page read with SQLITE_NOTADB, "file is not a database": the cipher
//   pragmas and `PRAGMA busy_timeout` still answer, but sqlite_master can't be
//   read. A file made outside the driver takes the first key it's opened with;
// - `PRAGMA cipher_status` answers '1' once the connection has a key, '0'
//   before; `PRAGMA cipher_version` answers a version. Options change both, or
//   answer no row, as SQLite without SQLCipher does;
// - SQLite's errors reject as the driver contract's SqlError, with the result
//   code node:sqlite gives as `errcode`.

export interface NodeSqliteDriverOptions {
    /** What `PRAGMA cipher_status` answers once keyed: '1' by default; null answers no row. */
    readonly cipherStatus?: string | null;
    /** What `PRAGMA cipher_version` answers: '4.17.0 community' by default; null answers no row. */
    readonly cipherVersion?: string | null;
    /** Thrown by `PRAGMA key`. */
    readonly keyError?: Error;
    /** Thrown by open. */
    readonly openError?: Error;
    /** Answers a statement before SQLite sees it, for answers real SQLite won't give. It may throw, as a failing statement does. */
    readonly intercept?: (sql: string) => readonly SqlRow[] | undefined;
    /** Each file's key, by path. Share one map between drivers to keep the keys across them. */
    readonly keys?: Map<string, string>;
}

export interface NodeSqliteDriver extends SqlDriver {
    /** Every statement run, as `<file name>: <sql>`, in order. */
    readonly log: string[];
    /** The paths with an open connection. */
    openPaths(): string[];
}

const KEY = /^\s*PRAGMA\s+key\s*=\s*(.+?)\s*;?\s*$/is;
const CIPHER_STATUS = /^\s*PRAGMA\s+cipher_status\s*;?\s*$/i;
const CIPHER_VERSION = /^\s*PRAGMA\s+cipher_version\s*;?\s*$/i;
/** Pragmas that set the connection and read no page, so SQLCipher runs them with any key. */
const READS_NO_PAGE = /^\s*PRAGMA\s+busy_timeout\b/i;

/** SQLITE_NOTADB, what SQLCipher answers for a wrong key. */
export function notADatabase(): SqlError {
    return new SqlError('file is not a database', SQLITE_NOTADB);
}

/** node:sqlite's error as a SqlError with its result code; any other error as it is. */
function sqlError(error: unknown): unknown {
    const errcode: unknown = error instanceof Error ? Reflect.get(error, 'errcode') : undefined;
    return error instanceof Error && typeof errcode === 'number' ? new SqlError(error.message, errcode, error) : error;
}

const size = (path: string) => statSync(path, { throwIfNoEntry: false })?.size ?? 0;

/** The file has no page yet: SQLCipher has nothing to check a key against. */
const hasNoPage = (path: string) => size(path) === 0 && size(`${path}-wal`) === 0;

export function createNodeSqliteDriver(options: NodeSqliteDriverOptions = {}): NodeSqliteDriver {
    const keys = options.keys ?? new Map<string, string>();
    const open = new Map<string, number>();
    const log: string[] = [];

    const connect = (file: DbFile): SqlConnection => {
        const path = join(file.directory, file.name);
        if (options.openError) {
            throw options.openError;
        }
        const db = new DatabaseSync(path);
        open.set(path, (open.get(path) ?? 0) + 1);
        /** The connection's `PRAGMA key` value, undefined before. */
        let connectionKey: string | undefined;
        let closed = false;
        let tail: Promise<unknown> = Promise.resolve();

        /** The fake's answer to a cipher pragma, or undefined when SQLite should run `sql`. */
        const cipher = (sql: string): SqlRow[] | undefined => {
            const key = KEY.exec(sql)?.[1];
            if (key !== undefined) {
                if (options.keyError) {
                    throw options.keyError;
                }
                connectionKey = key;
                return [];
            }
            if (CIPHER_STATUS.test(sql)) {
                const status = options.cipherStatus === undefined ? '1' : options.cipherStatus;
                return status === null ? [] : [{ cipher_status: connectionKey === undefined ? '0' : status }];
            }
            if (CIPHER_VERSION.test(sql)) {
                const version = options.cipherVersion === undefined ? '4.17.0 community' : options.cipherVersion;
                return version === null ? [] : [{ cipher_version: version }];
            }
            return undefined;
        };

        /** Runs `sql` through the fake, then SQLite. */
        const statement = <T>(sql: string, sqlite: () => T, answer: (rows: readonly SqlRow[]) => T): T => {
            if (closed) {
                throw new Error(`${file.name} is closed.`);
            }
            log.push(`${file.name}: ${sql.replace(/\s+/g, ' ').trim()}`);
            const faked = options.intercept?.(sql) ?? cipher(sql);
            if (faked !== undefined) {
                return answer(faked);
            }
            const empty = hasNoPage(path);
            if (!empty && !READS_NO_PAGE.test(sql)) {
                const known = keys.get(path);
                if (known === undefined) {
                    if (connectionKey !== undefined) {
                        keys.set(path, connectionKey);
                    }
                } else if (known !== connectionKey) {
                    throw notADatabase();
                }
            }
            try {
                return sqlite();
            } catch (error) {
                throw sqlError(error);
            } finally {
                // The first page is written with this connection's key, which is now the file's.
                if (empty && !hasNoPage(path)) {
                    if (connectionKey === undefined) {
                        keys.delete(path);
                    } else {
                        keys.set(path, connectionKey);
                    }
                }
            }
        };

        const values = (params: SqlParams = []) => params as (string | number | null | Uint8Array)[];
        const tx: SqlStatements = {
            exec: async (sql) =>
                statement(
                    sql,
                    () => db.exec(sql),
                    () => undefined,
                ),
            run: async (sql, params) =>
                statement(
                    sql,
                    (): SqlRunResult => {
                        const result = db.prepare(sql).run(...values(params));
                        return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
                    },
                    () => ({ changes: 0, lastInsertRowId: 0 }),
                ),
            get: async <Row>(sql: string, params?: SqlParams) =>
                statement(
                    sql,
                    () => {
                        const row = db.prepare(sql).get(...values(params));
                        return row === undefined ? null : ({ ...row } as Row);
                    },
                    (rows) => (rows[0] === undefined ? null : ({ ...rows[0] } as Row)),
                ),
            all: async <Row>(sql: string, params?: SqlParams) =>
                statement(
                    sql,
                    () =>
                        db
                            .prepare(sql)
                            .all(...values(params))
                            .map((row) => ({ ...row }) as Row),
                    (rows) => rows.map((row) => ({ ...row }) as Row),
                ),
        };

        /** Runs `work` after everything queued before it: statements wait out a transaction. */
        const serial = <T>(work: () => Promise<T>): Promise<T> => {
            const run = tail.then(work);
            tail = run.catch(() => {});
            return run;
        };

        return {
            exec: (sql) => serial(() => tx.exec(sql)),
            run: (sql, params) => serial(() => tx.run(sql, params)),
            get: <Row>(sql: string, params?: SqlParams) => serial(() => tx.get<Row>(sql, params)),
            all: <Row>(sql: string, params?: SqlParams) => serial(() => tx.all<Row>(sql, params)),
            transaction: <T>(task: (tx: SqlStatements) => Promise<T>) =>
                serial(async () => {
                    await tx.exec('BEGIN IMMEDIATE');
                    try {
                        const result = await task(tx);
                        await tx.exec('COMMIT');
                        return result;
                    } catch (error) {
                        // SQLite may have rolled back already; the task's error is the one to report.
                        await tx.exec('ROLLBACK').catch(() => {});
                        throw error;
                    }
                }),
            close: () =>
                serial(async () => {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    db.close();
                    const left = (open.get(path) ?? 1) - 1;
                    if (left === 0) {
                        open.delete(path);
                    } else {
                        open.set(path, left);
                    }
                }),
        };
    };

    return {
        log,
        openPaths: () => [...open.keys()].sort(),
        open: async (file) => connect(file),
        delete: async (file) => {
            const path = join(file.directory, file.name);
            if (open.has(path)) {
                throw new Error(`Unable to delete the database file for "${file.name}" because it is currently open.`);
            }
            for (const suffix of ['', '-wal', '-shm', '-journal']) {
                rmSync(path + suffix, { force: true });
            }
            keys.delete(path);
            log.push(`${file.name}: (deleted)`);
        },
    };
}
