import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cachePaths, cacheSize, workspaceLayout } from '../../src/data';
import { createSizeOf, type ExpoSizes } from '../../src/platform/cache-size';

// Settings' local cache size: what Clear cache deletes, cache.db with
// its -wal and -shm and `images/` however deep, measured through a fake
// expo-file-system on node:fs that answers as 58's does (`Paths.info`, a
// file's `size`, a directory's walked total). user.db and attachments don't count.

vi.mock('expo-file-system', () => ({ Paths: {}, Directory: class {}, File: class {} }));
vi.mock('expo-file-system/legacy', () => ({ readDirectoryAsync: vi.fn() }));

const pathOf = (uri: string) => fileURLToPath(uri);

function walk(path: string): number {
    return readdirSync(path, { withFileTypes: true }).reduce(
        (sum, entry) =>
            sum + (entry.isDirectory() ? walk(join(path, entry.name)) : statSync(join(path, entry.name)).size),
        0,
    );
}

const fakeExpo: ExpoSizes = {
    Paths: {
        info: (uri: string) => {
            try {
                return { exists: true, isDirectory: statSync(pathOf(uri)).isDirectory() };
            } catch {
                return { exists: false, isDirectory: null };
            }
        },
    },
    Directory: class {
        readonly size: number;
        constructor(uri: string) {
            this.size = walk(pathOf(uri));
        }
    },
    File: class {
        readonly size: number;
        constructor(uri: string) {
            this.size = statSync(pathOf(uri)).size;
        }
    },
};

const ID = 'a'.repeat(64);
let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'socio-cache-size-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('the local cache size', () => {
    it('is what Clear cache deletes: cache.db, its -wal and -shm, and every image', async () => {
        const layout = workspaceLayout(root, ID);
        expect(cachePaths(root, ID)).toEqual([
            join(layout.directory, 'cache.db'),
            join(layout.directory, 'cache.db-wal'),
            join(layout.directory, 'cache.db-shm'),
            layout.images,
        ]);
        mkdirSync(join(layout.images, 'thumbs'), { recursive: true });
        mkdirSync(layout.attachments, { recursive: true });
        writeFileSync(join(layout.directory, 'cache.db'), Buffer.alloc(4096));
        writeFileSync(join(layout.directory, 'cache.db-wal'), Buffer.alloc(1000));
        writeFileSync(join(layout.images, 'a.jpg'), Buffer.alloc(300));
        writeFileSync(join(layout.images, 'thumbs', 'b.jpg'), Buffer.alloc(20));
        // Not the cache: what the person wrote and picked.
        writeFileSync(join(layout.directory, 'user.db'), Buffer.alloc(9999));
        writeFileSync(join(layout.attachments, 'c.jpg'), Buffer.alloc(7777));

        expect(await cacheSize(createSizeOf(fakeExpo), root, ID)).toBe(4096 + 1000 + 300 + 20);
    });

    it('counts nothing for what isn’t there', async () => {
        expect(await cacheSize(createSizeOf(fakeExpo), root, ID)).toBe(0);
    });
});
