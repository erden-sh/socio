import type { DatabaseSync } from 'node:sqlite';

/**
 * The pragmas every connection to the app's database gets (CB-110).
 *
 * synchronous=NORMAL is the safe pairing for WAL: a crash can lose the last
 * commits but never corrupts the file. Litestream is configured when
 * LITESTREAM_REPLICA_DIR is set (CB-109); it must own checkpoints, because
 * a checkpoint that runs between its syncs can recycle WAL frames it hasn't
 * copied yet. So the app turns its own automatic checkpoints off then, and
 * leaves SQLite's default alone when Litestream isn't there to do it.
 */
export function applyConnectionPragmas(db: DatabaseSync, env: Record<string, string | undefined> = process.env) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    if (env.LITESTREAM_REPLICA_DIR?.trim()) {
        db.exec('PRAGMA wal_autocheckpoint=0');
    }
}
