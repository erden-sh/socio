/**
 * Analytical tables' declarations (CB-369): what a table's columns may be, how
 * a row's partition is found, and where its Parquet parts live. Read by the app
 * (the catalog, the routes) and by the analytics process (staging, queries), so
 * both agree; no I/O here.
 */
import { join } from 'node:path';

import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import {
    ANALYTICAL_COLUMN_TYPES,
    ANALYTICAL_DECIMAL,
    ANALYTICAL_RETAIN_DAYS_MAX,
    type PartitionGrain,
} from '@socio/shared/dataspace/analytics';

/** The engine's hidden catalog tables in a dataset file. */
export const OLAP_PREFIX = '_olap_';
export const OLAP_TABLES = '_olap_tables';
export const OLAP_PARTS = '_olap_parts';
/**
 * Parts retention deleted, kept by append id only (CB-387): a retried
 * append still finds its id once its parts are gone, and adds nothing.
 */
export const OLAP_FORGOTTEN = '_olap_forgotten';
/** Where staged (not yet committed) parts are written, under the parts directory. */
export const STAGING_DIR = '_staging';
/** Partitions one append may touch (a backfill writes one file per partition). */
export const MAX_APPEND_PARTITIONS = 400;
/** Rows one `append-from` read transaction takes from the source table. */
export const APPEND_FROM_CHUNK = 10_000;

/** An analytical column: its name, type and whether it may be null. */
export interface AnalyticalColumn {
    name: string;
    type: string;
    notNull?: boolean;
}
/** An analytical table, as declared and as the catalog keeps it. */
export interface AnalyticalTable {
    name: string;
    /** Its stable id, used in paths. */
    id: string;
    columns: AnalyticalColumn[];
    partitionBy: { column: string; grain: PartitionGrain };
    /** Days its partitions are kept (CB-387); absent: kept until dropped. */
    retainDays?: number;
    /**
     * An admin's override of that (CB-387): days, or 0 to keep everything.
     * Absent: none. Kept apart from `retainDays`, which a plugin's manifest
     * sets on each update, so the override outlives updates until cleared.
     */
    retainOverride?: number;
}
/** One committed part, as the catalog lists it. */
export interface AnalyticalPart {
    id: string;
    tableId: string;
    partition: string;
    rows: number;
    bytes: number;
}
/** One part the analytics process staged: the app commits it. */
export interface StagedPart {
    id: string;
    partition: string;
    rows: number;
    bytes: number;
    min: number;
    max: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Ids the engine makes (table and part ids): lower-case hex and `-`. */
const ENGINE_ID = /^[a-f0-9-]{8,64}$/;
const DAY_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PARTITION = /^\d{4}-\d{2}$/;

/** Whether a name the catalog gives is the engine's own (never a path escape). */
export function engineId(id: string) {
    if (!ENGINE_ID.test(id)) {
        throw new DataError('The dataset’s analytical catalog is damaged.', 503);
    }
    return id;
}
export function partitionName(partition: string) {
    if (!DAY_PARTITION.test(partition) && !MONTH_PARTITION.test(partition)) {
        throw new DataError('The dataset’s analytical catalog is damaged.', 503);
    }
    return partition;
}

/** A column type an analytical table may declare, upper case. */
export function analyticalType(raw: string) {
    const type = raw.trim().toUpperCase().replace(/\s+/g, '');
    if ((ANALYTICAL_COLUMN_TYPES as readonly string[]).includes(type)) {
        return type;
    }
    const decimal = ANALYTICAL_DECIMAL.exec(type);
    if (decimal) {
        const precision = Number(decimal[1]);
        const scale = Number(decimal[2]);
        if (precision >= 1 && precision <= 38 && scale <= precision) {
            return `DECIMAL(${precision},${scale})`;
        }
    }
    throw new DataError(
        `"${raw.slice(0, 40)}" is not an analytical column type: use ${ANALYTICAL_COLUMN_TYPES.join(', ')} or DECIMAL(p,s).`,
    );
}

/** DuckDB's type for a declared one. */
export function duckType(type: string) {
    switch (type) {
        case 'TEXT':
        case 'JSON':
            return 'VARCHAR';
        case 'INTEGER':
            return 'BIGINT';
        case 'REAL':
            return 'DOUBLE';
        case 'BOOLEAN':
            return 'BOOLEAN';
        case 'DATE':
            return 'DATE';
        case 'TIMESTAMP':
            return 'TIMESTAMP';
        default:
            return type;
    }
}

const column = z
    .object({
        name: z.string().min(1).max(63),
        type: z.string().min(1).max(20),
        notNull: z.boolean().optional(),
    })
    .strict();
/** `POST …/tables` with `kind: analytical`. */
export const analyticalTableInput = z
    .object({
        table: z.string().min(1).max(63),
        kind: z.literal('analytical'),
        columns: z.array(column).min(1).max(100),
        partitionBy: z.object({ column: z.string().min(1).max(63), grain: z.enum(['day', 'month']) }).strict(),
        retainDays: z.number().int().min(1).max(ANALYTICAL_RETAIN_DAYS_MAX).optional(),
        ifNotExists: z.boolean().optional(),
    })
    .strict();
export type AnalyticalTableInput = z.input<typeof analyticalTableInput>;

/**
 * Checks a declaration: names, types, the partition column (a
 * NOT NULL DATE or TIMESTAMP), and no keys, uniques or defaults (the
 * schema refuses them as unknown fields). Returns it normalized.
 */
export function checkDeclaration(raw: unknown, reserved: (name: string) => void) {
    const input = analyticalTableInput.parse(raw);
    if (!IDENTIFIER.test(input.table) || /^sqlite_/i.test(input.table)) {
        throw new DataError(`Invalid table name "${input.table.slice(0, 80)}": use letters, digits and _.`);
    }
    reserved(input.table);
    const seen = new Set<string>();
    const columns = input.columns.map((item) => {
        if (!IDENTIFIER.test(item.name)) {
            throw new DataError(`Invalid column name "${item.name.slice(0, 80)}": use letters, digits and _.`);
        }
        if (item.name.startsWith('__')) {
            throw new DataError(`"${item.name}" is reserved: analytical column names can't start with __.`);
        }
        if (seen.has(item.name.toLowerCase())) {
            throw new DataError(`Column "${item.name}" is listed twice.`);
        }
        seen.add(item.name.toLowerCase());
        return { name: item.name, type: analyticalType(item.type), ...(item.notNull ? { notNull: true } : {}) };
    });
    const partition = columns.find((item) => item.name.toLowerCase() === input.partitionBy.column.toLowerCase());
    if (!partition || !['DATE', 'TIMESTAMP'].includes(partition.type) || !partition.notNull) {
        throw new DataError('partitionBy.column must be a NOT NULL DATE or TIMESTAMP column of the table.');
    }
    return {
        name: input.table,
        columns,
        partitionBy: { column: partition.name, grain: input.partitionBy.grain },
        ...(input.retainDays === undefined ? {} : { retainDays: input.retainDays }),
        ifNotExists: !!input.ifNotExists,
    };
}

/** Whether two declarations hold the same table (an `ifNotExists` that matches). */
export function sameDeclaration(a: Pick<AnalyticalTable, 'columns' | 'partitionBy' | 'retainDays'>, b: typeof a) {
    return (
        JSON.stringify(a.partitionBy) === JSON.stringify(b.partitionBy) &&
        (a.retainDays ?? null) === (b.retainDays ?? null) &&
        a.columns.length === b.columns.length &&
        a.columns.every(
            (item, i) =>
                item.name === b.columns[i]!.name &&
                item.type === b.columns[i]!.type &&
                !!item.notNull === !!b.columns[i]!.notNull,
        )
    );
}

/** What differs between two declarations, for a refusal that names it. */
export function declarationDifference(
    have: Pick<AnalyticalTable, 'columns' | 'partitionBy' | 'retainDays'>,
    want: typeof have,
) {
    if (JSON.stringify(have.partitionBy) !== JSON.stringify(want.partitionBy)) {
        return `it is partitioned by ${have.partitionBy.column} (${have.partitionBy.grain})`;
    }
    if ((have.retainDays ?? null) !== (want.retainDays ?? null)) {
        return have.retainDays ? `it keeps partitions ${have.retainDays} days` : 'it keeps partitions until dropped';
    }
    for (const [i, item] of want.columns.entries()) {
        const other = have.columns[i];
        if (!other || other.name !== item.name || other.type !== item.type || !!other.notNull !== !!item.notNull) {
            return other
                ? `its column ${i + 1} is ${other.name} ${other.type}${other.notNull ? ' NOT NULL' : ''}`
                : `it has no column ${item.name}`;
        }
    }
    return `it has ${have.columns.length} columns`;
}

const MS_DAY = 86_400_000;
/**
 * A partition value's ms (UTC) and its partition (`2026-11-10` or
 * `2026-11`), from a DATE (`YYYY-MM-DD`) or TIMESTAMP (an ISO string or
 * epoch ms) cell. Throws on anything else.
 */
export function partitionOf(value: number, grain: PartitionGrain) {
    const iso = new Date(value).toISOString();
    return grain === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}
/**
 * When a partition (`2026-11-10` or `2026-11`) ends, in ms (UTC): the
 * start of the next day or month. Retention retires a partition once it
 * ended before the cutoff.
 */
export function partitionEndMs(partition: string) {
    if (DAY_PARTITION.test(partition)) {
        return Date.parse(`${partition}T00:00:00Z`) + MS_DAY;
    }
    if (MONTH_PARTITION.test(partition)) {
        const [year, month] = partition.split('-').map(Number) as [number, number];
        return Date.UTC(year, month, 1);
    }
    return Number.NaN;
}
/** A DATE cell's ms (UTC midnight), or undefined when it isn't one. */
export function dateMs(value: unknown) {
    if (typeof value !== 'string' || !DAY_PARTITION.test(value)) {
        return undefined;
    }
    const ms = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined;
}
/** A TIMESTAMP cell's ms: epoch ms, or an ISO 8601 string with a date. */
export function timestampMs(value: unknown) {
    const inRange = (ms: number) => (ms >= MIN_TIMESTAMP_MS && ms <= MAX_TIMESTAMP_MS ? ms : undefined);
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? inRange(value) : undefined;
    }
    const parts =
        typeof value === 'string'
            ? /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/.exec(
                  value,
              )
            : null;
    if (typeof value !== 'string' || !parts) {
        return undefined;
    }
    // A real calendar day and clock time: Date.parse would roll 2026-02-30
    // over into March, moving the row and its partition.
    const [, day, hour = '0', minute = '0', second = '0', , zoneHour = '0', zoneMinute = '0'] = parts;
    if (
        dateMs(day) === undefined ||
        Number(hour) > 23 ||
        Number(minute) > 59 ||
        Number(second) > 59 ||
        Number(zoneHour) > 23 ||
        Number(zoneMinute) > 59
    ) {
        return undefined;
    }
    // A time without a zone is UTC, as DuckDB's TIMESTAMP is.
    const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value) || value.length === 10 ? value : `${value.replace(' ', 'T')}Z`;
    const ms = Date.parse(zoned.length === 10 ? `${zoned}T00:00:00Z` : zoned);
    return Number.isFinite(ms) ? inRange(ms) : undefined;
}
/** Timestamps run from year 1 to year 9999, UTC, as ISO 8601 writes them. */
const MIN_TIMESTAMP_MS = -62_135_596_800_000; // 0001-01-01T00:00:00.000Z
const MAX_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export { MS_DAY };

/** The dataset's parts directory, beside its file. */
export function partsDir(datasetPath: string) {
    return datasetPath.replace(/\.sqlite$/, '.parts');
}
/** Where a committed part lives. */
export function partPath(datasetPath: string, part: Pick<AnalyticalPart, 'id' | 'tableId' | 'partition'>) {
    return join(
        partsDir(datasetPath),
        engineId(part.tableId),
        partitionName(part.partition),
        `${engineId(part.id)}.parquet`,
    );
}
/** Where a part is staged before it is committed. */
export function stagedPath(datasetPath: string, partId: string) {
    return join(partsDir(datasetPath), STAGING_DIR, `${engineId(partId)}.parquet`);
}
