import { Directory, File, Paths } from 'expo-file-system';
import { moveAsync } from 'expo-file-system/legacy';

import type { SizeOf } from '../data/cache-size';
import type { FileSystem } from '../data/layout';
import type { FileCacheFiles } from '../sync/file-cache';

import { fileUri } from './file-system';

// The Media file cache's file operations (src/sync/file-cache.ts, CB-558) on
// expo-file-system 58. The cache hands in store paths under the store's
// file:// root, a file's name already one encoded segment there, so each goes
// to expo-file-system as the URI it is (`fileUri`): "report #1.pdf" and
// "growth 50%.txt" are files of those names, never a fragment or a bad escape.
// Listing and making folders are the store's (src/platform/file-system.ts).

/** The slice of expo-file-system it uses, so the tests can hand in a fake. */
export interface ExpoCacheFiles {
    readonly Paths: { info(...uris: string[]): { exists: boolean; isDirectory: boolean | null } };
    readonly Directory: new (uri: string) => { delete(): void };
    readonly File: new (uri: string) => {
        create(options: { overwrite: boolean }): void;
        write(bytes: Uint8Array): void | Promise<void>;
        text(): Promise<string>;
        delete(): void;
    };
    moveAsync(options: { from: string; to: string }): Promise<void>;
}

const EXPO_CACHE_FILES: ExpoCacheFiles = { Paths, Directory, File, moveAsync };

export function createFileCacheFiles(
    store: Pick<FileSystem, 'list' | 'mkdir'>,
    sizeOf: SizeOf,
    expo: ExpoCacheFiles = EXPO_CACHE_FILES,
): FileCacheFiles {
    return {
        list: (path) => store.list(path),
        remove: async (path) => {
            const uri = fileUri(path);
            const info = expo.Paths.info(uri);
            if (!info.exists) {
                return;
            }
            if (info.isDirectory) {
                new expo.Directory(uri).delete();
            } else {
                new expo.File(uri).delete();
            }
        },
        mkdir: (path) => store.mkdir(path),
        size: sizeOf,
        exists: async (path) => expo.Paths.info(fileUri(path)).exists,
        readText: (path) => new expo.File(fileUri(path)).text(),
        write: async (path, bytes) => {
            const file = new expo.File(fileUri(path));
            file.create({ overwrite: true });
            await file.write(bytes);
        },
        move: (from, to) => expo.moveAsync({ from: fileUri(from), to: fileUri(to) }),
    };
}
