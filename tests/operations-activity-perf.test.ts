import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it } from 'vitest';

import type { OpsBucket } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';

import { seedOpsActivity } from './fixtures/seed-ops-activity.js';
import { seedOpsDatabase } from './fixtures/seed-ops-runs.js';

// Activity and Value at a realistic size (CB-190): 20,000 turns over 90
// days with their approvals, reactions, pages and memories. Sessions are
// derived when asked, so these queries do the most work of the dashboard's,
// in the analytics process, away from chats. Alone they answer in about
// 350 ms at the 95th percentile; the bound leaves room for a busy machine
// running the whole suite at once.

const DAY = 86_400_000;
const TURNS = Number(process.env.OPS_PERF_TURNS) || 20_000;
const dir = mkdtempSync(join(tmpdir(), 'ops-activity-perf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!;

it(`answers Activity and Value over ${TURNS} turns in under 2.5 s (p95)`, async () => {
    const sqlitePath = join(dir, 'company-brain.sqlite');
    const seeded = seedOpsDatabase(sqlitePath, {
        turns: TURNS,
        start: Date.now() - 90 * DAY,
        spanMs: 90 * DAY - 60_000,
        answerChars: 100,
    });
    seedOpsActivity(seeded);
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
        await e.start();
        while (e.status().state !== 'ready') {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const now = Date.now();
        const times: Record<string, number[]> = {};
        const time = async (name: string, query: string, params: object) => {
            const at = performance.now();
            const answer = await e.handle({ op: 'query', query, params });
            (times[name] ??= []).push(performance.now() - at);
            expect(answer.ok, name).toBe(true);
        };
        const scope = (days: number, bucket: OpsBucket, i: number, filters = {}) => {
            // A different `to` each time: no cached answers.
            const to = now - i * 1_000;
            const from = to - days * DAY;
            return {
                window: {
                    from,
                    to,
                    bucket,
                    buckets: [bucket],
                    previous: { from: from - (to - from), to: from },
                    timeZone: 'UTC',
                },
                filters,
                sessionGapMinutes: 30,
            };
        };
        for (let i = 0; i < 12; i++) {
            const filters = i % 3 === 1 ? { socio: 'socio-a' } : i % 3 === 2 ? { person: 'alice' } : {};
            await time('activity 7d', 'activity', {
                ...scope(7, 'hour', i, filters),
                capabilities: [],
            });
            await time('activity 30d', 'activity', {
                ...scope(30, 'day', i, filters),
                capabilities: [],
            });
            await time('value 30d', 'value', scope(30, 'day', i, filters));
            await time('value 90d', 'value', scope(90, 'week', i, filters));
            for (const list of ['activityPeople', 'activitySocios', 'activityChats', 'activitySessions']) {
                await time(`${list} 30d`, list, {
                    ...scope(30, 'day', i, filters),
                    limit: 50,
                });
            }
        }
        const all = Object.values(times).flat();
        if (process.env.OPS_PERF_REPORT) {
            process.stderr.write(
                `ops activity perf: turns=${TURNS} p95=${p95(all).toFixed(0)}ms ${JSON.stringify(
                    Object.fromEntries(Object.entries(times).map(([name, list]) => [name, Math.round(p95(list))])),
                )}\n`,
            );
        }
        expect(p95(all)).toBeLessThan(2500);
    } finally {
        await e.stop();
    }
}, 600_000);
