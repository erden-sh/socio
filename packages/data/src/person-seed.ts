import type { DatabaseSync } from 'node:sqlite';

/**
 * The id a person's derived ids come from (CB-338): the opaque person ids
 * mini apps and plugins see, their actor envelopes' `sub`, and coding
 * volumes' keys. It is the user id, unless the person was renamed offline
 * (`backup rename-user`): then it is the id they had first, kept in
 * `person_seeds`, so every app and plugin keeps seeing the same person and
 * their state there stays theirs.
 *
 * An id a rename retired stays reserved: someone else given it later is
 * another person, so their seed is `reused:<id>` (a colon is never in a
 * user id), never the renamed person's.
 *
 * Seeds are written only offline, with the app stopped, so one lookup per
 * process and user is enough.
 */
export function personSeedOf(db: DatabaseSync, userId: string): string {
    let seeds = cache.get(db);
    if (!seeds) {
        seeds = new Map();
        cache.set(db, seeds);
    }
    let seed = seeds.get(userId);
    if (seed === undefined) {
        seed = storedPersonSeed(db, userId);
        seeds.set(userId, seed);
    }
    return seed;
}

/** `personSeedOf` read from the table now, uncached: for the rename itself. */
export function storedPersonSeed(db: DatabaseSync, userId: string): string {
    try {
        const own = db.prepare('SELECT seed FROM person_seeds WHERE userId=?').get(userId) as
            | { seed: string }
            | undefined;
        if (own) {
            return own.seed;
        }
        const retired = db.prepare('SELECT 1 FROM person_seeds WHERE seed=?').get(userId);
        return retired ? `${REUSED}${userId}` : userId;
    } catch {
        // A database without the table (a store's own tests): no renames.
        return userId;
    }
}

const REUSED = 'reused:';
const cache = new WeakMap<DatabaseSync, Map<string, string>>();
