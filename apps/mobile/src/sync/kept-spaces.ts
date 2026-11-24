import type { SqlConnection, UserDbState } from '../data';

// The Spaces kept offline,
// the scope's `keptSpaces`: user.db's `prefs` (migration 3) under
// `KEPT_SPACES_PREF`, a JSON list of Space ids in the order they were kept.
// They live in user.db, not cache.db's `kv`, so Clear cache keeps the choice.
// - Read whole as the scope opens; each change shows at once (`subscribe`) and
//   is written through one queue, in the order made.
// - A read-only user.db (a newer build's file, a failed migration) shows what
//   it holds and takes no change (`writable` false): the screens say
//   `KEEP_NEEDS_UPDATE`.
// - The list keeps ids whatever the workspace says: a Space the person lost
//   is skipped by the prefetch (keep-offline.ts) and by Settings, and comes
//   back kept if access does.
// No React Native: tests/sync runs it under Node.

/** user.db's `prefs` key of the kept Spaces. */
export const KEPT_SPACES_PREF = 'keptSpaces';
/** The first user.db migration that has `prefs`. */
export const PREFS_MIGRATION = 3;

export interface KeptSpaces {
    /** The kept Spaces' ids, oldest first; the same array until a change. */
    list(): readonly string[];
    has(spaceId: string): boolean;
    /** Whether a change can be kept (user.db is writable). */
    readonly writable: boolean;
    /** Keeps Space `spaceId` offline, or stops. Shown at once; resolves once user.db has it. Rejects when read-only. */
    set(spaceId: string, kept: boolean): Promise<void>;
    /** Calls `listener` after each change. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Takes no more changes, and waits for those made. */
    close(): Promise<void>;
}

export interface KeptSpacesOptions {
    /** The workspace's user.db. */
    readonly db: SqlConnection;
    readonly state: UserDbState;
    readonly onError?: (error: unknown) => void;
}

/** A read-only user.db, or a closed scope, refused a change. */
export class KeptSpacesError extends Error {
    override readonly name = 'KeptSpacesError';
}

function parseIds(value: string | undefined): string[] {
    if (value === undefined) {
        return [];
    }
    try {
        const ids: unknown = JSON.parse(value);
        return Array.isArray(ids)
            ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
            : [];
    } catch {
        return [];
    }
}

export async function openKeptSpaces(options: KeptSpacesOptions): Promise<KeptSpaces> {
    const { db, state, onError = () => {} } = options;
    let ids: readonly string[] = [];
    if (state.version >= PREFS_MIGRATION) {
        try {
            const row = await db.get<{ value: string }>('SELECT value FROM prefs WHERE key = ?', [KEPT_SPACES_PREF]);
            ids = parseIds(row?.value);
        } catch (error) {
            // A read that fails keeps nothing: bodies just stay bounded like any other.
            onError(error);
        }
    }
    const writable = state.writable && state.version >= PREFS_MIGRATION;
    const listeners = new Set<() => void>();
    let writes: Promise<void> = Promise.resolve();
    let closed = false;

    return {
        list: () => ids,
        has: (spaceId) => ids.includes(spaceId),
        writable,
        set(spaceId, kept) {
            if (closed || !writable) {
                return Promise.reject(new KeptSpacesError('The kept Spaces can’t change on this copy.'));
            }
            if (ids.includes(spaceId) === kept) {
                return writes;
            }
            ids = kept ? [...ids, spaceId] : ids.filter((id) => id !== spaceId);
            const value = JSON.stringify(ids);
            for (const listener of [...listeners]) {
                try {
                    listener();
                } catch (error) {
                    onError(error);
                }
            }
            const write = writes.then(() =>
                db.transaction(async (tx) => {
                    await tx.run(
                        'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                        [KEPT_SPACES_PREF, value],
                    );
                }),
            );
            writes = write.catch(onError);
            return write;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        close() {
            closed = true;
            listeners.clear();
            return writes;
        },
    };
}
