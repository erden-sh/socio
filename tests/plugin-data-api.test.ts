import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { PluginDataBudget, QueryResult } from '@socio/shared/data-types';

import type {
    DataBatchStatementResult as SdkStatementResult,
    DataPluginBudget as SdkBudget,
    DataQueryResult as SdkQueryResult,
} from '../packages/app-sdk/src/index.js';
import type { DataBatchStatementResult } from '../src/server/dataspace/contract.js';
import { DatasetEngine } from '../src/server/dataspace/engine.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';

import { cleanup, world } from './helpers/plugin-world.js';

// The data API gaps a D1-style driver needs (an events plugin): a plugin token's
// own statement budget, raisable per plugin (CB-473); read batches from one
// snapshot, counted as one operation (CB-474); and write batches with
// `expectChanges`, each statement's changes and last row id, and RETURNING
// rows (CB-475).

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

// The SDK's wire types take what the server sends.
const sdkTypes = (server: { result: DataBatchStatementResult; budget: PluginDataBudget; query: QueryResult }) => {
    const result: SdkStatementResult = server.result;
    const budget: SdkBudget = server.budget;
    const query: SdkQueryResult = server.query;
    return [result, budget, query];
};
void sdkTypes;

type Api = (
    path: string,
    method?: string,
    body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

async function events(api: Api) {
    const made = await api('/data/datasets/marts/tables', 'POST', {
        table: 'daily',
        columns: [
            { name: 'day', type: 'TEXT', primaryKey: true },
            { name: 'total', type: 'INTEGER' },
        ],
    });
    expect(made.status).toBe(200);
}

const audit = (f: Awaited<ReturnType<typeof world>>, action: string) =>
    f.workspace.db
        .prepare('SELECT actorKind, actorId, target, outcome, detail FROM data_audit WHERE action=? ORDER BY createdAt')
        .all(action)
        .map((row) => ({ ...row }));

describe('a plugin’s statement budget (CB-473)', () => {
    it('is the plugin’s own, apart from socios’, and spent by read batches as one operation', async () => {
        const f = await world({ statementsPerMinute: 5, pluginStatementsPerMinute: 12 });
        const { api } = await f.datasync();
        await events(api); // 1 of 12
        // A read batch of 10 statements is one operation.
        for (let i = 0; i < 3; i++) {
            const read = await api('/data/datasets/marts/read-batch', 'POST', {
                statements: Array.from({ length: 10 }, () => ({ sql: 'SELECT count(*) FROM daily' })),
            });
            expect(read.status).toBe(200);
        } // 4 of 12
        // A write batch counts each statement: 8 more fit, a ninth doesn't.
        const insert = (n: number, from: number) => ({
            statements: Array.from({ length: n }, (_, i) => ({
                sql: 'INSERT INTO daily (day, total) VALUES (?, ?)',
                params: [`d${from + i}`, i],
            })),
        });
        expect((await api('/data/datasets/marts/batch', 'POST', insert(9, 0))).status).toBe(429);
        expect((await api('/data/datasets/marts/batch', 'POST', insert(8, 0))).status).toBe(200); // 12 of 12
        const over = await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT 1' });
        expect(over.status).toBe(429);
        expect(String(over.body.error)).toMatch(/this plugin may make 12 a minute.*plugin’s page/);

        // A socio's token keeps the workspace's own limit, untouched by the plugin's.
        const dot = f.workspace.dots()[0]!;
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await computer('/data/datasets/scratch')).status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
        expect(f.platform.data.limits).toMatchObject({ statementsPerMinute: 5, pluginStatementsPerMinute: 12 });
    });

    it('defaults to 600 a minute, which an admin changes for all plugins in Settings', async () => {
        const f = await world();
        expect(f.platform.data.limits.pluginStatementsPerMinute).toBe(600);
        const alice = await f.as('alice');
        await f.platform.plugins.install('datasync');
        expect((await alice('/data/plugins/datasync/budget')).body).toEqual({
            pluginId: 'datasync',
            statementsPerMinute: 600,
            override: null,
            workspaceDefault: 600,
            max: 100_000,
        });
        expect((await alice('/settings', 'PATCH', { limits: { dataPluginStatementsPerMinute: 900 } })).status).toBe(
            200,
        );
        expect(f.platform.data.limits.pluginStatementsPerMinute).toBe(900);
        expect((await alice('/data/plugins/datasync/budget')).body).toMatchObject({
            statementsPerMinute: 900,
            workspaceDefault: 900,
        });
        // The socios' limit isn't the plugins'.
        expect(f.platform.data.limits.statementsPerMinute).toBe(120);
        expect(
            (await alice('/settings', 'PATCH', { limits: { dataPluginStatementsPerMinute: 0 } })).status,
        ).toBeGreaterThanOrEqual(400);
    });

    it('lets an admin raise one plugin’s budget on its page, at once, and clear it back to the default', async () => {
        const f = await world({ pluginStatementsPerMinute: 3 });
        const { api } = await f.datasync();
        await events(api);
        await api('/data/datasets/marts');
        await api('/data/datasets/marts');
        expect((await api('/data/datasets/marts')).status).toBe(429);

        const alice = await f.as('alice');
        const bob = await f.as('bob');
        // Admins only; installed plugins only; whole numbers 1 to the Settings ceiling.
        expect((await bob('/data/plugins/datasync/budget')).status).toBe(403);
        expect((await bob('/data/plugins/datasync/budget', 'PUT', { statementsPerMinute: 50 })).status).toBe(403);
        expect((await alice('/data/plugins/nope/budget', 'PUT', { statementsPerMinute: 50 })).status).toBe(404);
        for (const statementsPerMinute of [0, -1, 1.5, 100_001, '50']) {
            expect((await alice('/data/plugins/datasync/budget', 'PUT', { statementsPerMinute })).status).toBe(400);
        }
        // A token's request can't change it.
        expect((await api('/data/plugins/datasync/budget', 'PUT', { statementsPerMinute: 50 })).status).toBe(403);

        const raised = await alice('/data/plugins/datasync/budget', 'PUT', { statementsPerMinute: 6 });
        expect(raised.status).toBe(200);
        expect(raised.body).toMatchObject({
            pluginId: 'datasync',
            statementsPerMinute: 6,
            override: 6,
            workspaceDefault: 3,
            setBy: 'alice',
        });
        // Applies at once: 3 used, 3 more of 6.
        expect((await api('/data/datasets/marts')).status).toBe(200);
        expect((await api('/data/datasets/marts')).status).toBe(200);
        expect((await api('/data/datasets/marts')).status).toBe(200);
        expect((await api('/data/datasets/marts')).status).toBe(429);
        // Another plugin keeps the default.
        await f.platform.plugins.install('reports');
        expect((await alice('/data/plugins/reports/budget')).body).toMatchObject({
            statementsPerMinute: 3,
            override: null,
        });

        const cleared = await alice('/data/plugins/datasync/budget', 'PUT', { statementsPerMinute: null });
        expect(cleared.body).toMatchObject({ statementsPerMinute: 3, override: null });
        expect(cleared.body.setBy).toBeUndefined();
        expect(audit(f, 'plugin_budget')).toEqual([
            {
                actorKind: 'user',
                actorId: 'alice',
                target: 'datasync',
                outcome: 'ok',
                detail: 'default 3 → 6 a minute',
            },
            {
                actorKind: 'user',
                actorId: 'alice',
                target: 'datasync',
                outcome: 'ok',
                detail: '6 → default 3 a minute',
            },
        ]);
    });
});

describe('read batches (CB-474)', () => {
    it('answers each SELECT in order, with the single query’s checks and caps', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await events(api);
        await api('/data/datasets/marts/tables/daily/rows', 'POST', {
            rows: Array.from({ length: 5 }, (_, i) => ({ day: `2026-11-0${i + 1}`, total: (i + 1) * 100 })),
        });
        const read = await api('/data/datasets/marts/read-batch', 'POST', {
            statements: [
                { sql: 'SELECT count(*) AS n FROM daily' },
                { sql: 'SELECT day, total FROM daily WHERE total >= ? ORDER BY day', params: [400] },
                { sql: 'SELECT day FROM daily ORDER BY day' },
            ],
            maxRows: 3,
        });
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({
            dataset: 'marts',
            statements: 3,
            results: [
                { columns: ['n'], rows: [[5]], truncated: false },
                {
                    columns: ['day', 'total'],
                    rows: [
                        ['2026-11-04', 400],
                        ['2026-11-05', 500],
                    ],
                    truncated: false,
                },
                // The row cap holds per statement.
                { columns: ['day'], rows: [['2026-11-01'], ['2026-11-02'], ['2026-11-03']], truncated: true },
            ],
        });
        expect(audit(f, 'read_batch')).toEqual([
            expect.objectContaining({
                actorKind: 'plugin',
                outcome: 'ok',
                detail: '3 statement(s), 6 row(s), truncated',
            }),
        ]);

        // Only SELECTs, each refused by its number; nothing but the dataset's tables.
        const write = await api('/data/datasets/marts/read-batch', 'POST', {
            statements: [{ sql: 'SELECT 1' }, { sql: "INSERT INTO daily VALUES ('x', 1)" }],
        });
        expect(write.status).toBe(400);
        expect(String(write.body.error)).toMatch(/^Statement 2: Only read-only SELECT/);
        const hidden = await api('/data/datasets/marts/read-batch', 'POST', {
            statements: [{ sql: 'SELECT 1' }, { sql: 'SELECT * FROM _writes' }],
        });
        expect(hidden.status).toBe(403);
        expect(String(hidden.body.error)).toMatch(/^Statement 2: Not allowed/);
        const pragma = await api('/data/datasets/marts/read-batch', 'POST', {
            statements: [{ sql: "SELECT * FROM pragma_table_info('daily')" }, { sql: 'SELECT load_extension(1)' }],
        });
        expect(pragma.status).toBe(403);
        // At most `batchMaxStatements`, and at least one.
        const many = Array.from({ length: 33 }, () => ({ sql: 'SELECT 1' }));
        expect((await api('/data/datasets/marts/read-batch', 'POST', { statements: many })).status).toBe(413);
        expect((await api('/data/datasets/marts/read-batch', 'POST', { statements: [] })).status).toBe(400);
        expect(
            (await api('/data/datasets/marts/read-batch', 'POST', { statements: [{ sql: 'SELECT 1', extra: 1 }] }))
                .status,
        ).toBe(400);
        // A signed-in admin reads one too, as with a query.
        const alice = await f.as('alice');
        const id = f.datasetRows('plugin:datasync').find((row) => row.name === 'marts')!.id;
        expect(
            (
                await alice(`/data/datasets/${id}/read-batch`, 'POST', {
                    statements: [{ sql: 'SELECT count(*) FROM daily' }],
                })
            ).body,
        ).toMatchObject({ results: [{ rows: [[5]] }] });
    });
});

describe('the runner’s read batch (CB-474)', () => {
    function file() {
        const dir = mkdtempSync(join(tmpdir(), 'socio-read-batch-'));
        const runner = new QueryRunner();
        cleanup.push(() => {
            runner.close();
            rmSync(dir, { recursive: true, force: true });
        });
        const engine = new DatasetEngine(runner);
        const path = join(dir, 'd.sqlite');
        engine.create(path);
        engine.createTable(path, { table: 't', columns: [{ name: 'x', type: 'INTEGER' }] }, 1 << 24);
        engine.insert(
            path,
            't',
            Array.from({ length: 10 }, (_, x) => ({ x })),
            1 << 24,
        );
        return { engine, path };
    }
    const heavy = (n: number) =>
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT (SELECT count(*) FROM t), count(*) FROM c`;
    const caps = { maxRows: 100, maxBytes: 65_536, maxTotalBytes: 1 << 20, timeoutMs: 20_000, totalTimeoutMs: 60_000 };

    it('reads every statement from one snapshot while a write waits to commit', async () => {
        const { engine, path } = file();
        const pending = engine.readBatch(
            path,
            [
                { sql: 'SELECT count(*) FROM t' },
                { sql: heavy(400_000) },
                { sql: heavy(400_000) },
                { sql: heavy(400_000) },
            ],
            caps,
        );
        // A write from outside, part way through the batch: it waits for the batch.
        // Write only once the batch holds its snapshot (an exclusive lock can't be
        // had), not after a fixed delay a slow runner may not honor.
        const probe = new DatabaseSync(path);
        probe.exec('PRAGMA busy_timeout=0');
        for (const deadline = Date.now() + 10_000; ;) {
            try {
                probe.exec('BEGIN EXCLUSIVE');
                probe.exec('ROLLBACK');
            } catch {
                break;
            }
            expect(Date.now(), 'the batch never took its snapshot').toBeLessThan(deadline);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        probe.close();
        const writer = new DatabaseSync(path);
        writer.exec('PRAGMA busy_timeout=30000');
        writer.prepare('INSERT INTO t (x) VALUES (99)').run();
        writer.close();
        const results = await pending;
        expect(results.map((result) => result.rows[0]![0])).toEqual([10, 10, 10, 10]);
        // The write did commit once the batch was done.
        const after = await engine.readBatch(path, [{ sql: 'SELECT count(*) FROM t' }], caps);
        expect(after[0]!.rows).toEqual([[11]]);
    });

    it('gives each statement the query time limit, and the batch its own', async () => {
        const { engine, path } = file();
        const started = Date.now();
        await expect(
            engine.readBatch(path, [{ sql: 'SELECT 1' }, { sql: heavy(1_000_000_000) }], {
                ...caps,
                timeoutMs: 300,
            }),
        ).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/^Statement 2 ran longer than 0.3 s/) });
        expect(Date.now() - started).toBeLessThan(10_000);
        await expect(
            engine.readBatch(
                path,
                Array.from({ length: 30 }, () => ({ sql: heavy(1_000_000) })),
                { ...caps, timeoutMs: 20_000, totalTimeoutMs: 300 },
            ),
        ).rejects.toMatchObject({
            status: 504,
            message: expect.stringMatching(/^The read batch ran longer than 0.3 s/),
        });
        // The file reads and writes again at once.
        expect(engine.insert(path, 't', [{ x: 5 }], 1 << 24)).toMatchObject({ changes: 1 });
    });

    it('holds the batch’s answer to its byte cap, naming the statement that passed it', async () => {
        const { engine, path } = file();
        const wide = { sql: "SELECT x, printf('%.500c', 'y') FROM t" };
        await expect(
            engine.readBatch(path, [wide, wide, wide], { ...caps, maxTotalBytes: 12_000 }),
        ).rejects.toMatchObject({
            status: 413,
            message: expect.stringMatching(/^Statement 3: the batch's results passed/),
        });
        expect(await engine.readBatch(path, [wide, wide], { ...caps, maxTotalBytes: 12_000 })).toHaveLength(2);
    });
});

describe('read batch review fixes (CB-474)', () => {
    function file() {
        const dir = mkdtempSync(join(tmpdir(), 'socio-read-batch-bytes-'));
        const runner = new QueryRunner();
        cleanup.push(() => {
            runner.close();
            rmSync(dir, { recursive: true, force: true });
        });
        const engine = new DatasetEngine(runner);
        const path = join(dir, 'd.sqlite');
        engine.create(path);
        engine.createTable(path, { table: 't', columns: [{ name: 'x', type: 'INTEGER' }] }, 1 << 24);
        engine.insert(
            path,
            't',
            Array.from({ length: 10 }, (_, x) => ({ x })),
            1 << 24,
        );
        return { engine, path };
    }
    const caps = { maxRows: 100, maxBytes: 65_536, maxTotalBytes: 12_000, timeoutMs: 20_000, totalTimeoutMs: 60_000 };

    it('counts the answer in UTF-8 bytes, not characters', async () => {
        const { engine, path } = file();
        // 300 characters a row, 900 bytes: two statements are about 6 K characters and 18 KB.
        const wide = { sql: "SELECT printf('%.300c', '界') FROM t" };
        await expect(engine.readBatch(path, [wide, wide], caps)).rejects.toMatchObject({
            status: 413,
            message: expect.stringMatching(/^Statement 2: the batch's results passed/),
        });
    });

    it('counts only the rows it keeps toward the batch’s cap', async () => {
        const { engine, path } = file();
        // One row past the statement's own cap: left out, as a single query leaves it.
        const result = await engine.readBatch(path, [{ sql: "SELECT printf('%.5000c', 'x')" }], {
            ...caps,
            maxBytes: 1000,
            maxTotalBytes: 2000,
        });
        expect(result[0]).toMatchObject({ rows: [], truncated: true });
    });

    it('reads row ids past 2^53 in every statement after a RETURNING one', async () => {
        const { engine, path } = file();
        const done = await engine.batch(
            path,
            [
                [{ sql: 'INSERT INTO t (rowid, x) VALUES (9007199254740993, 1) RETURNING rowid', params: [] }],
                [{ sql: 'UPDATE t SET x = x WHERE x = 1', params: [] }],
            ],
            1 << 24,
            { writer: 'test', allowDelete: false, timeoutMs: 10_000 },
        );
        expect(done.results).toEqual([
            { changes: 1, lastInsertRowid: '9007199254740993', columns: ['rowid'], rows: [['9007199254740993']] },
            { changes: 2, lastInsertRowid: '9007199254740993' },
        ]);
    });

    it('counts a RETURNING statement’s columns against the cap even with no rows', async () => {
        const { engine, path } = file();
        const alias = 'c'.repeat(200);
        await expect(
            engine.batch(
                path,
                [[{ sql: `UPDATE t SET x = x WHERE x = -1 RETURNING x AS ${alias}`, params: [] }]],
                1 << 24,
                { writer: 'test', allowDelete: false, timeoutMs: 10_000, returning: { maxRows: 100, maxBytes: 100 } },
            ),
        ).rejects.toMatchObject({ status: 413 });
    });

    it('holds RETURNING rows to the cap in UTF-8 bytes', async () => {
        const { engine, path } = file();
        const returning = { maxRows: 100, maxBytes: 2000 };
        // 1,000 characters, 3,000 bytes.
        await expect(
            engine.batch(
                path,
                [[{ sql: "UPDATE t SET x = x WHERE x = 0 RETURNING printf('%.1000c', '界')", params: [] }]],
                1 << 24,
                { writer: 'test', allowDelete: false, timeoutMs: 10_000, returning },
            ),
        ).rejects.toMatchObject({ status: 413 });
        const fits = await engine.batch(
            path,
            [[{ sql: "UPDATE t SET x = x WHERE x = 0 RETURNING printf('%.300c', '界')", params: [] }]],
            1 << 24,
            { writer: 'test', allowDelete: false, timeoutMs: 10_000, returning },
        );
        expect(fits.results[0]!.rows).toHaveLength(1);
    });
});

describe('write batch assertions and RETURNING (CB-475)', () => {
    it('returns each statement’s changes and last row id', async () => {
        const f = await world();
        const { api } = await f.datasync();
        const made = await api('/data/datasets/marts/tables', 'POST', {
            table: 'events',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'title', type: 'TEXT' },
            ],
        });
        expect(made.status).toBe(200);
        const done = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { sql: "INSERT INTO events (title) VALUES ('Open studio')" },
                { sql: "INSERT INTO events (title) VALUES ('Demo day')", expectChanges: 1 },
                { sql: "UPDATE events SET title = upper(title) WHERE title = 'Nope'", expectChanges: 0 },
                { op: 'insert', table: 'events', rows: [{ title: 'a' }, { title: 'b' }], expectChanges: 2 },
            ],
        });
        expect(done.status).toBe(200);
        expect(done.body).toMatchObject({
            result: {
                statements: 4,
                changes: [1, 1, 0, 2],
                totalChanges: 4,
                results: [
                    { changes: 1, lastInsertRowid: 1 },
                    { changes: 1, lastInsertRowid: 2 },
                    { changes: 0, lastInsertRowid: 2 },
                    { changes: 2, lastInsertRowid: 4 },
                ],
            },
        });
        expect((done.body.result as { results: object[] }).results[0]).not.toHaveProperty('rows');
    });

    it('rolls the whole batch back when a statement makes other changes than it expects, naming its index', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await events(api);
        await api('/data/datasets/marts/tables/daily/rows', 'POST', { rows: [{ day: '2026-11-01', total: 1 }] });
        const failed = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { sql: "INSERT INTO daily (day, total) VALUES ('2026-11-02', 2)", expectChanges: 1 },
                { sql: 'UPDATE daily SET total = total + 1' },
                // An optimistic check that no longer holds: the row isn't at 1 any more.
                { sql: "UPDATE daily SET total = 10 WHERE day = '2026-11-01' AND total = 1", expectChanges: 1 },
            ],
        });
        expect(failed.status).toBe(409);
        expect(failed.body).toEqual({
            error: 'Statement 3 (index 2) expected 1 change(s) and made 0. Nothing in the batch was kept.',
            code: 'expect_changes',
            index: 2,
            expected: 1,
            actual: 0,
        });
        const rows = await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT day, total FROM daily' });
        expect((rows.body as unknown as QueryResult).rows).toEqual([['2026-11-01', 1]]);
        expect(audit(f, 'batch').at(-1)).toMatchObject({ outcome: 'error', detail: expect.stringMatching(/index 2/) });

        // More changes than expected fail as well; a row op too.
        const more = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { op: 'upsert', table: 'daily', key: ['day'], rows: [{ day: 'a' }, { day: 'b' }], expectChanges: 1 },
            ],
        });
        expect(more.body).toMatchObject({ code: 'expect_changes', index: 0, expected: 1, actual: 2 });
        // Not a whole number of changes: refused before anything runs.
        for (const expectChanges of [-1, 1.5, '1']) {
            const bad = await api('/data/datasets/marts/batch', 'POST', {
                statements: [{ sql: "INSERT INTO daily (day) VALUES ('z')", expectChanges }],
            });
            expect(bad.status).toBe(400);
        }
    });

    it('returns RETURNING rows, all of them or none of the batch', async () => {
        const f = await world({ pluginQueryMaxRows: 3 });
        const { api } = await f.datasync();
        await api('/data/datasets/marts/tables', 'POST', {
            table: 'events',
            columns: [
                { name: 'id', type: 'INTEGER', primaryKey: true },
                { name: 'title', type: 'TEXT' },
                { name: 'seats', type: 'INTEGER' },
            ],
        });
        const done = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                {
                    sql: "INSERT INTO events (title, seats) VALUES ('Open studio', 20), ('Demo day', 40) RETURNING id, title",
                    expectChanges: 2,
                },
                {
                    sql: 'UPDATE events SET seats = seats - 1 WHERE id = ? RETURNING seats',
                    params: [2],
                    expectChanges: 1,
                },
                { sql: 'DELETE FROM events WHERE id = 1 RETURNING *' },
            ],
        });
        expect(done.status).toBe(200);
        expect((done.body.result as { results: unknown[] }).results).toEqual([
            {
                changes: 2,
                lastInsertRowid: 2,
                columns: ['id', 'title'],
                rows: [
                    [1, 'Open studio'],
                    [2, 'Demo day'],
                ],
            },
            { changes: 1, lastInsertRowid: 2, columns: ['seats'], rows: [[39]] },
            { changes: 1, lastInsertRowid: 2, columns: ['id', 'title', 'seats'], rows: [[1, 'Open studio', 20]] },
        ]);
        // More rows than one query returns: the whole batch rolls back.
        const tooMany = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { sql: "INSERT INTO events (title) VALUES ('x')" },
                { sql: 'UPDATE events SET seats = 0 RETURNING id' },
                { sql: "INSERT INTO events (title) VALUES ('a'), ('b'), ('c'), ('d') RETURNING id" },
            ],
        });
        expect(tooMany.status).toBe(413);
        expect(String(tooMany.body.error)).toMatch(
            /^Statement 3: its RETURNING rows passed 3 rows.*Nothing in the batch was kept/,
        );
        const left = await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT id, seats FROM events' });
        expect((left.body as unknown as QueryResult).rows).toEqual([[2, 39]]);
        // RETURNING reads under the batch's guard: never the engine's tables.
        // SQLite names a table a RETURNING subquery reads without its database,
        // as written: each is checked as a table, never taken for a CTE.
        for (const sql of [
            "INSERT INTO events (title) VALUES ('x') RETURNING (SELECT count(*) FROM _writes)",
            "INSERT INTO events (title) VALUES ('x') RETURNING (SELECT max(actor) FROM _WRITES)",
            'UPDATE events SET seats = 1 RETURNING (SELECT count(*) FROM _history_events)',
            // Not even as an error that tells a bit: nothing is read at all.
            "INSERT INTO events (title) VALUES ('x') RETURNING (SELECT CASE WHEN count(*) > 0 THEN abs(-9223372036854775807 - 1) END FROM _writes)",
        ]) {
            const hidden = await api('/data/datasets/marts/batch', 'POST', { statements: [{ sql }] });
            expect(hidden.status, sql).toBe(403);
        }
        // Its own tables, and a CTE, read as anywhere else.
        const own = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                {
                    sql: 'UPDATE events SET seats = seats RETURNING (SELECT count(*) FROM EVENTS), (WITH q AS (SELECT 7 AS z) SELECT z FROM q)',
                },
            ],
        });
        expect(own.status).toBe(200);
        expect((own.body.result as { results: Array<{ rows: unknown[] }> }).results[0]!.rows).toEqual([[1, 7]]);
        const fn = await api('/data/datasets/marts/batch', 'POST', {
            statements: [{ sql: "INSERT INTO events (title) VALUES ('x') RETURNING load_extension('x')" }],
        });
        expect(fn.status).toBe(403);
        expect(
            (
                (await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT count(*) FROM events' }))
                    .body as unknown as QueryResult
            ).rows,
        ).toEqual([[1]]);
    });
});
