import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Message } from '@ag-ui/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { DataSpaceState } from '@socio/shared/data-types';
import { VIEW_NO_ACCESS } from '@socio/shared/dataset-view';
import type { MediaListing, UploadResult } from '@socio/shared/media-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { DataLimits } from '../src/server/dataspace/contract.js';

import { PNG } from './fixtures/media.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-64 pass 2: a deleted dataset, file, folder or attachment is gone from
// every listing and lookup for users, Dots and tokens, and its row and
// bytes are still there.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(limits?: Partial<DataLimits>) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-soft-delete-data-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            runtimeUrl: '',
            sessionSecret: 'secret-0123456789abcdef-xyz',
            data: { userDataDir: dir, limits },
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
        const request = (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const upload = async (bytes: Uint8Array, name: string, query = 'purpose=attachment') => {
            const response = await app.request(`/api/media/uploads?${query}`, {
                method: 'POST',
                headers: {
                    cookie,
                    'Content-Type': 'application/octet-stream',
                    'X-CB-Upload': '1',
                    'X-File-Name': encodeURIComponent(name),
                },
                body: new Uint8Array(bytes),
            });
            expect(response.status).toBe(201);
            return (await response.json()) as UploadResult;
        };
        return Object.assign(request, { upload });
    };
    const dot = workspace.dots()[0];
    return {
        platform,
        workspace,
        data: platform.data,
        media: platform.media,
        db: workspace.db,
        dot,
        as,
        alice: await as('alice'),
        dotActor: { kind: 'dot' as const, userId: 'alice', dotId: dot.id },
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
const text = (value: string) => Buffer.from(value);
const DAY = 86_400_000;

it('hides a deleted file from Media, search, the Data page, Dot tools and by id, and keeps its row and bytes', async () => {
    const f = await fixture();
    const { item } = await f.alice.upload(text('quarterly numbers'), 'report.md', 'purpose=file&folder=reports/');
    f.data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'reports/',
        access: 'read',
    });
    expect((await f.data.getFile(f.dotActor, 'reports/report.md')).data.toString()).toBe('quarterly numbers');

    expect((await f.alice(`/media/items/${item.id}`, 'DELETE')).status).toBe(200);
    // The app: by id, its content, the folder, search, the Data page, raw.
    expect((await f.alice(`/media/items/${item.id}`)).status).toBe(404);
    expect((await f.alice(`/media/items/${item.id}/content`)).status).toBe(404);
    const listing = await json<MediaListing>(f.alice('/media?folder=reports/'));
    expect(listing.items).toEqual([]);
    expect(listing.tree).toEqual([]);
    expect((await json<MediaListing>(f.alice('/media?q=report'))).items).toEqual([]);
    expect((await json<DataSpaceState>(f.alice('/data'))).files).toEqual([]);
    expect((await f.alice('/data/files/raw?path=reports/report.md')).status).toBe(404);
    // Dots and tokens: files_list, files_get.
    expect(f.data.listFiles(f.dotActor)).toEqual([]);
    await expect(f.data.getFile(f.dotActor, 'reports/report.md')).rejects.toMatchObject({ status: 404 });
    expect(f.data.listFiles({ kind: 'token', userId: 'alice', dotId: f.dot.id })).toEqual([]);
    // Kept: the row with its stamp, and the sealed bytes.
    expect(f.data.withDeletedFile(item.id)).toMatchObject({
        path: 'reports/report.md',
        deletedAt: expect.any(Number),
        deletedBy: 'alice',
        deletedWith: null,
    });
    expect((await f.data.withDeletedContent(item.id)).toString()).toBe('quarterly numbers');
    expect(
        f.data
            .auditFor('alice')
            .some((entry) => entry.action === 'files_delete' && entry.target === 'reports/report.md'),
    ).toBe(true);
    // The path is free: the same name gets it again, as a new file.
    const again = await f.alice.upload(text('new numbers'), 'report.md', 'purpose=file&folder=reports/');
    expect(again.item.path).toBe('reports/report.md');
    expect(again.item.id).not.toBe(item.id);
    expect((await f.data.getFile(f.dotActor, 'reports/report.md')).data.toString()).toBe('new numbers');
    // Writing over the new one never touches the deleted one.
    await f.data.putFile({ kind: 'user', userId: 'alice' }, 'reports/report.md', text('newer numbers'));
    expect((await f.data.withDeletedContent(item.id)).toString()).toBe('quarterly numbers');
    // Moving a file onto a deleted file's path is fine too.
    await f.alice.upload(text('draft'), 'draft.md', 'purpose=file');
    await f.data.deleteFile('alice', 'draft.md');
    await f.data.moveFile('alice', 'reports/report.md', 'draft.md');
    expect(f.data.listFiles(f.dotActor)).toEqual([]);
});

it('frees quota when a file or dataset is deleted, and shows operators what is kept', async () => {
    const f = await fixture({ userMaxBytes: 4096 });
    const big = new Uint8Array(3000).fill(65);
    const first = await f.alice.upload(big, 'big.bin', 'purpose=file');
    await expect(f.data.putFile({ kind: 'user', userId: 'alice' }, 'more.bin', big)).rejects.toMatchObject({
        status: 413,
    });
    await f.alice(`/media/items/${first.item.id}`, 'DELETE');
    expect(f.data.usage('alice')).toMatchObject({ files: 0, fileBytes: 0 });
    await f.data.putFile({ kind: 'user', userId: 'alice' }, 'more.bin', big);

    const dataset = f.data.createDataset('alice', { name: 'Prices' });
    const before = f.data.usage('alice');
    f.data.deleteDataset('alice', dataset.id);
    expect(f.data.usage('alice')).toMatchObject({
        datasets: before.datasets - 1,
        datasetBytes: before.datasetBytes - dataset.sizeBytes,
    });
    const alice = f.data.usageAll().find((entry) => entry.userId === 'alice')!;
    expect(alice).toMatchObject({
        files: 1,
        deletedFiles: 1,
        deletedDatasets: 1,
    });
    expect(alice.deletedBytes).toBeGreaterThan(3000 + dataset.sizeBytes - 1);
    // Operators see it in the Data page's usage; a user's own usage doesn't.
    const usage = await json<{ own: Record<string, unknown> }>(f.alice('/data/usage'));
    expect(usage.own.deletedBytes).toBeUndefined();
});

it('hides a deleted file’s attachments with it; one removed before keeps its own stamp', async () => {
    const f = await fixture();
    const thread = await f.platform.createConversation(f.dot.id, 'A', 'alice');
    const turn = { userId: 'alice', dotId: f.dot.id, threadId: thread.id };
    const sent = (await f.alice.upload(PNG, 'shot.png')).attachment!;
    await f.media.bind((await f.media.attachment(sent.id))!, turn, 'message-1');
    const path = f.media.view((await f.media.attachment(sent.id))!).path!;
    const fileId = f.data.fileAt('alice', path)!.id;
    expect((await f.media.forThread(thread.id)).map((row) => row.id)).toEqual([sent.id]);
    // Shown in the conversation, its Dot reads it without a grant.
    expect((await f.data.getFile({ ...f.dotActor, threadId: thread.id }, path)).data.length).toBe(PNG.length);

    expect((await f.alice(`/media/items/${fileId}`, 'DELETE')).status).toBe(200);
    expect((await f.alice(`/media/attachments/${sent.id}`)).status).toBe(404);
    expect((await f.alice(`/media/attachments/${sent.id}/content`)).status).toBe(404);
    // attachments_list reads forThread; the Dot can't read it by path either.
    expect(await f.media.forThread(thread.id)).toEqual([]);
    await expect(f.data.getFile({ ...f.dotActor, threadId: thread.id }, path)).rejects.toMatchObject({ status: 404 });
    // History tells the model it was deleted.
    const [message] = await f.media.resolveForModel({ ...turn, maxImages: 4 }, [
        {
            id: 'message-1',
            role: 'user',
            content: [
                { type: 'text', text: 'look' },
                {
                    type: 'binary',
                    id: sent.id,
                    mimeType: 'image/png',
                    filename: 'shot.png',
                },
            ],
        } as unknown as Message,
    ]);
    expect(JSON.stringify(message.content)).toContain('since been deleted');
    expect(await f.media.withDeletedAttachment(sent.id)).toMatchObject({
        deletedAt: expect.any(Number),
        deletedBy: 'alice',
        deletedWith: `file:${fileId}`,
    });

    // Removed from the composer before it was sent: the attachment is
    // stamped on its own, and its file goes with it.
    const pending = await f.alice.upload(PNG, 'draft.png');
    expect((await f.alice(`/media/attachments/${pending.attachment!.id}`, 'DELETE')).status).toBe(200);
    expect(await f.media.withDeletedAttachment(pending.attachment!.id)).toMatchObject({
        deletedBy: 'alice',
        deletedWith: null,
    });
    expect(f.data.withDeletedFile(pending.item.id)).toMatchObject({
        deletedBy: 'alice',
        deletedWith: `attachment:${pending.attachment!.id}`,
    });
    expect(f.data.usage('alice').files).toBe(0);
});

it('collects unsent attachments as the system, and keeps them (soft, nothing hard-deleted)', async () => {
    const f = await fixture();
    const stale = await f.alice.upload(PNG, 'stale.png');
    // One the user moved out of attachments/ to keep: only its attachment goes.
    const moved = await f.alice.upload(PNG, 'kept.png');
    await f.data.moveFile('alice', moved.item.path, 'keep/kept.png');
    const fresh = await f.alice.upload(PNG, 'fresh.png');
    const count = (table: string) => Number(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    const rowsBefore = {
        files: count('data_files'),
        attachments: count('media_attachments'),
    };
    const objectDeletes = vi.spyOn(f.data.objects, 'delete');
    const later = Date.now() + DAY + 1000;
    // One made just before the tick: younger than a day, so it stays.
    f.db.prepare('UPDATE media_attachments SET createdAt=? WHERE id=?').run(later, fresh.attachment!.id);

    expect(await f.media.collectPending(later)).toBe(2);
    expect(await f.media.attachment(stale.attachment!.id)).toBeUndefined();
    expect(await f.media.withDeletedAttachment(stale.attachment!.id)).toMatchObject({
        deletedAt: expect.any(Number),
        deletedBy: 'system',
        deletedWith: null,
    });
    expect(f.data.withDeletedFile(stale.item.id)).toMatchObject({
        deletedAt: expect.any(Number),
        deletedBy: 'system',
        deletedWith: `attachment:${stale.attachment!.id}`,
    });
    // The bytes are kept, in the store the row names, under the same key.
    expect((await f.data.withDeletedContent(stale.item.id)).equals(Buffer.from(PNG))).toBe(true);
    // The moved file stays live; its attachment is stamped on its own.
    expect(await f.media.withDeletedAttachment(moved.attachment!.id)).toMatchObject({
        deletedBy: 'system',
    });
    expect(f.data.withDeletedFile(moved.item.id)).toMatchObject({
        path: 'keep/kept.png',
        deletedAt: null,
    });
    // A day hasn't passed for the fresh one.
    expect(await f.media.attachment(fresh.attachment!.id)).toBeDefined();
    // Nothing was hard-deleted: every row is still there, no object removed.
    expect({
        files: count('data_files'),
        attachments: count('media_attachments'),
    }).toEqual(rowsBefore);
    expect(objectDeletes).not.toHaveBeenCalled();
    expect(f.data.usage('alice').files).toBe(2);
    // Already collected: the next tick finds nothing.
    expect(await f.media.collectPending(later)).toBe(0);
});

it('deletes a folder’s files with it, stamped with the folder; a file deleted before keeps its own stamp', async () => {
    const f = await fixture();
    const a = await f.alice.upload(text('a'), 'a.txt', 'purpose=file&folder=projects/x/');
    const b = await f.alice.upload(text('b'), 'b.txt', 'purpose=file&folder=projects/');
    const c = await f.alice.upload(text('c'), 'c.txt', 'purpose=file&folder=projects/');
    f.data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'projects/',
        access: 'write',
    });
    await f.alice(`/media/items/${c.item.id}`, 'DELETE');
    const deleted = await f.alice('/media/folders?path=projects/&recursive=1', 'DELETE');
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect(
        [a, b, c].map(({ item }) => {
            const row = f.data.withDeletedFile(item.id)!;
            return [row.path, row.deletedBy, row.deletedWith];
        }),
    ).toEqual([
        ['projects/x/a.txt', 'alice', 'folder:projects/'],
        ['projects/b.txt', 'alice', 'folder:projects/'],
        ['projects/c.txt', 'alice', null],
    ]);
    expect((await json<MediaListing>(f.alice('/media'))).tree.filter((path) => path.startsWith('projects/'))).toEqual(
        [],
    );
    // Its grants end (security state), audited; a new folder starts bare.
    expect(f.data.grants('alice')).toEqual([]);
    expect(
        f.data
            .auditFor('alice')
            .some((entry) => entry.action === 'revoke' && entry.detail?.includes('the folder was deleted')),
    ).toBe(true);
    const fresh = await f.alice.upload(text('a again'), 'a.txt', 'purpose=file&folder=projects/x/');
    expect(fresh.item.path).toBe('projects/x/a.txt');
    await expect(f.data.getFile(f.dotActor, 'projects/x/a.txt')).rejects.toMatchObject({ status: 404 });
});

it('hides a deleted dataset from the Data page, Dots, tokens, exports and page views, keeps its file, and ends its grants', async () => {
    const f = await fixture();
    const space = f.workspace.spaces()[0];
    const created = await json<{ id: string }>(f.alice('/data/datasets', 'POST', { name: 'Prices' }));
    const id = created.id;
    f.data.setGrant('alice', { dotId: f.dot.id, datasetId: id, access: 'write' });
    await f.data.write(f.dotActor, id, {
        op: 'create_table',
        input: { table: 'prices', columns: [{ name: 'item', type: 'TEXT' }] },
    });
    await f.data.write(f.dotActor, id, {
        op: 'insert',
        table: 'prices',
        rows: [{ item: 'tea' }],
    });
    f.data.updateDataset('alice', id, { sharedSpaceId: space.id });
    expect(f.data.viewable('alice', id, space.id).name).toBe('Prices');

    expect((await f.alice(`/data/datasets/${id}`, 'DELETE')).status).toBe(200);
    // The app: the Data page, by id, rows, exports, query.
    const state = await json<DataSpaceState>(f.alice('/data'));
    expect(state.datasets.map((dataset) => dataset.id)).not.toContain(id);
    expect(state.grants).toEqual([]);
    for (const path of [
        `/data/datasets/${id}`,
        `/data/datasets/${id}/tables/prices/rows`,
        `/data/datasets/${id}/export.csv?table=prices`,
        `/data/datasets/${id}/export.sqlite`,
    ]) {
        expect((await f.alice(path)).status, path).toBe(404);
    }
    expect(
        (
            await f.alice(`/data/datasets/${id}/query`, 'POST', {
                sql: 'SELECT * FROM prices',
            })
        ).status,
    ).toBe(404);
    // Another member of the Space doesn't see it; page views say no access.
    const bob = (await json<DataSpaceState>((await f.as('bob'))('/data'))).datasets;
    expect(bob.map((dataset) => dataset.id)).not.toContain(id);
    expect(() => f.data.viewable('alice', id, space.id)).toThrow(VIEW_NO_ACCESS);
    // Dots and tokens: data_list, data_describe, data_query.
    expect(f.data.list(f.dotActor).map((entry) => entry.id)).not.toContain(id);
    expect(() => f.data.describe(f.dotActor, id)).toThrow(/No dataset/);
    await expect(f.data.query(f.dotActor, id, 'SELECT * FROM prices')).rejects.toMatchObject({ status: 404 });
    expect(f.data.list({ kind: 'token', userId: 'alice', dotId: f.dot.id }).map((entry) => entry.id)).not.toContain(id);
    // Writes refuse it: no grant can be given back, no change made.
    expect(() =>
        f.data.setGrant('alice', {
            dotId: f.dot.id,
            datasetId: id,
            access: 'read',
        }),
    ).toThrow('Dataset not found.');
    expect(() => f.data.updateDataset('alice', id, { name: 'Again' })).toThrow('Dataset not found.');
    // Kept: the row with its stamp, and its SQLite file with its rows.
    const row = f.data.withDeletedDataset(id)!;
    expect(row).toMatchObject({
        name: 'Prices',
        deletedAt: expect.any(Number),
        deletedBy: 'alice',
        deletedWith: null,
    });
    expect(existsSync(f.data.datasetPath(row))).toBe(true);
    const file = new DatabaseSync(f.data.datasetPath(row), { readOnly: true });
    cleanup.push(() => file.close());
    expect(file.prepare('SELECT item FROM prices').all()).toEqual([{ item: 'tea' }]);
    // Its grant ended, audited with what it allowed.
    expect(f.data.auditFor('alice', { datasetId: id }).map((entry) => [entry.action, entry.detail])).toEqual(
        expect.arrayContaining([
            ['delete', null],
            ['revoke', `${f.dot.name}: write; the dataset was deleted`],
        ]),
    );
});

it('makes room for a new scratch dataset once the Dot’s is deleted', async () => {
    const f = await fixture();
    // A person's own socio: its scratch is Alice's (a company socio's is its
    // shared dataset, CB-337).
    const home = f.dot.spaceId;
    const dot = f.workspace.createDot(
        home,
        'Helper',
        'Helps.',
        false,
        false,
        [home],
        null,
        false,
        null,
        false,
        'alice',
    );
    const first = f.data.scratch('alice', dot.id)!;
    f.data.deleteDataset('alice', first.id);
    const second = f.data.scratch('alice', dot.id)!;
    expect(second.id).not.toBe(first.id);
    expect(f.data.list({ ...f.dotActor, dotId: dot.id }).map((entry) => entry.id)).toEqual([second.id]);
    expect(f.data.withDeletedDataset(first.id)).toMatchObject({
        scratchForDotId: dot.id,
        deletedBy: 'alice',
    });
});

it('applies retention as the system: the dataset is hidden and kept, once', async () => {
    const f = await fixture();
    const dataset = f.data.createDataset('alice', { name: 'Logs' });
    f.data.updateDataset('alice', dataset.id, { retentionDays: 1 });
    expect(f.data.applyRetention(Date.now() + 2 * DAY)).toBe(1);
    expect(f.data.datasetsFor('alice').map((entry) => entry.id)).not.toContain(dataset.id);
    const row = f.data.withDeletedDataset(dataset.id)!;
    expect(row).toMatchObject({ deletedBy: 'system', deletedWith: null });
    expect(existsSync(f.data.datasetPath(row))).toBe(true);
    expect(
        f.data.auditFor('alice', { datasetId: dataset.id }).map((entry) => [entry.actorKind, entry.action]),
    ).toContainEqual(['system', 'retention_delete']);
    // Already hidden: retention doesn't find it again.
    expect(f.data.applyRetention(Date.now() + 4 * DAY)).toBe(0);
});
