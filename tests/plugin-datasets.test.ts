import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { DataSpaceState, DatasetDetail, QueryResult } from '@socio/shared/data-types';

import { DatasetEngine, batchRuns } from '../src/server/dataspace/engine.js';
import { dataSettingsFromEnv } from '../src/server/dataspace/limits.js';
import { QueryRunner } from '../src/server/dataspace/query-runner.js';
import { parseManifest } from '../src/server/plugins/catalog.js';

import { updateAcked } from './helpers/plugin-update.js';
import { HISTORY_TABLE, SHARED, cleanup, manifest, world } from './helpers/plugin-world.js';

// A service plugin's datasets (workspace datasets bound to its needs since
// CB-451): declared in its manifest, bound on install and enable, reached by
// a data token it exchanges its identity for, written with single ops and
// atomic batches. The bindings themselves: plugin-dataset-bindings.test.ts.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** The raw, facts and mart tables the sheet sync keeps, made through the single routes. */
async function schema(api: ReturnType<Awaited<ReturnType<typeof world>>['withToken']>) {
    for (const [dataset, table, columns] of [
        [
            'stripe',
            'raw_charges',
            [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'payload', type: 'JSON' },
            ],
        ],
        [
            'stripe',
            'facts',
            [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'day', type: 'TEXT' },
                { name: 'amount', type: 'INTEGER' },
            ],
        ],
        [
            'marts',
            'daily',
            [
                { name: 'day', type: 'TEXT', primaryKey: true },
                { name: 'total', type: 'INTEGER' },
            ],
        ],
    ] as const) {
        const made = await api(`/data/datasets/${dataset}/tables`, 'POST', { table, columns });
        expect(made.status).toBe(200);
    }
}

describe('the manifest', () => {
    it('validates a service plugin’s datasets', () => {
        const parsed = parseManifest(manifest('datasync', [{ name: 'stripe', description: ' Charges ' }]), 'catalog');
        expect(parsed.datasets).toEqual([{ name: 'stripe', description: 'Charges' }]);
        expect(parseManifest(manifest('datasync', []), 'catalog').datasets).toBeUndefined();
        for (const [datasets, message] of [
            [[{ name: 'has space' }], /a name is 1 to 63/],
            [[{ name: '_hidden' }], /a name is 1 to 63/],
            [[{ name: 'x'.repeat(64) }], /a name is 1 to 63/],
            [[{ name: 'stripe' }, { name: 'STRIPE' }], /listed twice/],
            [[{ name: 'stripe', owner: 'alice' }], /field owner is not allowed/],
            [[{ name: 'stripe', description: 'two\nlines' }], /one line/],
            [Array.from({ length: 17 }, (_, i) => ({ name: `d${i}` })), /at most 16/],
            ['stripe', /at most 16/],
        ] as const) {
            expect(() => parseManifest(manifest('datasync', datasets as unknown as unknown[]), 'catalog')).toThrow(
                message,
            );
        }
    });
});

describe('a plugin’s own datasets', () => {
    it('makes its datasets on install, owned by the plugin, and exchanges its identity for a data token', async () => {
        const f = await world();
        const { identity, token, datasets, dataUrl, expiresAt, api } = await f.datasync();
        expect(dataUrl).toBe('/api/data');
        expect(token).toMatch(/^cbdt_/);
        expect(expiresAt).toBeGreaterThan(Date.now());
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
        expect(datasets.map((item) => item.name)).toEqual(['stripe', 'marts']);
        expect(f.datasetRows('plugin:datasync')).toMatchObject([
            { name: 'marts', deletedAt: null },
            { name: 'stripe', deletedAt: null },
        ]);
        // No plugin datasets for a plugin that declares none, and no token.
        await f.platform.plugins.install('plain');
        expect(f.datasetRows('plugin:plain')).toEqual([]);
        expect((await f.exchange(f.delivered('plain'), f.proof('plain'))).status).toBe(404);

        // Only its own identity with its own proof: not the shared token, another
        // plugin's proof, a missing proof, a person's session or a data token.
        expect((await f.exchange(identity, undefined)).status).toBe(401);
        expect((await f.exchange(identity, f.proof('reports'))).status).toBe(401);
        expect((await f.exchange(SHARED, f.proof('datasync'))).status).toBe(401);
        // Its own data token reaches the data API only.
        expect((await f.exchange(token, f.proof('datasync'))).status).toBe(403);
        const alice = await f.as('alice');
        expect((await alice('/workload/data-token', 'POST', {})).status).toBe(401);
        // Narrowed to some of its datasets by name; an unknown name is refused.
        const narrow = await f.exchange(identity, f.proof('datasync'), { datasets: ['marts'] });
        expect(narrow.body.datasets.map((item) => item.name)).toEqual(['marts']);
        expect((await f.withToken(narrow.body.token)('/data/datasets/stripe')).status).toBe(404);
        expect((await f.exchange(identity, f.proof('datasync'), { datasets: ['nope'] })).status).toBe(404);
        expect((await f.exchange(identity, f.proof('datasync'), { owner: 'alice' })).status).toBe(400);

        // The token lists exactly its datasets, writes and reads them, as the plugin.
        const listed = await api('/data/datasets');
        expect(listed.status).toBe(200);
        expect((listed.body as unknown as Array<{ name: string }>).map((item) => item.name).sort()).toEqual([
            'marts',
            'stripe',
        ]);
        await schema(api);
        const rows = await api('/data/datasets/stripe/tables/raw_charges/rows', 'POST', {
            rows: [
                { id: 'ch_1', payload: { amount: 1200, created: '2026-11-01' } },
                { id: 'ch_2', payload: { amount: 800, created: '2026-11-01' } },
            ],
        });
        expect(rows).toMatchObject({ status: 200, body: { status: 'done', result: { rows: 2 } } });
        const query = await api('/data/datasets/stripe/query', 'POST', {
            sql: 'SELECT count(*) AS n FROM raw_charges',
        });
        expect((query.body as unknown as QueryResult).rows).toEqual([[2]]);
        const index = await api('/data/datasets/stripe/tables/facts/indexes', 'POST', {
            name: 'facts_by_day',
            columns: ['day'],
        });
        expect(index.status).toBe(200);
        expect((await api('/data/datasets/stripe/tables/facts/indexes/facts_by_day', 'DELETE')).status).toBe(200);
        const audit = f.workspace.db
            .prepare(
                "SELECT ownerUserId, actorKind, actorId, dotId, area FROM data_audit WHERE action='insert' AND outcome='ok'",
            )
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            {
                ownerUserId: 'plugin:datasync',
                actorKind: 'plugin',
                actorId: 'datasync',
                dotId: null,
                area: 'ws:workspace',
            },
        ]);
        // Row history names the plugin as the writer.
        await api('/data/datasets/stripe/tables/raw_charges/rows', 'POST', {
            rows: [{ id: 'ch_1', payload: { amount: 1300, created: '2026-11-01' } }],
            key: ['id'],
        });
        const stripe = f.datasetRows('plugin:datasync').find((row) => row.name === 'stripe')!;
        expect(f.platform.data.withHistoryRows(stripe.id, 'raw_charges')).toMatchObject([
            { change: 'update', actor: 'plugin:datasync' },
        ]);
    });

    it('never reaches another owner’s data, files or routes, and takes no x-cb-obo', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await f.platform.plugins.install('reports');
        const reports = f.datasetRows('plugin:reports')[0]!;
        // A person's own dataset and a company socio's shared one.
        const alice = await f.as('alice');
        const mine = await alice('/data/datasets', 'POST', { name: 'stripe' });
        expect(mine.status).toBe(201);
        const dot = f.workspace.dots()[0]!;
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'socio').token);
        await computer('/data/datasets/scratch/tables', 'POST', {
            table: 't',
            columns: [{ name: 'a', type: 'INTEGER' }],
        });
        const shared = f.platform.data.scratch(`socio:${dot.id}`, dot.id, false)!;
        for (const id of [reports.id, mine.body.id as string, shared.id, 'scratch', 'reports']) {
            for (const [path, method, body] of [
                [`/data/datasets/${id}`, 'GET', undefined],
                [`/data/datasets/${id}/query`, 'POST', { sql: 'SELECT 1' }],
                [`/data/datasets/${id}/tables`, 'POST', { table: 'x', columns: [{ name: 'a' }] }],
                [`/data/datasets/${id}/batch`, 'POST', { statements: [{ sql: 'UPDATE t SET a = 1' }] }],
            ] as const) {
                expect((await api(path, method, body)).status, `${method} ${path}`).toBe(404);
            }
        }
        // "stripe" by name is its own, never Alice's dataset of that name.
        const own = await api('/data/datasets/stripe');
        expect(own.status).toBe(200);
        expect((own.body as { id: string }).id).not.toBe(mine.body.id);
        // No files, no jobs, no apps' or workloads' routes.
        expect((await api('/data/files')).status).toBe(403);
        expect((await api('/data/files', 'PUT', { path: 'a.txt', content: 'x' })).status).toBe(403);
        expect((await api('/data/files/raw?path=a.txt')).status).toBe(403);
        expect((await api('/data/job/checkpoint')).status).toBeGreaterThanOrEqual(400);
        expect((await api('/workload/secrets?names=STRIPE_API_KEY')).status).toBe(403);
        expect((await api('/apps/actor/approvals', 'POST', {})).status).toBe(403);
        // Nor the user-only routes.
        expect((await api('/data/datasets/stripe', 'DELETE')).status).toBe(403);
        expect((await api('/data/grants')).status).toBe(403);
        // Background writes need no x-cb-obo, and one is refused.
        const obo = f.withToken((await f.exchange(f.delivered('datasync'), f.proof('datasync'))).body.token, {
            'x-cb-obo': 'cbob_whatever',
        });
        expect((await obo('/data/datasets')).status).toBe(400);
        const denied = f.workspace.db
            .prepare("SELECT count(*) AS n FROM data_audit WHERE actorKind='plugin' AND outcome='denied'")
            .get() as { n: number };
        expect(Number(denied.n)).toBeGreaterThan(0);
    });

    it('ends its tokens when it is disabled or uninstalled, and keeps its data', async () => {
        const f = await world();
        const { api, identity } = await f.datasync();
        await schema(api);
        await api('/data/datasets/stripe/tables/raw_charges/rows', 'POST', { rows: [{ id: 'ch_1', payload: {} }] });
        const before = f.datasetRows('plugin:datasync');

        await f.platform.plugins.setEnabled('datasync', false);
        expect((await api('/data/datasets')).status).toBe(401);
        expect((await f.exchange(identity, f.proof('datasync'))).status).toBe(401);
        expect(f.datasetRows('plugin:datasync')).toEqual(before);

        // Enabled again: a new identity, the same datasets adopted with their rows.
        await f.platform.plugins.setEnabled('datasync', true);
        const again = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        expect(again.status).toBe(200);
        expect(again.body.datasets.map((item) => item.id).sort()).toEqual(before.map((row) => row.id).sort());
        const fresh = f.withToken(again.body.token);
        const count = await fresh('/data/datasets/stripe/query', 'POST', { sql: 'SELECT count(*) FROM raw_charges' });
        expect((count.body as unknown as QueryResult).rows).toEqual([[1]]);

        // A token the database still holds is refused once the plugin is off,
        // even if this runtime's revocation never ran (another runtime disabled it).
        f.workspace.db.prepare('UPDATE plugin_installs SET enabled=0 WHERE id=?').run('datasync');
        expect((await fresh('/data/datasets')).status).toBe(401);
        f.workspace.db.prepare('UPDATE plugin_installs SET enabled=1 WHERE id=?').run('datasync');
        expect((await fresh('/data/datasets')).status).toBe(200);

        await f.platform.plugins.uninstall('datasync');
        expect((await fresh('/data/datasets')).status).toBe(401);
        expect(f.datasetRows('plugin:datasync')).toEqual(before);
        // Installed again later, the admin is offered what it left,
        // preselected (CB-451); nothing is taken back without the choice.
        const plan = f.platform.plugins.bindingPlan('datasync');
        const bindings = Object.fromEntries(plan.needs.map((need) => [need.need, need.preselected]));
        expect(
            Object.values(bindings)
                .map((choice) => (choice as { datasetId: string }).datasetId)
                .sort(),
        ).toEqual(before.map((row) => row.id).sort());
        await f.platform.plugins.install('datasync', {}, { bindings });
        const third = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        expect(third.body.datasets.map((item) => item.id).sort()).toEqual(before.map((row) => row.id).sort());
    });

    it('stops a token when the identity it was exchanged for is rotated out', async () => {
        const f = await world();
        const { api } = await f.datasync();
        expect((await api('/data/datasets')).status).toBe(200);
        // Rotated twice: the first version is no longer accepted, nor its token.
        await f.platform.plugins.rotateIdentity('datasync');
        expect((await api('/data/datasets')).status).toBe(200);
        await f.platform.plugins.rotateIdentity('datasync');
        expect((await api('/data/datasets')).status).toBe(401);
        const fresh = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        expect((await f.withToken(fresh.body.token)('/data/datasets')).status).toBe(200);
    });
});

describe('batches', () => {
    it('rebuilds a mart atomically with DELETE and INSERT … SELECT over json_extract', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        const load = await api('/data/datasets/stripe/batch', 'POST', {
            statements: [
                {
                    op: 'upsert',
                    table: 'raw_charges',
                    key: ['id'],
                    rows: [
                        { id: 'ch_1', payload: { amount: 1200, created: '2026-11-01' } },
                        { id: 'ch_2', payload: { amount: 800, created: '2026-11-01' } },
                        { id: 'ch_3', payload: { amount: 500, created: '2026-11-02' } },
                    ],
                },
                { sql: 'DELETE FROM facts' },
                {
                    sql: "INSERT INTO facts (id, day, amount) SELECT id, json_extract(payload, '$.created'), json_extract(payload, '$.amount') FROM raw_charges WHERE json_extract(payload, '$.amount') >= ?",
                    params: [0],
                },
            ],
        });
        expect(load).toMatchObject({
            status: 200,
            body: { status: 'done', dataset: 'stripe', result: { statements: 3, changes: [3, 0, 3], totalChanges: 6 } },
        });
        const facts = await api('/data/datasets/stripe/query', 'POST', {
            sql: 'SELECT day, sum(amount) FROM facts GROUP BY day ORDER BY day',
        });
        expect((facts.body as unknown as QueryResult).rows).toEqual([
            ['2026-11-01', 2000],
            ['2026-11-02', 500],
        ]);
        // Rebuilt again: the old rows go to history, as the plugin's.
        const again = await api('/data/datasets/stripe/batch', 'POST', {
            statements: [
                { sql: 'DELETE FROM facts' },
                {
                    sql: "INSERT INTO facts SELECT id, json_extract(payload, '$.created'), json_extract(payload, '$.amount') * 2 FROM raw_charges",
                },
            ],
        });
        expect(again.body).toMatchObject({ result: { changes: [3, 3] } });
        const stripe = f.datasetRows('plugin:datasync').find((row) => row.name === 'stripe')!;
        expect(f.platform.data.withHistoryRows(stripe.id, 'facts')).toHaveLength(3);
        expect(f.platform.data.withHistoryRows(stripe.id, 'facts')[0]).toMatchObject({
            change: 'delete',
            actor: 'plugin:datasync',
        });
        const audit = f.workspace.db
            .prepare(
                "SELECT actorKind, detail FROM data_audit WHERE action='batch' AND outcome='ok' ORDER BY createdAt",
            )
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            { actorKind: 'plugin', detail: '3 statement(s), 6 change(s)' },
            { actorKind: 'plugin', detail: '2 statement(s), 6 change(s)' },
        ]);
    });

    it('keeps nothing of a batch when a statement fails part way', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        await api('/data/datasets/marts/tables/daily/rows', 'POST', { rows: [{ day: '2026-11-01', total: 1 }] });
        const count = async () =>
            (
                (await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT count(*), sum(total) FROM daily' }))
                    .body as unknown as QueryResult
            ).rows;
        const before = await count();
        for (const failing of [
            // A constraint fails in the third statement.
            { sql: "INSERT INTO daily (day, total) VALUES ('2026-11-01', 9)" },
            // A table that isn't there.
            { sql: 'INSERT INTO nope SELECT 1' },
            // A refused statement.
            { sql: 'INSERT INTO daily SELECT name, 1 FROM _writes' },
        ]) {
            const response = await api('/data/datasets/marts/batch', 'POST', {
                statements: [
                    { sql: 'DELETE FROM daily' },
                    { op: 'insert', table: 'daily', rows: [{ day: '2026-11-01', total: 5 }] },
                    failing,
                ],
            });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(String(response.body.error)).toMatch(/^Statement 3: .*Nothing in the batch was kept\.$/s);
            expect(await count()).toEqual(before);
        }
        const errors = f.workspace.db
            .prepare("SELECT count(*) AS n FROM data_audit WHERE action='batch' AND outcome IN ('error','denied')")
            .get() as { n: number };
        expect(Number(errors.n)).toBe(3);
    });

    it('refuses DDL, PRAGMA, ATTACH, transactions, engine tables and denied functions inside a batch', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        const refused = async (sql: string) => {
            const response = await api('/data/datasets/stripe/batch', 'POST', {
                statements: [{ sql: "INSERT INTO facts (id) VALUES ('kept?')" }, { sql }],
            });
            return { status: response.status, error: String(response.body.error) };
        };
        for (const sql of [
            'CREATE TABLE evil (a)',
            'DROP TABLE facts',
            'ALTER TABLE facts ADD COLUMN b',
            'CREATE INDEX evil ON facts (day)',
            'PRAGMA writable_schema = ON',
            "ATTACH DATABASE '/tmp/evil.sqlite' AS evil",
            'BEGIN',
            'COMMIT',
            'SAVEPOINT a',
            'VACUUM',
            'SELECT * FROM facts',
            "INSERT INTO facts (id) VALUES ('a'); DROP TABLE facts",
        ]) {
            expect(await refused(sql), sql).toMatchObject({ status: 400 });
        }
        for (const sql of [
            'INSERT INTO _history_facts (_rowid) VALUES (1)',
            "UPDATE _writer SET actor = 'alice'",
            'DELETE FROM _writes',
            'INSERT INTO facts (id) SELECT actor FROM _writes',
            "INSERT INTO facts (id) SELECT load_extension('/tmp/x.so')",
            "INSERT INTO facts (id, amount) SELECT 'z', length(zeroblob(1000000000))",
            'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) INSERT INTO facts (id) SELECT i FROM n LIMIT 5',
            "INSERT INTO facts (id) SELECT name FROM pragma_table_info('facts')",
            "INSERT INTO main.sqlite_master (name) VALUES ('x')",
        ]) {
            // The batch's authorizer refuses each, whatever SQLite would do.
            expect(await refused(sql), sql).toMatchObject({
                status: 403,
                error: expect.stringMatching(/^Statement 2: not allowed/),
            });
        }
        expect((await refused('INSERT INTO temp.t VALUES (1)')).status).toBeGreaterThanOrEqual(400);
        // Not in this SQLite at all, and denied if it were.
        expect((await refused("INSERT INTO facts (id) SELECT readfile('/etc/passwd')")).status).toBeGreaterThanOrEqual(
            400,
        );
        // A statement naming the engine's triggers' prefix can't pass as one.
        expect(
            await refused(
                'WITH _keep_delete_facts AS (SELECT actor FROM _writes) INSERT INTO facts (id) SELECT actor FROM _keep_delete_facts',
            ),
        ).toMatchObject({ status: 400, error: expect.stringMatching(/reserved/) });
        // Nothing of any of them was kept.
        const kept = await api('/data/datasets/stripe/query', 'POST', { sql: 'SELECT count(*) FROM facts' });
        expect((kept.body as unknown as QueryResult).rows).toEqual([[0]]);
        // The schema is as it was.
        const detail = await api('/data/datasets/stripe');
        expect((detail.body as { tables: Array<{ name: string }> }).tables.map((table) => table.name).sort()).toEqual([
            'facts',
            'raw_charges',
        ]);
    });

    it('holds a batch to its statement limit, the per-minute budget and the dataset quota', async () => {
        const f = await world({ pluginStatementsPerMinute: 40 });
        const { api } = await f.datasync();
        await schema(api); // 3 statements of the budget
        const statements = (n: number) =>
            Array.from({ length: n }, (_, i) => ({
                sql: `INSERT INTO daily (day, total) VALUES ('d${i}-${n}', ${i})`,
            }));
        expect((await api('/data/datasets/marts/batch', 'POST', { statements: statements(33) })).status).toBe(413);
        expect((await api('/data/datasets/marts/batch', 'POST', { statements: [] })).status).toBe(400);
        expect((await api('/data/datasets/marts/batch', 'POST', { statements: statements(32) })).status).toBe(200);
        // 3 + 32 used: a batch of 6 is over the 40 a minute, one of 5 isn't.
        expect((await api('/data/datasets/marts/batch', 'POST', { statements: statements(6) })).status).toBe(429);
        expect((await api('/data/datasets/marts/batch', 'POST', { statements: statements(5) })).status).toBe(200);
    });

    it('lets an admin raise a plugin dataset’s size and rows per query', async () => {
        const f = await world({ pluginDatasetMaxBytes: 64 * 1024 });
        const { api } = await f.datasync();
        await schema(api);
        const big = 'x'.repeat(4000);
        const fill = (from: number) =>
            api('/data/datasets/marts/batch', 'POST', {
                statements: [
                    {
                        op: 'insert',
                        table: 'daily',
                        rows: Array.from({ length: 40 }, (_, i) => ({ day: `${from + i}-${big}`, total: i })),
                    },
                ],
            });
        const full = await fill(0);
        expect(full.status).toBe(413);
        expect(String(full.body.error)).toMatch(/full.*Nothing in the batch was kept/);
        const alice = await f.as('alice');
        expect(
            (await alice('/settings', 'PATCH', { limits: { dataPluginDatasetMaxMb: 2, dataPluginQueryMaxRows: 1000 } }))
                .status,
        ).toBe(200);
        expect((await fill(0)).status).toBe(200);
        expect((await fill(40)).status).toBe(200);
        for (let at = 80; at < 700; at += 40) {
            await api('/data/datasets/marts/tables/daily/rows', 'POST', {
                rows: Array.from({ length: 40 }, (_, i) => ({ day: `s${at + i}`, total: i })),
            });
        }
        const rows = await api('/data/datasets/marts/query', 'POST', { sql: 'SELECT day FROM daily' });
        expect((rows.body as unknown as QueryResult).rows.length).toBeGreaterThan(500);
        // A person's own dataset keeps the general limit.
        expect(f.platform.data.limits.queryMaxRows).toBe(500);
    });

    it('offers batches to other tokens without DELETE, and never on a Space-shared dataset', async () => {
        const f = await world();
        const dot = f.workspace.dots()[0]!;
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        await computer('/data/datasets/scratch/tables', 'POST', {
            table: 'items',
            columns: [
                { name: 'name', type: 'TEXT', primaryKey: true },
                { name: 'n', type: 'INTEGER' },
            ],
        });
        const done = await computer('/data/datasets/scratch/batch', 'POST', {
            statements: [
                { op: 'insert', table: 'items', rows: [{ name: 'a', n: 1 }] },
                { sql: "INSERT INTO items SELECT 'b', n + 1 FROM items WHERE name = 'a'" },
                { sql: 'UPDATE items SET n = n * 10' },
            ],
        });
        expect(done).toMatchObject({ status: 200, body: { result: { changes: [1, 1, 2] } } });
        expect(
            (await computer('/data/datasets/scratch/batch', 'POST', { statements: [{ sql: 'DELETE FROM items' }] }))
                .status,
        ).toBe(400);
        expect(
            (
                await computer('/data/datasets/scratch/batch', 'POST', {
                    statements: [{ sql: 'WITH x AS (SELECT 1) DELETE FROM items' }],
                })
            ).status,
        ).toBe(403);
        // A session can't batch: the person changes data in the app.
        const alice = await f.as('alice');
        expect(
            (await alice('/data/datasets/scratch/batch', 'POST', { statements: [{ sql: 'UPDATE items SET n = 1' }] }))
                .status,
        ).toBe(403);
    });
});

describe('batch review fixes', () => {
    it('keeps the rows a REPLACE replaces in row history, as a DELETE does', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        await api('/data/datasets/marts/tables/daily/rows', 'POST', {
            rows: [
                { day: 'a', total: 1 },
                { day: 'b', total: 2 },
            ],
        });
        const done = await api('/data/datasets/marts/batch', 'POST', {
            statements: [
                { sql: "REPLACE INTO daily (day, total) VALUES ('a', 10)" },
                { sql: "INSERT OR REPLACE INTO daily (day, total) VALUES ('b', 20)" },
            ],
        });
        expect(done.status).toBe(200);
        const marts = f.datasetRows('plugin:datasync').find((row) => row.name === 'marts')!;
        expect(
            f.platform.data
                .withHistoryRows(marts.id, 'daily')
                .map((row) => [row.values.day, row.values.total, row.actor]),
        ).toEqual([
            ['a', 1, 'plugin:datasync'],
            ['b', 2, 'plugin:datasync'],
        ]);
        // A socio's computer, which may not DELETE, may still REPLACE, and keeps history too.
        const dot = f.workspace.dots()[0]!;
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        await computer('/data/datasets/scratch/tables', 'POST', {
            table: 'kv',
            columns: [
                { name: 'k', type: 'TEXT', primaryKey: true },
                { name: 'v', type: 'TEXT' },
            ],
        });
        await computer('/data/datasets/scratch/tables/kv/rows', 'POST', { rows: [{ k: 'x', v: 'old' }] });
        const replaced = await computer('/data/datasets/scratch/batch', 'POST', {
            statements: [{ sql: "REPLACE INTO kv (k, v) VALUES ('x', 'new')" }],
        });
        expect(replaced.status).toBe(200);
        const scratch = f.platform.data.scratch('alice', dot.id, false)!;
        expect(f.platform.data.withHistoryRows(scratch.id, 'kv').map((row) => row.values.v)).toEqual(['old']);
    });

    it('names a plugin dataset called "scratch" by its name', async () => {
        const f = await world();
        // The same catalog shape, with a dataset named like the scratch alias.
        await f.platform.plugins.install('datasync');
        f.workspace.db
            .prepare('UPDATE plugin_installs SET manifest=json_set(manifest, ?, json(?)) WHERE id=?')
            .run('$.datasets', JSON.stringify([{ name: 'scratch' }]), 'datasync');
        f.platform.data.ensurePluginDatasets('datasync', [{ name: 'scratch' }]);
        const issued = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        expect(issued.body.datasets.map((item) => item.name)).toEqual(['scratch']);
        const described = await f.withToken(issued.body.token)('/data/datasets/scratch');
        expect(described).toMatchObject({ status: 200, body: { name: 'scratch', id: issued.body.datasets[0]!.id } });
    });

    it('holds a person’s quota across concurrent batches on two of their datasets', async () => {
        const f = await world({ userMaxBytes: 600 * 1024 });
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        const other = await alice('/data/datasets', 'POST', { name: 'other' });
        expect(
            (await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: other.body.id, access: 'write' })).status,
        ).toBe(200);
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        for (const dataset of ['scratch', String(other.body.id)]) {
            await computer(`/data/datasets/${dataset}/tables`, 'POST', {
                table: 'blob',
                columns: [{ name: 'v', type: 'TEXT' }],
            });
        }
        // Each adds about 360 KB: either fits alone, both together don't.
        const fill = (dataset: string) =>
            computer(`/data/datasets/${dataset}/batch`, 'POST', {
                statements: [
                    {
                        sql: "WITH n(i) AS (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) INSERT INTO blob (v) SELECT printf('%.30000c', 'x') || a.i FROM n a",
                    },
                ],
            });
        const results = await Promise.all([fill('scratch'), fill(String(other.body.id))]);
        expect(results.map((result) => result.status).sort()).toEqual([200, 413]);
        expect(f.platform.data.usage('alice').totalBytes).toBeLessThanOrEqual(600 * 1024);
    });
});

describe('batch review fixes, round 2', () => {
    it('refuses a batch on a Space-shared dataset, except a plugin’s own', async () => {
        const f = await world();
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        const space = f.workspace.spaces()[0]!;
        const shared = await alice('/data/datasets', 'POST', { name: 'team' });
        const id = String(shared.body.id);
        await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: id, access: 'write' });
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        await computer(`/data/datasets/${id}/tables`, 'POST', {
            table: 't',
            columns: [{ name: 'a', type: 'INTEGER' }],
        });
        await computer(`/data/datasets/${id}/tables/t/rows`, 'POST', { rows: [{ a: 1 }] });
        expect((await alice(`/data/datasets/${id}`, 'PATCH', { sharedSpaceId: space.id })).status).toBe(200);
        const refused = await computer(`/data/datasets/${id}/batch`, 'POST', {
            statements: [{ sql: 'INSERT INTO t (a) VALUES (2)' }],
        });
        expect(refused.status).toBe(409);
        const rows = await computer(`/data/datasets/${id}/query`, 'POST', { sql: 'SELECT a FROM t' });
        expect((rows.body as unknown as QueryResult).rows).toEqual([[1]]);
        // A plugin's own dataset, shared by an admin, still takes its batches.
        const { api } = await f.datasync();
        await schema(api);
        const marts = f.datasetRows('plugin:datasync').find((row) => row.name === 'marts')!;
        expect((await alice(`/data/datasets/${marts.id}`, 'PATCH', { sharedSpaceId: space.id })).status).toBe(200);
        const own = await api('/data/datasets/marts/batch', 'POST', {
            statements: [{ sql: "INSERT INTO daily (day, total) VALUES ('d', 1)" }],
        });
        expect(own.status).toBe(200);
    });

    it('records the dataset’s sizes as they are after the batch, not as the batch measured them', async () => {
        const f = await world();
        const dot = f.workspace.dots()[0]!;
        const actor = { kind: 'token' as const, purpose: 'computer' as const, userId: 'alice', dotId: dot.id };
        await f.platform.data.write(actor, undefined, {
            op: 'create_table',
            input: { table: 'blob', columns: [{ name: 'v', type: 'TEXT' }] },
        });
        // A single write that waited for the batch's lock commits before the
        // batch's reply is handled.
        const engine = f.platform.data.engine;
        const original = engine.batch.bind(engine);
        engine.batch = async (...args) => {
            const outcome = await original(...args);
            await f.platform.data.write(actor, undefined, {
                op: 'insert',
                table: 'blob',
                rows: Array.from({ length: 20 }, (_, i) => ({ v: `${'y'.repeat(20_000)}${i}` })),
            });
            return outcome;
        };
        const done = await f.platform.data.batch(actor, undefined, [{ sql: "INSERT INTO blob (v) VALUES ('small')" }]);
        expect(done.status).toBe('done');
        const row = f.platform.data.scratch('alice', dot.id, false)!;
        const measured = engine.sizes(f.platform.data.datasetPath(row));
        expect(row.sizeBytes).toBe(measured.sizeBytes);
        expect(row.sizeBytes).toBeGreaterThan(400_000);
    });
});

describe('batch review fixes, round 3', () => {
    it('says a batch it stopped committed, when it did just before', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'socio-batch-late-'));
        const runner = new QueryRunner();
        cleanup.push(() => {
            runner.close();
            rmSync(dir, { recursive: true, force: true });
        });
        const engine = new DatasetEngine(runner);
        const path = join(dir, 'd.sqlite');
        engine.create(path);
        engine.createTable(path, { table: 't', columns: [{ name: 'x', type: 'INTEGER' }] }, 1 << 24);
        // A warm runner process, so the batch starts at once.
        await engine.query(path, 'SELECT 1', [], { maxRows: 1, maxBytes: 1000, timeoutMs: 5000 });
        const runs = [batchRuns({ sql: 'INSERT INTO t (x) VALUES (1)' }, { allowDelete: false, insertMaxRows: 10 })];
        // The child commits and replies while this process is busy past the
        // limit, so the timer fires before the reply is read.
        const pending = engine.batch(path, runs, 1 << 24, { writer: 'test', allowDelete: false, timeoutMs: 50 });
        const until = Date.now() + 3000;
        while (Date.now() < until) {
            // busy
        }
        const error = await pending.then(
            () => undefined,
            (reason: unknown) => reason as { status: number; message: string },
        );
        // Timers run before the reply is read, so it is stopped after its commit.
        expect(error).toMatchObject({ status: 504, message: expect.stringMatching(/committed as it was stopped/) });
        const rows = await engine.query(path, 'SELECT count(*) FROM t', [], {
            maxRows: 1,
            maxBytes: 1000,
            timeoutMs: 5000,
        });
        expect(rows.rows).toEqual([[1]]);
        // And a batch stopped before it committed says nothing was kept.
        engine.insert(
            path,
            't',
            Array.from({ length: 1000 }, (_, x) => ({ x })),
            1 << 24,
        );
        await expect(
            engine.batch(
                path,
                [
                    batchRuns(
                        { sql: 'INSERT INTO t (x) SELECT count(*) FROM t a, t b, t c' },
                        { allowDelete: false, insertMaxRows: 10 },
                    ),
                ],
                1 << 24,
                { writer: 'test', allowDelete: false, timeoutMs: 200 },
            ),
        ).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/nothing it did was kept/) });
    });

    it('lets queued batches on one dataset count its size as it is when each runs', async () => {
        const f = await world({ userMaxBytes: 600 * 1024 });
        const dot = f.workspace.dots()[0]!;
        const computer = f.withToken(f.platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token);
        await computer('/data/datasets/scratch/tables', 'POST', {
            table: 'blob',
            columns: [{ name: 'v', type: 'TEXT' }],
        });
        // Each adds about 200 KB: both fit, one after the other.
        const fill = (tag: string) =>
            computer('/data/datasets/scratch/batch', 'POST', {
                statements: [
                    {
                        sql: `WITH n(i) AS (VALUES (1),(2),(3),(4),(5),(6),(7)) INSERT INTO blob (v) SELECT printf('%.30000c', 'x') || '${tag}' || a.i FROM n a`,
                    },
                ],
            });
        const results = await Promise.all([fill('a'), fill('b')]);
        expect(results.map((result) => result.status)).toEqual([200, 200]);
    });
});

describe('batch review fixes, astra', () => {
    it('records the sizes of a batch that committed as it was stopped', async () => {
        const f = await world({ userMaxBytes: 700 * 1024 });
        const dot = f.workspace.dots()[0]!;
        const actor = { kind: 'token' as const, purpose: 'computer' as const, userId: 'alice', dotId: dot.id };
        await f.platform.data.write(actor, undefined, {
            op: 'create_table',
            input: { table: 'blob', columns: [{ name: 'v', type: 'TEXT' }] },
        });
        // The batch commits, then its time runs out before its reply is read.
        const engine = f.platform.data.engine;
        const original = engine.batch.bind(engine);
        engine.batch = async (...args) => {
            await original(...args);
            throw new DataError('The batch committed as it was stopped: its changes were kept.', 504);
        };
        await expect(
            f.platform.data.batch(actor, undefined, [
                {
                    sql: "WITH n(i) AS (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15)) INSERT INTO blob (v) SELECT printf('%.30000c', 'x') || a.i FROM n a",
                },
            ]),
        ).rejects.toMatchObject({ status: 504 });
        engine.batch = original;
        const row = f.platform.data.scratch('alice', dot.id, false)!;
        expect(row.sizeBytes).toBe(engine.sizes(f.platform.data.datasetPath(row)).sizeBytes);
        expect(row.sizeBytes).toBeGreaterThan(400_000);
        // The person's quota counts it: another 450 KB doesn't fit.
        const alice = await f.as('alice');
        const other = await alice('/data/datasets', 'POST', { name: 'other' });
        await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: other.body.id, access: 'write' });
        await f.platform.data.write(actor, String(other.body.id), {
            op: 'create_table',
            input: { table: 'blob', columns: [{ name: 'v', type: 'TEXT' }] },
        });
        await expect(
            f.platform.data.write(actor, String(other.body.id), {
                op: 'insert',
                table: 'blob',
                rows: Array.from({ length: 15 }, (_, i) => ({ v: `${'z'.repeat(30_000)}${i}` })),
            }),
        ).rejects.toMatchObject({ status: 413 });
    });
});

describe('batch review fixes, final', () => {
    it('checks a queued batch’s access again once it gets the lock', async () => {
        const f = await world();
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        const space = f.workspace.spaces()[0]!;
        const team = await alice('/data/datasets', 'POST', { name: 'team' });
        const id = String(team.body.id);
        const grant = await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: id, access: 'write' });
        const actor = { kind: 'token' as const, purpose: 'computer' as const, userId: 'alice', dotId: dot.id };
        await f.platform.data.write(actor, id, {
            op: 'create_table',
            input: { table: 't', columns: [{ name: 'a', type: 'INTEGER' }] },
        });
        const count = async () =>
            (await f.platform.data.query({ kind: 'user', userId: 'alice' }, id, 'SELECT count(*) FROM t')).rows;
        // Holds Alice's lock (a file write's), changes the dataset meanwhile, then lets go.
        const holdWhile = async (change: () => unknown) => {
            const data = f.platform.data as unknown as { hold(userId: string): Promise<() => void> };
            const release = await data.hold('alice');
            const queued = f.platform.data.batch(actor, id, [{ sql: 'INSERT INTO t (a) VALUES (1)' }]);
            await new Promise((resolve) => setTimeout(resolve, 20));
            await change();
            release();
            return queued;
        };
        // Shared with a Space while it waited: refused.
        await expect(
            holdWhile(() => alice(`/data/datasets/${id}`, 'PATCH', { sharedSpaceId: space.id })),
        ).rejects.toMatchObject({ status: 409 });
        await alice(`/data/datasets/${id}`, 'PATCH', { sharedSpaceId: null });
        // Its grant ended while it waited: refused.
        await expect(holdWhile(() => alice(`/data/grants/${String(grant.body.id)}`, 'DELETE'))).rejects.toMatchObject({
            status: 403,
        });
        expect(await count()).toEqual([[0]]);
    });
});

describe('admins and socios', () => {
    it('shows admins a plugin’s datasets on the Data page to manage, never members', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        const alice = await f.as('alice');
        const bob = await f.as('bob');
        const state = (await alice('/data?files=false')).body as unknown as DataSpaceState;
        const stripe = state.datasets.find((item) => item.name === 'stripe')!;
        expect(stripe).toMatchObject({
            ownerUserId: 'ws:workspace',
            access: 'owner',
            plugin: { id: 'datasync', name: 'Data sync' },
        });
        const member = (await bob('/data?files=false')).body as unknown as DataSpaceState;
        expect(member.datasets.some((item) => item.ownerUserId === 'ws:workspace')).toBe(false);
        expect((await bob(`/data/datasets/${stripe.id}`)).status).toBe(404);
        expect((await bob(`/data/datasets/${stripe.id}`, 'DELETE')).status).toBe(404);
        // The admin browses, exports, sees its audit and shares it with a Space.
        expect(((await alice(`/data/datasets/${stripe.id}`)).body as unknown as DatasetDetail).tables).toHaveLength(2);
        expect((await alice(`/data/datasets/${stripe.id}/tables/facts/rows`)).status).toBe(200);
        const audit = (await alice(`/data/audit?dataset=${stripe.id}`)).body as unknown as Array<{ actorKind: string }>;
        expect(audit.some((entry) => entry.actorKind === 'plugin')).toBe(true);
        const space = f.workspace.spaces()[0]!;
        expect((await alice(`/data/datasets/${stripe.id}`, 'PATCH', { sharedSpaceId: space.id })).status).toBe(200);
        expect(((await bob(`/data/datasets/${stripe.id}`)).body as unknown as DatasetDetail).dataset).toMatchObject({
            access: 'read',
            ownerName: 'the Data sync plugin',
        });
        // Shared with a Space, the plugin still writes it without an approval.
        expect(
            (await api('/data/datasets/stripe/tables/facts/rows', 'POST', { rows: [{ id: 'f1', amount: 1 }] })).body,
        ).toMatchObject({ status: 'done' });
        // A workspace dataset (CB-451): an admin may rename it; the plugin
        // still finds it by its need's name.
        expect((await alice(`/data/datasets/${stripe.id}`, 'PATCH', { name: 'renamed' })).status).toBe(200);
        expect(((await api('/data/datasets/stripe')).body as { id: string }).id).toBe(stripe.id);
        // Only an admin deletes it; its binding ends, and with it the
        // plugin's tokens (CB-451); a new token no longer reaches it, and
        // enabling the plugin again starts a new, empty one.
        expect((await alice(`/data/datasets/${stripe.id}`, 'DELETE')).status).toBe(200);
        expect((await api('/data/datasets/stripe')).status).toBe(401);
        const fresh = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        expect((await f.withToken(fresh.body.token)('/data/datasets/stripe')).status).toBe(404);
        await f.platform.plugins.setEnabled('datasync', false);
        await f.platform.plugins.setEnabled('datasync', true);
        const after = await f.exchange(f.delivered('datasync'), f.proof('datasync'));
        const recreated = after.body.datasets.find((item) => item.name === 'stripe')!;
        expect(recreated.id).not.toBe(stripe.id);
    });

    it('lets an admin grant a company socio a plugin’s dataset through the usual grants', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        const alice = await f.as('alice');
        const bob = await f.as('bob');
        const dot = f.workspace.dots()[0]!;
        expect(dot.ownerId).toBeNull();
        const marts = f.datasetRows('plugin:datasync').find((row) => row.name === 'marts')!;
        // A member can't grant it; an admin can, and the grant is the plugin's.
        expect((await bob('/data/grants', 'PUT', { dotId: dot.id, datasetId: marts.id, access: 'read' })).status).toBe(
            404,
        );
        const grant = await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: marts.id, access: 'read' });
        expect(grant.status).toBe(200);
        expect(
            f.workspace.db.prepare('SELECT ownerUserId, createdBy FROM data_grants WHERE datasetId=?').get(marts.id),
        ).toEqual({ ownerUserId: 'ws:workspace', createdBy: 'alice' });
        // The socio reads it for anyone who uses it, and can't write it.
        const chat = { kind: 'dot' as const, userId: 'bob', dotId: dot.id };
        expect(f.platform.data.visible(chat).find((item) => item.row.id === marts.id)).toMatchObject({
            access: 'read',
        });
        await expect(
            f.platform.data.write(chat, marts.id, { op: 'insert', table: 'daily', rows: [{ day: 'x', total: 1 }] }),
        ).rejects.toThrow(/may only read/);
        const listed = ((await alice('/data?files=false')).body as unknown as DataSpaceState).grants;
        expect(listed.some((item) => item.datasetId === marts.id)).toBe(true);
        // The admin removes it again.
        expect((await alice(`/data/grants/${String(grant.body.id)}`, 'DELETE')).status).toBe(200);
        expect(f.platform.data.visible(chat).some((item) => item.row.id === marts.id)).toBe(false);
    });

    it('leaves plugin datasets and their grants alone when a person’s data is transferred', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await schema(api);
        const alice = await f.as('alice');
        const dot = f.workspace.dots()[0]!;
        const marts = f.datasetRows('plugin:datasync').find((row) => row.name === 'marts')!;
        await alice('/data/grants', 'PUT', { dotId: dot.id, datasetId: marts.id, access: 'read' });
        await alice(`/data/datasets/${marts.id}/tables/daily/rows`); // an admin's read, audited as Alice's
        await alice('/data/datasets', 'POST', { name: 'mine' });
        const handle = await f.platform.data.prepareTransfer({
            from: 'alice',
            to: 'bob',
            fromName: 'Alice',
            toName: 'Bob',
        });
        f.workspace.db.exec('BEGIN');
        const tally = handle.commit();
        f.workspace.db.exec('COMMIT');
        await handle.finish();
        expect(tally).toBeDefined();
        expect(f.datasetRows('plugin:datasync').map((row) => row.ownerUserId)).toEqual([
            'ws:workspace',
            'ws:workspace',
        ]);
        expect(f.workspace.db.prepare('SELECT ownerUserId FROM data_grants WHERE datasetId=?').get(marts.id)).toEqual({
            ownerUserId: 'ws:workspace',
        });
        expect(f.platform.data.ownedData('alice')).toMatchObject({ count: 0 });
        // The plugin still writes it.
        expect(
            (await api('/data/datasets/marts/tables/daily/rows', 'POST', { rows: [{ day: 'after', total: 1 }] }))
                .status,
        ).toBe(200);
    });
});

describe('the runner', () => {
    it('stops a batch past its time limit and rolls everything in it back', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'socio-batch-timeout-'));
        const runner = new QueryRunner();
        cleanup.push(() => {
            runner.close();
            rmSync(dir, { recursive: true, force: true });
        });
        const engine = new DatasetEngine(runner);
        const path = join(dir, 'd.sqlite');
        engine.create(path);
        engine.createTable(path, { table: 'big', columns: [{ name: 'x', type: 'INTEGER' }] }, 1 << 24);
        engine.insert(
            path,
            'big',
            Array.from({ length: 1000 }, (_, x) => ({ x })),
            1 << 24,
        );
        const runs = [
            batchRuns({ sql: 'INSERT INTO big (x) VALUES (-1)' }, { allowDelete: true, insertMaxRows: 1000 }),
            // A billion rows to count: far past the limit.
            batchRuns(
                { sql: 'INSERT INTO big (x) SELECT count(*) FROM big a, big b, big c' },
                { allowDelete: true, insertMaxRows: 1000 },
            ),
        ];
        const started = Date.now();
        await expect(
            engine.batch(path, runs, 1 << 24, { writer: 'plugin:test', allowDelete: true, timeoutMs: 300 }),
        ).rejects.toMatchObject({ status: 504 });
        expect(Date.now() - started).toBeLessThan(10_000);
        // Nothing of it kept, and the file reads and writes again at once.
        const count = await engine.query(path, 'SELECT count(*), min(x) FROM big', [], {
            maxRows: 10,
            maxBytes: 65536,
            timeoutMs: 5000,
        });
        expect(count.rows).toEqual([[1000, 0]]);
        expect(engine.insert(path, 'big', [{ x: 5000 }], 1 << 24)).toMatchObject({ changes: 1 });
    });
});

describe('row history (CB-369 Phase H)', () => {
    it('validates declared tables in a manifest', () => {
        const parsed = parseManifest(
            manifest('datasync', [
                { name: 'marts', tables: [{ table: 'daily', columns: [{ name: 'day' }], history: false }] },
            ]),
            'catalog',
        );
        expect(parsed.datasets?.[0]?.tables).toEqual([{ table: 'daily', columns: [{ name: 'day' }], history: false }]);
        for (const [tables, message] of [
            [[{ table: 'has space', columns: [{ name: 'a' }] }], /use letters, digits/],
            [[{ table: 'a', columns: [] }], /columns must be a list of 1 to 100/],
            [[{ table: 'a', columns: [{ name: 'b', type: 'VARCHAR' }] }], /the type is one of/],
            [[{ table: 'a', columns: [{ name: 'b', extra: 1 }] }], /field extra is not allowed/],
            [[{ table: 'a', columns: [{ name: 'b' }], history: 'no' }], /history is true or false/],
            [
                [
                    { table: 'a', columns: [{ name: 'b' }] },
                    { table: 'A', columns: [{ name: 'b' }] },
                ],
                /listed twice/,
            ],
            [Array.from({ length: 33 }, (_, i) => ({ table: `t${i}`, columns: [{ name: 'b' }] })), /at most 32/],
        ] as const) {
            expect(() =>
                parseManifest(manifest('datasync', [{ name: 'marts', tables }] as unknown as unknown[]), 'catalog'),
            ).toThrow(message);
        }
    });

    it('makes declared tables on install, mart without history, and lets the plugin switch history', async () => {
        const f = await world();
        await f.platform.plugins.install('tabled');
        const issued = await f.exchange(f.delivered('tabled')!, f.proof('tabled'));
        expect(issued.status).toBe(200);
        const api = f.withToken(issued.body.token);
        const described = await api('/data/datasets/marts');
        const tables = described.body.tables as Array<{ name: string; history: boolean }>;
        expect(tables.map((table) => [table.name, table.history])).toEqual([
            ['daily', false],
            ['facts', true],
        ]);
        expect((await api('/data/datasets/marts/tables/facts', 'PATCH', { history: false })).status).toBe(200);
        expect((await api('/data/datasets/marts/tables/facts', 'PATCH', { history: 'no' })).status).toBe(400);
        const again = (await api('/data/datasets/marts')).body.tables as Array<{ name: string; history: boolean }>;
        expect(again.find((table) => table.name === 'facts')?.history).toBe(false);
        // Enabling again leaves the tables as they are.
        await f.platform.plugins.setEnabled('tabled', false);
        await f.platform.plugins.setEnabled('tabled', true);
        const id = issued.body.datasets[0]!.id;
        const admin = await f.as('alice');
        const detail = await admin(`/data/datasets/${id}`);
        expect((detail.body.tables as unknown[]).length).toBe(2);
        // The admin manages it: history days and Compact file.
        expect((await admin(`/data/datasets/${id}`, 'PATCH', { historyDays: 30 })).body).toMatchObject({
            historyDays: 30,
        });
        expect((await admin(`/data/datasets/${id}/compact`, 'POST', {})).body).toMatchObject({
            compactRequestedAt: expect.any(Number),
        });
        expect((await admin(`/data/datasets/${id}/tables/daily`, 'PATCH', { history: true })).status).toBe(200);
        // A plugin token can't ask for a compaction: the app does. (Its old
        // token ended when it was disabled.)
        expect((await api(`/data/datasets/${id}/compact`, 'POST', {})).status).toBe(401);
        const fresh = f.withToken((await f.exchange(f.delivered('tabled')!, f.proof('tabled'))).body.token);
        expect((await fresh(`/data/datasets/${id}/compact`, 'POST', {})).status).toBe(403);
    });
});

describe('analytical tables (CB-369 Phase 1)', () => {
    const occupancy = {
        table: 'occupancy',
        kind: 'analytical',
        columns: [
            { name: 'event_day', type: 'DATE', notNull: true },
            { name: 'space_id', type: 'TEXT', notNull: true },
            { name: 'people', type: 'INTEGER' },
            { name: 'recorded_at', type: 'TIMESTAMP', notNull: true },
            { name: 'amount', type: 'DECIMAL(10,2)' },
            { name: 'payload', type: 'JSON' },
        ],
        partitionBy: { column: 'event_day', grain: 'day' },
    };
    const ndjson = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
    /** `POST …/append` with a raw body, as a plugin sends NDJSON. */
    const append = async (
        f: Awaited<ReturnType<typeof world>>,
        token: string,
        table: string,
        body: string,
        headers: Record<string, string> = {},
    ) => {
        const response = await f.http.request(
            `http://company-brain-app:4310/api/data/datasets/stripe/tables/${table}/append`,
            {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson', ...headers },
                body,
            },
        );
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    it('declares, appends idempotently, and joins both kinds of table in one DuckDB query', async () => {
        const f = await world();
        const { api, token, datasets } = await f.datasync();
        expect((await api('/data/datasets/stripe/tables', 'POST', occupancy)).body).toMatchObject({
            status: 'done',
            result: { created: true, kind: 'analytical' },
        });
        // The same declaration again is a no-op; another is refused, naming the difference.
        expect(
            (await api('/data/datasets/stripe/tables', 'POST', { ...occupancy, ifNotExists: true })).body,
        ).toMatchObject({ result: { created: false } });
        const differs = await api('/data/datasets/stripe/tables', 'POST', {
            ...occupancy,
            ifNotExists: true,
            partitionBy: { column: 'event_day', grain: 'month' },
        });
        expect(differs.status).toBe(409);
        expect(String(differs.body.error)).toMatch(/partitioned by event_day \(day\)/);
        // So is another retention (CB-387).
        const retained = await api('/data/datasets/stripe/tables', 'POST', {
            ...occupancy,
            ifNotExists: true,
            retainDays: 1,
        });
        expect(retained.status).toBe(409);
        expect(String(retained.body.error)).toMatch(/keeps partitions until dropped/);
        // A transactional table of the same name is refused.
        expect(
            (await api('/data/datasets/stripe/tables', 'POST', { table: 'occupancy', columns: [{ name: 'a' }] }))
                .status,
        ).toBe(409);
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'spaces',
            columns: [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'label', type: 'TEXT' },
            ],
        });
        await api('/data/datasets/stripe/tables/spaces/rows', 'POST', {
            rows: [
                { id: 's1', label: 'Studio' },
                { id: 's2', label: 'Hall' },
            ],
        });
        const rows = [
            ...Array.from({ length: 30 }, (_, i) => ({
                event_day: '2026-11-09',
                space_id: i % 2 ? 's1' : 's2',
                people: i,
                recorded_at: '2026-11-09T10:00:00Z',
                amount: '1.25',
                payload: { i },
            })),
            { event_day: '2026-11-10', space_id: 's1', people: 5, recorded_at: 1_762_776_000_000 },
        ];
        const first = await append(f, token, 'occupancy', ndjson(rows), { 'x-cb-append-id': 'day:2026-11-10' });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ status: 'done', table: 'occupancy', rows: 31, parts: 2 });
        const again = await append(f, token, 'occupancy', ndjson(rows), { 'x-cb-append-id': 'day:2026-11-10' });
        expect(again.body).toMatchObject({ rows: 31, parts: 2, duplicate: true });
        const query = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT s.label, count(*) AS n, sum(o.people) AS people, sum(o.amount) AS amount FROM occupancy o JOIN spaces s ON s.id = o.space_id WHERE o.event_day >= ? GROUP BY s.label ORDER BY s.label',
            params: ['2026-11-01'],
        });
        expect(query.status).toBe(200);
        expect(query.body.columns).toEqual(['label', 'n', 'people', 'amount']);
        // DECIMAL sums come back exact, as text.
        expect(query.body.rows).toEqual([
            ['Hall', 15, 210, '18.75'],
            ['Studio', 16, 230, '18.75'],
        ]);
        const exact = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT 9007199254740993.01::DECIMAL(20,2) AS d, 9007199254740993::HUGEINT AS h',
        });
        expect(exact.body.rows).toEqual([['9007199254740993.01', '9007199254740993']]);
        // Nested ones too: a struct's decimal, a list of decimals.
        const nested = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: "SELECT {'v': 9007199254740993.01::DECIMAL(20,2)} AS s, [1.25::DECIMAL(10,2), 2.50::DECIMAL(10,2)] AS l, [1, 2] AS n",
        });
        expect(nested.body.rows).toEqual([['{"v":"9007199254740993.01"}', '["1.25","2.50"]', '[1,2]']]);
        // Dates and timestamps come back as ISO strings.
        const typed = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: "SELECT event_day, recorded_at FROM occupancy WHERE event_day = DATE '2026-11-10'",
        });
        expect(typed.body.rows).toEqual([['2026-11-10', '2025-11-10T12:00:00.000Z']]);
        // The SQLite route points at the analytical one.
        const sqlite = await api('/data/datasets/stripe/query', 'POST', { sql: 'SELECT * FROM occupancy' });
        expect(sqlite.status).toBe(400);
        expect(String(sqlite.body.error)).toMatch(/analytical table: query it with POST/);
        // describe shows both kinds, with the analytical table's partitions.
        const described = (await api('/data/datasets/stripe')).body.tables as Array<Record<string, unknown>>;
        expect(described.find((table) => table.name === 'occupancy')).toMatchObject({
            kind: 'analytical',
            rowCount: 31,
            analytical: { parts: 2, partitions: 2, firstPartition: '2026-11-09', lastPartition: '2026-11-10' },
        });
        // An admin reads it on the Data page; a member sees nothing of it.
        const admin = await f.as('alice');
        const id = datasets.find((item) => item.name === 'stripe')!.id;
        const page = await admin(`/data/datasets/${id}/analytics/query`, 'POST', {
            sql: 'SELECT count(*) AS n FROM occupancy',
        });
        expect(page.body.rows).toEqual([[31]]);
        const detail = await admin(`/data/datasets/${id}`);
        expect((detail.body.dataset as { analyticalBytes: number }).analyticalBytes).toBeGreaterThan(0);
        const actions = f.workspace.db
            .prepare(
                "SELECT action, outcome, actorKind FROM data_audit WHERE datasetId=? AND action IN ('append', 'analytics_query') ORDER BY createdAt",
            )
            .all(id)
            .map((row) => `${row.action}:${row.outcome}:${row.actorKind}`);
        expect(actions).toContain('append:ok:plugin');
        expect(actions).toContain('analytics_query:ok:user');
        // A dataset file restored without its parts directory: health names the parts.
        const path = f.platform.data.datasetPath({ id, ownerUserId: 'ws:workspace' });
        rmSync(path.replace(/\.sqlite$/, '.parts'), { recursive: true, force: true });
        expect(f.platform.data.missingDatasetFiles()).toMatchObject({ missingParts: 2, partDatasetIds: [id] });
    });

    it('checks every row against the declaration and keeps nothing of a refused append', async () => {
        const f = await world();
        const { api, token } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const good = { event_day: '2026-11-09', space_id: 's1', recorded_at: '2026-11-09T10:00:00Z' };
        for (const [row, message] of [
            [{ ...good, event_day: '11/09/2026' }, /event_day must be a date/],
            [{ ...good, space_id: null }, /space_id is NOT NULL/],
            [{ ...good, people: 1.5 }, /people must be a 64-bit whole number/],
            [{ ...good, recorded_at: 'yesterday' }, /recorded_at must be a timestamp/],
            [{ ...good, recorded_at: '2026-02-30T10:00:00Z' }, /recorded_at must be a timestamp/],
            [{ ...good, recorded_at: '2026-11-09T24:30:00Z' }, /recorded_at must be a timestamp/],
            [{ ...good, extra: 1 }, /"extra" is not a column/],
        ] as const) {
            const refused = await append(f, token, 'occupancy', ndjson([good, row]));
            expect(refused.status).toBe(400);
            expect(String(refused.body.error)).toMatch(message);
        }
        expect((await append(f, token, 'occupancy', 'not json')).status).toBe(400);
        const count = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT count(*) FROM occupancy',
        });
        expect(count.body.rows).toEqual([[0]]);
    });

    it('copies rows whatever their row ids, the smallest signed 64-bit one included', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'raw',
            columns: [
                { name: 'n', type: 'INTEGER', primaryKey: true },
                { name: 'event_day', type: 'TEXT' },
                { name: 'city', type: 'TEXT' },
                { name: 'amount', type: 'NUMERIC' },
                { name: 'x', type: 'INTEGER' },
            ],
        });
        const inserted = await api('/data/datasets/stripe/batch', 'POST', {
            statements: [
                {
                    sql: "INSERT INTO raw (n, event_day, city, amount, x) VALUES (-9223372036854775808, '2026-10-01', 'Zürich', 9007199254740993, 1), (-5000000000000000000, '2026-10-01', 'Oslo', 1, 2.5), (1, '2026-10-02', 'Oslo', 2, 10)",
                },
            ],
        });
        expect(inserted.status).toBe(200);
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'days',
            kind: 'analytical',
            columns: [{ name: 'event_day', type: 'DATE', notNull: true }],
            partitionBy: { column: 'event_day', grain: 'day' },
        });
        const copied = await api('/data/datasets/stripe/tables/days/append-from', 'POST', { from: 'raw' });
        expect(copied.status).toBe(200);
        expect(copied.body).toMatchObject({ rows: 3 });
        // Bounds of any text make a valid append id.
        const zurich = await api('/data/datasets/stripe/tables/days/append-from', 'POST', {
            from: 'raw',
            where: { column: 'city', from: 'Zürich', to: `Zürich${'~'.repeat(94)}` },
        });
        expect(zurich.status).toBe(200);
        expect(zurich.body).toMatchObject({ rows: 1 });
        // A NUMERIC column of whole numbers joins exactly, past 2^53.
        const exact = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT amount, amount = 9007199254740992 AS rounded FROM raw WHERE n < -6000000000000000000',
        });
        expect(exact.body.rows).toEqual([['9007199254740993', false]]);
        // Whole and fractional numbers copy into a REAL column.
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'amounts',
            kind: 'analytical',
            columns: [
                { name: 'event_day', type: 'DATE', notNull: true },
                { name: 'x', type: 'REAL' },
            ],
            partitionBy: { column: 'event_day', grain: 'day' },
        });
        const reals = await api('/data/datasets/stripe/tables/amounts/append-from', 'POST', { from: 'raw' });
        expect(reals.status).toBe(200);
        const summed = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT sum(x) FROM amounts',
        });
        expect(summed.body.rows).toEqual([[13.5]]);
        // A BOOLEAN column (0 and 1 in SQLite) sums.
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'flags',
            columns: [{ name: 'enabled', type: 'BOOLEAN' }],
        });
        await api('/data/datasets/stripe/batch', 'POST', {
            statements: [{ sql: 'INSERT INTO flags (enabled) VALUES (0), (1), (1)' }],
        });
        const flags = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT sum(enabled) FROM flags',
        });
        expect(flags.body.rows).toEqual([[2]]);
        // An INTEGER column holding a fraction (SQLite allows it) stays a number.
        const numeric = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT max(x) AS top, sum(x) AS total, list(x ORDER BY x) AS ordered FROM raw',
        });
        expect(numeric.body.rows).toEqual([[10, 13.5, '[1,2.5,10]']]);
        // One past 2^53 beside fractions has no exact DuckDB number: refused.
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'mixed',
            columns: [{ name: 'v', type: 'NUMERIC' }],
        });
        await api('/data/datasets/stripe/batch', 'POST', {
            statements: [{ sql: 'INSERT INTO mixed (v) VALUES (9007199254740993), (0.5)' }],
        });
        // A REAL beyond 64-bit integers, either way, loads as a DOUBLE.
        await api('/data/datasets/stripe/tables', 'POST', { table: 'samples', columns: [{ name: 'x', type: 'REAL' }] });
        await api('/data/datasets/stripe/batch', 'POST', {
            statements: [{ sql: 'INSERT INTO samples (x) VALUES (1e20), (-1e20), (3)' }],
        });
        const samples = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT min(x), max(x) FROM samples',
        });
        expect(samples.body.rows).toEqual([[-1e20, 1e20]]);
        const mixed = await api('/data/datasets/stripe/analytics/query', 'POST', { sql: 'SELECT * FROM mixed' });
        expect(mixed.status).toBe(400);
        expect(String(mixed.body.error)).toMatch(/past 2\^53 with fractions/);
        // A wide answer streams, stopping at the byte cap.
        const wide = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: "SELECT repeat('x', 100000) AS v FROM range(5000)",
        });
        expect(wide.status).toBe(200);
        expect(wide.body.truncated).toBe(true);
        expect((wide.body.rows as unknown[]).length).toBeLessThan(100);
    });

    it('copies a transactional table across, adds a column, and refuses anything but one SELECT', async () => {
        const f = await world();
        const { api, token } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'history_sqlite',
            columns: [
                { name: 'event_day', type: 'TEXT' },
                { name: 'space_id', type: 'TEXT' },
                { name: 'people', type: 'INTEGER' },
                { name: 'recorded_at', type: 'TEXT' },
            ],
        });
        const rows = Array.from({ length: 900 }, (_, i) => ({
            event_day: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
            space_id: `s${i % 3}`,
            people: i,
            recorded_at: '2026-10-01T00:00:00Z',
        }));
        await api('/data/datasets/stripe/tables/history_sqlite/rows', 'POST', { rows });
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const copied = await api('/data/datasets/stripe/tables/occupancy/append-from', 'POST', {
            from: 'history_sqlite',
            where: { column: 'event_day', from: '2026-10-01', to: '2026-10-14' },
        });
        expect(copied.status).toBe(200);
        expect(copied.body).toMatchObject({ table: 'occupancy', parts: 14 });
        const copiedRows = Number(copied.body.rows);
        expect(
            (
                await api('/data/datasets/stripe/tables/occupancy/append-from', 'POST', {
                    from: 'history_sqlite',
                    where: { column: 'event_day', from: '2026-10-01', to: '2026-10-14' },
                })
            ).body,
        ).toMatchObject({ duplicate: true, rows: copiedRows });
        // A nullable column: older parts read it as null.
        expect(
            (
                await api('/data/datasets/stripe/tables/occupancy/columns', 'POST', {
                    column: { name: 'note', type: 'TEXT' },
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await api('/data/datasets/stripe/tables/occupancy/columns', 'POST', {
                    column: { name: 'n2', type: 'TEXT', notNull: true },
                })
            ).status,
        ).toBe(400);
        await append(
            f,
            token,
            'occupancy',
            ndjson([{ event_day: '2026-11-01', space_id: 's9', recorded_at: 0, note: 'new' }]),
        );
        const notes = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT count(*) FILTER (WHERE note IS NULL) AS old, count(note) AS new FROM occupancy',
        });
        expect(notes.body.rows).toEqual([[copiedRows, 1]]);
        for (const sql of [
            "COPY occupancy TO '/tmp/x.parquet'",
            'SELECT 1; SELECT 2',
            "ATTACH '/tmp/x.db'",
            'PRAGMA version',
            "SET allowed_paths=['/']",
            "SELECT * FROM read_csv('/etc/passwd')",
            "SELECT * FROM read_parquet('/etc/passwd')",
            'SELECT * FROM "_olap_parts"',
        ]) {
            const refused = await api('/data/datasets/stripe/analytics/query', 'POST', { sql });
            expect(refused.status, sql).toBeGreaterThanOrEqual(400);
        }
    });

    it('keeps analytical tables to plugins’ own datasets and holds appends to the owner’s budget', async () => {
        const f = await world({ analyticalMaxBytes: 2_000 });
        const { api, token, datasets } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const big = Array.from({ length: 2_000 }, (_, i) => ({
            event_day: '2026-11-09',
            space_id: `space-${i}-${'x'.repeat(40)}`,
            recorded_at: i,
        }));
        const refused = await append(f, token, 'occupancy', ndjson(big));
        expect(refused.status).toBe(413);
        expect(String(refused.body.error)).toMatch(/analytical budget is full/);
        // A person's scratch, or a socio's grant, never gets one in Phase 1.
        const admin = await f.as('alice');
        const id = datasets.find((item) => item.name === 'stripe')!.id;
        const member = await f.as('bob');
        expect((await member(`/data/datasets/${id}/analytics/query`, 'POST', { sql: 'SELECT 1' })).status).toBe(404);
        expect((await admin(`/data/datasets/${id}/analytics/query`, 'POST', { sql: 'SELECT 1' })).status).toBe(200);
        // Nothing is left in staging.
        expect(f.platform.data.sweepAnalytical(Date.now() + 2 * 3_600_000)).toBe(0);
        expect(f.platform.data.missingDatasetFiles().missingParts).toBeUndefined();
    });
    it('commits inside a write transaction on the app database, which every runtime shares', async () => {
        const f = await world();
        const { api, token } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const space = f.platform.data as unknown as {
            db: DatabaseSync;
            engine: { commitParts: (...args: unknown[]) => unknown };
        };
        const commit = space.engine.commitParts.bind(space.engine);
        const held: boolean[] = [];
        space.engine.commitParts = (...args: unknown[]) => {
            held.push(space.db.isTransaction);
            return commit(...args);
        };
        const row = { event_day: '2026-11-09', space_id: 's1', recorded_at: 1 };
        expect((await append(f, token, 'occupancy', ndjson([row]))).status).toBe(200);
        expect(held).toEqual([true]);
    });

    it('refuses the commit when the dataset is deleted while its parts stage', async () => {
        const f = await world();
        const { api, token, datasets } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const id = datasets.find((item) => item.name === 'stripe')!.id;
        const space = f.platform.data as unknown as {
            analytics: { run: (...args: unknown[]) => Promise<unknown> };
            deleteDataset: (userId: string, id: string) => void;
            sweepAnalytical: (now: number) => number;
        };
        const run = space.analytics.run.bind(space.analytics);
        space.analytics.run = async (...args: unknown[]) => {
            const answer = await run(...args);
            space.deleteDataset('alice', id);
            return answer;
        };
        const row = { event_day: '2026-11-09', space_id: 's1', recorded_at: 1 };
        const refused = await append(f, token, 'occupancy', ndjson([row]));
        expect(refused.status).toBe(404);
        // Nothing committed, nothing left staged.
        expect(space.sweepAnalytical(Date.now() + 2 * 3_600_000)).toBe(0);
    });

    it('never leaves a refused body behind, and takes no body once the rate is spent', async () => {
        const f = await world({ pluginStatementsPerMinute: 40 });
        const { api, token } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', occupancy);
        const bad = await append(f, token, 'occupancy', ndjson([{ event_day: 'not a day', space_id: 's1' }]));
        expect(bad.status).toBe(400);
        const statuses: number[] = [];
        for (let i = 0; i < 45 && !statuses.includes(429); i++) {
            statuses.push((await append(f, token, 'nope', ndjson([{ a: 1 }]))).status);
        }
        expect(statuses).toContain(429);
        // Nothing is left in staging for the sweep to find.
        expect(f.platform.data.sweepAnalytical(Date.now() + 2 * 3_600_000)).toBe(0);
    });

    it('reads a WITH name as its CTE, and counts answer bytes as UTF-8', async () => {
        const f = await world({ analyticsJoinMaxRows: 1, analyticsQueryMaxBytes: 100 });
        const { api } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'spaces',
            columns: [{ name: 'id', type: 'TEXT', primaryKey: true }],
        });
        await api('/data/datasets/stripe/tables/spaces/rows', 'POST', { rows: [{ id: 's1' }, { id: 's2' }] });
        // The stored table is over the join cap; the CTE of its name is not it.
        const shadowed = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'WITH spaces AS (SELECT 42 AS x) SELECT * FROM spaces',
        });
        expect(shadowed.status).toBe(200);
        expect(shadowed.body.rows).toEqual([[42]]);
        // Named inside a CTE's definition, the stored table still counts.
        const inner = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'WITH s AS (SELECT * FROM spaces) SELECT count(*) FROM s',
        });
        expect(inner.status).toBe(413);
        // A plain CTE that names itself reads the stored table, as DuckDB binds it.
        const selfNamed = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'WITH spaces AS (SELECT * FROM spaces) SELECT count(*) FROM spaces',
        });
        expect(selfNamed.status).toBe(413);
        // A recursive one is itself.
        const recursive = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'WITH RECURSIVE spaces(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM spaces WHERE i < 3) SELECT count(*) FROM spaces',
        });
        expect(recursive.status).toBe(200);
        expect(recursive.body.rows).toEqual([[3]]);
        // A table named in a string (CB-387) is read, so it counts too.
        for (const sql of [
            "SELECT * FROM query_table('spaces')",
            "SELECT * FROM query_table(['spaces'], true)",
            "SELECT * FROM query('SELECT * FROM spaces')",
            "WITH s AS (SELECT 1) SELECT * FROM query('SELECT * FROM spaces')",
        ]) {
            const indirect = await api('/data/datasets/stripe/analytics/query', 'POST', { sql });
            expect(indirect.status).toBe(413);
        }
        // ...unless a CTE of its name is in scope, as DuckDB binds it.
        for (const sql of [
            "WITH spaces AS (SELECT 42 AS x) SELECT * FROM query('SELECT * FROM spaces')",
            "WITH spaces AS (SELECT 42 AS x) SELECT * FROM query_table('spaces')",
            'WITH spaces AS (SELECT 42 AS x) SELECT * FROM query_table(\'"spaces"\')',
            "WITH spaces AS (SELECT 42 AS x) SELECT * FROM query_table('main.spaces')",
            "WITH spaces AS (SELECT 42 AS x) SELECT * FROM query('SELECT * FROM query_table(''spaces'')')",
        ]) {
            const shadowed = await api('/data/datasets/stripe/analytics/query', 'POST', { sql });
            expect(shadowed.status, sql).toBe(200);
            expect(shadowed.body.rows).toEqual([[42]]);
        }
        // Its anchor reads the stored table of its name.
        const anchored = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'WITH RECURSIVE spaces(i) AS (SELECT id FROM spaces UNION ALL SELECT i FROM spaces WHERE false) SELECT count(*) FROM spaces',
        });
        expect(anchored.status).toBe(413);
        // 80 three-byte characters are 240 bytes, past a 100-byte answer.
        const wide = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: "SELECT repeat('界', 80) AS v",
        });
        expect(wide.status).toBe(200);
        expect(wide.body).toMatchObject({ rows: [], truncated: true });
    });
});

describe('query_table() and query() in analytical queries (CB-387)', () => {
    it('reads the tables they name, both kinds, and holds query() to one SELECT', async () => {
        const f = await world();
        const { api, token } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'events',
            kind: 'analytical',
            columns: [
                { name: 'day', type: 'DATE', notNull: true },
                { name: 'space_id', type: 'TEXT' },
            ],
            partitionBy: { column: 'day', grain: 'day' },
        });
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'spaces',
            columns: [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'label', type: 'TEXT' },
            ],
        });
        await api('/data/datasets/stripe/tables/spaces/rows', 'POST', {
            rows: [
                { id: 's1', label: 'Studio' },
                { id: 's2', label: 'Hall' },
            ],
        });
        const appended = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/stripe/tables/events/append',
            {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' },
                body: ['s1', 's1', 's2'].map((id) => JSON.stringify({ day: '2026-11-10', space_id: id })).join('\n'),
            },
        );
        expect(appended.status).toBe(200);
        const run = (sql: string) => api('/data/datasets/stripe/analytics/query', 'POST', { sql });
        expect((await run("SELECT count(*) AS n FROM query_table('events')")).body.rows).toEqual([[3]]);
        expect((await run("SELECT count(*) AS n FROM query_table('SPACES')")).body.rows).toEqual([[2]]);
        expect(
            (
                await run(
                    "SELECT s.label, count(*) AS n FROM query('SELECT * FROM events') e JOIN query_table('spaces') s ON s.id = e.space_id GROUP BY s.label ORDER BY s.label",
                )
            ).body.rows,
        ).toEqual([
            ['Hall', 1],
            ['Studio', 2],
        ]);
        expect(
            (await run("SELECT * FROM query('SELECT count(*) FROM query(''SELECT * FROM events'')')")).body.rows,
        ).toEqual([[3]]);
        for (const [sql, status, message] of [
            [
                "SELECT * FROM query('COPY spaces TO ''/tmp/x.csv''')",
                403,
                /Only one read-only SELECT .*in query\(\) too/,
            ],
            ["SELECT * FROM query('SELECT 1; SELECT 2')", 403, /one statement at a time, in query\(\) too/],
            ["SELECT * FROM query('SELEC 1')", 400, /doesn't parse: query\(\) inside it/],
            ["SELECT * FROM query_table(concat('ev', 'ents'))", 400, /constant strings/],
            ["SELECT * FROM query_table(['events', lower('X')])", 400, /constant strings/],
            ["SELECT * FROM query(concat('SELECT 1', ''))", 400, /one constant string/],
            [
                "SELECT * FROM query('SELECT * FROM query(''SELECT * FROM query(''''SELECT * FROM query(''''''''SELECT 1'''''''')'''')'')')",
                400,
                /nests at most 3 deep/,
            ],
        ] as const) {
            const refused = await run(sql);
            expect(refused.status, sql).toBe(status);
            expect(String(refused.body.error), sql).toMatch(message);
        }
        const params = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT * FROM query_table(?)',
            params: ['events'],
        });
        expect(params.status).toBe(400);
        expect(String(params.body.error)).toMatch(/constant strings/);
    });
});

/**
 * CB-369: every analytical column type against every input it can meet, on
 * every path in: a JSON body (`append`), a SQLite cell (`append-from`), and a
 * transactional column read into DuckDB. Each cell reads back exactly, or is
 * refused with a message naming the column; nothing is silently changed.
 */
describe('analytical type fidelity (CB-369)', () => {
    const TYPES = ['TEXT', 'JSON', 'INTEGER', 'REAL', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'DECIMAL(20,4)'] as const;
    /** Refused, with `Row 1: v must be …`. */
    const R = Symbol('refused');
    type Cell = unknown;
    type Row = [label: string, input: string, expected: [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell]];
    const tableOf = (type: string) => `t_${type.replace(/\W+/g, '_').toLowerCase().replace(/_$/, '')}`;
    type Api = (
        path: string,
        method?: string,
        body?: unknown,
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
    const declare = async (api: Api) => {
        for (const type of TYPES) {
            const made = await api('/data/datasets/stripe/tables', 'POST', {
                table: tableOf(type),
                kind: 'analytical',
                columns: [
                    { name: 'd', type: 'DATE', notNull: true },
                    { name: 'k', type: 'TEXT', notNull: true },
                    { name: 'v', type },
                ],
                partitionBy: { column: 'd', grain: 'day' },
            });
            expect(made.status).toBe(200);
        }
    };
    const readBack = async (api: Api, type: string, k: string) => {
        const answer = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: `SELECT v FROM ${tableOf(type)} WHERE k = ?`,
            params: [k],
        });
        expect(answer.status).toBe(200);
        return (answer.body.rows as unknown[][])[0]![0];
    };
    /** Each row's outcome per type, as `expected` writes it. */
    const outcomes = async (
        api: Api,
        rows: Row[],
        send: (
            type: string,
            label: string,
            input: string,
        ) => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
        const got: Record<string, Cell[]> = {};
        const want: Record<string, Cell[]> = {};
        for (const [label, input, expected] of rows) {
            got[label] = [];
            want[label] = expected.map((cell) => (cell === R ? 'refused' : cell));
            for (const type of TYPES) {
                const sent = await send(type, label, input);
                if (sent.status === 200) {
                    got[label]!.push(await readBack(api, type, label));
                } else {
                    expect(sent.status, `${label} → ${type}`).toBe(400);
                    expect(String(sent.body.error), `${label} → ${type}`).toMatch(/^Row 1: v (must be|is)/);
                    got[label]!.push('refused');
                }
            }
        }
        expect(got).toEqual(want);
    };
    const T0 = '1970-01-01T00:00:00.000Z';

    it('takes each JSON value of an append body exactly, or refuses it', async () => {
        const f = await world({ pluginStatementsPerMinute: 100_000 });
        const { api, token } = await f.datasync();
        await declare(api);
        // Inputs are JSON source text, so a literal like 9007199254740993 arrives as written.
        // Expected per column: TEXT, JSON, INTEGER, REAL, BOOLEAN, DATE, TIMESTAMP, DECIMAL(20,4).
        const rows: Row[] = [
            ['null', 'null', [null, null, null, null, null, null, null, null]],
            ['zero', '0', ['0', '0', 0, 0, false, R, T0, '0.0000']],
            ['negzero', '-0', ['0', '0', 0, 0, false, R, T0, '0.0000']],
            ['one', '1', ['1', '1', 1, 1, true, R, '1970-01-01T00:00:00.001Z', '1.0000']],
            ['neg', '-1', ['-1', '-1', -1, -1, R, R, '1969-12-31T23:59:59.999Z', '-1.0000']],
            [
                'safe',
                '9007199254740991',
                [
                    '9007199254740991',
                    '9007199254740991',
                    9007199254740991,
                    9007199254740991,
                    R,
                    R,
                    R,
                    '9007199254740991.0000',
                ],
            ],
            [
                'unsafe',
                '9007199254740993',
                [
                    '9007199254740993',
                    '9007199254740993',
                    '9007199254740993',
                    9007199254740992,
                    R,
                    R,
                    R,
                    '9007199254740993.0000',
                ],
            ],
            [
                'min64',
                '-9223372036854775808',
                [
                    '-9223372036854775808',
                    '-9223372036854775808',
                    '-9223372036854775808',
                    -9223372036854775808,
                    R,
                    R,
                    R,
                    R,
                ],
            ],
            [
                'over64',
                '9223372036854775808',
                ['9223372036854775808', '9223372036854775808', R, 9223372036854775808, R, R, R, R],
            ],
            ['half', '0.5', ['0.5', '0.5', R, 0.5, R, R, R, '0.5000']],
            ['huge', '1e308', ['1e308', '1e308', R, 1e308, R, R, R, R]],
            ['tiny', '5e-324', ['5e-324', '5e-324', R, 5e-324, R, R, R, R]],
            ['overflow', '1e400', [R, R, R, R, R, R, R, R]],
            // Fractions and exponents keep their digits where a type holds them.
            [
                'wide-frac',
                '1234567890123456.1234',
                [
                    '1234567890123456.1234',
                    '1234567890123456.1234',
                    R,
                    Number('1234567890123456.1234'),
                    R,
                    R,
                    R,
                    '1234567890123456.1234',
                ],
            ],
            ['near-one', '1.00000000000000001', ['1.00000000000000001', '1.00000000000000001', R, 1, R, R, R, R]],
            ['underflow', '1e-400', ['1e-400', '1e-400', R, 0, R, R, R, R]],
            ['one-point-zero', '1.0', ['1.0', '1.0', 1, 1, true, R, '1970-01-01T00:00:00.001Z', '1.0000']],
            ['exp', '1e3', ['1e3', '1e3', 1000, 1000, R, R, '1970-01-01T00:00:01.000Z', '1000.0000']],
            ['true', 'true', ['true', 'true', R, R, true, R, R, R]],
            ['false', 'false', ['false', 'false', R, R, false, R, R, R]],
            ['empty', '""', ['', R, R, R, R, R, R, R]],
            ['unicode', '"Zürich 界 😀"', ['Zürich 界 😀', R, R, R, R, R, R, R]],
            ['s-true', '"true"', ['true', 'true', R, R, R, R, R, R]],
            ['s-int', '"12"', ['12', '12', 12, 12, R, R, R, '12.0000']],
            [
                's-unsafe',
                '"9007199254740993"',
                [
                    '9007199254740993',
                    '9007199254740993',
                    '9007199254740993',
                    9007199254740992,
                    R,
                    R,
                    R,
                    '9007199254740993.0000',
                ],
            ],
            [
                's-over64',
                '"9223372036854775808"',
                ['9223372036854775808', '9223372036854775808', R, 9223372036854775808, R, R, R, R],
            ],
            ['s-real', '"1.5"', ['1.5', '1.5', R, 1.5, R, R, R, '1.5000']],
            ['s-exp', '"1e3"', ['1e3', '1e3', R, 1000, R, R, R, '1000.0000']],
            ['s-nan', '"NaN"', ['NaN', R, R, R, R, R, R, R]],
            ['s-inf', '"Infinity"', ['Infinity', R, R, R, R, R, R, R]],
            ['s-scale', '"1.23456"', ['1.23456', '1.23456', R, 1.23456, R, R, R, R]],
            [
                's-wide',
                '"12345678901234567"',
                ['12345678901234567', '12345678901234567', '12345678901234567', 12345678901234568, R, R, R, R],
            ],
            ['leap', '"2024-02-29"', ['2024-02-29', R, R, R, R, '2024-02-29', '2024-02-29T00:00:00.000Z', R]],
            ['not-leap', '"2023-02-29"', ['2023-02-29', R, R, R, R, R, R, R]],
            ['ts', '"2024-02-29T12:00:00Z"', ['2024-02-29T12:00:00Z', R, R, R, R, R, '2024-02-29T12:00:00.000Z', R]],
            ['ts-bad', '"2023-02-29T12:00:00Z"', ['2023-02-29T12:00:00Z', R, R, R, R, R, R, R]],
            ['ts-hour', '"2026-11-09T24:00:00Z"', ['2026-11-09T24:00:00Z', R, R, R, R, R, R, R]],
            [
                'ts-zone',
                '"2026-11-09T10:00:00+02:00"',
                ['2026-11-09T10:00:00+02:00', R, R, R, R, R, '2026-11-09T08:00:00.000Z', R],
            ],
            ['ts-space', '"2026-11-09 10:00"', ['2026-11-09 10:00', R, R, R, R, R, '2026-11-09T10:00:00.000Z', R]],
            // TIMESTAMP keeps milliseconds.
            [
                'ts-nanos',
                '"2026-11-09T10:00:00.123456789Z"',
                ['2026-11-09T10:00:00.123456789Z', R, R, R, R, R, '2026-11-09T10:00:00.123Z', R],
            ],
            ['ts-year0', '"0000-12-31T00:00:00Z"', ['0000-12-31T00:00:00Z', R, R, R, R, R, R, R]],
            ['object', '{"a":1}', [R, '{"a":1}', R, R, R, R, R, R]],
            ['array', '[1,2]', [R, '[1,2]', R, R, R, R, R, R]],
            ['nested-big', '{"n":9007199254740993}', [R, '{"n":9007199254740993}', R, R, R, R, R, R]],
            ['nested-frac', '{"n":1234567890123456.1234}', [R, '{"n":1234567890123456.1234}', R, R, R, R, R, R]],
        ];
        await outcomes(api, rows, async (type, label, input) => {
            const response = await f.http.request(
                `http://company-brain-app:4310/api/data/datasets/stripe/tables/${tableOf(type)}/append`,
                {
                    method: 'POST',
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' },
                    body: `{"d":"2026-11-09","k":${JSON.stringify(label)},"v":${input}}`,
                },
            );
            return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        });
        // A { "rows": [...] } body keeps its numbers' digits too.
        const body = await f.http.request(
            `http://company-brain-app:4310/api/data/datasets/stripe/tables/${tableOf('DECIMAL(20,4)')}/append`,
            {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: '{"rows":[{"d":"2026-11-09","k":"json-body","v":1234567890123456.1234}]}',
            },
        );
        expect(body.status).toBe(200);
        expect(await readBack(api, 'DECIMAL(20,4)', 'json-body')).toBe('1234567890123456.1234');
    }, 600_000);

    it('leaves an omitted column NULL whatever its name, and counts analytical tables', async () => {
        const f = await world();
        const { api, token } = await f.datasync();
        expect(
            (
                await api('/data/datasets/stripe/tables', 'POST', {
                    table: 'protos',
                    kind: 'analytical',
                    columns: [
                        { name: 'd', type: 'DATE', notNull: true },
                        { name: 'constructor', type: 'TEXT' },
                        { name: 'tostring', type: 'TEXT' },
                        { name: 'hasownproperty', type: 'INTEGER' },
                    ],
                    partitionBy: { column: 'd', grain: 'day' },
                })
            ).status,
        ).toBe(200);
        const response = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/stripe/tables/protos/append',
            {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' },
                body: '{"d":"2026-11-09"}',
            },
        );
        expect(response.status).toBe(200);
        const read = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT "constructor", tostring, hasownproperty FROM protos',
        });
        expect(read.body.rows).toEqual([[null, null, null]]);
        const listed = (await api('/data/datasets')).body as unknown as Array<{ name: string; tables: number }>;
        expect(listed.find((dataset) => dataset.name === 'stripe')?.tables).toBe(1);
    });

    it('copies each SQLite storage class exactly, or refuses it, and joins on what it copied', async () => {
        const f = await world({ pluginStatementsPerMinute: 100_000 });
        const { api } = await f.datasync();
        await declare(api);
        // A BLOB column has no affinity: each value keeps the storage class written.
        await api('/data/datasets/stripe/tables', 'POST', {
            table: 'src',
            columns: [
                { name: 'k', type: 'TEXT', primaryKey: true },
                { name: 'd', type: 'TEXT' },
                { name: 'v', type: 'BLOB' },
            ],
        });
        // Expected per column: TEXT, JSON, INTEGER, REAL, BOOLEAN, DATE, TIMESTAMP, DECIMAL(20,4).
        const rows: Row[] = [
            ['null', 'NULL', [null, null, null, null, null, null, null, null]],
            ['zero', '0', ['0', '0', 0, 0, false, R, T0, '0.0000']],
            ['one', '1', ['1', '1', 1, 1, true, R, '1970-01-01T00:00:00.001Z', '1.0000']],
            ['neg', '-1', ['-1', '-1', -1, -1, R, R, '1969-12-31T23:59:59.999Z', '-1.0000']],
            [
                'unsafe',
                '9007199254740993',
                [
                    '9007199254740993',
                    '9007199254740993',
                    '9007199254740993',
                    9007199254740992,
                    R,
                    R,
                    R,
                    '9007199254740993.0000',
                ],
            ],
            [
                'min64',
                '-9223372036854775808',
                [
                    '-9223372036854775808',
                    '-9223372036854775808',
                    '-9223372036854775808',
                    -9223372036854775808,
                    R,
                    R,
                    R,
                    R,
                ],
            ],
            [
                'max64',
                '9223372036854775807',
                ['9223372036854775807', '9223372036854775807', '9223372036854775807', 2 ** 63, R, R, R, R],
            ],
            ['half', '0.5', ['0.5', '0.5', R, 0.5, R, R, R, '0.5000']],
            ['negzero', '-0.0', ['0', '0', 0, 0, false, R, T0, '0.0000']],
            ['huge', '1e308', ['1e+308', '1e+308', R, 1e308, R, R, R, R]],
            ['inf', '9e999', [R, R, R, R, R, R, R, R]],
            ['neginf', '-9e999', [R, R, R, R, R, R, R, R]],
            ['big-real', '1e20', ['100000000000000000000', '100000000000000000000', R, 1e20, R, R, R, R]],
            ['empty', "''", ['', R, R, R, R, R, R, R]],
            ['unicode', "'Zürich 界'", ['Zürich 界', R, R, R, R, R, R, R]],
            ['s-int', "'12'", ['12', '12', 12, 12, R, R, R, '12.0000']],
            ['s-true', "'true'", ['true', 'true', R, R, R, R, R, R]],
            ['leap', "'2024-02-29'", ['2024-02-29', R, R, R, R, '2024-02-29', '2024-02-29T00:00:00.000Z', R]],
            ['ts', "'2024-02-29T12:00:00Z'", ['2024-02-29T12:00:00Z', R, R, R, R, R, '2024-02-29T12:00:00.000Z', R]],
            ['s-json', `'{"a":1}'`, ['{"a":1}', '{"a":1}', R, R, R, R, R, R]],
            ['blob', "x'00ff'", [R, R, R, R, R, R, R, R]],
        ];
        const inserted = await api('/data/datasets/stripe/batch', 'POST', {
            statements: [
                {
                    sql: `INSERT INTO src (k, d, v) VALUES ${rows.map(([label, sql]) => `('${label}', '2026-11-09', ${sql})`).join(', ')}`,
                },
            ],
        });
        expect(inserted.status).toBe(200);
        await outcomes(api, rows, (type, label) =>
            api(`/data/datasets/stripe/tables/${tableOf(type)}/append-from`, 'POST', {
                from: 'src',
                where: { column: 'k', from: label, to: label },
            }),
        );
        // What it copied joins a transactional table exactly, past 2^53.
        await api('/data/datasets/stripe/tables', 'POST', { table: 'refs', columns: [{ name: 'v', type: 'INTEGER' }] });
        await api('/data/datasets/stripe/batch', 'POST', {
            statements: [
                { sql: 'INSERT INTO refs (v) VALUES (9007199254740993), (-9223372036854775808), (9007199254740992)' },
            ],
        });
        const joined = await api('/data/datasets/stripe/analytics/query', 'POST', {
            sql: 'SELECT a.k, a.v FROM t_integer a JOIN refs r ON r.v = a.v ORDER BY a.k',
        });
        expect(joined.body.rows).toEqual([
            ['min64', '-9223372036854775808'],
            ['unsafe', '9007199254740993'],
        ]);
    }, 600_000);

    it('reads each transactional column into DuckDB as SQLite answers it, or refuses it', async () => {
        const f = await world({ pluginStatementsPerMinute: 100_000 });
        const { api } = await f.datasync();
        // Columns of one storage class read back as SQLite answers them.
        const same: Array<[string, string, string[], string]> = [
            [
                'ints',
                'INTEGER',
                ['0', '-1', '9007199254740993', '-9223372036854775808', '9223372036854775807'],
                'BIGINT',
            ],
            ['reals', 'REAL', ['0.0', '-0.0', '1e308', '5e-324', '1e20', '-1e20', '3'], 'DOUBLE'],
            ['infs', 'REAL', ['9e999', '-9e999', '1'], 'DOUBLE'],
            ['texts', 'TEXT', ["''", "'Zürich 界'", "'123'", '7'], 'VARCHAR'],
            ['blobs', 'BLOB', ["x'00ff'", "x''"], 'BLOB'],
            ['text_blobs', 'TEXT', ["x'00ff'", 'NULL'], 'BLOB'],
            ['bools', 'BOOLEAN', ['0', '1', '1'], 'BIGINT'],
            ['reals_ints', 'NUMERIC', ['1', '2.5', '9007199254740991'], 'DOUBLE'],
            ['nulls', 'TEXT', ['NULL', 'NULL'], 'VARCHAR'],
        ];
        // Columns mixing storage classes read back as text (documented).
        const asText: Array<[string, string, string[], unknown[]]> = [
            ['nums', 'NUMERIC', ['1', '2.5', "'abc'"], ['1', '2.5', 'abc']],
            ['dts', 'DATETIME', ["'2024-02-29 12:00:00'", '1700000000'], ['2024-02-29 12:00:00', '1700000000']],
            ['anys', 'BLOB', ['1', "'x'", "x'00'"], ['1', 'x', 'AA==']],
        ];
        const make = async (name: string, type: string, values: string[]) => {
            await api('/data/datasets/stripe/tables', 'POST', { table: name, columns: [{ name: 'v', type }] });
            const inserted = await api('/data/datasets/stripe/batch', 'POST', {
                statements: [
                    { sql: `INSERT INTO ${name} (v) VALUES ${values.map((value) => `(${value})`).join(', ')}` },
                ],
            });
            expect(inserted.status).toBe(200);
        };
        const duck = (name: string) =>
            api('/data/datasets/stripe/analytics/query', 'POST', { sql: `SELECT v, typeof(v) FROM ${name}` });
        for (const [name, type, values, duckType] of same) {
            await make(name, type, values);
            const lite = await api('/data/datasets/stripe/query', 'POST', {
                sql: `SELECT v FROM ${name} ORDER BY rowid`,
            });
            const read = await duck(name);
            expect(read.status, name).toBe(200);
            expect(read.body.rows, name).toEqual((lite.body.rows as unknown[][]).map(([v]) => [v, duckType]));
        }
        for (const [name, type, values, text] of asText) {
            await make(name, type, values);
            const read = await duck(name);
            expect(read.body.rows, name).toEqual(text.map((v) => [v, 'VARCHAR']));
        }
        // An integer past 2^53 beside fractions has no exact DuckDB number.
        await make('mixbig', 'NUMERIC', ['9007199254740993', '0.5']);
        const refused = await duck('mixbig');
        expect(refused.status).toBe(400);
        expect(String(refused.body.error)).toMatch(/past 2\^53 with fractions/);
    }, 600_000);
});

describe('analytical tables a manifest declares (CB-387)', () => {
    const ndjson = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
    const day = (offset: number) => new Date(Date.UTC(2026, 10, 10) - offset * 86_400_000).toISOString().slice(0, 10);
    /** `PluginService`'s catalog, to offer a new version as a catalog refresh would. */
    const offer = (f: Awaited<ReturnType<typeof world>>, next: unknown) =>
        (f.platform.plugins as unknown as { catalog: Map<string, unknown> }).catalog.set(
            'history',
            parseManifest(next, 'catalog'),
        );

    it('validates kind, partitioning, analytical types and retention in a manifest', () => {
        const parsed = parseManifest(manifest('history', [{ name: 'history', tables: [HISTORY_TABLE] }]), 'catalog');
        expect(parsed.datasets?.[0]?.tables).toEqual([HISTORY_TABLE]);
        const table = (patch: Record<string, unknown>) => [{ ...HISTORY_TABLE, ...patch }];
        for (const [tables, message] of [
            [table({ kind: 'olap' }), /kind is transactional or analytical/],
            [table({ partitionBy: undefined }), /needs partitionBy/],
            [table({ partitionBy: { column: 'space_id', grain: 'day' } }), /NOT NULL DATE or TIMESTAMP/],
            [table({ partitionBy: { column: 'event_day', grain: 'week' } }), /grain is day or month/],
            [table({ retainDays: 0 }), /retainDays is a whole number/],
            [table({ retainDays: 1.5 }), /retainDays is a whole number/],
            [table({ history: false }), /field history is not allowed/],
            [
                table({ columns: [{ name: 'event_day', type: 'DATE', notNull: true, primaryKey: true }] }),
                /field primaryKey is not allowed/,
            ],
            [table({ columns: [{ name: 'event_day', type: 'DATETIME', notNull: true }] }), /DECIMAL\(p,s\)/],
            [table({ columns: [{ name: '__p', type: 'DATE', notNull: true }] }), /can't start with __/],
            [
                [{ table: 'a', columns: [{ name: 'b' }], partitionBy: { column: 'b', grain: 'day' } }],
                /field partitionBy is not allowed/,
            ],
        ] as const) {
            expect(() =>
                parseManifest(manifest('history', [{ name: 'history', tables }] as unknown as unknown[]), 'catalog'),
            ).toThrow(message);
        }
        // DECIMAL(p,s) and an explicit transactional kind are fine.
        expect(
            parseManifest(
                manifest('history', [
                    {
                        name: 'history',
                        tables: [
                            ...table({
                                columns: [...HISTORY_TABLE.columns, { name: 'amount', type: 'decimal(10, 2)' }],
                            }),
                            { table: 'spaces', kind: 'transactional', columns: [{ name: 'id' }] },
                        ],
                    },
                ]),
                'catalog',
            ).datasets?.[0]?.tables?.[1],
        ).toEqual({ table: 'spaces', kind: 'transactional', columns: [{ name: 'id' }] });
    });

    it('makes them on install, takes a daily batch in one append, and follows the manifest on update', async () => {
        const f = await world();
        await f.platform.plugins.install('history');
        const issued = await f.exchange(f.delivered('history')!, f.proof('history'));
        expect(issued.status).toBe(200);
        const api = f.withToken(issued.body.token);
        const described = (await api('/data/datasets/history')).body.tables as Array<Record<string, unknown>>;
        expect(described).toEqual([
            expect.objectContaining({
                name: 'occupancy',
                kind: 'analytical',
                analytical: expect.objectContaining({
                    partitionBy: { column: 'event_day', grain: 'day' },
                    retainDays: 30,
                    parts: 0,
                }),
            }),
        ]);
        // A daily batch of about 11,000 rows in one call, append-only.
        const rows = Array.from({ length: 11_000 }, (_, i) => ({
            event_day: day(0),
            space_id: `s${i % 40}`,
            people: i % 17,
        }));
        const appended = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/history/tables/occupancy/append',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${issued.body.token}`,
                    'content-type': 'application/x-ndjson',
                    'x-cb-append-id': `day:${day(0)}`,
                },
                body: ndjson(rows),
            },
        );
        expect(appended.status).toBe(200);
        expect(await appended.json()).toMatchObject({ rows: 11_000, parts: 1, status: 'done' });
        const counted = await api('/data/datasets/history/analytics/query', 'POST', {
            sql: 'SELECT count(*) AS n, count(DISTINCT space_id) AS spaces FROM occupancy',
        });
        expect(counted.body.rows).toEqual([[11_000, 40]]);
        // No route updates or deletes an analytical table's rows.
        expect((await api('/data/datasets/history/query', 'POST', { sql: 'DELETE FROM occupancy' })).status).toBe(400);
        // Enabling again changes nothing.
        await f.platform.plugins.setEnabled('history', false);
        await f.platform.plugins.setEnabled('history', true);
        const fresh = () => f.exchange(f.delivered('history')!, f.proof('history'));
        const again = f.withToken((await fresh()).body.token);
        expect(((await again('/data/datasets/history')).body.tables as unknown[]).length).toBe(1);

        // "Update to 1.1.0": a new nullable column and a longer retention apply in place.
        offer(f, {
            ...manifest('history', [
                {
                    name: 'history',
                    tables: [
                        {
                            ...HISTORY_TABLE,
                            columns: [...HISTORY_TABLE.columns, { name: 'note', type: 'TEXT' }],
                            retainDays: 90,
                        },
                        { ...HISTORY_TABLE, table: 'visits' },
                        { table: 'spaces', columns: [{ name: 'id' }] },
                    ],
                },
            ]),
            version: '1.1.0',
        });
        expect(await updateAcked(f.platform.plugins, 'history', 'alice')).toMatchObject({
            changed: true,
            to: '1.1.0',
        });
        const updated = f.withToken((await fresh()).body.token);
        const table = ((await updated('/data/datasets/history')).body.tables as Array<Record<string, unknown>>).find(
            (item) => item.name === 'occupancy',
        )!;
        expect((table.columns as Array<{ name: string }>).map((column) => column.name)).toEqual([
            'event_day',
            'space_id',
            'people',
            'note',
        ]);
        expect(table.analytical).toMatchObject({ retainDays: 90 });
        // Old parts read the new column as null.
        expect(
            (
                await updated('/data/datasets/history/analytics/query', 'POST', {
                    sql: 'SELECT count(note) AS n FROM occupancy',
                })
            ).body.rows,
        ).toEqual([[0]]);

        // A version that changes the partitioning, or retypes a column, is refused and changes nothing.
        for (const [tables, message] of [
            [
                [{ ...HISTORY_TABLE, partitionBy: { column: 'event_day', grain: 'month' } }],
                /Partitioning never changes/,
            ],
            [
                [
                    {
                        ...HISTORY_TABLE,
                        columns: [...HISTORY_TABLE.columns.slice(0, 2), { name: 'people', type: 'REAL' }],
                    },
                ],
                /column "people" is INTEGER, the manifest declares REAL/,
            ],
            [
                [
                    {
                        ...HISTORY_TABLE,
                        columns: [...HISTORY_TABLE.columns, { name: 'extra', type: 'TEXT', notNull: true }],
                    },
                ],
                /may be null/,
            ],
            // A shorter retention for one table, with another table refused:
            // neither changes (the whole update is checked first).
            [
                [
                    {
                        ...HISTORY_TABLE,
                        columns: [...HISTORY_TABLE.columns, { name: 'note', type: 'TEXT' }],
                        retainDays: 1,
                    },
                    { ...HISTORY_TABLE, table: 'visits', partitionBy: { column: 'event_day', grain: 'month' } },
                ],
                /analytical table "visits": it is partitioned by event_day \(day\)/,
            ],
            // A retention change waits for every table and column: a column
            // the engine refuses (NOT NULL, no default) leaves it as it was.
            [
                [
                    {
                        ...HISTORY_TABLE,
                        columns: [...HISTORY_TABLE.columns, { name: 'note', type: 'TEXT' }],
                        retainDays: 1,
                    },
                    { ...HISTORY_TABLE, table: 'visits' },
                    { table: 'spaces', columns: [{ name: 'id' }, { name: 'label', type: 'TEXT', notNull: true }] },
                ],
                /NOT NULL/i,
            ],
            // A reserved table name is refused before an earlier table changes.
            [
                [
                    { ...HISTORY_TABLE, columns: [...HISTORY_TABLE.columns, { name: 'extra2', type: 'TEXT' }] },
                    { ...HISTORY_TABLE, table: '_history_events' },
                ],
                /reserved/i,
            ],
            [[{ table: 'occupancy', columns: [{ name: 'a' }] }], /it is an analytical table/],
        ] as const) {
            offer(f, {
                ...manifest('history', [{ name: 'history', tables }] as unknown as unknown[]),
                version: '1.2.0',
            });
            await expect(updateAcked(f.platform.plugins, 'history', 'alice')).rejects.toThrow(message);
            expect(f.platform.plugins.get('history')).toMatchObject({ version: '1.1.0' });
        }
        const kept = ((await updated('/data/datasets/history')).body.tables as Array<Record<string, unknown>>).find(
            (item) => item.name === 'occupancy',
        );
        expect(kept?.analytical).toMatchObject({ retainDays: 90 });
        // A version the runtime fails to start isn't adopted: its retention never applies.
        const service = f.platform.plugins as unknown as { provision: (...args: unknown[]) => Promise<unknown> };
        const provision = service.provision;
        service.provision = async () => {
            throw new Error('the runtime is down');
        };
        offer(f, {
            ...manifest('history', [{ name: 'history', tables: [{ ...HISTORY_TABLE, retainDays: 1 }] }]),
            version: '1.2.0',
        });
        await expect(updateAcked(f.platform.plugins, 'history', 'alice')).rejects.toThrow(/runtime is down/);
        service.provision = provision;
        expect(f.platform.plugins.get('history')).toMatchObject({ version: '1.1.0' });
        const still = ((await updated('/data/datasets/history')).body.tables as Array<Record<string, unknown>>).find(
            (item) => item.name === 'occupancy',
        );
        expect(still?.analytical).toMatchObject({ retainDays: 90 });
        const data = f.platform.data as unknown as {
            applyAnalyticalRetention: (now: number) => { partitions: number };
        };
        // 2026-11-10's partition is 31 days old on 2026-12-11: kept at 90 days, gone at 1.
        expect(data.applyAnalyticalRetention(Date.UTC(2026, 11, 11, 3))).toMatchObject({ partitions: 0 });
        // Disabled, an update its next enable would refuse isn't adopted.
        await f.platform.plugins.setEnabled('history', false);
        offer(f, {
            ...manifest('history', [
                {
                    name: 'history',
                    tables: [{ ...HISTORY_TABLE, partitionBy: { column: 'event_day', grain: 'month' } }],
                },
            ]),
            version: '1.3.0',
        });
        await expect(updateAcked(f.platform.plugins, 'history', 'alice')).rejects.toThrow(/Partitioning never changes/);
        expect(f.platform.plugins.get('history')).toMatchObject({ version: '1.1.0' });
        // Nor one that adds a column the engine would refuse.
        offer(f, {
            ...manifest('history', [
                {
                    name: 'history',
                    tables: [
                        { ...HISTORY_TABLE, columns: [...HISTORY_TABLE.columns, { name: 'note', type: 'TEXT' }] },
                        { ...HISTORY_TABLE, table: 'visits' },
                        { table: 'spaces', columns: [{ name: 'id' }, { name: 'label', type: 'TEXT', notNull: true }] },
                    ],
                },
            ]),
            version: '1.3.0',
        });
        await expect(updateAcked(f.platform.plugins, 'history', 'alice')).rejects.toThrow(/needs a default/);
        expect(f.platform.plugins.get('history')).toMatchObject({ version: '1.1.0' });
        // Nor one whose new dataset holds a table the engine refuses.
        offer(f, {
            ...manifest('history', [
                { name: 'history', tables: [HISTORY_TABLE] },
                { name: 'extra', tables: [{ table: '_history_events', columns: [{ name: 'id' }] }] },
            ]),
            version: '1.4.0',
        });
        await expect(updateAcked(f.platform.plugins, 'history', 'alice')).rejects.toThrow(/reserved/i);
        expect(f.platform.plugins.get('history')).toMatchObject({ version: '1.1.0' });
        expect(f.datasetRows('plugin:history').map((row) => row.name)).toEqual(['history']);
        // No refused version added a column, and uninstalling keeps the last adopted retention.
        const id = issued.body.datasets[0]!.id;
        const path = f.platform.data.datasetPath({ id, ownerUserId: 'ws:workspace' });
        expect(f.platform.data.engine.analyticalTable(path, 'occupancy')).toMatchObject({
            columns: [{ name: 'event_day' }, { name: 'space_id' }, { name: 'people' }, { name: 'note' }],
            retainDays: 90,
        });
        await f.platform.plugins.uninstall('history', 'alice');
        expect(f.platform.data.engine.analyticalTable(path, 'occupancy')).toMatchObject({ retainDays: 90 });
    });

    it('refuses a declared analytical table over a transactional one of the same name', async () => {
        const f = await world();
        const { api } = await f.datasync();
        await api('/data/datasets/stripe/tables', 'POST', { table: 'occupancy', columns: [{ name: 'a' }] });
        const data = f.platform.data as unknown as {
            ensurePluginDatasets: (id: string, datasets: unknown[]) => unknown;
        };
        expect(() => data.ensurePluginDatasets('datasync', [{ name: 'stripe', tables: [HISTORY_TABLE] }])).toThrow(
            /it is a transactional table, the manifest declares an analytical one/,
        );
    });

    /** Installs history, appends one row a day at these offsets, and answers its dataset and an admin's API. */
    async function backfilled(f: Awaited<ReturnType<typeof world>>, offsets = [0, 10, 29, 30, 31, 45]) {
        await f.platform.plugins.install('history');
        const issued = await f.exchange(f.delivered('history')!, f.proof('history'));
        const appended = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/history/tables/occupancy/append',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${issued.body.token}`,
                    'content-type': 'application/x-ndjson',
                    'x-cb-append-id': 'backfill',
                },
                body: ndjson(offsets.map((offset) => ({ event_day: day(offset), space_id: 's1', people: offset }))),
            },
        );
        expect(appended.status).toBe(200);
        const id = issued.body.datasets[0]!.id;
        const admin = await f.as('alice');
        const retention = async () =>
            (
                (await admin(`/data/datasets/${id}`)).body.tables as Array<{
                    name: string;
                    analytical: { retainDays?: number; retention: Record<string, unknown> };
                }>
            ).find((table) => table.name === 'occupancy')!.analytical;
        const data = f.platform.data as unknown as {
            applyAnalyticalRetention: (now: number) => { partitions: number; rows: number; failed: number };
        };
        const audit = (action: string) =>
            f.workspace.db
                .prepare('SELECT actorKind, actorId, target, detail FROM data_audit WHERE action=? ORDER BY rowid')
                .all(action)
                .map((row) => ({ ...row }));
        return { id, admin, retention, data, audit };
    }

    it('lets an admin override a table’s retention over manifest updates until cleared, with a preview', async () => {
        // The night after 2026-11-10, for the preview's "now" too.
        const night = Date.UTC(2026, 10, 11, 3);
        vi.useFakeTimers({ toFake: ['Date'], now: night });
        cleanup.push(() => vi.useRealTimers());
        const f = await world();
        const { id, admin, retention, data, audit } = await backfilled(f);
        const base = `/data/datasets/${id}/tables/occupancy/retention`;
        expect(await retention()).toEqual(
            expect.objectContaining({
                retainDays: 30,
                retention: { days: 30, source: 'manifest', declared: 30, workspaceDefault: null },
            }),
        );
        // The preview: 30 days drop 2026-09-26, 10-10 and 10-11; 10 days drop 5 of the 6.
        expect((await admin(`${base}/preview?days=30`)).body).toEqual({
            table: 'occupancy',
            days: 30,
            partitions: 3,
            parts: 3,
            rows: 3,
            bytes: expect.any(Number),
            firstPartition: day(45),
            lastPartition: day(30),
        });
        expect((await admin(`${base}/preview?days=10`)).body).toMatchObject({
            partitions: 5,
            rows: 5,
            firstPartition: day(45),
            lastPartition: day(10),
        });
        expect((await admin(`${base}/preview?days=400`)).body).toMatchObject({ partitions: 0, firstPartition: null });
        expect((await admin(`${base}/preview?days=0`)).status).toBe(400);
        expect((await admin(`${base}/preview`)).status).toBe(400);
        // A member manages no plugin's dataset; a plugin's token can't override.
        const member = await f.as('bob');
        expect((await member(`${base}/preview?days=10`)).status).toBe(404);
        expect((await member(base, 'PUT', { days: 90 })).status).toBe(404);
        expect((await admin(`/data/datasets/${id}/tables/missing/retention`, 'PUT', { days: 9 })).status).toBe(404);
        expect((await admin(base, 'PUT', { days: 0 })).status).toBe(400);
        expect((await admin(base, 'PUT', { days: 36_501 })).status).toBe(400);

        // The admin keeps 90 days: it wins.
        expect((await admin(base, 'PUT', { days: 90 })).body).toEqual({
            days: 90,
            source: 'override',
            override: 90,
            declared: 30,
            workspaceDefault: null,
        });
        expect(data.applyAnalyticalRetention(night)).toMatchObject({ partitions: 0 });
        // An update declaring 1 day is adopted, but the override still wins.
        offer(f, {
            ...manifest('history', [{ name: 'history', tables: [{ ...HISTORY_TABLE, retainDays: 1 }] }]),
            version: '1.1.0',
        });
        expect(await updateAcked(f.platform.plugins, 'history', 'alice')).toMatchObject({ to: '1.1.0' });
        expect((await retention()).retention).toEqual({
            days: 90,
            source: 'override',
            override: 90,
            declared: 1,
            workspaceDefault: null,
        });
        expect(data.applyAnalyticalRetention(night)).toMatchObject({ partitions: 0 });
        // "Keep everything" is an override too.
        expect((await admin(base, 'PUT', { days: null })).body).toMatchObject({
            days: null,
            source: 'override',
            override: null,
        });
        expect((await retention()).retainDays).toBeUndefined();
        expect(data.applyAnalyticalRetention(night)).toMatchObject({ partitions: 0 });
        // Cleared, the adopted manifest's 1 day applies at the next run.
        expect((await admin(base, 'DELETE')).body).toMatchObject({ days: 1, source: 'manifest', declared: 1 });
        expect((await retention()).retention).not.toHaveProperty('override');
        expect(data.applyAnalyticalRetention(night)).toMatchObject({ partitions: 5, rows: 5 });
        // Clearing again changes nothing, and audits nothing.
        expect((await admin(base, 'DELETE')).body).toMatchObject({ source: 'manifest' });
        expect(audit('table_retention_override')).toEqual([
            {
                actorKind: 'user',
                actorId: 'alice',
                target: 'history.occupancy',
                detail: 'override set: 30 days (the plugin) → 90 days (admin override)',
            },
            {
                actorKind: 'user',
                actorId: 'alice',
                target: 'history.occupancy',
                detail: 'override set: 90 days (admin override) → keep everything (admin override)',
            },
            {
                actorKind: 'user',
                actorId: 'alice',
                target: 'history.occupancy',
                detail: 'override cleared: keep everything (admin override) → 1 days (the plugin)',
            },
        ]);
        expect(audit('table_retention').at(-1)).toMatchObject({
            detail: 'partitions kept 1 days, as the manifest declares; the admin’s override still applies',
        });
    });

    it('applies the workspace default to tables whose plugin declares no retention', async () => {
        expect(dataSettingsFromEnv({ DATA_ANALYTICS_RETAIN_DAYS: '20' }, '/tmp').limits).toMatchObject({
            analyticalRetainDays: 20,
        });
        expect(() => dataSettingsFromEnv({ DATA_ANALYTICS_RETAIN_DAYS: '-1' }, '/tmp')).toThrow(
            /DATA_ANALYTICS_RETAIN_DAYS/,
        );
        const night = Date.UTC(2026, 10, 11, 3);
        vi.useFakeTimers({ toFake: ['Date'], now: night });
        cleanup.push(() => vi.useRealTimers());
        // DATA_ANALYTICS_RETAIN_DAYS=40, as the environment sets it.
        const f = await world({ analyticalRetainDays: 40 });
        const { admin, retention, data, audit } = await backfilled(f);
        // The manifest's 30 days win over the default.
        expect((await retention()).retention).toMatchObject({ days: 30, source: 'manifest', workspaceDefault: 40 });
        const { retainDays: _, ...undeclared } = HISTORY_TABLE;
        offer(f, { ...manifest('history', [{ name: 'history', tables: [undeclared] }]), version: '1.1.0' });
        await updateAcked(f.platform.plugins, 'history', 'alice');
        expect((await retention()).retention).toEqual({
            days: 40,
            source: 'default',
            declared: null,
            workspaceDefault: 40,
        });
        // An admin's Settings value over the environment's, audited.
        expect((await admin('/settings', 'PATCH', { limits: { dataAnalyticsRetainDays: 30 } })).status).toBe(200);
        expect((await retention()).retention).toMatchObject({ days: 30, source: 'default', workspaceDefault: 30 });
        expect(data.applyAnalyticalRetention(night)).toMatchObject({ partitions: 3 });
        expect((await admin('/settings', 'PATCH', { limits: { dataAnalyticsRetainDays: 0 } })).status).toBe(200);
        expect((await retention()).retention).toMatchObject({ days: null, source: 'default', workspaceDefault: null });
        expect((await admin('/settings', 'PATCH', { limits: { dataAnalyticsRetainDays: null } })).status).toBe(200);
        expect((await retention()).retention).toMatchObject({ days: 40, workspaceDefault: 40 });
        expect(audit('analytics_retention_default').map((row) => row.detail)).toEqual([
            '40 days → 30 days',
            '30 days → keep everything',
            'keep everything → 40 days',
        ]);
        // Two saves at once each record their own step, as committed.
        await Promise.all([
            admin('/settings', 'PATCH', { limits: { dataAnalyticsRetainDays: 10 } }),
            admin('/settings', 'PATCH', { limits: { dataAnalyticsRetainDays: 20 } }),
        ]);
        const steps = audit('analytics_retention_default')
            .slice(3)
            .map((row) => row.detail)
            .sort();
        expect([
            ['10 days → 20 days', '40 days → 10 days'],
            ['20 days → 10 days', '40 days → 20 days'],
        ]).toContainEqual(steps);
        // An override wins over the default too.
        const { id } = (await f.exchange(f.delivered('history')!, f.proof('history'))).body.datasets[0]!;
        expect(
            (await admin(`/data/datasets/${id}/tables/occupancy/retention`, 'PUT', { days: 400 })).body,
        ).toMatchObject({ days: 400, source: 'override' });
    });

    it('retires partitions past their retention at night and deletes their files two days later', async () => {
        const f = await world();
        await f.platform.plugins.install('history');
        const issued = await f.exchange(f.delivered('history')!, f.proof('history'));
        const api = f.withToken(issued.body.token);
        const rows = [0, 10, 29, 30, 31, 45].map((offset) => ({
            event_day: day(offset),
            space_id: 's1',
            people: offset,
        }));
        const appended = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/history/tables/occupancy/append',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${issued.body.token}`,
                    'content-type': 'application/x-ndjson',
                    'x-cb-append-id': 'backfill',
                },
                body: ndjson(rows),
            },
        );
        expect(appended.status).toBe(200);
        const id = issued.body.datasets[0]!.id;
        const path = f.platform.data.datasetPath({ id, ownerUserId: 'ws:workspace' });
        const files = () => f.platform.data.engine.listedParts(path).map((part) => part.file);
        const listed = files();
        expect(listed).toHaveLength(6);
        // The night after 2026-11-10: 30 days keep the partitions that ended
        // after 2026-10-12 03:00, so 2026-10-12 onward.
        const night = Date.UTC(2026, 10, 11, 3);
        const data = f.platform.data as unknown as {
            applyAnalyticalRetention: (now: number) => { partitions: number; rows: number; failed: number };
            sweepAnalytical: (now: number) => number;
        };
        expect(data.applyAnalyticalRetention(night)).toEqual({ partitions: 3, rows: 3, failed: 0 });
        expect(data.applyAnalyticalRetention(night)).toEqual({ partitions: 0, rows: 0, failed: 0 });
        const left = await api('/data/datasets/history/analytics/query', 'POST', {
            sql: 'SELECT min(event_day) AS first, count(*) AS n FROM occupancy',
        });
        expect(left.body.rows).toEqual([[day(29), 3]]);
        expect((await api('/data/datasets/history')).body.tables).toEqual([
            expect.objectContaining({ rowCount: 3, analytical: expect.objectContaining({ partitions: 3, parts: 3 }) }),
        ]);
        // The retired files stay listed (backups keep them) until 48 hours pass.
        expect(files()).toHaveLength(6);
        data.sweepAnalytical(night + 47 * 3_600_000);
        expect(files()).toHaveLength(6);
        expect(data.sweepAnalytical(night + 49 * 3_600_000)).toBe(3);
        expect(files()).toHaveLength(3);
        for (const file of listed.filter((item) => !files().includes(item))) {
            expect(existsSync(file)).toBe(false);
        }
        // The append id outlives its parts: a retry adds nothing back.
        const retried = await f.http.request(
            'http://company-brain-app:4310/api/data/datasets/history/tables/occupancy/append',
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${issued.body.token}`,
                    'content-type': 'application/x-ndjson',
                    'x-cb-append-id': 'backfill',
                },
                body: ndjson(rows),
            },
        );
        expect(await retried.json()).toMatchObject({ duplicate: true, rows: 6, parts: 6 });
        expect(files()).toHaveLength(3);
        const audit = f.workspace.db
            .prepare("SELECT actorKind, target, detail FROM data_audit WHERE action='retention_drop_partition'")
            .all()
            .map((row) => ({ ...row }));
        expect(audit).toEqual([
            {
                actorKind: 'system',
                target: 'history.occupancy',
                detail: expect.stringMatching(
                    new RegExp(`^3 partition\\(s\\) \\(${day(45)} to ${day(30)}\\), 3 row\\(s\\), \\d+ bytes$`),
                ),
            },
        ]);
    });
});
