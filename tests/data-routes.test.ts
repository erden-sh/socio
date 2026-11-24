import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { StorageSettings } from '@socio/data/storage/settings';
import type { ApprovalsState, ApprovalView } from '@socio/shared/approvals';
import type { DataSpaceState, DatasetDetail, DatasetView, RowsPage } from '@socio/shared/data-types';
import { rowChanges } from '@socio/shared/dataset-views/contract';
import type { SetupStatus } from '@socio/shared/types';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { BackupService } from '../src/server/backup/backup-service.js';
import { DataSpace } from '../src/server/dataspace/space.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(storage?: StorageSettings, appOrigin?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-routes-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: 'secret-0123456789abcdef-xyz',
            data: { userDataDir: dir },
            storage,
            appOrigin,
        },
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
        return (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    ...headers,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    // A computer on the computers network: another Host, a bearer token, no cookie.
    const withToken =
        (token: string) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`http://company-brain-app:4310/api${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const dot = workspace.dots()[0];
    return {
        app,
        dir,
        platform,
        workspace,
        dot,
        withToken,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as Promise<T>;

it('serves each user their own data space and refuses other users’ data', async () => {
    const f = await fixture();
    const created = await f.alice('/data/datasets', 'POST', {
        name: 'Prices',
        description: 'Tracked',
    });
    expect(created.status).toBe(201);
    const dataset = await json<DatasetView>(created);
    const state = await json<DataSpaceState>(f.alice('/data'));
    expect(state.datasets.map((d) => d.name)).toEqual(['Prices']);
    expect((await json<DataSpaceState>(f.bob('/data'))).datasets).toEqual([]);
    for (const [path, method] of [
        [`/data/datasets/${dataset.id}`, 'GET'],
        [`/data/datasets/${dataset.id}/export.sqlite`, 'GET'],
        [`/data/datasets/${dataset.id}`, 'DELETE'],
    ] as const) {
        expect((await f.bob(path, method)).status, path).toBe(404);
    }
    expect(
        (
            await f.bob(`/data/datasets/${dataset.id}/query`, 'POST', {
                sql: 'SELECT 1',
            })
        ).status,
    ).toBe(404);
    expect(
        (
            await f.bob('/data/grants', 'PUT', {
                dotId: f.dot.id,
                datasetId: dataset.id,
                access: 'read',
            })
        ).status,
    ).toBe(404);
    // Shared with a Space: Bob reads it, but never changes it.
    await f.alice(`/data/datasets/${dataset.id}`, 'PATCH', {
        sharedSpaceId: f.dot.spaceId,
        retentionDays: 30,
    });
    const shared = await json<DatasetDetail>(f.bob(`/data/datasets/${dataset.id}`));
    expect(shared.dataset).toMatchObject({ access: 'read', retentionDays: 30 });
    expect((await f.bob(`/data/datasets/${dataset.id}`, 'PATCH', { name: 'Mine' })).status).toBe(404);
    expect((await f.bob(`/data/datasets/${dataset.id}`, 'DELETE')).status).toBe(404);
    expect((await f.alice(`/data/datasets/${dataset.id}`, 'DELETE')).status).toBe(200);
    // Nobody signed in: nothing.
    expect((await f.app.request('/api/data')).status).toBe(401);
});

it('accepts a scoped token from a computer for its Dot’s data only', async () => {
    const f = await fixture();
    const token = f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token;
    const computer = f.withToken(token);
    const table = await computer('/data/datasets/scratch/tables', 'POST', {
        table: 'listings',
        columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'price', type: 'REAL' },
        ],
    });
    expect(table.status).toBe(200);
    expect(await table.json()).toMatchObject({ status: 'done' });
    expect(
        (
            await computer('/data/datasets/scratch/tables/listings/rows', 'POST', {
                rows: [
                    { id: 'a', price: 10 },
                    { id: 'b', price: 12 },
                ],
            })
        ).status,
    ).toBe(200);
    await computer('/data/datasets/scratch/tables/listings/rows', 'POST', {
        rows: [{ id: 'a', price: 11 }],
        key: ['id'],
    });
    const result = await json<{ rows: unknown[][] }>(
        computer('/data/datasets/scratch/query', 'POST', {
            sql: 'SELECT id, price FROM listings ORDER BY id',
        }),
    );
    expect(result.rows).toEqual([
        ['a', 11],
        ['b', 12],
    ]);
    expect(
        (
            await computer('/data/files', 'PUT', {
                path: 'out/report.txt',
                content: 'hello',
            })
        ).status,
    ).toBe(200);
    expect(await (await computer(`/data/files/raw?path=${encodeURIComponent('out/report.txt')}`)).text()).toBe('hello');
    // Alice sees what her Dot wrote, in her scratch dataset for it.
    const scratch = (await json<DataSpaceState>(f.alice('/data'))).datasets.find((d) => d.kind === 'scratch')!;
    const rows = await json<RowsPage>(f.alice(`/data/datasets/${scratch.id}/tables/listings/rows`));
    expect(rows.total).toBe(2);
    const audit = await json<Array<{ actorKind: string; action: string }>>(f.alice('/data/audit'));
    expect(audit.some((entry) => entry.actorKind === 'token' && entry.action === 'insert')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(token);
    // A token never reaches the user-only routes, Bob's data, or anything outside /api/data.
    const bobs = await f.bob('/data/datasets', 'POST', { name: 'Bob’s' });
    const bobDataset = await json<DatasetView>(bobs);
    expect(
        (
            await computer(`/data/datasets/${bobDataset.id}/query`, 'POST', {
                sql: 'SELECT 1',
            })
        ).status,
    ).toBe(404);
    expect((await computer('/data')).status).toBe(403);
    expect(
        (
            await computer('/data/grants', 'PUT', {
                dotId: f.dot.id,
                folder: 'x',
                access: 'write',
            })
        ).status,
    ).toBe(403);
    expect((await computer(`/data/datasets/${scratch.id}`, 'DELETE')).status).toBe(403);
    expect((await computer(`/data/datasets/${scratch.id}/export.sqlite`)).status).toBe(403);
    expect((await computer('/state')).status).toBe(403);
    expect((await computer('/workspace')).status).toBe(403);
    // Revoked when the computer stops; forged tokens are refused.
    f.platform.dotExtensions.computer!.stopped!(f.dot.id);
    expect((await computer('/data/datasets')).status).toBe(401);
    expect((await f.withToken('cbdt_forged')('/data/datasets')).status).toBe(401);
    // The session user can't write rows through the API: Dots do that.
    expect(
        (
            await f.alice(`/data/datasets/${scratch.id}/tables`, 'POST', {
                table: 'x',
                columns: [{ name: 'a' }],
            })
        ).status,
    ).toBe(403);
});

it('declares and drops secondary indexes for a token and for the dataset’s owner (CB-355)', async () => {
    const f = await fixture();
    const computer = f.withToken(f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token);
    await computer('/data/datasets/scratch/tables', 'POST', {
        table: 'snapshots',
        columns: [{ name: 'listing_id' }, { name: 'rating', type: 'REAL' }],
    });
    const created = await computer('/data/datasets/scratch/tables/snapshots/indexes', 'POST', {
        name: 'by_listing',
        columns: ['listing_id'],
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ status: 'done', result: { created: true, index: 'by_listing' } });
    const described = await json<{ tables: Array<{ name: string; indexes: unknown[] }> }>(
        computer('/data/datasets/scratch'),
    );
    expect(described.tables[0].indexes).toEqual([{ name: 'by_listing', columns: ['listing_id'], unique: false }]);
    // Never SQL: anything but a name, columns and flags is refused.
    for (const input of [
        { name: 'x', columns: ['rating'], where: 'rating > 1' },
        { name: 'x', columns: ['rating DESC'] },
        { name: 'x', columns: [] },
        { sql: 'CREATE INDEX x ON snapshots (rating)' },
    ]) {
        expect((await computer('/data/datasets/scratch/tables/snapshots/indexes', 'POST', input)).status).toBe(400);
    }
    // The owner, in the app, drops and declares on her own dataset; Bob can't.
    const scratch = (await json<DataSpaceState>(f.alice('/data'))).datasets.find((d) => d.kind === 'scratch')!;
    expect((await f.bob(`/data/datasets/${scratch.id}/tables/snapshots/indexes/by_listing`, 'DELETE')).status).toBe(
        404,
    );
    expect((await f.alice(`/data/datasets/${scratch.id}/tables/snapshots/indexes/by_listing`, 'DELETE')).status).toBe(
        200,
    );
    expect((await f.alice(`/data/datasets/${scratch.id}/tables/snapshots/indexes/by_listing`, 'DELETE')).status).toBe(
        404,
    );
    expect(
        (
            await f.alice(`/data/datasets/${scratch.id}/tables/snapshots/indexes`, 'POST', {
                name: 'one_per_listing',
                columns: ['listing_id'],
                unique: true,
            })
        ).status,
    ).toBe(200);
    const detail = await json<DatasetDetail>(f.alice(`/data/datasets/${scratch.id}`));
    expect(detail.tables[0].indexes).toEqual([{ name: 'one_per_listing', columns: ['listing_id'], unique: true }]);
    const audit = await json<Array<{ actorKind: string; action: string }>>(f.alice('/data/audit'));
    expect(audit.filter((entry) => entry.action.endsWith('_index')).map((e) => [e.actorKind, e.action])).toEqual(
        expect.arrayContaining([
            ['token', 'create_index'],
            ['user', 'drop_index'],
            ['user', 'create_index'],
        ]),
    );
});

it('runs ANALYZE for a token and for the dataset’s owner, as a declared operation (CB-355)', async () => {
    const f = await fixture();
    const computer = f.withToken(f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token);
    await computer('/data/datasets/scratch/tables', 'POST', { table: 'snapshots', columns: [{ name: 'listing_id' }] });
    await computer('/data/datasets/scratch/tables', 'POST', { table: 'notes', columns: [{ name: 'text' }] });
    const one = await computer('/data/datasets/scratch/tables/snapshots/analyze', 'POST', {});
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ status: 'done', result: { analyzed: ['snapshots'] } });
    const all = await computer('/data/datasets/scratch/analyze', 'POST', {});
    expect(await all.json()).toMatchObject({ status: 'done', result: { analyzed: ['notes', 'snapshots'] } });
    expect((await computer('/data/datasets/scratch/tables/nope/analyze', 'POST', {})).status).toBe(404);
    // The owner, in the app, on her own dataset; Bob can't.
    const scratch = (await json<DataSpaceState>(f.alice('/data'))).datasets.find((d) => d.kind === 'scratch')!;
    expect((await f.bob(`/data/datasets/${scratch.id}/analyze`, 'POST', {})).status).toBe(404);
    expect((await f.alice(`/data/datasets/${scratch.id}/tables/notes/analyze`, 'POST', {})).status).toBe(200);
    const audit = await json<Array<{ actorKind: string; action: string; detail: string | null }>>(
        f.alice('/data/audit'),
    );
    expect(audit.filter((entry) => entry.action === 'analyze').map((e) => [e.actorKind, e.detail])).toEqual(
        expect.arrayContaining([
            ['token', 'analyze snapshots'],
            ['token', 'analyze every table'],
            ['user', 'analyze notes'],
        ]),
    );
});

it('exports CSV and SQLite, and shows usage to its owner and to operators', async () => {
    const f = await fixture();
    const computer = f.withToken(f.platform.data.tokens.forCommand('bob', f.dot.id, 60_000, 'person').token);
    await computer('/data/datasets/scratch/tables', 'POST', {
        table: 't',
        columns: [{ name: 'a' }, { name: 'b' }],
    });
    await computer('/data/datasets/scratch/tables/t/rows', 'POST', {
        rows: [{ a: 'x,y', b: 'say "hi"' }],
    });
    const scratch = (await json<DataSpaceState>(f.bob('/data'))).datasets[0];
    const csv = await f.bob(`/data/datasets/${scratch.id}/export.csv?table=t`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
    const sqlite = await f.bob(`/data/datasets/${scratch.id}/export.sqlite`);
    expect(
        Buffer.from(await sqlite.arrayBuffer())
            .subarray(0, 15)
            .toString(),
    ).toBe('SQLite format 3');
    // Bob (member) sees his own usage; Alice (operator) sees everyone's.
    const bob = await json<{ own: { datasets: number }; all?: unknown[] }>(f.bob('/data/usage'));
    expect(bob.own.datasets).toBe(1);
    expect(bob.all).toBeUndefined();
    const alice = await json<{
        all?: Array<{ userId: string; datasets: number }>;
    }>(f.alice('/data/usage'));
    expect(alice.all?.find((entry) => entry.userId === 'bob')?.datasets).toBe(1);
});

it('lets each user see and decide only their own approvals, and set their own policies', async () => {
    const f = await fixture();
    const request = await f.platform.data.requestDataset(
        { kind: 'dot', userId: 'bob', dotId: f.dot.id },
        { name: 'Wishlist', description: '' },
    );
    if (request.status !== 'pending_approval') {
        throw new Error('expected pending');
    }
    const bobState = await json<ApprovalsState>(f.bob('/approvals'));
    expect(bobState.pending.map((item) => item.id)).toEqual([request.id]);
    expect(bobState.capabilities.map((c) => c.id)).toEqual([
        // CB-271: a socio's new Space, manual only.
        'space.create',
        'external.mcp',
        'data.create_dataset',
        'data.write_shared',
        'grant.change',
        // CB-524: a socio's uploads into a Space's media.
        'media.space_upload',
        // CB-267: repository extraction for apps, manual only (dark).
        'repo_extract',
        'repo_extract_standing',
        // CB-239: coding sessions; one that pushes is manual only (dark).
        'coding_session_read',
        'coding_session_push',
        // CB-326 step 4: a provider's runtime requests (command, file-change,
        // …) as consumable approval capabilities, manual only (dark).
        'coding_runtime_command',
        'coding_runtime_file_read',
        'coding_runtime_file_change',
        'coding_runtime_mcp_elicitation',
        'coding_runtime_permission',
        // Jobs and schedules.
        'job.save',
        'schedule.create',
        // Persistent goals.
        'goal.set',
        // CB-492: a large linked-page import (unfurl_recursive).
        'unfurl.recursive',
    ]);
    expect(bobState.capabilities.find((c) => c.id === 'external.mcp')).toMatchObject({
        manualOnly: true,
        auto: { allowed: false },
    });
    expect((await json<ApprovalsState>(f.alice('/approvals'))).pending).toEqual([]);
    expect((await f.alice(`/approvals/${request.id}`)).status).toBe(404);
    expect(
        (
            await f.alice(`/approvals/${request.id}/decision`, 'POST', {
                decision: 'approve',
            })
        ).status,
    ).toBe(404);
    const decided = await json<ApprovalView>(
        f.bob(`/approvals/${request.id}/decision`, 'POST', { decision: 'approve' }),
    );
    expect(decided).toMatchObject({ status: 'approved', decidedVia: 'user' });
    expect((await json<DataSpaceState>(f.bob('/data'))).datasets.map((d) => d.name)).toContain('Wishlist');
    expect(
        (
            await f.bob(`/approvals/${request.id}/decision`, 'POST', {
                decision: 'deny',
            })
        ).status,
    ).toBe(409);
    const policy = await f.bob('/approvals/policies', 'PUT', {
        dotId: f.dot.id,
        capability: 'data.create_dataset',
        policy: 'bypass',
    });
    expect(policy.status).toBe(200);
    expect(await f.platform.approvals.policy('bob', f.dot.id, 'data.create_dataset')).toBe('bypass');
    expect(await f.platform.approvals.policy('alice', f.dot.id, 'data.create_dataset')).toBe('manual');
    expect(
        (
            await f.bob('/approvals/policies', 'PUT', {
                dotId: f.dot.id,
                capability: 'nope',
                policy: 'bypass',
            })
        ).status,
    ).toBe(404);
    const audit = (await json<ApprovalsState>(f.bob('/approvals'))).audit.map((entry) => entry.event);
    expect(audit).toEqual(expect.arrayContaining(['requested', 'approved', 'executed', 'policy_changed']));
});

it('sends a Telegram turn’s approval request to the linked user as a direct message with a link', async () => {
    const f = await fixture(undefined, 'https://brain.example');
    const sent: Array<[string, string]> = [];
    (f.platform as unknown as { telegram: unknown }).telegram = {
        status: 'online',
        sendDirect: async (to: string, text: string) => void sent.push([to, text]),
        stop: async () => {},
    };
    const { code } = await f.workspace.telegram.createCode('bob');
    await f.workspace.telegram.redeem(code, '777');
    f.workspace.bindThread('tg-thread', f.dot.id, 'Telegram direct message', 'bob');
    await f.workspace.telegram.bindThread('tg:777:dm#bob', 'tg-thread', 'dm', '777', null);
    f.workspace.bindThread('web-thread', f.dot.id, 'Web', 'bob');
    const web = await f.platform.data.requestDataset(
        { kind: 'dot', userId: 'bob', dotId: f.dot.id, threadId: 'web-thread' },
        { name: 'From the web', description: '' },
    );
    expect(web.status).toBe('pending_approval');
    expect(sent).toEqual([]);
    const telegram = await f.platform.data.requestDataset(
        { kind: 'dot', userId: 'bob', dotId: f.dot.id, threadId: 'tg-thread' },
        { name: 'From Telegram', description: '' },
    );
    if (telegram.status !== 'pending_approval') {
        throw new Error('expected pending');
    }
    expect(sent).toEqual([
        [
            '777',
            `Approval needed: Sebas wants to create a dataset “From Telegram”.\nApprove or deny it below, or in Socio: https://brain.example/approvals/${telegram.id}\nThe socio carries on here once you decide.`,
        ],
    ]);
    expect(sent[0][1]).not.toMatch(/bob|Bob/);
});

it('keeps files in S3 when configured: moves local ones at start, serves them, and answers 503 while S3 is down', async () => {
    const s3 = await startFakeS3();
    cleanup.push(() => s3.close());
    const f = await fixture({
        driver: 's3',
        tenantId: 'main',
        s3: s3.settings(),
    });
    // A file from before S3, on the local disk.
    const before = new DataSpace(f.workspace.db, {
        dir: f.dir,
        secret: 'secret-0123456789abcdef-xyz',
        approvals: sqliteApprovals(f.workspace.db),
        workspace: f.workspace,
        ...dataSpaceStorage(f.dir),
    });
    await before.putFile({ kind: 'user', userId: 'alice' }, 'old.txt', Buffer.from('from before'));
    before.close();
    await f.platform.start();
    await vi.waitFor(() => expect(f.platform.data.pendingLocalFiles()).toBe(0));
    expect(s3.buckets.has('company-brain')).toBe(true);
    const raw = (path: string) => f.alice(`/data/files/raw?path=${encodeURIComponent(path)}`);
    expect(await (await raw('old.txt')).text()).toBe('from before');
    expect(
        (
            await f.alice('/data/files', 'PUT', {
                path: 'new.txt',
                content: 'in S3',
            })
        ).status,
    ).toBe(200);
    expect(await (await raw('new.txt')).text()).toBe('in S3');
    expect([...s3.objects.keys()]).toHaveLength(2);
    const setup = async () => (await json<{ setup: { storage?: string } }>(f.alice('/workspace'))).setup.storage;
    expect(await setup()).toBe('s3');
    s3.failNext(3, 503);
    const down = await raw('new.txt');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({
        error: 'File storage is unavailable; try again.',
    });
    expect(await setup()).toBe('s3_unreachable');
    expect(await f.platform.health()).toMatchObject({
        storage: 's3_unreachable',
    });
    expect(await (await raw('new.txt')).text()).toBe('in S3');
    expect(await setup()).toBe('s3');
});

it('shows the data key and backups in setup to admins only (CB-62, CB-63)', async () => {
    const f = await fixture();
    f.platform.useBackups(
        new BackupService({
            databasePath: join(f.dir, 'none.sqlite'),
            userDataDir: f.dir,
            settings: {
                directory: join(f.dir, 'backups'),
                keep: 3,
                intervalHours: 24,
            },
            log: () => {},
        }),
    );
    const alice = await json<{ setup: SetupStatus }>(f.alice('/workspace'));
    expect(alice.setup.dataKey).toEqual({
        configured: false,
        legacy: 0,
        previous: 0,
        unknown: 0,
    });
    expect(alice.setup.backup).toEqual({
        intervalHours: 24,
        offsite: false,
        running: false,
    });
    const bob = await json<{ setup: SetupStatus }>(f.bob('/workspace'));
    expect(bob.setup.dataKey).toBeUndefined();
    expect(bob.setup.backup).toBeUndefined();
    expect(bob.setup.storage).toBe('local');
});

it('leaves the file list out of the data space when asked (?files=false)', async () => {
    const f = await fixture();
    await f.platform.data.putFile(
        { kind: 'user', userId: 'alice' },
        'notes/plan.md',
        new TextEncoder().encode('# Plan'),
        'text/markdown',
    );
    const full = await json<DataSpaceState>(f.alice('/data'));
    expect(full.files?.map((file) => file.path)).toEqual(['notes/plan.md']);
    const light = await json<DataSpaceState>(f.alice('/data?files=false'));
    expect(light).not.toHaveProperty('files');
    expect(light.usage.own.files).toBe(1);
    expect(light.datasets).toEqual(full.datasets);
});

it('lets previous users manage company shared data without exposing personal data', async () => {
    const f = await fixture();
    const token = f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'socio').token;
    const computer = f.withToken(token);
    expect(
        (
            await computer('/data/files', 'PUT', {
                path: 'report.txt',
                content: 'Shared report',
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await computer('/data/datasets/scratch/tables', 'POST', {
                table: 'reports',
                columns: [{ name: 'title', type: 'TEXT' }],
            })
        ).status,
    ).toBe(200);
    await computer('/data/datasets/scratch/tables/reports/rows', 'POST', {
        rows: [{ title: 'Quarterly' }],
    });
    await f.alice('/data/files', 'PUT', {
        path: 'private.txt',
        content: 'Personal only',
    });
    expect(await json(f.bob('/data/shared'))).toEqual([]);
    expect((await f.bob(`/data/shared/${f.dot.id}/files?path=report.txt`, 'DELETE')).status).toBe(404);
    expect((await f.bob(`/data/shared/${f.dot.id}/files/raw?path=report.txt`)).status).toBe(404);

    f.workspace.bindThread('shared-user-test', f.dot.id, 'Previous use', 'bob');
    const areas = await json<import('@socio/shared/data-types').SharedAreaView[]>(f.bob('/data/shared'));
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({
        dotId: f.dot.id,
        retentionDays: 0,
        files: [{ path: 'report.txt', added: { by: 'Alice', via: 'computer' } }],
    });
    expect(areas[0].dataset?.tables[0]).toMatchObject({
        name: 'reports',
        rowCount: 1,
        created: { by: 'Alice' },
    });
    const id = areas[0].dataset!.id;
    expect((await json<DatasetDetail>(f.bob(`/data/datasets/${id}`))).dataset.access).toBe('shared');
    const download = await f.bob(`/data/shared/${f.dot.id}/files/raw?path=report.txt`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('Shared report');
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect((await f.bob(`/data/shared/${f.dot.id}/files/raw?path=private.txt`)).status).toBe(404);
    expect((await f.bob(`/data/shared/${f.dot.id}/files?path=../private.txt`, 'DELETE')).status).toBe(400);
    expect((await f.bob(`/data/shared/${f.dot.id}/files?path=report.txt`, 'DELETE')).status).toBe(200);
    const removed = f.workspace.db
        .prepare('SELECT deletedAt, deletedBy FROM data_files WHERE ownerUserId=?')
        .get(`socio:${f.dot.id}`);
    expect(removed).toMatchObject({
        deletedBy: 'bob',
        deletedAt: expect.any(Number),
    });
    expect((await f.alice('/data/files/raw?path=private.txt')).status).toBe(200);
    expect((await f.bob(`/data/shared/${f.dot.id}/tables/reports`, 'DELETE')).status).toBe(200);
    expect(await json(f.bob('/data/shared'))).toEqual([]);
    const query = await f.bob(`/data/datasets/${id}/query`, 'POST', {
        sql: 'SELECT * FROM _deleted_reports',
    });
    expect(query.status).toBe(400);
});

it('allows shared computer file cleanup but rejects personal and promoted-app tokens', async () => {
    const f = await fixture();
    const shared = f.withToken(f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'socio').token);
    await shared('/data/files', 'PUT', { path: 'obsolete.txt', content: 'Old' });
    const personal = f.withToken(f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token);
    expect((await personal('/data/files?path=obsolete.txt', 'DELETE')).status).toBe(403);
    const app = f.withToken(
        f.platform.data.tokens.issue({
            userId: 'alice',
            dotId: f.dot.id,
            purpose: 'app',
            session: 'app-test',
            appId: 'ungranted',
            reach: 'socio',
        }),
    );
    expect((await app('/data/files?path=obsolete.txt', 'DELETE')).status).toBe(403);
    const job = f.withToken(
        f.platform.data.tokens.issue({
            userId: 'alice',
            dotId: f.dot.id,
            purpose: 'job',
            session: 'job-test',
            reach: 'socio',
        }),
    );
    expect((await job('/data/files?path=obsolete.txt', 'DELETE')).status).toBe(403);
    expect((await shared(`/data/shared/${f.dot.id}/files?path=obsolete.txt`, 'DELETE')).status).toBe(403);
    expect((await shared('/data/files?path=obsolete.txt', 'DELETE')).status).toBe(200);
    expect((await shared('/data/files/raw?path=obsolete.txt')).status).toBe(404);
});

it('retains shared data by default and only expires aged shared items when configured', async () => {
    const f = await fixture();
    const computer = f.withToken(f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'socio').token);
    await computer('/data/files', 'PUT', { path: 'old.txt', content: 'Old' });
    await computer('/data/files', 'PUT', { path: 'fresh.txt', content: 'Fresh' });
    await f.alice('/data/files', 'PUT', {
        path: 'private.txt',
        content: 'Private',
    });
    const old = Date.now() - 3 * 86400000;
    f.workspace.db.prepare('UPDATE data_files SET updatedAt=? WHERE path LIKE ?').run(old, '%old.txt');
    f.workspace.db.prepare('UPDATE data_files SET updatedAt=? WHERE ownerUserId=?').run(old, 'alice');
    expect(await f.platform.data.applySharedRetention()).toBe(0);
    expect(
        (
            await f.alice('/settings', 'PATCH', {
                limits: { dataSharedRetentionDays: 1 },
            })
        ).status,
    ).toBe(200);
    expect(await f.platform.data.applySharedRetention()).toBe(1);
    expect((await computer('/data/files/raw?path=old.txt')).status).toBe(404);
    expect((await computer('/data/files/raw?path=fresh.txt')).status).toBe(200);
    expect((await f.alice('/data/files/raw?path=private.txt')).status).toBe(200);
});

it('recognizes computer use and team topics without granting access to personal socios', async () => {
    const f = await fixture();
    expect(f.platform.data.canSeeShared('bob', f.dot.id)).toBe(false);
    f.workspace.computers.begin(f.dot.id, 'files.list', 'owner', 'bob');
    expect(f.platform.data.canSeeShared('bob', f.dot.id)).toBe(true);
    const teamDot = f.workspace.createDot(f.dot.spaceId, 'Team', '', false, false);
    f.workspace.bindThread('topic-shared-test', teamDot.id, 'Topic', 'alice');
    await f.workspace.telegram.bindThread('topic-shared-test', 'topic-shared-test', 'topic', '-100', '42');
    expect(f.platform.data.canSeeShared('bob', teamDot.id)).toBe(false);
    await f.workspace.telegram.recordMember('-100', 'bob');
    expect(f.platform.data.canSeeShared('bob', teamDot.id)).toBe(true);
    const personal = f.workspace.createDot(
        f.dot.spaceId,
        'Private',
        '',
        false,
        false,
        [f.dot.spaceId],
        null,
        false,
        null,
        false,
        'alice',
    );
    expect(f.platform.data.canSeeShared('bob', personal.id)).toBe(false);
    expect(f.platform.data.canSeeShared('alice', personal.id)).toBe(false);
});

it('answers a table’s changes since a sync token to its readers only, 304 when unchanged (CB-451)', async () => {
    const f = await fixture();
    const token = f.platform.data.tokens.forCommand('alice', f.dot.id, 60_000, 'person').token;
    const computer = f.withToken(token);
    await computer('/data/datasets/scratch/tables', 'POST', {
        table: 'customers',
        columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'name', type: 'TEXT' },
        ],
    });
    await computer('/data/datasets/scratch/tables/customers/rows', 'POST', { rows: [{ id: 'c1', name: 'Acme' }] });
    const scratch = (await json<DataSpaceState>(f.alice('/data'))).datasets.find((d) => d.kind === 'scratch')!;
    const route = `/data/datasets/${scratch.id}/tables/customers/changes`;
    // No token yet: another generation answers reconcile, with the token to start from.
    const first = await f.alice(`${route}?since=start.0`);
    expect(first.status).toBe(200);
    const start = rowChanges.parse(await first.json());
    expect(start).toMatchObject({ schema: 1, reconcile: true, upserts: [], deleted: [] });
    await computer('/data/datasets/scratch/tables/customers/rows', 'POST', {
        rows: [{ id: 'c1', name: 'Acme Inc' }],
        key: ['id'],
    });
    const read = await f.alice(`${route}?since=${start.token}`);
    const tag = read.headers.get('etag')!;
    const page = rowChanges.parse(await read.json());
    expect(page.upserts).toEqual([{ key: '"c1"', stamp: page.token, values: { id: 'c1', name: 'Acme Inc' } }]);
    expect((await f.alice(`${route}?since=${start.token}`, 'GET', undefined, { 'If-None-Match': tag })).status).toBe(
        304,
    );
    expect((await f.alice(route)).status).toBe(400);
    expect((await f.alice(`${route}?since=nope`)).status).toBe(400);
    expect((await f.bob(`${route}?since=${start.token}`)).status).toBe(404);
});
