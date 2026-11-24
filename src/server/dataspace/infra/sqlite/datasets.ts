import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { DeletedStamp } from '../../contract.js';
import type { DatasetRepository, DatasetSettings, DatasetSizes, NewDataset } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataDatasets } from './schema.js';

/** Hard deletes name the table (tests/hard-deletes.test.ts). */
const d = dataDatasets;

/** What a new dataset's row holds besides what it is given (the defaults). */
const empty = { sizeBytes: 0, historyBytes: 0, tableCount: 0, analyticalBytes: 0 };

/** Dataset metadata, hidden and kept once deleted (CB-64). */
export class SqliteDatasets extends SqliteRepository implements DatasetRepository {
    insertNow(dataset: NewDataset) {
        this.db
            .insert(d)
            .values({ ...dataset, ...empty })
            .run();
    }

    insertScratchNow(dataset: NewDataset) {
        // The partial unique index on (ownerUserId, scratchForDotId) over live
        // rows is the conflict: a scratch dataset made meanwhile wins.
        const { changes } = this.db
            .insert(d)
            .values({ ...dataset, ...empty })
            .onConflictDoNothing()
            .run();
        return Number(changes) > 0;
    }

    updateNow(id: string, settings: DatasetSettings) {
        this.db.update(d).set(settings).where(eq(d.id, id)).run();
    }

    recordAnalyticalBytesNow(id: string, bytes: number, at: number) {
        this.db.update(d).set({ analyticalBytes: bytes, updatedAt: at }).where(eq(d.id, id)).run();
    }

    requestCompactNow(id: string, at: number | null) {
        this.db.update(d).set({ compactRequestedAt: at }).where(eq(d.id, id)).run();
    }

    clearCompactNow(id: string, at: number) {
        this.db
            .update(d)
            .set({ compactRequestedAt: null })
            .where(and(eq(d.id, id), eq(d.compactRequestedAt, at)))
            .run();
    }

    recordSizesNow(id: string, sizes: DatasetSizes) {
        this.db.update(d).set(sizes).where(eq(d.id, id)).run();
    }

    recordSizes(id: string, sizes: DatasetSizes, at: number) {
        this.soon('dataset sizes', () => {
            this.db
                .update(d)
                .set({ ...sizes, updatedAt: at })
                .where(eq(d.id, id))
                .run();
        });
    }

    markDeletedNow(id: string, stamp: DeletedStamp) {
        this.db
            .update(d)
            .set({
                deletedAt: stamp.at,
                deletedBy: stamp.by,
                deletedWith: stamp.with,
            })
            .where(and(eq(d.id, id), isNull(d.deletedAt)))
            .run();
    }

    removeNow(id: string) {
        this.db.delete(dataDatasets).where(eq(d.id, id)).run();
    }

    moveOwnerNow(id: string, from: string, to: string) {
        const { changes } = this.db
            .update(d)
            .set({ ownerUserId: to })
            .where(and(eq(d.id, id), eq(d.ownerUserId, from)))
            .run();
        return Number(changes) > 0;
    }

    reparentNow(spaceId: string, pageIds: readonly string[], parentId: string | null) {
        if (!pageIds.length) {
            return 0;
        }
        const { changes } = this.db
            .update(d)
            .set({ spaceParentId: parentId })
            .where(and(eq(d.sharedSpaceId, spaceId), inArray(d.spaceParentId, [...pageIds]), isNull(d.deletedAt)))
            .run();
        return Number(changes);
    }

    markDotDeletedNow(dotId: string, at: number) {
        const { changes } = this.db
            .update(d)
            .set({ dotDeletedAt: at })
            .where(and(eq(d.scratchForDotId, dotId), isNull(d.dotDeletedAt)))
            .run();
        return Number(changes);
    }
}
