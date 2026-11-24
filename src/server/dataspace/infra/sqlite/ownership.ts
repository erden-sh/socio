import type { DatabaseSync } from 'node:sqlite';

import { freeName, type OwnedItem, type TransferParties, type TransferTally } from '@socio/shared/auth';

/** A file row as a transfer copies it: what must not change between the copy and the commit. */
export interface TransferFileRow {
    id: string;
    storage: 'local' | 's3';
    sealKey: string;
    storedSize: number;
}

/** Every file row of a person, deleted versions too: each has bytes of its own. */
export function transferFileRows(db: DatabaseSync, userId: string) {
    return db
        .prepare('SELECT id, storage, sealKey, storedSize FROM data_files WHERE ownerUserId=? ORDER BY id')
        .all(userId) as unknown as TransferFileRow[];
}

/** A moved file's new seal: the data key and size of the bytes sealed for its new owner. */
export function recordTransferredSeal(db: DatabaseSync, id: string, sealKey: string, storedSize: number) {
    db.prepare('UPDATE data_files SET sealKey=?, storedSize=? WHERE id=?').run(sealKey, storedSize, id);
}

/** Every dataset of a person, deleted ones too: each is a file of its own. */
export function transferDatasetIds(db: DatabaseSync, userId: string) {
    return (
        db.prepare('SELECT id FROM data_datasets WHERE ownerUserId=? ORDER BY id').all(userId) as { id: string }[]
    ).map((row) => row.id);
}

/** A person's datasets and files as the assets view lists them. */
export function ownedDataItems(db: DatabaseSync, userId: string): OwnedItem[] {
    const datasets = db
        .prepare(
            'SELECT id, name, scratchForDotId, deletedAt FROM data_datasets WHERE ownerUserId=? ORDER BY createdAt, id',
        )
        .all(userId) as { id: string; name: string; scratchForDotId: string | null; deletedAt: number | null }[];
    const files = db
        .prepare('SELECT id, path, deletedAt FROM data_files WHERE ownerUserId=? ORDER BY path, createdAt, id')
        .all(userId) as { id: string; path: string; deletedAt: number | null }[];
    return [
        ...datasets.map((row) => ({
            id: row.id,
            name: row.name,
            type: row.scratchForDotId ? 'scratch' : 'dataset',
            deleted: row.deletedAt !== null,
        })),
        ...files.map((row) => ({ id: row.id, name: row.path, type: 'file', deleted: row.deletedAt !== null })),
    ];
}

/** `reports/summary.md` → `reports/summary 2.md`: the same folder, a free name. */
export function freePath(path: string, taken: (path: string) => boolean) {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const free = freeName(stem, (candidate) => taken(`${folder}${candidate}${extension}`), 128 - extension.length);
    return `${folder}${free}${extension}`;
}

const ACCESS_RANK: Record<string, number> = { read: 1, write: 2 };

/**
 * Moves a person's data space rows to another person (CB-360), inside the
 * caller's transaction: datasets, files (deleted versions too) and the
 * grants they gave socios. Their audit stays as it was. A live file at a
 * path the new owner uses already gets a free name beside it; a private
 * scratch area for a socio the new owner has one for already becomes a
 * dataset of its own; a grant the new owner gave the same socio already
 * keeps the wider access.
 */
export function transferDataRows(db: DatabaseSync, { from, to, fromName }: TransferParties): TransferTally {
    const notes: string[] = [];
    const now = Date.now();

    // Scratch areas the new owner has for the same socio already.
    const clashing = db
        .prepare(
            `SELECT d.id, d.name FROM data_datasets d WHERE d.ownerUserId=? AND d.deletedAt IS NULL AND d.scratchForDotId IS NOT NULL
               AND EXISTS (SELECT 1 FROM data_datasets t WHERE t.ownerUserId=? AND t.deletedAt IS NULL AND t.scratchForDotId=d.scratchForDotId)`,
        )
        .all(from, to) as { id: string; name: string }[];
    const names = new Set(
        (
            db.prepare('SELECT name FROM data_datasets WHERE ownerUserId=? AND deletedAt IS NULL').all(to) as {
                name: string;
            }[]
        ).map((row) => row.name),
    );
    for (const scratch of clashing) {
        const name = freeName(`${scratch.name} (${fromName})`.slice(0, 80), (candidate) => names.has(candidate));
        names.add(name);
        db.prepare('UPDATE data_datasets SET scratchForDotId=NULL, name=?, updatedAt=? WHERE id=?').run(
            name,
            now,
            scratch.id,
        );
        notes.push(
            `A private scratch area became the dataset “${name}”: the new owner has one for that socio already.`,
        );
    }
    const datasets = db.prepare('UPDATE data_datasets SET ownerUserId=? WHERE ownerUserId=?').run(to, from);

    // Live files at a path the new owner uses.
    const paths = new Set(
        (
            db
                .prepare('SELECT path FROM data_files WHERE ownerUserId IN (?, ?) AND deletedAt IS NULL')
                .all(to, from) as {
                path: string;
            }[]
        ).map((row) => row.path),
    );
    const theirs = db.prepare('SELECT 1 FROM data_files WHERE ownerUserId=? AND path=? AND deletedAt IS NULL');
    const clashes = (
        db
            .prepare('SELECT id, path FROM data_files WHERE ownerUserId=? AND deletedAt IS NULL ORDER BY path')
            .all(from) as {
            id: string;
            path: string;
        }[]
    ).filter((row) => theirs.get(to, row.path));
    for (const file of clashes) {
        const path = freePath(file.path, (candidate) => paths.has(candidate));
        paths.add(path);
        db.prepare('UPDATE data_files SET path=?, updatedAt=? WHERE id=?').run(path, now, file.id);
        notes.push(`File ${file.path} is now ${path}: the new owner has a file there.`);
    }
    const files = db.prepare('UPDATE data_files SET ownerUserId=? WHERE ownerUserId=?').run(to, from);

    // Grants to socios: one per socio and target; the wider access stays.
    const grants = db
        .prepare('SELECT id, dotId, datasetId, folder, access FROM data_grants WHERE ownerUserId=?')
        .all(from) as { id: string; dotId: string; datasetId: string | null; folder: string | null; access: string }[];
    const same = db.prepare(
        "SELECT id, access FROM data_grants WHERE ownerUserId=? AND dotId=? AND COALESCE(datasetId, '')=? AND COALESCE(folder, '')=?",
    );
    let movedGrants = 0;
    let mergedGrants = 0;
    for (const grant of grants) {
        const existing = same.get(to, grant.dotId, grant.datasetId ?? '', grant.folder ?? '') as
            | { id: string; access: string }
            | undefined;
        if (!existing) {
            db.prepare('UPDATE data_grants SET ownerUserId=? WHERE id=?').run(to, grant.id);
            movedGrants++;
            continue;
        }
        if ((ACCESS_RANK[grant.access] ?? 0) > (ACCESS_RANK[existing.access] ?? 0)) {
            db.prepare('UPDATE data_grants SET access=? WHERE id=?').run(grant.access, existing.id);
        }
        db.prepare('DELETE FROM data_grants WHERE id=?').run(grant.id);
        mergedGrants++;
    }
    return {
        moved: {
            datasets: Number(datasets.changes),
            files: Number(files.changes),
            grants: movedGrants,
            ...(clashing.length ? { scratchAreasRenamed: clashing.length } : {}),
            ...(clashes.length ? { filesRenamed: clashes.length } : {}),
            ...(mergedGrants ? { grantsMerged: mergedGrants } : {}),
        },
        notes,
    };
}
