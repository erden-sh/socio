/**
 * The native view contract's version, stamps and row keys (CB-451).
 *
 * The server, the web client and Socio Mobile (CB-469) import these, so
 * every one of them reads a schema number, a stamp and a row key the
 * same way.
 */
import { canonicalJson } from '../jcs.js';

/**
 * The contract's schema version. Every answer carries it, and
 * every stored view definition carries the one it was saved under.
 *
 * - **Additive changes keep the number**: a new optional field, a new
 *   layout, field kind, operator or option value. Clients meet those as
 *   unknowns and fall back (`./fallback.ts`), never fail.
 * - **A removed field or a changed meaning bumps it**, and the server
 *   keeps answering the previous schema for at least two minor releases
 *   of Socio Mobile.
 */
export const DATASET_VIEWS_SCHEMA = 1;
export type DatasetViewsSchema = typeof DATASET_VIEWS_SCHEMA;

/**
 * The schema the server answers in, for a client that sent `?schema=`:
 * the highest both read. A client that sent none, or something that
 * isn't a schema number, gets the first schema, which every client
 * reads. A client newer than the server gets the server's.
 */
export function answerSchema(requested: unknown): number {
    const asked = typeof requested === 'string' && /^\d{1,4}$/.test(requested) ? Number(requested) : requested;
    if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1) {
        return 1;
    }
    return Math.min(asked, DATASET_VIEWS_SCHEMA);
}

// Stamps and sync tokens -----------------------------------------------------

/**
 * A generation id: the random id a dataset file gets when it is made and
 * again whenever its history is rewound or replaced (a restore, an import
 * over it). The server mints them (build step 3b); the contract only
 * fixes their alphabet, so a stamp splits at its one dot.
 */
export const STAMP_GENERATION = /^[A-Za-z0-9_-]{1,64}$/;
/** A stamp or sync token on the wire: `<generation>.<value>`, the value a decimal integer without leading zeros. */
export const STAMP = /^([A-Za-z0-9_-]{1,64})\.(0|[1-9]\d{0,15})$/;

/** A parsed stamp: which history the write belongs to, and its place in it. */
export interface Stamp {
    generation: string;
    value: number;
}

/**
 * A stamp or sync token as the wire carries it. A **stamp** names the
 * write that last changed a row, under the generation the file had at
 * that write; a **sync token** is the file's position when it was read.
 * Both have this one form.
 */
export function formatStamp(generation: string, value: number): string {
    if (!STAMP_GENERATION.test(generation)) {
        throw new RangeError(`Not a stamp generation: ${JSON.stringify(generation)}.`);
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`A stamp value is a whole number from 0: ${value}.`);
    }
    return `${generation}.${value}`;
}

/** A stamp or sync token, or undefined when `text` isn't one. */
export function parseStamp(text: unknown): Stamp | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const match = STAMP.exec(text);
    if (!match) {
        return undefined;
    }
    const value = Number(match[2]);
    return Number.isSafeInteger(value) ? { generation: match[1], value } : undefined;
}

export const isStamp = (text: unknown): text is string => parseStamp(text) !== undefined;

/**
 * Whether two row stamps name the same write, so the rows hold the same
 * values and a cached copy needs no refetch. A missing or
 * malformed stamp is never equal to anything, not even itself: a row
 * without a stamp is always fetched again.
 */
export function stampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = parseStamp(a);
    const y = parseStamp(b);
    return !!x && !!y && x.generation === y.generation && x.value === y.value;
}

// Row keys -------------------------------------------------------------------

/** A primary key value as a row key holds it. */
export type KeyValue = string | number | boolean | null;

/**
 * A row's key on the wire: its primary key as JCS JSON (RFC 8785, so the
 * server and every client spell it the same), the one value for a
 * single-column key and an array, in key column order, for a composite
 * one. A table without a primary key has only SQLite's `rowid`, written
 * `r:<rowid>`; JCS JSON never starts with `r`, so the two can't collide.
 */
export function rowKey(values: KeyValue | readonly KeyValue[]): string {
    if (Array.isArray(values)) {
        if (!values.length) {
            throw new RangeError('A row key needs at least one value.');
        }
        return values.length === 1 ? canonicalJson(values[0]) : canonicalJson(values);
    }
    return canonicalJson(values);
}

/** The key of a row of a table without a primary key. */
export function rowidKey(rowid: number): string {
    if (!Number.isSafeInteger(rowid)) {
        throw new RangeError(`Not a rowid: ${rowid}.`);
    }
    return `r:${rowid}`;
}

/**
 * A row key read back: the key value(s), or the rowid. Undefined for a
 * string that is neither (a client never builds keys; it only reads the
 * ones it was sent).
 */
export function parseRowKey(key: string): { values: KeyValue[] } | { rowid: number } | undefined {
    if (key.startsWith('r:')) {
        const rowid = Number(key.slice(2));
        return /^r:-?\d+$/.test(key) && Number.isSafeInteger(rowid) ? { rowid } : undefined;
    }
    try {
        const value: unknown = JSON.parse(key);
        const isKey = (v: unknown): v is KeyValue =>
            v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
        if (Array.isArray(value)) {
            return value.length > 1 && value.every(isKey) ? { values: value } : undefined;
        }
        return isKey(value) ? { values: [value] } : undefined;
    } catch {
        return undefined;
    }
}
