// What the store needs from SQLite:
// open a file, run statements with bound values, a transaction, close, and
// delete a file. The platform binds it to expo-sqlite's async API
// (src/platform/); the tests bind it to Node's node:sqlite
// (tests/helpers/node-sqlite-driver.ts). Nothing here loads either.

/** A value SQLite stores and binds: text, a number, NULL or a blob. */
export type SqlValue = string | number | null | Uint8Array;

/** Positional values for a statement's `?` placeholders. */
export type SqlParams = readonly SqlValue[];

/** A result row, by column name. */
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
    /** Rows the statement inserted, changed or deleted. */
    readonly changes: number;
    readonly lastInsertRowId: number;
}

/**
 * A statement SQLite refused. A driver rejects with one whenever SQLite
 * returns an error, carrying its result code, so the store can tell a wrong key
 * from a lock or a damaged file (open.ts). node:sqlite gives the code as the
 * error's `errcode`; expo-sqlite writes it into the message, "Error code N: …",
 * on Android and iOS alike.
 */
export class SqlError extends Error {
    override readonly name = 'SqlError';
    /** SQLite's primary result code (https://sqlite.org/rescode.html): the low 8 bits of an extended one. */
    readonly resultCode: number;

    constructor(message: string, resultCode: number, cause?: unknown) {
        super(message);
        this.resultCode = resultCode & 0xff;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

/** Another connection holds a lock on the file. */
export const SQLITE_BUSY = 5;
/** A lock conflict on a shared cache. */
export const SQLITE_LOCKED = 6;
/** A page is damaged. */
export const SQLITE_CORRUPT = 11;
/** "file is not a database": what SQLCipher answers at the first page read with a wrong key. */
export const SQLITE_NOTADB = 26;

/** The result code a driver's error carries, or undefined for any other error. */
export function resultCode(error: unknown): number | undefined {
    return error instanceof SqlError ? error.resultCode : undefined;
}

/** The error is a lock held elsewhere (SQLITE_BUSY or SQLITE_LOCKED): it changed nothing, and a later try may work. */
export function isBusy(error: unknown): boolean {
    const code = resultCode(error);
    return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}

/** A database file: its directory (a workspace's) and its name there. */
export interface DbFile {
    readonly directory: string;
    readonly name: string;
}

/** Statements on an open file. A statement SQLite refuses rejects with a SqlError. */
export interface SqlStatements {
    /** Runs one or more statements with no bound values (DDL, PRAGMAs). */
    exec(sql: string): Promise<void>;
    run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
    /** The first row, or null when there's none. The row type isn't checked. */
    get<Row = SqlRow>(sql: string, params?: SqlParams): Promise<Row | null>;
    /** Every row. The row type isn't checked. */
    all<Row = SqlRow>(sql: string, params?: SqlParams): Promise<Row[]>;
}

/**
 * One connection to one file.
 *
 * A transaction runs on this same connection: SQLCipher keys a connection, so
 * a second one (expo-sqlite's `withExclusiveTransactionAsync` opens one) would
 * have no key and couldn't read the file. Statements from outside the task wait
 * until it ends, so they never land inside it; inside, use `tx`.
 */
export interface SqlConnection extends SqlStatements {
    /** BEGIN IMMEDIATE, the task, then COMMIT, or ROLLBACK when the task throws, and the error rethrown. */
    transaction<T>(task: (tx: SqlStatements) => Promise<T>): Promise<T>;
    /** Closes the connection. Closing it again does nothing. */
    close(): Promise<void>;
}

export interface SqlDriver {
    /** Opens the file, creating it (and no table) when it doesn't exist. */
    open(file: DbFile): Promise<SqlConnection>;
    /**
     * Deletes the file and its `-wal`, `-shm` and `-journal` files, if any. It
     * throws while a connection to the file is open, as expo-sqlite's
     * `deleteDatabaseAsync` does, so close every connection first.
     */
    delete(file: DbFile): Promise<void>;
}
