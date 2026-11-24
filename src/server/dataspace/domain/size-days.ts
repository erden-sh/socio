/** A dataset's sizes as one write measured them (CB-191). */
export interface DatasetSizeDay {
    datasetId: string;
    sizeBytes: number;
    historyBytes: number;
    tableCount: number;
    measuredAt: number;
}

/**
 * Each dataset's sizes per UTC day, the day's last measurement winning
 * (`data_dataset_days`, data migration 8): what Operations charts as
 * dataset sizes over time. Nothing reads it back at once, so a record is
 * written soon, in order, never making the write that measured it wait.
 */
export interface DatasetSizeDays {
    record(day: DatasetSizeDay): void;
}

/** The UTC day a time falls on, as days since the epoch. */
export const utcDay = (at: number) => Math.floor(at / 86_400_000);
