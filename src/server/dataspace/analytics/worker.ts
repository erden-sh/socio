/**
 * The datasets' analytics process (CB-369): forked by the app
 * (`DATA_ANALYTICS_MODE=child`) with an empty environment, it stages appends as
 * Parquet parts and runs analytical queries with DuckDB. It never decides
 * access: the app sends each job the dataset file it has already authorized,
 * and the process reads only that file (read-only, through `node:sqlite`) and
 * the Parquet parts its catalog lists.
 *
 * Every DuckDB instance is in memory, made for one job, with extensions off
 * (Parquet and JSON are linked in), and locked down before any SQL runs:
 * `allowed_paths` / `allowed_directories` name exactly what the job may
 * touch, then `enable_external_access=false` and `lock_configuration=true`.
 * `allowed_paths` lets DuckDB write the files it names too, so a query is
 * also held to exactly one SELECT by DuckDB's own parser, and committed
 * parts are read-only on disk.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

import {
    DuckDBInstance,
    JSDuckDBValueConverter,
    JsonDuckDBValueConverter,
    type DuckDBConnection,
} from '@duckdb/node-api';

import {
    APPEND_FROM_CHUNK,
    MAX_APPEND_PARTITIONS,
    OLAP_PARTS,
    OLAP_TABLES,
    STAGING_DIR,
    dateMs,
    duckType,
    partPath,
    partitionOf,
    partsDir,
    timestampMs,
    type AnalyticalColumn,
    type AnalyticalTable,
    type StagedPart,
} from './declare.js';
import type { WorkerJob, WorkerReply } from './ipc.js';

/** An error with the HTTP status the app answers with. */
class JobError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

const HIDDEN = (name: string) => {
    const lower = name.toLowerCase();
    return (
        lower.startsWith('_history_') ||
        lower.startsWith('_deleted_') ||
        lower.startsWith('_olap_') ||
        lower.startsWith('_stamp') ||
        lower === '_writes' ||
        lower === '_writer'
    );
};
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A fresh in-memory DuckDB, offline, reaching only `paths` and `dirs`, then locked. */
async function lockedDuck(options: {
    memoryMb: number;
    threads: number;
    tempDir?: string;
    tempMb?: number;
    paths?: readonly string[];
    dirs?: readonly string[];
}) {
    const instance = await DuckDBInstance.create(':memory:', {
        memory_limit: `${options.memoryMb}MB`,
        threads: String(options.threads),
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
        allow_community_extensions: 'false',
        allow_unsigned_extensions: 'false',
        ...(options.tempDir
            ? { temp_directory: options.tempDir, max_temp_directory_size: `${options.tempMb ?? 2048}MB` }
            : {}),
    });
    const connection = await instance.connect();
    const list = (items: readonly string[]) => `[${items.map(literal).join(', ')}]`;
    if (options.paths?.length) {
        await connection.run(`SET allowed_paths=${list(options.paths)}`);
    }
    const dirs = [...(options.dirs ?? []), ...(options.tempDir ? [options.tempDir] : [])];
    if (dirs.length) {
        await connection.run(`SET allowed_directories=${list(dirs.map((dir) => `${dir.replace(/\/$/, '')}/`))}`);
    }
    await connection.run('SET enable_external_access=false');
    await connection.run('SET lock_configuration=true');
    return {
        connection,
        close: () => {
            try {
                connection.closeSync();
            } catch {
                // Already closed.
            }
            try {
                instance.closeSync();
            } catch {
                // Already closed.
            }
        },
    };
}

// ── Staging ────────────────────────────────────────────────────────────

/** How a declared type is held while staged, and how COPY makes it the real one. */
function staging(column: AnalyticalColumn, index: number) {
    const name = `c${index}`;
    switch (column.type) {
        case 'INTEGER':
            return { name, type: 'BIGINT', select: `${name} AS ${quote(column.name)}` };
        case 'REAL':
            return { name, type: 'DOUBLE', select: `${name} AS ${quote(column.name)}` };
        case 'BOOLEAN':
            return { name, type: 'BOOLEAN', select: `${name} AS ${quote(column.name)}` };
        case 'TIMESTAMP':
            return { name, type: 'BIGINT', select: `epoch_ms(${name}) AS ${quote(column.name)}` };
        case 'TEXT':
        case 'JSON':
            return { name, type: 'VARCHAR', select: `${name} AS ${quote(column.name)}` };
        default:
            // DATE and DECIMAL(p,s): text, cast by COPY.
            return {
                name,
                type: 'VARCHAR',
                select: `CAST(${name} AS ${duckType(column.type)}) AS ${quote(column.name)}`,
            };
    }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
type Staged = string | number | bigint | boolean | null;

/**
 * A decimal number as plain text, if it fits DECIMAL(precision, scale)
 * exactly: no more fraction digits than the scale, no more whole digits than
 * precision minus scale. Exponents are written out.
 */
function decimalText(text: string, precision: number, scale: number) {
    const match = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(text);
    if (!match || !`${match[2]}${match[3] ?? ''}`) {
        return undefined;
    }
    const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
    let digits = `${whole}${fraction}`.replace(/^0+/, '');
    let shift = Number(exponent) - fraction.length;
    if (!digits) {
        return '0';
    }
    while (shift < 0 && digits.endsWith('0')) {
        digits = digits.slice(0, -1);
        shift++;
    }
    const fractionDigits = Math.max(0, -shift);
    const wholeDigits = digits.length + shift;
    if (fractionDigits > scale || wholeDigits > precision - scale) {
        return undefined;
    }
    const padded = shift >= 0 ? `${digits}${'0'.repeat(shift)}` : digits.padStart(fractionDigits + 1, '0');
    const at = padded.length - fractionDigits;
    return `${sign === '-' ? '-' : ''}${padded.slice(0, at)}${fractionDigits ? `.${padded.slice(at)}` : ''}`;
}

/** One cell, checked against its column and made what its staging column holds. */
function cellFor(column: AnalyticalColumn, input: unknown, where: string): Staged {
    if (input === null || input === undefined) {
        if (column.notNull) {
            throw new JobError(`${where}: ${column.name} is NOT NULL.`);
        }
        return null;
    }
    const bad = (expected: string): never => {
        throw new JobError(`${where}: ${column.name} must be ${expected}.`);
    };
    let value = input;
    // A JSON number with a fraction or exponent, as written: a DECIMAL, TEXT
    // or JSON cell keeps its digits, a REAL takes the nearest double, and the
    // whole-number types take it only when it is exactly a whole number.
    if (value instanceof SourceNumber) {
        if (!Number.isFinite(value.value)) {
            return bad('a finite number');
        }
        if (column.type === 'TEXT' || column.type === 'JSON') {
            return value.source;
        }
        if (column.type === 'REAL') {
            value = value.value;
        } else if (column.type.startsWith('DECIMAL')) {
            value = value.source;
        } else {
            const whole = decimalText(value.source, 40, 0);
            value = whole === undefined ? Number.NaN : BigInt(whole);
        }
    }
    switch (column.type) {
        case 'TEXT':
            return typeof value === 'string'
                ? value
                : (typeof value === 'number' && Number.isFinite(value)) ||
                    typeof value === 'boolean' ||
                    typeof value === 'bigint'
                  ? String(value)
                  : bad('text');
        case 'JSON': {
            // A string is JSON text (as a SQLite TEXT column holds it), so it
            // must parse; any other JSON value is written as JSON.
            if (typeof value === 'string') {
                try {
                    JSON.parse(value);
                    return value;
                } catch {
                    return bad('JSON (a string is taken as JSON text)');
                }
            }
            if (value instanceof Uint8Array) {
                return bad('JSON, not bytes');
            }
            if (typeof value === 'number' && !Number.isFinite(value)) {
                return bad('JSON, which has no NaN or Infinity');
            }
            return JSON.stringify(value, (_key, item: unknown) =>
                typeof item === 'bigint'
                    ? (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON(item.toString())
                    : item instanceof SourceNumber
                      ? (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON(item.source)
                      : item,
            );
        }
        case 'INTEGER': {
            let big: bigint | undefined;
            if (typeof value === 'bigint') {
                big = value;
            } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
                big = BigInt(value);
            } else if (typeof value === 'string' && /^-?\d{1,19}$/.test(value)) {
                big = BigInt(value);
            }
            return big !== undefined && big >= INT64_MIN && big <= INT64_MAX ? big : bad('a 64-bit whole number');
        }
        case 'REAL': {
            // A REAL is a double: an integer (SQLite's come as BigInts) is
            // the nearest double, exact up to 2^53, as SQLite's REAL holds it.
            const n =
                typeof value === 'number'
                    ? value
                    : typeof value === 'bigint'
                      ? Number(value)
                      : typeof value === 'string' && value.trim()
                        ? Number(value)
                        : NaN;
            return Number.isFinite(n) ? n : bad('a finite number');
        }
        case 'BOOLEAN':
            return typeof value === 'boolean'
                ? value
                : value === 0 || value === 1 || value === 0n || value === 1n
                  ? Number(value) === 1
                  : bad('true or false');
        case 'DATE':
            return dateMs(value) !== undefined ? (value as string) : bad('a date, YYYY-MM-DD');
        case 'TIMESTAMP': {
            const ms = timestampMs(typeof value === 'bigint' ? Number(value) : value);
            return ms !== undefined ? BigInt(ms) : bad('a timestamp: epoch milliseconds or ISO 8601');
        }
        default: {
            // DECIMAL(p,s): exactly, or refused, never rounded.
            const [, precision = '18', scale = '3'] = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(column.type) ?? [];
            const text = typeof value === 'number' || typeof value === 'bigint' ? String(value) : value;
            const exact =
                typeof text === 'string' ? decimalText(text.trim(), Number(precision), Number(scale)) : undefined;
            return exact !== undefined ? exact : bad('a decimal number');
        }
    }
}

/** The partition column's value as ms, from its checked cell. */
function partitionMs(column: AnalyticalColumn, cell: Staged) {
    return column.type === 'DATE' ? dateMs(cell)! : Number(cell);
}

/**
 * A JSON.parse reviver keeping numbers as written: integers past 2^53 as
 * BigInts (9007199254740993 stays itself), and numbers with a fraction or
 * exponent with their source text (`SourceNumber`), so no column takes a
 * value JSON.parse rounded.
 */
function exactNumbers(_key: string, value: unknown, context?: { source?: string }) {
    const source = context?.source;
    if (typeof value !== 'number' || source === undefined) {
        return value;
    }
    if (/^-?\d+$/.test(source)) {
        return Number.isSafeInteger(value) ? value : BigInt(source);
    }
    return new SourceNumber(source, value);
}

/** A JSON number with a fraction or exponent: its text as sent, and its double. */
class SourceNumber {
    constructor(
        readonly source: string,
        readonly value: number,
    ) {}
}

/** Rows as they arrive: from a staged request body, or a table of the dataset file. */
async function* rowsOf(job: Extract<WorkerJob, { kind: 'stage' }>, table: AnalyticalTable) {
    const source = job.source;
    if (source.kind === 'body') {
        if (source.format === 'json') {
            let parsed: unknown;
            try {
                parsed = JSON.parse(readFileSync(source.file, 'utf8'), exactNumbers);
            } catch {
                throw new JobError('The body is not JSON: send { "rows": [...] } or NDJSON (application/x-ndjson).');
            }
            const rows = Array.isArray(parsed)
                ? parsed
                : parsed && typeof parsed === 'object'
                  ? (parsed as { rows?: unknown }).rows
                  : undefined;
            if (!Array.isArray(rows)) {
                throw new JobError('The body is { "rows": [...] }.');
            }
            yield* rows;
            return;
        }
        const lines = createInterface({ input: createReadStream(source.file, 'utf8'), crlfDelay: Infinity });
        let n = 0;
        for await (const line of lines) {
            n++;
            if (!line.trim()) {
                continue;
            }
            try {
                yield JSON.parse(line, exactNumbers) as unknown;
            } catch {
                throw new JobError(`Line ${n} is not JSON.`);
            }
        }
        return;
    }
    // A table of the same dataset (`append-from`): read-only, in chunks,
    // each its own short read, so the app's writers never wait long.
    const db = new DatabaseSync(job.datasetPath, { readOnly: true, allowExtension: false });
    try {
        db.enableDefensive(true);
        db.exec('PRAGMA busy_timeout=2000');
        const exists = db
            .prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND type='table' AND name=?")
            .get(source.table) as { wr: number } | undefined;
        if (!exists || HIDDEN(source.table)) {
            throw new JobError(`No table "${source.table}" in this dataset.`, 404);
        }
        if (exists.wr) {
            throw new JobError(`"${source.table}" is a WITHOUT ROWID table, which append-from can't read in order.`);
        }
        const have = new Map(
            (db.prepare(`PRAGMA table_info(${quote(source.table)})`).all() as Array<{ name: string }>).map((c) => [
                c.name.toLowerCase(),
                c.name,
            ]),
        );
        const picked = table.columns.map((column) => {
            const name = have.get(column.name.toLowerCase());
            if (!name && column.notNull) {
                throw new JobError(`"${source.table}" has no column ${column.name}, which is NOT NULL here.`);
            }
            return name;
        });
        const filter = source.where;
        const filterColumn = filter ? have.get(filter.column.toLowerCase()) : undefined;
        if (filter && !filterColumn) {
            throw new JobError(`"${source.table}" has no column ${filter.column}.`);
        }
        // SQLite's own row id, under a name no column takes (one may be `rowid`).
        const rid = ['rowid', '_rowid_', 'oid'].find((name) => !have.has(name));
        if (!rid) {
            throw new JobError(
                `"${source.table}" has columns rowid, _rowid_ and oid, so append-from can't read it in order.`,
            );
        }
        // The first page has no cursor: a row id may be any signed 64-bit value.
        const page = (cursor: boolean) => {
            const conditions = [
                ...(cursor ? [`${rid} > ?`] : []),
                ...(filter?.from !== undefined ? [`${quote(filterColumn!)} >= ?`] : []),
                ...(filter?.to !== undefined ? [`${quote(filterColumn!)} <= ?`] : []),
            ];
            const statement = db.prepare(
                `SELECT ${rid} AS "__rid", ${picked.map((name, i) => (name ? `${quote(name)} AS "c${i}"` : `NULL AS "c${i}"`)).join(', ')} FROM ${quote(source.table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${rid} LIMIT ${APPEND_FROM_CHUNK}`,
            );
            statement.setReadBigInts(true);
            return statement;
        };
        const first = page(false);
        const next = page(true);
        const bounds = [
            ...(filter?.from !== undefined ? [filter.from] : []),
            ...(filter?.to !== undefined ? [filter.to] : []),
        ];
        let after: bigint | null = null;
        for (;;) {
            const chunk = (after === null ? first.all(...bounds) : next.all(after, ...bounds)) as Array<
                Record<string, unknown>
            >;
            for (const row of chunk) {
                yield Object.fromEntries(table.columns.map((column, i) => [column.name, row[`c${i}`]]));
            }
            if (chunk.length < APPEND_FROM_CHUNK) {
                return;
            }
            after = chunk.at(-1)!.__rid as bigint;
            await new Promise((resolve) => setImmediate(resolve));
        }
    } finally {
        db.close();
    }
}

/** Stages an append: one Parquet file per partition, synced to disk. */
async function stage(job: Extract<WorkerJob, { kind: 'stage' }>): Promise<{ parts: StagedPart[]; rows: number }> {
    const table = job.table;
    const dir = join(partsDir(job.datasetPath), STAGING_DIR);
    mkdirSync(dir, { recursive: true });
    const columns = table.columns.map(staging);
    const partitionColumn = table.columns.findIndex((column) => column.name === table.partitionBy.column);
    const known = new Set(table.columns.map((column) => column.name));
    const duck = await lockedDuck({
        memoryMb: job.memoryMb,
        threads: job.threads,
        tempDir: job.tempDir,
        tempMb: job.tempMb,
        dirs: [dir],
    });
    const written: string[] = [];
    try {
        await duck.connection.run(
            `CREATE TABLE rows (${columns.map((column) => `${column.name} ${column.type}`).join(', ')}, __partition VARCHAR)`,
        );
        const appender = await duck.connection.createAppender('rows');
        const partitions = new Map<string, { rows: number; min: number; max: number }>();
        let count = 0;
        try {
            for await (const raw of rowsOf(job, table)) {
                count++;
                const where = `Row ${count}`;
                if (count > job.maxRows) {
                    throw new JobError(`Send at most ${job.maxRows} rows per append.`, 413);
                }
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                    throw new JobError(`${where} is not an object.`);
                }
                const row = raw as Record<string, unknown>;
                for (const key of Object.keys(row)) {
                    if (!known.has(key)) {
                        throw new JobError(`${where}: "${key.slice(0, 63)}" is not a column of "${table.name}".`);
                    }
                }
                // Own keys only: a column named `constructor` left out is NULL.
                const cells = table.columns.map((column) =>
                    cellFor(column, Object.hasOwn(row, column.name) ? row[column.name] : undefined, where),
                );
                const ms = partitionMs(table.columns[partitionColumn]!, cells[partitionColumn]!);
                const partition = partitionOf(ms, table.partitionBy.grain);
                const seen = partitions.get(partition);
                if (seen) {
                    seen.rows++;
                    seen.min = Math.min(seen.min, ms);
                    seen.max = Math.max(seen.max, ms);
                } else {
                    if (partitions.size >= MAX_APPEND_PARTITIONS) {
                        throw new JobError(`One append touches at most ${MAX_APPEND_PARTITIONS} partitions.`, 413);
                    }
                    partitions.set(partition, { rows: 1, min: ms, max: ms });
                }
                for (const [i, cell] of cells.entries()) {
                    if (cell === null) {
                        appender.appendNull();
                    } else if (columns[i]!.type === 'BIGINT') {
                        appender.appendBigInt(cell as bigint);
                    } else if (columns[i]!.type === 'DOUBLE') {
                        appender.appendDouble(cell as number);
                    } else if (columns[i]!.type === 'BOOLEAN') {
                        appender.appendBoolean(cell as boolean);
                    } else {
                        appender.appendVarchar(cell as string);
                    }
                }
                appender.appendVarchar(partition);
                appender.endRow();
            }
            appender.flushSync();
        } finally {
            appender.closeSync();
        }
        if (!count) {
            throw new JobError('Send at least one row.');
        }
        const parts: StagedPart[] = [];
        for (const [partition, seen] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
            const id = randomUUID();
            const file = join(dir, `${id}.parquet`);
            written.push(file);
            await duck.connection.run(
                `COPY (SELECT ${columns.map((column) => column.select).join(', ')} FROM rows WHERE __partition = ${literal(partition)}) TO ${literal(file)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`,
            );
            const fd = openSync(file, 'r');
            try {
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            chmodSync(file, 0o444);
            parts.push({ id, partition, rows: seen.rows, bytes: statSync(file).size, min: seen.min, max: seen.max });
        }
        const fd = openSync(dir, 'r');
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        return { parts, rows: count };
    } catch (error) {
        for (const file of written) {
            rmSync(file, { force: true });
        }
        if (error instanceof JobError) {
            throw error;
        }
        throw new JobError(`The append failed: ${message(error).split('\n')[0]!.slice(0, 240)}`);
    } finally {
        duck.close();
    }
}

// ── Queries ────────────────────────────────────────────────────────────

/** How deep `query('…')` may nest inside a statement. */
const MAX_QUERY_DEPTH = 4;

/** An argument's constant string (`'facts'`), or undefined when it isn't one. */
function constantString(expression: unknown) {
    const item = expression as { class?: unknown; literal?: { kind?: unknown; text?: unknown } } | null;
    return item?.class === 'CONSTANT' && item.literal?.kind === 'STRING' && typeof item.literal.text === 'string'
        ? item.literal.text
        : undefined;
}

/** A table function's argument expressions, as DuckDB's parser serializes them. */
function argumentsOf(fn: { arguments?: unknown; children?: unknown }) {
    const list = Array.isArray(fn.arguments) ? fn.arguments : Array.isArray(fn.children) ? fn.children : [];
    return list.map((item) =>
        item && typeof item === 'object' && 'expression' in item ? (item as { expression: unknown }).expression : item,
    );
}

/**
 * The tables a statement names, by DuckDB's parser; refuses all but one
 * SELECT. `query_table('t')` (or a list of names) and `query('SELECT …')`
 * (CB-387) name tables in strings: with constant strings, those tables
 * are read too, and the inner query is held to one SELECT as the outer
 * one is. Anything else in them (a parameter, an expression) is refused.
 */
async function namedTables(sql: string) {
    const duck = await lockedDuck({ memoryMb: 64, threads: 1 });
    try {
        const names = new Set<string>();
        // `scope`: the CTEs where the text sits; DuckDB binds the names in
        // `query()` and `query_table()` to them first, as it does direct ones.
        const parse = async (text: string, depth: number, scope: ReadonlySet<string>) => {
            const reader = await duck.connection.runAndReadAll('SELECT json_serialize_sql(?::VARCHAR) AS j', [text]);
            const parsed = JSON.parse(String(reader.getRows()[0]?.[0] ?? '{}')) as {
                error?: boolean;
                error_type?: string;
                error_message?: string;
                statements?: unknown[];
            };
            const inner = depth ? 'query() inside it: ' : '';
            if (parsed.error) {
                if (parsed.error_type === 'parser') {
                    throw new JobError(
                        `The query doesn't parse: ${inner}${String(parsed.error_message).slice(0, 200)}`,
                    );
                }
                throw new JobError(
                    `Only one read-only SELECT (or WITH … SELECT) runs here${depth ? ', in query() too' : ''}: no PRAGMA, SET, ATTACH, COPY, INSTALL, LOAD, CREATE or EXPORT.`,
                    403,
                );
            }
            if (parsed.statements?.length !== 1) {
                throw new JobError(`Send one statement at a time${depth ? ', in query() too' : ''}.`, 403);
            }
            const indirect: Array<{ fn: string; args: unknown[]; scope: ReadonlySet<string> }> = [];
            // A name a WITH defines is that CTE, not a stored table, where
            // DuckDB would bind it to the CTE.
            const walk = (node: unknown, ctes: ReadonlySet<string>) => {
                if (Array.isArray(node)) {
                    node.forEach((child) => walk(child, ctes));
                } else if (node && typeof node === 'object') {
                    const item = node as {
                        type?: unknown;
                        table_name?: unknown;
                        schema_name?: unknown;
                        cte_map?: { map?: { key?: unknown }[] };
                    };
                    let scope = ctes;
                    const defined = item.cte_map?.map;
                    if (Array.isArray(defined) && defined.length) {
                        // As DuckDB binds a WITH: each definition sees the CTEs
                        // before it; a recursive one also sees itself, in its
                        // recursive term only (its anchor reads a stored table
                        // of its name); the body sees them all.
                        const seen = new Set(ctes);
                        for (const cte of defined) {
                            const key = typeof cte.key === 'string' ? cte.key.toLowerCase() : null;
                            const value = (cte as { value?: { query_node?: Record<string, unknown> } }).value;
                            const node = value?.query_node;
                            if (key && node?.type === 'RECURSIVE_CTE_NODE') {
                                const { left, ...rest } = node;
                                walk(left, new Set(seen));
                                walk(rest, new Set([...seen, key]));
                                walk({ ...value, query_node: null }, new Set(seen));
                            } else {
                                walk(value, new Set(seen));
                            }
                            if (key) {
                                seen.add(key);
                            }
                        }
                        scope = seen;
                    }
                    // Table functions that name tables (or SQL) in a string:
                    // read after this walk, since `query()` parses again.
                    const fn = (item as { function?: { function_name?: unknown } }).function;
                    const name = typeof fn?.function_name === 'string' ? fn.function_name.toLowerCase() : '';
                    if (item.type === 'TABLE_FUNCTION' && (name === 'query_table' || name === 'query')) {
                        indirect.push({ fn: name, args: argumentsOf(fn as { arguments?: unknown }), scope });
                    }
                    if (item.type === 'BASE_TABLE' && typeof item.table_name === 'string') {
                        const table = item.table_name.toLowerCase();
                        if (item.schema_name || !scope.has(table)) {
                            names.add(table);
                        }
                    }
                    for (const [field, child] of Object.entries(node)) {
                        if (field !== 'cte_map') {
                            walk(child, scope);
                        }
                    }
                }
            };
            walk(parsed.statements, scope);
            for (const { fn, args, scope: around } of indirect) {
                if (fn === 'query_table') {
                    // `query_table('t')`, `query_table(['a', 'b'])`, either with `by_name`.
                    const [first, byName, ...rest] = args;
                    const list = first as { class?: unknown; function_name?: unknown } | undefined;
                    const listed =
                        list?.class === 'FUNCTION' && list.function_name === 'list_value'
                            ? argumentsOf(list as { arguments?: unknown }).map(constantString)
                            : [constantString(first)];
                    const flag = byName as { class?: unknown; literal?: { kind?: unknown } } | undefined;
                    if (
                        !listed.length ||
                        listed.some((value) => value === undefined) ||
                        rest.length ||
                        (byName !== undefined && !(flag?.class === 'CONSTANT' && flag.literal?.kind === 'BOOLEAN'))
                    ) {
                        throw new JobError(
                            "query_table() takes its table names as constant strings here: query_table('facts') or query_table(['a', 'b']).",
                        );
                    }
                    for (const value of listed as string[]) {
                        // DuckDB reads the string as a (possibly qualified,
                        // quoted) name and binds its last part to a CTE in
                        // scope first; otherwise it is a stored table.
                        const last = value
                            .split('.')
                            .at(-1)!
                            .trim()
                            .replace(/^"(.*)"$/, '$1')
                            .replace(/""/g, '"')
                            .toLowerCase();
                        if (around.has(last)) {
                            continue;
                        }
                        names.add(last);
                        names.add(value.toLowerCase());
                    }
                    continue;
                }
                const text = args.length === 1 ? constantString(args[0]) : undefined;
                if (text === undefined) {
                    throw new JobError("query() takes one constant string here: query('SELECT … FROM facts').");
                }
                if (depth + 1 >= MAX_QUERY_DEPTH) {
                    throw new JobError(`query() nests at most ${MAX_QUERY_DEPTH - 1} deep here.`);
                }
                await parse(text, depth + 1, around);
            }
        };
        await parse(sql, 0, new Set());
        return names;
    } finally {
        duck.close();
    }
}

/** A transactional table's column, as DuckDB holds it while the query runs. */
function loadedType(declared: string, values: unknown[]) {
    const type = declared.toUpperCase();
    const fits = (check: (value: unknown) => boolean) => values.every((value) => value === null || check(value));
    // SQLite integers come as BigInts; a REAL (1e20 too) only when it is a safe integer.
    const whole = (value: unknown) => typeof value === 'bigint' || Number.isSafeInteger(value);
    const number = (value: unknown) => typeof value === 'number' || typeof value === 'bigint';
    const safe = (value: unknown) =>
        typeof value === 'number' ||
        (typeof value === 'bigint' &&
            value <= BigInt(Number.MAX_SAFE_INTEGER) &&
            value >= BigInt(Number.MIN_SAFE_INTEGER));
    // A column of numbers keeps numeric meaning (MAX, SUM, ORDER BY), whatever
    // its declared type (BOOLEAN, DATETIME, none: SQLite stores numbers in
    // any column but a TEXT one): whole numbers exact as BIGINT, else DOUBLE,
    // which holds every value SQLite gave except an integer past 2^53 beside
    // fractions, refused. A column of only NULLs keeps its affinity.
    const numeric = /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL|BOOL/.test(type) || values.some((value) => value !== null);
    if (numeric && fits(number)) {
        if (fits(whole)) {
            return 'BIGINT';
        }
        if (fits(safe)) {
            return 'DOUBLE';
        }
        throw new JobError(
            'A transactional column mixes integers past 2^53 with fractions, which no DuckDB number holds exactly: keep them in separate columns, or store the column as text.',
        );
    }
    // Bytes in any column (SQLite keeps a BLOB even in a TEXT one) stay bytes.
    if ((/BLOB/.test(type) || values.some((value) => value !== null)) && fits((value) => value instanceof Uint8Array)) {
        return 'BLOB';
    }
    return 'VARCHAR';
}

/** One answer cell, as the data API answers (`QueryResult`). */
function answerCell(value: unknown, type: string): string | number | boolean | null | { $blob: string } {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'bigint') {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    if (value instanceof Date) {
        return type === 'DATE' ? value.toISOString().slice(0, 10) : value.toISOString();
    }
    if (value instanceof Uint8Array) {
        return { $blob: Buffer.from(value).toString('base64') };
    }
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

async function query(job: Extract<WorkerJob, { kind: 'query' }>) {
    const started = performance.now();
    const named = await namedTables(job.sql);
    // The snapshot: the catalog's live parts and every
    // transactional table the statement names, in one read transaction.
    const db = new DatabaseSync(job.datasetPath, { readOnly: true, allowExtension: false });
    type Loaded = { name: string; columns: Array<{ name: string; type: string }>; rows: unknown[][] };
    const loaded: Loaded[] = [];
    const views: Array<{ table: AnalyticalTable; files: string[]; widest: number }> = [];
    try {
        db.enableDefensive(true);
        db.exec('PRAGMA busy_timeout=2000');
        db.exec('BEGIN');
        try {
            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'")
                .all()
                .map((row) => String(row.name));
            if (tables.includes(OLAP_TABLES)) {
                const parts = db
                    .prepare(
                        `SELECT id, table_id AS tableId, partition, columns FROM ${OLAP_PARTS} WHERE retired_at IS NULL`,
                    )
                    .all() as Array<{ id: string; tableId: string; partition: string; columns: number }>;
                for (const row of db
                    .prepare(`SELECT name, id, columns, partition_column, grain FROM ${OLAP_TABLES}`)
                    .all()) {
                    const table: AnalyticalTable = {
                        name: String(row.name),
                        id: String(row.id),
                        columns: JSON.parse(String(row.columns)) as AnalyticalColumn[],
                        partitionBy: { column: String(row.partition_column), grain: row.grain as 'day' | 'month' },
                    };
                    if (!named.has(table.name.toLowerCase())) {
                        continue;
                    }
                    const own = parts.filter((part) => part.tableId === table.id);
                    views.push({
                        table,
                        files: own.map((part) => partPath(job.datasetPath, part)),
                        widest: own.reduce((max, part) => Math.max(max, Number(part.columns)), 0),
                    });
                }
            }
            let rows = 0;
            let bytes = 0;
            for (const name of tables) {
                if (
                    HIDDEN(name) ||
                    !named.has(name.toLowerCase()) ||
                    views.some((view) => view.table.name.toLowerCase() === name.toLowerCase())
                ) {
                    continue;
                }
                const columns = (
                    db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string; type: string }>
                ).map((column) => ({ name: String(column.name), type: String(column.type ?? '') }));
                const statement = db.prepare(`SELECT * FROM ${quote(name)} LIMIT ?`);
                statement.setReadBigInts(true);
                statement.setReturnArrays(true);
                const out: unknown[][] = [];
                for (const row of statement.iterate(job.joinMaxRows + 1) as Iterable<unknown[]>) {
                    rows++;
                    for (const value of row) {
                        bytes +=
                            typeof value === 'string'
                                ? Buffer.byteLength(value)
                                : value instanceof Uint8Array
                                  ? value.byteLength
                                  : 8;
                    }
                    if (rows > job.joinMaxRows || bytes > job.joinMaxBytes) {
                        throw new JobError(
                            `A transactional table is too large to join (more than ${job.joinMaxRows} rows or ${Math.round(job.joinMaxBytes / 1048576)} MB together): filter it in a view, or query it with POST …/query.`,
                            413,
                        );
                    }
                    out.push(row);
                }
                loaded.push({ name, columns, rows: out });
            }
        } finally {
            db.exec('COMMIT');
        }
    } finally {
        db.close();
    }
    const files = views.flatMap((view) => view.files);
    mkdirSync(job.tempDir, { recursive: true });
    const duck = await lockedDuck({
        memoryMb: job.memoryMb,
        threads: job.threads,
        tempDir: job.tempDir,
        tempMb: job.tempMb,
        paths: files,
    });
    try {
        for (const view of views) {
            const typed = view.table.columns.map((column, i) =>
                view.files.length && i < view.widest
                    ? `${quote(column.name)}`
                    : `CAST(NULL AS ${duckType(column.type)}) AS ${quote(column.name)}`,
            );
            const from = view.files.length
                ? `read_parquet([${view.files.map(literal).join(', ')}], union_by_name=true)`
                : '(SELECT 1) AS empty WHERE false';
            await duck.connection.run(
                `CREATE VIEW ${quote(view.table.name)} AS SELECT ${typed.join(', ')} FROM ${from}`,
            );
        }
        for (const table of loaded) {
            const types = table.columns.map((column, i) =>
                loadedType(
                    column.type,
                    table.rows.map((row) => row[i]),
                ),
            );
            await duck.connection.run(
                `CREATE TEMP TABLE ${quote(table.name)} (${table.columns.map((column, i) => `${quote(column.name)} ${types[i]}`).join(', ')})`,
            );
            await appendRows(duck.connection, table.name, types, table.rows);
        }
        const timer = setTimeout(() => {
            try {
                duck.connection.interrupt();
            } catch {
                // Finished meanwhile.
            }
        }, job.timeoutMs);
        try {
            const prepared = await duck.connection.prepare(job.sql);
            if (job.params.length) {
                prepared.bind(job.params as Parameters<typeof prepared.bind>[0]);
            }
            // Streamed and converted a row at a time, each checked against
            // the caps before the next: a wide result is never held whole.
            const result = await prepared.stream();
            const columns = result.columnNames();
            const types = result.columnTypes().map((type) => type.toString());
            // DECIMAL exactly, as text: a JS number would round it. (Whole
            // numbers come as BigInts, which `answerCell` keeps exact.)
            // Nested values (STRUCT, LIST, ARRAY, MAP, UNION) go as DuckDB's
            // own JSON of them, which keeps their decimals and wide integers
            // exact as text.
            const exact = types.map((type) =>
                /^(?:STRUCT|MAP|UNION)\(|\]$/.test(type) ? 'nested' : type.startsWith('DECIMAL(') ? 'decimal' : null,
            );
            const anyExact = exact.some(Boolean);
            const rows: unknown[][] = [];
            let size = 2;
            let truncated = false;
            read: for (;;) {
                const chunk = await result.fetchChunk();
                if (!chunk || chunk.rowCount === 0) {
                    break;
                }
                for (let index = 0; index < chunk.rowCount; index++) {
                    if (rows.length >= job.maxRows) {
                        truncated = true;
                        break read;
                    }
                    const raw = chunk.convertRowValues(index, JSDuckDBValueConverter);
                    const json = anyExact ? chunk.convertRowValues(index, JsonDuckDBValueConverter) : undefined;
                    const row = raw.map((value, i) =>
                        value === null || !exact[i]
                            ? answerCell(value, types[i]!)
                            : exact[i] === 'decimal'
                              ? String(json![i])
                              : JSON.stringify(json![i]),
                    );
                    size += Buffer.byteLength(JSON.stringify(row)) + 1;
                    if (size > job.maxBytes) {
                        truncated = true;
                        break read;
                    }
                    rows.push(row);
                }
            }
            return { columns, rows, truncated, ms: Math.round(performance.now() - started) };
        } catch (error) {
            const text = message(error);
            if (/interrupt/i.test(text)) {
                throw new JobError(
                    `The query ran longer than ${Math.round(job.timeoutMs / 1000)} s and was stopped. Narrow it (WHERE on the partition column, LIMIT) or aggregate less.`,
                    504,
                );
            }
            if (/Permission Error|disabled by configuration/i.test(text)) {
                throw new JobError('Not allowed: an analytical query reads this dataset’s tables only.', 403);
            }
            throw new JobError(`The query failed: ${text.split('\n')[0]!.slice(0, 260)}`);
        } finally {
            clearTimeout(timer);
        }
    } finally {
        duck.close();
        rmSync(job.tempDir, { recursive: true, force: true });
    }
}

async function appendRows(connection: DuckDBConnection, table: string, types: string[], rows: unknown[][]) {
    if (!rows.length) {
        return;
    }
    const appender = await connection.createAppender(table, 'main', 'temp');
    try {
        for (const row of rows) {
            for (const [i, value] of row.entries()) {
                if (value === null || value === undefined) {
                    appender.appendNull();
                } else if (types[i] === 'BIGINT') {
                    appender.appendBigInt(typeof value === 'bigint' ? value : BigInt(value as number));
                } else if (types[i] === 'DOUBLE') {
                    appender.appendDouble(Number(value));
                } else if (types[i] === 'BLOB') {
                    appender.appendBlob(value as Uint8Array);
                } else {
                    appender.appendVarchar(
                        value instanceof Uint8Array ? Buffer.from(value).toString('base64') : String(value),
                    );
                }
            }
            appender.endRow();
        }
        appender.flushSync();
    } finally {
        appender.closeSync();
    }
}

// ── The channel ────────────────────────────────────────────────────────

async function run(job: WorkerJob) {
    switch (job.kind) {
        case 'stage':
            return stage(job);
        case 'query':
            return query(job);
        case 'ping':
            return { pid: process.pid };
    }
}

if (!process.send) {
    throw new Error('The datasets’ analytics process runs as a child of the app.');
}
process.on('message', (raw: { id?: number; job?: WorkerJob; shutdown?: boolean }) => {
    if (raw.shutdown) {
        process.exit(0);
    }
    const { id, job } = raw;
    if (typeof id !== 'number' || !job) {
        return;
    }
    run(job).then(
        (value) => process.send?.({ id, ok: true, value } satisfies WorkerReply),
        (error: unknown) =>
            process.send?.({
                id,
                ok: false,
                status: error instanceof JobError ? error.status : 500,
                error: message(error).slice(0, 400),
            } satisfies WorkerReply),
    );
});
// The app is gone: so is this process.
process.on('disconnect', () => process.exit(0));
