import type { DatabaseSync } from 'node:sqlite';

import { sqliteData, writeSoon } from '@socio/data/open';

import { utcDay, type DatasetSizeDay, type DatasetSizeDays } from '../../domain/size-days.js';

import { dataDatasetDays } from './schema.js';

/** `DatasetSizeDays` on the app's connection (CB-110). */
export class SqliteDatasetSizeDays implements DatasetSizeDays {
    constructor(private db: DatabaseSync) {}

    record(row: DatasetSizeDay) {
        const values = { ...row, day: utcDay(row.measuredAt) };
        // Queued behind another chain's unit of work, if one is open.
        writeSoon(this.db, 'dataset size day', () => {
            sqliteData(this.db)
                .uow.executor()
                .insert(dataDatasetDays)
                .values(values)
                .onConflictDoUpdate({
                    target: [dataDatasetDays.datasetId, dataDatasetDays.day],
                    set: {
                        sizeBytes: values.sizeBytes,
                        historyBytes: values.historyBytes,
                        tableCount: values.tableCount,
                        measuredAt: values.measuredAt,
                    },
                })
                .run();
        });
    }
}
