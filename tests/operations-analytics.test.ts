import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { TAXONOMY_VERSION } from '@socio/shared/failure-taxonomy';
import { analyticsDefaults, analyticsInForce, reportingTimeZone } from '@socio/shared/operations/operations-analytics';

import { analyticsFromEnv } from '../src/server/composition/config.js';
import { ChildAnalytics, analyticsEntry } from '../src/server/operations/analytics/child.js';
import { HttpAnalytics } from '../src/server/operations/analytics/client.js';
import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import type { EngineStatus } from '../src/server/operations/analytics/ipc.js';
import type { EtlStep } from '../src/server/operations/infra/duckdb/etl.js';
import { openDuck, rows } from '../src/server/operations/infra/duckdb/open.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// The Operations analytics store (CB-186): DuckDB in its own process,
// rebuilt from SQLite, reached over IPC (child) or HTTP (service).

/** Where the app's ETL steps stand on a database with no turns (CB-187). */
const NO_TURNS_YET = [
    { source: 'agent_runs', watermark: null },
    { source: 'approval_audit', watermark: null },
    // Turn cost (CB-195): the inputs' hash and the hour it reached.
    { source: 'cost', watermark: expect.any(String) },
    // CB-191's: nothing read yet, but the database file is measured.
    { source: 'data_audit', watermark: null },
    { source: 'data_dataset_days', watermark: null },
    { source: 'dimensions', watermark: null },
    { source: 'dot_requests', watermark: null },
    // Items filed from turns (CB-194): none yet.
    { source: 'issue_runs', watermark: null },
    // The board's items (CB-189): none, read.
    { source: 'issues', watermark: expect.any(String) },
    { source: 'job_runs', watermark: null },
    // Failure labels (CB-198): none yet.
    { source: 'labels', watermark: null },
    { source: 'memories', watermark: null },
    { source: 'message_reactions', watermark: null },
    { source: 'page_revisions', watermark: null },
    { source: 'pages', watermark: null },
    { source: 'retention', watermark: '0' },
    // What turns read (CB-194): none yet.
    { source: 'run_refs', watermark: null },
    { source: 'runs', watermark: null },
    { source: 'schedules', watermark: null },
    // Sessions' intent and themes (CB-199): none yet.
    { source: 'session_labels', watermark: null },
    { source: 'space_writes', watermark: null },
    { source: 'storage', watermark: expect.any(String) },
    // The failure taxonomy's version (CB-189).
    { source: 'taxonomy', watermark: String(TAXONOMY_VERSION) },
    // Work cycles (CB-218): none yet.
    { source: 'work_cycles', watermark: null },
];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-analytics-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // The app's database, as the app leaves it: WAL, with settings.
    const sqlitePath = join(dir, 'company-brain.sqlite');
    const db = new DatabaseSync(sqlitePath);
    db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    INSERT INTO settings VALUES (1, '{}');
    CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);`);
    cleanup.push(() => db.close());
    const add = (n: number) => {
        const insert = db.prepare('INSERT INTO events (kind) VALUES (?)');
        for (let i = 0; i < n; i++) {
            insert.run(i % 2 ? 'b' : 'a');
        }
    };
    return { dir, sqlitePath, analytics: join(dir, 'analytics'), db, add };
}

/** A source like CB-187's: by id, 50 rows a batch, read-only. */
function eventsStep(hold?: Promise<void>): EtlStep {
    return {
        source: 'events',
        ddl: ['CREATE TABLE f_event (id BIGINT PRIMARY KEY, kind VARCHAR)'],
        async batch({ sqlite, duck, watermark }) {
            if (hold) {
                await hold;
            }
            const after = Number(watermark ?? 0);
            const batch = sqlite
                .prepare('SELECT id, kind FROM events WHERE id > ? ORDER BY id LIMIT 50')
                .all(after) as { id: number; kind: string }[];
            const [{ total }] = sqlite.prepare('SELECT count(*) AS total FROM events').all() as [{ total: number }];
            for (const row of batch) {
                await duck.run('INSERT INTO f_event VALUES ($1, $2)', [row.id, row.kind]);
            }
            const last = batch.at(-1)?.id ?? after;
            return {
                watermark: String(last),
                caughtUp: batch.length < 50,
                progress: total ? last / total : 1,
            };
        },
    };
}

function engine(s: ReturnType<typeof scratch>, options: { steps?: EtlStep[]; etlVersion?: number } = {}) {
    const statuses: EngineStatus[] = [];
    const lines: string[] = [];
    const e = new AnalyticsEngine({
        dir: s.analytics,
        sqlitePath: s.sqlitePath,
        defaults: analyticsDefaults({}),
        steps: options.steps ?? [eventsStep()],
        etlVersion: options.etlVersion ?? 1,
        lockRetryMs: 100,
        log: (line) => lines.push(line),
        onStatus: (status) => statuses.push(status),
    });
    cleanup.push(() => e.stop());
    return { e, statuses, lines };
}

async function until<T>(check: () => T | Promise<T>, timeoutMs = 20_000): Promise<NonNullable<T>> {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) {
            return value as NonNullable<T>;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function eventCount(file: string) {
    const instance = await openDuck(file, {
        memoryMb: 128,
        threads: 1,
        tempDir: join(file, '..', 'tmp'),
    });
    const connection = await instance.connect();
    try {
        const [row] = await rows<{ n: number }>(connection, 'SELECT count(*) AS n FROM f_event');
        return row!.n;
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

describe('DuckDB, offline and locked down', () => {
    it('loads no extension, touches no other file and keeps its limits', async () => {
        const s = scratch();
        const instance = await openDuck(join(s.dir, 'x.duckdb'), {
            memoryMb: 256,
            threads: 2,
            tempDir: join(s.dir, 'tmp'),
        });
        const c = await instance.connect();
        cleanup.push(() => {
            c.closeSync();
            instance.closeSync();
        });
        const [settings] = await rows<Record<string, unknown>>(
            c,
            `SELECT current_setting('autoinstall_known_extensions') AS install,
        current_setting('autoload_known_extensions') AS autoload,
        current_setting('enable_external_access') AS external,
        current_setting('lock_configuration') AS locked,
        current_setting('threads') AS threads,
        current_setting('max_temp_directory_size') AS temp`,
        );
        expect(settings).toMatchObject({
            install: false,
            autoload: false,
            external: false,
            locked: true,
            threads: 2,
        });
        expect(String(settings!.temp)).toMatch(/^1\.8 GiB|^2/);
        // Nothing can loosen it afterwards, or reach a file or the network.
        for (const sql of [
            "SET memory_limit='4GB'",
            "SET enable_external_access='true'",
            'INSTALL sqlite',
            'LOAD sqlite',
            `ATTACH '${s.sqlitePath}' AS app (TYPE sqlite)`,
            `SELECT * FROM read_csv('${s.sqlitePath}')`,
            "SELECT * FROM read_json('https://example.invalid/x.json')",
        ]) {
            await expect(c.run(sql), sql).rejects.toThrow();
        }
    });

    it('is never pointed at SQLite through DuckDB (its sqlite extension)', () => {
        const root = new URL('../src/server/operations/', import.meta.url);
        const files = (readdirSync(root, { recursive: true }) as string[])
            .filter((name) => name.endsWith('.ts'))
            .map((name) => readFileSync(new URL(name, root), 'utf8'));
        expect(files.length).toBeGreaterThan(5);
        for (const text of files) {
            expect(text).not.toMatch(/sqlite_scan|sqlite_attach|(INSTALL|LOAD)\s+sqlite|TYPE\s+sqlite/i);
        }
    });
});

// Each builds DuckDB files: slow on a loaded host.
describe('the engine', { timeout: 40_000 }, () => {
    it('builds a missing file from SQLite, then keeps it up to date', async () => {
        const s = scratch();
        s.add(120);
        const { e } = engine(s);
        await e.start();
        await until(() => e.status().state === 'ready');
        const answer = await e.handle({ op: 'query', query: 'freshness' });
        expect(answer).toMatchObject({
            ok: true,
            value: { sources: [{ source: 'events', watermark: '120' }] },
            status: { state: 'ready' },
        });
        expect((answer as { value: { asOf: number } }).value.asOf).toBeGreaterThan(0);
        s.add(30);
        e.nudge();
        await until(async () => {
            const fresh = await e.handle({ op: 'status' });
            return fresh.status.asOf && (await freshnessMark(e)) === '150';
        });
        await e.stop();
        expect(await eventCount(join(s.analytics, 'ops.duckdb'))).toBe(150);
    });

    it('opens a current file as is, without rebuilding', async () => {
        const s = scratch();
        s.add(10);
        const first = engine(s);
        await first.e.start();
        await until(() => first.e.status().state === 'ready');
        await first.e.stop();
        const second = engine(s);
        await second.e.start();
        expect(second.e.status().state).toBe('ready');
        expect(second.lines.join('\n')).not.toMatch(/rebuilding/);
    });

    it('puts a damaged file aside and rebuilds it with nothing lost', async () => {
        const s = scratch();
        s.add(75);
        const first = engine(s);
        await first.e.start();
        await until(() => first.e.status().state === 'ready');
        await first.e.stop();
        const file = join(s.analytics, 'ops.duckdb');
        writeFileSync(file, 'not a database at all'.repeat(100));
        const second = engine(s);
        await second.e.start();
        await until(() => second.e.status().state === 'ready');
        expect(second.lines.join('\n')).toMatch(/can't be read/);
        expect(existsSync(`${file}.corrupt`)).toBe(true);
        await second.e.stop();
        expect(await eventCount(file)).toBe(75);
    });

    it('answers "rebuilding" while a new version rebuilds, never from the old file, then swaps', async () => {
        const s = scratch();
        s.add(200);
        const first = engine(s);
        await first.e.start();
        await until(() => first.e.status().state === 'ready');
        await first.e.stop();
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        // A new ETL version: the file is rebuilt; batches wait for `hold`.
        const second = engine(s, { steps: [eventsStep(hold)], etlVersion: 2 });
        await second.e.start();
        expect(second.e.status()).toMatchObject({ state: 'rebuilding' });
        // Its tables may not be the new version's (CB-187): not asked.
        const during = await second.e.handle({ op: 'query', query: 'freshness' });
        expect(during).toMatchObject({
            ok: false,
            code: 'not_ready',
            error: 'Rebuilding 0%.',
            status: { state: 'rebuilding', progress: 0 },
        });
        release();
        await until(() => second.e.status().state === 'ready');
        expect(second.statuses.some((x) => (x.progress ?? 0) > 0)).toBe(true);
        expect(existsSync(join(s.analytics, 'ops.duckdb.next'))).toBe(false);
        await second.e.stop();
        expect(await eventCount(join(s.analytics, 'ops.duckdb'))).toBe(200);
    });

    it('keeps answering from a current file while an admin’s rebuild runs', async () => {
        const s = scratch();
        s.add(120);
        const first = engine(s);
        await first.e.start();
        await until(() => first.e.status().state === 'ready');
        await first.e.stop();
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const second = engine(s, { steps: [eventsStep(hold)] });
        await second.e.start();
        expect(second.e.status()).toMatchObject({ state: 'ready' });
        expect(await second.e.handle({ op: 'rebuild' })).toMatchObject({
            ok: true,
        });
        await until(() => second.e.status().state === 'rebuilding');
        expect(await second.e.handle({ op: 'query', query: 'freshness' })).toMatchObject({
            ok: true,
            value: { sources: [{ watermark: '120' }] },
            status: { state: 'rebuilding' },
        });
        release();
        await until(() => second.e.status().state === 'ready');
    });

    it('answers "not ready" while there is no file yet, and refuses bad requests', async () => {
        const s = scratch();
        s.add(10);
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const { e } = engine(s, { steps: [eventsStep(hold)] });
        await e.start();
        expect(await e.handle({ op: 'query', query: 'freshness' })).toMatchObject({
            ok: false,
            code: 'not_ready',
            error: 'Rebuilding 0%.',
        });
        expect(await e.handle({ op: 'drop tables' })).toMatchObject({
            ok: false,
            code: 'bad_request',
        });
        expect(await e.handle({ op: 'query', query: 'freshness', params: { x: 1 } })).toMatchObject({
            ok: false,
            code: 'bad_request',
        });
        release();
        await until(() => e.status().state === 'ready');
    });

    it('applies an admin’s memory and threads over the environment’s', () => {
        const env = analyticsDefaults({
            OPS_ANALYTICS_MEMORY_MB: '1024',
            OPS_ANALYTICS_THREADS: '4',
        });
        // Retention (CB-193) keeps derived facts and hourly rollups by default.
        const kept = { factDays: 0, hourlyDays: 0 };
        expect(env).toEqual({
            memoryMb: 1024,
            threads: 4,
            etlEverySeconds: 60,
            ...kept,
        });
        expect(analyticsDefaults({})).toEqual({
            memoryMb: 512,
            threads: 2,
            etlEverySeconds: 60,
            ...kept,
        });
        expect(analyticsInForce({ analytics: { memoryMb: 256, threads: 999, factDays: 400 } }, env)).toEqual({
            memoryMb: 256,
            threads: 4,
            etlEverySeconds: 60,
            factDays: 400,
            hourlyDays: 0,
        });
        expect(() => analyticsDefaults({ OPS_ANALYTICS_MEMORY_MB: '10' })).toThrow(/OPS_ANALYTICS_MEMORY_MB/);
        expect(analyticsDefaults({ OPS_HOURLY_DAYS: '0' }).hourlyDays).toBe(0);
        // The reporting time zone: an admin's, over OPS_TIME_ZONE, else UTC.
        expect(reportingTimeZone(undefined, {})).toBe('UTC');
        expect(reportingTimeZone(undefined, { OPS_TIME_ZONE: 'Europe/Madrid' })).toBe('Europe/Madrid');
        expect(reportingTimeZone({ timeZone: 'Asia/Kolkata' }, { OPS_TIME_ZONE: 'Europe/Madrid' })).toBe(
            'Asia/Kolkata',
        );
        expect(reportingTimeZone({ timeZone: 'Nowhere/Else' }, {})).toBe('UTC');
    });

    it('reopens DuckDB when an admin changes its memory', async () => {
        const s = scratch();
        const { e, lines } = engine(s);
        await e.start();
        await until(() => e.status().state === 'ready');
        s.db
            .prepare('UPDATE settings SET value=? WHERE id=1')
            .run(JSON.stringify({ operations: { analytics: { memoryMb: 256 } } }));
        e.nudge();
        await until(() => lines.some((line) => /memory 256 MB/.test(line)));
        expect(await e.handle({ op: 'query', query: 'freshness' })).toMatchObject({
            ok: true,
        });
    });
});

async function freshnessMark(e: AnalyticsEngine) {
    const answer = await e.handle({ op: 'query', query: 'freshness' });
    return answer.ok ? (answer.value as { sources: { watermark: string }[] }).sources[0]?.watermark : undefined;
}

describe('configuration', () => {
    it('runs as a child by default, or as the service with its URL and secret', () => {
        expect(analyticsFromEnv({}, '/data/db.sqlite', '/data/analytics')).toEqual({
            mode: 'child',
            dir: '/data/analytics',
            databasePath: '/data/db.sqlite',
            env: {},
        });
        expect(analyticsFromEnv({ OPS_ANALYTICS_MODE: 'off' }, '/data/db.sqlite', '/data/analytics')).toBeUndefined();
        const secret = 's'.repeat(32);
        expect(
            analyticsFromEnv(
                {
                    OPS_ANALYTICS_MODE: 'service',
                    OPS_ANALYTICS_URL: 'http://socio-analytics:4340/',
                    OPS_ANALYTICS_SECRET: secret,
                },
                '/data/db.sqlite',
                '/data/analytics',
            ),
        ).toEqual({ mode: 'service', url: 'http://socio-analytics:4340', secret });
        expect(() =>
            analyticsFromEnv({ OPS_ANALYTICS_MODE: 'service', OPS_ANALYTICS_URL: 'http://a:1' }, '', ''),
        ).toThrow(/OPS_ANALYTICS_SECRET/);
        expect(() => analyticsFromEnv({ OPS_ANALYTICS_MODE: 'duck' }, '', '')).toThrow(/OPS_ANALYTICS_MODE/);
    });

    it('shows the mode and state in setup() and /healthz', async () => {
        const { platform, dispose } = await makeTestRuntime({
            config: {
                baseUrl: '',
                apiKey: '',
                model: '',
                voiceName: 'marin',
                runtimeUrl: '',
                analytics: {
                    mode: 'service',
                    url: 'http://127.0.0.1:9',
                    secret: 's'.repeat(32),
                },
            },
        });
        cleanup.push(dispose);
        expect((await platform.setup()).analytics).toEqual({
            mode: 'service',
            state: 'starting',
        });
        expect(await platform.health()).toMatchObject({ analytics: 'starting' });
    });

    it('nudges the ETL after each finished turn, after the turn (CB-187)', async () => {
        const { platform, dispose } = await makeTestRuntime({
            config: {
                baseUrl: '',
                apiKey: '',
                model: '',
                voiceName: 'marin',
                runtimeUrl: '',
                analytics: {
                    mode: 'service',
                    url: 'http://127.0.0.1:9',
                    secret: 's'.repeat(32),
                },
            },
        });
        cleanup.push(dispose);
        let nudges = 0;
        platform.analytics!.nudge = () => void nudges++;
        class Answer extends AbstractAgent {
            run(input: RunAgentInput): Observable<BaseEvent> {
                return new Observable<BaseEvent>((subscriber) => {
                    subscriber.next({
                        type: EventType.RUN_STARTED,
                        threadId: input.threadId,
                        runId: input.runId,
                    } as BaseEvent);
                    subscriber.next({
                        type: EventType.RUN_FINISHED,
                        threadId: input.threadId,
                        runId: input.runId,
                    } as BaseEvent);
                    subscriber.complete();
                });
            }
        }
        await lastValueFrom(
            platform.runner
                .run({
                    threadId: 'thread',
                    agent: new Answer({}),
                    input: {
                        threadId: 'thread',
                        runId: 'run-1',
                        messages: [{ id: 'u-1', role: 'user', content: 'Hi' }],
                        state: {},
                        tools: [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
        );
        // Not on the turn's path: on a later turn of the event loop.
        expect(nudges).toBe(0);
        await until(() => nudges === 1);
    });
});

describe('child mode', () => {
    it('forks the store, answers over IPC, and stops by its PID', async () => {
        const s = scratch();
        s.add(60);
        const client = childClient(s);
        client.start();
        await until(() => client.health().state === 'ready', 20_000);
        expect(client.health().mode).toBe('child');
        // The app's own ETL steps (CB-187), with no turns yet: caught up at once.
        const answer = await client.query('freshness', {});
        expect(answer.asOf).toBeGreaterThan(0);
        const pid = client.pid!;
        expect(alive(pid)).toBe(true);
        await client.stop();
        expect(alive(pid)).toBe(false);
        await expect(client.query('freshness', {})).rejects.toMatchObject({
            code: 'unavailable',
        });
    }, 30_000);

    it('starts again with backoff after a crash, with nothing lost', async () => {
        const s = scratch();
        const client = childClient(s);
        client.start();
        await until(() => client.health().state === 'ready', 20_000);
        const before = await client.query('freshness', {});
        const first = client.pid!;
        process.kill(first, 'SIGKILL');
        await until(() => client.health().state === 'unavailable');
        await until(() => client.pid !== first && client.health().state === 'ready', 20_000);
        // The same file, opened again: not rebuilt, so its history is there.
        const after = await client.query('freshness', {});
        expect(after.asOf).toBeGreaterThanOrEqual(before.asOf!);
        expect(readdirSync(s.analytics).filter((name) => name.endsWith('.corrupt'))).toEqual([]);
    }, 30_000);

    it('waits, as "starting", while another process holds the file (blue/green)', async () => {
        const s = scratch();
        const older = childClient(s);
        older.start();
        await until(() => older.health().state === 'ready', 20_000);
        const newer = childClient(s);
        newer.start();
        await until(() => newer.health().detail?.includes('let go'), 20_000);
        expect(newer.health().state).toBe('starting');
        await expect(newer.query('freshness', {})).rejects.toMatchObject({
            code: 'not_ready',
        });
        await older.stop();
        await until(() => newer.health().state === 'ready', 20_000);
        expect(await newer.query('freshness', {})).toMatchObject({
            sources: NO_TURNS_YET,
        });
    }, 40_000);
});

function childClient(s: ReturnType<typeof scratch>) {
    const client = new ChildAnalytics(
        {
            mode: 'child',
            dir: s.analytics,
            databasePath: s.sqlitePath,
            env: { OPS_ANALYTICS_LOCK_RETRY_MS: '200' },
        },
        { backoff: { firstMs: 100, maxMs: 1_000 }, log: () => undefined },
    );
    cleanup.push(() => client.stop());
    return client;
}

function alive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('service mode', () => {
    it('answers the app over HTTP with the secret, and nothing without it', async () => {
        const s = scratch();
        const port = await freePort();
        const secret = 'k'.repeat(40);
        const service = startService(s, port, secret);
        const url = `http://127.0.0.1:${port}`;
        await until(
            () =>
                fetch(`${url}/healthz`)
                    .then((r) => r.ok)
                    .catch(() => false),
            20_000,
        );
        const health = await (await fetch(`${url}/healthz`)).json();
        expect(health).toMatchObject({ ok: true });
        for (const authorization of [undefined, 'Bearer wrong', `Basic ${secret}`]) {
            expect(
                (
                    await fetch(`${url}/v1/rpc`, {
                        method: 'POST',
                        headers: authorization ? { authorization } : {},
                        body: JSON.stringify({ op: 'status' }),
                    })
                ).status,
            ).toBe(401);
        }
        const client = new HttpAnalytics({ url, secret });
        client.start();
        cleanup.push(() => client.stop());
        await until(
            () =>
                client.query('freshness', {}).then(
                    () => true,
                    () => false,
                ),
            20_000,
        );
        expect(client.health().state).toBe('ready');
        expect(client.health().mode).toBe('service');
        expect(await client.query('freshness', {})).toMatchObject({
            sources: NO_TURNS_YET,
        });
        const wrong = new HttpAnalytics({ url, secret: 'x'.repeat(40) });
        await expect(wrong.query('freshness', {})).rejects.toMatchObject({
            code: 'unavailable',
        });
        expect(wrong.health()).toMatchObject({
            state: 'unavailable',
            detail: expect.stringMatching(/refused the secret/),
        });
        service.kill('SIGTERM');
        await new Promise((resolve) => service.once('exit', resolve));
        expect(statSync(join(s.analytics, 'ops.duckdb')).size).toBeGreaterThan(0);
    }, 30_000);
});

function startService(s: ReturnType<typeof scratch>, port: number, secret: string): ChildProcess {
    const service = spawn(process.execPath, ['--import', 'tsx', analyticsEntry()], {
        env: {
            OPS_ANALYTICS_MODE: 'service',
            OPS_ANALYTICS_SECRET: secret,
            OPS_ANALYTICS_HOST: '127.0.0.1',
            OPS_ANALYTICS_PORT: String(port),
            DATABASE_PATH: s.sqlitePath,
            OPS_ANALYTICS_DIR: s.analytics,
        },
        stdio: 'ignore',
    });
    cleanup.push(async () => {
        if (service.exitCode !== null || service.signalCode !== null) {
            return;
        }
        const exited = new Promise((resolve) => service.once('exit', resolve));
        service.kill('SIGKILL');
        await exited;
    });
    return service;
}

function freePort() {
    return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}
