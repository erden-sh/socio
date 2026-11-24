import { StorageUnavailableError, type StorageDriver } from '@socio/data/object-store';

import type { LocalMigration, LocalMigrationResult } from './contract.js';

interface Row {
    id: string;
    ownerUserId: string;
    storedSize: number;
    storage: StorageDriver;
}

/**
 * Moves the data space's local files into S3 once (CB-54), idempotently.
 * Per row marked `local`, under the user's lock: read the sealed bytes,
 * put them to the row's S3 key, HEAD it and check the size, mark the row
 * `s3`, then delete the local file. A crash before the update re-puts the
 * same bytes next time; one after it leaves a local copy, which the sweep
 * removes once the object is there. The bytes stay sealed throughout: the
 * key and AAD are the file's id, so nothing is re-encrypted. Deleted
 * files (CB-64) move too: they are kept, so their bytes go where the rest
 * are.
 */
export async function migrateLocalFiles(options: LocalMigration): Promise<LocalMigrationResult> {
    const result: LocalMigrationResult = {
        moved: 0,
        missing: 0,
        mismatched: 0,
        cleaned: 0,
        unavailable: false,
    };
    const { db, from, to, key } = options;
    const batch = options.batch ?? 50;
    const current = (id: string) =>
        db.prepare('SELECT id, ownerUserId, storedSize, storage FROM data_files WHERE id=?').get(id) as Row | undefined;
    try {
        // By id, past the last batch: rows left as they are aren't seen twice.
        let after = '';
        for (;;) {
            const rows = db
                .prepare("SELECT id, ownerUserId FROM data_files WHERE storage='local' AND id>? ORDER BY id LIMIT ?")
                .all(after, batch) as unknown as Row[];
            if (!rows.length) {
                break;
            }
            after = rows[rows.length - 1].id;
            for (const { id, ownerUserId } of rows) {
                if (options.stopped?.()) {
                    return result;
                }
                await options.exclusive(ownerUserId, async () => {
                    const row = current(id);
                    if (!row || row.storage !== 'local') {
                        return;
                    }
                    const localKey = key('local', row.ownerUserId, row.id);
                    const remoteKey = key(to.driver, row.ownerUserId, row.id);
                    const bytes = await from.get(localKey);
                    if (!bytes) {
                        result.missing++;
                        return;
                    }
                    await to.put(remoteKey, bytes);
                    const head = await to.head(remoteKey);
                    if (head?.size !== row.storedSize || bytes.length !== row.storedSize) {
                        result.mismatched++;
                        return;
                    }
                    await options.files.markMoved(row.id, to.driver);
                    await from.delete(localKey);
                    result.moved++;
                });
            }
        }
        if (!options.sweep) {
            return result;
        }
        after = '';
        for (;;) {
            const rows = db
                .prepare('SELECT id, ownerUserId FROM data_files WHERE storage=? AND id>? ORDER BY id LIMIT ?')
                .all(to.driver, after, batch) as unknown as Row[];
            if (!rows.length) {
                break;
            }
            after = rows[rows.length - 1].id;
            for (const { id, ownerUserId } of rows) {
                if (options.stopped?.()) {
                    return result;
                }
                await options.exclusive(ownerUserId, async () => {
                    const row = current(id);
                    if (!row || row.storage !== to.driver) {
                        return;
                    }
                    const localKey = key('local', row.ownerUserId, row.id);
                    if (!(await from.head(localKey))) {
                        return;
                    }
                    const head = await to.head(key(to.driver, row.ownerUserId, row.id));
                    if (head?.size !== row.storedSize) {
                        return;
                    }
                    await from.delete(localKey);
                    result.cleaned++;
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
