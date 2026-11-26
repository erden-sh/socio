import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StorageUnavailableError, type ObjectStore } from '@socio/data/object-store';
import { objectKey } from '@socio/data/storage/keys';

import { LocalObjectStore } from '../src/server/storage/local-store.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3, type FakeS3 } from './fixtures/fake-s3.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function local() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-objects-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new LocalObjectStore(dir);
    await store.ensureReady();
    return { store: store as ObjectStore, dir };
}
async function s3() {
    const fake = await startFakeS3();
    cleanup.push(() => fake.close());
    const store = new S3ObjectStore(fake.settings(), { backoffMs: 1 });
    await store.ensureReady();
    return { store: store as ObjectStore, fake };
}

const bytes = (text: string) => new Uint8Array(Buffer.from(text));

describe.each([
    ['local', local],
    ['s3', s3],
] as const)('%s object store', (_name, make) => {
    it('round-trips bytes, answers undefined for missing keys and deletes idempotently', async () => {
        const { store } = await make();
        const key = 'tenants/main/users/alice/files/0001';
        expect(await store.get(key)).toBeUndefined();
        expect(await store.head(key)).toBeUndefined();
        await store.put(key, bytes('sealed-bytes'));
        expect(Buffer.from((await store.get(key))!).toString()).toBe('sealed-bytes');
        expect(await store.head(key)).toMatchObject({ size: 12 });
        await store.put(key, bytes('replaced'));
        expect(Buffer.from((await store.get(key))!).toString()).toBe('replaced');
        await store.delete(key);
        await store.delete(key);
        expect(await store.get(key)).toBeUndefined();
        // An empty object is an object.
        await store.put('a/empty', new Uint8Array());
        expect(await store.head('a/empty')).toMatchObject({ size: 0 });
    });

    it('lists keys under a prefix only, in order, a page at a time', async () => {
        const { store } = await make();
        const keys = Array.from(
            { length: 1003 },
            (_, n) => `tenants/main/users/alice/files/${String(n).padStart(4, '0')}`,
        );
        await Promise.all(keys.map((key) => store.put(key, bytes('x'))));
        await store.put('tenants/main/users/bob/files/0001', bytes('bob'));
        await store.put('tenants/other/users/alice/files/0001', bytes('other'));
        const first = await store.list('tenants/main/users/alice/');
        expect(first.keys).toHaveLength(1000);
        expect(first.keys[0]).toMatchObject({ key: keys[0], size: 1 });
        // A change marker for incremental backups (CB-63): an ETag or an mtime.
        expect(first.keys[0].etag ?? first.keys[0].modified).toBeTruthy();
        expect(first.next).toBeTruthy();
        const second = await store.list('tenants/main/users/alice/', first.next);
        expect(second.keys.map((entry) => entry.key)).toEqual(keys.slice(1000));
        expect(second.next).toBeUndefined();
        const all: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await store.list('tenants/main/', cursor);
            all.push(...page.keys.map((entry) => entry.key));
            cursor = page.next;
        } while (cursor);
        expect(all).toEqual([...keys, 'tenants/main/users/bob/files/0001']);
        expect((await store.list('tenants/main/users/b')).keys).toEqual([
            expect.objectContaining({
                key: 'tenants/main/users/bob/files/0001',
                size: 3,
            }),
        ]);
        expect((await store.list('nothing/here/')).keys).toEqual([]);
    });

    it('refuses keys that could leave the store’s root', async () => {
        const { store } = await make();
        for (const key of ['../escape', 'a/../../b', '/absolute', 'a//b', 'a/./b', 'spaces are not keys', '', 'a/b/']) {
            await expect(store.put(key, bytes('x'))).rejects.toThrow('Invalid object key.');
            await expect(store.get(key)).rejects.toThrow('Invalid object key.');
        }
        await expect(store.list('../')).rejects.toThrow('Invalid object key.');
    });
});

it('keeps the local layout the data space had before CB-54', async () => {
    const { store, dir } = await local();
    const key = objectKey('local', 'main', 'alice', 'file-1');
    expect(key).toBe('alice/files/file-1.bin');
    await store.put(key, bytes('sealed'));
    expect(readdirSync(join(dir, 'alice', 'files'))).toEqual(['file-1.bin']);
    expect(statSync(join(dir, 'alice', 'files', 'file-1.bin')).mode & 0o077).toBe(0);
    expect(objectKey('s3', 'main', 'alice', 'file-1')).toBe('tenants/main/users/alice/files/file-1');
    // Ids that aren't safe names become a hash, as before.
    expect(objectKey('s3', 'main', 'a/b@c', 'f')).toMatch(/^tenants\/main\/users\/u-[0-9a-f]{24}\/files\/f$/);
});

describe('S3 object store', () => {
    let fake: FakeS3;
    const store = (options = {}) => new S3ObjectStore(fake.settings(), { backoffMs: 1, ...options });
    afterEach(() => fake?.close());

    it('creates its bucket once, signs every request and sends only opaque bytes', async () => {
        fake = await startFakeS3();
        const objects = store();
        await objects.ensureReady();
        await objects.ensureReady();
        expect(fake.buckets.has('company-brain')).toBe(true);
        expect(fake.requests.map((request) => `${request.method} ${request.status}`)).toEqual([
            'HEAD 404',
            'PUT 200',
            'HEAD 200',
        ]);
        await objects.put('tenants/main/users/alice/files/id-1', bytes('sealed'));
        const put = fake.requests.at(-1)!;
        expect(put.path).toBe('company-brain/tenants/main/users/alice/files/id-1');
        expect(put.headers['content-type']).toBe('application/octet-stream');
        expect(Object.keys(put.headers).filter((name) => name.startsWith('x-amz-meta'))).toEqual([]);
        expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=FAKEACCESSKEY0000001\//);
        expect(fake.requests.every((request) => request.status !== 403)).toBe(true);
    });

    it('is refused with the wrong secret, and says so without the key pair', async () => {
        fake = await startFakeS3();
        const objects = new S3ObjectStore(fake.settings({ secretAccessKey: 'not-the-secret-key-at-all-000000' }), {
            backoffMs: 1,
        });
        const failure = await objects.ensureReady().catch((error) => error);
        expect(failure).toBeInstanceOf(StorageUnavailableError);
        expect(failure.status).toBe(503);
        expect(failure.message).toBe('Object storage HEAD bucket failed: HTTP 403.');
        expect(failure.message).not.toContain('not-the-secret');
        // 4xx answers are not retried.
        expect(fake.requests).toHaveLength(1);
    });

    it('retries 5xx answers and cut connections, then gives up as unavailable', async () => {
        fake = await startFakeS3();
        const objects = store();
        await objects.ensureReady();
        fake.requests.length = 0;
        fake.failNext(2, 503);
        await objects.put('k/1', bytes('one'));
        expect(fake.requests.map((request) => request.status)).toEqual([503, 503, 200]);
        fake.dropNext(1);
        expect(Buffer.from((await objects.get('k/1'))!).toString()).toBe('one');
        fake.failNext(3, 500);
        await expect(objects.get('k/1')).rejects.toThrow('Object storage GET failed: HTTP 500.');
        fake.dropNext(3);
        await expect(objects.head('k/1')).rejects.toBeInstanceOf(StorageUnavailableError);
    });

    it('streams files up and down, signed with their real hash, and retries them whole (CB-378)', async () => {
        fake = await startFakeS3();
        const objects = store();
        await objects.ensureReady();
        const dir = mkdtempSync(join(tmpdir(), 'cb-s3-files-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const body = randomBytes(3 * 1024 * 1024 + 17);
        writeFileSync(join(dir, 'up.bin'), body);
        fake.requests.length = 0;
        // A failed attempt sends the file again from its start.
        fake.failNext(1, 503, 'PUT');
        expect(await objects.putFile('k/big', join(dir, 'up.bin'))).toBe(body.length);
        expect(fake.requests.map((request) => request.status)).toEqual([503, 200]);
        const put = fake.requests.at(-1)!;
        expect(put.headers['content-length']).toBe(String(body.length));
        expect(put.headers['content-type']).toBe('application/octet-stream');
        expect(fake.objects.get('company-brain/k/big')!.equals(body)).toBe(true);
        // An empty file is an empty object.
        writeFileSync(join(dir, 'empty.bin'), '');
        expect(await objects.putFile('k/empty', join(dir, 'empty.bin'))).toBe(0);
        expect(fake.objects.get('company-brain/k/empty')).toHaveLength(0);

        expect(await objects.getFile('k/big', join(dir, 'down.bin'))).toBe(body.length);
        expect(readFileSync(join(dir, 'down.bin')).equals(body)).toBe(true);
        expect(statSync(join(dir, 'down.bin')).mode & 0o777).toBe(0o600);
        expect(await objects.getFile('k/empty', join(dir, 'down-empty.bin'))).toBe(0);
        expect(await objects.getFile('k/missing', join(dir, 'missing.bin'))).toBeUndefined();
        expect(existsSync(join(dir, 'missing.bin'))).toBe(false);
        fake.failNext(3, 500, 'GET');
        await expect(objects.getFile('k/big', join(dir, 'failed.bin'))).rejects.toThrow(
            'Object storage GET failed: HTTP 500.',
        );
    });

    it('times out a request that never answers', async () => {
        fake = await startFakeS3();
        // A server that never answers: only the request's own timeout ends it. The
        // fake's slow answer raced the timer, and the 50 ms timeout also fired early
        // on the HEAD before it when the host was loaded.
        const signals: AbortSignal[] = [];
        const silent: typeof fetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                const signal = init!.signal!;
                signals.push(signal);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        const objects = store({ timeoutMs: 50, retries: 0, fetch: silent });
        await expect(objects.get('k/slow')).rejects.toThrow('Object storage GET failed: timed out.');
        expect(signals).toHaveLength(1);
        expect(signals[0]!.reason).toMatchObject({ name: 'TimeoutError' });
    });

    it('answers unavailable when nothing listens', async () => {
        fake = await startFakeS3();
        const settings = fake.settings();
        await fake.close();
        const objects = new S3ObjectStore(settings, { backoffMs: 1 });
        await expect(objects.ensureReady()).rejects.toThrow('Object storage HEAD failed: unreachable.');
        fake = await startFakeS3();
    });

    it('lists ETags and LastModified, and HEAD answers the ETag', async () => {
        fake = await startFakeS3();
        const objects = store();
        await objects.ensureReady();
        await objects.put('k/1', bytes('one'));
        const [listed] = (await objects.list('k/')).keys;
        expect(listed).toEqual({
            key: 'k/1',
            size: 3,
            etag: 'f97c5d29941bfb1b2fdab0874906ab82',
            modified: expect.any(Number),
        });
        expect(Math.abs(listed.modified! - Date.now())).toBeLessThan(5000);
        expect(await objects.head('k/1')).toEqual({
            size: 3,
            etag: 'f97c5d29941bfb1b2fdab0874906ab82',
        });
    });

    it('addresses the bucket in the host name when path style is off', async () => {
        fake = await startFakeS3({ region: 'eu-west-1' });
        const objects = new S3ObjectStore(fake.settings({ endpoint: fake.virtualUrl, forcePathStyle: false }), {
            backoffMs: 1,
            fetch: fake.hostFetch,
        });
        await objects.ensureReady();
        await objects.put('tenants/main/users/alice/files/id-1', bytes('sealed'));
        expect(Buffer.from((await objects.get('tenants/main/users/alice/files/id-1'))!).toString()).toBe('sealed');
        expect((await objects.list('tenants/')).keys).toHaveLength(1);
        await objects.delete('tenants/main/users/alice/files/id-1');
        expect(fake.requests.every((request) => request.virtualHosted)).toBe(true);
        expect(fake.requests.every((request) => request.status !== 403)).toBe(true);
        expect(fake.requests.map((request) => String(request.headers.host))).toEqual(
            fake.requests.map(() => `company-brain.${new URL(fake.virtualUrl).host}`),
        );
        expect(fake.requests[2].path).toBe('company-brain/tenants/main/users/alice/files/id-1');
    });

    it('creates a bucket outside us-east-1 with a LocationConstraint', async () => {
        fake = await startFakeS3({ region: 'eu-central-1' });
        await store().ensureReady();
        const create = fake.requests.find((request) => request.method === 'PUT')!;
        expect(create.status).toBe(200);
        expect(create.headers['content-type']).toBe('application/xml');
        expect(create.body.toString()).toBe(
            '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>eu-central-1</LocationConstraint></CreateBucketConfiguration>',
        );
        await fake.close();
        // us-east-1 sends none (AWS refuses one naming it).
        fake = await startFakeS3();
        await store().ensureReady();
        expect(fake.requests.find((request) => request.method === 'PUT')!.body.length).toBe(0);
        expect(fake.buckets.has('company-brain')).toBe(true);
    });
});
