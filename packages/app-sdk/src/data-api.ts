/**
 * The data API's wire shapes for a plugin's or app's dataset work
 * (`/api/data`), for a driver such as a D1-style `prepare/bind/all/first/run`
 * with `batch`: queries, read batches (CB-474) and write batches with
 * assertions and `RETURNING` (CB-475). docs/PLUGINS.md, "Datasets", has
 * the rules; the server's own types are in `src/server/dataspace/contract.ts`.
 */

/** A bound value: booleans are stored as 0 and 1. */
export type DataValue = string | number | boolean | null;

/** A cell as JSON: integers past 2^53 are strings, BLOBs `{ $blob: base64 }`. */
export type DataCell = string | number | boolean | null | { $blob: string };

/** `POST /api/data/datasets/:id/query`, and each statement of a read batch. */
export interface DataQueryResult {
    columns: string[];
    rows: DataCell[][];
    /** More rows (or bytes) than the caps allowed were left out. */
    truncated: boolean;
    ms: number;
}

/**
 * `POST /api/data/datasets/:id/read-batch` (CB-474): up to
 * `batchMaxStatements` (32) SELECTs read from one snapshot, one operation
 * against the per-minute budget. Each keeps the single query's caps;
 * `maxRows` lowers them.
 */
export interface DataReadBatchRequest {
    statements: Array<{ sql: string; params?: DataValue[] }>;
    maxRows?: number;
}

export interface DataReadBatchResponse {
    dataset: string;
    datasetId: string;
    statements: number;
    /** In the order sent. */
    results: DataQueryResult[];
    ms: number;
}

/**
 * One statement of `POST /api/data/datasets/:id/batch`. `expectChanges`
 * (CB-475): any other count of changed rows rolls the whole batch back with
 * a `409` naming the statement (`DataBatchExpectationError`).
 */
export type DataBatchStatement = (
    | { sql: string; params?: DataValue[] }
    | { op: 'insert'; table: string; rows: Array<Record<string, unknown>> }
    | { op: 'upsert'; table: string; rows: Array<Record<string, unknown>>; key: string[] }
) & { expectChanges?: number };

/** One write statement's outcome, as D1's `meta.changes` and `meta.last_row_id`. */
export interface DataBatchStatementResult {
    changes: number;
    /** SQLite's `last_insert_rowid()` after it (a string past 2^53); meaningful after an INSERT. */
    lastInsertRowid: number | string | null;
    /** With a `RETURNING` clause: its columns and every row. */
    columns?: string[];
    rows?: DataCell[][];
}

export interface DataBatchResponse {
    status: 'done';
    dataset: string;
    result: {
        statements: number;
        changes: number[];
        totalChanges: number;
        results: DataBatchStatementResult[];
    };
}

/** A failed `expectChanges` (`409`): `index` is the statement's, from 0. */
export interface DataBatchExpectationError {
    error: string;
    code: 'expect_changes';
    index: number;
    expected: number;
    actual: number;
}

/** `GET` and `PUT /api/data/plugins/:pluginId/budget` (CB-473, admins only). */
export interface DataPluginBudget {
    pluginId: string;
    /** In force now: the override, else the workspace's plugin default. */
    statementsPerMinute: number;
    override: number | null;
    workspaceDefault: number;
    max: number;
    setBy?: string;
    setAt?: number;
}
