import type { DatabaseSync } from 'node:sqlite';

import type { DuckDBConnection } from '@duckdb/node-api';

import type { AnalyticsSettings } from '@socio/shared/operations/operations-analytics';

/** What a batch works with besides the data: the settings in force. */
export interface EtlContext {
    settings: AnalyticsSettings;
    /** The reporting time zone the rollups are cut in. */
    timeZone: string;
    /** The cycle's time (ms), for retention. */
    now: number;
}

/** What one batch did. */
export interface EtlBatch {
    /** Where the next batch starts; kept in `etl_state` with the batch's rows. */
    watermark?: string;
    /** Nothing is left to copy for now. */
    caughtUp: boolean;
    /** How far through the source it is, 0 to 1, for "Rebuilding n%". */
    progress?: number;
}

/**
 * One source the ETL copies from SQLite into DuckDB (CB-187 adds them in
 * `analytics/steps.ts`). It reads SQLite through the analytics process's
 * own read-only `node:sqlite` connection, never DuckDB's `sqlite`
 * extension, at most 500 rows per batch in one short read transaction so
 * the app's writer and the WAL checkpoint are never held up. The engine
 * runs each batch and its watermark in one DuckDB transaction.
 */
export interface EtlStep {
    /** Its key in `etl_state`. */
    source: string;
    /** Its tables and indexes, created in every fresh file. */
    ddl: readonly string[];
    batch(input: {
        sqlite: DatabaseSync;
        duck: DuckDBConnection;
        /** null: from the start. */
        watermark: string | null;
        /** Building a fresh file, rather than keeping one current. */
        rebuilding: boolean;
        context: EtlContext;
    }): Promise<EtlBatch>;
}
