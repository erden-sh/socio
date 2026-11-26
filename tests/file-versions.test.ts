import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { StorageUnavailableError } from '@socio/data/object-store';
import type { MediaListing, UploadResult } from '@socio/shared/media-types';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { LocalObjectStore } from '../src/server/storage/local-store.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// An overwrite keeps the previous bytes as a soft-deleted version of the
// file, and a folder move is one transaction for its files, markers and
// grants.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'secret-0123456789abcdef-xyz';

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-file-versions-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            runtimeUrl: '',
            sessionSecret: SECRET,
            data: { userDataDir: dir },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const alice = (path: string, method = 'GET', body?: unknown) =>
        app.request(`/api${path}`, {
            method,
            headers: {
                cookie,
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const upload = async (bytes: Uint8Array, name: string, query: string) => {
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
    const dot = workspace.dots()[0];
    return {
        dir,
        data: platform.data,
        db: workspace.db,
        dot,
        alice,
        /** A GET as alice with headers of its own (If-None-Match). */
        aliceWith: (path: string, headers: Record<string, string>) =>
            app.request(`/api${path}`, { headers: { cookie, ...headers } }),
        upload,
        user: { kind: 'user' as const, userId: 'alice' },
        dotActor: { kind: 'dot' as const, userId: 'alice', dotId: dot.id },
    };
}
const text = (value: string) => Buffer.from(value);
const objectCount = (dir: string) => readdirSync(join(dir, 'alice', 'files')).length;

it('keeps the previous bytes of an overwritten file as a soft-deleted version that no live read sees', async () => {
    const f = await fixture();
    await f.data.putFile(f.user, 'reports/q3.md', text('first draft'), 'text/markdown');
    const live = f.data.fileAt('alice', 'reports/q3.md')!;
    const before = f.data.usage('alice');
    // A Dot with a grant rewrites it, then the user does.
    f.data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'reports/',
        access: 'write',
    });
    await f.data.putFile(f.dotActor, 'reports/q3.md', text('second, longer draft'));
    await f.data.putFile(f.user, 'reports/q3.md', text('final'), 'text/markdown');

    // The live file keeps its id and has the newest bytes.
    expect(f.data.fileAt('alice', 'reports/q3.md')!.id).toBe(live.id);
    expect((await f.data.getFile(f.user, 'reports/q3.md')).data.toString()).toBe('final');
    const versions = f.data.withDeletedVersions(live.id);
    expect(
        versions.map((row) => [
            row.path,
            row.size,
            row.mediaType,
            row.deletedBy,
            row.deletedWith,
            row.deletedAt !== null,
        ]),
    ).toEqual([
        ['reports/q3.md', 'first draft'.length, 'text/markdown', `dot:${f.dot.id}`, `file:${live.id}`, true],
        ['reports/q3.md', 'second, longer draft'.length, 'application/octet-stream', 'alice', `file:${live.id}`, true],
    ]);
    expect(
        await Promise.all(versions.map(async (row) => (await f.data.withDeletedContent(row.id)).toString())),
    ).toEqual(['first draft', 'second, longer draft']);
    // Live reads never see a version: by path, lists, Media, Dot tools.
    expect(f.data.fileRecords('alice').map((file) => file.id)).toEqual([live.id]);
    expect(f.data.listFiles(f.user).map((file) => file.path)).toEqual(['reports/q3.md']);
    expect(f.data.listFiles(f.dotActor, 'reports/')).toHaveLength(1);
    for (const version of versions) {
        expect(f.data.fileRecord('alice', version.id)).toBeUndefined();
        await expect(f.data.getFileById(f.user, version.id)).rejects.toMatchObject({
            status: 404,
        });
        expect((await f.alice(`/media/items/${version.id}`)).status).toBe(404);
    }
    const listing = (await (await f.alice('/media?folder=reports/')).json()) as MediaListing;
    expect(listing.items.map((item) => item.id)).toEqual([live.id]);
    // Versions don't count against the quota; operators see them as kept.
    const after = f.data.usage('alice');
    expect(after.files).toBe(1);
    expect(after.fileBytes).toBe(before.fileBytes - 'first draft'.length + 'final'.length);
    const all = f.data.usageAll().find((row) => row.userId === 'alice')!;
    expect(all).toMatchObject({ ...after, userName: 'Alice' });
    expect(all.deletedFiles).toBe(2);
    expect(all.deletedBytes).toBe(versions.reduce((sum, row) => sum + row.storedSize, 0));
    // Each version is its own object: one per overwrite, plus the live one.
    expect(objectCount(f.dir)).toBe(3);
    // The audit says a version was kept.
    expect(
        f.data
            .auditFor('alice')
            .filter((entry) => entry.action === 'files_put')
            .map((entry) => entry.detail),
    ).toEqual(expect.arrayContaining(['5 bytes; the previous version is kept', '11 bytes']));
});

it('keeps no version when the new bytes equal the old ones', async () => {
    const f = await fixture();
    await f.data.putFile(f.user, 'daily/report.md', text('same numbers'));
    const live = f.data.fileAt('alice', 'daily/report.md')!;
    await f.data.putFile(f.user, 'daily/report.md', text('same numbers'), 'text/markdown');
    await f.data.copyFile(f.user, 'daily/report.md', 'daily/report.md');
    expect(f.data.withDeletedVersions(live.id)).toEqual([]);
    expect(objectCount(f.dir)).toBe(1);
    expect(f.data.usageAll().find((row) => row.userId === 'alice')).toMatchObject({ deletedFiles: 0, deletedBytes: 0 });
    // The row still takes the new media type.
    expect(f.data.fileAt('alice', 'daily/report.md')!.mediaType).toBe('text/markdown');
    expect((await f.data.getFile(f.user, 'daily/report.md')).data.toString()).toBe('same numbers');
});

it('keeps a version on copies onto a file and on API writes, and an attachment still resolves after its file is overwritten', async () => {
    const f = await fixture();
    const { item, attachment } = await f.upload(text('original upload'), 'notes.txt', 'purpose=attachment');
    expect(attachment).toBeDefined();
    // Overwritten through the API, as a computer or job would.
    const put = await f.alice('/data/files', 'PUT', {
        path: item.path,
        content: 'edited by a job',
    });
    expect(put.status).toBe(200);
    const content = await f.alice(`/media/attachments/${attachment!.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('edited by a job');
    expect((await f.alice(`/media/attachments/${attachment!.id}`)).status).toBe(200);
    // A copy onto it keeps the edit as a version too.
    await f.data.putFile(f.user, 'other.txt', text('from elsewhere'));
    await f.data.copyFile(f.user, 'other.txt', item.path);
    const versions = f.data.withDeletedVersions(item.id);
    expect(
        await Promise.all(versions.map(async (row) => (await f.data.withDeletedContent(row.id)).toString())),
    ).toEqual(['original upload', 'edited by a job']);
    expect(await (await f.alice(`/media/attachments/${attachment!.id}/content`)).text()).toBe('from elsewhere');
});

it('answers a 304 to a copy whose bytes are still the file’s, and the new bytes once the file under an attachment is overwritten', async () => {
    const f = await fixture();
    const { item, attachment } = await f.upload(text('original upload'), 'notes.txt', 'purpose=attachment');
    for (const url of [`/media/attachments/${attachment!.id}/content`, `/media/items/${item.id}/content`]) {
        const first = await f.alice(url);
        const etag = first.headers.get('etag');
        expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
        expect(await first.text()).toBe('original upload');
        // The copy is current: no bytes, the same tag (weak or in a list, as a client may send it).
        for (const ifNoneMatch of [etag!, `W/${etag!}`, `"other", ${etag!}`, '*']) {
            const again = await f.aliceWith(url, { 'if-none-match': ifNoneMatch });
            expect(again.status).toBe(304);
            expect(again.headers.get('etag')).toBe(etag);
            expect(again.headers.get('cache-control')).toBe('private, no-cache');
            expect(await again.text()).toBe('');
        }
        expect((await f.aliceWith(url, { 'if-none-match': '"other"' })).status).toBe(200);
    }
    const before = (await f.alice(`/media/attachments/${attachment!.id}/content`)).headers.get('etag')!;
    expect((await f.alice('/data/files', 'PUT', { path: item.path, content: 'edited by a job' })).status).toBe(200);
    // Replaced under the same ids: the old tag no longer matches, and the answer is the new bytes.
    for (const url of [`/media/attachments/${attachment!.id}/content`, `/media/items/${item.id}/content`]) {
        const after = await f.aliceWith(url, { 'if-none-match': before });
        expect(after.status).toBe(200);
        expect(await after.text()).toBe('edited by a job');
        expect(after.headers.get('etag')).not.toBe(before);
    }
});

/** A data space over the local disk whose puts can be made to fail. */
function failingSpace(secret = SECRET) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-file-versions-store-'));
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const local = new LocalObjectStore(dir);
    let failAt: ((key: string) => boolean) | undefined;
    const objects: typeof local = Object.assign(Object.create(local), {
        driver: local.driver,
        put: (key: string, body: Uint8Array) => {
            if (failAt?.(key)) {
                return Promise.reject(new StorageUnavailableError('injected'));
            }
            return local.put(key, body);
        },
    });
    const open = (with_ = secret) =>
        new DataSpace(workspace.db, {
            dir,
            secret: with_,
            approvals: sqliteApprovals(workspace.db),
            workspace,
            objects,
            ...dataSpaceStorage(dir, local),
        });
    const space = open();
    cleanup.push(() => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return {
        dir,
        db: workspace.db,
        space,
        open,
        fail: (when?: (key: string) => boolean) => (failAt = when),
    };
}

it('leaves the file as it was, with no version, when writing the new bytes fails', async () => {
    const f = failingSpace();
    const user = { kind: 'user' as const, userId: 'alice' };
    await f.space.putFile(user, 'plan.md', text('v1'));
    const { id } = f.space.fileAt('alice', 'plan.md')!;
    // The version's copy is written; the live object's put then fails.
    f.fail((key) => key.endsWith(`${id}.bin`));
    await expect(f.space.putFile(user, 'plan.md', text('v2'))).rejects.toMatchObject({ status: 503 });
    f.fail(undefined);
    expect((await f.space.getFile(user, 'plan.md')).data.toString()).toBe('v1');
    expect(f.space.withDeletedVersions(id)).toEqual([]);
    expect(objectCount(f.dir)).toBe(1);
    // Writing the copy fails: nothing changes either.
    f.fail((key) => !key.endsWith(`${id}.bin`));
    await expect(f.space.putFile(user, 'plan.md', text('v2'))).rejects.toMatchObject({ status: 503 });
    f.fail(undefined);
    expect((await f.space.getFile(user, 'plan.md')).data.toString()).toBe('v1');
    expect(objectCount(f.dir)).toBe(1);
    await f.space.putFile(user, 'plan.md', text('v2'));
    expect(f.space.withDeletedVersions(id)).toHaveLength(1);
});

it('refuses to overwrite bytes it can’t read, since the version would be lost', async () => {
    const f = failingSpace();
    const user = { kind: 'user' as const, userId: 'alice' };
    await f.space.putFile(user, 'sealed.txt', text('under the first secret'));
    const other = f.open('another-secret-0123456789abcdef');
    cleanup.push(() => other.close());
    await expect(other.putFile(user, 'sealed.txt', text('new'))).rejects.toMatchObject({ status: 409 });
    expect((await f.space.getFile(user, 'sealed.txt')).data.toString()).toBe('under the first secret');
});

it('moves a folder whole or not at all: a failure halfway leaves files, markers and grants where they were (16.3c)', async () => {
    const f = await fixture();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        await f.data.putFile(f.user, `drafts/${name}`, text(name));
    }
    expect((await f.alice('/media/folders', 'POST', { path: 'drafts/empty/' })).status).toBe(201);
    f.data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'drafts/',
        access: 'write',
    });
    const state = () => ({
        files: f.data.fileRecords('alice').map((file) => file.path),
        grants: f.data.grants('alice').map((grant) => grant.folder),
        tree: f.db
            .prepare('SELECT path FROM media_folders ORDER BY path')
            .all()
            .map((row) => row.path),
    });
    const before = state();
    expect(before).toEqual({
        files: ['drafts/a.txt', 'drafts/b.txt', 'drafts/c.txt'],
        grants: ['drafts/'],
        tree: ['drafts/empty/'],
    });
    // An injected failure on the second file's move, after the first moved.
    f.db.exec(
        `CREATE TRIGGER fail_move BEFORE UPDATE OF path ON data_files WHEN NEW.path = 'final/b.txt' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    const failed = await f.alice('/media/folders', 'PATCH', {
        from: 'drafts/',
        to: 'final/',
    });
    expect(failed.status).toBe(500);
    expect(state()).toEqual(before);
    f.db.exec('DROP TRIGGER fail_move');
    // An injected failure in the grants' step, after every file moved.
    f.db.exec(
        `CREATE TRIGGER fail_grant BEFORE INSERT ON data_grants WHEN NEW.folder = 'final/' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    // The repositories' Drizzle query error carries SQLite's (CB-110).
    await expect(f.data.moveFolder('alice', 'drafts/', 'final/')).rejects.toMatchObject({
        cause: expect.objectContaining({
            message: expect.stringContaining('injected failure'),
        }),
    });
    expect(state()).toEqual(before);
    // The Dot still reads and writes where it did, and nothing is at the target.
    expect((await f.data.getFile(f.dotActor, 'drafts/a.txt')).data.toString()).toBe('a.txt');
    await expect(f.data.getFile(f.user, 'final/a.txt')).rejects.toMatchObject({
        status: 404,
    });
    expect(f.data.auditFor('alice').filter((entry) => entry.action === 'files_move')).toEqual([]);
    f.db.exec('DROP TRIGGER fail_grant');
    // With nothing in the way, everything moves together.
    const moved = await f.alice('/media/folders', 'PATCH', {
        from: 'drafts/',
        to: 'final/',
    });
    expect(moved.status).toBe(200);
    expect(state()).toEqual({
        files: ['final/a.txt', 'final/b.txt', 'final/c.txt'],
        grants: ['final/'],
        tree: ['final/empty/'],
    });
    await f.data.putFile(f.dotActor, 'final/d.txt', text('d'));
    expect(f.data.auditFor('alice').filter((entry) => entry.action === 'files_move')).toHaveLength(3);
});

it('refuses a folder move onto a taken file before anything moves', async () => {
    const f = await fixture();
    await f.data.putFile(f.user, 'drafts/a.txt', text('a'));
    await f.data.putFile(f.user, 'drafts/b.txt', text('b'));
    await f.data.putFile(f.user, 'final/b.txt', text('already there'));
    const response = await f.alice('/media/folders', 'PATCH', {
        from: 'drafts/',
        to: 'final/',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
        error: 'There is a file at final/b.txt already.',
    });
    expect(f.data.fileRecords('alice').map((file) => file.path)).toEqual([
        'drafts/a.txt',
        'drafts/b.txt',
        'final/b.txt',
    ]);
});
