// Moving a person's data space to another person (CB-360's transfer).
//
// A file's sealed bytes live under its owner's key (`objectKey`: the
// owner's folder on disk, or their prefix in S3), and a dataset is a
// SQLite file in its owner's folder (`DataSpace.datasetPath`). A file's
// seal is bound to its owner and id (the AAD is `<owner>/<id>`), so each
// is opened and sealed again for the new owner, under the current data
// key, as the offline rename does (backup/rename-user.ts). The order keeps
// every row naming bytes that are there:
//
//   1. prepare: under both people's file locks (every file write, delete,
//      move, re-seal and S3 move takes the owner's), seal each file again
//      for the new owner at the new owner's key and check the copy's size;
//      a file this server can't open stops it, before anything changed;
//   2. commit, inside the caller's transaction: check no file row changed
//      since its copy, hard-link each dataset file into the new owner's
//      folder (a copy across devices), then move the rows, each file with
//      the key and size of its new seal;
//   3. after the commit, remove the old copies and dataset links (`finish`);
//      after a rollback, the new ones (`abort`).
//
// A crash before the commit leaves unused copies under the new owner's
// keys, which nothing names; after it, the old copies under the old
// owner's, which their purge removes. Neither loses data. Dataset writes
// are synchronous and the commit is too, so none lands between the link
// and the rows moving in this process; the link is made under the file's
// write lock, so no half-written change is left behind and no write on
// another runtime is in flight.
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ObjectStore, StorageDriver } from '@socio/data/object-store';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { TransferParties } from '@socio/shared/auth';

import type { DataTransferShape } from './contract.js';
import {
    recordTransferredSeal,
    transferDataRows,
    transferDatasetIds,
    transferFileRows,
    type TransferFileRow,
} from './infra/sqlite/ownership.js';

/** What the move needs of `DataSpace`. */
export interface DataTransferHost {
    db: DatabaseSync;
    /** The store a row names; throws while S3 rows can't be reached. */
    store(driver: StorageDriver): Pick<ObjectStore, 'get' | 'put' | 'head' | 'delete'>;
    key(driver: StorageDriver, userId: string, fileId: string): string;
    datasetPath(row: { id: string; ownerUserId: string }): string;
    /** Opens a file's sealed bytes for `from` and seals them for `to`; throws when they can't be opened. */
    reseal(sealed: Uint8Array, from: string, to: string, fileId: string): { bytes: Uint8Array; sealKey: string };
    /** Takes a person's file lock; resolves with its release once held. */
    hold(userId: string): Promise<() => void>;
}

const DATASET_SUFFIXES = ['', '-journal', '-wal', '-shm'];
const fingerprint = (row: TransferFileRow) => `${row.id}:${row.storage}:${row.sealKey}:${row.storedSize}`;

/**
 * Runs `work` holding the dataset file's EXCLUSIVE lock, which every
 * writer's transaction needs (on every runtime): a hot journal a crashed
 * write left is rolled back first, a write in flight finishes first, and
 * none is half done while `work` links the file, so the file alone holds
 * the dataset. A write waiting for the lock lands in the same inode, which
 * both names share.
 */
function whileLocked(path: string, work: () => void) {
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA busy_timeout=2000');
        db.exec('BEGIN EXCLUSIVE');
        try {
            work();
        } finally {
            db.exec('ROLLBACK');
        }
    } finally {
        db.close();
    }
}

function removeDataset(path: string) {
    for (const suffix of DATASET_SUFFIXES) {
        rmSync(`${path}${suffix}`, { force: true });
    }
}

export async function prepareDataTransfer(
    host: DataTransferHost,
    parties: TransferParties,
): Promise<DataTransferShape> {
    const { from, to } = parties;
    if (from === to) {
        throw new DataError('A data space can’t move to its own owner.', 400);
    }
    // Both locks, in one order, so two moves the other way round can't deadlock.
    const [first, second] = [from, to].sort();
    const releases = [await host.hold(first), await host.hold(second)];
    let released = false;
    const release = () => {
        if (!released) {
            released = true;
            for (const done of releases.reverse()) {
                done();
            }
        }
    };

    const copied: {
        id: string;
        driver: StorageDriver;
        source: string;
        target: string;
        sealKey: string;
        size: number;
    }[] = [];
    const missing: string[] = [];
    const removeCopies = async () => {
        for (const copy of copied) {
            await host
                .store(copy.driver)
                .delete(copy.target)
                .catch(() => undefined);
        }
    };
    const rows = transferFileRows(host.db, from);
    try {
        for (const row of rows) {
            const store = host.store(row.storage);
            const source = host.key(row.storage, from, row.id);
            const target = host.key(row.storage, to, row.id);
            const sealed = await store.get(source);
            if (!sealed) {
                // Missing already: the row moves, naming bytes that were never there.
                missing.push(row.id);
                continue;
            }
            let resealed: { bytes: Uint8Array; sealKey: string };
            try {
                resealed = host.reseal(sealed, from, to, row.id);
            } catch {
                throw new DataError(
                    `File ${row.id} can’t be opened with this server’s data keys, so nothing moved.`,
                    409,
                );
            }
            const body = resealed.bytes;
            copied.push({
                id: row.id,
                driver: row.storage,
                source,
                target,
                sealKey: resealed.sealKey,
                size: body.length,
            });
            await store.put(target, body);
            if ((await store.head(target))?.size !== body.length) {
                throw new DataError('A file’s copy didn’t check out, so nothing moved. Try again.', 503);
            }
        }
    } catch (error) {
        await removeCopies();
        release();
        throw error;
    }

    const linked: string[] = [];
    const sources: string[] = [];
    let state: 'open' | 'committed' | 'ended' = 'open';
    return {
        commit() {
            if (state !== 'open') {
                throw new Error('This data space move has ended.');
            }
            const now = transferFileRows(host.db, from).map(fingerprint).join('\n');
            if (now !== rows.map(fingerprint).join('\n')) {
                throw new DataError('Their files changed while they were copied, so nothing moved. Try again.', 409);
            }
            for (const id of transferDatasetIds(host.db, from)) {
                const source = host.datasetPath({ id, ownerUserId: from });
                if (!existsSync(source)) {
                    continue;
                }
                const target = host.datasetPath({ id, ownerUserId: to });
                mkdirSync(dirname(target), { recursive: true });
                removeDataset(target);
                linked.push(target);
                // Under the file's write lock, so no write is half done as it
                // is linked (CB-451 review).
                whileLocked(source, () => {
                    try {
                        linkSync(source, target);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
                            throw error;
                        }
                        copyFileSync(source, target);
                    }
                });
                sources.push(source);
            }
            const tally = transferDataRows(host.db, parties);
            for (const copy of copied) {
                recordTransferredSeal(host.db, copy.id, copy.sealKey, copy.size);
            }
            if (missing.length) {
                tally.notes.push(
                    `${missing.length} file(s) had no stored bytes before the move (${missing.slice(0, 5).join(', ')}).`,
                );
            }
            state = 'committed';
            return tally;
        },
        async finish() {
            const left: string[] = [];
            try {
                for (const copy of copied) {
                    await host
                        .store(copy.driver)
                        .delete(copy.source)
                        .catch(() => left.push(copy.source));
                }
                for (const source of sources) {
                    try {
                        removeDataset(source);
                    } catch {
                        left.push(source);
                    }
                }
            } finally {
                state = 'ended';
                release();
            }
            return left;
        },
        async abort() {
            try {
                await removeCopies();
                for (const target of linked) {
                    try {
                        removeDataset(target);
                    } catch {
                        // An unused link under the new owner: nothing names it.
                    }
                }
            } finally {
                state = 'ended';
                release();
            }
        },
    };
}
