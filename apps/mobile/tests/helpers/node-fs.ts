import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import type { FileSystem } from '../../src/data/layout';

// The store's FileSystem on node:fs, for tests on a real temporary directory.
// The platform binds expo-file-system the same way, and both pass
// tests/helpers/file-system-contract.ts: a read that fails throws, never
// answers "nothing there".

type Call = 'list' | 'remove' | 'exists' | 'mkdir';

export interface NodeFileSystemOptions {
    /** Runs before each call, which it may fail by throwing. */
    readonly before?: (call: Call, path: string) => void;
    /** Changes what `list` answers, as a binding that hides an error would (expo-file-system's Android `list()`). */
    readonly list?: (path: string, entries: string[]) => string[];
    /** Changes what `exists` answers, given what is there, as a binding for one kind only would. */
    readonly exists?: (path: string, kind: 'file' | 'directory' | null) => boolean;
}

export interface NodeFileSystem extends FileSystem {
    /** Every call, as `<call> <path>`, in order. */
    readonly log: string[];
}

/** Nothing is there: any other error is one the caller must see. */
const isMissing = (error: unknown) => {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR';
};

async function kindOf(path: string): Promise<'file' | 'directory' | null> {
    try {
        return (await stat(path)).isDirectory() ? 'directory' : 'file';
    } catch (error) {
        if (isMissing(error)) {
            return null;
        }
        throw error;
    }
}

export function createNodeFileSystem(options: NodeFileSystemOptions = {}): NodeFileSystem {
    const log: string[] = [];
    const call = (name: Call, path: string) => {
        log.push(`${name} ${path}`);
        options.before?.(name, path);
    };
    return {
        log,
        list: async (path) => {
            call('list', path);
            let entries: string[];
            try {
                entries = (await readdir(path)).sort();
            } catch (error) {
                if (!isMissing(error)) {
                    throw error;
                }
                entries = [];
            }
            return options.list?.(path, entries) ?? entries;
        },
        remove: async (path) => {
            call('remove', path);
            await rm(path, { recursive: true, force: true });
        },
        exists: async (path) => {
            call('exists', path);
            const kind = await kindOf(path);
            return options.exists?.(path, kind) ?? kind !== null;
        },
        mkdir: async (path) => {
            call('mkdir', path);
            await mkdir(path, { recursive: true });
        },
    };
}
