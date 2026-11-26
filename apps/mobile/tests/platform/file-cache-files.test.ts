import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceLayout } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { createSizeOf } from '../../src/platform/cache-size';
import { createFileCacheFiles, type ExpoCacheFiles } from '../../src/platform/file-cache-files';
import { createExpoFileSystem, type ExpoFileSystem, fileUri } from '../../src/platform/file-system';
import { createFileCache, type FileLoad } from '../../src/sync/file-cache';

// The Media file cache (src/sync/file-cache.ts, CB-558) through its
// expo-file-system binding (src/platform/file-cache-files.ts) under the
// store's file:// root, as on a phone, against a fake expo-file-system that
// reads a URI as the native side does: a URL whose path is percent-decoded,
// `#` starting a fragment and `?` a query (Android's Uri, Foundation's URL).
// So a file's name reaches the disk, the share sheet and the save panel as
// the person named it.

vi.mock('expo-file-system', () => ({ Paths: {}, Directory: class {}, File: class {} }));
vi.mock('expo-file-system/legacy', () => ({ readDirectoryAsync: vi.fn(), moveAsync: vi.fn() }));

/** The file a URI names, as the native side reads it. */
const pathOf = (uri: string) => fileURLToPath(uri);

const info = (uri: string) => {
    try {
        return { exists: true, isDirectory: statSync(pathOf(uri)).isDirectory() };
    } catch {
        return { exists: false, isDirectory: null };
    }
};

class FakeDirectory {
    readonly path: string;
    constructor(uri: string) {
        this.path = pathOf(uri);
    }
    create() {
        mkdirSync(this.path, { recursive: true });
    }
    delete() {
        rmSync(this.path, { recursive: true });
    }
    get size() {
        return null;
    }
}

class FakeFile {
    readonly path: string;
    constructor(uri: string) {
        this.path = pathOf(uri);
    }
    create() {
        writeFileSync(this.path, '');
    }
    write(bytes: Uint8Array) {
        writeFileSync(this.path, bytes);
    }
    text() {
        return readFile(this.path, 'utf8');
    }
    delete() {
        rmSync(this.path);
    }
    get size() {
        return statSync(this.path).size;
    }
}

const expoStore: ExpoFileSystem = {
    Paths: { info },
    Directory: FakeDirectory,
    File: FakeFile,
    readDirectoryAsync: async (uri) => readdir(pathOf(uri)),
};
const expoFiles: ExpoCacheFiles = {
    Paths: { info },
    Directory: FakeDirectory,
    File: FakeFile,
    moveAsync: async ({ from, to }) => renameSync(pathOf(from), pathOf(to)),
};

const NAMES: [given: string, shown: string][] = [
    ['report #1.pdf', 'report #1.pdf'],
    ['growth 50%.txt', 'growth 50%.txt'],
    ['what? really.txt', 'what? really.txt'],
    ['  quarterly   plan.pdf ', 'quarterly   plan.pdf'],
    ['résumé 日本 🙂.txt', 'résumé 日本 🙂.txt'],
    ['%20 & = + ;.md', '%20 & = + ;.md'],
    // A leading dot would hide the file in Files: shown without it.
    ['.env', 'env'],
];

describe('the file cache under a file:// root', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'socio-cache-files-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function open(sent: { url: string; ifNoneMatch: string | null }[]) {
        const fetch: AuthedFetch = async (url, init) => {
            sent.push({ url, ifNoneMatch: new Headers(init?.headers).get('if-none-match') });
            const etag = `"${url.length}"`;
            if (new Headers(init?.headers).get('if-none-match') === etag) {
                return new Response(null, { status: 304, headers: { etag } });
            }
            return new Response(`the bytes of ${url}`, { status: 200, headers: { etag } });
        };
        return createFileCache({
            fetch,
            files: createFileCacheFiles(
                createExpoFileSystem(expoStore),
                createSizeOf({ Paths: { info }, Directory: FakeDirectory, File: FakeFile }),
                expoFiles,
            ),
            layout: workspaceLayout(pathToFileURL(root).href, 'c'.repeat(64)),
            setFileProtection: async () => {},
            onError: (error) => {
                throw error;
            },
        });
    }

    it('keeps each file under the name the person gave it, which preview, share and save read from its URI', async () => {
        const sent: { url: string; ifNoneMatch: string | null }[] = [];
        const cache = open(sent);
        const loads = new Map<string, FileLoad>();
        for (const [index, [given, shown]] of NAMES.entries()) {
            const url = `/api/media/attachments/cbatt_${index}/content`;
            const load = await cache.load({ key: `att-cbatt_${index}`, url, name: given }, { checkedSince: 0 });
            expect(load.state).toBe('ready');
            const { path, bytes } = load as { path: string; bytes: number };
            // The page hands this URI to Quick Look, the share sheet and the save panel.
            const uri = fileUri(path);
            expect(uri.startsWith('file://')).toBe(true);
            expect(new URL(uri).hash).toBe('');
            expect(new URL(uri).search).toBe('');
            expect(decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))).toBe(shown);
            expect(basename(pathOf(uri))).toBe(shown);
            expect(readFileSync(pathOf(uri), 'utf8')).toBe(`the bytes of ${url}`);
            expect(bytes).toBe(`the bytes of ${url}`.length);
            loads.set(url, load);
        }
        const files = join(root, 'socio', 'c'.repeat(64), 'files');
        const onDisk = readdirSync(files).flatMap((folder) =>
            readdirSync(join(files, folder)).filter((name) => name !== '.validator'),
        );
        expect(onDisk.sort()).toEqual(NAMES.map(([, shown]) => shown).sort());

        // A relaunch finds each copy by its name and checks it with the ETag it kept.
        const again = open(sent);
        sent.length = 0;
        for (const [url, load] of loads) {
            expect(
                await again.load(
                    { key: `att-cbatt_${[...loads.keys()].indexOf(url)}`, url, name: 'x' },
                    { checkedSince: 1 },
                ),
            ).toEqual(load);
        }
        expect(sent.every((request) => request.ifNoneMatch === `"${request.url.length}"`)).toBe(true);
        expect(sent).toHaveLength(NAMES.length);

        // Deleted by hand, a copy is downloaded again under the same name.
        const [url, load] = [...loads][0]!;
        rmSync(pathOf((load as { path: string }).path));
        const fresh = await again.load({ key: 'att-cbatt_0', url, name: NAMES[0]![0] }, { checkedSince: 1 });
        expect(fresh.state).toBe('ready');
        expect(existsSync(pathOf((fresh as { path: string }).path))).toBe(true);
        expect(basename(pathOf((fresh as { path: string }).path))).toBe('report #1.pdf');
    });

    it('turns an absolute path into a URI whose every name stays one segment', () => {
        expect(fileUri('/data/files/report #1.pdf')).toBe('file:///data/files/report%20%231.pdf');
        expect(pathOf(fileUri('/data/files/growth 50%.txt'))).toBe('/data/files/growth 50%.txt');
        expect(pathOf(fileUri('/data/files/what?.txt'))).toBe('/data/files/what?.txt');
    });
});
