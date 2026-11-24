import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    rmSync,
    statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import {
    COLUMN_TYPES,
    type ColumnInfo,
    type IndexInfo,
    type QueryResult,
    type RowsPage,
    type TableInfo,
} from '@socio/shared/data-types';
import { VIEW_READ_LIMITS } from '@socio/shared/dataset-views/contract';
import { formatStamp, parseStamp } from '@socio/shared/dataset-views/schema';
import type { AnalyticalTableStats } from '@socio/shared/dataspace/analytics';
import { DEFAULT_DATA_LIMITS } from '@socio/shared/dataspace/limits';
import { csvRow } from '@socio/shared/text/csv';

import {
    OLAP_FORGOTTEN,
    OLAP_PARTS,
    OLAP_TABLES,
    checkDeclaration,
    declarationDifference,
    analyticalType,
    engineId,
    partPath,
    partitionEndMs,
    partitionName,
    partsDir,
    sameDeclaration,
    stagedPath,
    type AnalyticalColumn,
    type AnalyticalTable,
    type StagedPart,
} from './analytics/declare.js';
import type { BatchOutcome, BatchRun, QueryRunner } from './query-runner.js';
import {
    DELETED_PREFIX,
    HISTORY_PREFIX,
    STAMP_BUMP,
    STAMP_PREFIX,
    TRIGGER_PREFIX,
    WRITER_TABLE,
    WRITES_TABLE,
    bindable,
    cell,
    guardWrites,
    hiddenTable,
    identifier,
    oneStatement,
    singleQuery,
} from './sql.js';
import {
    dropStamps,
    ensureStamps,
    keyColumns,
    pruneTombstones,
    raiseFloorToNow,
    readChanges,
    restampLive,
    restartGeneration,
    stampedTables,
    stampState,
    stampsTable,
    syncStamps,
    type ChangesPage,
} from './stamps.js';

const PAGE_SIZE = 4096;
/** A cell as a view answer carries it: a blob never leaves the server. */
const viewCell = (value: unknown) => {
    const out = cell(value);
    return out !== null && typeof out === 'object' ? { $blob: true as const } : out;
};
/**
 * Engine-owned tables besides row history that name a `_writes` row, by
 * table and column: a history prune keeps those writes (CB-369).
 */
export const WRITE_REFERENCES: ReadonlyArray<readonly [string, string]> = [[OLAP_PARTS, 'write_id']];
export const MAX_TABLES = 100;
export const MAX_COLUMNS = 100;
/** Declared secondary indexes per table, and columns per index (CB-355). */
export const MAX_INDEXES = 10;
export const MAX_INDEX_COLUMNS = 8;

/**
 * Row history. Every table keeps the rows a write replaces or removes in
 * `_history_<table>`, written by the engine's own triggers in the same file and
 * transaction: the old values, `_rowid`, `_change` (`update` or `delete`),
 * `_writeId` and `_replacedAt`. Who wrote it is in `_writes` (id, actor: a user
 * id, `dot:<id>` or `system`, at), which a trigger fills from `_writer`, the
 * one-row note each write call leaves of its actor. None of these tables is a
 * dataset table: describe, listings, row pages, CSV, queries and SQLite exports
 * leave them out, and the quota counts only the rest of the file. Triggers are
 * named with their own prefix (`TRIGGER_PREFIX`), so no table's history name
 * meets them.
 */
/** `PRAGMA user_version` once a file has history (0: from before it). */
export const HISTORY_VERSION = 1;
/** History's own columns, ahead of the table's; reserved as column names. */
const HISTORY_COLUMNS = ['_rowid', '_writeId', '_replacedAt', '_change'];

/** Flushes a directory's entries to disk (a rename or a new entry in it). */
function syncDir(dir: string) {
    const fd = openSync(dir, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** A name quoted for SQL; engine-made names may run past `identifier`'s 63. */
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * A dataset file's bytes, split for the quota: `sizeBytes` counts (the
 * dataset's tables and the schema), `historyBytes` doesn't (row history,
 * the engine's own tables and free pages).
 */
export interface DatasetSizes {
    sizeBytes: number;
    historyBytes: number;
}
/** Who writes (for row history), and the file's sizes as last measured. */
export interface WriteOptions {
    /** A user id, `dot:<id>` or `system`: the actor kept with replaced rows. */
    writer?: string;
    /**
     * The sizes as last measured (the dataset's row): the cap gives history
     * this much room on top, and the write updates them in place, measuring
     * again only when it wrote history or changed the schema.
     */
    sizes?: DatasetSizes;
    /** The engine's own maintenance (a history prune): no measuring, no quota. */
    maintenance?: boolean;
}

/** What one history prune removed (`DatasetEngine.pruneHistory`). */
export interface HistoryPruneResult {
    /** Kept rows deleted: older than the cutoff, or of a table without history. */
    rows: number;
    /** `_writes` rows no kept row (or analytical part) names any more. */
    writes: number;
    /** Row stamps' tombstones older than `tombstonesBefore` (CB-451), when asked. */
    tombstones?: number;
}
/**
 * Write options for the engine's own maintenance (a prune): sizes it never
 * measures (`dbstat` reads every history page, once per chunk otherwise);
 * the caller measures once when it is done.
 */
const unmeasured = (): WriteOptions => ({ maintenance: true });
/** Rows one prune transaction deletes, so a writer never waits long. */
export const PRUNE_CHUNK = 5_000;
/** `_writes` rows younger than this are never pruned: a stopped batch's marker. */
const WRITES_KEEP_MS = 86_400_000;

/** One kept row, for the future admin view (`DataSpace.withHistoryRows`). */
export interface HistoryRow {
    rowid: number | null;
    change: 'update' | 'delete';
    writeId: number;
    replacedAt: number;
    /** Who made the write that replaced it: a user id, `dot:<id>` or `system`. */
    actor: string | null;
    /** The row as it was. */
    values: Record<string, unknown>;
}

const literal = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
export const columnInput = z
    .object({
        name: z.string().min(1).max(63),
        type: z.enum(COLUMN_TYPES).default('TEXT'),
        notNull: z.boolean().optional(),
        primaryKey: z.boolean().optional(),
        unique: z.boolean().optional(),
        default: literal.optional(),
    })
    .strict();
export type ColumnInput = z.input<typeof columnInput>;
export const createTableInput = z
    .object({
        table: z.string().min(1).max(63),
        columns: z.array(columnInput).min(1).max(MAX_COLUMNS),
        ifNotExists: z.boolean().optional(),
        /**
         * `false`: the table keeps no row history (CB-369 Phase H): no
         * `_history_<table>` triggers, for derived tables (marts, caches)
         * rebuilt from other tables. Absent or `true`: history, as before.
         */
        history: z.boolean().optional(),
    })
    .strict();
export type CreateTableInput = z.input<typeof createTableInput>;
const cellInput = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
]);
export const rowsInput = z.array(z.record(z.string(), cellInput)).min(1);
/**
 * A secondary index, declared (CB-355): a name, its table's columns in
 * order, and whether it is unique. The engine writes the statement.
 */
export const indexInput = z
    .object({
        name: z.string().min(1).max(63),
        columns: z.array(z.string().min(1).max(63)).min(1).max(MAX_INDEX_COLUMNS),
        unique: z.boolean().optional(),
        ifNotExists: z.boolean().optional(),
    })
    .strict();
export type IndexInput = z.input<typeof indexInput>;

/** A SQL literal for a column DEFAULT (DDL can't bind parameters). */
function sqlLiteral(value: string | number | boolean | null) {
    if (value === null) {
        return 'NULL';
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new DataError('Defaults must be finite.');
        }
        return String(value);
    }
    return `'${value.replaceAll("'", "''")}'`;
}

function columnSql(column: z.output<typeof columnInput>, inline: boolean) {
    const parts = [identifier(column.name, 'column name'), column.type];
    if (inline && column.primaryKey) {
        parts.push('PRIMARY KEY');
    }
    if (column.notNull) {
        parts.push('NOT NULL');
    }
    if (column.unique && !column.primaryKey) {
        parts.push('UNIQUE');
    }
    if (column.default !== undefined) {
        parts.push(`DEFAULT ${sqlLiteral(column.default)}`);
    }
    return parts.join(' ');
}

/** Names the engine keeps for itself (row history). */
function reservedTable(name: string) {
    if (hiddenTable(name)) {
        throw new DataError(
            `"${name}" is reserved: table names can't start with ${HISTORY_PREFIX}, ${DELETED_PREFIX} or ${STAMP_PREFIX}, or be ${WRITES_TABLE} or ${WRITER_TABLE}.`,
        );
    }
}
/** Index names can't look like the engine's own objects either. */
function reservedIndex(name: string) {
    if (hiddenTable(name) || name.toLowerCase().startsWith(TRIGGER_PREFIX)) {
        throw new DataError(
            `"${name}" is reserved: index names can't start with ${HISTORY_PREFIX}, ${DELETED_PREFIX}, ${STAMP_PREFIX} or ${TRIGGER_PREFIX}, or be ${WRITES_TABLE} or ${WRITER_TABLE}.`,
        );
    }
}
function reservedColumn(name: string) {
    if (HISTORY_COLUMNS.some((column) => column.toLowerCase() === name.toLowerCase())) {
        throw new DataError(`"${name}" is reserved: columns can't be named ${HISTORY_COLUMNS.join(', ')}.`);
    }
}

function friendly(error: unknown): never {
    if (error instanceof DataError) {
        throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/database or disk is full|SQLITE_FULL/i.test(message)) {
        throw new DataError('The dataset is full: it reached its size quota.', 413);
    }
    if (/not authorized/i.test(message)) {
        throw new DataError('Not allowed in a dataset.', 403);
    }
    throw new DataError(message.replace(/^SQLITE_[A-Z_]+:?\s*/, '').slice(0, 300));
}

/** A batch statement, as `DataSpace.batch` checked it (`DataBatchStatement`). */
export type BatchStatementInput =
    | { sql: string; params?: Array<string | number | boolean | null> }
    | { op: 'insert' | 'upsert'; table: string; rows: unknown; key?: readonly string[] };

const batchSql = z.string().min(1).max(20_000);
const batchParams = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100);

/**
 * One batch statement's runs (`QueryRunner.batch`). SQL is one statement
 * that changes rows: INSERT, REPLACE, UPDATE, WITH … (and DELETE when
 * `allowDelete`), never DDL, checked here and again by the batch's
 * authorizer, which has the last word. It may not name the engine's own
 * triggers. Rows become the same INSERT (or upsert) the single write route
 * runs, one run per row.
 */
export function batchRuns(
    statement: BatchStatementInput,
    limits: { allowDelete: boolean; insertMaxRows: number },
): BatchRun[] {
    if ('sql' in statement) {
        const sql = batchSql.parse(statement.sql);
        const params = batchParams.parse(statement.params ?? []);
        const { statement: text, keyword } = oneStatement(sql);
        const allowed = ['INSERT', 'REPLACE', 'UPDATE', 'WITH', ...(limits.allowDelete ? ['DELETE'] : [])];
        if (!keyword || !allowed.includes(keyword)) {
            throw new DataError(
                `A batch statement changes rows: ${allowed.join(', ')}${limits.allowDelete ? '' : ' (DELETE only in a plugin’s own datasets)'}. Tables, columns and indexes have their own routes.`,
            );
        }
        if (/_keep_/i.test(text)) {
            throw new DataError(`"${TRIGGER_PREFIX}" is reserved for the engine's own triggers.`);
        }
        return [{ sql: text, params: params.map((value) => (typeof value === 'boolean' ? +value : value)) }];
    }
    const table = identifier(statement.table, 'table name');
    reservedTable(statement.table);
    const rows = rowsInput.parse(statement.rows);
    if (rows.length > limits.insertMaxRows) {
        throw new DataError(`Send at most ${limits.insertMaxRows} rows per statement.`, 413);
    }
    const key = statement.op === 'upsert' ? (statement.key ?? []) : [];
    if (statement.op === 'upsert' && (!key.length || key.length > 8)) {
        throw new DataError('An upsert names 1 to 8 key columns.');
    }
    for (const name of key) {
        identifier(name, 'column name');
    }
    return rows.map((row) => {
        const names = Object.keys(row);
        if (!names.length) {
            throw new DataError('Rows need at least one column.');
        }
        let sql = `INSERT INTO ${table} (${names.map((name) => identifier(name, 'column name')).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
        if (key.length) {
            const updates = names.filter((name) => !key.includes(name));
            sql += ` ON CONFLICT (${key.map((name) => identifier(name)).join(', ')}) ${
                updates.length
                    ? `DO UPDATE SET ${updates.map((name) => `${identifier(name)} = excluded.${identifier(name)}`).join(', ')}`
                    : 'DO NOTHING'
            }`;
        }
        return { sql, params: names.map((name) => bindable(row[name], name)) };
    });
}

/**
 * A registered dataset whose file isn't on disk (CB-340: a volume move left
 * the files behind, and writes made empty ones in their place). Nothing is
 * read or written; the message doesn't show the server's path.
 */
export class DatasetFileMissingError extends DataError {
    readonly code = 'dataset_file_missing';
    constructor(readonly path: string) {
        super(
            "This dataset's file is missing on the server, so it can't be read or written. Ask an admin to restore it.",
            503,
        );
        this.name = 'DatasetFileMissingError';
    }
}

/**
 * One dataset file. Writes go through a short-lived connection in this
 * process: defensive mode, the write authorizer (`guardWrites`) and
 * `max_page_count` as the size cap, so SQLite itself refuses to grow the
 * file past its quota. Every statement is generated here from validated
 * names, with values bound. Queries (`query`) run in the QueryRunner's
 * processes on read-only connections. Files use the rollback journal, so a
 * dataset is always a single file (exports and backups copy one file).
 */
export class DatasetEngine {
    constructor(private runner: QueryRunner) {}
    create(path: string) {
        mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSync(path);
        try {
            db.exec(`PRAGMA page_size=${PAGE_SIZE}; PRAGMA journal_mode=DELETE; VACUUM;`);
        } finally {
            db.close();
        }
    }
    /**
     * Runs `work` holding the dataset file's SQLite EXCLUSIVE lock, the lock
     * every writer's transaction (`BEGIN IMMEDIATE`, here and in the query
     * runner's batches, on every runtime) needs: a write in flight finishes
     * first (up to `busyMs`, else this throws `SQLITE_BUSY`), and the next
     * one waits until `work` is done. While it is held no transaction is
     * open, so no journal is in use: moving the file (CB-451) or linking it
     * (a transfer) leaves no write half done. Changes nothing in the file.
     */
    whileLocked<T>(path: string, work: () => T, busyMs = 5000): T {
        this.existing(path);
        const db = new DatabaseSync(path, { allowExtension: false });
        try {
            db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyMs))}`);
            db.exec('BEGIN EXCLUSIVE');
            try {
                return work();
            } finally {
                db.exec('ROLLBACK');
            }
        } finally {
            db.close();
        }
    }
    /**
     * Throws `DatasetFileMissingError` when a dataset's file isn't there
     * (CB-340). Only `create` makes a file: reading or writing a registered
     * dataset never puts an empty one where its data should be.
     */
    existing(path: string) {
        if (!existsSync(path)) {
            throw new DatasetFileMissingError(path);
        }
    }
    size(path: string) {
        try {
            return statSync(path).size;
        } catch {
            return 0;
        }
    }
    /** The file's bytes split for the quota (`dbstat`); `hint`: as last measured. */
    sizes(path: string, hint?: DatasetSizes): DatasetSizes {
        if (!this.size(path)) {
            return { sizeBytes: 0, historyBytes: 0 };
        }
        return this.read(path, (db) => this.measure(db, hint));
    }
    remove(path: string) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            rmSync(`${path}${suffix}`, { force: true });
        }
        // Its analytical parts (CB-369) go with it.
        rmSync(partsDir(path), { recursive: true, force: true });
    }
    /**
     * One write call: a transaction on a short-lived connection, capped at
     * `maxBytes` of dataset tables. History has its own room: the cap is the
     * file's history bytes on top. A file from before row history gets it
     * first, in the same transaction. A row change names its `writer`.
     */
    private write<T>(
        path: string,
        maxBytes: number,
        work: (db: DatabaseSync, as: ReturnType<typeof guardWrites>) => T,
        options: WriteOptions = {},
    ): T {
        this.existing(path);
        const db = new DatabaseSync(path, { allowExtension: false });
        try {
            db.enableDefensive(true);
            const as = guardWrites(db);
            db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF;');
            db.exec('BEGIN IMMEDIATE');
            try {
                const installed = this.ensureHistory(db);
                // Row stamps (CB-451), lazily, as history: once per file, or a
                // restored file's new generation.
                const stamped = ensureStamps(db, () => this.tableNames(db));
                // The engine's own maintenance (a prune): it only frees room, so
                // it is never measured or held to a quota; the caller measures
                // once when it is done (CB-369).
                if (options.maintenance) {
                    const result = work(db, as);
                    db.exec('COMMIT');
                    return result;
                }
                const known = options.sizes;
                // The sizes passed in, unless the file looks over its room with
                // them (they may be stale: a write whose sizes weren't recorded).
                const history =
                    known && !installed && this.fileBytes(db) <= maxBytes + known.historyBytes
                        ? known.historyBytes
                        : this.measure(db, known).historyBytes;
                // SQLite's cap has room for this call's history too (`maxBytes` on
                // top); the dataset's tables are held to `maxBytes` after it, below.
                db.exec(`PRAGMA max_page_count=${Math.max(2, Math.floor((2 * maxBytes + history) / PAGE_SIZE))};`);
                if (options.writer !== undefined) {
                    db.prepare(
                        `UPDATE ${WRITER_TABLE} SET writeId=(SELECT coalesce(max(id), 0) + 1 FROM ${WRITES_TABLE}), actor=?, at=? WHERE id=1`,
                    ).run(options.writer, Date.now());
                }
                // Its stamp: the file's sequence, once, before its first change.
                db.exec(STAMP_BUMP);
                // A history row adds its write to `_writes`; DDL bumps the schema;
                // a write into free pages changes the free list (CB-369).
                const mark = () =>
                    JSON.stringify([
                        db.prepare(`SELECT max(id) AS id FROM ${WRITES_TABLE}`).get(),
                        db.prepare('PRAGMA schema_version').get(),
                        db.prepare('PRAGMA freelist_count').get(),
                    ]);
                const before = mark();
                const live = this.fileBytes(db) - history;
                const result = work(db, as);
                const measured = installed || stamped || mark() !== before;
                let after = measured
                    ? this.measure(db, known)
                    : {
                          sizeBytes: Math.max(0, this.fileBytes(db) - history),
                          historyBytes: history,
                      };
                // Unmeasured, a write's growth all counts as the dataset's, its
                // row stamps' pages too (CB-451): measured before it is refused.
                if (!measured && after.sizeBytes > maxBytes && after.sizeBytes > live) {
                    after = this.measure(db, known);
                }
                // A dataset already over (its quota was lowered) may still change
                // rows in place, as before: SQLite's cap never went below the file.
                if (after.sizeBytes > maxBytes && after.sizeBytes > live) {
                    throw new DataError('The dataset is full: it reached its size quota.', 413);
                }
                if (known) {
                    Object.assign(known, after);
                }
                db.exec('COMMIT');
                return result;
            } catch (error) {
                if (db.isTransaction) {
                    db.exec('ROLLBACK');
                }
                throw error;
            }
        } catch (error) {
            friendly(error);
        } finally {
            db.close();
        }
    }
    /** Gives a file from before row history its history (once: `user_version`). */
    private ensureHistory(db: DatabaseSync) {
        const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (version >= HISTORY_VERSION) {
            return false;
        }
        db.exec(
            `CREATE TABLE IF NOT EXISTS ${WRITES_TABLE} (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ${WRITER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), writeId INTEGER, actor TEXT, at INTEGER);
      INSERT OR IGNORE INTO ${WRITER_TABLE} (id) VALUES (1);`,
        );
        for (const table of this.tableNames(db)) {
            this.syncHistory(db, table);
        }
        db.exec(`PRAGMA user_version=${HISTORY_VERSION}`);
        return true;
    }
    /**
     * Makes `_history_<table>` match the table (its columns, in order, with
     * their types and no constraints) and (re)creates the table's triggers.
     * The update trigger skips a row whose values didn't change (an upsert
     * of the same values keeps nothing).
     */
    private syncHistory(db: DatabaseSync, table: string) {
        const columns = this.columnsOf(db, table);
        const history = `${HISTORY_PREFIX}${table}`;
        const kept = new Set(
            (
                db.prepare(`PRAGMA table_info(${quoted(history)})`).all() as Array<{
                    name: string;
                }>
            ).map((column) => column.name.toLowerCase()),
        );
        const typed = (column: ColumnInfo) => `${quoted(column.name)}${column.type ? ` ${column.type}` : ''}`;
        if (!kept.size) {
            db.exec(
                `CREATE TABLE ${quoted(history)} ("_rowid" INTEGER, "_writeId" INTEGER, "_replacedAt" INTEGER, "_change" TEXT${columns.map((column) => `, ${typed(column)}`).join('')})`,
            );
        } else {
            for (const column of columns) {
                if (!kept.has(column.name.toLowerCase())) {
                    db.exec(`ALTER TABLE ${quoted(history)} ADD COLUMN ${typed(column)}`);
                }
            }
        }
        const withoutRowid = (
            db.prepare('SELECT wr FROM pragma_table_list WHERE schema=? AND name=?').get('main', table) as
                | { wr: number }
                | undefined
        )?.wr;
        const names = columns.map((column) => quoted(column.name));
        const keep = (change: 'update' | 'delete') =>
            `INSERT INTO ${WRITES_TABLE} (id, actor, at) SELECT writeId, coalesce(actor, 'system'), coalesce(at, 0) FROM ${WRITER_TABLE} w WHERE writeId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${WRITES_TABLE} WHERE id = w.writeId);
        INSERT INTO ${quoted(history)} ("_rowid", "_writeId", "_replacedAt", "_change", ${names.join(', ')}) SELECT ${withoutRowid ? 'NULL' : 'old.rowid'}, writeId, at, '${change}', ${names.map((name) => `old.${name}`).join(', ')} FROM ${WRITER_TABLE};`;
        const update = quoted(`${TRIGGER_PREFIX}update_${table}`);
        const remove = quoted(`${TRIGGER_PREFIX}delete_${table}`);
        db.exec(
            `DROP TRIGGER IF EXISTS ${update}; DROP TRIGGER IF EXISTS ${remove};
      CREATE TRIGGER ${update} AFTER UPDATE ON ${quoted(table)} WHEN ${names.map((name) => `old.${name} IS NOT new.${name}`).join(' OR ')} BEGIN ${keep('update')} END;
      CREATE TRIGGER ${remove} AFTER DELETE ON ${quoted(table)} BEGIN ${keep('delete')} END;`,
        );
    }
    /**
     * Whether a table keeps row history now: its delete trigger is there
     * (CB-369). A table made with `history: false`, or switched off, has
     * none; its `_history_<table>` may still hold rows until a prune.
     */
    private keepsHistory(db: DatabaseSync, table: string) {
        return !!db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
            .get(`${TRIGGER_PREFIX}delete_${table}`);
    }
    /**
     * The name SQLite's row id answers to in a table: `rowid`, `_rowid_` or
     * `oid`, whichever no column takes (a column may be called `rowid`);
     * none when all three are taken.
     */
    private rowIdName(db: DatabaseSync, table: string) {
        const taken = new Set(
            (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>).map((column) =>
                column.name.toLowerCase(),
            ),
        );
        return ['rowid', '_rowid_', 'oid'].find((name) => !taken.has(name));
    }
    /** Drops a table's history triggers; what it kept stays until a prune. */
    private dropHistoryTriggers(db: DatabaseSync, table: string) {
        db.exec(
            `DROP TRIGGER IF EXISTS ${quoted(`${TRIGGER_PREFIX}update_${table}`)}; DROP TRIGGER IF EXISTS ${quoted(`${TRIGGER_PREFIX}delete_${table}`)};`,
        );
    }
    /** The engine's own tables in this file. */
    private hiddenNames(db: DatabaseSync): string[] {
        return db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name")
            .all()
            .map((row) => String(row.name))
            .filter(hiddenTable);
    }
    private fileBytes(db: DatabaseSync) {
        const { page_count: pages } = db.prepare('PRAGMA page_count').get() as {
            page_count: number;
        };
        return pages * PAGE_SIZE;
    }
    /**
     * Splits the file with `dbstat`, which reads every page of the b-trees it
     * is asked about: so it reads the smaller side, by `hint` (the sizes last
     * measured). History is its tables' pages, plus the text its tables and
     * triggers add to the schema, plus the free pages (CB-369: what a prune
     * freed never counts); the rest of the file counts.
     */
    private measure(db: DatabaseSync, hint?: DatasetSizes): DatasetSizes {
        const fileBytes = this.fileBytes(db);
        const sum = (names: string[]) =>
            Number(
                (
                    db
                        .prepare(
                            `SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat WHERE aggregate=TRUE AND name IN (${names.map(() => '?').join(', ')})`,
                        )
                        .get(...names) as { bytes: number }
                ).bytes,
            );
        const schema = Number(
            (
                db
                    .prepare(
                        `SELECT coalesce(sum(length(sql)), 0) AS bytes FROM sqlite_master WHERE (type='trigger' AND name GLOB '${TRIGGER_PREFIX}*') OR (type='table' AND (lower(name) GLOB '${HISTORY_PREFIX}*' OR lower(name) GLOB '${DELETED_PREFIX}*' OR lower(name) GLOB '${STAMP_PREFIX}*' OR lower(name) IN ('${WRITES_TABLE}', '${WRITER_TABLE}')))`,
                    )
                    .get() as { bytes: number }
            ).bytes,
        );
        const trees = db
            .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') AND rootpage > 0")
            .all();
        const { freelist_count: free } = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
        let tables: number;
        if (!hint || hint.historyBytes <= hint.sizeBytes) {
            tables = sum(trees.filter((row) => hiddenTable(String(row.tbl_name))).map((row) => String(row.name)));
        } else {
            const live = trees.filter((row) => !hiddenTable(String(row.tbl_name))).map((row) => String(row.name));
            tables = fileBytes - free * PAGE_SIZE - sum(['sqlite_schema', ...live]);
        }
        // Free pages (mostly what a history prune freed, CB-369) count with
        // history, outside the quota: pruning never fills a person's data,
        // and a write that reuses them is measured again (`write`).
        const historyBytes = Math.min(fileBytes, Math.max(0, tables + schema + free * PAGE_SIZE));
        return { sizeBytes: fileBytes - historyBytes, historyBytes };
    }
    private read<T>(path: string, work: (db: DatabaseSync) => T): T {
        this.existing(path);
        const db = new DatabaseSync(path, {
            readOnly: true,
            allowExtension: false,
        });
        try {
            db.enableDefensive(true);
            return work(db);
        } catch (error) {
            friendly(error);
        } finally {
            db.close();
        }
    }
    private columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
        return (
            db.prepare(`PRAGMA table_info(${identifier(table, 'table name')})`).all() as Array<{
                name: string;
                type: string;
                notnull: number;
                pk: number;
                dflt_value: string | null;
            }>
        ).map((column) => ({
            name: column.name,
            type: column.type,
            notNull: !!column.notnull,
            primaryKey: column.pk > 0,
            defaultValue: column.dflt_value,
        }));
    }
    /** The dataset's tables: never SQLite's own or the engine's (history). */
    private tableNames(db: DatabaseSync): string[] {
        return db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name")
            .all()
            .map((row) => String(row.name))
            .filter((name) => !hiddenTable(name));
    }
    /**
     * A table's declared secondary indexes (CB-355), by name: those made by
     * CREATE INDEX (`origin` c), never the automatic ones of its PRIMARY KEY
     * and UNIQUE columns.
     */
    private indexesOf(db: DatabaseSync, table: string): IndexInfo[] {
        const list = db.prepare(`PRAGMA index_list(${quoted(table)})`).all() as Array<{
            name: string;
            unique: number;
            origin: string;
            partial: number;
        }>;
        return list
            .filter((index) => index.origin === 'c')
            .map((index) => ({
                name: index.name,
                columns: (
                    db.prepare(`PRAGMA index_info(${quoted(index.name)})`).all() as Array<{
                        seqno: number;
                        name: string | null;
                    }>
                )
                    .sort((a, b) => a.seqno - b.seqno)
                    .map((column) => String(column.name)),
                unique: !!index.unique,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    tables(path: string): TableInfo[] {
        return this.read(path, (db) =>
            this.tableNames(db).map((name) => ({
                name,
                columns: this.columnsOf(db, name),
                rowCount: Number(
                    (db.prepare(`SELECT count(*) AS n FROM ${identifier(name)}`).get() as { n: number }).n,
                ),
                indexes: this.indexesOf(db, name),
                history: this.keepsHistory(db, name),
            })),
        );
    }
    /** Its tables of both kinds, as the Data page counts them. */
    tableCount(path: string) {
        return this.read(path, (db) => this.tableNames(db).length + this.catalogNames(db).length);
    }
    private requireTable(db: DatabaseSync, table: string) {
        identifier(table, 'table name');
        if (!this.tableNames(db).includes(table)) {
            throw new DataError(`No table "${table}" in this dataset. Create it with data_create_table.`, 404);
        }
        return this.columnsOf(db, table);
    }
    /** A new table's declaration, checked without a file (CB-387: a manifest's, before any change). */
    checkCreateTable(raw: CreateTableInput) {
        const input = createTableInput.parse(raw);
        const table = identifier(input.table, 'table name');
        reservedTable(input.table);
        const names = new Set<string>();
        for (const column of input.columns) {
            identifier(column.name, 'column name');
            reservedColumn(column.name);
            if (names.has(column.name.toLowerCase())) {
                throw new DataError(`Column "${column.name}" is listed twice.`);
            }
            names.add(column.name.toLowerCase());
        }
        return { input, table };
    }
    createTable(path: string, raw: CreateTableInput, maxBytes: number, options: WriteOptions = {}) {
        const { input, table } = this.checkCreateTable(raw);
        const keys = input.columns.filter((column) => column.primaryKey);
        const inline = keys.length === 1;
        const sql = `CREATE TABLE ${input.ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (${[
            ...input.columns.map((column) => columnSql(column, inline)),
            ...(keys.length > 1 ? [`PRIMARY KEY (${keys.map((column) => identifier(column.name)).join(', ')})`] : []),
        ].join(', ')})`;
        return this.write(
            path,
            maxBytes,
            (db, as) => {
                const existing = this.tableNames(db);
                const analytical = this.catalogNames(db);
                if (analytical.some((name) => name.toLowerCase() === input.table.toLowerCase())) {
                    throw new DataError(`"${input.table}" is an analytical table in this dataset.`, 409);
                }
                if (existing.length + analytical.length >= MAX_TABLES && !existing.includes(input.table)) {
                    throw new DataError(`A dataset holds at most ${MAX_TABLES} tables.`, 413);
                }
                if (existing.includes(input.table)) {
                    if (input.ifNotExists) {
                        return { created: false, table: input.table };
                    }
                    throw new DataError(
                        `Table "${input.table}" exists already. Use data_add_column to change it.`,
                        409,
                    );
                }
                if (existing.length >= MAX_TABLES) {
                    throw new DataError(`A dataset holds at most ${MAX_TABLES} tables.`, 413);
                }
                as('ddl', () => db.prepare(sql).run());
                if (input.history !== false) {
                    this.syncHistory(db, input.table);
                }
                // Row stamps whatever its history (CB-451): a table with a primary key.
                syncStamps(db, input.table);
                return { created: true, table: input.table, ...(input.history === false ? { history: false } : {}) };
            },
            options,
        );
    }
    /**
     * A column to add, checked without a file (CB-387: a manifest's,
     * before any change); `columns`: how many the table will have before it.
     */
    checkAddColumn(raw: ColumnInput, columns = 0) {
        const column = columnInput.parse(raw);
        identifier(column.name, 'column name');
        reservedColumn(column.name);
        if (column.primaryKey || column.unique) {
            throw new DataError('Added columns can’t be PRIMARY KEY or UNIQUE.');
        }
        if (column.notNull && (column.default === undefined || column.default === null)) {
            throw new DataError('A NOT NULL column needs a default when it is added.');
        }
        if (columns >= MAX_COLUMNS) {
            throw new DataError(`A table holds at most ${MAX_COLUMNS} columns.`, 413);
        }
        return column;
    }
    addColumn(path: string, table: string, raw: ColumnInput, maxBytes: number, options: WriteOptions = {}) {
        const column = this.checkAddColumn(raw);
        return this.write(
            path,
            maxBytes,
            (db, as) => {
                const columns = this.requireTable(db, table);
                if (columns.some((existing) => existing.name.toLowerCase() === column.name.toLowerCase())) {
                    throw new DataError(`Column "${column.name}" exists already.`, 409);
                }
                if (columns.length >= MAX_COLUMNS) {
                    throw new DataError(`A table holds at most ${MAX_COLUMNS} columns.`, 413);
                }
                // A table without history stays without it; switching it on
                // later gives its history every column then.
                const keeps = this.keepsHistory(db, table);
                as('ddl', () =>
                    db.prepare(`ALTER TABLE ${identifier(table)} ADD COLUMN ${columnSql(column, false)}`).run(),
                );
                if (keeps) {
                    this.syncHistory(db, table);
                }
                // Its stamps' update trigger names every column, and every row
                // gained one: each takes this write's stamp.
                if (syncStamps(db, table)) {
                    restampLive(db, table);
                }
                return { table, column: column.name };
            },
            options,
        );
    }
    /**
     * Switches a table's row history on or off (CB-369 Phase H). Off drops
     * its triggers: nothing it replaces from then on is kept, and the rows
     * it kept go at the next prune (`pruneHistory`). On (again) installs
     * them, with history from that moment. `changed`: whether it was the
     * other way before.
     */
    setHistory(path: string, table: string, on: boolean, options: WriteOptions = {}) {
        return this.write(
            path,
            2 ** 40,
            (db) => {
                this.requireTable(db, table);
                const before = this.keepsHistory(db, table);
                if (on && !before) {
                    this.syncHistory(db, table);
                } else if (!on && before) {
                    this.dropHistoryTriggers(db, table);
                }
                return { table, history: on, changed: before !== on };
            },
            options,
        );
    }
    /**
     * Deletes kept rows (CB-369 Phase H): every row a live table without
     * history still keeps, and, with `before` (ms), every kept row replaced
     * before it, deleted tables' too. Then the `_writes` rows nothing names
     * any more (no kept row, no analytical part, older than a day so a
     * stopped batch's marker stays readable). In transactions of at most
     * `PRUNE_CHUNK` rows each, yielding between them, so writers and the
     * event loop wait for one chunk at most. The freed pages stay in the
     * file for later history; `vacuum` gives them back.
     */
    async pruneHistory(
        path: string,
        before: number | null,
        options: { chunk?: number; now?: number; tombstonesBefore?: number } = {},
    ): Promise<HistoryPruneResult> {
        const chunk = options.chunk ?? PRUNE_CHUNK;
        const now = options.now ?? Date.now();
        const tombstones =
            options.tombstonesBefore === undefined
                ? {}
                : { tombstones: await this.pruneTombstones(path, options.tombstonesBefore, chunk) };
        // Each history table is read a page of `chunk` rows at a time, by
        // SQLite's row id (history has no index on its time, so a filter on
        // it would scan the whole table at once), yielding between pages; a
        // page with rows to drop gets a transaction of its own. The cutoff is
        // decided again in each one, so a table whose history is switched
        // back on meanwhile loses only what `before` allows.
        const tables = this.read(path, (db) =>
            this.hiddenNames(db).filter((name) => name.toLowerCase().startsWith(HISTORY_PREFIX)),
        );
        const cutoffOf = (db: DatabaseSync, name: string) => {
            const base = name.slice(HISTORY_PREFIX.length);
            // A live table without history keeps nothing at all.
            return this.tableNames(db).includes(base) && !this.keepsHistory(db, base)
                ? Number.MAX_SAFE_INTEGER
                : before;
        };
        let rows = 0;
        for (const name of tables) {
            let after = Number.MIN_SAFE_INTEGER;
            for (;;) {
                const page = this.read(path, (db) => {
                    if (!this.hiddenNames(db).includes(name)) {
                        return undefined;
                    }
                    const cutoff = cutoffOf(db, name);
                    const id = this.rowIdName(db, name);
                    if (cutoff === null || !id) {
                        return { cutoff, id, seen: [] as Array<{ r: number; old: number }> };
                    }
                    const seen = db
                        .prepare(
                            `SELECT ${id} AS r, coalesce("_replacedAt", 0) < ? AS old FROM ${quoted(name)} WHERE ${id} > ? ORDER BY ${id} LIMIT ?`,
                        )
                        .all(cutoff, after, chunk) as Array<{ r: number; old: number }>;
                    return { cutoff, id, seen };
                });
                if (!page || page.cutoff === null) {
                    break;
                }
                const drop = page.seen.filter((row) => row.old).map((row) => Number(row.r));
                if (drop.length || !page.id) {
                    rows += this.write(
                        path,
                        2 ** 40,
                        (db) => {
                            if (!this.hiddenNames(db).includes(name)) {
                                return 0;
                            }
                            const cutoff = cutoffOf(db, name);
                            if (cutoff === null) {
                                return 0;
                            }
                            // No name reaches the row id (every one is a column): all at once.
                            if (!page.id) {
                                return Number(
                                    db
                                        .prepare(`DELETE FROM ${quoted(name)} WHERE coalesce("_replacedAt", 0) < ?`)
                                        .run(cutoff).changes,
                                );
                            }
                            return Number(
                                db
                                    .prepare(
                                        `DELETE FROM ${quoted(name)} WHERE ${page.id} IN (SELECT value FROM json_each(?)) AND coalesce("_replacedAt", 0) < ?`,
                                    )
                                    .run(JSON.stringify(drop), cutoff).changes,
                            );
                        },
                        unmeasured(),
                    );
                }
                if (!page.id || page.seen.length < chunk) {
                    break;
                }
                after = Number(page.seen.at(-1)!.r);
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        // `_writes` rows nothing names any more, whether or not history was
        // pruned (a batch leaves a marker even in a dataset without history),
        // and older than a day. The ids kept rows (and analytical parts) name
        // are read a page at a time, table by table; then candidates are
        // deleted in transactions of `chunk`. A write made meanwhile names a
        // new id, never an old candidate, so the ids read stay right.
        const cutoff = now - WRITES_KEEP_MS;
        const named = new Set<number>();
        // The schema as the ids are read: a table deleted (its history
        // renamed) or made meanwhile would hide ids still named, so then the
        // cleanup stops, to run again at the next prune.
        const schemaOf = (db: DatabaseSync) =>
            Number((db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version);
        let schema = 0;
        const sources = this.read(path, (db) => {
            const hidden = this.hiddenNames(db);
            if (!hidden.includes(WRITES_TABLE)) {
                return undefined;
            }
            schema = schemaOf(db);
            return [
                ...hidden
                    .filter((name) => name.toLowerCase().startsWith(HISTORY_PREFIX))
                    .map((name) => [name, '_writeId'] as const),
                ...WRITE_REFERENCES.filter(([table]) => hidden.includes(table)),
            ];
        });
        if (!sources) {
            return { rows, writes: 0, ...tombstones };
        }
        // Passes of at most `chunk` rows, across as many tables as fit, each
        // one short read, yielding between them.
        let source = 0;
        let from = Number.MIN_SAFE_INTEGER;
        let changed = false;
        while (source < sources.length && !changed) {
            this.read(path, (db) => {
                if (schemaOf(db) !== schema) {
                    changed = true;
                    return;
                }
                let budget = chunk;
                while (budget > 0 && source < sources.length) {
                    const [table, column] = sources[source]!;
                    const id = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
                        ? this.rowIdName(db, table)
                        : null;
                    if (id === null) {
                        source++;
                        from = Number.MIN_SAFE_INTEGER;
                        continue;
                    }
                    const asked = budget;
                    const page = id
                        ? (db
                              .prepare(
                                  `SELECT ${id} AS r, ${quoted(column)} AS w FROM ${quoted(table)} WHERE ${id} > ? ORDER BY ${id} LIMIT ?`,
                              )
                              .all(from, asked) as Array<{ r: number; w: number | null }>)
                        : (db.prepare(`SELECT DISTINCT ${quoted(column)} AS w FROM ${quoted(table)}`).all() as Array<{
                              w: number | null;
                          }>);
                    for (const row of page) {
                        if (row.w !== null) {
                            named.add(Number(row.w));
                        }
                    }
                    budget -= Math.max(1, page.length);
                    if (!id || page.length < asked) {
                        // Read to its end.
                        source++;
                        from = Number.MIN_SAFE_INTEGER;
                    } else {
                        from = Number((page as unknown as Array<{ r: number }>).at(-1)!.r);
                    }
                }
            });
            if (source < sources.length) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        let writes = 0;
        let after = Number.MIN_SAFE_INTEGER;
        while (!changed) {
            // A page of `_writes` by id, filtered here: a filter on its time
            // would scan every recent row at once.
            const page = this.read(path, (db) => {
                const current = (
                    db.prepare(`SELECT writeId FROM ${WRITER_TABLE} WHERE id=1`).get() as
                        | { writeId: number | null }
                        | undefined
                )?.writeId;
                return {
                    current: current === null || current === undefined ? undefined : Number(current),
                    rows: db
                        .prepare(`SELECT id, at FROM ${WRITES_TABLE} WHERE id > ? ORDER BY id LIMIT ?`)
                        .all(after, chunk)
                        .map((row) => ({ id: Number(row.id), at: Number(row.at) })),
                };
            });
            const candidates = page.rows.map((row) => row.id);
            const orphans = page.rows
                .filter((row) => row.at < cutoff && row.id !== page.current && !named.has(row.id))
                .map((row) => row.id);
            if (orphans.length) {
                writes += this.write(
                    path,
                    2 ** 40,
                    (db) => {
                        if (schemaOf(db) !== schema) {
                            changed = true;
                            return 0;
                        }
                        return Number(
                            db
                                .prepare(
                                    `DELETE FROM ${WRITES_TABLE} WHERE at < ? AND id IN (SELECT value FROM json_each(?))`,
                                )
                                .run(cutoff, JSON.stringify(orphans)).changes,
                        );
                    },
                    unmeasured(),
                );
            }
            if (candidates.length < chunk) {
                break;
            }
            after = candidates.at(-1)!;
            await new Promise((resolve) => setImmediate(resolve));
        }
        return { rows, writes, ...tombstones };
    }
    /**
     * Deletes row stamps' tombstones (CB-451) deleted before `before` (ms),
     * table by table, `chunk` at a time, yielding between: each raises the
     * floor past what it removed, so a changes read from before then
     * reconciles instead of missing a deletion.
     */
    private async pruneTombstones(path: string, before: number, chunk: number) {
        const tables = this.read(path, (db) => stampedTables(db));
        let removed = 0;
        for (const table of tables) {
            for (;;) {
                const n = this.write(
                    path,
                    2 ** 40,
                    (db) =>
                        this.hiddenNames(db).includes(stampsTable(table))
                            ? pruneTombstones(db, table, before, chunk)
                            : 0,
                    unmeasured(),
                );
                removed += n;
                if (n < chunk) {
                    break;
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        return removed;
    }
    /**
     * The file's sync token, `<generation>.<value>` (CB-451): what
     * a read was read at, and the next changes read's `since`.
     */
    stampToken(path: string): string {
        this.prepareStamps(path);
        return this.read(path, (db) => {
            const state = stampState(db)!;
            return formatStamp(state.generation, state.value);
        });
    }
    /** Gives a file its stamps (or a restored file its generation) before a read needs them. */
    private prepareStamps(path: string) {
        if (!this.read(path, (db) => stampState(db))) {
            this.write(path, 2 ** 40, () => undefined, unmeasured());
        }
    }
    /**
     * A table's rows changed after `since`, a sync token (CB-451,
     * `GET …/tables/:table/changes`): one page of at most `limit`, in stamp
     * order, with `next` to go on from. `reconcile` when `since` is of
     * another generation (a restore) or below the floor; `resync` for a
     * table without stamps (no primary key, or analytical). State and rows
     * are read in one transaction, so the token is the rows' own.
     */
    changes(
        path: string,
        table: string,
        since: string,
        options: { cursor?: string; limit?: number } = {},
    ): ChangesPage {
        if (!parseStamp(since)) {
            throw new DataError('since is not a sync token (<generation>.<value>, as a read answered it).');
        }
        const limit = Math.max(
            1,
            Math.min(options.limit ?? VIEW_READ_LIMITS.changesRows, VIEW_READ_LIMITS.changesRows),
        );
        this.prepareStamps(path);
        return this.read(path, (db) => {
            db.exec('BEGIN');
            try {
                const state = stampState(db);
                if (!state) {
                    throw new DataError("This dataset's row stamps aren't ready; try again.", 503);
                }
                const resync = (): ChangesPage => ({
                    token: formatStamp(state.generation, state.value),
                    resync: true,
                    upserts: [],
                    deleted: [],
                    next: null,
                });
                if (this.catalogNames(db).some((name) => name.toLowerCase() === table.toLowerCase())) {
                    return resync();
                }
                this.requireTable(db, table);
                if (!keyColumns(db, table).length || !this.hiddenNames(db).includes(stampsTable(table))) {
                    return resync();
                }
                const page = readChanges(db, table, state, since, options.cursor, limit, viewCell);
                if (page === 'bad-since') {
                    throw new DataError('since is not a sync token (<generation>.<value>, as a read answered it).');
                }
                if (page === 'bad-cursor') {
                    throw new DataError('cursor is not one this changes read answered; send its next as it was.');
                }
                return page;
            } finally {
                db.exec('COMMIT');
            }
        });
    }
    /**
     * Rewrites the file without its free pages (SQLite `VACUUM`, CB-369
     * Phase H's Compact file), in the query runner's process so the app
     * doesn't wait on it; past `timeoutMs` that process is killed and the
     * file rolls back as it was. Its sizes after.
     */
    async vacuum(path: string, timeoutMs: number): Promise<DatasetSizes> {
        this.write(path, 2 ** 40, () => undefined, unmeasured());
        return this.runner.vacuum({ path }, timeoutMs, () => {
            this.recover(path);
            return false;
        });
    }
    /**
     * Declares a secondary index on a table (CB-355): its columns must be
     * the table's, at most `MAX_INDEXES` per table, and no two with the same
     * columns. The engine writes `CREATE [UNIQUE] INDEX` itself, under the
     * write authorizer's `index` mode; the index's pages count toward the
     * dataset's quota. It lives in the dataset's file, so it goes wherever
     * the file goes (backups, the off-site copy, moves and transfers).
     */
    createIndex(path: string, table: string, raw: IndexInput, maxBytes: number, options: WriteOptions = {}) {
        const input = indexInput.parse(raw);
        const name = identifier(input.name, 'index name');
        reservedIndex(input.name);
        return this.write(
            path,
            maxBytes,
            (db, as) => {
                const known = this.requireTable(db, table);
                const columns = input.columns.map((wanted) => {
                    identifier(wanted, 'column name');
                    const column = known.find((existing) => existing.name.toLowerCase() === wanted.toLowerCase());
                    if (!column) {
                        throw new DataError(`Column "${wanted}" is not in "${table}".`);
                    }
                    return column.name;
                });
                if (new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) {
                    throw new DataError('An index lists each column once.');
                }
                const unique = !!input.unique;
                const declared = this.indexesOf(db, table);
                const same = (index: IndexInfo) =>
                    index.unique === unique &&
                    index.columns.length === columns.length &&
                    index.columns.every((column, i) => column.toLowerCase() === columns[i].toLowerCase());
                const existing = declared.find((index) => index.name.toLowerCase() === input.name.toLowerCase());
                if (existing) {
                    if (input.ifNotExists && same(existing)) {
                        return { created: false, table, index: existing.name };
                    }
                    throw new DataError(`Index "${existing.name}" exists already on "${table}".`, 409);
                }
                const taken = db
                    .prepare('SELECT type, tbl_name AS tbl FROM sqlite_master WHERE lower(name)=lower(?)')
                    .get(input.name) as { type: string; tbl: string } | undefined;
                if (taken) {
                    throw new DataError(
                        `The name "${input.name}" is taken in this dataset (by a ${taken.type}${taken.type === 'index' ? ` on "${taken.tbl}"` : ''}). Index names are unique across a dataset.`,
                        409,
                    );
                }
                const twin = declared.find(same);
                if (twin) {
                    throw new DataError(`"${table}" already has this index, as "${twin.name}".`, 409);
                }
                if (declared.length >= MAX_INDEXES) {
                    throw new DataError(`A table holds at most ${MAX_INDEXES} indexes.`, 413);
                }
                as('index', () =>
                    db
                        .prepare(
                            `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${identifier(table, 'table name')} (${columns.map((column) => identifier(column)).join(', ')})`,
                        )
                        .run(),
                );
                return { created: true, table, index: input.name, columns, unique };
            },
            options,
        );
    }
    /** Drops a declared index (CB-355); never a PRIMARY KEY's or UNIQUE column's. */
    dropIndex(path: string, table: string, name: string, options: WriteOptions = {}) {
        identifier(name, 'index name');
        return this.write(
            path,
            2 ** 40,
            (db, as) => {
                this.requireTable(db, table);
                const index = this.indexesOf(db, table).find(
                    (declared) => declared.name.toLowerCase() === name.toLowerCase(),
                );
                if (!index) {
                    throw new DataError(`No index "${name}" on "${table}".`, 404);
                }
                as('index', () => db.prepare(`DROP INDEX ${identifier(index.name, 'index name')}`).run());
                return { dropped: true, table, index: index.name };
            },
            options,
        );
    }
    /**
     * Refreshes the query planner's statistics (SQLite `ANALYZE`) for one
     * table, or every table of the dataset (CB-355), so it picks the right
     * index once the rows have grown. Never SQL from the caller: the engine
     * names each table itself, under the write authorizer's `analyze` mode
     * (the engine's own tables are never analyzed). The statistics live in
     * the dataset's file and count toward its quota.
     */
    analyze(path: string, table: string | undefined, maxBytes: number, options: WriteOptions = {}) {
        return this.write(
            path,
            maxBytes,
            (db, as) => {
                if (table !== undefined) {
                    this.requireTable(db, table);
                }
                const tables = table === undefined ? this.tableNames(db) : [table];
                for (const name of tables) {
                    as('analyze', () => db.prepare(`ANALYZE main.${identifier(name, 'table name')}`).run());
                }
                return { analyzed: tables };
            },
            options,
        );
    }
    /**
     * Inserts rows, or upserts them on `key` (a PRIMARY KEY or UNIQUE set).
     * A row an upsert changes is kept in its history, as `writer`'s write.
     */
    insert(
        path: string,
        table: string,
        rawRows: unknown,
        maxBytes: number,
        key?: readonly string[],
        options: WriteOptions = {},
    ) {
        const rows = rowsInput.parse(rawRows);
        return this.write(
            path,
            maxBytes,
            (db, as) => {
                const columns = new Set(this.requireTable(db, table).map((column) => column.name));
                for (const name of key ?? []) {
                    if (!columns.has(name)) {
                        throw new DataError(`Key column "${name}" is not in "${table}".`);
                    }
                }
                let changes = 0;
                const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
                for (const row of rows) {
                    const names = Object.keys(row);
                    if (!names.length) {
                        throw new DataError('Rows need at least one column.');
                    }
                    for (const name of names) {
                        if (!columns.has(name)) {
                            throw new DataError(
                                `Column "${name}" is not in "${table}". Add it with data_add_column first.`,
                            );
                        }
                    }
                    const signature = names.join('\u0000');
                    let statement = statements.get(signature);
                    if (!statement) {
                        let sql = `INSERT INTO ${identifier(table)} (${names.map((name) => identifier(name)).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
                        if (key?.length) {
                            const updates = names.filter((name) => !key.includes(name));
                            sql += ` ON CONFLICT (${key.map((name) => identifier(name)).join(', ')}) ${
                                updates.length
                                    ? `DO UPDATE SET ${updates.map((name) => `${identifier(name)} = excluded.${identifier(name)}`).join(', ')}`
                                    : 'DO NOTHING'
                            }`;
                        }
                        statement = as('dml', () => db.prepare(sql));
                        statements.set(signature, statement);
                    }
                    changes += Number(statement.run(...names.map((name) => bindable(row[name], name))).changes);
                }
                return { table, rows: rows.length, changes };
            },
            { writer: 'system', ...options },
        );
    }
    /**
     * A batch (`batchRuns`): every statement in one transaction, all or
     * nothing, in the query runner's process (`QueryRunner.batch`) under the
     * same quota as a write. A file from before row history gets it first.
     */
    async batch(
        path: string,
        statements: BatchRun[][],
        maxBytes: number,
        options: {
            writer: string;
            allowDelete: boolean;
            timeoutMs: number;
            /** Each statement's `expectChanges` (CB-475), by index. */
            expectChanges?: ReadonlyArray<number | undefined>;
            /** `RETURNING` rows per statement and bytes per batch; the single query's caps by default. */
            returning?: { maxRows: number; maxBytes: number };
        },
    ): Promise<BatchOutcome> {
        // History and stamps first; the batch takes its own stamp.
        this.write(path, 2 ** 40, () => undefined, unmeasured());
        const marker = randomUUID();
        return this.runner.batch(
            {
                path,
                statements: statements.map((runs, index) => {
                    const expectChanges = options.expectChanges?.[index];
                    return expectChanges === undefined ? { runs } : { runs, expectChanges };
                }),
                writer: options.writer,
                maxBytes,
                allowDelete: options.allowDelete,
                marker,
                returningMaxRows: options.returning?.maxRows ?? DEFAULT_DATA_LIMITS.queryMaxRows,
                returningMaxBytes: options.returning?.maxBytes ?? DEFAULT_DATA_LIMITS.queryMaxBytes,
            },
            options.timeoutMs,
            () => this.recover(path, marker),
        );
    }
    /**
     * Opens a file whose writer was killed mid-transaction: SQLite rolls the
     * hot journal back on the first read, before anyone reads half a batch.
     */
    recover(path: string, marker?: string) {
        const db = new DatabaseSync(path, { allowExtension: false });
        try {
            db.exec('PRAGMA busy_timeout=5000');
            db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
            // Whether the batch with this mark committed (`QueryRunner.batch`).
            return (
                !!marker && !!db.prepare(`SELECT 1 FROM ${WRITES_TABLE} WHERE actor=? LIMIT 1`).get(`batch:${marker}`)
            );
        } finally {
            db.close();
        }
    }
    async query(
        path: string,
        sql: string,
        params: Array<string | number | boolean | null>,
        caps: { maxRows: number; maxBytes: number; timeoutMs: number },
    ): Promise<QueryResult> {
        const statement = singleQuery(sql);
        this.existing(path);
        return this.runner.run(
            {
                path,
                sql: statement,
                params: params.map((value) => (typeof value === 'boolean' ? +value : value)),
                maxRows: caps.maxRows,
                maxBytes: caps.maxBytes,
            },
            caps.timeoutMs,
        );
    }
    /**
     * A read batch (CB-474): each SELECT checked as `query` checks one, all
     * read from one snapshot in a runner process (`QueryRunner.readBatch`).
     * A statement that isn't one SELECT refuses the batch, naming it.
     */
    async readBatch(
        path: string,
        statements: ReadonlyArray<{ sql: string; params?: Array<string | number | boolean | null> }>,
        caps: { maxRows: number; maxBytes: number; maxTotalBytes: number; timeoutMs: number; totalTimeoutMs: number },
    ): Promise<QueryResult[]> {
        const checked = statements.map((statement, index) => {
            try {
                return {
                    sql: singleQuery(statement.sql),
                    params: (statement.params ?? []).map((value) => (typeof value === 'boolean' ? +value : value)),
                };
            } catch (error) {
                if (error instanceof DataError) {
                    throw new DataError(`Statement ${index + 1}: ${error.message}`, error.status);
                }
                throw error;
            }
        });
        this.existing(path);
        return this.runner.readBatch(
            {
                path,
                statements: checked,
                maxRows: caps.maxRows,
                maxBytes: caps.maxBytes,
                maxTotalBytes: caps.maxTotalBytes,
            },
            caps.timeoutMs,
            caps.totalTimeoutMs,
        );
    }
    /**
     * A page of a table's rows, in rowid order (the app's table browser).
     * With `rowids`, each row's rowid too (a socio's shared dataset, whose
     * rows the viewer may delete: CB-229), unless the table has none.
     */
    rows(
        path: string,
        table: string,
        offset: number,
        limit: number,
        { rowids = false }: { rowids?: boolean } = {},
    ): RowsPage {
        const started = performance.now();
        return this.read(path, (db) => {
            this.requireTable(db, table);
            const total = Number(
                (db.prepare(`SELECT count(*) AS n FROM ${identifier(table)}`).get() as { n: number }).n,
            );
            // The rowid first, in the same statement: the same rows, in the same order.
            const alias = rowids ? this.rowidAlias(db, table) : undefined;
            const statement = db.prepare(
                `SELECT ${alias ? `${alias}, ` : ''}* FROM ${identifier(table)} LIMIT ? OFFSET ?`,
            );
            statement.setReadBigInts(true);
            statement.setReturnArrays(true);
            const columns = statement
                .columns()
                .slice(alias ? 1 : 0)
                .map((column) => column.name);
            const all = statement.all(limit, offset) as unknown as unknown[][];
            const rows = all.map((row) => row.slice(alias ? 1 : 0).map(cell));
            return {
                table,
                offset,
                limit,
                total,
                columns,
                rows,
                truncated: offset + rows.length < total,
                ms: Math.round(performance.now() - started),
                ...(alias && all.every((row) => Number.isSafeInteger(Number(row[0])))
                    ? { rowids: all.map((row) => Number(row[0])) }
                    : {}),
            };
        });
    }
    /**
     * The name a table's rowid answers to: `rowid`, `_rowid_` or `oid`,
     * whichever no column of its own takes; none for a WITHOUT ROWID table.
     */
    private rowidAlias(db: DatabaseSync, table: string) {
        const withoutRowid = (
            db.prepare('SELECT wr FROM pragma_table_list WHERE schema=? AND name=?').get('main', table) as
                | { wr: number }
                | undefined
        )?.wr;
        if (withoutRowid) {
            return undefined;
        }
        const taken = new Set(this.columnsOf(db, table).map((column) => column.name.toLowerCase()));
        return ['rowid', '_rowid_', 'oid'].find((name) => !taken.has(name));
    }
    /**
     * Deletes rows by rowid (a company socio's shared dataset, CB-229): the
     * table's delete trigger keeps each in its history, with `writer`.
     */
    deleteRows(path: string, table: string, rowids: readonly number[], options: WriteOptions = {}) {
        if (!rowids.length || rowids.length > 1000 || rowids.some((id) => !Number.isSafeInteger(id))) {
            throw new DataError('Invalid row identifiers.');
        }
        return this.write(
            path,
            2 ** 40,
            (db) => {
                this.requireTable(db, table);
                const alias = this.rowidAlias(db, table);
                if (!alias) {
                    throw new DataError(
                        `Rows of "${table}" can't be deleted one at a time; delete the table instead.`,
                        409,
                    );
                }
                const remove = db.prepare(`DELETE FROM ${identifier(table)} WHERE ${alias}=?`);
                let deleted = 0;
                for (const id of rowids) {
                    deleted += Number(remove.run(id).changes);
                }
                return { deleted };
            },
            options,
        );
    }
    /**
     * Deletes a table (CB-229): it is renamed `_deleted_<at>_<name>` in the
     * same file, its history with it, kept and hidden like history (its bytes
     * don't count toward the quota). Its triggers and declared indexes go
     * first, so a new table can take its name and their names (an index is
     * rebuilt from the rows if it is ever wanted again).
     */
    deleteTable(path: string, table: string, at = Date.now(), options: WriteOptions = {}) {
        return this.write(
            path,
            2 ** 40,
            (db) => {
                this.requireTable(db, table);
                const base = `${DELETED_PREFIX}${at}_${table}`;
                let kept = base;
                let suffix = 0;
                const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
                while (exists.get(kept)) {
                    kept = `${base}_${++suffix}`;
                }
                db.exec(
                    `DROP TRIGGER IF EXISTS ${quoted(`${TRIGGER_PREFIX}update_${table}`)}; DROP TRIGGER IF EXISTS ${quoted(`${TRIGGER_PREFIX}delete_${table}`)};`,
                );
                for (const index of this.indexesOf(db, table)) {
                    db.exec(`DROP INDEX ${quoted(index.name)}`);
                }
                // Its row stamps go (CB-451): a table made later under its name
                // starts afresh, and no client's token from before reads it as
                // changes (the floor), so no deleted row stays in a cache.
                dropStamps(db, table);
                raiseFloorToNow(db);
                db.exec(`ALTER TABLE ${identifier(table)} RENAME TO ${quoted(kept)}`);
                const history = `${HISTORY_PREFIX}${table}`;
                if (this.hiddenNames(db).includes(history)) {
                    db.exec(`ALTER TABLE ${quoted(history)} RENAME TO ${quoted(`${HISTORY_PREFIX}${kept}`)}`);
                }
                return { table: kept };
            },
            options,
        );
    }
    /**
     * Each table's bytes with its indexes (`dbstat`, which reads their
     * pages): a socio's shared dataset's view (CB-229).
     */
    tableSizes(path: string): Map<string, number> {
        if (!this.size(path)) {
            return new Map();
        }
        return this.read(
            path,
            (db) =>
                new Map(
                    (
                        db
                            .prepare(
                                "SELECT m.tbl_name AS name, coalesce(sum(s.pgsize), 0) AS bytes FROM sqlite_master m JOIN dbstat s ON s.name = m.name AND s.aggregate = TRUE WHERE m.type IN ('table', 'index') GROUP BY m.tbl_name",
                            )
                            .all() as Array<{ name: string; bytes: number }>
                    ).map((row) => [String(row.name), Number(row.bytes)] as const),
                ),
        );
    }
    /**
     * How many rows of a table still hold each of a select field's option
     * ids (CB-451): as the cell's text, or as an item of a JSON list
     * (a multi-select), whichever the column's rows hold. Ids no row holds
     * are left out.
     */
    optionUse(path: string, table: string, column: string, ids: readonly string[]): Map<string, number> {
        const out = new Map<string, number>();
        if (!ids.length) {
            return out;
        }
        return this.read(path, (db) => {
            const columns = this.requireTable(db, table);
            const have = columns.find((item) => item.name.toLowerCase() === column.toLowerCase());
            if (!have) {
                return out;
            }
            const col = identifier(have.name, 'column');
            const statement = db.prepare(
                `SELECT count(*) AS n FROM ${identifier(table)} WHERE ${col} = ?1 OR (json_valid(${col}) AND json_type(${col}) = 'array' AND EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?1))`,
            );
            for (const id of new Set(ids)) {
                const n = Number((statement.get(id) as { n: number | bigint }).n);
                if (n > 0) {
                    out.set(id, n);
                }
            }
            return out;
        });
    }
    /** A table as CSV (RFC 4180; BLOBs as base64; a field, text or base64, that a spreadsheet would run as a formula starts with an apostrophe). */
    csv(path: string, table: string): string {
        return this.read(path, (db) => {
            this.requireTable(db, table);
            const statement = db.prepare(`SELECT * FROM ${identifier(table)}`);
            statement.setReadBigInts(true);
            statement.setReturnArrays(true);
            // Every CSV export goes through `csvField` (formula guard, CB-451).
            const lines = [csvRow(statement.columns().map((column) => column.name))];
            for (const row of statement.iterate() as Iterable<unknown[]>) {
                lines.push(csvRow(row));
            }
            return `${lines.join('\r\n')}\r\n`;
        });
    }
    /**
     * Drops tables: the platform's own step when a mini app's promotion
     * moves them into a dataset of their own, never a Dot's or token's.
     * Their history goes with them (and their triggers and indexes, with the
     * table): the copy they moved into holds all of it.
     */
    dropTables(path: string, tables: readonly string[]) {
        if (!tables.length) {
            return;
        }
        this.write(path, 2 ** 40, (db) => {
            const known = new Set(this.tableNames(db));
            for (const table of tables) {
                if (known.has(table)) {
                    db.exec(`DROP TABLE ${identifier(table, 'table name')}`);
                    db.exec(`DROP TABLE IF EXISTS ${quoted(`${HISTORY_PREFIX}${table}`)}`);
                    dropStamps(db, table);
                    raiseFloorToNow(db);
                }
            }
        });
    }
    /**
     * A consistent copy of the dataset file, history and all (moves, tests).
     * The copy is written on its own from here, so it takes a generation of
     * its own (CB-451): no stamp of it can name a write of the source.
     */
    copy(path: string, target: string) {
        this.existing(path);
        mkdirSync(dirname(target), { recursive: true });
        rmSync(target, { force: true });
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            db.exec('PRAGMA busy_timeout=5000');
            db.prepare('VACUUM INTO ?').run(target);
        } finally {
            db.close();
        }
        const copy = new DatabaseSync(target, { allowExtension: false });
        try {
            if (stampState(copy)) {
                copy.exec('BEGIN IMMEDIATE');
                restartGeneration(copy);
                copy.exec('COMMIT');
            }
        } finally {
            copy.close();
        }
    }
    /**
     * A copy for the user to take away (the SQLite export): the dataset's
     * tables only, without the engine's history tables and triggers.
     */
    exportCopy(path: string, target: string) {
        this.copy(path, target);
        const db = new DatabaseSync(target, { allowExtension: false });
        try {
            const triggers = db
                .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB ?")
                .all(`${TRIGGER_PREFIX}*`)
                .map((row) => String(row.name));
            for (const name of triggers) {
                db.exec(`DROP TRIGGER ${quoted(name)}`);
            }
            for (const name of this.hiddenNames(db)) {
                db.exec(`DROP TABLE ${quoted(name)}`);
            }
            db.exec('PRAGMA user_version=0; VACUUM;');
        } finally {
            db.close();
        }
    }
    // ── Analytical tables (CB-369) ───────────────────────────────────────
    /** The analytical tables' names in a file (none before its first one). */
    private catalogNames(db: DatabaseSync): string[] {
        if (!this.hiddenNames(db).includes(OLAP_TABLES)) {
            return [];
        }
        return db
            .prepare(`SELECT name FROM ${OLAP_TABLES} ORDER BY name`)
            .all()
            .map((row) => String(row.name));
    }
    private catalogTables(db: DatabaseSync): AnalyticalTable[] {
        if (!this.hiddenNames(db).includes(OLAP_TABLES)) {
            return [];
        }
        return (
            db
                // `*`: `retain_override` (CB-387) is only in catalogs an admin overrode.
                .prepare(`SELECT * FROM ${OLAP_TABLES} ORDER BY name`)
                .all()
                .map((row) => ({
                    name: String(row.name),
                    id: engineId(String(row.id)),
                    columns: JSON.parse(String(row.columns)) as AnalyticalColumn[],
                    partitionBy: { column: String(row.partition_column), grain: row.grain as 'day' | 'month' },
                    ...(row.retain_days == null ? {} : { retainDays: Number(row.retain_days) }),
                    ...(row.retain_override == null ? {} : { retainOverride: Number(row.retain_override) }),
                }))
        );
    }
    /** Makes the catalog in a file, the first time it gets an analytical table. */
    private ensureCatalog(db: DatabaseSync) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${OLAP_TABLES}(name TEXT PRIMARY KEY COLLATE NOCASE, id TEXT NOT NULL UNIQUE, columns TEXT NOT NULL, partition_column TEXT NOT NULL, grain TEXT NOT NULL, retain_days INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ${OLAP_PARTS}(id TEXT PRIMARY KEY, table_id TEXT NOT NULL, partition TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, min_value INTEGER NOT NULL, max_value INTEGER NOT NULL, columns INTEGER NOT NULL, append_id TEXT, write_id INTEGER, created_at INTEGER NOT NULL, retired_at INTEGER, retired_by TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS _olap_parts_append ON ${OLAP_PARTS}(table_id, append_id, partition) WHERE append_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS _olap_parts_live ON ${OLAP_PARTS}(table_id, partition) WHERE retired_at IS NULL;`);
    }
    /** A file's analytical tables, with what the Data page shows of each. */
    analyticalTables(path: string): Array<AnalyticalTable & { rowCount: number; stats: AnalyticalTableStats }> {
        if (!this.size(path)) {
            return [];
        }
        return this.read(path, (db) =>
            this.catalogTables(db).map((table) => {
                const sums = db
                    .prepare(
                        `SELECT count(*) AS parts, coalesce(sum(rows), 0) AS rows, coalesce(sum(bytes), 0) AS bytes, count(DISTINCT partition) AS partitions, min(partition) AS first, max(partition) AS last FROM ${OLAP_PARTS} WHERE table_id=? AND retired_at IS NULL`,
                    )
                    .get(table.id) as {
                    parts: number;
                    rows: number;
                    bytes: number;
                    partitions: number;
                    first: string | null;
                    last: string | null;
                };
                return {
                    ...table,
                    rowCount: Number(sums.rows),
                    stats: {
                        partitionBy: table.partitionBy,
                        parts: Number(sums.parts),
                        bytes: Number(sums.bytes),
                        partitions: Number(sums.partitions),
                        firstPartition: sums.first,
                        lastPartition: sums.last,
                        ...(table.retainDays ? { retainDays: table.retainDays } : {}),
                    },
                };
            }),
        );
    }
    /** One analytical table by name, or undefined. */
    analyticalTable(path: string, name: string): AnalyticalTable | undefined {
        if (!this.size(path)) {
            return undefined;
        }
        return this.read(path, (db) =>
            this.catalogTables(db).find((table) => table.name.toLowerCase() === name.toLowerCase()),
        );
    }
    /**
     * Declares an analytical table: the catalog row only; its parts
     * come with appends. Its name is the dataset's, shared with the
     * transactional tables. `ifNotExists` with the same declaration is a
     * no-op; with another, a 409 that names the difference.
     */
    /** An analytical declaration, checked as `createAnalyticalTable` checks it, without a file (CB-387). */
    checkAnalyticalDeclaration(raw: unknown) {
        return checkDeclaration(raw, reservedTable);
    }
    createAnalyticalTable(path: string, raw: unknown, options: WriteOptions = {}) {
        const input = this.checkAnalyticalDeclaration(raw);
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const existing = this.catalogTables(db).find(
                    (table) => table.name.toLowerCase() === input.name.toLowerCase(),
                );
                if (existing) {
                    if (input.ifNotExists && sameDeclaration(existing, input)) {
                        return { created: false, table: existing.name, kind: 'analytical' as const };
                    }
                    throw new DataError(
                        `Analytical table "${existing.name}" exists already and differs: ${declarationDifference(existing, input)}.`,
                        409,
                    );
                }
                const transactional = this.tableNames(db);
                if (transactional.some((name) => name.toLowerCase() === input.name.toLowerCase())) {
                    throw new DataError(`"${input.name}" is a transactional table in this dataset.`, 409);
                }
                if (transactional.length + this.catalogNames(db).length >= MAX_TABLES) {
                    throw new DataError(`A dataset holds at most ${MAX_TABLES} tables.`, 413);
                }
                this.ensureCatalog(db);
                db.prepare(
                    `INSERT INTO ${OLAP_TABLES}(name, id, columns, partition_column, grain, retain_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ).run(
                    input.name,
                    randomUUID(),
                    JSON.stringify(input.columns),
                    input.partitionBy.column,
                    input.partitionBy.grain,
                    input.retainDays ?? null,
                    Date.now(),
                );
                return { created: true, table: input.name, kind: 'analytical' as const };
            },
            options,
        );
    }
    /** Adds a nullable column to an analytical table; older parts read it as null. */
    addAnalyticalColumn(
        path: string,
        table: string,
        raw: { name: string; type?: string; notNull?: boolean },
        options: WriteOptions = {},
    ) {
        const extra = Object.keys(raw).filter((key) => !['name', 'type', 'notNull'].includes(key));
        if (extra.length || raw.notNull) {
            throw new DataError(
                'A column added to an analytical table has a name and a type, and may be null: no keys, uniques, defaults or NOT NULL.',
            );
        }
        identifier(raw.name, 'column name');
        const type = analyticalType(raw.type ?? 'TEXT');
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const found = this.catalogTables(db).find((item) => item.name.toLowerCase() === table.toLowerCase());
                if (!found) {
                    throw new DataError(`No table "${table}" in this dataset.`, 404);
                }
                if (found.columns.some((column) => column.name.toLowerCase() === raw.name.toLowerCase())) {
                    throw new DataError(`Column "${raw.name}" exists already.`, 409);
                }
                if (raw.name.startsWith('__')) {
                    throw new DataError(`"${raw.name}" is reserved: analytical column names can't start with __.`);
                }
                if (found.columns.length >= MAX_COLUMNS) {
                    throw new DataError(`A table holds at most ${MAX_COLUMNS} columns.`, 413);
                }
                db.prepare(`UPDATE ${OLAP_TABLES} SET columns=? WHERE id=?`).run(
                    JSON.stringify([...found.columns, { name: raw.name, type }]),
                    found.id,
                );
                return { table: found.name, column: raw.name };
            },
            options,
        );
    }
    /**
     * Records an analytical table's retention (CB-387): days, or null
     * to keep everything. Answers whether it changed.
     */
    setAnalyticalRetention(path: string, table: string, days: number | null) {
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const found = this.catalogTables(db).find((item) => item.name.toLowerCase() === table.toLowerCase());
                if (!found || (found.retainDays ?? null) === days) {
                    return false;
                }
                db.prepare(`UPDATE ${OLAP_TABLES} SET retain_days=? WHERE id=?`).run(days, found.id);
                return true;
            },
            { maintenance: true },
        );
    }
    /**
     * Sets or clears an admin's retention override on an analytical table
     * (CB-387): days, 0 to keep everything, or null to clear it. Kept in its
     * own column, which no manifest update writes. Answers the table's
     * override before, or throws a 404 for a missing table.
     */
    setAnalyticalRetentionOverride(path: string, table: string, override: number | null) {
        if (!this.size(path)) {
            throw new DataError(`No table "${table}" in this dataset.`, 404);
        }
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const found = this.catalogTables(db).find((item) => item.name.toLowerCase() === table.toLowerCase());
                if (!found) {
                    throw new DataError(`No table "${table}" in this dataset.`, 404);
                }
                const columns = db.prepare(`PRAGMA table_info(${OLAP_TABLES})`).all() as Array<{ name: string }>;
                if (!columns.some((column) => column.name === 'retain_override')) {
                    if (override === null) {
                        return { table: found.name, before: undefined };
                    }
                    db.exec(`ALTER TABLE ${OLAP_TABLES} ADD COLUMN retain_override INTEGER`);
                }
                db.prepare(`UPDATE ${OLAP_TABLES} SET retain_override=? WHERE id=?`).run(override, found.id);
                return { table: found.name, before: found.retainOverride };
            },
            { maintenance: true },
        );
    }
    /**
     * What retention of `days` would retire in a table if it ran at `now`
     * (CB-387): the live partitions that ended before the cutoff, with their
     * parts, rows and bytes. Null days keeps everything: nothing.
     */
    retentionPreview(path: string, table: string, days: number | null, now = Date.now()) {
        const found = this.analyticalTable(path, table);
        if (!found) {
            throw new DataError(`No table "${table}" in this dataset.`, 404);
        }
        const preview = {
            table: found.name,
            days,
            partitions: 0,
            parts: 0,
            rows: 0,
            bytes: 0,
            firstPartition: null as string | null,
            lastPartition: null as string | null,
        };
        if (!days) {
            return preview;
        }
        const cutoff = now - days * 86_400_000;
        const live = this.read(
            path,
            (db) =>
                db
                    .prepare(
                        `SELECT partition, count(*) AS parts, sum(rows) AS rows, sum(bytes) AS bytes FROM ${OLAP_PARTS} WHERE table_id=? AND retired_at IS NULL GROUP BY partition ORDER BY partition`,
                    )
                    .all(found.id) as Array<{ partition: string; parts: number; rows: number; bytes: number }>,
        );
        for (const item of live) {
            if (!(partitionEndMs(partitionName(item.partition)) <= cutoff)) {
                continue;
            }
            preview.partitions++;
            preview.parts += Number(item.parts);
            preview.rows += Number(item.rows);
            preview.bytes += Number(item.bytes);
            preview.firstPartition ??= item.partition;
            preview.lastPartition = item.partition;
        }
        return preview;
    }
    /**
     * Retention (CB-387): retires every live part of a table whose
     * partition ended before `now` less the days `days` answers for it (by
     * default the catalog's `retainDays`), in one transaction
     * (`retired_by = 'retention'`). Queries stop reading them at once; the
     * files stay until `forgetRetired` (backups keep them meanwhile). What
     * it retired, per table and partition.
     */
    retirePastRetention(
        path: string,
        now = Date.now(),
        days: (table: AnalyticalTable) => number | null = (table) => table.retainDays ?? null,
    ) {
        if (!this.size(path)) {
            return [];
        }
        const has = this.read(path, (db) => this.catalogTables(db).some((table) => days(table)));
        if (!has) {
            return [];
        }
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const retired: Array<{ table: string; partition: string; parts: number; rows: number; bytes: number }> =
                    [];
                for (const table of this.catalogTables(db)) {
                    const keep = days(table);
                    if (!keep) {
                        continue;
                    }
                    const cutoff = now - keep * 86_400_000;
                    const live = db
                        .prepare(
                            `SELECT partition, count(*) AS parts, sum(rows) AS rows, sum(bytes) AS bytes FROM ${OLAP_PARTS} WHERE table_id=? AND retired_at IS NULL GROUP BY partition ORDER BY partition`,
                        )
                        .all(table.id) as Array<{ partition: string; parts: number; rows: number; bytes: number }>;
                    const retire = db.prepare(
                        `UPDATE ${OLAP_PARTS} SET retired_at=?, retired_by='retention' WHERE table_id=? AND partition=? AND retired_at IS NULL`,
                    );
                    for (const item of live) {
                        if (!(partitionEndMs(partitionName(item.partition)) <= cutoff)) {
                            continue;
                        }
                        retire.run(now, table.id, item.partition);
                        retired.push({
                            table: table.name,
                            partition: item.partition,
                            parts: Number(item.parts),
                            rows: Number(item.rows),
                            bytes: Number(item.bytes),
                        });
                    }
                }
                return retired;
            },
            { maintenance: true },
        );
    }
    /**
     * Forgets parts retired before `before` (`retiredKeepHours`): their
     * catalog rows go in one transaction, and their files are answered for
     * the caller to delete. A crash between leaves unlisted files, which the
     * sweep deletes.
     */
    forgetRetired(path: string, before: number): string[] {
        if (!this.size(path)) {
            return [];
        }
        const any = this.read(path, (db) =>
            this.hiddenNames(db).includes(OLAP_PARTS)
                ? !!db
                      .prepare(`SELECT 1 FROM ${OLAP_PARTS} WHERE retired_at IS NOT NULL AND retired_at < ? LIMIT 1`)
                      .get(before)
                : false,
        );
        if (!any) {
            return [];
        }
        return this.write(
            path,
            2 ** 40,
            (db) => {
                const gone = db
                    .prepare(
                        `SELECT id, table_id AS tableId, partition FROM ${OLAP_PARTS} WHERE retired_at IS NOT NULL AND retired_at < ?`,
                    )
                    .all(before) as Array<{ id: string; tableId: string; partition: string }>;
                // An append id outlives its parts, so a retry adds nothing.
                db.exec(
                    `CREATE TABLE IF NOT EXISTS ${OLAP_FORGOTTEN}(id TEXT PRIMARY KEY, table_id TEXT NOT NULL, append_id TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, forgotten_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS _olap_forgotten_append ON ${OLAP_FORGOTTEN}(table_id, append_id);`,
                );
                db.prepare(
                    `INSERT OR IGNORE INTO ${OLAP_FORGOTTEN}(id, table_id, append_id, rows, bytes, forgotten_at) SELECT id, table_id, append_id, rows, bytes, ? FROM ${OLAP_PARTS} WHERE retired_at IS NOT NULL AND retired_at < ? AND append_id IS NOT NULL`,
                ).run(Date.now(), before);
                db.prepare(`DELETE FROM ${OLAP_PARTS} WHERE retired_at IS NOT NULL AND retired_at < ?`).run(before);
                return gone.map((part) => partPath(path, part));
            },
            { maintenance: true },
        );
    }
    /** The parts an append id committed to a table already (a retried append). */
    appendedParts(path: string, tableId: string, appendId: string) {
        return this.read(path, (db) => this.appendRecord(db, tableId, appendId));
    }
    /** An append id's parts, live, retired or forgotten by retention (CB-387). */
    private appendRecord(db: DatabaseSync, tableId: string, appendId: string) {
        const hidden = this.hiddenNames(db);
        if (!hidden.includes(OLAP_PARTS)) {
            return [];
        }
        const forgotten = hidden.includes(OLAP_FORGOTTEN)
            ? ` UNION ALL SELECT rows, bytes FROM ${OLAP_FORGOTTEN} WHERE table_id=? AND append_id=?`
            : '';
        return db
            .prepare(`SELECT rows, bytes FROM ${OLAP_PARTS} WHERE table_id=? AND append_id=?${forgotten}`)
            .all(...(forgotten ? [tableId, appendId, tableId, appendId] : [tableId, appendId])) as Array<{
            rows: number;
            bytes: number;
        }>;
    }
    /**
     * Commits staged parts: each is moved from staging to its
     * partition's directory, where nothing lists it yet, and then one
     * transaction on the dataset file adds their catalog rows and a
     * `_writes` row naming the writer, unless the append id is committed
     * already (nothing is added, the moved files are removed). Readers see
     * only what the catalog lists, so never half an append. `room`: bytes
     * the append may add (the owner's analytical budget), checked in the
     * same transaction.
     */
    commitParts(
        path: string,
        table: AnalyticalTable,
        parts: readonly StagedPart[],
        options: { appendId: string | null; writer: string; room: () => number },
    ) {
        const moved: string[] = [];
        try {
            for (const part of parts) {
                const target = partPath(path, {
                    id: part.id,
                    tableId: table.id,
                    partition: partitionName(part.partition),
                });
                mkdirSync(dirname(target), { recursive: true });
                renameSync(stagedPath(path, part.id), target);
                chmodSync(target, 0o444);
                moved.push(target);
            }
            // Durable before the catalog names them: every directory a move
            // made or changed, up to the datasets directory (a crash after the
            // commit never leaves a listed part missing).
            const dirs = new Set<string>();
            for (const file of moved) {
                for (let dir = dirname(file); dir.length >= dirname(path).length; dir = dirname(dir)) {
                    dirs.add(dir);
                    if (dir === dirname(path)) {
                        break;
                    }
                }
            }
            for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
                syncDir(dir);
            }
            const outcome = this.write(path, 2 ** 40, (db) => {
                this.ensureCatalog(db);
                const current = this.catalogTables(db).find((item) => item.id === table.id);
                if (!current) {
                    throw new DataError(`No table "${table.name}" in this dataset.`, 404);
                }
                if (current.columns.length !== table.columns.length) {
                    throw new DataError(`"${table.name}" changed while the append was staged; send it again.`, 409);
                }
                if (options.appendId) {
                    const before = this.appendRecord(db, table.id, options.appendId);
                    if (before.length) {
                        return { duplicate: true as const, before };
                    }
                }
                const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
                const room = options.room();
                if (bytes > room) {
                    throw new DataError(
                        `The analytical budget is full: this append is ${Math.ceil(bytes / 1048576)} MB and ${Math.max(0, Math.floor(room / 1048576))} MB are left. An admin raises it in Settings → General → Analytical tables.`,
                        413,
                    );
                }
                const now = Date.now();
                const writeId = Number(
                    (db.prepare(`SELECT coalesce(max(id), 0) + 1 AS id FROM ${WRITES_TABLE}`).get() as { id: number })
                        .id,
                );
                db.prepare(`INSERT INTO ${WRITES_TABLE} (id, actor, at) VALUES (?, ?, ?)`).run(
                    writeId,
                    options.writer,
                    now,
                );
                const insert = db.prepare(
                    `INSERT INTO ${OLAP_PARTS}(id, table_id, partition, rows, bytes, min_value, max_value, columns, append_id, write_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                );
                for (const part of parts) {
                    insert.run(
                        engineId(part.id),
                        table.id,
                        partitionName(part.partition),
                        part.rows,
                        part.bytes,
                        part.min,
                        part.max,
                        table.columns.length,
                        options.appendId,
                        writeId,
                        now,
                    );
                }
                return { duplicate: false as const };
            });
            if (outcome.duplicate) {
                for (const file of moved) {
                    rmSync(file, { force: true });
                }
            }
            return outcome;
        } catch (error) {
            for (const file of moved) {
                rmSync(file, { force: true });
            }
            for (const part of parts) {
                rmSync(stagedPath(path, part.id), { force: true });
            }
            throw error;
        }
    }
    /** Every part a file's catalog lists, live or retired (backups, the sweep, missing parts). */
    listedParts(path: string): Array<{ id: string; tableId: string; partition: string; bytes: number; file: string }> {
        if (!this.size(path)) {
            return [];
        }
        return this.read(path, (db) =>
            this.hiddenNames(db).includes(OLAP_PARTS)
                ? (
                      db.prepare(`SELECT id, table_id AS tableId, partition, bytes FROM ${OLAP_PARTS}`).all() as Array<{
                          id: string;
                          tableId: string;
                          partition: string;
                          bytes: number;
                      }>
                  ).map((part) => ({ ...part, bytes: Number(part.bytes), file: partPath(path, part) }))
                : [],
        );
    }
    /** The live parts' bytes, which the owner's analytical budget counts. */
    analyticalBytes(path: string) {
        if (!this.size(path)) {
            return 0;
        }
        return this.read(path, (db) =>
            this.hiddenNames(db).includes(OLAP_PARTS)
                ? Number(
                      (
                          db
                              .prepare(
                                  `SELECT coalesce(sum(bytes), 0) AS n FROM ${OLAP_PARTS} WHERE retired_at IS NULL`,
                              )
                              .get() as {
                              n: number;
                          }
                      ).n,
                  )
                : 0,
        );
    }
    /**
     * What a table's history holds, oldest first, with who replaced each row
     * (the admin view, not built; tests). Empty for a table never changed.
     */
    withHistoryOf(path: string, table: string): HistoryRow[] {
        return this.read(path, (db) => {
            const history = `${HISTORY_PREFIX}${table}`;
            if (!this.hiddenNames(db).includes(history)) {
                return [];
            }
            // Kept order: SQLite's row id, under a name no column takes (one may be `rowid`).
            const id = this.rowIdName(db, history);
            const statement = db.prepare(
                `SELECT w.actor, h.* FROM ${quoted(history)} h LEFT JOIN ${WRITES_TABLE} w ON w.id = h."_writeId" ORDER BY ${id ? `h.${id}` : 'h."_replacedAt", h."_writeId"'}`,
            );
            statement.setReturnArrays(true);
            // The actor, history's own four columns, then the table's.
            const names = statement
                .columns()
                .slice(1 + HISTORY_COLUMNS.length)
                .map((column) => column.name);
            return (statement.all() as unknown as unknown[][]).map(
                ([actor, rowid, writeId, replacedAt, change, ...values]) => ({
                    rowid: rowid === null ? null : Number(rowid),
                    change: change as HistoryRow['change'],
                    writeId: Number(writeId),
                    replacedAt: Number(replacedAt),
                    actor: actor === null ? null : String(actor),
                    values: Object.fromEntries(names.map((name, i) => [name, cell(values[i])])),
                }),
            );
        });
    }
}
