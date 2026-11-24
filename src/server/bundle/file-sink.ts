/**
 * Where an import puts page images (CB-380): into a person's Files on the
 * target, sealed with the target's data key for that file (the data
 * space's seal, `<owner>/<fileId>`, purpose `data-files`), in the store
 * new files go to. The bundle carries them unsealed; the source's seal is
 * never copied.
 *
 * It writes what `DataSpace.putFile` writes for a new file, without the
 * quota and rate limits a person's own uploads have: an import is an
 * operator's. A live file already at the path is reused (a re-run after a
 * cut-off import), and never replaced.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ObjectStore } from '@socio/data/object-store';
import { transaction } from '@socio/data/open';
import { objectKey } from '@socio/data/storage/keys';
import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface FileSinkInput {
    ownerUserId: string;
    /** The file's path in its owner's Files. */
    path: string;
    name: string;
    mediaType: string;
    bytes: Uint8Array;
}

export interface FileSink {
    /** Stores the file and resolves its id. */
    put(input: FileSinkInput): Promise<string>;
}

export interface SealedFileSinkOptions {
    db: DatabaseSync;
    /** The target's data keyring (`PlatformKeys`): new seals use its current key. */
    keys: DataKeyring;
    /** The store new files go to (S3 when configured, else the local disk). */
    store: ObjectStore;
    tenantId: string;
    now?: () => number;
}

export function sealedFileSink(options: SealedFileSinkOptions): FileSink {
    const box = new SecretBox(options.keys, 'data-files');
    const now = options.now ?? Date.now;
    return {
        async put(input) {
            // Prepared when used: the sink is made while the server builds its routes.
            const found = options.db
                .prepare('SELECT id, size FROM data_files WHERE ownerUserId=? AND path=? AND deletedAt IS NULL')
                .get(input.ownerUserId, input.path) as { id: string; size: number } | undefined;
            if (found) {
                // Reused only when it holds exactly these bytes (a re-run after a cut-off import).
                const sealed =
                    Number(found.size) === input.bytes.length
                        ? await options.store.get(
                              objectKey(options.store.driver, options.tenantId, input.ownerUserId, found.id),
                          )
                        : undefined;
                let same = false;
                try {
                    same =
                        !!sealed &&
                        sha256(box.openBytes(sealed, `${input.ownerUserId}/${found.id}`)) === sha256(input.bytes);
                } catch {
                    same = false;
                }
                if (!same) {
                    throw new Error(
                        `There is another file at ${input.path} already. Move or delete it, then import again.`,
                    );
                }
                return found.id;
            }
            const id = randomUUID();
            const driver = options.store.driver;
            const sealed = box.sealBytes(input.bytes, `${input.ownerUserId}/${id}`);
            await options.store.put(objectKey(driver, options.tenantId, input.ownerUserId, id), sealed);
            const at = now();
            await transaction(options.db, 'import file', () => {
                options.db
                    .prepare(
                        `INSERT INTO data_files(id, ownerUserId, path, size, storedSize, mediaType, createdByDotId, createdAt, updatedAt, storage, name, sealKey)
                         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        id,
                        input.ownerUserId,
                        input.path,
                        input.bytes.length,
                        sealed.length,
                        input.mediaType,
                        at,
                        at,
                        driver,
                        input.name.slice(0, 200),
                        box.currentKey,
                    );
            });
            return id;
        },
    };
}
