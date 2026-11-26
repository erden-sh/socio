import { Directory, File, Paths } from 'expo-file-system';
import { readDirectoryAsync } from 'expo-file-system/legacy';

import type { FileSystem } from '../data/layout';

// The store's FileSystem on expo-file-system 58 (src/data/layout.ts), which
// must pass tests/helpers/file-system-contract.ts: a read it can't do throws,
// never answering "nothing there", and `exists` answers for files and
// directories in one call. expo-file-system doesn't hold to that by itself:
//
// - Android's `Directory.list()` answers [] when the listing fails (Java's
//   `listFiles()` gives null, which it reads as empty). The legacy
//   `readDirectoryAsync` throws instead, on both platforms, for a directory
//   that is missing, isn't one, or can't be read; so `list` uses it, and takes
//   a throw as "missing" only once `exists` agrees.
// - `Paths.info`, `File.exists` and `Directory.exists` answer false whenever
//   they can't look (Java's `File.exists()`, Foundation's `fileExists`). So a
//   false is checked against the parent's listing: a parent that lists the
//   name, or is there but can't be listed, throws; a parent that is gone
//   makes it gone too.
//
// Paths are file:// URIs, as `Paths.document.uri` gives the store's root, or
// absolute paths, which become file:// URIs here.

/**
 * A store path as the file:// URI expo-file-system takes: a URI as it is, an absolute path with each
 * name encoded as one segment (so `#`, `?` and `%` in a name stay letters of it).
 */
export function fileUri(path: string): string {
    return path.startsWith('file://') ? path : `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The parent of `path` and its last name (as a listing gives it, decoded), or null for the root. */
function split(path: string): { parent: string; name: string } | null {
    const scheme = path.startsWith('file://') ? 'file://' : '';
    const rest = path.slice(scheme.length).replace(/\/+$/, '');
    const cut = rest.lastIndexOf('/');
    if (cut < 0) {
        return null;
    }
    const name = rest.slice(cut + 1);
    return {
        parent: scheme + (cut === 0 ? '/' : rest.slice(0, cut)),
        name: scheme === '' ? name : decodeURIComponent(name),
    };
}

/** `exists` can't tell whether something is at `path`. */
export class FileSystemReadError extends Error {
    override readonly name = 'FileSystemReadError';
    readonly path: string;

    constructor(path: string, message: string, cause?: unknown) {
        super(`${path}: ${message}`);
        this.path = path;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

/** The slice of expo-file-system the binding uses, so the tests can hand in a fake. */
export interface ExpoFileSystem {
    readonly Paths: { info(...uris: string[]): { exists: boolean; isDirectory: boolean | null } };
    readonly Directory: new (uri: string) => {
        create(options: { intermediates: boolean; idempotent: boolean }): void;
        delete(): void;
    };
    readonly File: new (uri: string) => { delete(): void };
    readDirectoryAsync(uri: string): Promise<string[]>;
}

const EXPO_FILE_SYSTEM: ExpoFileSystem = { Paths, Directory, File, readDirectoryAsync };

export function createExpoFileSystem(expo: ExpoFileSystem = EXPO_FILE_SYSTEM): FileSystem {
    /** Resolves once nothing is at `path`, which `info` said: its parent is gone, or lists no such name. Throws otherwise. */
    const confirmAbsent = async (path: string): Promise<void> => {
        const at = split(path);
        if (at === null) {
            throw new FileSystemReadError(path, 'a root that reads as missing.');
        }
        let names: string[];
        try {
            names = await expo.readDirectoryAsync(fileUri(at.parent));
        } catch (error) {
            if (await exists(at.parent)) {
                throw new FileSystemReadError(path, 'its directory is there but could not be listed.', error);
            }
            return;
        }
        if (names.includes(at.name)) {
            throw new FileSystemReadError(path, 'its directory lists it, but it reads as missing.');
        }
    };

    const exists = async (path: string): Promise<boolean> => {
        if (expo.Paths.info(fileUri(path)).exists) {
            return true;
        }
        await confirmAbsent(path);
        return false;
    };

    return {
        list: async (path) => {
            try {
                return await expo.readDirectoryAsync(fileUri(path));
            } catch (error) {
                if (await exists(path)) {
                    throw new FileSystemReadError(path, 'could not be listed.', error);
                }
                return [];
            }
        },
        remove: async (path) => {
            const uri = fileUri(path);
            const info = expo.Paths.info(uri);
            if (!info.exists) {
                await confirmAbsent(path);
                return;
            }
            if (info.isDirectory) {
                new expo.Directory(uri).delete();
            } else {
                new expo.File(uri).delete();
            }
        },
        exists,
        mkdir: async (path) => {
            new expo.Directory(fileUri(path)).create({ intermediates: true, idempotent: true });
        },
    };
}
