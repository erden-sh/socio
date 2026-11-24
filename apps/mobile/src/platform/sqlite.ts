import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import {
    type DbFile,
    type SqlConnection,
    type SqlDriver,
    SqlError,
    type SqlParams,
    type SqlRow,
    type SqlRunResult,
    type SqlStatements,
} from '../data/driver';
import type { FileSystem } from '../data/layout';

// The store's SqlDriver on expo-sqlite 58 (src/data/driver.ts),
// which links SQLCipher (its plugin entry in app.config.ts):
//
// - **One open, one connection.** `openDatabaseAsync(name, options, directory)`
//   with `useNewConnection`: without it expo-sqlite hands a second open of the
//   same path the cached connection, so two of the store's connections would
//   share one key and one transaction, and closing one would leave the other
//   open. A new connection also stays out of the dev tools plugin's list.
// - **Transactions on the same connection, behind a queue.** SQLCipher keys a
//   connection, so `withExclusiveTransactionAsync` (which opens another, with
//   no key) can't read the file, and `withTransactionAsync` lets any other
//   statement on the connection land inside the transaction. Every statement
//   waits its turn, and a transaction holds the turn from BEGIN IMMEDIATE to
//   COMMIT or ROLLBACK; inside, the task uses `tx`, as the driver contract says.
// - **Delete closes first, and a missing file is no error.** expo-sqlite's
//   `deleteDatabaseAsync` throws while any connection to the path is open and
//   when the file isn't there. So the driver closes the connections it opened
//   to the file (each waits for its queue), deletes, and when the file is gone
//   already removes only what is left of its `-wal`, `-shm` and `-journal`.
// - **Errors carry SQLite's code.** expo-sqlite writes it into the message,
//   "Error code N: …" ("Error code N" alone for some iOS statements), on both
//   platforms; `sqlErrorFrom` turns that into the SqlError open.ts reads.

/** The suffixes of SQLite's files beside a database. */
const SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

/** "Error code 26: file is not a database", anywhere in an expo-sqlite message. */
const ERROR_CODE = /\bError code (\d+)\b/;

/**
 * An expo-sqlite error as a SqlError with SQLite's result code (its primary
 * code: SqlError keeps the low 8 bits), or the error as it is when its message
 * carries no code (a closed connection, a bad argument).
 */
export function sqlErrorFrom(error: unknown): unknown {
    if (error instanceof SqlError) {
        return error;
    }
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const code = ERROR_CODE.exec(message)?.[1];
    return code === undefined ? error : new SqlError(message, Number(code), error);
}

/** Runs `work`, rejecting with `sqlErrorFrom` of whatever it throws. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throw sqlErrorFrom(error);
    }
}

/** The path expo-sqlite caches a connection under: directory and name with one `/`, as its createDatabasePath joins them. */
export function databasePath(file: DbFile): string {
    return `${file.directory.replace(/\/*$/, '')}/${file.name.replace(/^\/+/, '')}`;
}

/** The slice of expo-sqlite the driver uses, so the tests can hand in a fake. */
export interface ExpoSqlite {
    openDatabaseAsync: typeof openDatabaseAsync;
    deleteDatabaseAsync: typeof deleteDatabaseAsync;
}

export interface ExpoSqliteDriverOptions {
    /** For a delete: whether the file is there, and removing what is left beside a missing one. The store's FileSystem. */
    readonly files: Pick<FileSystem, 'exists' | 'remove'>;
    /** expo-sqlite; the tests pass a fake. */
    readonly sqlite?: ExpoSqlite;
}

const EXPO_SQLITE: ExpoSqlite = { openDatabaseAsync, deleteDatabaseAsync };

export function createExpoSqliteDriver({ files, sqlite = EXPO_SQLITE }: ExpoSqliteDriverOptions): SqlDriver {
    /** Every connection this driver opened and hasn't closed, by path. */
    const open = new Map<string, Set<SqlConnection>>();

    const connect = (file: DbFile, db: SQLiteDatabase): SqlConnection => {
        const path = databasePath(file);
        let closed = false;
        let tail: Promise<unknown> = Promise.resolve();

        const tx: SqlStatements = {
            exec: (sql) => mapped(() => db.execAsync(sql)),
            run: (sql, params = []) =>
                mapped(async (): Promise<SqlRunResult> => {
                    const result = await db.runAsync(sql, bind(params));
                    return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
                }),
            get: <Row = SqlRow>(sql: string, params: SqlParams = []) =>
                mapped(() => db.getFirstAsync<Row>(sql, bind(params))),
            all: <Row = SqlRow>(sql: string, params: SqlParams = []) =>
                mapped(() => db.getAllAsync<Row>(sql, bind(params))),
        };

        /** Runs `work` after everything queued before it, so a transaction's statements are never interleaved. */
        const turn = <T>(work: () => Promise<T>): Promise<T> => {
            const run = tail.then(() => {
                if (closed) {
                    throw new Error(`${file.name}: the connection is closed.`);
                }
                return work();
            });
            tail = run.catch(() => {});
            return run;
        };

        const connection: SqlConnection = {
            exec: (sql) => turn(() => tx.exec(sql)),
            run: (sql, params) => turn(() => tx.run(sql, params)),
            get: <Row = SqlRow>(sql: string, params?: SqlParams) => turn(() => tx.get<Row>(sql, params)),
            all: <Row = SqlRow>(sql: string, params?: SqlParams) => turn(() => tx.all<Row>(sql, params)),
            transaction: (task) =>
                turn(async () => {
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
            close: async () => {
                const run = tail.then(async () => {
                    if (closed) {
                        return;
                    }
                    await mapped(() => db.closeAsync());
                    closed = true;
                    const set = open.get(path);
                    set?.delete(connection);
                    if (set?.size === 0) {
                        open.delete(path);
                    }
                });
                tail = run.catch(() => {});
                return run;
            },
        };
        return connection;
    };

    return {
        open: async (file) => {
            const db = await mapped(() =>
                sqlite.openDatabaseAsync(file.name, { useNewConnection: true }, file.directory),
            );
            const connection = connect(file, db);
            const path = databasePath(file);
            const set = open.get(path) ?? new Set();
            set.add(connection);
            open.set(path, set);
            return connection;
        },
        delete: async (file) => {
            const path = databasePath(file);
            await Promise.all([...(open.get(path) ?? [])].map((connection) => connection.close()));
            if (await files.exists(path)) {
                await mapped(() => sqlite.deleteDatabaseAsync(file.name, file.directory));
            }
            // deleteDatabaseAsync removes these with the file; with no file it removes none.
            for (const suffix of SIDE_FILES) {
                await files.remove(path + suffix);
            }
        },
    };
}

/** The store's values as expo-sqlite binds them: the same kinds, in a mutable array. */
function bind(params: SqlParams): (string | number | null | Uint8Array)[] {
    return [...params];
}
