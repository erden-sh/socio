import {
    type DbFile,
    isBusy,
    resultCode,
    type SqlConnection,
    type SqlDriver,
    SQLITE_CORRUPT,
    SQLITE_NOTADB,
} from './driver';
import { createCacheSchema, migrateUserDb, type UserDbState, userVersion } from './migrate';
import { CACHE_DB, CACHE_SCHEMA, type CacheSchema, type Migration, USER_DB, USER_MIGRATIONS } from './schema';

// Opening a file fails closed. In order:
// 1. `PRAGMA key = "x'<hex>'"`: a raw 32-byte key, with no KDF. Then
//    `PRAGMA busy_timeout`, which reads nothing: a statement waits up to 5 s
//    for another connection's lock instead of failing at once.
// 2. `PRAGMA cipher_status` must be '1' and `PRAGMA cipher_version` not empty.
//    A build without SQLCipher answers neither, and the file is never used as
//    plain SQLite.
// 3. Read sqlite_master. SQLCipher reports '1' for any key; a wrong one fails
//    only at the first page read, here, with SQLITE_NOTADB. That is "files
//    without their key", whose remedy is deleting them, so only that
//    code is 'wrong-key'. SQLITE_CORRUPT is 'damaged', a lock is 'busy', and
//    any other failure (I/O, a full disk, memory, an error with no result code)
//    is 'read-failed': none of them says the key is wrong. SQLCipher can't tell
//    a damaged first page from a wrong key, though: both fail its check of
//    page 1 and answer NOTADB.
// 4. On a new file (no page yet), `auto_vacuum = INCREMENTAL`, read back as 2.
//    It must come before WAL: the first pragma to write page 1 fixes the mode,
//    `journal_mode = WAL` writes it with mode 0, and after that only a VACUUM
//    changes it.
// 5. `journal_mode = WAL`, read back as 'wal'.
// Each failure closes the connection and throws a StoreOpenError naming its
// step, or 'busy' when a step met a lock past the busy timeout.

export type OpenFailure =
    /** The key isn't 64 hex characters. Nothing was opened. */
    | 'invalid-key'
    /** The driver couldn't open the file. */
    | 'open-failed'
    /** `PRAGMA key`, or the `busy_timeout` set with it, failed. */
    | 'key-failed'
    /** No working SQLCipher: `cipher_status` isn't '1' or `cipher_version` is empty. */
    | 'no-cipher'
    /**
     * Reading the file failed with SQLITE_NOTADB, as SQLCipher fails with a
     * wrong key: files without their key. Under SQLCipher a damaged first
     * page answers the same.
     */
    | 'wrong-key'
    /** Reading the file failed with SQLITE_CORRUPT: a page is damaged. */
    | 'damaged'
    /** Another connection held a lock past the busy timeout (SQLITE_BUSY or SQLITE_LOCKED). Try again later. */
    | 'busy'
    /** Reading the file failed some other way: I/O, a full disk, memory, or an error with no result code. Try again later. */
    | 'read-failed'
    /** A new file didn't take `auto_vacuum = INCREMENTAL`. */
    | 'auto-vacuum'
    /** The file didn't go to WAL. */
    | 'wal';

export class StoreOpenError extends Error {
    override readonly name = 'StoreOpenError';
    readonly failure: OpenFailure;
    readonly file: DbFile;

    constructor(failure: OpenFailure, file: DbFile, message: string, cause?: unknown) {
        super(`${file.name}: ${message}`);
        this.failure = failure;
        this.file = file;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export interface OpenedFile {
    readonly db: SqlConnection;
    /** The file was new (no page yet), so it got the auto-vacuum mode. */
    readonly created: boolean;
}

/** 32 bytes as hex. Checked, since `PRAGMA key` takes no bound value. */
const KEY_HEX = /^[0-9a-f]{64}$/i;

/** How long a statement waits for another connection's lock. SQLite's default, 0, fails at once. */
const BUSY_TIMEOUT_MS = 5000;

const BUSY = 'another connection holds a lock on the file; try again.';

/** A lock becomes 'busy'; any other error comes through as it is. */
function orBusy(file: DbFile, error: unknown): unknown {
    return isBusy(error) ? new StoreOpenError('busy', file, BUSY, error) : error;
}

/** What a failed read of sqlite_master means (step 3). Only SQLITE_NOTADB means the key. */
function readFailure(cause: unknown): readonly [OpenFailure, string] {
    if (isBusy(cause)) {
        return ['busy', BUSY];
    }
    switch (resultCode(cause)) {
        case SQLITE_NOTADB:
            return ['wrong-key', 'the key does not read the file (SQLITE_NOTADB).'];
        case SQLITE_CORRUPT:
            return ['damaged', 'the file is damaged (SQLITE_CORRUPT).'];
        default:
            return ['read-failed', 'the file could not be read.'];
    }
}

/** Steps 1 to 5 above, on `file` with `key` (64 hex characters). */
export async function openEncrypted(driver: SqlDriver, file: DbFile, key: string): Promise<OpenedFile> {
    if (!KEY_HEX.test(key)) {
        throw new StoreOpenError('invalid-key', file, 'a database key is 64 hex characters (32 bytes).');
    }
    let db: SqlConnection;
    try {
        db = await driver.open(file);
    } catch (cause) {
        throw new StoreOpenError('open-failed', file, 'the file could not be opened.', cause);
    }
    /** Runs one step; a throw there becomes that step's failure, or 'busy' for a lock. */
    const step = async <T>(failure: OpenFailure, message: string, work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (cause) {
            throw isBusy(cause)
                ? new StoreOpenError('busy', file, BUSY, cause)
                : new StoreOpenError(failure, file, message, cause);
        }
    };
    try {
        await step('key-failed', 'PRAGMA key failed.', () => db.exec(`PRAGMA key = "x'${key.toLowerCase()}'"`));
        await step('key-failed', 'PRAGMA busy_timeout failed.', () =>
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`),
        );
        const noCipher = 'SQLCipher is not working in this build, so the file stays closed.';
        const status = await step('no-cipher', noCipher, () =>
            db.get<{ cipher_status: unknown }>('PRAGMA cipher_status'),
        );
        const version = await step('no-cipher', noCipher, () =>
            db.get<{ cipher_version: unknown }>('PRAGMA cipher_version'),
        );
        if (String(status?.cipher_status ?? '') !== '1' || String(version?.cipher_version ?? '') === '') {
            throw new StoreOpenError('no-cipher', file, noCipher);
        }
        try {
            await db.get('SELECT count(*) AS tables FROM sqlite_master');
        } catch (cause) {
            const [failure, message] = readFailure(cause);
            throw new StoreOpenError(failure, file, message, cause);
        }
        const noVacuum = 'auto_vacuum could not be set.';
        const pages = await step('auto-vacuum', noVacuum, () => db.get<{ page_count: number }>('PRAGMA page_count'));
        const created = Number(pages?.page_count ?? 0) === 0;
        if (created) {
            const mode = await step('auto-vacuum', noVacuum, async () => {
                await db.exec('PRAGMA auto_vacuum = INCREMENTAL');
                return db.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum');
            });
            if (Number(mode?.auto_vacuum) !== 2) {
                throw new StoreOpenError('auto-vacuum', file, `auto_vacuum reads ${mode?.auto_vacuum}, not 2.`);
            }
        }
        const journal = await step('wal', 'WAL could not be turned on.', () =>
            db.get<{ journal_mode: string }>('PRAGMA journal_mode = WAL'),
        );
        if (String(journal?.journal_mode ?? '').toLowerCase() !== 'wal') {
            throw new StoreOpenError('wal', file, `journal_mode is ${journal?.journal_mode}, not wal.`);
        }
        return { db, created };
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

export interface CacheDb {
    readonly db: SqlConnection;
    /** The file was made now: new, or rebuilt. Either way it holds no row. */
    readonly created: boolean;
    /** A file of another version was on the phone and was deleted first. */
    readonly rebuilt: boolean;
}

/**
 * Opens the workspace's cache.db, or builds it. One of another schema version
 * is deleted, with its `-wal` and `-shm`, and built again; nothing else in the
 * directory is touched. A file its key can't read is not rebuilt: that is
 * 'wrong-key', files without their key, which the caller handles for both
 * files. Nor is a 'damaged', 'busy' or 'read-failed' one: the caller decides.
 * A lock met after the open is a 'busy' StoreOpenError too. The driver's own
 * error comes through as it is when the delete fails (another connection to
 * the file still open). `schema` is for tests.
 */
export async function openCacheDb(
    driver: SqlDriver,
    directory: string,
    key: string,
    schema: CacheSchema = CACHE_SCHEMA,
): Promise<CacheDb> {
    const file: DbFile = { directory, name: CACHE_DB };
    const opened = await openEncrypted(driver, file, key);
    let rebuilt = false;
    let { db, created } = opened;
    try {
        if (!created && (await userVersion(db)) !== schema.version) {
            await db.close();
            await driver.delete(file);
            ({ db, created } = await openEncrypted(driver, file, key));
            rebuilt = true;
            if (!created) {
                throw new Error(`${CACHE_DB} was still there after its delete.`);
            }
        }
        if (created) {
            await createCacheSchema(db, schema);
        }
    } catch (error) {
        await db.close().catch(() => {});
        throw orBusy(file, error);
    }
    return { db, created, rebuilt };
}

export interface UserDb {
    readonly db: SqlConnection;
    readonly created: boolean;
    /** Writable, or read-only and why. */
    readonly state: UserDbState;
}

/**
 * Opens the workspace's user.db and brings it to the last migration. A failed
 * migration or a newer file opens read-only (migrate.ts); it is never deleted
 * or rebuilt. A lock held elsewhere past the busy timeout isn't a failed
 * migration: nothing changed, the file is closed, and the open throws a 'busy'
 * StoreOpenError for the caller to try again. `migrations` is for tests.
 */
export async function openUserDb(
    driver: SqlDriver,
    directory: string,
    key: string,
    migrations: readonly Migration[] = USER_MIGRATIONS,
): Promise<UserDb> {
    const file: DbFile = { directory, name: USER_DB };
    const { db, created } = await openEncrypted(driver, file, key);
    try {
        return { db, created, state: await migrateUserDb(db, migrations) };
    } catch (error) {
        await db.close().catch(() => {});
        throw orBusy(file, error);
    }
}
