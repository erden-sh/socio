/**
 * Row stamps (CB-451): what a changes read (`GET
 * …/tables/:table/changes?since=`) and a cache's reconcile compare.
 *
 * - `_stamp_seq` holds the file's sequence: every write transaction takes
 *   `value + 1` once, before its first change (`STAMP_BUMP`), and nothing
 *   lowers it. `_writes.id` can't be the cursor: it is `max(id) + 1`, so a
 *   history prune makes it reusable.
 * - `generation` names the file's history: a random id, replaced whenever
 *   the history is rewound or forked (a restore from backup, a copy that is
 *   written on its own). A backup's copy is left with an empty generation
 *   (`PENDING_GENERATION`, `@socio/data/backup`): each restore of it takes
 *   a new one on its first open, so two restores of one backup never share
 *   one. `_stamp_generations` numbers them in the file, so a row costs an
 *   integer.
 * - `_stamps_<table>` keeps, per row of a table with a primary key, the
 *   stamp and generation of the write that last changed it, whatever the
 *   table's history setting; a delete leaves a tombstone, `deleted` being
 *   when (ms, never 0). Its `key` is SQLite's `json_array` of the key
 *   values; the wire's row key (JCS JSON, `rowKey`) is read from it
 *   (`wireKey`). A blob key value is held as `{"$blob":"<hex>"}`, apart
 *   from any text; a table holding a blob or NULL key answers `resync`.
 * - `_writer.stampFloor` is the oldest stamp a changes read still answers:
 *   tombstones pruned after `stampTombstoneDays`, and a dropped table, raise
 *   it; a `since` below it reconciles.
 *
 * Installed lazily, per file, in the transaction of its first write (or
 * of the first changes read, which makes one), like row history: no boot
 * step opens every dataset file. Every live row of a keyed table is
 * backfilled with the sequence's first value.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { formatStamp, parseStamp, rowKey, STAMP_GENERATION, type KeyValue } from '@socio/shared/dataset-views/schema';

import {
    STAMP_GENERATIONS_TABLE,
    STAMP_PREFIX,
    STAMP_SEQ_TABLE,
    STAMPS_PREFIX,
    TRIGGER_PREFIX,
    WRITER_TABLE,
} from './sql.js';

/** `PRAGMA user_version` once a file has row stamps (after `HISTORY_VERSION`). */
export const STAMPS_VERSION = 2;
/** A backup's copy: the next open of a restore of it takes a new generation. */
export const PENDING_GENERATION = '';

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const stampsTable = (table: string) => `${STAMPS_PREFIX}${table}`;
const stampIndex = (table: string) => `${STAMP_PREFIX}_by_${table}`;
const stampTrigger = (kind: 'insert' | 'update' | 'delete', table: string) => `${TRIGGER_PREFIX}stamp_${kind}_${table}`;

/** A new generation id: 128 random bits, base64url (22 characters of `STAMP_GENERATION`). */
export function newGeneration(): string {
    return randomBytes(16).toString('base64url');
}

/** The file's place: its generation, its sequence's value and its floor. */
export interface StampState {
    generation: string;
    value: number;
    floor: number;
}

const hasTable = (db: DatabaseSync, name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The file's stamp state, or undefined before stamps (or with a generation still to take). */
export function stampState(db: DatabaseSync): StampState | undefined {
    if (!hasTable(db, STAMP_SEQ_TABLE)) {
        return undefined;
    }
    const seq = db.prepare(`SELECT value, generation FROM ${STAMP_SEQ_TABLE} WHERE id=1`).get() as
        | { value: number; generation: string }
        | undefined;
    if (!seq || !STAMP_GENERATION.test(seq.generation)) {
        return undefined;
    }
    const writer = db.prepare(`SELECT stampFloor FROM ${WRITER_TABLE} WHERE id=1`).get() as
        | { stampFloor: number | null }
        | undefined;
    return { generation: seq.generation, value: Number(seq.value), floor: Number(writer?.stampFloor ?? 0) };
}

/** Starts a new generation: the history goes on from here under another id. */
export function restartGeneration(db: DatabaseSync) {
    const generation = newGeneration();
    db.prepare(`INSERT INTO ${STAMP_GENERATIONS_TABLE} (generation) VALUES (?)`).run(generation);
    db.prepare(`UPDATE ${STAMP_SEQ_TABLE} SET generation=? WHERE id=1`).run(generation);
    return generation;
}

/**
 * Gives a file its stamps once (`user_version`), in the caller's write
 * transaction, or a restored file its new generation. `tables`: the
 * dataset's transactional tables. True when it installed them now.
 */
export function ensureStamps(db: DatabaseSync, tables: () => readonly string[]): boolean {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version >= STAMPS_VERSION) {
        const seq = db.prepare(`SELECT generation FROM ${STAMP_SEQ_TABLE} WHERE id=1`).get() as
            | { generation: string }
            | undefined;
        if (seq && !STAMP_GENERATION.test(seq.generation)) {
            restartGeneration(db);
        }
        return false;
    }
    const generation = newGeneration();
    db.exec(
        `CREATE TABLE IF NOT EXISTS ${STAMP_SEQ_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${STAMP_GENERATIONS_TABLE} (id INTEGER PRIMARY KEY, generation TEXT NOT NULL UNIQUE);`,
    );
    const columns = db.prepare(`PRAGMA table_info(${WRITER_TABLE})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name.toLowerCase() === 'stampfloor')) {
        db.exec(`ALTER TABLE ${WRITER_TABLE} ADD COLUMN stampFloor INTEGER`);
    }
    db.prepare(`INSERT INTO ${STAMP_GENERATIONS_TABLE} (generation) VALUES (?)`).run(generation);
    // The sequence's first value: the backfill's stamp.
    db.prepare(`INSERT OR REPLACE INTO ${STAMP_SEQ_TABLE} (id, value, generation) VALUES (1, 1, ?)`).run(generation);
    for (const table of tables()) {
        syncStamps(db, table);
    }
    db.exec(`PRAGMA user_version=${STAMPS_VERSION}`);
    return true;
}

/** A table's primary key columns, in key order; none without one. */
export function keyColumns(db: DatabaseSync, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string; pk: number }>)
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
}

/** The stored key of row `alias` (`new`, `old` or a table alias). */
const keyOf = (alias: string, keys: readonly string[]) =>
    `json_array(${keys
        .map(
            (name) =>
                `CASE typeof(${alias}.${quoted(name)}) WHEN 'blob' THEN json_object('$blob', hex(${alias}.${quoted(name)})) ELSE ${alias}.${quoted(name)} END`,
        )
        .join(', ')})`;
/** Now, in ms, as a tombstone's `deleted`. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/**
 * Makes a table's stamps match it: `_stamps_<table>` and its three
 * triggers for a table with a primary key, backfilled with the current
 * stamp when the stamps table is new; nothing (and nothing left) for one
 * without. Run again when the table's columns change (the update trigger
 * names them all, to skip an update that changed nothing).
 */
export function syncStamps(db: DatabaseSync, table: string) {
    const keys = keyColumns(db, table);
    if (!keys.length) {
        dropStamps(db, table);
        return false;
    }
    const names = (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>).map((column) =>
        quoted(column.name),
    );
    const stamps = quoted(stampsTable(table));
    const made = !hasTable(db, stampsTable(table));
    const source = `FROM ${STAMP_SEQ_TABLE} s JOIN ${STAMP_GENERATIONS_TABLE} g ON g.generation = s.generation WHERE s.id = 1`;
    const upsert = (key: string, deleted: string, when = '') =>
        `INSERT INTO ${stamps} (key, stamp, gen, deleted) SELECT ${key}, s.value, g.id, ${deleted} ${source}${when} ON CONFLICT (key) DO UPDATE SET stamp = excluded.stamp, gen = excluded.gen, deleted = excluded.deleted;`;
    const insert = quoted(stampTrigger('insert', table));
    const update = quoted(stampTrigger('update', table));
    const remove = quoted(stampTrigger('delete', table));
    db.exec(
        `CREATE TABLE IF NOT EXISTS ${stamps} (key TEXT PRIMARY KEY, stamp INTEGER NOT NULL, gen INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS ${quoted(stampIndex(table))} ON ${stamps} (stamp, key);
      DROP TRIGGER IF EXISTS ${insert}; DROP TRIGGER IF EXISTS ${update}; DROP TRIGGER IF EXISTS ${remove};
      CREATE TRIGGER ${insert} AFTER INSERT ON ${quoted(table)} BEGIN ${upsert(keyOf('new', keys), '0')} END;
      CREATE TRIGGER ${update} AFTER UPDATE ON ${quoted(table)} WHEN ${names.map((name) => `old.${name} IS NOT new.${name}`).join(' OR ')} BEGIN ${upsert(keyOf('old', keys), NOW_MS, ` AND ${keyOf('old', keys)} IS NOT ${keyOf('new', keys)}`)} ${upsert(keyOf('new', keys), '0')} END;
      CREATE TRIGGER ${remove} AFTER DELETE ON ${quoted(table)} BEGIN ${upsert(keyOf('old', keys), NOW_MS)} END;`,
    );
    if (made) {
        db.exec(
            `INSERT INTO ${stamps} (key, stamp, gen, deleted) SELECT ${keyOf('r', keys)}, s.value, g.id, 0 FROM ${quoted(table)} r, ${STAMP_SEQ_TABLE} s JOIN ${STAMP_GENERATIONS_TABLE} g ON g.generation = s.generation WHERE s.id = 1 ON CONFLICT (key) DO NOTHING;`,
        );
    }
    return true;
}

/**
 * Restamps every live row of a table with the current write (a column
 * added: each row gained a field, so no cached copy of it is current).
 */
export function restampLive(db: DatabaseSync, table: string) {
    db.exec(
        `UPDATE ${quoted(stampsTable(table))} SET stamp = (SELECT value FROM ${STAMP_SEQ_TABLE} WHERE id = 1), gen = (SELECT g.id FROM ${STAMP_SEQ_TABLE} s JOIN ${STAMP_GENERATIONS_TABLE} g ON g.generation = s.generation WHERE s.id = 1) WHERE deleted = 0`,
    );
}

/** Drops a table's stamps and their triggers (a table deleted or moved away). */
export function dropStamps(db: DatabaseSync, table: string) {
    db.exec(
        `DROP TRIGGER IF EXISTS ${quoted(stampTrigger('insert', table))}; DROP TRIGGER IF EXISTS ${quoted(stampTrigger('update', table))}; DROP TRIGGER IF EXISTS ${quoted(stampTrigger('delete', table))};
      DROP TABLE IF EXISTS ${quoted(stampsTable(table))};`,
    );
}

/** Raises the floor: no `since` below `value` is answered with rows any more. */
export function raiseFloor(db: DatabaseSync, value: number) {
    if (hasTable(db, STAMP_SEQ_TABLE)) {
        db.prepare(`UPDATE ${WRITER_TABLE} SET stampFloor=max(coalesce(stampFloor, 0), ?) WHERE id=1`).run(value);
    }
}

/** Raises the floor to the current stamp: a dropped table's tombstones are gone with it. */
export function raiseFloorToNow(db: DatabaseSync) {
    if (hasTable(db, STAMP_SEQ_TABLE)) {
        db.exec(
            `UPDATE ${WRITER_TABLE} SET stampFloor=max(coalesce(stampFloor, 0), (SELECT value FROM ${STAMP_SEQ_TABLE} WHERE id=1)) WHERE id=1`,
        );
    }
}

/** The tables with stamps in a file, by their table's name. */
export function stampedTables(db: DatabaseSync): string[] {
    return db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB ?")
        .all(`${STAMPS_PREFIX}*`)
        .map((row) => String(row.name).slice(STAMPS_PREFIX.length));
}

/**
 * Deletes up to `chunk` tombstones of a table older than `before` (ms) and
 * raises the floor past them, in the caller's transaction. How many went.
 */
export function pruneTombstones(db: DatabaseSync, table: string, before: number, chunk: number) {
    const stamps = quoted(stampsTable(table));
    const gone = db
        .prepare(`SELECT rowid AS r, stamp FROM ${stamps} WHERE deleted > 0 AND deleted < ? LIMIT ?`)
        .all(before, chunk) as Array<{ r: number; stamp: number }>;
    if (!gone.length) {
        return 0;
    }
    raiseFloor(
        db,
        gone.reduce((max, row) => Math.max(max, Number(row.stamp)), 0),
    );
    db.prepare(`DELETE FROM ${stamps} WHERE rowid IN (SELECT value FROM json_each(?))`).run(
        JSON.stringify(gone.map((row) => Number(row.r))),
    );
    return gone.length;
}

/**
 * The wire's row key (JCS JSON, `rowKey`) of a stored key; undefined for
 * one the wire can't name: a blob or NULL key value (SQLite lets several
 * rows share a NULL key), or an integer past 2^53 (JSON readers round it),
 * which only a full read tells apart.
 */
export function wireKey(stored: string): string | undefined {
    try {
        // An integer past 2^53 can't be told from its neighbors once parsed.
        let unsafe = false;
        const values = JSON.parse(stored, (_key, value: unknown, context?: { source?: string }) => {
            if (typeof value === 'number' && /^-?\d+$/.test(context?.source ?? '') && !Number.isSafeInteger(value)) {
                unsafe = true;
            }
            return value;
        }) as unknown;
        if (
            unsafe ||
            !Array.isArray(values) ||
            !values.length ||
            values.some((value) => value === null || typeof value === 'object')
        ) {
            return undefined;
        }
        return rowKey(values as KeyValue[]);
    } catch {
        return undefined;
    }
}

/** Where a paged changes read goes on from: the last row it sent, by stamp and key. */
interface ChangesCursor {
    generation: string;
    stamp: number;
    key: string;
}
export function encodeChangesCursor(cursor: ChangesCursor): string {
    return Buffer.from(JSON.stringify([cursor.generation, cursor.stamp, cursor.key])).toString('base64url');
}
export function decodeChangesCursor(text: string): ChangesCursor | undefined {
    try {
        const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
        if (
            Array.isArray(value) &&
            value.length === 3 &&
            typeof value[0] === 'string' &&
            STAMP_GENERATION.test(value[0]) &&
            Number.isSafeInteger(value[1]) &&
            value[1] >= 0 &&
            typeof value[2] === 'string'
        ) {
            return { generation: value[0], stamp: value[1] as number, key: value[2] };
        }
    } catch {
        // Not a cursor.
    }
    return undefined;
}

/** A changes answer without its schema number (`RowChanges`). */
export interface ChangesPage {
    token: string;
    reconcile?: true;
    resync?: true;
    upserts: Array<{ key: string; stamp: string; values: Record<string, unknown> }>;
    deleted: Array<{ key: string; stamp: string }>;
    next: string | null;
}

/**
 * One page of a keyed table's changes after `since`, in stamp order (then
 * key), read in the caller's read transaction. `since` must be in the
 * file's current generation and at or above its floor; otherwise the
 * answer is `reconcile` with no rows. Live rows come with all their
 * fields (`cell`: blobs as `{ $blob: true }`); deleted ones as tombstones.
 */
export function readChanges(
    db: DatabaseSync,
    table: string,
    state: StampState,
    sinceText: string,
    cursorText: string | undefined,
    limit: number,
    cell: (value: unknown) => unknown,
): ChangesPage | 'bad-since' | 'bad-cursor' {
    const token = formatStamp(state.generation, state.value);
    const since = parseStamp(sinceText);
    if (!since) {
        return 'bad-since';
    }
    const cursor = cursorText === undefined ? undefined : decodeChangesCursor(cursorText);
    if (cursorText !== undefined && (!cursor || cursor.stamp < since.value)) {
        return 'bad-cursor';
    }
    if (
        since.generation !== state.generation ||
        since.value < state.floor ||
        since.value > state.value ||
        (cursor && cursor.generation !== state.generation)
    ) {
        return { token, reconcile: true, upserts: [], deleted: [], next: null };
    }
    const keys = keyColumns(db, table);
    const from = cursor ? '(s.stamp, s.key) > (?, ?)' : 's.stamp > ?';
    const join = keys.map((name, index) => `r.${quoted(name)} = (s.key ->> ${index})`).join(' AND ');
    // Whether the live row was found: a key the join can't match (a blob or
    // NULL key value) has a stamp but no row to send.
    const found = keys.map((name) => `r.${quoted(name)} IS NOT NULL`).join(' AND ');
    const statement = db.prepare(
        `SELECT s.key, s.stamp, g.generation, s.deleted, ${found}, r.* FROM ${quoted(stampsTable(table))} s JOIN ${STAMP_GENERATIONS_TABLE} g ON g.id = s.gen LEFT JOIN ${quoted(table)} r ON s.deleted = 0 AND ${join} WHERE ${from} ORDER BY s.stamp, s.key LIMIT ?`,
    );
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement
        .columns()
        .slice(5)
        .map((column) => column.name);
    const rows = statement.all(
        ...(cursor ? [cursor.stamp, cursor.key] : [since.value]),
        limit + 1,
    ) as unknown as unknown[][];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const upserts: ChangesPage['upserts'] = [];
    const deleted: ChangesPage['deleted'] = [];
    for (const [stored, stamp, generation, gone, live, ...values] of page) {
        const key = wireKey(String(stored));
        if (key === undefined) {
            // A row the wire can't name changed: only a new read is right.
            return { token, resync: true, upserts: [], deleted: [], next: null };
        }
        const wire = formatStamp(String(generation), Number(stamp));
        if (Number(gone)) {
            deleted.push({ key, stamp: wire });
        } else if (Number(live)) {
            upserts.push({
                key,
                stamp: wire,
                values: Object.fromEntries(columns.map((name, index) => [name, cell(values[index])])),
            });
        }
    }
    if (!more) {
        return { token, upserts, deleted, next: null };
    }
    const last = page.at(-1)!;
    return {
        // Everything at or below the stamp before the last one's is sent: a
        // client that stops here goes on from there.
        token: formatStamp(state.generation, Math.max(since.value, Number(last[1]) - 1)),
        upserts,
        deleted,
        next: encodeChangesCursor({ generation: state.generation, stamp: Number(last[1]), key: String(last[0]) }),
    };
}
