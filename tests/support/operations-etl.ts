// Shared fixtures for the Operations ETL tests (CB-187), split across
// operations-etl*.test.ts so no one file sets the suite's wall time (CB-311).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect } from 'vitest';

import { type OpsBucket, type OpsFilters, type OpsMetric, type OpsWindow } from '@socio/shared/operations/operations';
import { analyticsDefaults, type AnalyticsSettings } from '@socio/shared/operations/operations-analytics';

import { AnalyticsEngine } from '../../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../../src/server/operations/domain/ops-queries.js';
import type { OpsScope } from '../../src/server/operations/domain/reader.js';
import { openDuck, rows } from '../../src/server/operations/infra/duckdb/open.js';
import '../../src/server/operations/etl/sources.js';
import { MemoryOpsReader } from '../../src/server/operations/infra/memory/reader.js';
import { seedOpsDatabase, TEAM, type Seeded } from '../fixtures/seed-ops-runs.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const cleanup: Array<() => unknown> = [];
/** Runs and forgets every registered cleanup, newest first (each file's afterEach). */
export async function runCleanup() {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
}

export function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-etl-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return {
        dir,
        sqlitePath: join(dir, 'company-brain.sqlite'),
        analytics: join(dir, 'analytics'),
    };
}

export function seed(s: ReturnType<typeof scratch>, options: Partial<Parameters<typeof seedOpsDatabase>[1]> = {}) {
    const seeded = seedOpsDatabase(s.sqlitePath, {
        turns: 600,
        start: Date.now() - 45 * DAY,
        spanMs: 44 * DAY,
        ...options,
    });
    cleanup.push(() => seeded.db.close());
    return seeded;
}

export function engine(s: ReturnType<typeof scratch>, settings: Partial<AnalyticsSettings> = {}, timeZone = 'UTC') {
    const lines: string[] = [];
    const e = new AnalyticsEngine({
        dir: s.analytics,
        sqlitePath: s.sqlitePath,
        defaults: { ...analyticsDefaults({}), ...settings },
        defaultTimeZone: timeZone,
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: (line) => lines.push(line),
    });
    cleanup.push(() => e.stop());
    return { e, lines };
}

export async function until<T>(check: () => T | Promise<T>, timeoutMs = 30_000): Promise<NonNullable<T>> {
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

export async function ask<T = unknown>(e: AnalyticsEngine, query: OpsQueryName, params: object = {}): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params });
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

/** Waits until the store has read every turn in the database. */
export async function caughtUp(e: AnalyticsEngine, db: DatabaseSync) {
    const { n } = db.prepare('SELECT count(*) AS n FROM agent_runs').get() as {
        n: number;
    };
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const overview = await ask<{ id: string; value: number }[]>(
            e,
            'overview',
            scopeOf({ from: null, to: Date.now() + DAY, bucket: 'day' }),
        ).catch(() => []);
        return overview.find((tile) => tile.id === 'turns')?.value === n;
    });
}

export function windowOf({
    from,
    to,
    bucket,
    timeZone = 'UTC',
    previous = true,
}: {
    from: number | null;
    to: number;
    bucket: OpsBucket;
    timeZone?: string;
    previous?: boolean;
}): OpsWindow {
    return {
        from,
        to,
        bucket,
        buckets: [bucket],
        previous: previous && from !== null ? { from: from - (to - from), to: from } : null,
        timeZone,
    };
}
export function scopeOf(window: Parameters<typeof windowOf>[0], filters: OpsFilters = {}): OpsScope {
    return { window: windowOf(window), filters };
}

/** Waits until an ETL cycle has run every step since `since`. */
export async function cycled(e: AnalyticsEngine, since: number) {
    await until(async () => {
        const fresh = await ask<{ sources: { at: number }[] }>(e, 'freshness').catch(() => ({ sources: [] }));
        return fresh.sources.length === ETL_STEPS.length && fresh.sources.every((source) => source.at >= since);
    });
}

/** Every table of a store file, rows sorted, minus what changes by the clock. */
export async function dump(file: string) {
    const instance = await openDuck(file, {
        memoryMb: 128,
        threads: 1,
        tempDir: join(file, '..', 'tmp'),
    });
    const connection = await instance.connect();
    try {
        const out: Record<string, string[]> = {};
        for (const table of [
            'f_turn',
            'f_message',
            'f_tool',
            'f_participant',
            'd_person',
            'd_socio',
            'd_space',
            'd_chat',
            'd_source',
            'r_hourly',
            'r_daily',
        ]) {
            out[table] = (await rows(connection, `SELECT * FROM ${table}`))
                .map((row) =>
                    JSON.stringify(row, (_, value: unknown) => (typeof value === 'bigint' ? Number(value) : value)),
                )
                .sort();
        }
        out.etl_state = (
            await rows<{ source: string; watermark: string | null }>(
                connection,
                'SELECT source, watermark FROM etl_state ORDER BY source',
            )
        ).map((row) => JSON.stringify(row));
        return out;
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

export const SCOPE_FILTERS: OpsFilters[] = [
    {},
    { socio: 'socio-a' },
    { space: 'space-2' },
    { source: 'telegram' },
    { source: 'scheduled' },
    { person: 'alice' },
    { person: TEAM },
    { socio: 'socio-b', person: 'carol' },
    { source: 'nothing-here' },
];

/** The DuckDB store's answers equal the memory reader's for these scopes. */
export async function sameAnswers(
    e: AnalyticsEngine,
    memory: MemoryOpsReader,
    windows: Parameters<typeof windowOf>[0][],
    metrics: OpsMetric[] = ['turns', 'failed', 'messages', 'people', 'tokens'],
    filters: OpsFilters[] = SCOPE_FILTERS,
) {
    for (const window of windows) {
        for (const filter of filters) {
            const scope = scopeOf(window, filter);
            const label = JSON.stringify({ ...window, filter });
            expect(await ask(e, 'overview', scope), label).toEqual(await memory.overview(scope));
            for (const metric of metrics) {
                expect(await ask(e, 'series', { ...scope, metric }), `${label} ${metric}`).toEqual(
                    await memory.series(scope, metric),
                );
            }
        }
    }
}

/** Every page of the turns list, both ways. */
export async function sameTurns(e: AnalyticsEngine, memory: MemoryOpsReader, scope: OpsScope) {
    let cursor: { key: number | string; id: string } | undefined;
    let pages = 0;
    for (;;) {
        const page = { limit: 50, ...(cursor ? { cursor } : {}) };
        const mine = await ask<{ items: unknown[]; next: typeof cursor | null }>(e, 'turns', { ...scope, ...page });
        expect(mine).toEqual(await memory.turns(scope, page));
        pages++;
        if (!mine.next) {
            return pages;
        }
        cursor = mine.next;
    }
}

export function memoryOf(seeded: Seeded) {
    return new MemoryOpsReader({
        turns: seeded.turns,
        messages: seeded.messages,
    });
}
