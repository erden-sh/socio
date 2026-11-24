import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { attachmentContentUrl } from '@socio/shared/media-types';
import { coverUrl } from '@socio/shared/pages/page-library';

import { workspaceLayout } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { createImageCache, type ImageCacheFiles } from '../../src/sync/image-cache';

// The app's image cache (src/sync/image-cache.ts) on a
// real directory: downloaded once through authedFetch into images/ (given its
// protection class first), kept across a relaunch by id and version, the
// oldest dropped past the bound, and nothing kept that isn't a picture.

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

const ID = 'a'.repeat(64);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const att = (n: number) => `cbatt_${String(n).padStart(22, 'A')}`;

function setup(options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'images-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const layout = workspaceLayout(root, ID);
    const requests: string[] = [];
    const answers = new Map<string, Response | 'offline'>();
    const protections: string[] = [];
    const fetch: AuthedFetch = async (input) => {
        requests.push(input);
        const answer = answers.get(input);
        if (answer === 'offline') {
            throw new NetworkError('offline');
        }
        return answer ?? new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const files: ImageCacheFiles = {
        list: async (path) => (existsSync(path) ? readdirSync(path) : []),
        remove: (path) => rm(path, { recursive: true, force: true }),
        mkdir: async (path) => void (await mkdir(path, { recursive: true })),
        size: async (path) => (existsSync(path) ? statSync(path).size : 0),
        write: (path, bytes) => writeFile(path, bytes),
        move: (from, to) => rename(from, to),
    };
    let clock = 1_000;
    const open = () =>
        createImageCache({
            fetch,
            files,
            layout,
            setFileProtection: async (path, level) => void protections.push(`${path}:${level}`),
            now: () => (clock += 1),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        });
    return { layout, requests, answers, protections, open, files };
}

describe('the image cache', () => {
    it('downloads a picture once through authedFetch into images/, then holds it across a relaunch', async () => {
        const s = setup();
        const cache = s.open();
        expect(cache.path(att(1))).toBeNull();
        const [first, second] = await Promise.all([cache.load(att(1)), cache.load(att(1))]);
        expect(first).toEqual(second);
        expect(s.requests).toEqual([attachmentContentUrl(att(1))]);
        expect(first.state).toBe('ready');
        const path = (first as { path: string }).path;
        expect(path.startsWith(s.layout.images)).toBe(true);
        expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
        expect(s.protections).toEqual([`${s.layout.images}:complete`]);
        expect(cache.path(att(1))).toBe(path);

        const again = s.open();
        expect(await again.load(att(1))).toEqual({ state: 'ready', path });
        expect(again.path(att(1))).toBe(path);
        expect(s.requests).toHaveLength(1);
        // Another version is another picture.
        await again.load(att(1), 2);
        expect(s.requests).toHaveLength(2);
    });

    it('keeps a page’s cover by its media embed’s id, apart from an attachment of the same id', async () => {
        const s = setup();
        const cache = s.open();
        const embed = await cache.load('emb_1', 0, 'embed');
        expect(s.requests).toEqual([coverUrl('emb_1')]);
        expect(embed.state).toBe('ready');
        expect(cache.path('emb_1', 0, 'embed')).toBe((embed as { path: string }).path);
        expect(cache.path('emb_1')).toBeNull();
        await cache.load('emb_1');
        expect(s.requests).toEqual([coverUrl('emb_1'), attachmentContentUrl('emb_1')]);
        expect(await s.open().load('emb_1', 0, 'embed')).toEqual(embed);
        expect(s.requests).toHaveLength(2);
    });

    it('reads an issue’s picture from its own path, kept apart from the other kinds', async () => {
        const s = setup();
        const cache = s.open();
        const id = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
        const issue = await cache.load(id, 0, 'issue');
        expect(s.requests).toEqual([`/api/issue-attachments/${id}`]);
        expect(issue.state).toBe('ready');
        expect(cache.path(id, 0, 'issue')).toBe((issue as { path: string }).path);
        expect(cache.path(id)).toBeNull();
        expect(cache.path(id, 0, 'embed')).toBeNull();
        expect(await s.open().load(id, 0, 'issue')).toEqual(issue);
        expect(s.requests).toHaveLength(1);
        // A text file the server serves is never kept as a picture.
        s.answers.set('/api/issue-attachments/t1', new Response('x', { headers: { 'content-type': 'text/plain' } }));
        expect(await cache.load('t1', 0, 'issue')).toEqual({ state: 'failed' });
    });

    it('says gone for a 404, and keeps nothing for no answer, a refusal or a body that isn’t a picture', async () => {
        const s = setup();
        const cache = s.open();
        s.answers.set(attachmentContentUrl(att(1)), new Response('nope', { status: 404 }));
        s.answers.set(attachmentContentUrl(att(2)), 'offline');
        s.answers.set(
            attachmentContentUrl(att(3)),
            new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        );
        s.answers.set(attachmentContentUrl(att(4)), new Response('', { status: 403 }));
        expect(await cache.load(att(1))).toEqual({ state: 'gone' });
        expect(await cache.load(att(2))).toEqual({ state: 'failed' });
        expect(await cache.load(att(3))).toEqual({ state: 'failed' });
        expect(await cache.load(att(4))).toEqual({ state: 'failed' });
        expect(existsSync(s.layout.images) ? readdirSync(s.layout.images) : []).toEqual([]);
        // No answer is tried again on the next load.
        s.answers.delete(attachmentContentUrl(att(2)));
        expect((await cache.load(att(2))).state).toBe('ready');
    });

    it('drops the oldest pictures past its bound, never the one just loaded', async () => {
        const s = setup({ maxBytes: PNG.byteLength * 2 });
        const cache = s.open();
        for (const n of [1, 2, 3]) {
            await cache.load(att(n));
        }
        expect(cache.path(att(1))).toBeNull();
        expect(cache.path(att(2))).not.toBeNull();
        expect(cache.path(att(3))).not.toBeNull();
        expect(readdirSync(s.layout.images)).toHaveLength(2);
        // The order survives a relaunch: the stamp is in the name.
        const again = s.open();
        await again.load(att(4));
        expect(again.path(att(2))).toBeNull();
        expect(readdirSync(s.layout.images)).toHaveLength(2);
    });

    it('deletes a file it can’t name as it reads its folder (a write a kill cut off)', async () => {
        const s = setup();
        await mkdir(s.layout.images, { recursive: true });
        writeFileSync(join(s.layout.images, 'partial.tmp'), 'x');
        const cache = s.open();
        await cache.load(att(1));
        expect(readdirSync(s.layout.images).some((name) => name === 'partial.tmp')).toBe(false);
    });

    it('writes nothing and makes no folder when the scope closes while a body is read, or during the write', async () => {
        const controller = new AbortController();
        const s = setup({ signal: controller.signal });
        const cache = s.open();
        // Sign-out (or Clear cache) closes the scope while the body comes, and wipes the folder.
        let finish!: () => void;
        const body = new ReadableStream<Uint8Array>({
            start(stream) {
                stream.enqueue(PNG);
                finish = () => stream.close();
            },
        });
        s.answers.set(
            attachmentContentUrl(att(1)),
            new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }),
        );
        const loading = cache.load(att(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();
        finish();
        expect(await loading).toEqual({ state: 'failed' });
        expect(existsSync(s.layout.directory)).toBe(false);
        // Once closed, nothing downloads at all.
        expect(await cache.load(att(2))).toEqual({ state: 'failed' });
        expect(s.requests).toEqual([attachmentContentUrl(att(1))]);
    });

    it('never keeps a write a kill cut short: it goes to a temporary name, renamed once whole', async () => {
        const s = setup();
        const written: string[] = [];
        const write = s.files.write;
        s.files.write = async (path, bytes) => {
            written.push(path);
            // The kill: half the bytes land, and the rename never comes.
            await write(path, bytes.subarray(0, 3));
            throw new Error('killed');
        };
        expect(await s.open().load(att(1))).toEqual({ state: 'failed' });
        expect(written).toHaveLength(1);
        expect(written[0]?.endsWith('.part')).toBe(true);
        // What a real kill leaves behind: the part file. The next launch drops it and downloads again.
        writeFileSync(written[0]!, PNG.subarray(0, 3));
        s.files.write = write;
        const relaunched = s.open();
        const load = await relaunched.load(att(1));
        expect(load.state).toBe('ready');
        expect(new Uint8Array(readFileSync((load as { path: string }).path))).toEqual(PNG);
        expect(readdirSync(s.layout.images).some((name) => name.endsWith('.part'))).toBe(false);
        expect(s.requests).toHaveLength(2);
    });

    it('removes a picture whose write the scope’s close overtook', async () => {
        const controller = new AbortController();
        const s = setup({ signal: controller.signal });
        const write = s.files.write;
        s.files.write = async (path, bytes) => {
            await write(path, bytes);
            controller.abort();
        };
        const cache = s.open();
        expect(await cache.load(att(1))).toEqual({ state: 'failed' });
        expect(readdirSync(s.layout.images)).toEqual([]);
        expect(cache.path(att(1))).toBeNull();
    });
});
