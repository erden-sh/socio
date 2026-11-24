import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OpsBucket, OpsFilters } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import type { OpsKnowledge, OpsStorage } from '@socio/shared/operations/operations-knowledge';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { storageStep } from '../src/server/operations/etl/knowledge-steps.js';
import type { EtlStep } from '../src/server/operations/infra/duckdb/etl.js';
import '../src/server/operations/etl/sources.js';
import { openDuck, rows } from '../src/server/operations/infra/duckdb/open.js';
import { MemoryOpsReader } from '../src/server/operations/infra/memory/reader.js';
import { sqliteKnowledgeSource } from '../src/server/operations/infra/sqlite/knowledge-source.js';

import { seedKnowledge } from './fixtures/seed-ops-knowledge.js';
import { seedOpsDatabase, TEAM } from './fixtures/seed-ops-runs.js';

// Operations → Knowledge and Capabilities (CB-191): Space pages, search,
// dataset access, storage and tool calls copied into the analytics store
// and answered as the in-memory reader answers from what was written.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function seeded(now: number) {
    const dir = mkdtempSync(join(tmpdir(), 'ops-knowledge-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const sqlitePath = join(dir, 'company-brain.sqlite');
    const runs = seedOpsDatabase(sqlitePath, {
        turns: 300,
        start: now - 40 * DAY,
        spanMs: 39 * DAY,
    });
    cleanup.push(() => runs.db.close());
    const knowledge = seedKnowledge(runs.db, { now });
    return { dir, sqlitePath, runs, knowledge };
}

function engine(s: ReturnType<typeof seeded>, steps: readonly EtlStep[] = ETL_STEPS) {
    const e = new AnalyticsEngine({
        dir: join(s.dir, 'analytics'),
        sqlitePath: s.sqlitePath,
        defaults: analyticsDefaults({}),
        defaultTimeZone: 'UTC',
        steps,
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
    {
        from,
        to,
        bucket = 'day',
        timeZone = 'UTC',
    }: { from: number | null; to: number; bucket?: OpsBucket; timeZone?: string },
    filters: OpsFilters = {},
): OpsScope {
    return {
        window: {
            from,
            to,
            bucket,
            buckets: [bucket],
            previous: null,
            timeZone,
        },
        filters,
    };
}

function memoryOf(s: ReturnType<typeof seeded>, database: OpsStorage['database']) {
    return new MemoryOpsReader({
        turns: s.runs.turns,
        messages: s.runs.messages,
        knowledge: {
            ...s.knowledge.facts,
            spaces: s.knowledge.spaces(),
            tools: s.runs.tools,
            database,
        },
    });
}

/** Waits until the store holds every live page and turn. */
async function caughtUp(e: AnalyticsEngine, s: ReturnType<typeof seeded>) {
    const pages = s.knowledge.facts.pages.length;
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const answer = await ask<OpsKnowledge>(e, 'knowledge', scopeOf({ from: null, to: Date.now() + DAY })).catch(
            () => undefined,
        );
        return answer?.totals.pages === pages;
    });
}

/** Every page of a list, both readers, equal. */
async function sameList(
    e: AnalyticsEngine,
    memory: MemoryOpsReader,
    query: 'pages' | 'datasets' | 'requests',
    scope: OpsScope | null,
    limit = 50,
) {
    let cursor: { key: number | string; id: string } | undefined;
    let rows = 0;
    for (;;) {
        const page = { limit, ...(cursor ? { cursor } : {}) };
        const mine = await ask<{ items: unknown[]; next: typeof cursor | null }>(
            e,
            query,
            scope ? { ...scope, ...page } : page,
        );
        const theirs = query === 'requests' ? await memory.requests(page) : await memory[query](scope!, page);
        expect(mine, `${query} ${JSON.stringify(scope?.filters)}`).toEqual(theirs);
        rows += mine.items.length;
        if (!mine.next) {
            return rows;
        }
        cursor = mine.next;
    }
}

/** This issue's sources and tables. */
const MINE = ['data_audit', 'data_dataset_days', 'dot_requests', 'page_revisions', 'pages', 'storage'];
const TABLES = [
    'd_page',
    'd_page_use',
    'f_search_day',
    'f_search_latency',
    'f_page_edit',
    'f_data_access',
    'f_dataset_day',
    'd_dataset',
    's_lifetime',
    's_owner_files',
    'f_request',
];

/** This issue's tables in a store file, rows sorted, and its watermarks. */
async function dump(file: string) {
    const instance = await openDuck(file, {
        memoryMb: 128,
        threads: 1,
        tempDir: join(file, '..', 'tmp'),
    });
    const connection = await instance.connect();
    try {
        const out: Record<string, string[]> = {};
        for (const table of TABLES) {
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
        )
            .filter((row) => MINE.includes(row.source))
            .map((row) => JSON.stringify(row));
        return out;
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
}

const FILTERS: OpsFilters[] = [
    {},
    { space: 'space-1' },
    { space: 'space-gone' },
    { socio: 'socio-a' },
    { person: 'alice' },
    { person: TEAM },
    { source: 'telegram' },
    { space: 'nothing-here' },
];

describe('the Knowledge ETL', { timeout: 180_000 }, () => {
    it('copies pages, edits, searches, datasets, storage and requests, and answers as the memory reader does', async () => {
        const now = Date.now();
        const s = seeded(now);
        const e = engine(s);
        await e.start();
        await caughtUp(e, s);
        const storage = await ask<OpsStorage>(e, 'storage', scopeOf({ from: now - 30 * DAY, to: now }));
        // The database file as measured, chat history (`agent_runs`) in it.
        expect(storage.database).toMatchObject({
            bytes: expect.any(Number),
            agentRunsBytes: expect.any(Number),
        });
        expect(storage.database!.agentRunsBytes!).toBeGreaterThan(0);
        expect(storage.database!.agentRunsBytes!).toBeLessThan(storage.database!.bytes);
        const memory = memoryOf(s, storage.database);
        const windows = [
            { from: now - 7 * DAY, to: now, bucket: 'hour' as const },
            { from: now - 30 * DAY, to: now },
            { from: now - 90 * DAY, to: now - 20 * DAY, bucket: 'week' as const },
            { from: null, to: now, bucket: 'month' as const },
            { from: now - 30 * DAY, to: now, timeZone: 'America/New_York' },
        ];
        for (const window of windows) {
            for (const filters of FILTERS) {
                const scope = scopeOf(window, filters);
                const label = JSON.stringify({ window, filters });
                expect(await ask(e, 'knowledge', scope), label).toEqual(await memory.knowledge(scope));
                expect(await ask(e, 'storage', scope), label).toEqual(await memory.storage(scope));
                expect(await ask(e, 'toolUse', scope), label).toEqual(await memory.toolUse(scope));
            }
        }
        for (const filters of [{}, { space: 'space-1' }, { person: 'bob' }]) {
            expect(await sameList(e, memory, 'pages', scopeOf({ from: now - 30 * DAY, to: now }, filters))).toBe(
                s.knowledge.facts.pages.filter((page) => !filters.space || page.spaceId === filters.space).length,
            );
        }
        for (const filters of [{}, { person: 'carol' }, { socio: 'socio-b' }]) {
            expect(
                await sameList(e, memory, 'datasets', scopeOf({ from: now - 60 * DAY, to: now }, filters), 7),
            ).toBeGreaterThan(0);
        }
        expect(await sameList(e, memory, 'requests', null, 9)).toBe(69);

        // The numbers mean what they say, not only agree.
        const all = (await ask<OpsKnowledge>(e, 'knowledge', scopeOf({ from: null, to: now })))!;
        expect(all.totals.pages).toBe(s.knowledge.facts.pages.length);
        expect(all.totals.edits).toBe(1300);
        expect(all.access.total).toBe(1100);
        expect(all.spaces.map((space) => space.spaceId)).toContain('space-3');
        expect(all.spaces.find((space) => space.spaceId === 'space-3')).toMatchObject({ pages: 0, name: 'Empty' });
        expect(all.search.queries).toBe(s.knowledge.facts.searchDays.reduce((sum, day) => sum + day.queries, 0));
        expect(all.search.p50).toBeGreaterThan(0);
        expect(all.search.p95!).toBeGreaterThanOrEqual(all.search.p50!);
        const now30 = await ask<OpsStorage>(e, 'storage', scopeOf({ from: now - 30 * DAY, to: now }));
        // Today's totals are the last point of the chart.
        for (const kind of now30.kinds) {
            expect(now30.series.find((line) => line.kind === kind.kind)!.points.at(-1)!.value, kind.kind).toBe(
                kind.bytes,
            );
        }
    });

    it('reads no page text, revision body, audit target or request wording', async () => {
        const now = Date.now();
        const s = seeded(now);
        const e = engine(s);
        await e.start();
        await caughtUp(e, s);
        const answers = JSON.stringify([
            await ask(e, 'knowledge', scopeOf({ from: null, to: now })),
            await ask(e, 'pages', {
                ...scopeOf({ from: null, to: now }),
                limit: 200,
            }),
            await ask(e, 'datasets', {
                ...scopeOf({ from: null, to: now }),
                limit: 200,
            }),
            await ask(e, 'requests', { limit: 200 }),
        ]);
        expect(answers).not.toMatch(/secret|xxxx/);
        // Live pages are listed from the covering index, not the table.
        const plan = (
            s.runs.db
                .prepare(
                    'EXPLAIN QUERY PLAN SELECT rowid AS rowKey, spaceId, updatedAt, title FROM pages INDEXED BY pages_live_keys WHERE (deletedAt IS NULL) = 1',
                )
                .all() as { detail: string }[]
        ).map((row) => row.detail);
        expect(plan.join(' ')).toMatch(/COVERING INDEX pages_live_keys/);
        // Accesses and size days in time order through their indexes.
        for (const sql of [
            'SELECT id FROM data_audit INDEXED BY data_audit_time WHERE (createdAt, id) > (?, ?) AND createdAt < ? ORDER BY createdAt, id LIMIT 5',
            'SELECT rowid FROM data_dataset_days INDEXED BY data_dataset_days_measured WHERE (measuredAt, rowid) > (?, ?) AND measuredAt < ? ORDER BY measuredAt, rowid LIMIT 5',
        ]) {
            expect(
                (
                    s.runs.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 0, now) as {
                        detail: string;
                    }[]
                )
                    .map((row) => row.detail)
                    .join(' '),
            ).not.toMatch(/TEMP B-TREE/);
        }
    });

    it('follows edits, moves, deletes and new access, and waits for late commits', async () => {
        const now = Date.now();
        const s = seeded(now);
        // Storage at every cycle here, instead of every 5 minutes.
        const e = engine(s, [...ETL_STEPS.filter((step) => step.source !== 'storage'), storageStep(0, 0)]);
        await e.start();
        await caughtUp(e, s);
        const db = s.runs.db;
        const [first, second, third] = s.knowledge.facts.pages;
        db.prepare("UPDATE pages SET content = 'short', updatedAt = ?, title = 'Edited' WHERE id = ?").run(
            now - 1000,
            first!.pageId,
        );
        db.prepare("UPDATE pages SET spaceId = 'space-2' WHERE id = ?").run(second!.pageId);
        db.prepare('UPDATE pages SET deletedAt = ? WHERE id = ?').run(now, third!.pageId);
        db.prepare(
            "INSERT INTO data_audit (id, ownerUserId, actorKind, actorId, dotId, datasetId, target, action, outcome, detail, createdAt) VALUES ('late', 'alice', 'user', 'alice', NULL, 'ds-001', NULL, 'query', 'ok', NULL, ?), ('fresh', 'alice', 'user', 'alice', NULL, 'ds-001', NULL, 'query', 'ok', NULL, ?)",
        ).run(now - 2 * 60_000, Date.now());
        db.prepare(
            "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdAt, updatedAt) VALUES ('new-file', 'alice', 'new.txt', 100, 132, 'text/plain', ?, ?)",
        ).run(now - HOUR, now - HOUR);
        const since = Date.now();
        e.nudge();
        await until(async () => {
            const fresh = await ask<{ sources: { at: number }[] }>(e, 'freshness');
            return fresh.sources.every((source) => source.at >= since);
        });
        const scope = scopeOf({ from: null, to: now + DAY });
        const all: {
            pageId: string;
            title: string;
            chars: number;
            spaceId: string;
        }[] = [];
        let cursor: unknown;
        for (;;) {
            const page = await ask<{
                items: typeof all;
                next: unknown;
            }>(e, 'pages', { ...scope, limit: 200, ...(cursor ? { cursor } : {}) });
            all.push(...page.items);
            if (!page.next) {
                break;
            }
            cursor = page.next;
        }
        expect(all).toHaveLength(s.knowledge.facts.pages.length - 1);
        expect(all.find((page) => page.pageId === first!.pageId)).toMatchObject({
            title: 'Edited',
            chars: 5,
        });
        expect(all.find((page) => page.pageId === second!.pageId)?.spaceId).toBe('space-2');
        expect(all.some((page) => page.pageId === third!.pageId)).toBe(false);
        const knowledge = await ask<OpsKnowledge>(e, 'knowledge', scope);
        // The one 2 minutes old is in; the one just written waits a minute.
        expect(knowledge.access.total).toBe(1101);
        const storage = await ask<OpsStorage>(e, 'storage', scope);
        const files = s.knowledge.facts.lifetimes.filter((row) => row.kind === 'files' && row.deletedAt === null);
        expect(storage.kinds.find((kind) => kind.kind === 'files')).toMatchObject({
            items: files.reduce((sum, row) => sum + row.items, 0) + 1,
        });
    });

    it('is idempotent: reading again, or rebuilding, gives the same store', async () => {
        const now = Date.now();
        const s = seeded(now);
        const file = join(s.dir, 'analytics', 'ops.duckdb');
        const run = async () => {
            const e = engine(s);
            await e.start();
            await caughtUp(e, s);
            await until(async () => {
                const fresh = await ask<{
                    sources: { source: string; watermark: string | null }[];
                }>(e, 'freshness');
                return fresh.sources
                    .filter((source) => MINE.includes(source.source))
                    .every((source) => source.watermark !== null);
            });
            await e.stop();
            return dump(file);
        };
        const first = await run();
        expect(first.d_page).toHaveLength(s.knowledge.facts.pages.length);
        expect(first.f_page_edit).toHaveLength(1300);
        expect(first.f_data_access).toHaveLength(1100);
        // Every source read again over the same file: nothing changes.
        const instance = await openDuck(file, {
            memoryMb: 128,
            threads: 1,
            tempDir: join(s.dir, 'analytics', 'tmp'),
        });
        const connection = await instance.connect();
        await connection.run(
            `UPDATE etl_state SET watermark = NULL WHERE source IN (${MINE.map((m) => `'${m}'`).join(', ')})`,
        );
        await connection.run('DELETE FROM s_database');
        connection.closeSync();
        instance.closeSync();
        expect(await run()).toEqual(first);
        // From scratch: the same.
        rmSync(join(s.dir, 'analytics'), { recursive: true, force: true });
        expect(await run()).toEqual(first);
    });

    it('names a company socio’s shared area for its socio, never as a person (CB-224)', async () => {
        const now = Date.now();
        const s = seeded(now);
        const socio = s.runs.db.prepare('SELECT id, name FROM dots ORDER BY id LIMIT 1').get() as {
            id: string;
            name: string;
        };
        s.runs.db
            .prepare(
                'INSERT INTO data_datasets (id, ownerUserId, name, scratchForDotId, sizeBytes, historyBytes, tableCount, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                'shared-area',
                `socio:${socio.id}`,
                `${socio.name} shared`,
                socio.id,
                10,
                0,
                1,
                now - DAY,
                now - DAY,
                null,
            );
        s.runs.db
            .prepare(
                "INSERT INTO data_files (id, ownerUserId, path, size, storedSize, mediaType, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)",
            )
            .run('shared-file', `socio:${socio.id}`, `dots/${socio.id}/scan.txt`, 5, 37, now - DAY, now - DAY, null);
        const e = engine(s);
        await e.start();
        await caughtUp(e, s);
        await until(async () => {
            const fresh = await ask<{
                sources: { source: string; watermark: string | null }[];
            }>(e, 'freshness');
            return fresh.sources.some((source) => source.source === 'storage' && source.watermark !== null);
        });
        await e.stop();
        const out = await dump(join(s.dir, 'analytics', 'ops.duckdb'));
        const label = `${socio.name} (shared computer)`;
        const dataset = out.d_dataset
            .map((row) => JSON.parse(row) as { id: string; owner_id: string })
            .find((row) => row.id === 'shared-area');
        expect(dataset?.owner_id).toBe(label);
        const owners = out.s_owner_files.map((row) => (JSON.parse(row) as { owner_id: string }).owner_id);
        expect(owners).toContain(label);
        expect(owners.some((id) => id.startsWith('socio:'))).toBe(false);
    });

    it('reads through a port that lists sizes by the hour and people’s files', () => {
        const now = Date.now();
        const s = seeded(now);
        const reader = sqliteKnowledgeSource(s.runs.db);
        const lifetimes = reader.lifetimes();
        expect(lifetimes.every((row) => row.createdAt % HOUR === 0)).toBe(true);
        expect(
            [...lifetimes].sort((a, b) =>
                `${a.kind}${a.createdAt}${a.deletedAt}`.localeCompare(`${b.kind}${b.createdAt}${b.deletedAt}`),
            ),
        ).toEqual(
            [...s.knowledge.facts.lifetimes].sort((a, b) =>
                `${a.kind}${a.createdAt}${a.deletedAt}`.localeCompare(`${b.kind}${b.createdAt}${b.deletedAt}`),
            ),
        );
        expect(reader.ownerFiles().map((row) => ({ ...row, ownerId: row.ownerUserId }))).toEqual(
            [...s.knowledge.facts.owners]
                .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
                .map((row) => ({ ...row, ownerUserId: row.ownerId })),
        );
    });
});
