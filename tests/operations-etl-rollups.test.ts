import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bucketStart } from '@socio/shared/operations/operations';

import { openDuck, rows } from '../src/server/operations/infra/duckdb/open.js';
import '../src/server/operations/etl/sources.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';

import {
    HOUR,
    DAY,
    scratch,
    seed,
    engine,
    until,
    ask,
    caughtUp,
    windowOf,
    scopeOf,
    cycled,
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
    it('keeps rollups equal to the facts, cut in the reporting time zone, and recuts them when it changes', async () => {
        const s = scratch();
        // Around both of New York's clock changes in 2025-26, hourly kept.
        const seeded = seed(s, {
            turns: 500,
            start: Date.UTC(2025, 10, 1),
            spanMs: 3 * DAY,
        });
        seeded.more(500, { from: Date.UTC(2026, 2, 7), spanMs: 3 * DAY });
        const { e } = engine(s, { hourlyDays: 3650 }, 'America/New_York');
        await e.start();
        await caughtUp(e, seeded.db);
        const memory = memoryOf(seeded);
        const windows: Parameters<typeof windowOf>[0][] = [];
        for (const timeZone of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
            for (const [from, to] of [
                [Date.UTC(2025, 10, 1, 7, 13), Date.UTC(2025, 10, 4)],
                [Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 10, 9, 30)],
            ] as const) {
                windows.push({ from, to, bucket: 'hour', timeZone });
                windows.push({ from, to, bucket: 'day', timeZone });
            }
        }
        windows.push({
            from: null,
            to: Date.UTC(2026, 3, 1),
            bucket: 'week',
            timeZone: 'America/New_York',
            previous: false,
        });
        windows.push({
            from: null,
            to: Date.UTC(2026, 3, 1),
            bucket: 'month',
            timeZone: 'America/New_York',
            previous: false,
        });
        await sameAnswers(e, memory, windows, undefined, [{}, { socio: 'socio-a' }, { person: 'alice' }]);

        const rollups = async (timeZone: string) => {
            const file = join(s.analytics, 'ops.duckdb');
            const instance = await openDuck(file, {
                memoryMb: 128,
                threads: 1,
                tempDir: join(s.analytics, 'tmp'),
            });
            const c = await instance.connect();
            try {
                const daily = await rows<Record<string, number | string | null>>(
                    c,
                    'SELECT day_at, socio_id, source, person_id, turns, failed, tokens, messages FROM r_daily',
                );
                const hourly = await rows<Record<string, number | string | null>>(
                    c,
                    'SELECT hour_at, socio_id, source, person_id, turns, failed, tokens, messages FROM r_hourly',
                );
                // The same sums from the seed's own facts, bucketed by CB-184's rules.
                const expected = (bucket: 'hour' | 'day') => {
                    const out = new Map<string, number[]>();
                    const add = (at: number, socio: string, source: string, person: string | null, v: number[]) => {
                        const key = JSON.stringify([bucketStart(at, bucket, timeZone), socio, source, person]);
                        const sum = out.get(key) ?? [0, 0, 0, 0];
                        out.set(
                            key,
                            sum.map((x, i) => x + v[i]!),
                        );
                    };
                    for (const t of seeded.turns) {
                        add(t.startedAt, t.socioId, t.source, t.personId ?? null, [
                            1,
                            t.status === 'failed' ? 1 : 0,
                            (t.inputTokens ?? 0) + (t.outputTokens ?? 0),
                            0,
                        ]);
                    }
                    for (const m of seeded.messages) {
                        if (m.authorKind === 'person') {
                            add(m.at, m.socioId, m.source, m.authorId, [0, 0, 0, 1]);
                        }
                    }
                    return [...out]
                        .map(([key, v]) => [...(JSON.parse(key) as unknown[]), ...v])
                        .map((r) => JSON.stringify(r))
                        .sort();
                };
                const flat = (list: Record<string, unknown>[]) =>
                    list.map((r) => JSON.stringify(Object.values(r))).sort();
                expect(flat(daily)).toEqual(expected('day'));
                expect(flat(hourly)).toEqual(expected('hour'));
            } finally {
                c.closeSync();
                instance.closeSync();
            }
        };
        await e.stop();
        await rollups('America/New_York');
        // An admin picks another reporting time zone: the rollups are recut.
        seeded.db
            .prepare('INSERT OR REPLACE INTO settings (id, value) VALUES (1, ?)')
            .run(JSON.stringify({ operations: { timeZone: 'Asia/Kolkata' } }));
        const next = engine(s, { hourlyDays: 3650 }, 'America/New_York');
        const since = Date.now();
        await next.e.start();
        await cycled(next.e, since);
        await sameAnswers(
            next.e,
            memory,
            windows.filter((w) => w.timeZone === 'Asia/Kolkata'),
            ['turns', 'people'],
            [{}],
        );
        await next.e.stop();
        await rollups('Asia/Kolkata');
    });

    it('keeps and restores hourly history beyond 30 days when hourlyDays is zero', async () => {
        const s = scratch();
        const now = Date.now();
        const seeded = seed(s, {
            turns: 80,
            start: now - 80 * DAY,
            spanMs: 79 * DAY,
        });
        const span = async () => {
            const instance = await openDuck(join(s.analytics, 'ops.duckdb'), {
                memoryMb: 128,
                threads: 1,
                tempDir: join(s.analytics, 'tmp'),
            });
            const connection = await instance.connect();
            try {
                return (
                    await rows<{ first: number; turns: number }>(
                        connection,
                        'SELECT min(hour_at) AS first, sum(turns) AS turns FROM r_hourly',
                    )
                )[0]!;
            } finally {
                connection.closeSync();
                instance.closeSync();
            }
        };
        // A store already holding every turn is ready, with the turn count
        // right, before the new engine's first cycle has applied its
        // hourlyDays; stopping then would skip it. So each run waits for a
        // whole cycle after it started.
        const run = async (hourlyDays: number) => {
            const { e } = engine(s, { hourlyDays });
            const since = Date.now();
            await e.start();
            await caughtUp(e, seeded.db);
            await cycled(e, since);
            await e.stop();
        };
        await run(0);
        const original = await span();
        expect(original.first).toBeLessThan(now - 70 * DAY);
        expect(original.turns).toBe(seeded.turns.length);
        await run(7);
        expect((await span()).first).toBeGreaterThanOrEqual(now - 7 * DAY - HOUR);
        await run(0);
        expect(await span()).toEqual(original);
        await run(0);
        expect(await span()).toEqual(original);
        expect(seeded.db.prepare('SELECT COUNT(*) n FROM agent_runs').get()?.n).toBe(seeded.turns.length);
    });

    it('keeps hourly rollups for their configured window and facts as long as asked, answering from the facts beyond', async () => {
        const s = scratch();
        const seeded = seed(s, {
            turns: 400,
            start: Date.now() - 60 * DAY,
            spanMs: 59 * DAY,
        });
        const { e } = engine(s, { factDays: 50, hourlyDays: 7 });
        await e.start();
        await until(() => e.status().state === 'ready');
        const now = Date.now();
        const kept = seeded.turns.filter((t) => t.startedAt >= now - 50 * DAY);
        await until(async () => {
            const overview = await ask<{ id: string; value: number }[]>(
                e,
                'overview',
                scopeOf({ from: null, to: now + DAY, bucket: 'day' }),
            ).catch(() => []);
            const turns = overview.find((tile) => tile.id === 'turns')?.value;
            return turns !== undefined && Math.abs(turns - kept.length) <= 1;
        });
        await e.stop();
        const instance = await openDuck(join(s.analytics, 'ops.duckdb'), {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.analytics, 'tmp'),
        });
        const c = await instance.connect();
        const [span] = await rows<{ turn: number; hour: number; day: number }>(
            c,
            'SELECT (SELECT min(started_at) FROM f_turn) AS turn, (SELECT min(hour_at) FROM r_hourly) AS hour, (SELECT min(day_at) FROM r_daily) AS day',
        );
        c.closeSync();
        instance.closeSync();
        expect(span!.turn).toBeGreaterThanOrEqual(now - 50 * DAY - 60_000);
        expect(span!.hour).toBeGreaterThanOrEqual(now - 7 * DAY - 2 * HOUR);
        expect(span!.day).toBeGreaterThanOrEqual(now - 51 * DAY);
        // An hourly view older than the hourly rollups still adds up.
        const again = engine(s, { factDays: 50, hourlyDays: 7 });
        await again.e.start();
        await until(() => again.e.status().state === 'ready');
        const memory = new MemoryOpsReader({
            turns: kept,
            messages: seeded.messages.filter((m) => m.at >= now - 50 * DAY),
        });
        await sameAnswers(
            again.e,
            memory,
            [
                { from: now - 20 * DAY, to: now - 12 * DAY, bucket: 'hour' },
                { from: now - 10 * DAY, to: now, bucket: 'hour' },
            ],
            ['turns', 'people'],
            [{}, { person: 'carol' }],
        );
    });
});
