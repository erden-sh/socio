import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { DatasetView } from '@socio/shared/data-types';
import type { SpecResult } from '@socio/shared/dataset-query/result';
import type { SpecValidation } from '@socio/shared/dataset-query/spec';
import { notesForWrite } from '@socio/shared/live/change-notes';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-specs-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: { sessionSecret: 'secret-0123456789abcdef-xyz', data: { userDataDir: dir } },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: { cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
            });
    };
    const dot = workspace.dots()[0];
    const token = platform.data.tokens.forCommand('alice', dot.id, 60_000, 'person').token;
    const computer = (path: string, method = 'GET', body?: unknown) =>
        app.request(`http://company-brain-app:4310/api${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    // Alice's Dot makes a table in her scratch dataset.
    const made = await computer('/data/datasets/scratch/tables', 'POST', {
        table: 'payments',
        columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'amount', type: 'REAL' },
            { name: 'paid_on', type: 'DATETIME' },
            { name: 'kind', type: 'TEXT' },
        ],
    });
    expect(made.status).toBe(200);
    const alice = await as('alice');
    const datasets = (await (await alice('/data/datasets')).json()) as DatasetView[];
    const dataset = datasets.find((d) => d.kind === 'scratch')!;
    return { app, alice, bob: await as('bob'), computer, dataset };
}

const validate = async (
    call: (path: string, method?: string, body?: unknown) => Response | Promise<Response>,
    body: unknown,
) => {
    const response = await call('/data/specs/validate', 'POST', body);
    return { status: response.status, body: (await response.json()) as SpecValidation & { error?: string } };
};

it('validates a spec against the live table, for the person asking', async () => {
    const f = await fixture();
    const source = { dataset: f.dataset.id, table: 'payments' };
    const good = await validate(f.alice, {
        spec: {
            source,
            filter: { field: 'kind', op: 'is', value: "charge' OR 1=1 --" },
            time: { field: 'paid_on', bucket: 'month' },
            window: 'trailing_12_months',
            measures: [
                { name: 'gross', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'charge' } },
                { name: 'refunds', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'refund' } },
                { name: 'net', expr: { sub: ['gross', 'refunds'] } },
            ],
            totals: true,
            timeZone: 'America/New_York',
        },
    });
    expect(good).toEqual({ status: 200, body: { ok: true, problems: [], engine: 'sqlite' } });

    const bad = await validate(f.alice, {
        spec: {
            source,
            filter: {
                all: [
                    { field: 'amount"; DROP TABLE payments; --', op: 'is_empty' },
                    { field: 'amount', op: 'contains', value: 'x' },
                ],
            },
            measures: [{ name: 'n', op: 'sum', field: 'kind' }],
        },
    });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems.map((p) => p.path)).toEqual([
        '$.filter.all[0].field',
        '$.filter.all[1].op',
        '$.measures[0].op',
    ]);

    // Parameters only when the dashboard declares them.
    const param = { source, filter: { field: 'amount', op: 'gte', value: { $param: 'floor' } } };
    expect((await validate(f.alice, { spec: param })).body.ok).toBe(false);
    expect((await validate(f.alice, { spec: param, params: ['floor'] })).body.ok).toBe(true);

    const noTable = await validate(f.alice, { spec: { source: { ...source, table: 'sqlite_master' } } });
    expect(noTable.body).toEqual({
        ok: false,
        problems: [{ path: '$.source.table', message: expect.stringContaining('no table "sqlite_master"') }],
    });
    const plugin = await validate(f.alice, { spec: { source: { plugin: 'p1', source: 'payouts' } } });
    expect(plugin.body.problems).toEqual([
        { path: '$.source', message: expect.stringContaining('Plugin data sources') },
    ]);
    const shape = await validate(f.alice, { spec: 'SELECT * FROM payments' });
    expect(shape.body.ok).toBe(false);
    expect(shape.body.problems[0].path).toBe('$');
});

it('refuses a dataset the person can’t read, a token, and a malformed body', async () => {
    const f = await fixture();
    const spec = { source: { dataset: f.dataset.id, table: 'payments' } };
    // Bob can't read Alice's dataset: the same 404 as everywhere else.
    expect((await validate(f.bob, { spec })).status).toBe(404);
    expect((await validate(f.alice, { spec: { source: { dataset: 'nope', table: 'payments' } } })).status).toBe(404);
    // A data token can't: specs are for people for now.
    expect((await validate(f.computer, { spec })).status).toBe(403);
    expect((await validate(f.alice, { spec, sql: 'SELECT 1' })).status).toBe(400);
    expect((await validate(f.alice, 'not json')).status).toBe(400);
    expect((await validate(f.alice, { spec, params: ["x'; --"] })).status).toBe(400);
    const huge = await f.alice(
        '/data/specs/validate',
        'POST',
        JSON.stringify({ spec: { ...spec, pad: 'x'.repeat(300 * 1024) } }),
    );
    expect(huge.status).toBe(413);
    const anonymous = await f.app.request('/api/data/specs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    expect(anonymous.status).toBe(401);
});

it('makes no change note: checking a spec changes nothing', () => {
    expect(notesForWrite('/data/specs/validate')).toEqual([]);
});

it('runs a spec for the person asking, as one parameterized query (build step 5)', async () => {
    const f = await fixture();
    const source = { dataset: f.dataset.id, table: 'payments' };
    const inserted = await f.computer('/data/datasets/scratch/tables/payments/rows', 'POST', {
        rows: [
            { id: 'p1', amount: 100, paid_on: '2026-01-10T12:00:00Z', kind: 'charge' },
            { id: 'p2', amount: 30, paid_on: '2026-01-20T12:00:00Z', kind: 'refund' },
            { id: 'p3', amount: 5, paid_on: '2026-02-02T12:00:00Z', kind: "charge' OR 1=1 --" },
        ],
    });
    expect(inserted.status).toBe(200);
    const run = (call: typeof f.alice, body: unknown) => call('/data/specs/run', 'POST', body);
    const answer = await run(f.alice, {
        spec: {
            source,
            filter: { field: 'kind', op: 'is_not', value: "charge' OR 1=1 --" },
            time: { field: 'paid_on', bucket: 'month' },
            window: { between: ['2026-01-01', '2026-02-28'] },
            measures: [
                { name: 'gross', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'charge' } },
                { name: 'refunds', op: 'sum', field: 'amount', where: { field: 'kind', op: 'is', value: 'refund' } },
                { name: 'net', expr: { sub: ['gross', 'refunds'] } },
            ],
            totals: true,
        },
        timeZone: 'America/New_York',
    });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as SpecResult;
    expect(body.rows.map((r) => r.values)).toEqual([
        { paid_on: '2026-01-01', gross: 100, refunds: 30, net: 70 },
        { paid_on: '2026-02-01', gross: null, refunds: null, net: null },
    ]);
    expect(body.totals).toEqual({ gross: 100, refunds: 30, net: 70 });
    expect(body).toMatchObject({ engine: 'sqlite', timeZone: 'America/New_York', truncated: false, cached: false });

    // Every problem at once, as validate gives them.
    const bad = await run(f.alice, {
        spec: { source, filter: { field: 'nope', op: 'is_empty' }, sort: [{ field: 'x' }] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { problems: Array<{ path: string }> }).problems.map((p) => p.path)).toEqual([
        '$.filter.field',
        '$.sort[0].field',
    ]);
    // The same access as everywhere: Bob can't read it, a token can't run specs.
    expect((await run(f.bob, { spec: { source } })).status).toBe(404);
    expect((await run(f.computer, { spec: { source } })).status).toBe(403);
    expect((await run(f.alice, { spec: { source }, sql: 'SELECT 1' })).status).toBe(400);
    expect(notesForWrite('/data/specs/run')).toEqual([]);
});
