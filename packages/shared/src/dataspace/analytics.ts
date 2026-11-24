/**
 * Analytical tables (CB-369): a
 * dataset's append-only tables, stored as Parquet parts beside its SQLite
 * file and read with DuckDB. Shared so the client and the native app read
 * the same names; every field here is additive to the dataset types.
 */

/** A table's kind: `transactional` (SQLite, the default) or `analytical`. */
export type TableKind = 'transactional' | 'analytical';

/**
 * An analytical table's column types, one-to-one with Parquet and DuckDB:
 * TEXT, INTEGER (64-bit), REAL (double), DECIMAL(p,s), BOOLEAN, DATE,
 * TIMESTAMP (UTC, ms) and JSON (stored as text).
 */
export const ANALYTICAL_COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON'] as const;
/** `DECIMAL(p,s)`, precision 1 to 38 and scale 0 to p. */
export const ANALYTICAL_DECIMAL = /^DECIMAL\((\d{1,2}),(\d{1,2})\)$/;

/** The longest retention, in days, an analytical table may declare (`retainDays`). */
export const ANALYTICAL_RETAIN_DAYS_MAX = 36_500;

/** The unit of an analytical table's partitions. */
export type PartitionGrain = 'day' | 'month';

/** What the Data page and `GET …/datasets/:id` say of an analytical table. */
export interface AnalyticalTableStats {
    partitionBy: { column: string; grain: PartitionGrain };
    /** Live parts (Parquet files). */
    parts: number;
    /** Their bytes on disk, which the analytical budget counts. */
    bytes: number;
    partitions: number;
    /** The first and last partition, `2026-11-10` or `2026-11`; null when empty. */
    firstPartition: string | null;
    lastPartition: string | null;
    /** Days its partitions are kept (CB-387), the effective value; absent: kept until dropped. */
    retainDays?: number;
    /** Where that comes from, and what an admin may change (CB-387). */
    retention?: AnalyticalRetention;
}

/**
 * Where an analytical table's retention comes from (CB-387): an admin's
 * override on the table, the plugin's own value (its manifest, or the
 * table's declaration), or the workspace default (`DATA_ANALYTICS_RETAIN_DAYS`,
 * over which an admin's Settings value wins).
 */
export type AnalyticalRetentionSource = 'override' | 'manifest' | 'default';

/** An analytical table's retention as the nightly run applies it (CB-387). */
export interface AnalyticalRetention {
    /** Days kept; null keeps every partition. */
    days: number | null;
    source: AnalyticalRetentionSource;
    /** The admin's override: days, or null to keep everything. Absent: none. */
    override?: number | null;
    /** The plugin's value (manifest or table); null when it declares none. */
    declared: number | null;
    /** The workspace default in force; null keeps everything. */
    workspaceDefault: number | null;
}

/** What a retention would retire if the nightly run used it now (CB-387). */
export interface AnalyticalRetentionPreview {
    table: string;
    /** The days previewed; null keeps everything (nothing is dropped). */
    days: number | null;
    partitions: number;
    parts: number;
    rows: number;
    bytes: number;
    firstPartition: string | null;
    lastPartition: string | null;
}

/** The answer of `POST …/tables/:table/append` and `…/append-from`. */
export interface AppendResult {
    status: 'done';
    table: string;
    rows: number;
    parts: number;
    bytes: number;
    /** The append id was committed before: nothing was added, these are its counts. */
    duplicate?: boolean;
}
