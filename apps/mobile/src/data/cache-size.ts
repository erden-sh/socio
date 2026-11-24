import { joinPath, workspaceLayout } from './layout';

// The local cache's size, for Settings: what Clear cache deletes (wipe.ts,
// `clearCache`), cache.db with its write-ahead log and shared memory, and the
// image cache (`images/`). user.db and picked attachments aren't the cache,
// so they don't count.

/**
 * The bytes at `path`: a file's size, or everything in a directory, however
 * deep; 0 when nothing is there. Throws when it can't tell.
 */
export type SizeOf = (path: string) => Promise<number>;

/** The paths Clear cache deletes for workspace `id` under `root`. */
export function cachePaths(root: string, id: string): string[] {
    const { cache, images } = workspaceLayout(root, id);
    return [
        joinPath(cache.directory, cache.name),
        joinPath(cache.directory, `${cache.name}-wal`),
        joinPath(cache.directory, `${cache.name}-shm`),
        images,
    ];
}

/** Workspace `id`'s local cache in bytes. */
export async function cacheSize(sizeOf: SizeOf, root: string, id: string): Promise<number> {
    let total = 0;
    for (const path of cachePaths(root, id)) {
        total += await sizeOf(path);
    }
    return total;
}
