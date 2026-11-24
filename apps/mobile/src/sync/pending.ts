import type { SqlStatements, UserDbState } from '../data';

// The writes this device has queued and the server hasn't confirmed: user.db's
// outbox, loaded into the
// scope's local-only `pending` collection, which screens lay over the synced
// rows. The outbox (outbox.ts) reads and writes the table; the scope mirrors
// its rows into the collection.
//
// A row keeps its payload as stored, undecoded: each outbox kind's `overlay`
// decodes it by its `payloadVersion`, and a row this build can't decode is
// kept as it is, never dropped.

/** One outbox row, as user.db holds it. */
export interface PendingWrite {
    readonly id: string;
    /** The lane it is sent in, in order. */
    readonly lane: string;
    readonly kind: string;
    /** The payload's JSON, undecoded. */
    readonly payload: string;
    readonly payloadVersion: number;
    /** The outbox row it waits for, or null. */
    readonly dependsOn: string | null;
    /** Queued, in flight, unknown or held. */
    readonly state: string;
    readonly attempts: number;
    readonly createdAt: number;
    readonly lastError: string | null;
}

/**
 * user.db's outbox rows, oldest first. A file at version 0 (its first
 * migration failed, migrate.ts) has no outbox and so no row; a read-only file
 * still has its rows read.
 */
export async function readPending(db: SqlStatements, state: UserDbState): Promise<PendingWrite[]> {
    if (state.version < 1) {
        return [];
    }
    return db.all<PendingWrite>(
        `SELECT id, lane, kind, payload, payloadVersion, dependsOn, state, attempts, createdAt, lastError
         FROM outbox ORDER BY createdAt, id`,
    );
}
