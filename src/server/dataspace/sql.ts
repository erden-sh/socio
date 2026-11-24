import { constants, type DatabaseSync } from 'node:sqlite';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { CellValue } from '@socio/shared/data-types';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** A table or column name: letters, digits and `_`, never SQLite's own. */
export function identifier(name: string, what = 'name') {
    if (!IDENTIFIER.test(name) || /^sqlite_/i.test(name)) {
        throw new DataError(
            `Invalid ${what} "${String(name).slice(0, 80)}": use letters, digits and _ (up to 63, starting with a letter or _).`,
        );
    }
    return `"${name}"`;
}

/**
 * Row history (engine.ts): the engine's own tables in
 * a dataset file, which are never the dataset's: `_history_<table>` per
 * table, `_writes` (who wrote, when) and `_writer` (the current write, and
 * `stampFloor`, the oldest row stamp a changes read still answers).
 */
export const HISTORY_PREFIX = '_history_';
export const WRITES_TABLE = '_writes';
export const WRITER_TABLE = '_writer';
/**
 * A deleted table (CB-229): renamed `_deleted_<unix ms>_<name>` in the same
 * file, kept and hidden.
 */
export const DELETED_PREFIX = '_deleted_';
/** The engine's row history triggers (`_keep_update_<table>`, `_keep_delete_<table>`). */
export const TRIGGER_PREFIX = '_keep_';
/**
 * The analytical catalog (CB-369): `_olap_tables` and `_olap_parts`,
 * the engine's own, hidden like row history.
 */
export const OLAP_PREFIX = '_olap_';
/**
 * Row stamps (CB-451): the file's durable sequence `_stamp_seq`, its
 * generations `_stamp_generations`, and `_stamps_<table>` per keyed
 * transactional table (its index `_stamp_by_<table>`), kept by the
 * `_keep_stamp_insert_`, `_update_` and `_delete_` triggers. Every name
 * starting with `_stamp` is the engine's.
 */
export const STAMP_PREFIX = '_stamp';
export const STAMP_SEQ_TABLE = '_stamp_seq';
export const STAMP_GENERATIONS_TABLE = '_stamp_generations';
export const STAMPS_PREFIX = '_stamps_';
/** Every write transaction takes the next stamp once, before its first change. */
export const STAMP_BUMP = `UPDATE ${STAMP_SEQ_TABLE} SET value = value + 1 WHERE id = 1`;

/** One of the engine's own tables (case-insensitive, as SQLite names are). */
export function hiddenTable(name: string) {
    const lower = name.toLowerCase();
    return (
        lower.startsWith(HISTORY_PREFIX) ||
        lower.startsWith(DELETED_PREFIX) ||
        lower.startsWith(OLAP_PREFIX) ||
        lower.startsWith(STAMP_PREFIX) ||
        lower === WRITES_TABLE ||
        lower === WRITER_TABLE
    );
}

/** Functions no statement may call: files, extensions, huge allocations. */
export const DENIED_FUNCTIONS = [
    'load_extension',
    'readfile',
    'writefile',
    'edit',
    'fts3_tokenizer',
    'zeroblob',
    'randomblob',
];
/** Table-valued functions a query may read besides the dataset's tables. */
export const READABLE_FUNCTIONS = ['json_each', 'json_tree'];
/** SQLite's own tables a query may read (the schema). */
export const READABLE_SYSTEM = ['sqlite_master', 'sqlite_schema'];
/**
 * SQLite's planner statistics (`ANALYZE`, CB-355): only the `analyze` and
 * `index` write modes touch them (ANALYZE fills them, DROP INDEX clears an
 * index's rows). Queries never read them as tables.
 */
export const STAT_TABLES = ['sqlite_stat1', 'sqlite_stat4'];
const statTable = (name: string) => STAT_TABLES.includes(name.toLowerCase());

/**
 * Splits off one statement (a trailing `;` is fine; anything after it but
 * whitespace and comments is refused) and its first keyword, upper case.
 * Quotes, brackets and comments are skipped so a `;` inside them doesn't
 * count.
 */
export function oneStatement(sql: string): { statement: string; keyword: string | undefined } {
    let i = 0;
    let end = -1;
    const n = sql.length;
    while (i < n) {
        const ch = sql[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            const close = ch;
            i++;
            while (i < n) {
                if (sql[i] === close) {
                    if (sql[i + 1] === close) {
                        i += 2;
                    } else {
                        break;
                    }
                } else {
                    i++;
                }
            }
            if (i >= n) {
                throw new DataError('The statement has an unclosed quote.');
            }
            i++;
        } else if (ch === '[') {
            const close = sql.indexOf(']', i + 1);
            if (close < 0) {
                throw new DataError('The statement has an unclosed [.');
            }
            i = close + 1;
        } else if (ch === '-' && sql[i + 1] === '-') {
            const close = sql.indexOf('\n', i + 2);
            i = close < 0 ? n : close + 1;
        } else if (ch === '/' && sql[i + 1] === '*') {
            const close = sql.indexOf('*/', i + 2);
            if (close < 0) {
                throw new DataError('The statement has an unclosed comment.');
            }
            i = close + 2;
        } else if (ch === ';') {
            end = i;
            break;
        } else {
            i++;
        }
    }
    const statement = end < 0 ? sql : sql.slice(0, end);
    if (end >= 0 && stripComments(sql.slice(end + 1)).replace(/[\s;]/g, '')) {
        throw new DataError('Send one statement at a time.');
    }
    const head = stripComments(statement).trimStart();
    return { statement, keyword: /^[A-Za-z]+/.exec(head)?.[0]?.toUpperCase() };
}

/**
 * Checks a `data_query` statement before it runs: exactly one statement
 * (a trailing `;` is fine), starting with SELECT, WITH or VALUES. VACUUM
 * and REINDEX never reach SQLite's authorizer, so this is the gate for
 * them; the authorizer and the read-only connection refuse the rest.
 * Returns the statement without its trailing `;`.
 */
export function singleQuery(sql: string) {
    const { statement, keyword } = oneStatement(sql);
    if (!keyword || !['SELECT', 'WITH', 'VALUES'].includes(keyword)) {
        throw new DataError(
            'Only read-only SELECT (or WITH … SELECT) statements run here. Socios change data with data_create_table, data_add_column, data_insert and data_upsert.',
        );
    }
    return statement;
}

function stripComments(text: string) {
    return text.replace(/--[^\n]*(\n|$)/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** A SQLite value as JSON: BigInts that fit become numbers, BLOBs base64. */
export function cell(value: unknown): CellValue {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'bigint') {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    if (value instanceof Uint8Array) {
        return { $blob: Buffer.from(value).toString('base64') };
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return value;
    }
    return String(value);
}

/** A JSON value bound as a statement parameter. */
export type ParamValue = string | number | boolean | null;
export function bindable(value: unknown, column?: string): string | number | null | Uint8Array {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new DataError(`${column ? `Column ${column}: ` : ''}numbers must be finite.`);
        }
        return value;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (
        typeof value === 'object' &&
        Object.keys(value).length === 1 &&
        typeof (value as { $blob?: unknown }).$blob === 'string'
    ) {
        return Buffer.from((value as { $blob: string }).$blob, 'base64');
    }
    // Objects and arrays are stored as JSON text (JSON columns).
    return JSON.stringify(value);
}

export type StatementMode = 'internal' | 'ddl' | 'dml' | 'index' | 'analyze';

/**
 * The write connection's authorizer: `internal` statements are the
 * engine's own (PRAGMA max_page_count, transactions, schema reads); `ddl`
 * may create tables and add columns (SQLite writes its schema table for
 * them); `dml` may insert and update the dataset's tables; `index` may
 * create and drop a declared secondary index (CB-355: never SQLite's own,
 * and SQLite writes its schema table for it); `analyze` may run ANALYZE
 * on a dataset table (CB-355), and SQLite creates and fills its statistics
 * tables for it. Everything else (ATTACH, PRAGMA, DELETE, DROP TABLE,
 * triggers, views, virtual tables, other databases) is refused.
 */
export function guardWrites(db: DatabaseSync) {
    let mode: StatementMode = 'internal';
    const C = constants;
    const denied = new Set(DENIED_FUNCTIONS);
    db.setAuthorizer((code, a, b, database) => {
        if (mode === 'internal') {
            return C.SQLITE_OK;
        }
        if (code === C.SQLITE_FUNCTION) {
            return denied.has(String(b).toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
        }
        if (database !== null && database !== 'main') {
            return C.SQLITE_DENY;
        }
        const table = String(a ?? '');
        const system = /^sqlite_/i.test(table);
        switch (code) {
            case C.SQLITE_SELECT:
                return C.SQLITE_OK;
            case C.SQLITE_READ:
                if (statTable(table)) {
                    return mode === 'analyze' || mode === 'index' ? C.SQLITE_OK : C.SQLITE_DENY;
                }
                return !system || READABLE_SYSTEM.includes(table.toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_INSERT:
            case C.SQLITE_UPDATE:
                if (system) {
                    return (mode === 'ddl' || mode === 'index' || mode === 'analyze') &&
                        READABLE_SYSTEM.includes(table.toLowerCase())
                        ? C.SQLITE_OK
                        : C.SQLITE_DENY;
                }
                return mode === 'dml' ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_DELETE:
                // Dropping an index deletes its row from the schema table, and
                // its statistics; ANALYZE replaces a table's statistics.
                if (statTable(table)) {
                    return mode === 'analyze' || mode === 'index' ? C.SQLITE_OK : C.SQLITE_DENY;
                }
                return mode === 'index' && READABLE_SYSTEM.includes(table.toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_CREATE_TABLE:
                // ANALYZE creates its statistics table the first time.
                if (mode === 'analyze') {
                    return statTable(table) ? C.SQLITE_OK : C.SQLITE_DENY;
                }
                return mode === 'ddl' && !system ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_ALTER_TABLE:
                return mode === 'ddl' && !system ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_ANALYZE:
                // One dataset table at a time: never SQLite's or the engine's own.
                return mode === 'analyze' && !!table && !system && !hiddenTable(table) ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_CREATE_INDEX:
                // DDL: only the automatic indexes of PRIMARY KEY and UNIQUE
                // columns. `index`: a declared one, on a dataset table.
                if (mode === 'ddl') {
                    return table.startsWith('sqlite_autoindex_') ? C.SQLITE_OK : C.SQLITE_DENY;
                }
                return mode === 'index' &&
                    !system &&
                    !/^sqlite_/i.test(String(b ?? '')) &&
                    !hiddenTable(String(b ?? ''))
                    ? C.SQLITE_OK
                    : C.SQLITE_DENY;
            case C.SQLITE_REINDEX:
                // CREATE INDEX fills the index it makes.
                return mode === 'index' && !system ? C.SQLITE_OK : C.SQLITE_DENY;
            case C.SQLITE_DROP_INDEX:
                return mode === 'index' &&
                    !system &&
                    !/^sqlite_/i.test(String(b ?? '')) &&
                    !hiddenTable(String(b ?? ''))
                    ? C.SQLITE_OK
                    : C.SQLITE_DENY;
            default:
                return C.SQLITE_DENY;
        }
    });
    return <T>(next: StatementMode, run: () => T): T => {
        const previous = mode;
        mode = next;
        try {
            return run();
        } finally {
            mode = previous;
        }
    };
}
