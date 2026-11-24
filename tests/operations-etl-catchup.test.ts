import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';

import { ChildAnalytics } from '../src/server/operations/analytics/child.js';
import { AnalyticsError, type AnalyticsClient } from '../src/server/operations/analytics/client.js';
import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import { AnalyticsOpsReader } from '../src/server/operations/infra/analytics/reader.js';
import type { EtlStep } from '../src/server/operations/infra/duckdb/etl.js';
import { openDuck } from '../src/server/operations/infra/duckdb/open.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import '../src/server/operations/etl/sources.js';
import { operationsRoutes } from '../src/server/operations/routes.js';

import {
    HOUR,
    DAY,
    cleanup,
    scratch,
    seed,
    engine,
    until,
    ask,
    caughtUp,
    scopeOf,
    dump,
    sameAnswers,
    memoryOf,
    runCleanup,
} from './support/operations-etl.js';

// The Operations ETL (CB-187): turns, messages and tool calls copied from
// SQLite into DuckDB by the analytics process, with watermarks, rollups and
// the Overview's queries, checked against CB-184's in-memory reader. (Split from operations-etl.test.ts.)

afterEach(runCleanup);

// Each builds DuckDB files from a seeded database: slow on a loaded host.
describe('the ETL', { timeout: 120_000 }, () => {
    it('catches up after downtime, re-reads running turns, and is idempotent', async () => {
        const s = scratch();
        const seeded = seed(s, { turns: 300 });
        const first = engine(s);
        await first.e.start();
        await caughtUp(first.e, seeded.db);
        const running = seeded.turns.filter((t) => t.status === 'running');
        expect(running.length).toBe(2);
        await first.e.stop();
        // Down: turns finish and new ones arrive, more than one batch of them.
        for (const turn of running) {
            seeded.finish(turn.runId, Date.now() - 1000);
        }
        seeded.more(1200, { from: Date.now() - 20 * HOUR, spanMs: 19 * HOUR });
        const second = engine(s);
        await second.e.start();
        await caughtUp(second.e, seeded.db);
        const memory = memoryOf(seeded);
        const now = Date.now();
        await sameAnswers(
            second.e,
            memory,
            [
                { from: now - 2 * DAY, to: now, bucket: 'hour' },
                { from: null, to: now, bucket: 'day', previous: false },
            ],
            undefined,
            [{}, { person: 'bob' }],
        );
        const turns = await ask<{ items: { runId: string; status: string }[] }>(second.e, 'turns', {
            ...scopeOf({
                from: running[0]!.startedAt,
                to: running[1]!.startedAt + 1,
                bucket: 'hour',
            }),
            limit: 200,
        });
        expect(turns.items.filter((t) => running.some((r) => r.runId === t.runId))).toEqual(
            running.map((r) => expect.objectContaining({ runId: r.runId, status: 'finished' })).reverse(),
        );
        await second.e.stop();
        const file = join(s.analytics, 'ops.duckdb');
        const caught = await dump(file);

        // Reading everything again over the same file changes nothing.
        const again = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.analytics, 'tmp'),
        });
        const c = await again.connect();
        await c.run(`UPDATE etl_state SET watermark = NULL WHERE source IN ('agent_runs', 'dimensions')`);
        c.closeSync();
        again.closeSync();
        const third = engine(s);
        await third.e.start();
        await caughtUp(third.e, seeded.db);
        await until(async () => {
            const fresh = await ask<{
                sources: { source: string; watermark: string | null }[];
            }>(third.e, 'freshness');
            // The two reset (sources with nothing to read keep none).
            return fresh.sources
                .filter((source) => ['agent_runs', 'dimensions'].includes(source.source))
                .every((source) => source.watermark !== null);
        });
        await third.e.stop();
        expect(await dump(file)).toEqual(caught);

        // A rebuild from scratch gives the same store.
        rmSync(s.analytics, { recursive: true, force: true });
        const fourth = engine(s);
        await fourth.e.start();
        await caughtUp(fourth.e, seeded.db);
        await fourth.e.stop();
        expect(await dump(file)).toEqual(caught);
    });

    it('answers "rebuilding", not errors, while a store of another version rebuilds', async () => {
        const s = scratch();
        const seeded = seed(s, { turns: 300 });
        // A store as CB-186 left it: version 1, no fact tables.
        const old = new AnalyticsEngine({
            dir: s.analytics,
            sqlitePath: s.sqlitePath,
            defaults: analyticsDefaults({}),
            steps: [],
            etlVersion: 1,
            lockRetryMs: 100,
            log: () => undefined,
        });
        await old.start();
        await until(() => old.status().state === 'ready');
        await old.stop();
        // The upgrade: rebuilt with the facts, held part way.
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        const held: EtlStep = {
            source: 'held',
            ddl: [],
            async batch() {
                await hold;
                return { caughtUp: true };
            },
        };
        const e = new AnalyticsEngine({
            dir: s.analytics,
            sqlitePath: s.sqlitePath,
            defaults: analyticsDefaults({}),
            steps: [...ETL_STEPS, held],
            etlVersion: ETL_VERSION,
            lockRetryMs: 100,
            log: () => undefined,
        });
        cleanup.push(async () => {
            release();
            await e.stop();
        });
        await e.start();
        await until(() => e.status().state === 'rebuilding');
        const now = Date.now();
        const scope = scopeOf({ from: now - 7 * DAY, to: now, bucket: 'hour' });
        for (const [query, params] of [
            ['status', {}],
            ['overview', scope],
            ['series', { ...scope, metric: 'turns' }],
            ['turns', { ...scope, limit: 10 }],
        ] as const) {
            expect(await e.handle({ op: 'query', query, params }), query).toMatchObject({
                ok: false,
                code: 'not_ready',
                error: expect.stringMatching(/^Rebuilding \d+%\.$/),
            });
        }
        // Through the port and the routes: the state, never a 500.
        const client = {
            health: () => ({ mode: 'child' as const, ...e.status() }),
            async query(name: OpsQueryName, params: object) {
                const answer = await e.handle({ op: 'query', query: name, params });
                if (!answer.ok) {
                    throw new AnalyticsError(answer.error, answer.code);
                }
                return answer.value;
            },
        } as unknown as Pick<AnalyticsClient, 'query' | 'health'>;
        const reader = new AnalyticsOpsReader(client);
        expect(await reader.status()).toMatchObject({
            state: 'rebuilding',
            earliest: null,
        });
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
            c.set('user', { id: 'alice', name: 'Alice', role: 'admin' });
            await next();
        });
        let saved = {};
        app.route(
            '/api',
            operationsRoutes({
                reader,
                settings: {
                    settings: () => saved as never,
                    async updateSettings(patch) {
                        saved = { ...saved, ...patch };
                        return saved as never;
                    },
                },
            }),
        );
        for (const path of [
            '/api/operations/status',
            '/api/operations/overview',
            '/api/operations/series/turns',
            '/api/operations/turns',
        ]) {
            const response = await app.request(path);
            expect(response.status, path).toBe(200);
            const body = (await response.json()) as {
                state?: string;
                status?: { state: string };
                items?: unknown[];
            };
            // The turns list carries no status: it is empty.
            if (path === '/api/operations/turns') {
                expect(body.items).toEqual([]);
            } else {
                expect(body.state ?? body.status?.state, path).toBe('rebuilding');
            }
        }
        // The backstop: a query that fails while rebuilding isn't an error.
        const failing = new AnalyticsOpsReader({
            health: () => ({ mode: 'child', state: 'rebuilding', progress: 40 }),
            query: () => Promise.reject(new AnalyticsError('Table gone', 'failed')),
        });
        expect(await failing.status()).toEqual({
            state: 'rebuilding',
            asOf: null,
            earliest: null,
            progress: 40,
        });
        expect(await failing.turns(scope, { limit: 5 })).toEqual({
            items: [],
            next: null,
        });
        release();
        await caughtUp(e, seeded.db);
        expect(await reader.status()).toMatchObject({ state: 'ready' });
    });

    it('runs in the analytics child process, read through the OpsReader port', async () => {
        const s = scratch();
        const seeded = seed(s, { turns: 200 });
        const client = new ChildAnalytics(
            {
                mode: 'child',
                dir: s.analytics,
                databasePath: s.sqlitePath,
                env: {
                    OPS_ANALYTICS_LOCK_RETRY_MS: '200',
                    OPS_TIME_ZONE: 'Asia/Kolkata',
                },
            },
            { backoff: { firstMs: 100, maxMs: 1_000 }, log: () => undefined },
        );
        cleanup.push(() => client.stop());
        // Before the store has a file: the port's rule, nulls and no rows.
        const reader = new AnalyticsOpsReader(client);
        const early = scopeOf({
            from: Date.now() - DAY,
            to: Date.now(),
            bucket: 'hour',
        });
        expect(await reader.overview(early)).toEqual(await new MemoryOpsReader().overview(early));
        expect(await reader.turns(early, { limit: 5 })).toEqual({
            items: [],
            next: null,
        });
        expect((await reader.status()).earliest).toBeNull();
        client.start();
        await until(() => client.health().state === 'ready');
        const now = Date.now();
        const scope = scopeOf({
            from: now - 30 * DAY,
            to: now,
            bucket: 'day',
            timeZone: 'Asia/Kolkata',
        });
        const memory = memoryOf(seeded);
        await until(async () => {
            const tiles = await client.query('overview', scope).catch(() => []);
            return tiles.find((tile) => tile.id === 'turns')?.value === (await memory.overview(scope))[0]!.value;
        });
        expect(await reader.overview(scope)).toEqual(await memory.overview(scope));
        expect(await reader.series(scope, 'people')).toEqual(await memory.series(scope, 'people'));
        const first = await reader.turns(scope, { limit: 20 });
        expect(first).toEqual(await memory.turns(scope, { limit: 20 }));
        expect(await reader.turns(scope, { cursor: first.next!, limit: 20 })).toEqual(
            await memory.turns(scope, { cursor: first.next!, limit: 20 }),
        );
        expect(await reader.status()).toMatchObject({
            state: 'ready',
            earliest: (await memory.status()).earliest,
        });
        // A bad scope is refused, not run.
        await expect(
            client.query('overview', {
                ...scope,
                window: { ...scope.window, timeZone: 'Mars/Olympus' },
            }),
        ).rejects.toMatchObject({ code: 'bad_request' });
    }, 60_000);
});
