import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';
import type { FailureCategory } from '@socio/shared/failure-taxonomy';
import type { CursorPage, OpsWindow } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import type { OpsFailureRow, OpsReliabilitySummary } from '@socio/shared/operations/operations-reliability';

import { classifySchema } from '../src/server/classify/migrations.js';
import { ClassifyService } from '../src/server/classify/service.js';
import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import { openDuck } from '../src/server/operations/infra/duckdb/open.js';
import '../src/server/operations/etl/sources.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';

import { seedFailureDatabase } from './fixtures/seed-ops-failures.js';

// Failure labels in the analytics store (CB-198): the labels in force,
// an admin's or the model's once applied, replace the rules' Unclassified
// on the turns and tool calls they name, through the `labels` step; a
// suggestion, or a label on a failure the rules sort, changes nothing;
// and neither a taxonomy re-run nor a rebuild loses them.

const DAY = 86_400_000;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function engine(dir: string, sqlitePath: string) {
    const e = new AnalyticsEngine({
        dir: join(dir, 'analytics'),
        sqlitePath,
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

async function until<T>(check: () => T | Promise<T>, timeoutMs = 60_000) {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function ask<T>(e: AnalyticsEngine, query: OpsQueryName, params: object = {}): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params });
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

const window = (): OpsWindow => ({
    from: null,
    to: Date.now() + DAY,
    bucket: 'month',
    buckets: ['month'],
    previous: null,
    timeZone: 'UTC',
});

async function failures(e: AnalyticsEngine, category?: FailureCategory) {
    const items: OpsFailureRow[] = [];
    let cursor: unknown;
    for (;;) {
        const page = await ask<CursorPage<OpsFailureRow> & { next: unknown }>(e, 'failures', {
            window: window(),
            filters: {},
            limit: 200,
            ...(cursor ? { cursor } : {}),
            ...(category ? { category } : {}),
        });
        items.push(...page.items);
        if (!page.next) {
            return items;
        }
        cursor = page.next;
    }
}

const watermark = async (e: AnalyticsEngine, source: string) => {
    const fresh = await ask<{
        sources: { source: string; watermark: string | null }[];
    }>(e, 'freshness').catch(() => ({ sources: [] }));
    return fresh.sources.find((row) => row.source === source)?.watermark;
};

describe('failure labels in the store', { timeout: 180_000 }, () => {
    it('replace Unclassified where they are in force, and survive a taxonomy re-run and a rebuild', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ops-labels-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const sqlitePath = join(dir, 'company-brain.sqlite');
        const seeded = seedFailureDatabase(sqlitePath, {
            turns: 400,
            start: Date.now() - 20 * DAY,
            spanMs: 19 * DAY,
        });
        cleanup.push(() => seeded.db.close());
        migrate(seeded.db, [classifySchema]);
        const service = new ClassifyService({
            db: seeded.db,
            runs: sqliteSourceReader(seeded.db),
            settings: () => ({}),
            providers: [],
        });
        let e = engine(dir, sqlitePath);
        await e.start();
        await until(async () => (await watermark(e, 'issues')) !== undefined);
        await until(async () => {
            const summary = await ask<OpsReliabilitySummary>(e, 'reliability', {
                window: window(),
                filters: {},
            }).catch(() => ({ turns: null }));
            return summary.turns === 400;
        });
        const before = await failures(e);
        const unclassifiedTurns = before.filter((row) => row.category === 'unclassified' && row.level === 'turn');
        const unclassifiedTool = before.find((row) => row.category === 'unclassified' && row.level === 'tool')!;
        const sorted = before.find((row) => row.category === 'runtime_error' && row.level === 'turn')!;
        expect(unclassifiedTurns.length).toBeGreaterThanOrEqual(3);
        expect(unclassifiedTool).toBeDefined();
        const [a, b, c] = unclassifiedTurns;
        const subject = (row: OpsFailureRow) => service.failures.subject(row.runId, row.level)!;

        // A: an admin's label. B: the model's, applied. C: a suggestion only.
        // D: a label on a failure the rules sort (the API refuses it; the store
        // ignores it). T: an admin's label on a tool call.
        await service.failures.relabel(subject(a!), 'model_provider', 'alice');
        const model = {
            use: 'failures',
            labelsVersion: 1,
            idx: -1,
            source: 'model' as const,
            provider: 'workspace',
            version: 'workspace:m/p1',
            confidence: 0.95,
            input: '{}',
            actorId: null,
            at: Date.now(),
        };
        await service.store.addLabel({
            ...model,
            runId: b!.runId,
            label: 'external_service',
            applied: true,
        });
        await service.store.addLabel({
            ...model,
            runId: c!.runId,
            label: 'quotas',
            applied: false,
        });
        await service.store.addLabel({
            ...model,
            source: 'admin',
            provider: null,
            version: null,
            runId: sorted.runId,
            label: 'quotas',
            applied: true,
            actorId: 'alice',
        });
        const tool = subject(unclassifiedTool);
        await service.failures.relabel(tool, 'invalid_input', 'alice');

        const last = () =>
            (seeded.db.prepare('SELECT max(seq) AS seq FROM classify_labels WHERE applied=1').get() as { seq: number })
                .seq;
        const caughtUp = async (engineNow: AnalyticsEngine) => {
            await until(async () => {
                engineNow.nudge();
                return (await watermark(engineNow, 'labels')) === String(last());
            });
        };
        await caughtUp(e);

        const check = async (engineNow: AnalyticsEngine, aCategory: string) => {
            const after = new Map((await failures(engineNow)).map((row) => [row.runId, row]));
            expect(after.get(a!.runId)).toMatchObject({
                category: aCategory,
                rule: 'label:admin',
            });
            expect(after.get(b!.runId)).toMatchObject({
                category: 'external_service',
                rule: 'label:workspace',
            });
            expect(after.get(c!.runId)).toMatchObject({
                category: 'unclassified',
                rule: c!.rule,
            });
            expect(after.get(sorted.runId)).toMatchObject({
                category: 'runtime_error',
                rule: sorted.rule,
            });
            expect(after.get(unclassifiedTool.runId)).toMatchObject({
                level: 'tool',
                category: 'invalid_input',
                rule: 'label:admin',
            });
            const summary = await ask<OpsReliabilitySummary>(engineNow, 'reliability', {
                window: window(),
                filters: {},
            });
            const count = (summaryNow: OpsReliabilitySummary, id: string) =>
                summaryNow.categories.find((row) => row.category === id)!;
            return { summary, count };
        };
        const { summary, count } = await check(e, 'model_provider');
        // Failures stay failures: only their categories move.
        expect(summary.failures).toBe(before.filter((row) => row.level === 'turn').length);
        expect(count(summary, 'unclassified').turns).toBe(unclassifiedTurns.length - 2);

        // An admin's newer label wins.
        await service.failures.relabel(subject(a!), 'quotas', 'alice');
        await caughtUp(e);
        await check(e, 'quotas');

        // The rules re-run over the stored codes: the labels stand.
        await e.stop();
        const file = join(dir, 'analytics', 'ops.duckdb');
        const instance = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(dir, 'analytics', 'tmp'),
        });
        const connection = await instance.connect();
        await connection.run(`UPDATE etl_state SET watermark = '0' WHERE source = 'taxonomy'`);
        connection.closeSync();
        instance.closeSync();
        e = engine(dir, sqlitePath);
        await e.start();
        await until(async () => (await watermark(e, 'taxonomy')) === '1');
        await caughtUp(e);
        await check(e, 'quotas');

        // A rebuild from SQLite gives the same.
        await e.stop();
        rmSync(file, { force: true });
        rmSync(`${file}.wal`, { force: true });
        e = engine(dir, sqlitePath);
        await e.start();
        await until(() => e.status().state === 'ready');
        await caughtUp(e);
        await check(e, 'quotas');
    });
});
