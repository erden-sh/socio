import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoFileSystem, type ExpoFileSystem, fileUri } from '../../src/platform/file-system';
import { describeFileSystemContract } from '../helpers/file-system-contract';

// The store's FileSystem on expo-file-system (src/platform/file-system.ts)
// holds to the contract (tests/helpers/file-system-contract.ts), against a
// fake expo-file-system on node:fs that answers as 58.0.13's native side does
// where the binding depends on it:
// - `Paths.info` answers false whenever it can't look (Java's File.exists(),
//   Foundation's fileExists), never throwing;
// - the legacy `readDirectoryAsync` throws for a directory that is missing,
//   isn't one, or can't be read;
// - `Directory.create({ intermediates, idempotent })` makes the parents and is
//   quiet for one that's there; `delete()` throws for a missing item.
// On a phone the app can't make its own directory unreadable, so the
// contract's last case runs here only.

// The real modules load React Native; the binding gets the fake below instead.
vi.mock('expo-file-system', () => ({ Paths: {}, Directory: class {}, File: class {} }));
vi.mock('expo-file-system/legacy', () => ({ readDirectoryAsync: vi.fn() }));

const pathOf = (uri: string) => fileURLToPath(uri);

/** The fake, with each call logged. `info` can be made to answer false where something is, as a binding that can't look does. */
function fakeExpoFileSystem(hidden: Set<string> = new Set()) {
    const log: string[] = [];
    const expo: ExpoFileSystem = {
        Paths: {
            info: (uri) => {
                log.push(`info ${uri}`);
                if (hidden.has(pathOf(uri))) {
                    return { exists: false, isDirectory: null };
                }
                try {
                    return { exists: true, isDirectory: statSync(pathOf(uri)).isDirectory() };
                } catch {
                    return { exists: false, isDirectory: null };
                }
            },
        },
        Directory: class {
            readonly path: string;
            constructor(uri: string) {
                this.path = pathOf(uri);
            }
            create(options: { intermediates: boolean; idempotent: boolean }) {
                if (existsSync(this.path) && options.idempotent) {
                    return;
                }
                mkdirSync(this.path, { recursive: options.intermediates });
            }
            delete() {
                if (!existsSync(this.path)) {
                    throw new Error(`UnableToDeleteException: path does not exist`);
                }
                rmSync(this.path, { recursive: true });
            }
        },
        File: class {
            readonly path: string;
            constructor(uri: string) {
                this.path = pathOf(uri);
            }
            delete() {
                rmSync(this.path);
            }
        },
        readDirectoryAsync: async (uri) => {
            log.push(`readDirectory ${uri}`);
            return readdir(pathOf(uri));
        },
    };
    return { expo, log };
}

describeFileSystemContract('expo-file-system (fake)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'socio-expo-fs-'));
    return {
        fs: createExpoFileSystem(fakeExpoFileSystem().expo),
        root,
        writeFile: (path) => writeFile(path, 'bytes'),
        lock: async (path) => {
            // Root reads any directory, whatever its mode.
            if (process.getuid?.() === 0) {
                return null;
            }
            await chmod(path, 0o000);
            return () => chmod(path, 0o755);
        },
        dispose: () => rm(root, { recursive: true, force: true }),
    };
});

describe('the expo-file-system binding', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'socio-expo-fs-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('hands expo-file-system file:// URIs, as the store’s root is one', async () => {
        const { expo, log } = fakeExpoFileSystem();
        const fs = createExpoFileSystem(expo);
        await mkdir(join(root, 'socio'));
        expect(await fs.exists(fileUri(join(root, 'socio')))).toBe(true);
        expect(await fs.exists(join(root, 'socio'))).toBe(true);
        expect(log).toEqual([`info ${fileUri(join(root, 'socio'))}`, `info ${fileUri(join(root, 'socio'))}`]);
        expect(fileUri('/data/user/0/app/files/a b')).toBe('file:///data/user/0/app/files/a%20b');
    });

    it('throws when exists() reads an entry as missing that its directory lists', async () => {
        await mkdir(join(root, 'socio'));
        await writeFile(join(root, 'socio', 'registry.db'), 'bytes');
        const fs = createExpoFileSystem(fakeExpoFileSystem(new Set([join(root, 'socio', 'registry.db')])).expo);
        await expect(fs.exists(join(root, 'socio', 'registry.db'))).rejects.toThrow(
            'its directory lists it, but it reads as missing',
        );
        await expect(fs.remove(join(root, 'socio', 'registry.db'))).rejects.toThrow();
        expect(existsSync(join(root, 'socio', 'registry.db'))).toBe(true);
    });

    it('lists a missing directory as [] only once its parent confirms it is gone', async () => {
        const { expo, log } = fakeExpoFileSystem();
        const fs = createExpoFileSystem(expo);
        expect(await fs.list(join(root, 'socio'))).toEqual([]);
        expect(log).toEqual([
            `readDirectory ${fileUri(join(root, 'socio'))}`,
            `info ${fileUri(join(root, 'socio'))}`,
            `readDirectory ${fileUri(root)}`,
        ]);
    });

    it('throws for list() on a file, which is there but isn’t a directory', async () => {
        await writeFile(join(root, 'registry.db'), 'bytes');
        const fs = createExpoFileSystem(fakeExpoFileSystem().expo);
        await expect(fs.list(join(root, 'registry.db'))).rejects.toThrow('could not be listed');
    });
});
