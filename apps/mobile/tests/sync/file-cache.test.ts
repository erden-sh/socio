import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workspaceLayout } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    createFileCache,
    type FileCacheFiles,
    type FileLoad,
    type FileSource,
    safeFileName,
} from '../../src/sync/file-cache';

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
        exists: async (path) => existsSync(path),
        readText: (path) => readFile(path, 'utf8'),
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
        expect(safeFileName('a\\b:c?.txt')).toBe('b-c?.txt');
        // What the person named it, as the share sheet and the save panel show it.
        for (const name of ['report #1.pdf', 'growth 50%.txt', 'what? *really*.txt', 'résumé 日本 🙂.txt']) {
            expect(safeFileName(name)).toBe(name);
        }
        expect(safeFileName('.hidden')).toBe('hidden');
        expect(safeFileName('   ')).toBe('file');
        expect(safeFileName('Año nuevo.md')).toBe('Año nuevo.md');
        const long = safeFileName(`${'x'.repeat(300)}.pdf`);
        expect(long).toHaveLength(120);
        expect(long.endsWith('.pdf')).toBe(true);
    });
});

/**
 * A workspace whose files can be replaced under their ids, as the server's content routes answer:
 * the bytes with their ETag, a 304 to an If-None-Match that names it, a 404 once deleted.
 */
function replaceableServer(options: { etags?: boolean } = {}) {
    const { etags = true } = options;
    const contents = new Map<string, Uint8Array>();
    const versions = new Map<string, number>();
    const sent: { url: string; ifNoneMatch: string | null }[] = [];
    let offline = false;
    const fetch: AuthedFetch = async (url, init) => {
        const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
        sent.push({ url, ifNoneMatch });
        if (offline) {
            throw new NetworkError('offline');
        }
        const bytes = contents.get(url);
        if (bytes === undefined) {
            return new Response('{"error":"Attachment not found."}', { status: 404 });
        }
        const etag = `"v${versions.get(url)}"`;
        if (etags && ifNoneMatch === etag) {
            return new Response(null, { status: 304, headers: { etag } });
        }
        return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream', ...(etags ? { etag } : {}) },
        });
    };
    return {
        fetch,
        sent,
        put(url: string, text: string) {
            contents.set(url, new TextEncoder().encode(text));
            versions.set(url, (versions.get(url) ?? 0) + 1);
        },
        delete: (url: string) => contents.delete(url),
        setOffline: (value: boolean) => {
            offline = value;
        },
    };
}

function replaceableSetup(options: { etags?: boolean; maxBytes?: number } = {}) {
    /** Folders whose delete fails, as a binding's can: it throws as it is called. */
    const undeletable = new Set<string>();
    const errors: unknown[] = [];
    const root = mkdtempSync(join(tmpdir(), 'files-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const layout = workspaceLayout(root, ID);
    const server = replaceableServer(options);
    const files: FileCacheFiles = {
        list: async (path) => (existsSync(path) ? readdirSync(path) : []),
        remove: (path) => {
            if ([...undeletable].some((folder) => path.includes(folder))) {
                throw new Error(`could not delete ${path}`);
            }
            return rm(path, { recursive: true, force: true });
        },
        mkdir: async (path) => void (await mkdir(path, { recursive: true })),
        size: async (path) => (existsSync(path) ? statSync(path).size : 0),
        exists: async (path) => existsSync(path),
        readText: (path) => readFile(path, 'utf8'),
        write: (path, bytes) => writeFile(path, bytes),
        move: (from, to) => rename(from, to),
    };
    let clock = 1_000;
    const tick = () => (clock += 1);
    const open = (maxBytes = options.maxBytes) =>
        createFileCache({
            fetch: server.fetch,
            files,
            layout,
            setFileProtection: async () => {},
            now: tick,
            onError: (error) => void errors.push(error),
            ...(maxBytes === undefined ? {} : { maxBytes }),
        });
    /** A page opening now: what it passes as `checkedSince`. */
    const pageOpens = () => tick();
    const text = (load: FileLoad) => readFileSync((load as { path: string }).path, 'utf8');
    const folders = () => (existsSync(layout.files) ? readdirSync(layout.files) : []);
    /** Makes deleting a key's copy fail from now on. */
    const undeletableCopy = (key: string) => {
        const folder = folders().find((name) => name.startsWith(`${key}.`));
        expect(folder).toBeDefined();
        undeletable.add(folder!);
        return folder!;
    };
    return { layout, server, open, pageOpens, text, folders, undeletableCopy, errors };
}

describe('a copy of a file replaced under its id', () => {
    it('is checked with its ETag as a page opens it: a 304 keeps it, a replacement downloads the new bytes, also after a relaunch', async () => {
        const s = replaceableSetup();
        const source = pdf(1);
        s.server.put(source.url, 'first bytes');
        const cache = s.open();
        const first = await cache.load(source, { checkedSince: s.pageOpens() });
        expect(s.text(first)).toBe('first bytes');
        expect(s.server.sent).toEqual([{ url: source.url, ifNoneMatch: null }]);

        // The same page asking again (a focus, an action) sends nothing: its copy was checked as it opened.
        const opened = s.pageOpens();
        expect(await cache.load(source, { checkedSince: opened })).toEqual(first);
        expect(await cache.load(source, { checkedSince: opened })).toEqual(first);
        expect(s.server.sent).toHaveLength(2);
        expect(s.server.sent[1]).toEqual({ url: source.url, ifNoneMatch: '"v1"' });

        // Replaced on the server: the chip opened again shows the new bytes, and the old copy is gone.
        s.server.put(source.url, 'replaced bytes');
        const second = await cache.load(source, { checkedSince: s.pageOpens() });
        expect(s.server.sent[2]).toEqual({ url: source.url, ifNoneMatch: '"v1"' });
        expect(second.state).toBe('ready');
        expect(s.text(second)).toBe('replaced bytes');
        expect((second as { path: string }).path).not.toBe((first as { path: string }).path);
        expect(existsSync((first as { path: string }).path)).toBe(false);
        expect(s.folders()).toHaveLength(1);

        // A relaunch keeps the new copy and its ETag: a 304, then a replacement again.
        const relaunched = s.open();
        expect(await relaunched.load(source, { checkedSince: s.pageOpens() })).toEqual(second);
        expect(s.server.sent[3]).toEqual({ url: source.url, ifNoneMatch: '"v2"' });
        s.server.put(source.url, 'third bytes');
        const after = s.open();
        const third = await after.load(source, { checkedSince: s.pageOpens() });
        expect(s.text(third)).toBe('third bytes');
        expect(s.server.sent[4]).toEqual({ url: source.url, ifNoneMatch: '"v2"' });
        expect(s.folders()).toHaveLength(1);
    });

    it('downloads again on each open from a server that sends no ETag, and says gone once the file is', async () => {
        const s = replaceableSetup({ etags: false });
        const source = pdf(2);
        s.server.put(source.url, 'first bytes');
        const cache = s.open();
        expect(s.text(await cache.load(source, { checkedSince: s.pageOpens() }))).toBe('first bytes');
        s.server.put(source.url, 'replaced bytes');
        expect(s.text(await cache.load(source, { checkedSince: s.pageOpens() }))).toBe('replaced bytes');
        expect(s.server.sent.map((sent) => sent.ifNoneMatch)).toEqual([null, null]);
        s.server.delete(source.url);
        expect(await cache.load(source, { checkedSince: s.pageOpens() })).toEqual({ state: 'gone' });
        expect(s.folders()).toEqual([]);
        expect(cache.path(source.key)).toBeNull();
    });

    it('opens the copy it has while offline, and checks it again once the page can', async () => {
        const s = replaceableSetup();
        const source = pdf(3);
        s.server.put(source.url, 'first bytes');
        const cache = s.open();
        const first = await cache.load(source, { checkedSince: s.pageOpens() });
        s.server.put(source.url, 'replaced bytes');
        s.server.setOffline(true);
        const opened = s.pageOpens();
        expect(await cache.load(source, { checkedSince: opened })).toEqual(first);
        // Not confirmed, so the same page's next look asks again.
        s.server.setOffline(false);
        expect(s.text(await cache.load(source, { checkedSince: opened }))).toBe('replaced bytes');
    });
});

describe('a copy an open page has', () => {
    it('is never evicted while the page holds it, and goes once it lets go', async () => {
        const s = replaceableSetup({ maxBytes: 'aaaa'.length * 2 });
        for (const n of [1, 2, 3, 4]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const cache = s.open();
        await cache.load(pdf(1));
        const release = cache.hold(pdf(1).key);
        await cache.load(pdf(2));
        await cache.load(pdf(3));
        // The oldest is the held one: the next oldest went instead.
        expect(cache.path(pdf(1).key)).not.toBeNull();
        expect(cache.path(pdf(2).key)).toBeNull();
        release();
        release();
        await cache.load(pdf(4));
        expect(cache.path(pdf(1).key)).toBeNull();
        expect(s.folders()).toHaveLength(2);
    });

    it('is downloaded again when it was deleted under the cache, rather than handed on', async () => {
        const s = replaceableSetup();
        const source = pdf(5);
        s.server.put(source.url, 'the bytes');
        const cache = s.open();
        const opened = s.pageOpens();
        const first = await cache.load(source, { checkedSince: opened });
        rmSync(join(s.layout.files, s.folders()[0]!), { recursive: true });
        const again = await cache.load(source, { checkedSince: opened });
        expect(again.state).toBe('ready');
        expect(s.text(again)).toBe('the bytes');
        expect(existsSync((again as { path: string }).path)).toBe(true);
        expect((again as { path: string }).path).not.toBe((first as { path: string }).path);
        // Offline as well: it says so (the page offers Try again), never a path that isn't there.
        rmSync(join(s.layout.files, s.folders()[0]!), { recursive: true });
        s.server.setOffline(true);
        expect(await cache.load(source, { checkedSince: opened })).toEqual({ state: 'failed' });
    });

    it('comes back within its bound once pages held past it let go, never dropping one still held', async () => {
        const s = replaceableSetup({ maxBytes: 'aaaa'.length * 2 });
        for (const n of [1, 2, 3, 4]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const cache = s.open();
        // Three file pages, each pushed over the last (In Media, then another file): all held.
        const releases = [];
        for (const n of [1, 2, 3]) {
            releases.push(cache.hold(pdf(n).key));
            await cache.load(pdf(n));
        }
        expect(s.folders()).toHaveLength(3);
        // Back from the top two at once: one pass, and the held oldest stays.
        releases[2]!();
        releases[1]!();
        await cache.idle();
        expect(cache.path(pdf(1).key)).not.toBeNull();
        expect(cache.path(pdf(2).key)).toBeNull();
        expect(cache.path(pdf(3).key)).not.toBeNull();
        expect(s.folders()).toHaveLength(2);
        // Within the bound: letting go of the last changes nothing.
        releases[0]!();
        await cache.idle();
        expect(s.folders()).toHaveLength(2);

        // Over the bound again, with every page let go: back within it, the oldest gone.
        const held = [cache.hold(pdf(4).key), cache.hold(pdf(3).key), cache.hold(pdf(1).key)];
        await cache.load(pdf(4));
        expect(s.folders()).toHaveLength(3);
        for (const release of held) {
            release();
        }
        await cache.idle();
        expect(s.folders()).toHaveLength(2);
        expect(cache.path(pdf(1).key)).toBeNull();
        expect(cache.path(pdf(3).key)).not.toBeNull();
        expect(cache.path(pdf(4).key)).not.toBeNull();
    });

    it('comes back within its bound as it first reads a folder an earlier launch left over it', async () => {
        const s = replaceableSetup();
        for (const n of [1, 2, 3]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const first = s.open();
        for (const n of [1, 2, 3]) {
            await first.load(pdf(n));
        }
        expect(s.folders()).toHaveLength(3);
        const requests = s.server.sent.length;
        // Relaunched with the folder over its bound: the first load reads it and drops the oldest.
        const relaunched = s.open('aaaa'.length * 2);
        expect((await relaunched.load(pdf(3))).state).toBe('ready');
        expect(s.server.sent).toHaveLength(requests);
        expect(s.folders()).toHaveLength(2);
        expect(relaunched.path(pdf(1).key)).toBeNull();
        expect(relaunched.path(pdf(2).key)).not.toBeNull();
        expect(relaunched.path(pdf(3).key)).not.toBeNull();
    });

    it('keeps evicting after a pass fails: later releases, loads and idle() all go on', async () => {
        const s = replaceableSetup({ maxBytes: 'aaaa'.length * 2 });
        for (const n of [1, 2, 3, 4]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const cache = s.open();
        const first = [1, 2, 3].map((n) => cache.hold(pdf(n).key));
        for (const n of [1, 2, 3]) {
            await cache.load(pdf(n));
        }
        // The oldest copy can't be deleted: the pass after the release meets that failure.
        const stuck = s.undeletableCopy(pdf(1).key);
        for (const release of first) {
            release();
        }
        await expect(cache.idle()).resolves.toBeUndefined();
        expect(s.errors).toHaveLength(1);
        expect(cache.path(pdf(1).key)).toBeNull();

        // A later load still answers its copy, and a later release still brings the cache within its bound.
        const second = [2, 3, 4].map((n) => cache.hold(pdf(n).key));
        const load = await cache.load(pdf(4));
        expect(load.state).toBe('ready');
        expect(s.text(load)).toBe('aaaa');
        for (const release of second) {
            release();
        }
        await expect(cache.idle()).resolves.toBeUndefined();
        expect(cache.path(pdf(2).key)).toBeNull();
        expect(cache.path(pdf(3).key)).not.toBeNull();
        expect(cache.path(pdf(4).key)).not.toBeNull();
        // Only the folder that couldn't be deleted is left over, for the next launch to take back.
        expect(s.folders().filter((folder) => folder !== stuck)).toHaveLength(2);
    });

    it('answers a download’s copy when the eviction after it fails', async () => {
        const s = replaceableSetup({ maxBytes: 'aaaa'.length * 2 });
        for (const n of [1, 2, 3]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const cache = s.open();
        await cache.load(pdf(1));
        await cache.load(pdf(2));
        s.undeletableCopy(pdf(1).key);
        const load = await cache.load(pdf(3));
        expect(load.state).toBe('ready');
        expect(s.text(load)).toBe('aaaa');
        expect(s.errors).toHaveLength(1);
        await expect(cache.idle()).resolves.toBeUndefined();
    });

    it('reads a folder left over its bound even when a copy there can’t be deleted', async () => {
        const s = replaceableSetup();
        for (const n of [1, 2, 3, 4]) {
            s.server.put(pdf(n).url, 'aaaa');
        }
        const first = s.open();
        for (const n of [1, 2, 3]) {
            await first.load(pdf(n));
        }
        s.undeletableCopy(pdf(1).key);
        const relaunched = s.open('aaaa'.length * 2);
        const load = await relaunched.load(pdf(3));
        expect(load.state).toBe('ready');
        expect(s.errors).toHaveLength(1);
        expect(relaunched.path(pdf(1).key)).toBeNull();
        expect(relaunched.path(pdf(2).key)).not.toBeNull();
        // And the cache goes on: a new download, and the eviction after it.
        expect((await relaunched.load(pdf(4))).state).toBe('ready');
        expect(relaunched.path(pdf(2).key)).toBeNull();
        await expect(relaunched.idle()).resolves.toBeUndefined();
    });
});
