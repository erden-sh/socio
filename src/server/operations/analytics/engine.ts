import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

import type { OperationsSettings } from '@socio/shared/operations/operations';
import {
    analyticsInForce,
    reportingTimeZone,
    type AnalyticsSettings,
} from '@socio/shared/operations/operations-analytics';

import { OPS_QUERIES, type OpsQueryName } from '../domain/ops-queries.js';
import type { EtlContext, EtlStep } from '../infra/duckdb/etl.js';
import { errorMessage, isCorruptError, isLockError, openDuck, rows } from '../infra/duckdb/open.js';
import { duckOpsQueries } from '../infra/duckdb/ops-queries.js';
import { createSchema, duckdbVersion, fileVersion, readMeta, setMeta } from '../infra/duckdb/schema.js';

import { analyticsRequest, type AnalyticsAnswer, type EngineStatus } from './ipc.js';

export const ANALYTICS_FILE = 'ops.duckdb';
/** Held for the process's life: the one-writer rule across processes. */
const LOCK_FILE = 'ops.lock';
/** Where a rebuild builds, next to the file it replaces. */
const NEXT_SUFFIX = '.next';
/** The last damaged file, kept aside once for a look. */
const CORRUPT_SUFFIX = '.corrupt';
/** Above this a query is logged (`ops slow query`). */
const SLOW_MS = 500;
/** Answers are reused this long per (query, params). */
const CACHE_MS = 60_000;
/** A rebuild's pause between batches, so it never starves the queries. */
const REBUILD_PAUSE_MS = 5;

export interface EngineOptions {
    /** Its directory: `analytics/` next to the database. */
    dir: string;
    /** The app's SQLite database, opened read-only. */
    sqlitePath: string;
    /** The environment's settings, under what an admin saved. */
    defaults: AnalyticsSettings;
    /** `OPS_TIME_ZONE`: the reporting time zone, under an admin's. */
    defaultTimeZone?: string;
    steps: readonly EtlStep[];
    etlVersion: number;
    /** How often to try the file again while another process holds it. */
    lockRetryMs?: number;
    log?: (line: string) => void;
    onStatus?: (status: EngineStatus) => void;
    /** The clock the ETL's steps see as "now"; the real one unless a test pins it. */
    now?: () => number;
}

interface Open {
    instance: DuckDBInstance;
    /** For the ETL and meta; queries take their own. */
    connection: DuckDBConnection;
    settings: AnalyticsSettings;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * The analytics store (CB-186), inside the analytics process: it owns
 * `ops.duckdb`, keeps it up to date from SQLite, answers the dashboard's
 * queries, and rebuilds the file when it is missing, damaged or from
 * another version: it builds a fresh one next to it, serves the old one
 * (if any) until the new one has caught up, then swaps them. The file
 * holds only derived data, so a rebuild loses nothing.
 */
export class AnalyticsEngine {
    private lock?: DuckDBInstance;
    private current?: Open;
    /**
     * The open file is from another version (schema, ETL or DuckDB): it is
     * kept only until its rebuild is swapped in, and never queried, since
     * its tables aren't the ones the queries read.
     */
    private stale = false;
    private sqlite?: DatabaseSync;
    private state: EngineStatus = { state: 'starting' };
    private stopped = false;
    private building?: Promise<void>;
    private cycle?: Promise<void>;
    private again = false;
    private timer?: ReturnType<typeof setTimeout>;
    /** When the scheduled cycle runs (ms). */
    private dueAt = 0;
    private wake?: () => void;
    private inflight = 0;
    private gate?: Promise<void>;
    private cache = new Map<string, { at: number; value: unknown }>();
    private version?: string;
    /** The last rebuild failed: the next tick tries again. */
    private retryBuild = false;
    private readonly log: (line: string) => void;
    constructor(private options: EngineOptions) {
        this.log = options.log ?? ((line) => console.log(line));
    }
    private get file() {
        return join(this.options.dir, ANALYTICS_FILE);
    }
    status(): EngineStatus {
        return { ...this.state };
    }
    private setStatus(next: EngineStatus) {
        const same =
            next.state === this.state.state &&
            next.progress === this.state.progress &&
            next.asOf === this.state.asOf &&
            next.detail === this.state.detail;
        this.state = next;
        if (!same) {
            this.options.onStatus?.(this.status());
        }
    }

    /**
     * Takes the file (waiting, every `lockRetryMs`, while another process
     * holds it: an older app task in a blue/green deploy, or the service
     * being replaced), opens it, and starts the ETL. Returns once it has the
     * file, or when stopped first.
     */
    async start() {
        mkdirSync(join(this.options.dir, 'tmp'), { recursive: true });
        const retry = this.options.lockRetryMs ?? 10_000;
        while (!this.stopped && !this.lock) {
            try {
                this.lock = await openDuck(join(this.options.dir, LOCK_FILE), {
                    memoryMb: 16,
                    threads: 1,
                    tempDir: join(this.options.dir, 'tmp'),
                });
            } catch (error) {
                if (isLockError(error)) {
                    this.setStatus({
                        state: 'starting',
                        detail: 'Waiting for another analytics process to let go.',
                    });
                } else if (isCorruptError(error)) {
                    // Only a lock: nothing in it to lose.
                    this.removeFiles(join(this.options.dir, LOCK_FILE));
                    continue;
                } else {
                    this.log(`Analytics: can't open its lock: ${short(error)}`);
                    this.setStatus({ state: 'unavailable', detail: 'Can’t open.' });
                }
                await this.pause(retry);
            }
        }
        if (this.stopped) {
            return this.closeLock();
        }
        const probe = await this.lock!.connect();
        try {
            this.version = fileVersion(this.options.etlVersion, await duckdbVersion(probe));
        } finally {
            probe.closeSync();
        }
        await this.openCurrent();
        this.schedule(0);
    }

    async stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.wake?.();
        await Promise.allSettled([this.building, this.cycle]);
        this.closeCurrent();
        try {
            this.sqlite?.close();
        } catch {
            // Already closed.
        }
        this.sqlite = undefined;
        this.closeLock();
    }

    /** One request, from IPC or HTTP; never throws. */
    async handle(raw: unknown): Promise<AnalyticsAnswer> {
        const parsed = analyticsRequest.safeParse(raw);
        if (!parsed.success) {
            return this.fail('bad_request', 'Not a request this store knows.');
        }
        const request = parsed.data;
        try {
            switch (request.op) {
                case 'status':
                    return this.ok(null);
                case 'nudge':
                    this.nudge();
                    return this.ok(null);
                case 'rebuild':
                    if (!this.lock) {
                        return this.fail('not_ready', 'Analytics is starting.');
                    }
                    this.rebuild('an admin asked');
                    return this.ok(null);
                case 'query':
                    return await this.query(request.query, request.params);
            }
        } catch (error) {
            return this.fail('failed', `The query failed: ${short(error)}`);
        }
    }

    /**
     * Runs the ETL soon, or again right after the cycle in progress. A
     * cycle already due within the second stays as it is, so a stream of
     * finished turns can't keep putting it off.
     */
    nudge() {
        if (this.cycle) {
            this.again = true;
        } else if (!this.timer || this.dueAt > Date.now() + 1_000) {
            this.schedule(1_000);
        }
    }

    /** Builds a fresh file and swaps it in; one at a time. */
    rebuild(why: string) {
        if (this.building || this.stopped) {
            return this.building;
        }
        this.log(`Analytics: rebuilding from SQLite (${why}).`);
        this.setStatus({
            state: 'rebuilding',
            progress: 0,
            ...(this.state.asOf ? { asOf: this.state.asOf } : {}),
        });
        this.building = this.build()
            .catch((error: unknown) => {
                this.log(`Analytics: the rebuild failed: ${short(error)}`);
                this.setStatus(
                    this.current && !this.stale
                        ? { ...this.ready(), detail: 'The rebuild failed; retrying.' }
                        : { state: 'unavailable', detail: 'The rebuild failed; retrying.' },
                );
                this.retryBuild = true;
            })
            .finally(() => {
                this.building = undefined;
            });
        return this.building;
    }

    private ok(value: unknown): AnalyticsAnswer {
        return { ok: true, value, status: this.status() };
    }
    private fail(code: 'not_ready' | 'bad_request' | 'failed', error: string): AnalyticsAnswer {
        return {
            ok: false,
            code,
            error: error.slice(0, 300),
            status: this.status(),
        };
    }
    private ready(): EngineStatus {
        return {
            state: 'ready',
            ...(this.state.asOf ? { asOf: this.state.asOf } : {}),
        };
    }

    private async query(name: OpsQueryName, raw: Record<string, unknown>): Promise<AnalyticsAnswer> {
        const spec = OPS_QUERIES[name];
        const params = spec.params.safeParse(raw);
        if (!params.success) {
            return this.fail('bad_request', `Bad params for ${name}.`);
        }
        const key = `${name}\u0000${JSON.stringify(params.data)}`;
        // The store's status is never served from the cache.
        const cached = name === 'status' ? undefined : this.cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_MS) {
            return this.ok(cached.value);
        }
        while (this.gate) {
            await this.gate;
        }
        const open = this.stale ? undefined : this.current;
        if (!open) {
            return this.fail(
                'not_ready',
                this.state.state === 'rebuilding'
                    ? `Rebuilding ${this.state.progress ?? 0}%.`
                    : this.state.state === 'starting'
                      ? 'Analytics is starting.'
                      : 'Analytics is unavailable right now.',
            );
        }
        this.inflight++;
        const started = performance.now();
        let connection: DuckDBConnection | undefined;
        try {
            connection = await open.instance.connect();
            const value = spec.answer.parse(
                await duckOpsQueries(connection, () => this.status())[name](params.data as never),
            );
            this.cache.set(key, { at: Date.now(), value });
            return this.ok(value);
        } catch (error) {
            if (isCorruptError(error)) {
                this.damaged(error);
            }
            throw error;
        } finally {
            connection?.closeSync();
            this.inflight--;
            const ms = Math.round(performance.now() - started);
            if (ms > SLOW_MS) {
                this.log(`ops slow query query=${name} ms=${ms}`);
            }
        }
    }

    /** What admins saved under `settings.operations`, read from SQLite. */
    private saved(): OperationsSettings | undefined {
        try {
            const row = this.openSqlite()?.prepare('SELECT value FROM settings WHERE id=1').get() as
                | { value?: string }
                | undefined;
            if (row?.value) {
                return (JSON.parse(row.value) as { operations?: OperationsSettings }).operations;
            }
        } catch {
            // No settings yet (a new database): the environment's.
        }
        return undefined;
    }

    /** The settings in force: an admin's (read from SQLite) over the env's. */
    private settings(): AnalyticsSettings {
        return analyticsInForce(this.saved(), this.options.defaults);
    }

    /** What the ETL's steps work with this cycle. */
    private context(): EtlContext {
        const saved = this.saved();
        return {
            settings: analyticsInForce(saved, this.options.defaults),
            timeZone: reportingTimeZone(saved, {
                OPS_TIME_ZONE: this.options.defaultTimeZone,
            }),
            now: (this.options.now ?? Date.now)(),
        };
    }

    /**
     * The app's database, read-only and never written: `query_only`, a short
     * busy wait, and nothing here holds a transaction between batches. Opened
     * again after a failure; undefined while the app hasn't made it yet.
     */
    private openSqlite() {
        if (this.sqlite?.isOpen) {
            return this.sqlite;
        }
        if (!existsSync(this.options.sqlitePath)) {
            return undefined;
        }
        const db = new DatabaseSync(this.options.sqlitePath, {
            readOnly: true,
            allowExtension: false,
        });
        db.exec('PRAGMA busy_timeout=2000; PRAGMA query_only=1');
        this.sqlite = db;
        return db;
    }

    private async openCurrent() {
        const settings = this.settings();
        if (!existsSync(this.file)) {
            void this.rebuild('no file yet');
            return;
        }
        let open: Open | undefined;
        try {
            open = await this.open(this.file, settings);
            const meta = await readMeta(open.connection);
            this.current = open;
            this.stale = meta?.version !== this.version;
            const asOf = Number(meta?.as_of);
            if (Number.isFinite(asOf) && asOf > 0) {
                this.state = { ...this.state, asOf };
            }
            if (meta?.version === this.version) {
                this.setStatus(this.ready());
                return;
            }
            void this.rebuild(meta ? 'its version changed' : 'the file has no version');
        } catch (error) {
            if (open) {
                closeOpen(open);
            }
            this.current = undefined;
            this.stale = false;
            this.log(`Analytics: the file can't be read (${short(error)}).`);
            this.moveAside();
            void this.rebuild('the file was damaged');
        }
    }

    private async open(path: string, settings: AnalyticsSettings) {
        const instance = await openDuck(path, {
            memoryMb: settings.memoryMb,
            threads: settings.threads,
            tempDir: join(this.options.dir, 'tmp'),
        });
        try {
            return { instance, connection: await instance.connect(), settings };
        } catch (error) {
            instance.closeSync();
            throw error;
        }
    }

    private async build() {
        const next = this.file + NEXT_SUFFIX;
        this.removeFiles(next);
        const settings = this.settings();
        const fresh = await this.open(next, settings);
        let swapped = false;
        try {
            await createSchema(fresh.connection, this.options.steps, this.version!);
            await this.catchUp(fresh.connection, true);
            if (this.stopped) {
                return;
            }
            await fresh.connection.run('CHECKPOINT');
            closeOpen(fresh);
            await this.exclusive(async () => {
                this.closeCurrent();
                this.removeFiles(this.file);
                renameSync(next, this.file);
                this.current = await this.open(this.file, settings);
                this.stale = false;
                swapped = true;
                // Ready before the first query after the swap sees the store.
                const asOf = Number((await readMeta(this.current.connection))?.as_of);
                this.setStatus({
                    state: 'ready',
                    ...(Number.isFinite(asOf) && asOf > 0 ? { asOf } : {}),
                });
            });
            this.retryBuild = false;
            this.log('Analytics: the rebuilt file is in use.');
        } finally {
            if (!swapped) {
                closeOpen(fresh);
                this.removeFiles(next);
            }
        }
    }

    /**
     * Runs every step until it has caught up, each batch with its
     * watermark in one DuckDB transaction. Returns false when a step needs
     * SQLite and the app hasn't made it yet.
     */
    private async catchUp(connection: DuckDBConnection, rebuilding: boolean) {
        const steps = this.options.steps;
        const sqlite = steps.length ? this.openSqlite() : undefined;
        if (steps.length && !sqlite) {
            if (rebuilding) {
                throw new Error('the database is not there yet');
            }
            return false;
        }
        const context = this.context();
        for (const [index, step] of steps.entries()) {
            const [state] = await rows<{ watermark: string | null }>(
                connection,
                'SELECT watermark FROM etl_state WHERE source = $1',
                [step.source],
            );
            let watermark = state?.watermark ?? null;
            for (;;) {
                if (this.stopped) {
                    return false;
                }
                await connection.run('BEGIN TRANSACTION');
                let batch;
                try {
                    batch = await step.batch({
                        sqlite: sqlite!,
                        duck: connection,
                        watermark,
                        rebuilding,
                        context,
                    });
                    if (batch.watermark !== undefined) {
                        watermark = batch.watermark;
                    }
                    await connection.run(
                        `INSERT INTO etl_state VALUES ($1, $2, $3) ON CONFLICT (source) DO UPDATE SET watermark = excluded.watermark, "at" = excluded."at"`,
                        [step.source, watermark, Date.now()],
                    );
                    await connection.run('COMMIT');
                } catch (error) {
                    await connection.run('ROLLBACK').catch(() => undefined);
                    throw error;
                }
                if (rebuilding) {
                    const done = batch.caughtUp ? 1 : (batch.progress ?? 0);
                    this.setStatus({
                        ...this.state,
                        state: 'rebuilding',
                        progress: Math.floor(((index + done) / steps.length) * 100),
                    });
                    await sleep(REBUILD_PAUSE_MS);
                } else {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                if (batch.caughtUp) {
                    break;
                }
            }
        }
        await setMeta(connection, 'as_of', String(Date.now()));
        return true;
    }

    /** One ETL cycle on the current file, then the next one scheduled. */
    private async tick() {
        if (this.stopped) {
            return;
        }
        try {
            const settings = this.settings();
            if (this.retryBuild && !this.building) {
                void this.rebuild('retrying');
            }
            const open = this.current;
            if (open && (open.settings.memoryMb !== settings.memoryMb || open.settings.threads !== settings.threads)) {
                await this.exclusive(async () => {
                    this.log(`Analytics: memory ${settings.memoryMb} MB, ${settings.threads} thread(s).`);
                    this.closeCurrent();
                    this.current = await this.open(this.file, settings);
                });
            }
            if (this.current && !this.building && !this.stale) {
                if (await this.catchUp(this.current.connection, false)) {
                    const meta = await readMeta(this.current.connection);
                    const asOf = Number(meta?.as_of);
                    this.cache.clear();
                    this.setStatus({ state: 'ready', asOf });
                }
            }
        } catch (error) {
            if (isCorruptError(error)) {
                this.damaged(error);
            } else {
                this.log(`Analytics: the ETL failed: ${short(error)}`);
            }
        }
    }

    private schedule(delayMs: number) {
        if (this.stopped) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.dueAt = Date.now() + delayMs;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.cycle = this.tick().finally(() => {
                this.cycle = undefined;
                const again = this.again;
                this.again = false;
                this.schedule(again ? 0 : this.settings().etlEverySeconds * 1000);
            });
        }, delayMs);
        this.timer.unref();
    }

    /** A damaged file found in use: put aside and rebuilt; nothing is lost. */
    private damaged(error: unknown) {
        if (this.building || !this.current) {
            return;
        }
        this.log(`Analytics: the file is damaged (${short(error)}).`);
        void this.exclusive(async () => {
            this.closeCurrent();
            this.moveAside();
        }).then(() => this.rebuild('the file was damaged'));
    }

    /** Runs `work` with no query in flight and new ones held. */
    private async exclusive(work: () => Promise<void>) {
        while (this.gate) {
            await this.gate;
        }
        let release!: () => void;
        this.gate = new Promise<void>((resolve) => (release = resolve));
        try {
            for (let waited = 0; this.inflight > 0 && waited < 30_000; waited += 10) {
                await sleep(10);
            }
            this.cache.clear();
            await work();
        } finally {
            this.gate = undefined;
            release();
        }
    }

    private closeCurrent() {
        if (this.current) {
            closeOpen(this.current);
        }
        this.current = undefined;
    }
    private closeLock() {
        try {
            this.lock?.closeSync();
        } catch {
            // Already closed.
        }
        this.lock = undefined;
    }
    private moveAside() {
        const aside = this.file + CORRUPT_SUFFIX;
        this.removeFiles(aside);
        try {
            renameSync(this.file, aside);
        } catch {
            // Gone already.
        }
        this.removeFiles(this.file);
    }
    /** A DuckDB file and its write-ahead log. */
    private removeFiles(path: string) {
        rmSync(path, { force: true });
        rmSync(`${path}.wal`, { force: true });
    }
    /** Waits `ms`, or less when stopped. */
    private pause(ms: number) {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            timer.unref();
            this.wake = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }
}

function closeOpen(open: Open) {
    try {
        open.connection.closeSync();
    } catch {
        // Already closed.
    }
    try {
        open.instance.closeSync();
    } catch {
        // Already closed.
    }
}

/** An error in a line, without the paths DuckDB puts in its messages. */
function short(error: unknown) {
    return errorMessage(error)
        .replace(/"[^"]*\/[^"]*"/g, '"…"')
        .split('\n')[0]!
        .slice(0, 200);
}
