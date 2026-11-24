import { Directory, File, Paths } from 'expo-file-system';

import type { SizeOf } from '../data/cache-size';

import { fileUri } from './file-system';

// The store's SizeOf (src/data/cache-size.ts) on expo-file-system 58: a file's
// `size`, a directory's (every file in it, however deep, on both platforms),
// and 0 when nothing is there. It only feeds the number Settings shows, so a
// path `info` can't see counts as nothing, never as an error.

/** The slice of expo-file-system it uses, so the tests can hand in a fake. */
export interface ExpoSizes {
    readonly Paths: { info(...uris: string[]): { exists: boolean; isDirectory: boolean | null } };
    readonly Directory: new (uri: string) => { readonly size: number | null };
    readonly File: new (uri: string) => { readonly size: number | null };
}

const EXPO_SIZES: ExpoSizes = { Paths, Directory, File };

export function createSizeOf(expo: ExpoSizes = EXPO_SIZES): SizeOf {
    return async (path) => {
        const uri = fileUri(path);
        const info = expo.Paths.info(uri);
        if (!info.exists) {
            return 0;
        }
        const size = info.isDirectory ? new expo.Directory(uri).size : new expo.File(uri).size;
        return size ?? 0;
    };
}
