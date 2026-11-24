import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';

import type { OpsBucket } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';

import { seedOpsDatabase } from './fixtures/seed-ops-runs.js';

// The Operations ETL at size (CB-187): turns over 90 days, read from
// SQLite into DuckDB by a rebuild, then the Overview's queries, whose 95th
// percentile must stay under 200 ms. The suite runs 5,000 turns; the
// realistic 50,000 with OPS_PERF=1 (or OPS_PERF_TURNS=n), and
// OPS_PERF_REPORT=1 prints the numbers.

const DAY = 86_400_000;
const TURNS = Number(process.env.OPS_PERF_TURNS) || (process.env.OPS_PERF === '1' ? 50_000 : 5_000);
const dir = mkdtempSync(join(tmpdir(), 'ops-etl-perf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!;

it(`copies ${TURNS} turns and answers the Overview in under 200 ms (p95)`, async () => {
    const sqlitePath = join(dir, 'company-brain.sqlite');
    let started = performance.now();
    const seeded = seedOpsDatabase(sqlitePath, {
        turns: TURNS,
        start: Date.now() - 90 * DAY,
        spanMs: 90 * DAY - 60_000,
        answerChars: 1500,
    });
    const seedMs = performance.now() - started;
    seeded.db.close();
    const e = new AnalyticsEngine({
        dir: join(dir, 'analytics'),
        sqlitePath,
        defaults: analyticsDefaults({}),
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        log: () => undefined,
    });
    try {
        started = performance.now();
        await e.start();
        while (e.status().state !== 'ready') {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const etlMs = performance.now() - started;

        const now = Date.now();
        const times: Record<string, number[]> = {};
        const time = async (name: string, query: string, params: object) => {
            const at = performance.now();
            const answer = await e.handle({ op: 'query', query, params });
            (times[name] ??= []).push(performance.now() - at);
            expect(answer.ok, name).toBe(true);
            return answer;
        };
        const scope = (days: number | null, bucket: OpsBucket, i: number, filters = {}) => {
            // A different `to` each time: no cached answers.
            const to = now - i * 1_000;
            const from = days === null ? null : to - days * DAY;
            return {
                window: {
                    from,
                    to,
                    bucket,
                    buckets: [bucket],
                    previous: from === null ? null : { from: from - (to - from), to: from },
                    timeZone: 'UTC',
                },
                filters,
            };
        };
        for (let i = 0; i < 40; i++) {
            const filters =
                i % 4 === 1
                    ? { socio: 'socio-a' }
                    : i % 4 === 2
                      ? { person: 'alice' }
                      : i % 4 === 3
                        ? { space: 'space-2' }
                        : {};
            await time('overview 7d', 'overview', scope(7, 'hour', i, filters));
            await time('overview 30d', 'overview', scope(30, 'day', i, filters));
            await time('overview all', 'overview', scope(null, 'week', i, filters));
            await time('series 7d hourly', 'series', {
                ...scope(7, 'hour', i, filters),
                metric: i % 2 ? 'people' : 'turns',
            });
            await time('series 30d hourly', 'series', {
                ...scope(30, 'hour', i, filters),
                metric: 'tokens',
            });
            await time('series 90d daily', 'series', {
                ...scope(90, 'day', i, filters),
                metric: i % 2 ? 'messages' : 'people',
            });
            await time('series all weekly', 'series', {
                ...scope(null, 'week', i, filters),
                metric: 'failed',
            });
            await time('turns 30d page', 'turns', {
                ...scope(30, 'day', i, filters),
                limit: 50,
            });
        }
        const all = Object.values(times).flat();
        const summary = Object.fromEntries(Object.entries(times).map(([name, list]) => [name, Math.round(p95(list))]));
        if (process.env.OPS_PERF_REPORT) {
            process.stderr.write(
                `ops etl perf: turns=${TURNS} seed=${Math.round(seedMs)}ms etl=${Math.round(etlMs)}ms (${Math.round(TURNS / (etlMs / 1000))} turns/s) query p95=${p95(all).toFixed(1)}ms ${JSON.stringify(summary)}\n`,
            );
        }
        expect(p95(all)).toBeLessThan(200);
    } finally {
        await e.stop();
    }
}, 600_000);
