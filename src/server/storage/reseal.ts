import { nextTurn } from '@socio/data/events';
import { StorageUnavailableError, type ObjectStore, type StorageDriver } from '@socio/data/object-store';
import { LEGACY_KEY } from '@socio/foundation/keys/secret-box';

import type { ResealRun, ResealResult } from './contract.js';

interface Row {
    id: string;
    ownerUserId: string;
    storedSize: number;
    storage: StorageDriver;
    sealKey: string;
}

/**
 * Seals every file again under the current data key (CB-62), in the store
 * the row names, idempotently. Per row sealed under the legacy or the
 * previous key, under the user's lock: read the object, open it with whichever key
 * it names, seal it under the current one, put it back to the same key
 * (an atomic replace in both stores), HEAD it and check the size, then
 * record the key and size on the row. A crash after the put leaves an
 * object already under the current key with the old row: the next run
 * sees that from the object's header and only fixes the row. Reads in
 * between open either form. Rows under a key this server doesn't have are
 * left alone: they can't be opened. Nothing to do without a data key.
 */
export async function resealFiles(run: ResealRun): Promise<ResealResult> {
    const result: ResealResult = {
        resealed: 0,
        fixed: 0,
        missing: 0,
        unreadable: 0,
        mismatched: 0,
        skipped: 0,
        unavailable: false,
    };
    const { db, box, key } = run;
    const current = box.currentKey;
    const batch = run.batch ?? 50;
    if (current === LEGACY_KEY) {
        return result;
    }
    const from = [LEGACY_KEY, box.previousKey ?? LEGACY_KEY];
    const row = (id: string) =>
        db.prepare('SELECT id, ownerUserId, storedSize, storage, sealKey FROM data_files WHERE id=?').get(id) as
            | Row
            | undefined;
    const record = (id: string, size: number) => run.files.recordSeal(id, current, size);
    try {
        // By id, past the last batch: rows left as they are aren't seen twice.
        let after = '';
        for (let first = true; ; first = false) {
            // Between batches, the event loop's turn (CB-322, CB-318).
            if (!first) {
                await nextTurn();
            }
            const rows = db
                .prepare('SELECT id, ownerUserId FROM data_files WHERE sealKey IN (?, ?) AND id>? ORDER BY id LIMIT ?')
                .all(...from, after, batch) as unknown as Row[];
            if (!rows.length) {
                break;
            }
            after = rows[rows.length - 1].id;
            for (const { id, ownerUserId } of rows) {
                if (run.stopped?.()) {
                    return result;
                }
                await run.exclusive(ownerUserId, async () => {
                    const file = row(id);
                    if (!file || !from.includes(file.sealKey)) {
                        return;
                    }
                    let store: ObjectStore;
                    try {
                        store = run.store(file.storage);
                    } catch {
                        result.skipped++;
                        return;
                    }
                    const objectKey = key(file.storage, file.ownerUserId, file.id);
                    const sealed = await store.get(objectKey);
                    if (!sealed) {
                        result.missing++;
                        return;
                    }
                    const context = `${file.ownerUserId}/${file.id}`;
                    let next: Buffer | undefined;
                    try {
                        next = box.resealBytes(sealed, context);
                    } catch {
                        result.unreadable++;
                        return;
                    }
                    if (!next) {
                        await record(file.id, sealed.length);
                        result.fixed++;
                        return;
                    }
                    await store.put(objectKey, next);
                    const head = await store.head(objectKey);
                    if (head?.size !== next.length) {
                        result.mismatched++;
                        return;
                    }
                    await record(file.id, next.length);
                    result.resealed++;
                });
            }
        }
    } catch (error) {
        if (!(error instanceof StorageUnavailableError)) {
            throw error;
        }
        result.unavailable = true;
    }
    return result;
}
