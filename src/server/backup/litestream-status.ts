import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { copyAlertLevel, type CopyAlertThresholds } from '@socio/shared/continuous-copy';
import type { ContinuousCopyStatus } from '@socio/shared/types';

/** A write this much newer than the newest copy: the copy is behind. */
export const COPY_BEHIND_MS = 5 * 60_000;

/** The size of the file at `path` in bytes; undefined when it isn't there. */
function size(path: string) {
    try {
        return statSync(path).size;
    } catch {
        return undefined;
    }
}

function mtime(path: string) {
    try {
        return Math.round(statSync(path).mtimeMs);
    } catch {
        return undefined;
    }
}

/**
 * The newest copy in Litestream's file replica (CB-109): its files are
 * `<dir>/ltx/<level>/<min txid>-<max txid>.ltx`, in hex of one width, so
 * each level's last name is its newest, and only those are looked at.
 */
export function newestCopyAt(replicaDir: string) {
    let levels: string[];
    try {
        levels = readdirSync(join(replicaDir, 'ltx'));
    } catch {
        return undefined;
    }
    let newest: number | undefined;
    for (const level of levels) {
        let names: string[];
        try {
            names = readdirSync(join(replicaDir, 'ltx', level));
        } catch {
            continue;
        }
        const last = names
            .filter((name) => name.endsWith('.ltx'))
            .sort()
            .at(-1);
        const at = last && mtime(join(replicaDir, 'ltx', level, last));
        if (at && (newest === undefined || at > newest)) {
            newest = at;
        }
    }
    return newest;
}

/**
 * The continuous copy of the database (CB-109), from files alone: the
 * newest copy in the replica against the database's last write (its WAL's
 * time; the database file's own also changes on checkpoints, which aren't
 * writes). Behind when a write is over COPY_BEHIND_MS newer than the newest
 * copy, or there is no copy that long after one.
 *
 * With `thresholds` (CB-315), also the lag: with a write newer than the
 * newest copy, how long since that copy (so it keeps growing when writes
 * stop after Litestream did); 0 when the copy covers the last write, so an
 * idle database is never behind. Healthy, Litestream copies within about a
 * second, so the lag stays at seconds.
 * the WAL's size, and the level they make. Litestream holds no lock or
 * port the app could ask, and its replica dir is what it writes anyway, so
 * the files are the least coupled view of it. With no copy at all, the lag
 * runs from `since` (the server's start: Litestream copies the whole
 * database within seconds of its own), or else from the last write.
 */
export function continuousCopyStatus(
    replicaDir: string,
    databasePath: string,
    now: number,
    thresholds?: CopyAlertThresholds,
    since?: number,
): ContinuousCopyStatus {
    const lastCopiedAt = newestCopyAt(replicaDir);
    const lastWriteAt = mtime(`${databasePath}-wal`) ?? mtime(databasePath);
    const behind =
        lastWriteAt !== undefined &&
        (lastCopiedAt === undefined ? now - lastWriteAt > COPY_BEHIND_MS : lastWriteAt - lastCopiedAt > COPY_BEHIND_MS);
    const status: ContinuousCopyStatus = {
        ...(lastCopiedAt !== undefined ? { lastCopiedAt } : {}),
        ...(lastWriteAt !== undefined ? { lastWriteAt } : {}),
        behind,
    };
    if (!thresholds) {
        return status;
    }
    const lagMs =
        lastWriteAt === undefined
            ? 0
            : lastCopiedAt === undefined
              ? Math.max(0, now - (since ?? lastWriteAt))
              : lastWriteAt > lastCopiedAt
                ? now - lastCopiedAt
                : 0;
    const walBytes = size(`${databasePath}-wal`);
    return {
        ...status,
        lagMs,
        ...(walBytes !== undefined ? { walBytes } : {}),
        level: copyAlertLevel({ lagMs, walBytes }, thresholds),
    };
}
