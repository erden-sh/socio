import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

/** The most DuckDB may spill to its temp directory (CB-164). */
export const TEMP_MAX = '2GB';

export interface DuckOptions {
    memoryMb: number;
    threads: number;
    /** Where it spills; under the analytics directory. */
    tempDir: string;
}

/**
 * Opens a DuckDB file offline and locked down (CB-186): it never installs
 * or loads an extension on its own (so it never reaches
 * extensions.duckdb.org), reads or writes no file but its own (no
 * `read_csv`, `ATTACH`, `COPY`, and no `sqlite` extension: the ETL reads
 * SQLite through `node:sqlite`), and nothing can change that afterwards.
 * DuckDB applies options in order, and with external access off it
 * refuses a temp directory, so that goes first and the lock last.
 */
export function openDuck(path: string, options: DuckOptions) {
    return DuckDBInstance.create(path, {
        temp_directory: options.tempDir,
        max_temp_directory_size: TEMP_MAX,
        memory_limit: `${options.memoryMb}MB`,
        threads: String(options.threads),
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
        allow_community_extensions: 'false',
        allow_unsigned_extensions: 'false',
        enable_external_access: 'false',
        lock_configuration: 'true',
    });
}

/** Another process holds the file (DuckDB allows one writer per file). */
export function isLockError(error: unknown) {
    return /Could not set lock on file/i.test(String(errorMessage(error)));
}

/**
 * The file is damaged or isn't DuckDB's: rebuilt, as it holds only data
 * derived from SQLite.
 */
export function isCorruptError(error: unknown) {
    return /not a valid DuckDB database file|Could not read enough bytes|Corrupt|checksum|INTERNAL Error|Serialization Error/i.test(
        String(errorMessage(error)),
    );
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

/** Rows as plain objects, BIGINTs as numbers when they fit. */
export async function rows<T = Record<string, unknown>>(
    connection: DuckDBConnection,
    sql: string,
    values?: Parameters<DuckDBConnection['run']>[1],
): Promise<T[]> {
    const reader = await connection.runAndReadAll(sql, values);
    return reader.getRowObjects().map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            out[key] =
                typeof value === 'bigint' &&
                value <= BigInt(Number.MAX_SAFE_INTEGER) &&
                value >= BigInt(Number.MIN_SAFE_INTEGER)
                    ? Number(value)
                    : value;
        }
        return out as T;
    });
}
