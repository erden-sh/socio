import type { DuckDBConnection } from '@duckdb/node-api';

import type { EtlStep } from './etl.js';
import { rows } from './open.js';

/**
 * The store's own tables. Bump it (or a step's `ETL_VERSION`) with any
 * change to a table or to what the ETL writes: an open file with another
 * version is rebuilt from SQLite; until the new one is ready, queries
 * answer "not ready" (its tables may not be the ones they read).
 * There are no migrations: the file holds only derived data.
 */
export const ANALYTICS_SCHEMA_VERSION = 1;

const CORE_DDL = [
    `CREATE TABLE ops_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)`,
    // Per source, where the ETL got to and when (ms). AT is a keyword.
    `CREATE TABLE etl_state (source VARCHAR PRIMARY KEY, watermark VARCHAR, "at" BIGINT NOT NULL)`,
];

/** What makes a file current: rebuilt when any of these changes. */
export function fileVersion(etlVersion: number, duckdbVersion: string) {
    return `${ANALYTICS_SCHEMA_VERSION}.${etlVersion}@${duckdbVersion}`;
}

export async function createSchema(connection: DuckDBConnection, steps: readonly EtlStep[], version: string) {
    for (const sql of [...CORE_DDL, ...steps.flatMap((step) => step.ddl)]) {
        await connection.run(sql);
    }
    await setMeta(connection, 'version', version);
}

export async function setMeta(connection: DuckDBConnection, key: string, value: string) {
    await connection.run(
        `INSERT INTO ops_meta VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [key, value],
    );
}

/** The file's meta, or undefined when it has none (not ours, or half made). */
export async function readMeta(connection: DuckDBConnection) {
    const exists = await rows(
        connection,
        `SELECT 1 FROM duckdb_tables() WHERE table_name = 'ops_meta' AND schema_name = 'main'`,
    );
    if (!exists.length) {
        return undefined;
    }
    const meta = await rows<{ key: string; value: string }>(connection, 'SELECT key, value FROM ops_meta');
    return Object.fromEntries(meta.map(({ key, value }) => [key, value]));
}

export async function duckdbVersion(connection: DuckDBConnection) {
    const [row] = await rows<{ v: string }>(connection, 'SELECT version() AS v');
    return row?.v ?? 'unknown';
}
