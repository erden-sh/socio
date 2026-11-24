import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { writePrivate } from '@socio/data/backup';
import { nextTurn } from '@socio/data/events';
import { dataKeyId, LEGACY_KEY, SEAL_PURPOSES, SecretBox, type SealPurpose } from '@socio/foundation/keys/secret-box';
import type {
    RecoveryKeyCheck,
    RecoveryKeyPurpose,
    RestoreDrillRestore,
    RestoreDrillResult,
    RestoreDrillStatus,
} from '@socio/shared/types';

import { LTX_NAME, ltxTimestamp } from './backup-ltx.js';
import { BACKUP_CONTEXT } from './backup-offsite.js';
import {
    type FileSample,
    type KeyCheckSources,
    type RestoreDrillShape,
    type SealedValues,
    type ServerKeyIds,
} from './contract.js';

const DAY = 86_400_000;
/** The point-in-time restore picks a moment this far back at most. */
export const DRILL_WINDOW_MS = 14 * DAY;
/** A failed drill runs again after a day, or the interval when shorter. */
const DRILL_RETRY_MS = DAY;
/** One `litestream restore` may take this long. */
const RESTORE_TIMEOUT_MS = 30 * 60_000;
/**
 * A table's rows in the latest restore off live by more than this many and
 * this share of them: a gross mismatch, which fails the drill.
 */
export const GROSS_ROWS = 100;
export const GROSS_SHARE = 0.1;
const DIFFERENCES_SHOWN = 20;
/** Litestream 0.5 keeps its snapshots in level 9. */
const SNAPSHOT_LEVEL = '9';
/** What `ltxTimestamp` reads: an LTX file's shortest frame (header and trailer). */
const LTX_HEAD = 116;

/**
 * `litestream restore`'s arguments, the only command the app runs: never
 * `replicate`, so the litestream service stays the replica's one writer.
 * A point in time goes as RFC 3339, to the millisecond.
 */
export function restoreArgs(replica: string, output: string, pointAt?: number) {
    return [
        'restore',
        ...(pointAt === undefined ? [] : ['-timestamp', new Date(pointAt).toISOString()]),
        '-o',
        output,
        pathToFileURL(resolve(replica)).href,
    ];
}

/**
 * Runs `litestream restore` with nothing of the app's environment but PATH:
 * a file replica needs no credentials, and it gets none.
 */
function litestreamRestore(bin: string, args: string[]) {
    return new Promise<void>((done, fail) => {
        execFile(
            bin,
            args,
            {
                env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
                timeout: RESTORE_TIMEOUT_MS,
                maxBuffer: 1 << 20,
            },
            (error, _stdout, stderr) => {
                if (!error) {
                    return done();
                }
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return fail(new Error('The litestream binary isn’t installed (LITESTREAM_BIN).'));
                }
                const last = String(stderr)
                    .trim()
                    .split('\n')
                    .at(-1)
                    ?.replace(/^Error:\s*/, '')
                    .slice(0, 160);
                fail(
                    new Error(`litestream restore ${error.killed ? 'timed out' : 'failed'}${last ? `: ${last}` : ''}.`),
                );
            },
        );
    });
}

/** An LTX file's timestamp from its header; undefined when it's gone or isn't one. */
function headerTime(path: string) {
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const head = Buffer.alloc(LTX_HEAD);
        return ltxTimestamp(head.subarray(0, readSync(fd, head, 0, LTX_HEAD, 0)));
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

/** A level's LTX files, oldest first; none when it can't be read. */
function levelFiles(replica: string, level: string) {
    try {
        return readdirSync(join(replica, 'ltx', level))
            .filter((name) => LTX_NAME.test(name))
            .sort()
            .map((name) => join(replica, 'ltx', level, name));
    } catch {
        return [];
    }
}

/**
 * What a point-in-time restore can reach in Litestream's file replica: from
 * its oldest snapshot to its newest file, by their headers' times. Only
 * each level's ends are read; a file compacted away meanwhile is skipped.
 */
export function restorableSpan(replica: string) {
    let from: number | undefined;
    for (const path of levelFiles(replica, SNAPSHOT_LEVEL)) {
        if ((from = headerTime(path)) !== undefined) {
            break;
        }
    }
    let to: number | undefined;
    let levels: string[] = [];
    try {
        levels = readdirSync(join(replica, 'ltx'));
    } catch {
        // No replica: nothing to restore.
    }
    for (const level of levels) {
        for (const path of levelFiles(replica, level).reverse()) {
            const at = headerTime(path);
            if (at === undefined) {
                continue;
            }
            if (to === undefined || at > to) {
                to = at;
            }
            break;
        }
    }
    return from !== undefined && to !== undefined ? { from, to } : undefined;
}

/**
 * The drill's point in time: a random moment of the last DRILL_WINDOW_MS
 * the replica covers. Litestream 0.5 refuses a moment past its newest
 * file ("timestamp does not exist"), so it's never later than that, nor
 * before the oldest snapshot; a copy older than the window gives a point
 * of its own span.
 */
export function drillPoint(span: { from: number; to: number }, now: number, random: () => number = Math.random) {
    const from = Math.min(Math.max(span.from, now - DRILL_WINDOW_MS), span.to);
    return Math.floor(from + random() * (span.to - from));
}

/** Rows per table, ordinary tables only (not SQLite's own or virtual ones). */
type Counts = Record<string, number>;

/** The integrity check and the row counts, run by a worker. */
const CHECK_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=5000');
  const ok = !workerData.integrity || db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  const counts = {};
  if (ok)
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").all())
      counts[name] = Number(db.prepare('SELECT COUNT(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get().n);
  parentPort.postMessage({ ok, counts });
} finally {
  db.close();
}`;

/**
 * `PRAGMA integrity_check` (when asked) and each table's rows, in a worker
 * thread: both read the whole file, and the server keeps answering.
 */
export function checkDatabase(path: string, integrity: boolean) {
    return new Promise<{ ok: boolean; counts: Counts }>((done, fail) => {
        const worker = new Worker(CHECK_WORKER, {
            eval: true,
            workerData: { path, integrity },
            execArgv: [],
        });
        worker.once('message', done);
        worker.once('error', (error) =>
            fail(
                new Error(
                    `The database couldn’t be read: ${error instanceof Error ? error.message : 'unknown error'}.`,
                ),
            ),
        );
        worker.once('exit', () => fail(new Error('The database check stopped.')));
    });
}

/**
 * The latest restore's rows against live, counted before and after it: a
 * table may hold anything between the two (writes since the last
 * replicated transaction), so only a difference beyond them is one. A
 * table live had before and after but the restore lacks is missing; one
 * off by more than GROSS_ROWS and GROSS_SHARE of live is a gross mismatch.
 */
export function compareCounts(restored: Counts, before: Counts, after: Counts) {
    const missing: string[] = [];
    const gross: string[] = [];
    const differences: { table: string; live: number; restored: number }[] = [];
    for (const table of Object.keys(after).sort()) {
        const rows = restored[table];
        const low = Math.min(after[table]!, before[table] ?? after[table]!);
        const high = Math.max(after[table]!, before[table] ?? after[table]!);
        if (rows === undefined) {
            // New since the drill began: not in the copy yet.
            if (table in before) {
                missing.push(table);
            }
            continue;
        }
        const live = rows < low ? low : rows > high ? high : rows;
        if (live === rows) {
            continue;
        }
        differences.push({ table, live, restored: rows });
        if (Math.abs(live - rows) > Math.max(GROSS_ROWS, GROSS_SHARE * high)) {
            gross.push(table);
        }
    }
    return { missing, differences, gross };
}

const names = (tables: string[]) =>
    tables.length > 3 ? `${tables.slice(0, 3).join(', ')} and ${tables.length - 3} more` : tables.join(', ');

export interface DrillRun {
    /** LITESTREAM_REPLICA_DIR: Litestream's file replica (read only). */
    replica: string;
    /** The live database, for its row counts. */
    databasePath: string;
    /** Scratch space on the backup volume: made empty, and removed after. */
    scratch: string;
    /** LITESTREAM_BIN: `litestream` on PATH by default. */
    litestream: string;
    /**
     * With the off-site copy: puts its newest lineage in `directory` as a
     * file replica, and says how many files it fetched.
     */
    offsite?: (directory: string) => Promise<{ files: number }>;
    /** A failure's short reason, naming no path or key. */
    reason: (error: unknown) => string;
    now?: () => number;
    random?: () => number;
}

/**
 * One restore drill (CB-111): restores the continuous copy into scratch
 * files and checks each with `PRAGMA integrity_check`, then removes them,
 * failed or not:
 *
 * - the latest point from the local replica, whose rows are compared with
 *   live (`compareCounts`);
 * - a random point of the last 14 days from it (`drillPoint`);
 * - with the off-site copy, the latest point of its newest lineage, fetched
 *   and opened as `fetch-ltx` does; it must have every table live has.
 *
 * Each runs even when one before it failed, so the result says all that's
 * wrong. Only `litestream restore` runs, never `replicate`.
 */
export async function runRestoreDrill(run: DrillRun): Promise<RestoreDrillResult> {
    const now = run.now ?? Date.now;
    const startedAt = now();
    const restores: RestoreDrillRestore[] = [];
    const failures: string[] = [];
    let tables: number | undefined;
    let differences: RestoreDrillResult['differences'];
    /** One restore into a scratch file and its check; its rows when it passed. */
    const attempt = async (
        source: RestoreDrillRestore['source'],
        label: string,
        replica: string,
        options: { pointAt?: number; fetch?: () => Promise<void> } = {},
    ) => {
        const began = now();
        const output = join(run.scratch, `${label.replace(/\W+/g, '-')}.sqlite`);
        const point = options.pointAt !== undefined ? { pointAt: options.pointAt } : {};
        try {
            await options.fetch?.();
            await litestreamRestore(run.litestream, restoreArgs(replica, output, options.pointAt));
            const checked = await checkDatabase(output, true);
            if (!checked.ok) {
                throw new Error('The restored database failed its integrity check.');
            }
            restores.push({ source, ...point, ok: true, durationMs: now() - began });
            return checked.counts;
        } catch (error) {
            const reason = run.reason(error);
            restores.push({
                source,
                ...point,
                ok: false,
                durationMs: now() - began,
                error: reason,
            });
            failures.push(`${label}: ${reason.replace(/\.$/, '')}`);
            return undefined;
        } finally {
            // Each one goes as soon as it's checked: the volume needs room for one.
            for (const suffix of ['', '-wal', '-shm']) {
                rmSync(`${output}${suffix}`, { force: true });
            }
        }
    };
    try {
        rmSync(run.scratch, { recursive: true, force: true });
        mkdirSync(run.scratch, { recursive: true, mode: 0o700 });
        const before = (await checkDatabase(run.databasePath, false)).counts;
        let after = before;
        const latest = await attempt('local', 'the latest restore', run.replica);
        if (latest) {
            after = (await checkDatabase(run.databasePath, false)).counts;
            const compared = compareCounts(latest, before, after);
            tables = Object.keys(latest).length;
            differences = compared.differences.slice(0, DIFFERENCES_SHOWN);
            if (compared.missing.length) {
                failures.push(`the latest restore lacks table(s) ${names(compared.missing)}`);
            }
            if (compared.gross.length) {
                failures.push(`the latest restore's rows are far from live in ${names(compared.gross)}`);
            }
        }
        const span = restorableSpan(run.replica);
        if (span) {
            await attempt('local', 'the point-in-time restore', run.replica, {
                pointAt: drillPoint(span, startedAt, run.random),
            });
        } else {
            failures.push('the replica has no snapshot to restore a point from');
        }
        if (run.offsite) {
            const directory = join(run.scratch, 'offsite');
            const fetch = run.offsite;
            const offsite = await attempt('offsite', 'the off-site restore', directory, {
                fetch: async () => {
                    if (!(await fetch(directory)).files) {
                        throw new Error('The off-site copy has no continuous copy files.');
                    }
                },
            });
            const lacking = offsite ? Object.keys(after).filter((table) => table in before && !(table in offsite)) : [];
            if (lacking.length) {
                failures.push(`the off-site restore lacks table(s) ${names(lacking)}`);
            }
        }
    } catch (error) {
        failures.push(run.reason(error).replace(/\.$/, ''));
    } finally {
        rmSync(run.scratch, { recursive: true, force: true });
    }
    const error = failures.join('; ');
    return {
        startedAt,
        durationMs: now() - startedAt,
        ok: !failures.length,
        ...(error ? { error: `${error[0]!.toUpperCase()}${error.slice(1)}.`.slice(0, 500) } : {}),
        restores,
        ...(tables !== undefined ? { tables } : {}),
        ...(differences ? { differences } : {}),
    };
}

/** Seals tried per purpose. */
export const KEY_CHECK_SAMPLE = 5;

/**
 * The restored copy's seals, in a worker thread: per purpose, a random few
 * under the key id `kid` (the sealed text, or a file's row) and how many
 * are under the legacy key or another key. Only ids and sealed text cross
 * over; the key itself never reaches the worker.
 */
const SAMPLE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { path, kid, sample, sources } = workerData;
const db = new DatabaseSync(path, { readOnly: true });
const shuffle = (items) => {
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
};
try {
  const out = {};
  for (const [purpose, sql] of sources) {
    const entry = (out[purpose] ??= { values: [], legacy: 0, otherKey: 0 });
    let rows;
    try { rows = db.prepare(sql).all(); } catch { continue; }
    for (const { v } of rows) {
      if (typeof v !== 'string') continue;
      if (v.startsWith('v1.')) entry.legacy++;
      else if (v.startsWith('v2.' + kid + '.')) entry.values.push(v);
      else if (v.startsWith('v2.')) entry.otherKey++;
    }
  }
  for (const entry of Object.values(out)) entry.values = shuffle(entry.values).slice(0, sample);
  const files = { rows: [], legacy: 0, otherKey: 0 };
  try {
    for (const { sealKey, n } of db.prepare('SELECT sealKey, count(*) AS n FROM data_files GROUP BY sealKey').all()) {
      if (sealKey === 'legacy') files.legacy += Number(n);
      else if (sealKey !== kid) files.otherKey += Number(n);
    }
    files.rows = db.prepare('SELECT id, ownerUserId, storage FROM data_files WHERE sealKey=? ORDER BY deletedAt IS NOT NULL, random() LIMIT ?').all(kid, sample).map((row) => ({ ...row }));
  } catch {}
  parentPort.postMessage({ values: out, files });
} finally {
  db.close();
}`;

interface Sampled {
    values: Partial<Record<SealPurpose, { values: string[]; legacy: number; otherKey: number }>>;
    files: { rows: FileSample[]; legacy: number; otherKey: number };
}

function sampleSeals(path: string, kid: string, sample: number, sources: SealedValues) {
    return new Promise<Sampled>((done, fail) => {
        const worker = new Worker(SAMPLE_WORKER, {
            eval: true,
            workerData: { path, kid, sample, sources },
            execArgv: [],
        });
        worker.once('message', done);
        worker.once('error', () => fail(new Error('The restored database couldn’t be read.')));
        worker.once('exit', () => fail(new Error('The restored database check stopped.')));
    });
}

export interface KeyCheckRun extends KeyCheckSources {
    /** The key from escrow: read here, never stored, logged or echoed. */
    key: Uint8Array;
    /** The server's own key ids, to say which one it is. */
    serverKeys: ServerKeyIds;
    replica: string;
    /** Scratch space: made empty, and removed after. */
    scratch: string;
    litestream: string;
    reason: (error: unknown) => string;
    /** Where each purpose's sealed values live (`BackupConfig.sealed`). */
    sealed: SealedValues;
    sample?: number;
    now?: () => number;
}

/**
 * A recovery key check (CB-322): restores the latest point of the local
 * replica into a scratch file, checks its integrity, and opens a sample of
 * each purpose's seals with the supplied key alone, so a key held in
 * escrow is proven to open the backups, not just to look right. Credentials
 * come from the restored copy; files are its rows, their objects read from
 * file storage; backups are the off-site copy's files.
 *
 * Seals under the legacy key or another data key are counted, not tried:
 * no data key opens those. The key is wiped by the caller; the boxes made
 * from it here are wiped before this returns.
 */
export async function checkRecoveryKey(run: KeyCheckRun): Promise<RecoveryKeyCheck> {
    const now = run.now ?? Date.now;
    const startedAt = now();
    const kid = dataKeyId(run.key);
    const sample = run.sample ?? KEY_CHECK_SAMPLE;
    const matches =
        kid === run.serverKeys.current ? 'current' : kid === run.serverKeys.previous ? 'previous' : 'neither';
    const purposes: RecoveryKeyPurpose[] = [];
    let error: string | undefined;
    // The legacy secret is random: a data key check opens nothing legacy.
    const ring = { current: run.key, legacy: randomUUID() };
    const tally = (
        purpose: SealPurpose,
        counts: Pick<RecoveryKeyPurpose, 'sampled' | 'opened' | 'failed' | 'otherKey' | 'legacy' | 'missing'>,
    ) => {
        const { missing, ...rest } = counts;
        purposes.push({
            purpose,
            ...rest,
            ...(missing ? { missing } : {}),
            ok: counts.failed ? false : counts.opened ? true : null,
        });
    };
    const output = join(run.scratch, 'key-check.sqlite');
    try {
        rmSync(run.scratch, { recursive: true, force: true });
        mkdirSync(run.scratch, { recursive: true, mode: 0o700 });
        await litestreamRestore(run.litestream, restoreArgs(run.replica, output));
        if (!(await checkDatabase(output, true)).ok) {
            throw new Error('The restored database failed its integrity check.');
        }
        const sampled = await sampleSeals(output, kid, sample, run.sealed);
        for (const purpose of SEAL_PURPOSES) {
            const box = new SecretBox(ring, purpose);
            try {
                if (purpose === 'data-files') {
                    const counts = {
                        sampled: 0,
                        opened: 0,
                        failed: 0,
                        otherKey: sampled.files.otherKey,
                        legacy: sampled.files.legacy,
                        missing: 0,
                    };
                    for (const row of run.files ? sampled.files.rows : []) {
                        const sealed = await run.files!(row).catch(() => undefined);
                        if (!sealed) {
                            counts.missing++;
                            continue;
                        }
                        // Re-sealed since the backup: under the key the object names now.
                        const named = box.bytesKey(sealed);
                        if (named !== kid) {
                            counts[named === LEGACY_KEY ? 'legacy' : 'otherKey']++;
                            continue;
                        }
                        counts.sampled++;
                        try {
                            box.openBytes(sealed, `${row.ownerUserId}/${row.id}`).fill(0);
                            counts.opened++;
                        } catch {
                            counts.failed++;
                        }
                        await nextTurn();
                    }
                    tally(purpose, counts);
                } else if (purpose === 'backups') {
                    const counts = { sampled: 0, opened: 0, failed: 0, otherKey: 0, legacy: 0 };
                    for (const sealed of (await run.backups?.(sample)) ?? []) {
                        const named = box.bytesKey(sealed);
                        if (named !== kid) {
                            counts[named === LEGACY_KEY ? 'legacy' : 'otherKey']++;
                            continue;
                        }
                        counts.sampled++;
                        try {
                            box.openBytes(sealed, BACKUP_CONTEXT).fill(0);
                            counts.opened++;
                        } catch {
                            counts.failed++;
                        }
                        await nextTurn();
                    }
                    tally(purpose, counts);
                } else {
                    const found = sampled.values[purpose] ?? { values: [], legacy: 0, otherKey: 0 };
                    const counts = {
                        sampled: found.values.length,
                        opened: 0,
                        failed: 0,
                        otherKey: found.otherKey,
                        legacy: found.legacy,
                    };
                    for (const value of found.values) {
                        try {
                            box.open(value);
                            counts.opened++;
                        } catch {
                            counts.failed++;
                        }
                    }
                    tally(purpose, counts);
                }
            } finally {
                box.dispose();
            }
        }
    } catch (caught) {
        error = run.reason(caught);
    } finally {
        rmSync(run.scratch, { recursive: true, force: true });
    }
    return {
        startedAt,
        durationMs: now() - startedAt,
        ok: !error && purposes.every((p) => p.ok !== false) && purposes.some((p) => p.ok),
        keyId: kid,
        matches,
        ...(error ? { error } : {}),
        purposes,
    };
}

export interface RestoreDrillOptions extends Omit<DrillRun, 'scratch' | 'now'> {
    /** BACKUP_DIR: its status file, and the scratch files while it runs. */
    directory: string;
    /** Days between drills, read on every check; 0: only by hand. */
    intervalDays: () => number;
    log: (line: string) => void;
    /** After a drill that failed: admins are told (CB-114 notifications). */
    onFailure?: (result: RestoreDrillResult) => unknown;
    /** What a recovery key check samples (`BackupConfig.sealed`). */
    sealed: SealedValues;
    /** Whether the replica has a copy yet: no drill before it does. */
    ready: () => boolean;
    now?: () => number;
    /** First check after start; 10 minutes. */
    firstCheckMs?: number;
    /** How often it checks whether a drill is due; an hour. */
    checkMs?: number;
}

/**
 * The restore drill on a schedule (CB-111): every RESTORE_DRILL_INTERVAL_DAYS
 * (or an admin's interval from Settings) since the last one, as
 * `BACKUP_DIR/restore-drill.json` records it, so restarts don't reset the
 * clock; a failed one again after a day. One at a time: a drill asked for
 * while one runs is that one. An admin runs one now from Service setup.
 */
export class RestoreDrill implements RestoreDrillShape {
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<RestoreDrillResult>;
    private stopped = false;
    private checking?: Promise<RecoveryKeyCheck>;
    private lastKeyCheck?: RecoveryKeyCheck;
    constructor(private options: RestoreDrillOptions) {}
    private now() {
        return this.options.now?.() ?? Date.now();
    }
    private get statusPath() {
        return join(this.options.directory, 'restore-drill.json');
    }
    private get scratch() {
        return join(this.options.directory, '.restore-drill');
    }
    private get keyScratch() {
        return join(this.options.directory, '.restore-drill-key');
    }
    last(): RestoreDrillResult | undefined {
        try {
            return (
                JSON.parse(readFileSync(this.statusPath, 'utf8')) as {
                    last?: RestoreDrillResult;
                }
            ).last;
        } catch {
            return undefined;
        }
    }
    status(): RestoreDrillStatus {
        const last = this.last();
        return {
            intervalDays: this.options.intervalDays(),
            running: !!this.running,
            ...(last ? { last } : {}),
            ...(this.checking || this.lastKeyCheck
                ? {
                      keyCheck: {
                          running: !!this.checking,
                          ...(this.lastKeyCheck ? { last: this.lastKeyCheck } : {}),
                      },
                  }
                : {}),
        };
    }
    /**
     * "Verify a recovery key" (CB-322): `checkRecoveryKey` with a key from
     * escrow, one at a time, apart from the scheduled drills, which it
     * leaves as they are. The key is wiped once the check ends, whatever
     * happens; only its id and the counts are kept, in memory, and logged.
     */
    verifyKey(
        key: Uint8Array,
        serverKeys: KeyCheckRun['serverKeys'],
        sources: KeyCheckSources = {},
    ): Promise<RecoveryKeyCheck> {
        if (this.checking) {
            key.fill(0);
            throw new Error('A recovery key check is already running.');
        }
        const { log } = this.options;
        this.checking = checkRecoveryKey({
            ...sources,
            key,
            serverKeys,
            replica: this.options.replica,
            scratch: this.keyScratch,
            litestream: this.options.litestream,
            reason: this.options.reason,
            sealed: this.options.sealed,
            now: () => this.now(),
        })
            .then((result) => {
                this.lastKeyCheck = result;
                const opened = result.purposes.reduce((sum, p) => sum + p.opened, 0);
                const sampled = result.purposes.reduce((sum, p) => sum + p.sampled, 0);
                log(
                    result.error
                        ? `Recovery key check: key ${result.keyId} couldn't be checked: ${result.error}`
                        : `Recovery key check: key ${result.keyId} (${result.matches}) ${result.ok ? 'passed' : 'failed'}; opened ${opened} of ${sampled} sampled seal(s).`,
                );
                return result;
            })
            .finally(() => {
                key.fill(0);
                this.checking = undefined;
            });
        return this.checking;
    }
    /** Whether a scheduled drill is due now. */
    due() {
        const days = this.options.intervalDays();
        if (!days || !this.options.ready()) {
            return false;
        }
        const last = this.last();
        if (!last) {
            return true;
        }
        const wait = last.ok ? days * DAY : Math.min(days * DAY, DRILL_RETRY_MS);
        return this.now() - last.startedAt >= wait;
    }
    /** A drill now, or the one running; logged, and admins told when it fails. */
    run(): Promise<RestoreDrillResult> {
        if (this.running) {
            return this.running;
        }
        const { log } = this.options;
        this.running = runRestoreDrill({
            ...this.options,
            scratch: this.scratch,
            now: () => this.now(),
        })
            .then(async (result) => {
                writePrivate(this.statusPath, JSON.stringify({ last: result }));
                const seconds = Math.round(result.durationMs / 1000);
                if (result.ok) {
                    log(
                        `Restore drill: ${result.restores.length} restore(s) passed in ${seconds} s; ${result.differences?.length ?? 0} table(s) differ from live within writes since.`,
                    );
                } else {
                    log(`Restore drill failed in ${seconds} s: ${result.error}`);
                    try {
                        await this.options.onFailure?.(result);
                    } catch {
                        log('Restore drill: admins could not be notified.');
                    }
                }
                return result;
            })
            .finally(() => {
                this.running = undefined;
            });
        return this.running;
    }
    start() {
        this.stopped = false;
        // A drill cut off by a crash or a redeploy left its scratch files.
        rmSync(this.scratch, { recursive: true, force: true });
        rmSync(this.keyScratch, { recursive: true, force: true });
        const check = () => {
            if (this.stopped) {
                return;
            }
            const next = () => {
                if (this.stopped) {
                    return;
                }
                this.timer = setTimeout(check, this.options.checkMs ?? 60 * 60_000);
                this.timer.unref();
            };
            if (this.due()) {
                void this.run()
                    .catch(() => undefined)
                    .finally(next);
            } else {
                next();
            }
        };
        this.timer = setTimeout(check, this.options.firstCheckMs ?? 10 * 60_000);
        this.timer.unref();
    }
    /** Stops scheduling; a drill in progress finishes and removes its files. */
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }
}
