/**
 * Renames a user id everywhere, offline (CB-338): the operator's bootstrap
 * id `alice` becomes an id of the owner's choosing. Run as
 * `backup rename-user <old> <new>` (backup-cli.ts) while the app is
 * stopped, after a backup; a dry run unless `--apply`.
 *
 * What it changes, found from the database itself rather than a list:
 * - every text column of every table whose value is exactly the old id
 *   (users.id, the owner, actor, author and audit columns, auth_user.appUserId);
 * - ids embedded in keys and JSON: a JSON string that is the old id, at any
 *   depth and in JSON nested in a string (`"userId":"alice"`), and the old id
 *   as a segment of a key with no spaces (`tasks:alice`, `tg:1:dm#alice~x`).
 *   Prose that mentions it (a page, an issue, an audit line) is left alone;
 * - the data space's files, sealed for `<owner>/<file id>`: each is opened,
 *   sealed again for the new owner under the current key, and written to the
 *   new owner's key. The old S3 objects are left for the backup's sake;
 * - MCP connection credentials, whose sealed body names their owner;
 * - the user's folder under USER_DATA_DIR (datasets and local files);
 * - the analytics file, derived data the app rebuilds when it is missing;
 * - `person_seeds`: the id the person's derived ids come from (the opaque
 *   ids mini apps and plugins see, coding volume keys) stays the first one,
 *   so apps and plugins keep seeing the same person. It is the one place the
 *   old id is kept, on purpose, and the leftover check leaves it out.
 *
 * Audit tables' append-only guards are lifted for the rename alone, inside
 * its transaction. It refuses when the new id is taken, when a runtime is live, and when a
 * file can't be opened. All database changes are one transaction; after them,
 * every text column is scanned for the old id, and any exact match left
 * rolls everything back.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import type { ObjectStore, StorageDriver } from '@socio/data/object-store';
import { openDatabase } from '@socio/data/open';
import { storedPersonSeed } from '@socio/data/person-seed';
import { objectKey, userDirName } from '@socio/data/storage/keys';
import { storageSettingsFromEnv } from '@socio/data/storage/settings';
import { dataKeysFromEnv } from '@socio/foundation/keys/data-keys';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { nonPersonOwnerId } from '@socio/shared/data-types';

/** A user id the app accepts (MOCK_USERS, AUTH_OPERATOR_LINK). */
const USER_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Characters that continue an id: around a match, it's part of something longer. */
const ID_CHAR = 'A-Za-z0-9_.@+-';

/**
 * Where a renamed person's derived ids keep coming from (@socio/data/person-seed):
 * the one place the old id stays, on purpose, so apps, plugins and coding
 * volumes keep seeing the same person. Not rewritten, not a leftover.
 */
const SEEDS = 'person_seeds';

/** The cache-invalidation counters (`kind:<user>`): merged, never conflicting. */
const COUNTERS = 'change_counters';

export interface RenameUserOptions {
    db: DatabaseSync;
    from: string;
    to: string;
    /** Changes nothing unless set (the default is a dry run). */
    apply: boolean;
    /** USER_DATA_DIR. */
    userDataDir: string;
    /** `analytics/` next to the database, derived data removed on apply. */
    analyticsDir?: string;
    /** The data space's files: the `data-files` box, the tenant and the stores. */
    files: {
        box: SecretBox;
        tenantId: string;
        store: (driver: StorageDriver) => ObjectStore | undefined;
    };
    /** The `mcp-credentials` box. */
    mcpBox: SecretBox;
    now?: () => number;
    print?: (line: string) => void;
}

export interface ColumnCount {
    table: string;
    column: string;
    exact: number;
    /** In keys and JSON, rewritten. */
    embedded: number;
    /** In prose, left as is. */
    prose: number;
}

export interface RenameUserReport {
    applied: boolean;
    columns: ColumnCount[];
    files: { s3: number; local: number; missing: number; unreadable: number };
    mcpCredentials: number;
    /** The id the person's derived ids keep coming from (`person_seeds`), when the table exists. */
    seed?: string;
    folder?: { from: string; to: string; entries: number };
    analytics: string[];
    warnings: string[];
    /** Exact matches of the old id left after the rename (none, or it rolled back). */
    leftovers: Array<{ table: string; column: string; count: number }>;
}

export class RenameUserError extends Error {}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The rewrite of one stored text: the id itself, a key that has it as a
 * segment, or JSON that has it as a string (also JSON in a string). Prose,
 * any text with whitespace that isn't JSON, is returned as it was.
 */
export function idRewriter(from: string, to: string) {
    const segment = new RegExp(`(?<![${ID_CHAR}])${escapeRe(from)}(?![${ID_CHAR}])`, 'g');
    const literal = /"(?:[^"\\]|\\.)*"/g;
    const parses = (text: string) => {
        try {
            JSON.parse(text);
            return true;
        } catch {
            return false;
        }
    };
    const asJson = (text: string, depth: number): string =>
        text.replace(literal, (raw) => {
            if (!raw.includes(from)) {
                return raw;
            }
            const value = JSON.parse(raw) as string;
            const next = rewrite(value, depth + 1);
            return next === value ? raw : JSON.stringify(next);
        });
    const rewrite = (text: string, depth = 0): string => {
        if (text === from) {
            return to;
        }
        if (!text.includes(from) || depth > 8) {
            return text;
        }
        const trimmed = text.trimStart();
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && parses(text)) {
            return asJson(text, depth);
        }
        if (/\s/.test(text)) {
            return text;
        }
        return text.replace(segment, to);
    };
    return (text: string) => rewrite(text);
}

interface TableInfo {
    name: string;
    /** `rowid`, or the primary key's columns for a WITHOUT ROWID table. */
    key: string[];
    columns: string[];
}

/**
 * The app's tables and their stored columns, from the schema: not the
 * virtual (full-text) tables nor their shadow tables, which the triggers of
 * their content tables keep, and not generated columns.
 */
export function storedTables(db: DatabaseSync): TableInfo[] {
    const all = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .all() as Array<{ name: string; sql: string | null }>;
    const virtual = all.filter((t) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? '')).map((t) => t.name);
    const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
    return all
        .filter((t) => !virtual.includes(t.name) && !shadow(t.name))
        .map((t) => {
            const info = db.prepare(`PRAGMA table_xinfo(${quote(t.name)})`).all() as Array<{
                name: string;
                pk: number;
                hidden: number;
            }>;
            const columns = info.filter((c) => c.hidden === 0).map((c) => c.name);
            const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(t.sql ?? '');
            const key = withoutRowid
                ? info
                      .filter((c) => c.pk > 0)
                      .sort((a, b) => a.pk - b.pk)
                      .map((c) => c.name)
                : ['rowid'];
            return { name: t.name, key, columns };
        })
        .sort((a, b) => Number(a.name === COUNTERS) - Number(b.name === COUNTERS) || a.name.localeCompare(b.name));
}

/** Every stored text column holding exactly `id`, with its count. */
export function exactMatches(db: DatabaseSync, id: string) {
    const found: Array<{ table: string; column: string; count: number }> = [];
    for (const table of storedTables(db)) {
        for (const column of table.columns) {
            if (table.name === SEEDS && column === 'seed') {
                continue;
            }
            const { n } = db
                .prepare(
                    `SELECT count(*) AS n FROM ${quote(table.name)} WHERE typeof(${quote(column)}) = 'text' AND ${quote(column)} = ?`,
                )
                .get(id) as { n: number };
            if (n) {
                found.push({ table: table.name, column, count: n });
            }
        }
    }
    return found;
}

interface FilePlan {
    id: string;
    storage: StorageDriver;
    from: string;
    to: string;
    sealed?: Buffer;
    sealKey?: string;
}

/**
 * Renames `from` to `to` (see the file's comment). A dry run reads
 * everything the rename would, opens every file, and changes nothing.
 */
export async function renameUser(options: RenameUserOptions): Promise<RenameUserReport> {
    const { db, from, to, apply } = options;
    const now = options.now ?? Date.now;
    const print = options.print ?? (() => {});
    if (!from || from === to) {
        throw new RenameUserError('Give the old id and a different new id.');
    }
    if (!USER_ID.test(to) || nonPersonOwnerId(to)) {
        throw new RenameUserError(
            `The new id must be lowercase letters, digits, - and _ (at most 63, starting with a letter or digit): ${JSON.stringify(to)}.`,
        );
    }
    if (nonPersonOwnerId(from)) {
        throw new RenameUserError('That id is a socio’s shared area or a plugin, not a person.');
    }
    const one = (sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as unknown;
    const has = (table: string) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
    if (!has('users') || !one('SELECT 1 FROM users WHERE id=?', from)) {
        throw new RenameUserError(`No user ${from}.`);
    }
    if (one('SELECT 1 FROM users WHERE id=?', to)) {
        throw new RenameUserError(`The id ${to} is taken: a user has it already.`);
    }
    if (has('auth_user') && one('SELECT 1 FROM auth_user WHERE appUserId=?', to)) {
        throw new RenameUserError(`The id ${to} is taken: a sign-in account is linked to it.`);
    }
    if (has(SEEDS) && one(`SELECT 1 FROM ${SEEDS} WHERE userId=?`, to)) {
        throw new RenameUserError(`The id ${to} is taken: it has a person seed.`);
    }
    // The id the person's derived ids come from: kept across renames.
    const seed = has(SEEDS) ? storedPersonSeed(db, from) : undefined;
    const fromDir = join(options.userDataDir, userDirName(from));
    const toDir = join(options.userDataDir, userDirName(to));
    if (existsSync(toDir)) {
        throw new RenameUserError(`The id ${to} is taken: ${toDir} exists.`);
    }
    const live = has('runtime_instances')
        ? (
              db
                  .prepare('SELECT count(*) AS n FROM runtime_instances WHERE releasedAt IS NULL AND expiresAt > ?')
                  .get(now()) as { n: number }
          ).n
        : 0;
    if (live) {
        const line = `${live} runtime(s) of the app are live: stop the app (and wait for its lease to end) first.`;
        if (apply) {
            throw new RenameUserError(line);
        }
        print(`Note: ${line}`);
    }
    const extractions =
        has('gateway_extractions') &&
        (
            one('SELECT count(*) AS n FROM gateway_extractions WHERE personId=? AND removedAt IS NULL', from) as {
                n: number;
            }
        ).n;
    if (extractions) {
        // Sealed for their person: they'd be unreadable. They expire on their own.
        const line = `${extractions} repository extraction(s) of ${from} are still held; wait for them to expire.`;
        if (apply) {
            throw new RenameUserError(line);
        }
        print(`Note: ${line}`);
    }

    const report: RenameUserReport = {
        applied: false,
        columns: [],
        files: { s3: 0, local: 0, missing: 0, unreadable: 0 },
        mcpCredentials: 0,
        analytics: [],
        warnings: [],
        leftovers: [],
    };

    // The files: read and opened in both modes; sealed and written on apply.
    const files: FilePlan[] = [];
    const { box, tenantId } = options.files;
    const fileRows = has('data_files')
        ? (db.prepare('SELECT id, storage FROM data_files WHERE ownerUserId=? ORDER BY id').all(from) as Array<{
              id: string;
              storage: StorageDriver;
          }>)
        : [];
    for (const row of fileRows) {
        const store = options.files.store(row.storage);
        const plan: FilePlan = {
            id: row.id,
            storage: row.storage,
            from: objectKey(row.storage, tenantId, from, row.id),
            to: objectKey(row.storage, tenantId, to, row.id),
        };
        if (!store) {
            throw new RenameUserError(`File ${row.id} is in ${row.storage} storage, which isn’t configured here.`);
        }
        const sealed = await store.get(plan.from);
        if (!sealed) {
            report.files.missing++;
            continue;
        }
        let data: Buffer;
        try {
            data = box.openBytes(sealed, `${from}/${row.id}`);
        } catch {
            report.files.unreadable++;
            print(`Can't open file ${row.id} (${row.storage}).`);
            continue;
        }
        if (apply) {
            plan.sealed = box.sealBytes(data, `${to}/${row.id}`);
            plan.sealKey = box.currentKey;
        }
        data.fill(0);
        report.files[row.storage === 's3' ? 's3' : 'local']++;
        files.push(plan);
    }
    if (report.files.unreadable) {
        throw new RenameUserError(
            `${report.files.unreadable} file(s) of ${from} can't be opened with the keys here; nothing was changed.`,
        );
    }

    // The database: counted in both modes, changed in one transaction on apply.
    const rewrite = idRewriter(from, to);
    const mcpRows =
        has('mcp_connections') &&
        (db.prepare('SELECT id, secret FROM mcp_connections WHERE userId=? AND secret IS NOT NULL').all(from) as Array<{
            id: string;
            secret: string;
        }>);
    // MCP credentials name their owner inside the seal: opened in both modes.
    const credentials: Array<{ id: string; value: { userId?: string } }> = [];
    for (const row of mcpRows || []) {
        let value: { userId?: string };
        try {
            value = options.mcpBox.open(row.secret) as { userId?: string };
        } catch {
            throw new RenameUserError(
                `MCP connection ${row.id}'s credentials can't be opened with the keys here; nothing was changed.`,
            );
        }
        if (value?.userId !== from) {
            throw new RenameUserError(
                `MCP connection ${row.id}'s credentials name another owner; nothing was changed.`,
            );
        }
        credentials.push({ id: row.id, value });
    }
    report.mcpCredentials = credentials.length;
    const tables = storedTables(db);
    const fkBefore = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
    /** Local files swapped in, each with its prior bytes kept until the commit. */
    const swapped: string[] = [];
    let moved = false;
    const updates = new Map<string, ReturnType<DatabaseSync['prepare']>>();
    db.exec('PRAGMA foreign_keys=OFF');
    // A dry run only reads: a live app's writes aren't held up.
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    // The append-only guards (BEFORE UPDATE … RAISE, no WHEN) of audit
    // tables, lifted inside the transaction and put back before its end.
    const guards = apply
        ? (
              db
                  .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
                  .all() as Array<{
                  name: string;
                  sql: string;
              }>
          ).filter(
              (t) =>
                  /\bBEFORE\s+UPDATE\b/i.test(t.sql) &&
                  !/\bWHEN\b/i.test(t.sql) &&
                  /\bRAISE\s*\(\s*(ABORT|FAIL|ROLLBACK)\b/i.test(t.sql),
          )
        : [];
    try {
        for (const guard of guards) {
            db.exec(`DROP TRIGGER ${quote(guard.name)}`);
        }
        for (const table of tables) {
            if (!table.key.length || table.name === SEEDS) {
                continue;
            }
            const counts = new Map<string, ColumnCount>();
            const count = (column: string) => {
                let entry = counts.get(column);
                if (!entry) {
                    entry = { table: table.name, column, exact: 0, embedded: 0, prose: 0 };
                    counts.set(column, entry);
                }
                return entry;
            };
            const where = table.columns.map((c) => `instr(${quote(c)}, ?) > 0`).join(' OR ');
            const keySelect = table.key.map((k, i) => `${quote(k)} AS k${i}`).join(', ');
            const keys = db
                .prepare(`SELECT ${keySelect} FROM ${quote(table.name)} WHERE ${where}`)
                .all(...table.columns.map(() => from)) as Array<Record<string, string | number>>;
            const keyWhere = table.key.map((k) => `${quote(k)} IS ?`).join(' AND ');
            const read = db.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${keyWhere}`);
            for (const keyRow of keys) {
                const keyValues = table.key.map((_, i) => keyRow[`k${i}`]);
                const row = read.get(...keyValues) as Record<string, unknown> | undefined;
                if (!row) {
                    continue;
                }
                const changes: Array<[string, string]> = [];
                for (const column of table.columns) {
                    const value = row[column];
                    if (typeof value !== 'string' || !value.includes(from)) {
                        continue;
                    }
                    const next = rewrite(value);
                    if (value === from) {
                        count(column).exact++;
                    } else if (next !== value) {
                        count(column).embedded++;
                    } else {
                        count(column).prose++;
                    }
                    if (next !== value) {
                        changes.push([column, next]);
                    }
                }
                if (!apply || !changes.length) {
                    continue;
                }
                const set = changes.map(([c]) => `${quote(c)} = ?`).join(', ');
                const sql = `UPDATE ${quote(table.name)} SET ${set} WHERE ${keyWhere}`;
                const update = () => {
                    let statement = updates.get(sql);
                    if (!statement) {
                        statement = db.prepare(sql);
                        updates.set(sql, statement);
                    }
                    statement.run(...changes.map(([, v]) => v), ...keyValues);
                };
                if (table.name === COUNTERS && changes.length === 1 && changes[0][0] === 'key') {
                    // A counter the triggers bumped for the new id meanwhile:
                    // one counter, past both values.
                    const target = changes[0][1];
                    const existing = one(`SELECT n FROM ${COUNTERS} WHERE key=?`, target) as { n: number } | undefined;
                    if (existing) {
                        db.prepare(`UPDATE ${COUNTERS} SET n = ? WHERE key=?`).run(
                            Number(existing.n) + Number(row.n) + 1,
                            target,
                        );
                        db.prepare('DELETE FROM change_counters WHERE key=?').run(String(row.key));
                        continue;
                    }
                }
                try {
                    update();
                } catch (error) {
                    throw new RenameUserError(
                        `Couldn't rewrite ${table.name} (${changes.map(([c]) => c).join(', ')}): ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
            report.columns.push(...counts.values());
        }

        if (apply) {
            if (seed !== undefined) {
                db.prepare('DELETE FROM person_seeds WHERE userId=?').run(from);
                if (seed !== to) {
                    db.prepare('INSERT INTO person_seeds(userId, seed) VALUES (?, ?)').run(to, seed);
                }
                report.seed = seed;
            }
            // The files' rows: under the current key, with their new size.
            const record = db.prepare('UPDATE data_files SET sealKey=?, storedSize=? WHERE id=?');
            for (const file of files) {
                record.run(file.sealKey!, file.sealed!.length, file.id);
            }
            for (const { id, value } of credentials) {
                db.prepare('UPDATE mcp_connections SET secret=? WHERE id=?').run(
                    options.mcpBox.seal({ ...value, userId: to }),
                    id,
                );
            }
            for (const guard of guards) {
                db.exec(guard.sql);
            }
            report.leftovers = exactMatches(db, from);
            if (report.leftovers.length) {
                throw new RenameUserError(
                    `The old id is still in ${report.leftovers.map((l) => `${l.table}.${l.column} (${l.count})`).join(', ')}; nothing was changed.`,
                );
            }
            if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > fkBefore) {
                throw new RenameUserError('The rename would break a foreign key; nothing was changed.');
            }
            // The objects, before the commit: the old ones stay where they were.
            for (const file of files) {
                const store = options.files.store(file.storage)!;
                if (file.storage === 'local') {
                    // In place, inside the user's folder, which moves below.
                    const path = join(options.userDataDir, file.from);
                    writeFileSync(`${path}.renaming`, file.sealed!, { mode: 0o600 });
                    renameSync(path, `${path}.prior`);
                    swapped.push(path);
                    renameSync(`${path}.renaming`, path);
                    continue;
                }
                await store.put(file.to, file.sealed!);
                const head = await store.head(file.to);
                if (head?.size !== file.sealed!.length) {
                    throw new RenameUserError(`File ${file.id} didn't store whole at ${file.to}; nothing was changed.`);
                }
            }
            if (existsSync(fromDir)) {
                renameSync(fromDir, toDir);
                moved = true;
            }
            db.exec('COMMIT');
            report.applied = true;
        } else {
            db.exec('ROLLBACK');
        }
    } catch (error) {
        if (db.isTransaction) {
            db.exec('ROLLBACK');
        }
        if (moved) {
            renameSync(toDir, fromDir);
        }
        for (const path of swapped) {
            rmSync(`${path}.renaming`, { force: true });
            if (existsSync(`${path}.prior`)) {
                renameSync(`${path}.prior`, path);
            }
        }
        throw error;
    } finally {
        db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
    }
    // Committed: the renamed files stay whatever happens now; a prior copy
    // that can't be removed is only reported.
    for (const path of swapped) {
        const prior = join(toDir, relative(fromDir, `${path}.prior`));
        try {
            rmSync(prior, { force: true });
        } catch (error) {
            report.warnings.push(
                `Couldn't remove ${prior} (${error instanceof Error ? error.message : String(error)}); delete it by hand.`,
            );
        }
    }
    if (existsSync(fromDir) || existsSync(toDir)) {
        const dir = report.applied ? toDir : fromDir;
        report.folder = { from: fromDir, to: toDir, entries: countEntries(dir) };
    }
    if (options.analyticsDir) {
        for (const name of ['ops.duckdb', 'ops.duckdb.wal']) {
            const path = join(options.analyticsDir, name);
            if (existsSync(path)) {
                report.analytics.push(path);
                if (report.applied) {
                    rmSync(path, { force: true });
                }
            }
        }
    }
    if (!report.applied && seed !== undefined) {
        report.seed = seed;
    }
    if (report.files.s3) {
        report.warnings.push(
            `The ${report.files.s3} old S3 object(s) under ${objectKey('s3', tenantId, from, '')} are left for the backup; delete them once the rename is kept.`,
        );
    }
    return report;
}

function countEntries(dir: string): number {
    let n = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        n += entry.isDirectory() ? 1 + countEntries(join(dir, entry.name)) : 1;
    }
    return n;
}

/** The report as lines, for the CLI. */
export function reportLines(report: RenameUserReport, from: string, to: string): string[] {
    const lines = [report.applied ? `Renamed ${from} to ${to}.` : `Dry run: ${from} → ${to} (nothing changed).`];
    lines.push('table.column\texact\tin keys/JSON\tin prose (left)');
    for (const c of report.columns) {
        lines.push(`${c.table}.${c.column}\t${c.exact}\t${c.embedded}\t${c.prose}`);
    }
    const total = report.columns.reduce((sum, c) => sum + c.exact + c.embedded, 0);
    lines.push(
        `Rows rewritten: ${total} value(s) in ${report.columns.filter((c) => c.exact + c.embedded).length} column(s).`,
    );
    lines.push(
        `Files: ${report.files.s3} in S3 and ${report.files.local} on disk sealed again for ${to}; ${report.files.missing} missing (rows renamed).`,
    );
    if (report.seed !== undefined) {
        lines.push(
            `Derived ids (apps, plugins, coding volumes): ${report.applied ? 'kept' : 'will be kept'}, from the person's ${report.seed === from ? 'old' : 'first'} id (person_seeds).`,
        );
    }
    if (report.mcpCredentials) {
        lines.push(`MCP credentials ${report.applied ? 'sealed again' : 'to seal again'}: ${report.mcpCredentials}.`);
    }
    if (report.folder) {
        lines.push(`Folder: ${report.folder.from} → ${report.folder.to} (${report.folder.entries} entries).`);
    }
    for (const path of report.analytics) {
        lines.push(`Analytics (rebuilt by the app): ${report.applied ? 'removed' : 'removes'} ${path}.`);
    }
    for (const warning of report.warnings) {
        lines.push(`Note: ${warning}`);
    }
    if (report.applied) {
        lines.push(`Check: no exact ${from} left in any text column.`);
    }
    return lines;
}

/**
 * `backup rename-user <old> <new> [--dry-run | --apply]` and
 * `backup rename-user --leftovers <id>` (backup-cli.ts), with the server's
 * environment; the entry builds the stores. Returns the exit code.
 */
export async function renameUserCommand(
    argv: string[],
    options: {
        env: Record<string, string | undefined>;
        database: string;
        userDataDir: string;
        local: ObjectStore;
        s3?: ObjectStore;
        /** Whether the database is behind this release's schema: refused, never migrated here. */
        behind: (db: DatabaseSync) => boolean;
        print?: (line: string) => void;
    },
): Promise<number> {
    const print = options.print ?? console.log;
    const { positionals, values } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            apply: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            leftovers: { type: 'string' },
        },
    });
    if (values.leftovers !== undefined) {
        const db = openDatabase(options.database, options.env);
        try {
            const found = exactMatches(db, values.leftovers);
            for (const f of found) {
                print(`${f.table}.${f.column}\t${f.count}`);
            }
            print(found.length ? `${found.length} column(s) still hold it.` : 'No text column holds it.');
            return found.length ? 1 : 0;
        } finally {
            db.close();
        }
    }
    const [from, to] = positionals;
    if (!from || !to || positionals.length !== 2 || (values.apply && values['dry-run'])) {
        throw new RenameUserError(RENAME_USER_USAGE);
    }
    const env = options.env;
    const keys = {
        ...dataKeysFromEnv(env),
        legacy: env.SESSION_SECRET?.trim() || randomBytes(32).toString('base64url'),
    };
    const storage = storageSettingsFromEnv(env);
    const db = openDatabase(options.database, env);
    try {
        if (options.behind(db)) {
            throw new RenameUserError(
                'This database isn’t on this release’s schema: start the app with it once first.',
            );
        }
        const report = await renameUser({
            db,
            from,
            to,
            apply: values.apply,
            userDataDir: options.userDataDir,
            // As the analytics process finds it (analytics-main.ts).
            analyticsDir: env.OPS_ANALYTICS_DIR?.trim() || join(dirname(options.database), 'analytics'),
            files: {
                box: new SecretBox(keys, 'data-files'),
                tenantId: storage.tenantId,
                store: (driver) => (driver === 's3' ? options.s3 : options.local),
            },
            mcpBox: new SecretBox(keys, 'mcp-credentials'),
            print,
        });
        for (const line of reportLines(report, from, to)) {
            print(line);
        }
        if (!report.applied) {
            print('Run again with --apply, with the app stopped and a fresh backup, to rename.');
        }
        return 0;
    } finally {
        // The writes stay in the WAL for the app (and Litestream) to pick up.
        db.close();
    }
}

export const RENAME_USER_USAGE =
    'Use: backup rename-user <old> <new> [--dry-run | --apply] | backup rename-user --leftovers <id>';
