import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFacts } from '@socio/foundation/operations/run-facts';
import { bucketStarts } from '@socio/shared/operations/operations';
import type { OpsBucket, OpsFilters, OpsWindow } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import {
    goalState,
    HEALTH_METRICS,
    scheduleState,
    SCHEDULE_LATE_MS,
    type HealthFacts,
} from '@socio/shared/operations/operations-health';

import { AnalyticsEngine } from '../../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../../src/server/operations/domain/ops-queries.js';
import type { OpsScope } from '../../src/server/operations/domain/reader.js';
import { readKeysetWatermark } from '../../src/server/operations/etl/health-steps.js';
import { quantile, type JobRunFact } from '../../src/server/operations/infra/memory/health.js';
import '../../src/server/operations/etl/sources.js';
import { MemoryOpsReader } from '../../src/server/operations/infra/memory/reader.js';
import { seedHealthDatabase, type HealthSeeded } from '../fixtures/seed-ops-health.js';

// Operations → Health (CB-192): model rounds, job and scheduled runs,
// schedules, goals and long runs copied into DuckDB, and Health's queries
// checked against the in-memory reader's.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A pinned clock so the suite never depends on the real wall-clock date. The
// hourly America/New_York window crosses the 2026-11-01 fall-back (06:00Z), so
// the repeated 1 a.m. hour is always exercised (CB-324).
const NOW = Date.UTC(2026, 10, 1, 8, 0, 0);

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-health-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return {
        sqlitePath: join(dir, 'company-brain.sqlite'),
        analytics: join(dir, 'analytics'),
    };
}

async function until<T>(check: () => T | Promise<T>, timeoutMs = 30_000) {
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

function scopeOf(
    { from, to, bucket, timeZone = 'UTC' }: { from: number | null; to: number; bucket: OpsBucket; timeZone?: string },
    filters: OpsFilters = {},
): OpsScope {
    const window: OpsWindow = {
        from,
        to,
        bucket,
        buckets: [bucket],
        previous: null,
        timeZone,
    };
    return { window, filters };
}

/** A store built from a seeded database, caught up, and its memory twin. */
async function built(now: number = NOW): Promise<{
    e: AnalyticsEngine;
    seeded: HealthSeeded;
    memory: MemoryOpsReader;
    now: number;
}> {
    const s = scratch();
    const seeded = seedHealthDatabase(s.sqlitePath, { now });
    cleanup.push(() => seeded.db.close());
    const e = new AnalyticsEngine({
        dir: s.analytics,
        sqlitePath: s.sqlitePath,
        defaults: analyticsDefaults({}),
        defaultTimeZone: 'UTC',
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: () => undefined,
        now: () => now,
    });
    cleanup.push(() => e.stop());
    e.start();
    const all = scopeOf({ from: null, to: now + DAY, bucket: 'week' });
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const facts = await ask<HealthFacts | null>(e, 'health', all).catch(() => null);
        return (
            facts?.jobRuns.total === seeded.health.jobRuns!.length &&
            facts.longRuns.running === 1 &&
            facts.tokens.byReasoning.reduce((sum, row) => sum + row.turns, 0) === seeded.turns.length
        );
    });
    return {
        e,
        seeded,
        memory: new MemoryOpsReader({
            turns: seeded.turns,
            health: seeded.health,
        }),
        now,
    };
}

const FILTERS: OpsFilters[] = [
    {},
    { socio: 'socio-a' },
    { space: 'space-1' },
    { person: 'alice' },
    { source: 'scheduled' },
    { socio: 'socio-b', person: 'bob' },
    { socio: 'nobody' },
];

/** Every page of a list, from the store, equal to the memory reader's. */
async function sameList(
    e: AnalyticsEngine,
    memory: MemoryOpsReader,
    name: 'healthSchedules' | 'healthRuns' | 'healthLongRuns',
    scope: OpsScope,
) {
    let cursor: { key: number | string; id: string } | undefined;
    let seen = 0;
    for (;;) {
        const page = { limit: 7, ...(cursor ? { cursor } : {}) };
        const mine = await ask<{ items: unknown[]; next: typeof cursor | null }>(e, name, { ...scope, ...page });
        expect(mine, `${name} ${JSON.stringify(scope.filters)}`).toEqual(await memory[name](scope, page));
        seen += mine.items.length;
        if (!mine.next) {
            return seen;
        }
        cursor = mine.next;
    }
}

describe('health states', () => {
    it('reads a schedule’s state from its row, worst first', () => {
        const now = Date.UTC(2026, 9, 22, 12);
        const at = (status: string, nextRunAt: number | null, error?: string) =>
            scheduleState({ status, nextRunAt, error: error ?? null }, now);
        expect(at('scheduled', now + HOUR)).toBe('ok');
        expect(at('scheduled', now - SCHEDULE_LATE_MS + 1000)).toBe('ok');
        expect(at('scheduled', now - SCHEDULE_LATE_MS - 1000)).toBe('overdue');
        expect(at('scheduled', now + HOUR, 'The model was busy.')).toBe('failing');
        expect(at('failed', null, 'Exit 1')).toBe('failing');
        // Paused after failures says why, but is paused.
        expect(at('paused', null, 'Paused after 3 failed runs in a row')).toBe('paused');
        expect(at('running', null)).toBe('ok');
        expect(at('cancelled', now - DAY)).toBe('stopped');
        expect(at('completed', null)).toBe('stopped');
        expect(at('completed', now + HOUR)).toBe('ok');
    });

    it('calls a goal stalled while its schedule fails or nothing changes for 14 days', () => {
        const now = Date.UTC(2026, 9, 22, 12);
        const goal = (status: string, updatedAt = now - DAY) => ({
            status,
            updatedAt,
        });
        expect(goalState(goal('active'), 'ok', now)).toBe('active');
        expect(goalState(goal('active'), 'paused', now)).toBe('stalled');
        expect(goalState(goal('active'), 'failing', now)).toBe('stalled');
        expect(goalState(goal('active', now - 14 * DAY), 'ok', now)).toBe('stalled');
        expect(goalState(goal('done'), 'failing', now)).toBe('done');
        expect(goalState(goal('cancelled'), undefined, now)).toBe('cancelled');
    });

    it('takes percentiles by nearest rank, as DuckDB’s quantile_disc does', () => {
        expect(quantile([], 0.5)).toBeNull();
        expect(quantile([7], 0.95)).toBe(7);
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
        expect(quantile([0, 100], 0.95)).toBe(100);
        const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(quantile(hundred, 0.5)).toBe(50);
        expect(quantile(hundred, 0.95)).toBe(95);
    });
});

it('names every ETL source in Health’s freshness, every section’s included', () => {
    const health = JSON.parse(
        readFileSync(new URL('../../packages/i18n/locales/en-US/operations.health.json', import.meta.url), 'utf8'),
    ) as { freshness: { source: Record<string, string> } };
    expect(ETL_STEPS.map((step) => step.source).filter((source) => !health.freshness.source[source])).toEqual([]);
});

describe('a turn’s rounds as facts', () => {
    it('keeps each model round’s first output and reasoning kind, not summaries', () => {
        const facts = runFacts({
            seq: 1,
            runId: 'r1',
            threadId: 't1',
            status: 'finished',
            startedAt: 1000,
            finishedAt: 9000,
            source: 'web',
            socioId: 's1',
            ownerId: 'alice',
            events: '[]',
            trace: JSON.stringify({
                turn: { model: 'gpt-5' },
                rounds: [
                    {
                        round: 1,
                        startedAt: 1000,
                        endedAt: 3000,
                        firstOutputMs: 420.4,
                        reasoningKind: 'summary',
                    },
                    { round: 1, startedAt: 3000, endedAt: 3500, summary: true },
                    { round: 2, startedAt: 3500, endedAt: 4000 },
                    'junk',
                ],
            }),
        });
        expect(facts.rounds).toEqual([
            {
                round: 1,
                startedAt: 1000,
                durationMs: 2000,
                firstOutputMs: 420,
                reasoningKind: 'summary',
            },
            {
                round: 2,
                startedAt: 3500,
                durationMs: 500,
                firstOutputMs: null,
                reasoningKind: 'unknown',
            },
        ]);
        expect(runFacts({ ...facts.turn, events: '[]', trace: null, ownerId: null }).rounds).toEqual([]);
    });

    it('reads a keyset watermark, and starts over on junk', () => {
        expect(readKeysetWatermark(null)).toEqual({ at: -1, id: '', open: [] });
        expect(readKeysetWatermark('{"at":5,"id":"x","open":["a",3]}')).toEqual({
            at: 5,
            id: 'x',
            open: ['a'],
        });
        expect(readKeysetWatermark('nope')).toEqual({ at: -1, id: '', open: [] });
    });
});

describe('Health over the analytics store', { timeout: 120_000 }, () => {
    it('answers as the memory reader does, for every filter, metric and list', async () => {
        const { e, memory, now } = await built();
        const windows = [
            { from: now - 30 * DAY, to: now + MIN, bucket: 'day' as const },
            {
                from: now - 7 * DAY,
                to: now + MIN,
                bucket: 'hour' as const,
                timeZone: 'America/New_York',
            },
            { from: null, to: now + MIN, bucket: 'week' as const },
        ];
        for (const window of windows) {
            for (const filters of FILTERS) {
                const scope = scopeOf(window, filters);
                const label = JSON.stringify({ window, filters });
                const mine = await ask<HealthFacts>(e, 'health', scope);
                expect({ ...mine, sources: [] }, label).toEqual(await memory.health(scope));
                for (const metric of HEALTH_METRICS) {
                    expect(await ask(e, 'healthSeries', { ...scope, metric }), `${label} ${metric}`).toEqual(
                        await memory.healthSeries(scope, metric),
                    );
                }
                const listed = [
                    await sameList(e, memory, 'healthSchedules', scope),
                    await sameList(e, memory, 'healthRuns', scope),
                    await sameList(e, memory, 'healthLongRuns', scope),
                ];
                // Not empty answers agreeing: the whole workspace has rows in each.
                if (!Object.keys(filters).length) {
                    expect(
                        listed.every((n) => n > 0),
                        label,
                    ).toBe(true);
                    expect(mine.latency.firstOutput.n, label).toBeGreaterThan(0);
                    expect(mine.queues.jobWait.n, label).toBeGreaterThan(0);
                }
            }
        }
    });

    it('keeps reasoning kinds apart, unknown as its own, and sums reasoning only where reported', async () => {
        const { e, seeded, now } = await built();
        const scope = scopeOf({ from: null, to: now + MIN, bucket: 'week' });
        const facts = await ask<HealthFacts>(e, 'health', scope);
        const kinds = facts.tokens.byReasoning.map((row) => row.kind);
        expect(kinds).toContain('unknown');
        expect(new Set(kinds).size).toBe(kinds.length);
        for (const row of facts.tokens.byReasoning) {
            const turns = seeded.turns.filter((turn) => (turn.reasoningKind ?? 'unknown') === row.kind);
            expect(row.turns).toBe(turns.length);
            const reported = turns.filter((turn) => turn.reasoningTokensReported);
            expect(row.reportedTurns).toBe(reported.length);
            expect(row.reasoning).toBe(
                reported.length ? reported.reduce((sum, turn) => sum + turn.reasoningTokens!, 0) : null,
            );
        }
        // Every ETL source, Health's included, says when it last ran.
        expect(facts.sources.map((source) => source.source)).toEqual(ETL_STEPS.map((step) => step.source).sort());
        expect(facts.sources.map((source) => source.source)).toEqual(
            expect.arrayContaining(['job_runs', 'runs', 'schedules']),
        );
        // Now: one schedule in each state the seed made, deleted ones and
        // research tasks left out; goals and long runs as planned.
        expect(facts.schedules).toMatchObject({
            ok: 3,
            overdue: 1,
            failing: 2,
            paused: 2,
            stopped: 1,
            runs: 90,
        });
        expect(facts.goals).toMatchObject({
            active: 1,
            stalled: 2,
            done: 2,
            cancelled: 1,
            doneInRange: 2,
            cancelledInRange: 1,
        });
        expect(facts.longRuns).toMatchObject({
            running: 1,
            waiting: 1,
            deadItems: 4,
            done: 1,
            failed: 1,
        });
        // Collection gaps: turns without traces, runs without due times.
        const coverage = Object.fromEntries(facts.coverage.map((row) => [row.id, row]));
        expect(coverage.trace!.total).toBe(seeded.turns.length);
        expect(coverage.trace!.covered).toBeLessThan(coverage.trace!.total);
        expect(coverage.dueAt!.covered).toBeLessThan(coverage.dueAt!.total);
        expect(coverage.dueAt!.total).toBe(90);
    });

    it('follows changes: a job run that starts, a schedule that recovers', async () => {
        const { e, seeded, now } = await built();
        const scope = scopeOf({
            from: now - 40 * DAY,
            to: now + DAY,
            bucket: 'day',
        });
        const before = await ask<HealthFacts>(e, 'health', scope);
        seeded.db
            .prepare(
                "UPDATE job_runs SET status='succeeded', startedAt=queuedAt + 1000, finishedAt=queuedAt + 2000 WHERE status='queued'",
            )
            .run();
        seeded.db
            .prepare("UPDATE tasks SET status='scheduled', error=NULL, nextRunAt=? WHERE id='sched-5'")
            .run(now + DAY);
        seeded.db
            .prepare(
                `INSERT INTO job_runs (id, jobId, version, userId, dotId, trigger, status, queuedAt, startedAt)
        VALUES ('jrun-new', 'job-1', 1, 'alice', 'socio-a', 'manual', 'running', ?, ?)`,
            )
            .run(now, now + 500);
        e.nudge();
        const after = await until(async () => {
            const facts = await ask<HealthFacts>(e, 'health', scope);
            return facts.jobRuns.total === before.jobRuns.total + 1 &&
                facts.schedules.failing === before.schedules.failing - 1
                ? facts
                : null;
        });
        expect(after.queues.jobWait.n).toBe(before.queues.jobWait.n + 3);
        expect(after.schedules.ok).toBe(before.schedules.ok + 1);
    });
});

describe('memory reader buckets DST hours like the analytics store (CB-324)', () => {
    // The analytics store buckets each point with an ASOF join on the shared
    // bucket starts (the latest start at or before the point). The memory reader
    // must agree: re-bucketing each point's wall clock instead folds the repeated
    // fall-back hour into the one before it. Points here are placed by absolute
    // UTC time across each DST change in America/New_York, so the suite pins the
    // behavior instead of depending on the date it runs.
    const tz = 'America/New_York';

    function reader(jobRuns: { queuedAt: number; startedAt: number | null }[]) {
        const facts: JobRunFact[] = jobRuns.map((run, i) => ({
            id: `j-${i}`,
            socioId: 'socio-a',
            personId: 'alice',
            status: run.startedAt === null ? 'queued' : 'succeeded',
            queuedAt: run.queuedAt,
            startedAt: run.startedAt,
            wakeMs: null,
        }));
        return new MemoryOpsReader({
            health: {
                jobRuns: facts,
                socios: [{ id: 'socio-a', name: 'A', spaceId: 'space-1' }],
                people: [{ id: 'alice', name: 'Alice' }],
            },
        });
    }

    it('keeps the repeated fall-back hour as two separate buckets', async () => {
        // 2026-11-01 fall-back: 02:00 EDT (05:00Z) -> 01:00 EST (06:00Z), so the
        // 1 a.m. wall-clock hour occurs twice. One job run queued in each, with a
        // one-minute wait.
        const memory = reader([
            {
                queuedAt: Date.UTC(2026, 10, 1, 5, 30),
                startedAt: Date.UTC(2026, 10, 1, 5, 31),
            },
            {
                queuedAt: Date.UTC(2026, 10, 1, 6, 30),
                startedAt: Date.UTC(2026, 10, 1, 6, 31),
            },
        ]);
        const from = Date.UTC(2026, 10, 1, 4);
        const to = Date.UTC(2026, 10, 1, 9);
        const scope = scopeOf({ from, to, bucket: 'hour', timeZone: tz });
        const series = await memory.healthSeries(scope, 'job_wait');
        expect(series.map((point) => point.at)).toEqual(bucketStarts(from, to, 'hour', tz));
        const byAt = new Map(series.map((point) => [point.at, point]));
        expect(byAt.get(Date.UTC(2026, 10, 1, 5))!.n).toBe(1); // EDT 1 a.m.
        expect(byAt.get(Date.UTC(2026, 10, 1, 5))!.p95).toBe(60_000);
        expect(byAt.get(Date.UTC(2026, 10, 1, 6))!.n).toBe(1); // EST 1 a.m., its own bucket
        expect(byAt.get(Date.UTC(2026, 10, 1, 6))!.p95).toBe(60_000);
        expect(byAt.get(Date.UTC(2026, 10, 1, 4))!.n).toBe(0);
        expect(byAt.get(Date.UTC(2026, 10, 1, 7))!.n).toBe(0);
        expect(byAt.get(Date.UTC(2026, 10, 1, 8))!.n).toBe(0);
    });

    it('keeps the spring-forward gap on one timeline, with no repeated bucket', async () => {
        // 2026-03-08 spring-forward: 02:00 EST (07:00Z) -> 03:00 EDT, so 2 a.m. is
        // skipped. The bucket that starts at 07:00Z is the 03:00 EDT hour, and the
        // 03:30 EDT point lands in it, not folded into the next bucket.
        const memory = reader([
            {
                queuedAt: Date.UTC(2026, 2, 8, 6, 30),
                startedAt: Date.UTC(2026, 2, 8, 6, 31),
            }, // 01:30 EST
            {
                queuedAt: Date.UTC(2026, 2, 8, 7, 30),
                startedAt: Date.UTC(2026, 2, 8, 7, 31),
            }, // 03:30 EDT
        ]);
        const from = Date.UTC(2026, 2, 8, 5);
        const to = Date.UTC(2026, 2, 8, 10);
        const scope = scopeOf({ from, to, bucket: 'hour', timeZone: tz });
        const series = await memory.healthSeries(scope, 'job_wait');
        expect(series.map((point) => point.at)).toEqual(bucketStarts(from, to, 'hour', tz));
        const byAt = new Map(series.map((point) => [point.at, point]));
        expect(byAt.get(Date.UTC(2026, 2, 8, 6))!.n).toBe(1); // 01:00 EST
        expect(byAt.get(Date.UTC(2026, 2, 8, 7))!.n).toBe(1); // the 03:00 EDT bucket (07:00Z)
        expect(byAt.get(Date.UTC(2026, 2, 8, 5))!.n).toBe(0);
        expect(byAt.get(Date.UTC(2026, 2, 8, 8))!.n).toBe(0);
        expect(byAt.get(Date.UTC(2026, 2, 8, 9))!.n).toBe(0);
    });
});
