import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { insertBlock } from '@socio/foundation/pages/insert-block';
import type { DotTurn } from '@socio/foundation/turns/turn';
import {
    VIEW_NO_ACCESS,
    normalizeViewSpec,
    parseViewSpec,
    viewDraft,
    viewSpecMarkdown,
    type ViewQueryResult,
} from '@socio/shared/dataset-view';

import { inspectMarkdown, markdownManager } from '../../packages/client/src/modules/pages/editor/markdown.js';
import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { DatasetViews } from '../../src/server/dataspace/views.js';
import { datasetViewTools } from '../../src/server/pages/page-tools.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'secret-0123456789abcdef-xyz';
const USERS = [...DEFAULT_MOCK_USERS, { id: 'carol', name: 'Carol', role: 'member' as const }];

async function fixture(limits: { queryMaxRows?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-views-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir, limits },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (body: unknown, path = '/data/views/query') =>
            app.request(`/api${path}`, {
                method: 'POST',
                headers: { cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
    };
    const space = workspace.spaces()[0];
    // Alice's own socio: its scratch is hers (a company socio's is its
    // shared dataset, CB-337).
    const dot = workspace.createDot(
        space.id,
        'Helper',
        'Helps.',
        false,
        false,
        [space.id],
        null,
        false,
        null,
        false,
        'alice',
    );
    const other = workspace.createSpace('Elsewhere', '');
    const actor = { kind: 'dot' as const, userId: 'alice', dotId: dot.id };
    await platform.data.write(actor, undefined, {
        op: 'create_table',
        input: {
            table: 'sales',
            columns: [
                { name: 'month', type: 'TEXT', primaryKey: true },
                { name: 'total', type: 'REAL' },
            ],
        },
    });
    await platform.data.write(actor, undefined, {
        op: 'insert',
        table: 'sales',
        rows: [
            { month: '2026-07', total: 120 },
            { month: '2026-08', total: 95.5 },
            { month: '2026-09', total: 143 },
            { month: '2026-10', total: 160 },
        ],
    });
    const dataset = platform.data.datasetsFor('alice').find((d) => d.kind === 'scratch')!;
    const page = await workspace.pages.create(
        space.id,
        { title: 'Sales', content: '# Sales\n\nNumbers below.' },
        null,
        'alice',
    );
    return {
        app,
        platform,
        workspace,
        dot,
        space,
        other,
        actor,
        dataset,
        page,
        alice: await as('alice'),
        bob: await as('bob'),
        carol: await as('carol'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as Promise<T>;

it('round-trips a view block through page Markdown and the editor', () => {
    const spec = normalizeViewSpec({
        datasetId: 'd1',
        query: 'SELECT "month", total FROM sales WHERE note <> \'```\'',
        display: 'bar',
        x: 'month',
        y: 'total',
        title: '',
        refresh: 60,
    });
    // Empty optionals are dropped; keys keep a fixed order.
    expect(Object.keys(spec)).toEqual(['datasetId', 'query', 'display', 'x', 'y', 'refresh']);
    const block = viewSpecMarkdown(spec);
    // Backticks in the query never close the fence.
    expect(block.split('\n').filter((line) => line.startsWith('```'))).toEqual(['```dataset-view', '```']);
    expect(parseViewSpec(block.split('\n').slice(1, -1).join('\n'))).toEqual(spec);
    const source = `# Sales\n\n${block}\n\nAfter.\n\n\`\`\`dataset-view\nnot json\n\`\`\`\n`;
    expect(inspectMarkdown(source).supported).toBe(true);
    const doc = markdownManager.parse(source);
    const nodes = doc.content!.map((node) => node.type);
    expect(nodes).toEqual(['heading', 'datasetView', 'paragraph', 'codeBlock']);
    expect(doc.content![1].attrs).toMatchObject({
        datasetId: 'd1',
        display: 'bar',
        x: 'month',
        refresh: 60,
        title: null,
    });
    const out = markdownManager.serialize(doc);
    expect(out).toContain('"query": "SELECT \\"month\\", total');
    // Invalid JSON stays an ordinary code block, untouched.
    expect(out).toContain('```dataset-view\nnot json\n```');
    expect(markdownManager.parse(out)).toEqual(doc);
    // Unfinished blocks (just inserted) keep their place too.
    expect(viewDraft({ display: 'pie', refresh: 2 })).toEqual({
        datasetId: '',
        query: '',
        display: 'table',
        refresh: 10,
    });
    expect(parseViewSpec('{"datasetId":"d","query":""}')).toBeUndefined();
});

it('places a view block at the end or after a heading', () => {
    expect(insertBlock('', 'B')).toBe('B\n');
    expect(insertBlock('# A\n\ntext\n\n', 'B')).toBe('# A\n\ntext\n\nB\n');
    expect(insertBlock('# A\n\none\n\n## Two\n\ntwo', 'B', 'two')).toBe('# A\n\none\n\n## Two\n\nB\n\ntwo');
    expect(() => insertBlock('# A', 'B', 'Missing')).toThrow(/No heading/);
});

it('reads a view through the viewer: the owner, Space members once shared, nobody else', async () => {
    const f = await fixture();
    const body = {
        spaceId: f.space.id,
        pageId: f.page.id,
        datasetId: f.dataset.id,
        query: 'SELECT month, total FROM sales ORDER BY month',
    };
    const own = await json<ViewQueryResult>(f.alice(body));
    expect(own.columns).toEqual(['month', 'total']);
    expect(own.rows).toHaveLength(4);
    expect(own.dataset).toMatchObject({ owned: true, sharedHere: false });
    // Not shared: Bob gets the placeholder, not data (and no dataset name).
    const denied = await f.bob(body);
    expect(denied.status).toBe(403);
    const refusal = await json<{ error: string; code: string }>(denied);
    expect(refusal).toEqual({ error: VIEW_NO_ACCESS, code: 'no_access' });
    // Shared with another Space: still not on this page.
    f.platform.data.updateDataset('alice', f.dataset.id, {
        sharedSpaceId: f.other.id,
    });
    expect((await f.bob(body)).status).toBe(403);
    const elsewhere = await f.workspace.pages.create(f.other.id, { title: 'Other', content: '' }, null, 'bob');
    expect((await f.bob({ ...body, spaceId: f.other.id, pageId: elsewhere.id })).status).toBe(200);
    // Shared with this page's Space: every member reads it.
    f.platform.data.updateDataset('alice', f.dataset.id, {
        sharedSpaceId: f.space.id,
    });
    for (const viewer of [f.bob, f.carol]) {
        const shared = await json<ViewQueryResult>(viewer(body));
        expect(shared.rows).toEqual(own.rows);
        expect(shared.dataset).toMatchObject({ owned: false, sharedHere: true });
    }
    // A page id from another Space doesn't borrow that Space's share.
    expect((await f.bob({ ...body, spaceId: f.space.id, pageId: elsewhere.id })).status).toBe(404);
    // Unknown datasets get the same refusal as private ones.
    const unknown = await f.bob({ ...body, datasetId: 'nope' });
    expect(unknown.status).toBe(403);
    expect((await json<{ error: string }>(unknown)).error).toBe(VIEW_NO_ACCESS);
    // Signed out: nothing. A computer's data token: not this route.
    expect(
        (
            await f.app.request('/api/data/views/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
        ).status,
    ).toBe(401);
    const token = f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token;
    expect(
        (
            await f.app.request('http://company-brain-app:4310/api/data/views/query', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            })
        ).status,
    ).toBe(403);
});

it('runs only one read-only SELECT, within the data space caps', async () => {
    const f = await fixture({ queryMaxRows: 3 });
    const base = {
        spaceId: f.space.id,
        pageId: f.page.id,
        datasetId: f.dataset.id,
    };
    for (const query of [
        'DELETE FROM sales',
        'UPDATE sales SET total = 0',
        'DROP TABLE sales',
        'SELECT 1; DELETE FROM sales',
        'PRAGMA table_info(sales)',
        "ATTACH DATABASE '/tmp/x.sqlite' AS x",
    ]) {
        const response = await f.alice({ ...base, query });
        expect(response.status, query).toBe(400);
    }
    // The authorizer refuses what slips past the statement check.
    expect(
        (
            await f.alice({
                ...base,
                query: "SELECT * FROM pragma_table_info('sales')",
            })
        ).status,
    ).toBeGreaterThanOrEqual(400);
    const rows = await json<ViewQueryResult>(f.alice({ ...base, query: 'SELECT * FROM sales ORDER BY month' }));
    expect(rows.rows).toHaveLength(3);
    expect(rows).toMatchObject({ truncated: true, maxRows: 3 });
    // Parameters bind; they are never spliced into the SQL.
    const filtered = await json<ViewQueryResult>(
        f.alice({
            ...base,
            query: 'SELECT month FROM sales WHERE total > ? ORDER BY month',
            params: [130],
        }),
    );
    expect(filtered.rows).toEqual([['2026-09'], ['2026-10']]);
    expect((await f.alice({ ...base, query: 'SELECT nothing FROM nowhere' })).status).toBe(400);
    // The data is still there.
    const all = await f.platform.data.query(
        { kind: 'user', userId: 'alice' },
        f.dataset.id,
        'SELECT count(*) FROM sales',
    );
    expect(all.rows).toEqual([[4]]);
});

it('keeps results briefly, per dataset version, and limits uncached runs', async () => {
    const f = await fixture();
    const views = new DatasetViews(f.platform.data, f.workspace.pages, {
        perMinute: 3,
    });
    const body = {
        spaceId: f.space.id,
        pageId: f.page.id,
        datasetId: f.dataset.id,
        query: 'SELECT sum(total) FROM sales',
    };
    const first = await views.query('alice', body);
    expect(first).toMatchObject({ cached: false, rows: [[518.5]] });
    expect(await views.query('alice', body)).toMatchObject({ cached: true });
    // Space members share the cache, but each is checked first.
    f.platform.data.updateDataset('alice', f.dataset.id, {
        sharedSpaceId: f.space.id,
    });
    expect(await views.query('bob', body)).toMatchObject({ cached: true });
    f.platform.data.updateDataset('alice', f.dataset.id, {
        sharedSpaceId: null,
    });
    await expect(views.query('bob', body)).rejects.toThrow(VIEW_NO_ACCESS);
    // A write changes the dataset's version: the next read is fresh.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.platform.data.write(f.actor, undefined, {
        op: 'insert',
        table: 'sales',
        rows: [{ month: '2026-11', total: 1.5 }],
    });
    expect(await views.query('alice', body)).toMatchObject({
        cached: false,
        rows: [[520]],
    });
    // `fresh` skips the cache, and counts toward the viewer's limit.
    expect(await views.query('alice', { ...body, fresh: true })).toMatchObject({
        cached: false,
    });
    await expect(views.query('alice', { ...body, fresh: true })).rejects.toThrow(/Too many view queries/);
    // Cache hits stay free.
    expect(await views.query('alice', body)).toMatchObject({ cached: true });
});

it('lets a Dot insert a view of its datasets into a page, checked first', async () => {
    const f = await fixture();
    f.workspace.bindThread('thread', f.dot.id, 'Views', 'alice');
    const turn = {
        dot: f.dot,
        userId: 'alice',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    } as unknown as DotTurn;
    const [tool] = datasetViewTools(f.workspace, f.platform.data, turn);
    expect(tool.name).toBe('insert_dataset_view');
    const run = (args: Record<string, unknown>) =>
        tool.execute!(tool.parameters.parse({ pageId: f.page.id, ...args }) as never) as Promise<
            Record<string, unknown>
        >;
    const inserted = await run({
        query: 'SELECT month, total FROM sales ORDER BY month',
        display: 'line',
        title: 'Monthly sales',
        afterHeading: 'Sales',
    });
    expect(inserted).toMatchObject({
        view: {
            datasetId: f.dataset.id,
            display: 'line',
            x: 'month',
            y: 'total',
            title: 'Monthly sales',
        },
        columns: ['month', 'total'],
        visibility: expect.stringMatching(/Only the user sees the data/),
    });
    const page = f.workspace.pages.get(f.space.id, f.page.id);
    expect(page.revision).toBe(f.page.revision + 1);
    const doc = markdownManager.parse(page.content);
    expect(doc.content!.map((node) => node.type)).toEqual(['heading', 'datasetView', 'paragraph']);
    expect(doc.content![1].attrs).toMatchObject({
        datasetId: f.dataset.id,
        query: 'SELECT month, total FROM sales ORDER BY month',
    });
    // The block it wrote is one the route serves to the owner.
    const read = await json<ViewQueryResult>(
        f.alice({
            spaceId: f.space.id,
            pageId: f.page.id,
            datasetId: f.dataset.id,
            query: doc.content![1].attrs!.query,
        }),
    );
    expect(read.rows).toHaveLength(4);
    // Refused: writes, columns the query lacks, datasets the Dot can't see.
    expect(await run({ query: 'DELETE FROM sales' })).toMatchObject({
        error: expect.stringMatching(/read-only SELECT/),
    });
    expect(await run({ query: 'SELECT month FROM sales', display: 'bar', y: 'total' })).toMatchObject({
        error: expect.stringMatching(/no column "total"/),
    });
    const bobs = f.platform.data.createDataset('bob', { name: 'Bob only' });
    expect(await run({ dataset: bobs.id, query: 'SELECT 1' })).toMatchObject({
        error: expect.stringMatching(/No dataset/),
    });
    expect(f.workspace.pages.get(f.space.id, f.page.id).revision).toBe(page.revision);
    // Once shared with the Space, the tool says everyone sees it.
    f.platform.data.updateDataset('alice', f.dataset.id, {
        sharedSpaceId: f.space.id,
    });
    expect(await run({ dataset: 'scratch', query: 'SELECT count(*) AS n FROM sales' })).toMatchObject({
        visibility: 'Everyone in this Space sees the data.',
    });
    expect(f.workspace.pages.get(f.space.id, f.page.id).content.match(/```dataset-view/g)).toHaveLength(2);
});
