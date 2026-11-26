import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workspaceLayout } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { createFileCache, type FileCacheFiles, type FileSource, safeFileName } from '../../src/sync/file-cache';

// The Media file page's files (src/sync/file-cache.ts, CB-558) on a real
// directory: downloaded once through authedFetch into files/ (given its
// protection class first), each under its own name in a folder of its own,
// kept across a relaunch by key, the oldest dropped past the bound, and nothing
// kept for a file that is gone, too large, or cut short.

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

const ID = 'b'.repeat(64);
const PDF = new TextEncoder().encode('%PDF-1.4 made up');

const pdf = (n: number): FileSource => ({
    key: `att-cbatt_${n}`,
    url: `/api/media/attachments/cbatt_${n}/content`,
    name: `report ${n}.pdf`,
});

function setup(options: { maxBytes?: number; maxFileBytes?: number; signal?: AbortSignal } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'files-'));
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
        return answer ?? new Response(PDF, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    };
    const files: FileCacheFiles = {
        list: async (path) => (existsSync(path) ? readdirSync(path) : []),
        remove: (path) => rm(path, { recursive: true, force: true }),
        mkdir: async (path) => void (await mkdir(path, { recursive: true })),
        size: async (path) => (existsSync(path) ? statSync(path).size : 0),
        write: (path, bytes) => writeFile(path, bytes),
        move: (from, to) => rename(from, to),
    };
    let clock = 1_000;
    const open = () =>
        createFileCache({
            fetch,
            files,
            layout,
            setFileProtection: async (path, level) => void protections.push(`${path}:${level}`),
            now: () => (clock += 1),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
        });
    return { layout, requests, answers, protections, open };
}

describe('the file cache', () => {
    it('downloads a file once through authedFetch into files/, under its own name, and holds it across a relaunch', async () => {
        const s = setup();
        const cache = s.open();
        expect(cache.path(pdf(1).key)).toBeNull();
        const [first, second] = await Promise.all([cache.load(pdf(1)), cache.load(pdf(1))]);
        expect(first).toEqual(second);
        expect(s.requests).toEqual(['/api/media/attachments/cbatt_1/content']);
        expect(first.state).toBe('ready');
        const { path, bytes } = first as { path: string; bytes: number };
        expect(path.startsWith(`${s.layout.files}/att-cbatt_1.`)).toBe(true);
        expect(path.endsWith('/report 1.pdf')).toBe(true);
        expect(bytes).toBe(PDF.byteLength);
        expect(new Uint8Array(readFileSync(path))).toEqual(PDF);
        expect(s.protections).toEqual([`${s.layout.files}:complete`]);
        expect(cache.path(pdf(1).key)).toBe(path);

        const again = s.open();
        expect(await again.load(pdf(1))).toEqual({ state: 'ready', path, bytes: PDF.byteLength });
        expect(s.requests).toHaveLength(1);
        // Another version of a library file is another key, so another download.
        await again.load({ ...pdf(1), key: 'item-f1-2' });
        expect(s.requests).toHaveLength(2);
    });

    it('says gone for a 404, too large past the limit, and keeps nothing for no answer or a refusal', async () => {
        const s = setup({ maxFileBytes: 64 });
        const cache = s.open();
        s.answers.set(pdf(1).url, new Response('nope', { status: 404 }));
        s.answers.set(pdf(2).url, 'offline');
        s.answers.set(pdf(3).url, new Response('{"error":"Sign in to continue."}', { status: 401 }));
        s.answers.set(pdf(4).url, new Response(new Uint8Array(65), { status: 200 }));
        expect(await cache.load(pdf(1))).toEqual({ state: 'gone' });
        expect(await cache.load(pdf(2))).toEqual({ state: 'failed' });
        expect(await cache.load(pdf(3))).toEqual({ state: 'failed' });
        expect(await cache.load(pdf(4))).toEqual({ state: 'too-large' });
        // A size known to be too large is refused before any request.
        expect(await cache.load({ ...pdf(5), size: 65 })).toEqual({ state: 'too-large' });
        expect(s.requests).not.toContain(pdf(5).url);
        expect(existsSync(s.layout.files) ? readdirSync(s.layout.files) : []).toEqual([]);
        // A failure is asked again the next time.
        s.answers.delete(pdf(2).url);
        expect((await cache.load(pdf(2))).state).toBe('ready');
    });

    it('drops the oldest past its bound, never the one just opened', async () => {
        const s = setup({ maxBytes: PDF.byteLength * 2 });
        const cache = s.open();
        await cache.load(pdf(1));
        await cache.load(pdf(2));
        await cache.load(pdf(3));
        expect(cache.path(pdf(1).key)).toBeNull();
        expect(cache.path(pdf(2).key)).not.toBeNull();
        expect(cache.path(pdf(3).key)).not.toBeNull();
        expect(readdirSync(s.layout.files)).toHaveLength(2);
    });

    it('deletes what a kill left half-written, and anything it can’t name, as it first reads the folder', async () => {
        const s = setup();
        await mkdir(join(s.layout.files, 'att-cbatt_9.abc.part'), { recursive: true });
        await writeFile(join(s.layout.files, 'att-cbatt_9.abc.part', 'cut.pdf'), 'half');
        await mkdir(join(s.layout.files, 'att-cbatt_8.abd'), { recursive: true });
        await writeFile(join(s.layout.files, 'stray.txt'), 'x');
        const cache = s.open();
        expect((await cache.load(pdf(1))).state).toBe('ready');
        expect(readdirSync(s.layout.files)).toHaveLength(1);
        expect(readdirSync(s.layout.files)[0]).toMatch(/^att-cbatt_1\.[0-9a-z]+$/);
    });

    it('writes nothing once the scope has stopped (sign-out, Clear cache)', async () => {
        const controller = new AbortController();
        const s = setup({ signal: controller.signal });
        const cache = s.open();
        controller.abort();
        expect(await cache.load(pdf(1))).toEqual({ state: 'failed' });
        expect(s.requests).toEqual([]);
        expect(existsSync(s.layout.files)).toBe(false);
    });

    it('makes a name one safe path segment, its extension kept', () => {
        expect(safeFileName('report.pdf')).toBe('report.pdf');
        expect(safeFileName('../../etc/passwd')).toBe('passwd');
        expect(safeFileName('a\\b:c?.txt')).toBe('b-c-.txt');
        expect(safeFileName('.hidden')).toBe('hidden');
        expect(safeFileName('   ')).toBe('file');
        expect(safeFileName('Año nuevo.md')).toBe('Año nuevo.md');
        const long = safeFileName(`${'x'.repeat(300)}.pdf`);
        expect(long).toHaveLength(120);
        expect(long.endsWith('.pdf')).toBe(true);
    });
});
