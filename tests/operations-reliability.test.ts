import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { runFacts } from '@socio/foundation/operations/run-facts';
import { FAILURE_CATEGORIES, TAXONOMY_VERSION } from '@socio/shared/failure-taxonomy';
import type { CursorPage, OpsBucket, OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import {
    RELIABILITY_DIMENSIONS,
    type OpsFailureRow,
    type OpsReliability,
    type OpsReliabilityBreakdown,
    type OpsReliabilityFriction,
    type OpsReliabilityIssues,
    type OpsReliabilitySeries,
} from '@socio/shared/operations/operations-reliability';
import type { User } from '@socio/shared/types';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { openDuck, rows } from '../src/server/operations/infra/duckdb/open.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { operationsRoutes } from '../src/server/operations/routes.js';
import '../src/server/operations/etl/sources.js';

import { seedFailureDatabase, type FailureSeeded } from './fixtures/seed-ops-failures.js';

// Operations → Reliability (CB-189): the failure taxonomy applied by the
// ETL, and the section's queries, the DuckDB store's answers checked
// against the in-memory reader's over a seeded database.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-reliability-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return {
        dir,
        sqlitePath: join(dir, 'company-brain.sqlite'),
        analytics: join(dir, 'analytics'),
    };
}

function engine(s: ReturnType<typeof scratch>) {
    const e = new AnalyticsEngine({
        dir: s.analytics,
        sqlitePath: s.sqlitePath,
        defaults: analyticsDefaults({}),
        defaultTimeZone: 'UTC',
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: () => {},
    });
    cleanup.push(() => e.stop());
    return e;
}

async function until<T>(check: () => T | Promise<T>, timeoutMs = 60_000): Promise<NonNullable<T>> {
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

async function ask<T = unknown>(e: AnalyticsEngine, query: OpsQueryName, params: object = {}): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params });
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

function windowOf(from: number | null, to: number, bucket: OpsBucket, previous = true): OpsWindow {
    return {
        from,
        to,
        bucket,
        buckets: [bucket],
        previous: previous && from !== null ? { from: from - (to - from), to: from } : null,
        timeZone: 'UTC',
    };
}

const memoryOf = (seeded: FailureSeeded) =>
    new MemoryOpsReader({
        turns: seeded.turns,
        messages: seeded.messages,
        tools: seeded.tools,
        issues: seeded.issues,
    });

/** Seeds, builds the store, and waits until every step has read it all. */
async function built(turns = 900) {
    const s = scratch();
    const seeded = seedFailureDatabase(s.sqlitePath, {
        turns,
        start: Date.now() - 40 * DAY,
        spanMs: 39 * DAY,
    });
    cleanup.push(() => seeded.db.close());
    const e = engine(s);
    await e.start();
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const summary = await ask<{ turns: number | null }>(e, 'reliability', {
            window: windowOf(null, Date.now() + DAY, 'month', false),
            filters: {},
        }).catch(() => ({ turns: null }));
        const fresh = await ask<{ sources: { source: string }[] }>(e, 'freshness').catch(() => ({ sources: [] }));
        return summary.turns === turns && fresh.sources.some((source) => source.source === 'issues');
    });
    return { s, seeded, e, memory: memoryOf(seeded) };
}

const FILTERS: OpsFilters[] = [
    {},
    { socio: 'socio-b' },
    { space: 'space-1' },
    { source: 'scheduled' },
    { person: 'alice' },
    { person: 'nobody' },
];

/** Every page of the failures list, both ways. */
async function samePages(
    e: AnalyticsEngine,
    memory: MemoryOpsReader,
    scope: OpsScope,
    filter: { category?: (typeof FAILURE_CATEGORIES)[number]; tool?: string },
) {
    let cursor: { key: number | string; id: string } | undefined;
    let seen = 0;
    for (;;) {
        const page = { limit: 40, ...(cursor ? { cursor } : {}) };
        const mine = await ask<CursorPage<OpsFailureRow> & { next: typeof cursor }>(e, 'failures', {
            ...scope,
            ...page,
            ...filter,
        });
        expect(mine, JSON.stringify(filter)).toEqual(await memory.failures(scope, page, filter));
        seen += mine.items.length;
        if (!mine.next) {
            return seen;
        }
        cursor = mine.next ?? undefined;
    }
}

describe('a turn’s failure category', () => {
    it('comes from its status, codes and last round, and its tools’ from theirs', () => {
        const facts = runFacts({
            seq: 1,
            runId: 'r1',
            threadId: 't1',
            status: 'failed',
            startedAt: 1000,
            finishedAt: 2000,
            source: 'web',
            socioId: 's1',
            ownerId: 'alice',
            detail: 1,
            events: JSON.stringify([{ type: 'RUN_ERROR', code: 'failed', timestamp: 2000 }]),
            trace: JSON.stringify({
                rounds: [{ round: 1, stop: 'error', error: 'TypeError' }],
                tools: [
                    {
                        name: 'http_get',
                        outcome: 'error',
                        error: 'failed',
                        startedAt: 1100,
                        endedAt: 1300,
                    },
                    { name: 'read_page', outcome: 'ok', startedAt: 1400, endedAt: 1500 },
                ],
                fallback: { reason: 'usage_limit' },
                end: { reason: 'error' },
            }),
        });
        expect(facts.turn).toMatchObject({
            failureCode: 'failed',
            lastStop: 'error',
            hasDetail: true,
            fallbackReason: 'usage_limit',
            failureCategory: 'model_provider',
            failureRule: 'after_fallback',
        });
        expect(facts.tools.map((tool) => [tool.category, tool.categoryRule])).toEqual([
            ['external_service', 'web'],
            [null, 'ok'],
        ]);
        // No detail, no fallback: a runtime error; a finished turn: none.
        const plain = runFacts({
            seq: 2,
            runId: 'r2',
            threadId: 't1',
            status: 'finished',
            startedAt: 1000,
            finishedAt: 2000,
            source: 'web',
            socioId: 's1',
            ownerId: 'alice',
            events: '[]',
            trace: JSON.stringify({ end: { reason: 'completed' } }),
        });
        expect(plain.turn).toMatchObject({
            hasDetail: false,
            failureCategory: null,
            failureRule: 'ok',
        });
    });
});

// Each builds a DuckDB file from a seeded database: slow on a loaded host.
describe('Reliability over the analytics store', { timeout: 180_000 }, () => {
    it('answers every query as the in-memory reader does', async () => {
        const { e, memory, seeded } = await built();
        const now = Date.now();
        const windows = [
            windowOf(now - 7 * DAY, now, 'hour'),
            windowOf(now - 30 * DAY, now, 'day'),
            windowOf(now - 30 * DAY, now, 'week'),
            windowOf(null, now, 'month', false),
            windowOf(now - 20 * DAY, now - 9 * DAY + 17_000, 'day'),
        ];
        for (const window of windows) {
            for (const filters of FILTERS) {
                const scope: OpsScope = { window, filters };
                const label = JSON.stringify(scope);
                expect(await ask(e, 'reliability', scope), label).toEqual(await memory.reliability(scope));
                expect(await ask(e, 'failureSeries', scope), label).toEqual(await memory.failureSeries(scope));
                for (const by of RELIABILITY_DIMENSIONS) {
                    expect(await ask(e, 'failureBreakdown', { ...scope, by }), `${label} ${by}`).toEqual(
                        await memory.failureBreakdown(scope, by),
                    );
                }
                expect(await ask(e, 'friction', scope), label).toEqual(await memory.friction(scope));
                expect(await ask(e, 'issueVelocity', scope), label).toEqual(await memory.issueVelocity(scope));
            }
        }

        // The numbers are the scenarios', not just equal: every category
        // shows, Unclassified on its own and interrupted turns counted apart.
        const all: OpsScope = {
            window: windowOf(null, now, 'month', false),
            filters: {},
        };
        const summary = await memory.reliability(all);
        for (const category of FAILURE_CATEGORIES) {
            const count = summary.categories.find((c) => c.category === category)!;
            expect(count.turns + count.tools, category).toBeGreaterThan(0);
        }
        expect(summary.interrupted).toBe(seeded.turns.filter((t) => t.failureRule === 'interrupted').length);
        expect(summary.interrupted).toBeGreaterThan(0);
        expect(summary.failures).toBe(
            seeded.turns.filter((t) => t.failureCategory && t.failureCategory !== 'stopped').length,
        );
        const friction = await memory.friction(all);
        expect(friction.rows.length).toBeGreaterThan(0);
        expect(friction.rows.every((row) => row.people >= 3 || row.mostForOne >= 5)).toBe(true);
        const tools = await memory.failureBreakdown(all, 'tool');
        expect(tools[0]).toMatchObject({ key: 'http_get' });
        expect(tools[0]!.p95Ms).toBeGreaterThanOrEqual(tools[0]!.p50Ms!);
        const issues = await memory.issueVelocity(all);
        expect(issues.reported).toBe(seeded.issues.filter((i) => i.deletedAt === null).length);
        expect(issues.medianResolveMs).toBeGreaterThan(0);
    });

    it('lists failures newest first, a page at a time, by category and tool', async () => {
        const { e, memory } = await built(600);
        const now = Date.now();
        const scope: OpsScope = {
            window: windowOf(now - 30 * DAY, now, 'day'),
            filters: {},
        };
        const everything = await samePages(e, memory, scope, {});
        expect(everything).toBeGreaterThan(40);
        let byCategory = 0;
        for (const category of FAILURE_CATEGORIES) {
            byCategory += await samePages(e, memory, scope, { category });
        }
        // Every row has one category; Stopped turns aren't failures.
        expect(byCategory).toBe(everything);
        expect(await samePages(e, memory, scope, { category: 'stopped' })).toBe(0);
        expect(await samePages(e, memory, scope, { tool: 'http_get' })).toBeGreaterThan(0);
        await samePages(
            e,
            memory,
            { ...scope, filters: { person: 'alice' } },
            {
                category: 'quotas',
            },
        );
    });

    it('re-runs the rules over the stored codes when the taxonomy changes', async () => {
        const { s, e, memory } = await built(300);
        const now = Date.now();
        const scope: OpsScope = {
            window: windowOf(null, now, 'month', false),
            filters: {},
        };
        const before = await ask(e, 'reliability', scope);
        await e.stop();
        // As a store made by an older taxonomy: other categories, older version.
        const file = join(s.analytics, 'ops.duckdb');
        const instance = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.analytics, 'tmp'),
        });
        const c = await instance.connect();
        await c.run(`UPDATE f_turn SET failure_category = 'unclassified', failure_rule = 'old'`);
        await c.run(`UPDATE f_tool SET category = NULL, category_rule = 'old'`);
        await c.run(`UPDATE etl_state SET watermark = '0' WHERE source = 'taxonomy'`);
        c.closeSync();
        instance.closeSync();
        const again = engine(s);
        await again.start();
        await until(async () => {
            const fresh = await ask<{
                sources: { source: string; watermark: string | null }[];
            }>(again, 'freshness').catch(() => ({ sources: [] }));
            return fresh.sources.some(
                (source) => source.source === 'taxonomy' && source.watermark === String(TAXONOMY_VERSION),
            );
        });
        await again.stop();
        const reopened = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.analytics, 'tmp'),
        });
        const r = await reopened.connect();
        expect(await rows(r, `SELECT count(*) AS n FROM f_turn WHERE failure_rule = 'old'`)).toEqual([{ n: 0 }]);
        expect(await rows(r, `SELECT count(*) AS n FROM f_tool WHERE category_rule = 'old'`)).toEqual([{ n: 0 }]);
        r.closeSync();
        reopened.closeSync();
        const third = engine(s);
        await third.start();
        await until(() => third.status().state === 'ready');
        expect(await ask(third, 'reliability', scope)).toEqual(before);
        expect(before).toEqual(await memory.reliability(scope));
    });
});

describe('the in-memory reader with no data', () => {
    it('answers nulls and empty lists, never zeros', async () => {
        const memory = new MemoryOpsReader();
        const scope: OpsScope = {
            window: windowOf(0, DAY, 'hour'),
            filters: {},
        };
        expect(await memory.reliability(scope)).toMatchObject({
            turns: null,
            failures: null,
            categories: [],
        });
        expect(await memory.failureSeries(scope)).toEqual([]);
        expect(await memory.failureBreakdown(scope, 'tool')).toEqual([]);
        expect(await memory.failures(scope, { limit: 10 })).toEqual({
            items: [],
            next: null,
        });
        expect(await memory.friction(scope)).toEqual({ from: 0, rows: [] });
        expect(await memory.issueVelocity(scope)).toMatchObject({
            reported: null,
            points: [],
        });
    });
});

describe('the routes', () => {
    const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
    function app() {
        const now = Date.now();
        const turns = Array.from({ length: 10 }, (_, i) => ({
            runId: `run-${i}`,
            threadId: 't1',
            socioId: 's1',
            socioName: 'Manny',
            personId: 'bob',
            source: 'web',
            status: 'failed' as const,
            startedAt: now - (i + 1) * HOUR,
            finishedAt: now - (i + 1) * HOUR + 5000,
            failureCategory: i % 2 ? ('quotas' as const) : ('runtime_error' as const),
            failureRule: i % 2 ? 'quota_code' : 'failed',
            failureCode: i % 2 ? 'chatgpt_usage_limit' : 'failed',
        }));
        const reader = new MemoryOpsReader({
            turns,
            tools: [
                {
                    runId: 'run-0',
                    idx: 0,
                    tool: 'http_get',
                    code: 'failed',
                    category: 'external_service',
                    rule: 'web',
                    startedAt: now - HOUR,
                    durationMs: 300,
                },
            ],
            issues: [
                {
                    kind: 'bug',
                    reporterId: 'bob',
                    createdAt: now - 2 * DAY,
                    closedAt: now - DAY,
                },
            ],
        });
        const settings = { operations: {} } as never;
        const routes = operationsRoutes({
            reader,
            settings: {
                settings: () => settings,
                updateSettings: async () => settings,
            },
        });
        const outer = new Hono<AppEnv>();
        outer.use(async (c, next) => {
            c.set('user', alice);
            await next();
        });
        outer.route('/api', routes);
        return outer;
    }
    const get = async <T>(path: string, status = 200) => {
        const response = await app().request(`/api/operations/reliability${path}`);
        expect(response.status, path).toBe(status);
        return (await response.json()) as T;
    };

    it('answers each part of the section, with the range and filters', async () => {
        const summary = await get<OpsReliability>('?range=7d');
        expect(summary.summary).toMatchObject({ turns: 10, failures: 10 });
        expect(summary.window.bucket).toBe('hour');
        const series = await get<OpsReliabilitySeries>('/series?range=24h');
        expect(series.points.reduce((sum, p) => sum + p.failures, 0)).toBe(10);
        const tools = await get<OpsReliabilityBreakdown>('/breakdown/tool');
        expect(tools.rows).toEqual([expect.objectContaining({ key: 'http_get', failed: 1, p50Ms: 300 })]);
        expect((await get<OpsReliabilityBreakdown>('/breakdown/code')).rows.map((row) => [row.key, row.total])).toEqual(
            [
                ['chatgpt_usage_limit', 5],
                ['failed', 5],
            ],
        );
        await get('/breakdown/weather', 404);
        const friction = await get<OpsReliabilityFriction>('/friction');
        // Five times for one person: the newest first.
        expect(friction.rows).toEqual([
            expect.objectContaining({ category: 'runtime_error', mostForOne: 5 }),
            expect.objectContaining({ category: 'quotas', people: 1 }),
        ]);
        const issues = await get<OpsReliabilityIssues>('/issues?range=7d');
        expect(issues.issues).toMatchObject({
            reported: 1,
            resolved: 1,
            medianResolveMs: DAY,
        });
        expect((await get<OpsReliabilityIssues>('/issues?person=carol')).issues.reported).toBe(0);
        await get('?range=1y', 400);
    });

    it('pages the failures list and narrows it by category and tool', async () => {
        const first = await get<CursorPage<OpsFailureRow>>('/failures?limit=3');
        expect(first.items.map((row) => row.runId)).toEqual(['run-0', 'run-1', 'run-2']);
        expect(first.items[0]).toMatchObject({ tool: 'http_get', toolFailures: 1 });
        const second = await get<CursorPage<OpsFailureRow>>(`/failures?limit=3&cursor=${first.next}`);
        expect(second.items.map((row) => row.runId)).toEqual(['run-3', 'run-4', 'run-5']);
        expect(
            (await get<CursorPage<OpsFailureRow>>('/failures?category=quotas')).items.map((row) => row.runId),
        ).toEqual(['run-1', 'run-3', 'run-5', 'run-7', 'run-9']);
        expect((await get<CursorPage<OpsFailureRow>>('/failures?tool=http_get')).items).toHaveLength(1);
        await get('/failures?category=weather', 400);
        await get('/failures?tool=a%20b', 400);
        await get('/failures?cursor=nope!', 400);
    });
});
