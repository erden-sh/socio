import { spawn, type ChildProcess } from 'node:child_process';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { CellValue, QueryResult } from '@socio/shared/data-types';

import {
    DELETED_PREFIX,
    DENIED_FUNCTIONS,
    HISTORY_PREFIX,
    OLAP_PREFIX,
    STAMP_BUMP,
    STAMP_PREFIX,
    TRIGGER_PREFIX,
    WRITER_TABLE,
    WRITES_TABLE,
    READABLE_FUNCTIONS,
    READABLE_SYSTEM,
} from './sql.js';

export interface QueryJob {
    path: string;
    sql: string;
    params: Array<string | number | null>;
    maxRows: number;
    maxBytes: number;
}

/** One SQL run of a batch statement: its text and bound values. */
export interface BatchRun {
    sql: string;
    params: Array<string | number | null | Uint8Array>;
}

/**
 * A batch (`DataSpace.batch`): statements, each one or more runs of SQL the
 * data space checked (one statement each, no DDL), applied in one
 * transaction on the dataset's file in the runner's process.
 */
export interface BatchJob {
    path: string;
    /**
     * Each statement's runs, and the changes it must make (CB-475): any
     * other count rolls the whole batch back, naming the statement.
     */
    statements: Array<{ runs: BatchRun[]; expectChanges?: number }>;
    /** Who wrote, for row history: `plugin:<id>`, `dot:<id>` or a user id. */
    writer: string;
    /** Bytes the dataset's tables may grow to (its room). */
    maxBytes: number;
    /** DELETE on the dataset's tables: a plugin's own datasets only. */
    allowDelete: boolean;
    /**
     * This batch's mark, which its transaction records in `_writes` (as
     * `batch:<marker>`) as it commits: a batch stopped at its time limit
     * can be told committed or rolled back by looking for it.
     */
    marker: string;
    /**
     * What a statement's `RETURNING` rows may come to (CB-475): rows per
     * statement, and bytes over the whole batch. Past either the batch rolls
     * back: a write's rows are never cut short.
     */
    returningMaxRows: number;
    returningMaxBytes: number;
}

/** One write statement's outcome (CB-475), as D1's `meta` has it. */
export interface BatchStatementOutcome {
    changes: number;
    /** SQLite's `last_insert_rowid()` after it (a string past 2^53); meaningful after an INSERT. */
    lastInsertRowid: number | string | null;
    /** Its `RETURNING` rows, when it has a `RETURNING` clause. */
    columns?: string[];
    rows?: CellValue[][];
}

export interface BatchOutcome {
    changes: number[];
    results: BatchStatementOutcome[];
    sizes: { sizeBytes: number; historyBytes: number };
}

/**
 * A read batch (CB-475 companion, CB-474): SELECTs read from one snapshot,
 * each with the single query's caps; `maxTotalBytes` bounds the answer.
 */
export interface ReadBatchJob {
    path: string;
    statements: Array<{ sql: string; params: Array<string | number | null> }>;
    maxRows: number;
    maxBytes: number;
    maxTotalBytes: number;
}

/**
 * The query process: opens the dataset read-only and defensive, with an
 * authorizer that allows only SELECTs reading the dataset's own tables
 * (plus its schema and json_each/json_tree) and refuses PRAGMAs, ATTACH,
 * writes and the functions in DENIED_FUNCTIONS. The engine's row history
 * tables (`_history_*`, `_writes`, `_writer`) and deleted tables
 * (`_deleted_*`) aren't the dataset's: reading
 * them is refused, for the user, their Dots and tokens alike. Rows stop at the row and
 * byte caps. It has an empty environment and no access to the app's state.
 */
const CHILD = `
import { DatabaseSync, constants as C } from 'node:sqlite';
const DENIED = new Set(${JSON.stringify(DENIED_FUNCTIONS)});
const SYSTEM = new Set(${JSON.stringify([...READABLE_SYSTEM, ...READABLE_FUNCTIONS])});
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const hidden = (name) => { const lower = name.toLowerCase(); return lower.startsWith(${JSON.stringify(HISTORY_PREFIX)}) || lower.startsWith(${JSON.stringify(DELETED_PREFIX)}) || lower.startsWith(${JSON.stringify(OLAP_PREFIX)}) || lower.startsWith(${JSON.stringify(STAMP_PREFIX)}) || lower === ${JSON.stringify(WRITES_TABLE)} || lower === ${JSON.stringify(WRITER_TABLE)}; };
const TRIGGER = ${JSON.stringify(TRIGGER_PREFIX)};
const readAuthorizer = (tables) => (code, a, b, database) => {
  if (code === C.SQLITE_SELECT || code === C.SQLITE_RECURSIVE) return C.SQLITE_OK;
  if (code === C.SQLITE_FUNCTION) return DENIED.has(String(b).toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
  // A read without a database is of a CTE or subquery, not a table.
  if (code === C.SQLITE_READ) return database === null || (database === 'main' && (tables.has(String(a)) || SYSTEM.has(String(a).toLowerCase()))) ? C.SQLITE_OK : C.SQLITE_DENY;
  return C.SQLITE_DENY;
};
const datasetTables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'").all().map((r) => String(r.name)).filter((name) => !hidden(name)));
// A value's bytes as JSON in UTF-8, as the answer carries it.
const utf8 = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
// A SELECT's rows under the row and byte caps. \`bytes\` is what the answer
// keeps (its columns and the rows it returns), never a row it left out.
const select = (db, sql, params, maxRows, maxBytes) => {
  const started = performance.now();
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const columns = statement.columns().map((column) => column.name);
  const rows = [];
  let bytes = 2;
  let truncated = false;
  for (const row of statement.iterate(...params)) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const out = row.map(cell);
    const size = utf8(out) + 1;
    if (bytes + size > maxBytes) { truncated = true; break; }
    bytes += size;
    rows.push(out);
  }
  return { result: { columns, rows, truncated, ms: Math.round(performance.now() - started) }, bytes: bytes + utf8(columns) };
};
const cell = (v) => v === null || v === undefined ? null
  : typeof v === 'bigint' ? (v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : v.toString())
  : v instanceof Uint8Array ? { $blob: Buffer.from(v).toString('base64') }
  : v;
// A batch's sizes, as the engine measures them (engine.ts \`measure\`).
const measure = (db) => {
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const fileBytes = Number(db.prepare('PRAGMA page_count').get().page_count) * pageSize;
  const schema = Number(db.prepare("SELECT coalesce(sum(length(sql)), 0) AS bytes FROM sqlite_master WHERE (type='trigger' AND name GLOB ?) OR (type='table' AND (lower(name) GLOB ? OR lower(name) GLOB ? OR lower(name) GLOB ? OR lower(name) IN (?, ?)))").get(TRIGGER + '*', ${JSON.stringify(HISTORY_PREFIX)} + '*', ${JSON.stringify(DELETED_PREFIX)} + '*', ${JSON.stringify(STAMP_PREFIX)} + '*', ${JSON.stringify(WRITES_TABLE)}, ${JSON.stringify(WRITER_TABLE)}).bytes);
  const trees = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') AND rootpage > 0").all().filter((r) => hidden(String(r.tbl_name))).map((r) => String(r.name));
  const tables = trees.length ? Number(db.prepare('SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat WHERE aggregate=TRUE AND name IN (' + trees.map(() => '?').join(', ') + ')').get(...trees).bytes) : 0;
  // Free pages count with history, outside the quota (engine.ts \`measure\`, CB-369).
  const free = Number(db.prepare('PRAGMA freelist_count').get().freelist_count) * pageSize;
  const historyBytes = Math.min(fileBytes, Math.max(0, tables + schema + free));
  return { sizeBytes: fileBytes - historyBytes, historyBytes, pageSize };
};
// A batch: one transaction on a read-write, defensive connection. Its
// statements may read the dataset's tables (and its schema, json_each and
// json_tree, and CTEs), insert and update them, and delete from them only
// when allowed; the engine's own triggers may keep history. Nothing else:
// no DDL, PRAGMA, ATTACH, transactions, recursive CTEs or denied functions.
const batch = (job) => {
  let db;
  let mode = 'internal';
  let index = -1;
  try {
    db = new DatabaseSync(job.path, { allowExtension: false });
    db.enableDefensive(true);
    let tables = new Set();
    let lowerTables = new Set();
    let real = new Set();
    let triggers = new Set();
    db.setAuthorizer((code, a, b, database, inner) => {
      if (mode === 'internal') return C.SQLITE_OK;
      if (code === C.SQLITE_SELECT) return C.SQLITE_OK;
      if (code === C.SQLITE_FUNCTION) return DENIED.has(String(b).toLowerCase()) ? C.SQLITE_DENY : C.SQLITE_OK;
      // The engine's own history triggers, by their real names.
      const engine = inner !== null && inner !== undefined && triggers.has(String(inner));
      const table = String(a ?? '');
      if (code === C.SQLITE_READ) {
        // A read without a database is of a CTE or subquery, or (CB-475) of a
        // table a RETURNING subquery names, which SQLite passes as written and
        // without its database: a real table's name is checked as in main.
        if (database === null) {
          const lower = table.toLowerCase();
          if (!real.has(lower)) return C.SQLITE_OK;
          return lowerTables.has(lower) || SYSTEM.has(lower) || (engine && hidden(table)) ? C.SQLITE_OK : C.SQLITE_DENY;
        }
        if (database !== 'main') return C.SQLITE_DENY;
        return tables.has(table) || SYSTEM.has(table.toLowerCase()) || (engine && hidden(table)) ? C.SQLITE_OK : C.SQLITE_DENY;
      }
      if (database !== 'main') return C.SQLITE_DENY;
      if (code === C.SQLITE_INSERT || code === C.SQLITE_UPDATE) return tables.has(table) || (engine && hidden(table)) ? C.SQLITE_OK : C.SQLITE_DENY;
      if (code === C.SQLITE_DELETE) return job.allowDelete && tables.has(table) ? C.SQLITE_OK : C.SQLITE_DENY;
      return C.SQLITE_DENY;
    });
    // Recursive triggers: a REPLACE's implicit delete fires the history trigger too.
    db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA recursive_triggers=ON;');
    db.exec('BEGIN IMMEDIATE');
    tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%'").all().map((r) => String(r.name)).filter((name) => !hidden(name)));
    lowerTables = new Set([...tables].map((name) => name.toLowerCase()));
    real = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((r) => String(r.name).toLowerCase()));
    triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB ?").all(TRIGGER + '*').map((r) => String(r.name)));
    const before = measure(db);
    db.exec('PRAGMA max_page_count=' + Math.max(2, Math.floor((2 * job.maxBytes + before.historyBytes) / before.pageSize)));
    db.prepare(${JSON.stringify(`UPDATE ${WRITER_TABLE} SET writeId=(SELECT coalesce(max(id), 0) + 1 FROM ${WRITES_TABLE}), actor=?, at=? WHERE id=1`)}).run(job.writer, Date.now());
    // Its row stamp (CB-451): the file's sequence, once, before its first change.
    db.exec(${JSON.stringify(STAMP_BUMP)});
    const changes = [];
    const results = [];
    let returnedBytes = 0;
    mode = 'batch';
    for (index = 0; index < job.statements.length; index++) {
      const { runs, expectChanges } = job.statements[index];
      let n = 0;
      let rowid = null;
      let returned;
      for (const run of runs) {
        const statement = db.prepare(run.sql);
        // Row ids past 2^53 (the connection's last one too) read as BigInt, whichever branch runs.
        statement.setReadBigInts(true);
        if (!statement.columns().length) {
          const outcome = statement.run(...run.params);
          n += Number(outcome.changes);
          rowid = outcome.lastInsertRowid;
          continue;
        }
        // RETURNING (CB-475): every row, or the batch rolls back.
        statement.setReturnArrays(true);
        returned = { columns: statement.columns().map((column) => column.name), rows: [] };
        returnedBytes += utf8(returned.columns);
        // Its columns count even when no row follows.
        if (returnedBytes > job.returningMaxBytes) {
          throw Object.assign(new Error('returning'), { returning: true });
        }
        for (const row of statement.iterate(...run.params)) {
          const out = row.map(cell);
          returnedBytes += utf8(out) + 1;
          if (returned.rows.length >= job.returningMaxRows || returnedBytes > job.returningMaxBytes) {
            throw Object.assign(new Error('returning'), { returning: true });
          }
          returned.rows.push(out);
        }
        mode = 'internal';
        const meta = db.prepare('SELECT changes() AS n, last_insert_rowid() AS id');
        meta.setReadBigInts(true);
        const counted = meta.get();
        mode = 'batch';
        n += Number(counted.n);
        rowid = counted.id;
      }
      if (expectChanges !== undefined && expectChanges !== null && n !== expectChanges) {
        throw Object.assign(new Error('expectChanges'), { expect: { expected: expectChanges, actual: n } });
      }
      changes.push(n);
      results.push({ changes: n, lastInsertRowid: cell(rowid), ...(returned ? returned : {}) });
    }
    mode = 'internal';
    index = -1;
    const after = measure(db);
    // A dataset already over its quota may still change rows in place.
    if (after.sizeBytes > job.maxBytes && after.sizeBytes > before.sizeBytes) {
      db.exec('ROLLBACK');
      process.send({ ok: false, full: true, index: -1, error: 'full' });
      return;
    }
    // Its mark, in the same transaction: kept if and only if the batch is.
    db.prepare(${JSON.stringify(`INSERT INTO ${WRITES_TABLE} (id, actor, at) VALUES ((SELECT coalesce(max(id), 0) + 1 FROM ${WRITES_TABLE}), ?, ?)`)}).run('batch:' + job.marker, Date.now());
    db.exec('COMMIT');
    process.send({ ok: true, changes, results, sizes: { sizeBytes: after.sizeBytes, historyBytes: after.historyBytes } });
  } catch (error) {
    mode = 'internal';
    try { if (db && db.isTransaction) db.exec('ROLLBACK'); } catch {}
    const message = String(error && error.message ? error.message : error).slice(0, 300);
    process.send({ ok: false, index, full: /database or disk is full|SQLITE_FULL/i.test(message), error: message, ...(error && error.expect ? { expect: error.expect } : {}), ...(error && error.returning ? { returning: true } : {}) });
  } finally {
    try { db && db.close(); } catch {}
  }
};
// Compact file (CB-369): VACUUM rewrites the file without its free pages.
const vacuum = (job) => {
  let db;
  try {
    db = new DatabaseSync(job.path, { allowExtension: false });
    db.enableDefensive(true);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
    db.exec('VACUUM');
    const after = measure(db);
    process.send({ ok: true, sizes: { sizeBytes: after.sizeBytes, historyBytes: after.historyBytes } });
  } catch (error) {
    process.send({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
  } finally {
    try { db && db.close(); } catch {}
  }
};
// A read batch (CB-474): its SELECTs in one read transaction, so every one
// reads the same snapshot (the file's shared lock, held to the end: a
// writer's commit waits for it). Each statement's result goes back as it
// finishes, which restarts its time limit in the app's process.
const readBatch = (job) => {
  let db;
  let index = -1;
  try {
    db = new DatabaseSync(job.path, { readOnly: true, allowExtension: false });
    db.enableDefensive(true);
    db.exec('PRAGMA busy_timeout=2000');
    db.exec('BEGIN');
    // The first read: the snapshot starts here.
    const tables = datasetTables(db);
    db.setAuthorizer(readAuthorizer(tables));
    let total = 2;
    for (index = 0; index < job.statements.length; index++) {
      const { sql, params } = job.statements[index];
      const { result, bytes } = select(db, sql, params, job.maxRows, job.maxBytes);
      total += bytes;
      if (total > job.maxTotalBytes) {
        throw Object.assign(new Error('too big'), { tooBig: true });
      }
      process.send({ step: index, result });
    }
    db.setAuthorizer(null);
    db.exec('COMMIT');
    process.send({ ok: true });
  } catch (error) {
    process.send({ ok: false, index, tooBig: !!(error && error.tooBig), error: String(error && error.message ? error.message : error).slice(0, 300) });
  } finally {
    try { db && db.setAuthorizer(null); if (db && db.isTransaction) db.exec('ROLLBACK'); } catch {}
    try { db && db.close(); } catch {}
  }
};
process.on('message', (job) => {
  if (job.kind === 'batch') return batch(job);
  if (job.kind === 'vacuum') return vacuum(job);
  if (job.kind === 'readBatch') return readBatch(job);
  const started = performance.now();
  let db;
  try {
    db = new DatabaseSync(job.path, { readOnly: true, allowExtension: false });
    db.enableDefensive(true);
    // A write commits in the app process meanwhile: wait for it, briefly.
    db.exec('PRAGMA busy_timeout=2000');
    db.setAuthorizer(readAuthorizer(datasetTables(db)));
    const { result } = select(db, job.sql, job.params, job.maxRows, job.maxBytes);
    process.send({ ok: true, ...result, ms: Math.round(performance.now() - started) });
  } catch (error) {
    process.send({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
  } finally {
    try { db && db.close(); } catch {}
  }
});
`;

type Reply = ({ ok: true } & QueryResult) | { ok: false; error: string };

/**
 * Runs `data_query` statements in a small pool of separate Node processes,
 * so a statement that runs too long (a runaway recursive CTE, a huge join)
 * is stopped by killing its process at the timeout: node:sqlite has no
 * interrupt. Idle processes are reused; none holds the app open.
 */
export class QueryRunner {
    private idle: ChildProcess[] = [];
    private busy = new Set<ChildProcess>();
    private waiting: Array<() => void> = [];
    private closed = false;
    constructor(private options: { maxIdle?: number; maxConcurrent?: number } = {}) {}
    private spawn() {
        const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', CHILD], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced',
            // Never the app's environment: it holds the platform's secrets.
            env: {},
        });
        child.on('error', () => undefined);
        return child;
    }
    private park(child: ChildProcess) {
        this.busy.delete(child);
        if (this.closed || child.exitCode !== null || this.idle.length >= (this.options.maxIdle ?? 2)) {
            child.kill('SIGKILL');
        } else {
            child.unref();
            (child.channel as { unref?: () => void } | undefined)?.unref?.();
            this.idle.push(child);
        }
        this.waiting.shift()?.();
    }
    /**
     * An idle process, or a new one, once fewer than `maxConcurrent` are
     * busy (`readBatch`; `run` and `batch` take theirs inline, so a free
     * process starts their job before they first yield).
     */
    private async take(): Promise<ChildProcess> {
        if (this.closed) {
            throw new DataError('The data space is shutting down.', 409);
        }
        while (this.busy.size >= (this.options.maxConcurrent ?? 4)) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        let reused = this.idle.pop();
        while (reused && (!reused.connected || reused.exitCode !== null)) {
            reused = this.idle.pop();
        }
        const child = reused ?? this.spawn();
        this.busy.add(child);
        child.ref();
        (child.channel as { ref?: () => void } | undefined)?.ref?.();
        return child;
    }
    async run(job: QueryJob, timeoutMs: number): Promise<QueryResult> {
        if (this.closed) {
            throw new DataError('The data space is shutting down.', 409);
        }
        while (this.busy.size >= (this.options.maxConcurrent ?? 4)) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        let reused = this.idle.pop();
        while (reused && (!reused.connected || reused.exitCode !== null)) {
            reused = this.idle.pop();
        }
        const child = reused ?? this.spawn();
        this.busy.add(child);
        child.ref();
        (child.channel as { ref?: () => void } | undefined)?.ref?.();
        return new Promise<QueryResult>((resolve, reject) => {
            let settled = false;
            const finish = (park: boolean) => {
                settled = true;
                clearTimeout(timer);
                child.off('message', onMessage);
                child.off('exit', onExit);
                if (park) {
                    this.park(child);
                } else {
                    this.busy.delete(child);
                    child.kill('SIGKILL');
                    this.waiting.shift()?.();
                }
            };
            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                finish(false);
                reject(
                    new DataError(
                        `The query ran longer than ${Math.round(timeoutMs / 100) / 10} s and was stopped. Narrow it (WHERE, LIMIT) or aggregate less.`,
                        504,
                    ),
                );
            }, timeoutMs);
            const onMessage = (reply: Reply) => {
                if (settled) {
                    return;
                }
                finish(true);
                if (reply.ok) {
                    resolve({
                        columns: reply.columns,
                        rows: reply.rows,
                        truncated: reply.truncated,
                        ms: reply.ms,
                    });
                } else {
                    reject(queryError(reply.error));
                }
            };
            const onExit = () => {
                if (settled) {
                    return;
                }
                finish(false);
                reject(new DataError('The query stopped unexpectedly (out of memory?).', 400));
            };
            child.on('message', onMessage);
            child.once('exit', onExit);
            child.send(job);
        });
    }
    /**
     * Runs a batch in a runner process (`BatchJob`): all its statements in
     * one transaction, or none. Its SQL is the caller's (a plugin's, an
     * app's or a socio's), so it runs here, never in the app's process,
     * where a statement that runs long would stall everything: past
     * `timeoutMs` the process is killed, and once it is gone `recover`
     * opens the file, which rolls an unfinished transaction back, and says
     * whether the batch committed after all (its `marker` is in the file):
     * the child may have committed just before it was killed, with its
     * reply not yet read.
     */
    async batch(job: BatchJob, timeoutMs: number, recover: () => boolean): Promise<BatchOutcome> {
        if (this.closed) {
            throw new DataError('The data space is shutting down.', 409);
        }
        while (this.busy.size >= (this.options.maxConcurrent ?? 4)) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        let reused = this.idle.pop();
        while (reused && (!reused.connected || reused.exitCode !== null)) {
            reused = this.idle.pop();
        }
        const child = reused ?? this.spawn();
        this.busy.add(child);
        child.ref();
        (child.channel as { ref?: () => void } | undefined)?.ref?.();
        return new Promise<BatchOutcome>((resolve, reject) => {
            let settled = false;
            const done = () => {
                settled = true;
                clearTimeout(timer);
                child.off('message', onMessage);
                child.off('exit', onExit);
            };
            const lost = (error: DataError) => {
                done();
                this.busy.delete(child);
                const rolledBack = () => {
                    let committed: boolean | undefined;
                    try {
                        committed = recover();
                    } catch {
                        // The next write or read of the file rolls it back; whether it committed is unknown.
                    }
                    this.waiting.shift()?.();
                    reject(
                        committed === false
                            ? error
                            : new DataError(
                                  committed
                                      ? 'The batch committed as it was stopped: its changes were kept. Check the data before you send it again.'
                                      : 'The batch was stopped and whether it committed is not known. Check the data before you send it again.',
                                  504,
                              ),
                    );
                };
                if (child.exitCode !== null || child.signalCode !== null) {
                    rolledBack();
                } else {
                    child.once('exit', rolledBack);
                    child.kill('SIGKILL');
                }
            };
            const timer = setTimeout(() => {
                if (!settled) {
                    lost(
                        new DataError(
                            `The batch ran longer than ${Math.round(timeoutMs / 100) / 10} s and was stopped; nothing it did was kept. Split it, or narrow its statements.`,
                            504,
                        ),
                    );
                }
            }, timeoutMs);
            const onMessage = (reply: BatchReply) => {
                if (settled) {
                    return;
                }
                done();
                this.park(child);
                if (reply.ok) {
                    resolve({ changes: reply.changes, results: reply.results, sizes: reply.sizes });
                } else {
                    reject(batchError(reply, job));
                }
            };
            const onExit = () => {
                if (!settled) {
                    lost(
                        new DataError('The batch stopped unexpectedly (out of memory?); nothing it did was kept.', 400),
                    );
                }
            };
            child.on('message', onMessage);
            child.once('exit', onExit);
            child.send({ kind: 'batch', ...job });
        });
    }
    /**
     * Runs a read batch (`ReadBatchJob`, CB-474) in one runner process: its
     * SELECTs in one read transaction, so all of them read one snapshot.
     * Each statement has `timeoutMs`, restarted as each one's result comes
     * back, and the whole batch `totalTimeoutMs`; past either the process is
     * killed, which ends its transaction.
     */
    async readBatch(job: ReadBatchJob, timeoutMs: number, totalTimeoutMs: number): Promise<QueryResult[]> {
        const child = await this.take();
        return new Promise<QueryResult[]>((resolve, reject) => {
            const results: QueryResult[] = [];
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (park: boolean) => {
                settled = true;
                clearTimeout(timer);
                clearTimeout(total);
                child.off('message', onMessage);
                child.off('exit', onExit);
                if (park) {
                    this.park(child);
                } else {
                    this.busy.delete(child);
                    child.kill('SIGKILL');
                    this.waiting.shift()?.();
                }
            };
            const stop = (message: string) => {
                if (!settled) {
                    finish(false);
                    reject(new DataError(message, 504));
                }
            };
            const arm = () => {
                clearTimeout(timer);
                timer = setTimeout(
                    () =>
                        stop(
                            `Statement ${results.length + 1} ran longer than ${Math.round(timeoutMs / 100) / 10} s and was stopped. Narrow it (WHERE, LIMIT) or aggregate less.`,
                        ),
                    timeoutMs,
                );
            };
            const total = setTimeout(
                () =>
                    stop(
                        `The read batch ran longer than ${Math.round(totalTimeoutMs / 100) / 10} s and was stopped. Send fewer statements, or narrow them.`,
                    ),
                totalTimeoutMs,
            );
            const onMessage = (reply: ReadBatchReply) => {
                if (settled) {
                    return;
                }
                if ('step' in reply) {
                    results.push(reply.result);
                    arm();
                    return;
                }
                finish(true);
                if (reply.ok) {
                    resolve(results);
                } else if (reply.tooBig) {
                    reject(
                        new DataError(
                            `Statement ${reply.index + 1}: the batch's results passed ${Math.round(job.maxTotalBytes / 1024)} KB. Send fewer statements, or select fewer rows or columns.`,
                            413,
                        ),
                    );
                } else {
                    const error = queryError(reply.error);
                    reject(
                        reply.index >= 0
                            ? new DataError(`Statement ${reply.index + 1}: ${error.message}`, error.status)
                            : error,
                    );
                }
            };
            const onExit = () => {
                if (!settled) {
                    finish(false);
                    reject(new DataError('The read batch stopped unexpectedly (out of memory?).', 400));
                }
            };
            child.on('message', onMessage);
            child.once('exit', onExit);
            arm();
            child.send({ kind: 'readBatch', ...job });
        });
    }
    /**
     * Compacts a dataset file (`VACUUM`, CB-369) in a process of its own,
     * never reused: past `timeoutMs` it is killed, and `recover` opens the
     * file, which rolls the unfinished rewrite back.
     */
    async vacuum(
        job: { path: string },
        timeoutMs: number,
        recover: () => void,
    ): Promise<{ sizeBytes: number; historyBytes: number }> {
        if (this.closed) {
            throw new DataError('The data space is shutting down.', 409);
        }
        const child = this.spawn();
        this.busy.add(child);
        return new Promise((resolve, reject) => {
            let settled = false;
            const end = (error?: DataError, sizes?: { sizeBytes: number; historyBytes: number }) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                this.busy.delete(child);
                const after = () => {
                    if (error) {
                        try {
                            recover();
                        } catch {
                            // The next write or read of the file rolls it back.
                        }
                        reject(error);
                    } else {
                        resolve(sizes!);
                    }
                };
                if (child.exitCode !== null || child.signalCode !== null) {
                    after();
                } else {
                    child.once('exit', after);
                    child.kill('SIGKILL');
                }
            };
            const timer = setTimeout(
                () =>
                    end(
                        new DataError(
                            `Compacting ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped; the file is as it was.`,
                            504,
                        ),
                    ),
                timeoutMs,
            );
            child.on(
                'message',
                (
                    reply:
                        | { ok: true; sizes: { sizeBytes: number; historyBytes: number } }
                        | { ok: false; error: string },
                ) =>
                    reply.ok
                        ? end(undefined, reply.sizes)
                        : end(
                              new DataError(
                                  `Compacting failed: ${reply.error.replace(/^SQLITE_[A-Z_]+:?\s*/, '').slice(0, 200)}`,
                              ),
                          ),
            );
            child.once('exit', () =>
                end(new DataError('Compacting stopped unexpectedly; the file is as it was.', 400)),
            );
            child.send({ kind: 'vacuum', ...job });
        });
    }
    close() {
        this.closed = true;
        for (const child of [...this.idle, ...this.busy]) {
            child.kill('SIGKILL');
        }
        this.idle = [];
        this.busy.clear();
        for (const wake of this.waiting.splice(0)) {
            wake();
        }
    }
}

type BatchReply =
    | ({ ok: true } & BatchOutcome)
    | {
          ok: false;
          error: string;
          index: number;
          full?: boolean;
          expect?: { expected: number; actual: number };
          returning?: boolean;
      };

type ReadBatchReply =
    | { step: number; result: QueryResult }
    | { ok: true }
    | { ok: false; error: string; index: number; tooBig?: boolean };

/**
 * A batch statement that made another number of changes than its
 * `expectChanges` (CB-475): the whole batch rolled back. `index` is the
 * statement's, from 0; the message names it from 1, as other batch errors do.
 */
export class BatchExpectationError extends DataError {
    readonly code = 'expect_changes';
    constructor(
        readonly index: number,
        readonly expected: number,
        readonly actual: number,
    ) {
        super(
            `Statement ${index + 1} (index ${index}) expected ${expected} change(s) and made ${actual}. Nothing in the batch was kept.`,
            409,
        );
        this.name = 'BatchExpectationError';
    }
}

function batchError(reply: Extract<BatchReply, { ok: false }>, job: BatchJob) {
    if (reply.full) {
        return new DataError('The dataset is full: it reached its size quota. Nothing in the batch was kept.', 413);
    }
    if (reply.expect) {
        return new BatchExpectationError(reply.index, reply.expect.expected, reply.expect.actual);
    }
    if (reply.returning) {
        return new DataError(
            `Statement ${reply.index + 1}: its RETURNING rows passed ${job.returningMaxRows} rows, or the batch's passed ${Math.round(job.returningMaxBytes / 1024)} KB. Return fewer rows or columns. Nothing in the batch was kept.`,
            413,
        );
    }
    const at = reply.index >= 0 ? `Statement ${reply.index + 1}: ` : '';
    if (/not authorized|prohibited/i.test(reply.error)) {
        return new DataError(
            `${at}not allowed in a batch. A batch may read this dataset's tables and insert, update (and, for a plugin's own datasets, delete) their rows; no DDL, PRAGMA, ATTACH, transactions, recursive CTEs, or file and extension functions. Nothing in the batch was kept.`,
            403,
        );
    }
    return new DataError(
        `${at}${reply.error.replace(/^SQLITE_[A-Z_]+:?\s*/, '').slice(0, 260)}. Nothing in the batch was kept.`,
    );
}

function queryError(message: string) {
    if (/not authorized|prohibited/i.test(message)) {
        return new DataError(
            'Not allowed: data_query may only SELECT from this dataset’s tables (no PRAGMA, ATTACH, writes, or file and extension functions).',
            403,
        );
    }
    if (/readonly|read-only/i.test(message)) {
        return new DataError('Queries are read-only.', 403);
    }
    return new DataError(`The query failed: ${message}`);
}
