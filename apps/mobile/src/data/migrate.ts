import { isBusy, type SqlConnection, type SqlStatements } from './driver';
import type { CacheSchema, Migration } from './schema';

// Versions on an open file. cache.db is
// disposable: open.ts deletes and rebuilds it when `user_version` isn't its
// schema's. user.db is what the person wrote, so it is never rebuilt:
// - its migrations run together in one transaction, which also sets
//   `user_version`, so a failure rolls back every one of them and leaves the
//   main file as it was;
// - after a failure, or with a `user_version` higher than this build knows, the
//   file stays readable but takes no write (`PRAGMA query_only`): its rows are
//   kept, shown and never sent;
// - a lock another connection holds past the busy timeout (SQLITE_BUSY or
//   SQLITE_LOCKED, at BEGIN IMMEDIATE or later) is not a failed migration:
//   everything rolled back, so writes stay on and the error goes to the caller,
//   which opens the file again later.

/** What the app shows over writes it can't send because the file is newer than the build. */
export const UPDATE_TO_SEND = 'Update Socio to send these';

export type UserDbState =
    | { readonly writable: true; readonly version: number }
    | {
          readonly writable: false;
          /** A newer build wrote the file. */
          readonly reason: 'newer';
          readonly version: number;
          readonly message: typeof UPDATE_TO_SEND;
      }
    | {
          readonly writable: false;
          /** A migration statement failed, and every pending migration was rolled back. A lock throws instead. */
          readonly reason: 'migration-failed';
          /** The version the file still has. */
          readonly version: number;
          readonly error: unknown;
      };

/** The file's `PRAGMA user_version`. */
export async function userVersion(db: SqlStatements): Promise<number> {
    const row = await db.get<{ user_version: number }>('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
}

/** A version that can go into a PRAGMA, which takes no bound value. */
function checkVersion(version: number): number {
    if (!Number.isInteger(version) || version < 1) {
        throw new RangeError(`A schema version is a whole number from 1, not ${version}.`);
    }
    return version;
}

/** The version the migrations end at. They must run 1, 2, 3… with no gap, each with a statement. */
export function latestVersion(migrations: readonly Migration[]): number {
    migrations.forEach((migration, index) => {
        if (checkVersion(migration.version) !== index + 1 || migration.statements.length === 0) {
            throw new RangeError(`Migration ${index + 1} is out of order or empty (version ${migration.version}).`);
        }
    });
    if (migrations.length === 0) {
        throw new RangeError('user.db has no migrations.');
    }
    return migrations.length;
}

/** Creates `schema`'s tables in an empty cache.db and sets its version, in one transaction. */
export async function createCacheSchema(db: SqlConnection, schema: CacheSchema): Promise<void> {
    const version = checkVersion(schema.version);
    await db.transaction(async (tx) => {
        for (const statement of schema.statements) {
            await tx.exec(statement);
        }
        await tx.exec(`PRAGMA user_version = ${version}`);
    });
}

/** Turns writes off on this connection: any statement that would change the file fails. */
async function blockWrites(db: SqlStatements): Promise<void> {
    await db.exec('PRAGMA query_only = ON');
    const row = await db.get<{ query_only: number }>('PRAGMA query_only');
    if (Number(row?.query_only) !== 1) {
        throw new Error('Could not turn writes off on user.db.');
    }
}

/**
 * Brings user.db to the last migration, or leaves it read-only. Throws when
 * another connection holds a lock (SQLITE_BUSY or SQLITE_LOCKED): every pending
 * migration rolled back and nothing changed, so a later open tries again. Also
 * throws when it can't turn writes off. Either way the caller closes the file.
 */
export async function migrateUserDb(db: SqlConnection, migrations: readonly Migration[]): Promise<UserDbState> {
    const latest = latestVersion(migrations);
    const version = await userVersion(db);
    if (version > latest) {
        await blockWrites(db);
        return { writable: false, reason: 'newer', version, message: UPDATE_TO_SEND };
    }
    if (version === latest) {
        return { writable: true, version };
    }
    try {
        await db.transaction(async (tx) => {
            for (const migration of migrations.slice(version)) {
                for (const statement of migration.statements) {
                    await tx.exec(statement);
                }
            }
            await tx.exec(`PRAGMA user_version = ${latest}`);
        });
    } catch (error) {
        if (isBusy(error)) {
            throw error;
        }
        await blockWrites(db);
        return { writable: false, reason: 'migration-failed', version, error };
    }
    return { writable: true, version: latest };
}
