import type { DuckDBConnection } from '@duckdb/node-api';

/** A value for a fact column: text, a whole number, a flag or null. */
export type Cell = string | number | boolean | null;

/**
 * Appends rows to a table with DuckDB's appender, in the table's column
 * order, inside the caller's transaction: numbers as BIGINT (DuckDB casts
 * them to the column's type), text as VARCHAR.
 */
export async function append(
    duck: DuckDBConnection,
    table: string,
    rows: readonly (readonly Cell[])[],
    where: { schema?: string; catalog?: string } = {},
) {
    if (!rows.length) {
        return;
    }
    const appender = await duck.createAppender(table, where.schema ?? null, where.catalog ?? null);
    try {
        for (const row of rows) {
            for (const cell of row) {
                if (cell === null) {
                    appender.appendNull();
                } else if (typeof cell === 'string') {
                    appender.appendVarchar(cell);
                } else if (typeof cell === 'boolean') {
                    appender.appendBoolean(cell);
                } else {
                    appender.appendBigInt(BigInt(Math.trunc(cell)));
                }
            }
            appender.endRow();
        }
        appender.flushSync();
    } finally {
        appender.closeSync();
    }
}

/** A cell for `appendTyped`: a JS number is a DOUBLE there, a BigInt a BIGINT. */
export type TypedCell = string | bigint | number | boolean | null;

/**
 * Appends rows whose numbers are DOUBLEs and whose BigInts are BIGINTs
 * (cost columns, CB-195; a cycle's spend, CB-218), where `append` would
 * cut a number to a whole one.
 */
export async function appendTyped(
    duck: DuckDBConnection,
    table: string,
    rows: readonly (readonly TypedCell[])[],
    where: { schema?: string; catalog?: string } = {},
) {
    if (!rows.length) {
        return;
    }
    const appender = await duck.createAppender(table, where.schema ?? null, where.catalog ?? null);
    try {
        for (const row of rows) {
            for (const cell of row) {
                if (cell === null) {
                    appender.appendNull();
                } else if (typeof cell === 'string') {
                    appender.appendVarchar(cell);
                } else if (typeof cell === 'bigint') {
                    appender.appendBigInt(cell);
                } else if (typeof cell === 'boolean') {
                    appender.appendBoolean(cell);
                } else {
                    appender.appendDouble(cell);
                }
            }
            appender.endRow();
        }
        appender.flushSync();
    } finally {
        appender.closeSync();
    }
}
