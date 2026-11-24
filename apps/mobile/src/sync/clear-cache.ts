import { clearCache, type Store } from '../data';

// Settings' Clear cache for the open workspace. The scope holds cache.db open
// and writes to it, so it closes first and stays closed while the file goes
// (the hold sign-out uses), then opens again on the empty cache: the shell
// refills from the network, and the outbox's overlays come back from user.db,
// which Clear cache never touches. No React Native: tests/sync runs it under
// Node.

export interface ClearCacheDeps {
    readonly store: Store;
    /** Closes workspace `id`'s scope and keeps it closed; resolves once it has disposed. */
    readonly hold: (id: string) => Promise<void>;
    /** Lets the scope follow the gate again, which opens it. */
    readonly release: (id: string) => Promise<void>;
}

/** Clears workspace `id`'s cache with its scope closed, then lets the scope open again, whether or not the clear worked. */
export async function clearWorkspaceCache(deps: ClearCacheDeps, id: string): Promise<void> {
    await deps.hold(id);
    try {
        const cache = await clearCache(deps.store, id);
        await cache.db.close();
    } finally {
        await deps.release(id);
    }
}
