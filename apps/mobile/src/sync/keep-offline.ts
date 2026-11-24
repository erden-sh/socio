import type { Page } from '@socio/shared/pages/page-library';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { BOUNDED_ITEM_MAX_CHARS } from './bounded-kind';
import { HttpError, httpError, SnapshotShapeError } from './errors';
import type { KeptSpaces } from './kept-spaces';
import type { PagesStore } from './page-store';
import { PAGE_BODIES, PAGE_BODIES_KIND, pageBodyKey, PAGES, spaceBodyPrefix } from './pages';
import { SPACES } from './shell';
import type { SnapshotCache } from './snapshot-cache';

// Keeping a Space offline,
// the scope's `keepOffline`: every page body of each kept Space (kept-spaces.ts)
// on disk, so airplane mode reads every page of it.
// - A kept Space's bodies whose revision differs from its summary's (missing,
//   or older) are read one at a time, in one queue for every Space: after each
//   pull of its pages that changed a summary, as it is kept, as the workspace
//   first lists it (after Clear cache), and on `sync()` (the scope's start and
//   the network coming back), which pulls its pages first.
// - A body goes into page-store.ts's bodies with `put`, never into memory, so a
//   screen's bodies stay where they are; page-store.ts pins a kept Space's on
//   disk (`keptSpaces`), so the bounds never evict them.
// - A read with no answer ends that Space's round (offline: the next `sync()`
//   goes on); a 404 or 410 is skipped (the list's poll moves or drops the
//   page); a body over 4 MB is never kept, and isn't read again at the same
//   revision while the scope lives.
// - A Space the workspace no longer lists, or one no longer kept, stops.
// - `sizes()` says what each kept Space holds on disk, for Settings.
// No React Native: tests/sync runs it under Node.

/** What a kept Space holds on the phone. */
export interface KeptSpaceSize {
    /** Page bodies on disk. */
    readonly pages: number;
    /** About how many bytes: its bodies and its summaries. */
    readonly bytes: number;
}

export interface KeepOffline {
    /** Pulls each kept Space's pages, then reads the bodies whose revision differs. */
    sync(): void;
    /** What each of `spaceIds` holds on disk. */
    sizes(spaceIds: readonly string[]): Promise<Map<string, KeptSpaceSize>>;
    /** Resolves once the queue is empty. */
    idle(): Promise<void>;
    /** Stops after the read in flight, and follows nothing more. */
    close(): Promise<void>;
}

export interface KeepOfflineOptions {
    readonly kept: KeptSpaces;
    readonly pages: Pick<PagesStore, 'space' | 'bodies'>;
    readonly cache: Pick<SnapshotCache, 'rows' | 'subscribe'>;
    /** The workspace's cache.db. */
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
}

/** cache.db's scope prefix of Space `spaceId`'s bodies. */
const bodyScopePrefix = (spaceId: string) => `${PAGE_BODIES_KIND}:${PAGE_BODIES.format}:${spaceBodyPrefix(spaceId)}`;

export function createKeepOffline(options: KeepOfflineOptions): KeepOffline {
    const { kept, pages, cache, db, fetch, signal, onError = () => {} } = options;
    let closed = false;
    /** Spaces waiting for a round, and whether it pulls their pages first. */
    const waiting = new Map<string, boolean>();
    let running: Promise<void> | null = null;
    /** Bodies over the disk's 4 MB, by key: the revision not to read again. */
    const oversized = new Map<string, number>();

    const active = (spaceId: string) => !closed && kept.has(spaceId) && cache.rows(SPACES).has(spaceId);

    function queue(spaceId: string, pull: boolean) {
        if (closed) {
            return;
        }
        waiting.set(spaceId, (waiting.get(spaceId) ?? false) || pull);
        running ??= drain();
    }

    async function drain() {
        try {
            while (waiting.size > 0 && !closed) {
                const [spaceId, pull] = waiting.entries().next().value as [string, boolean];
                waiting.delete(spaceId);
                try {
                    await round(spaceId, pull);
                } catch (error) {
                    onError(error);
                }
            }
        } finally {
            running = null;
        }
    }

    /** The revision of each body of Space `spaceId` on disk, by key. */
    async function storedRevisions(spaceId: string): Promise<Map<string, number>> {
        const prefix = bodyScopePrefix(spaceId);
        const rows = await db.all<{ key: string; version: unknown }>(
            'SELECT key, version FROM rows WHERE collection = ? AND substr(scope, 1, ?) = ?',
            [PAGE_BODIES_KIND, prefix.length, prefix],
        );
        return new Map(rows.map((row) => [row.key, typeof row.version === 'number' ? row.version : -1]));
    }

    async function round(spaceId: string, pull: boolean) {
        if (!active(spaceId)) {
            return;
        }
        const space = pages.space(spaceId);
        if (pull) {
            if ((await space.pull()).outcome === 'failed') {
                return;
            }
        } else {
            await space.loaded;
        }
        const stored = await storedRevisions(spaceId);
        for (const [pageId, row] of cache.rows(PAGES, spaceId)) {
            if (!active(spaceId)) {
                return;
            }
            const key = pageBodyKey(spaceId, pageId);
            const revision = typeof row.version === 'number' ? row.version : null;
            const have = stored.get(key);
            if (have !== undefined && revision !== null && have >= revision) {
                continue;
            }
            if (revision !== null && oversized.get(key) === revision) {
                continue;
            }
            if ((await read(key)) === 'failed') {
                return;
            }
        }
    }

    /** Reads one body into the bodies' disk. */
    async function read(key: string): Promise<'kept' | 'skipped' | 'failed'> {
        const path = PAGE_BODIES.path(key);
        let page: Page;
        try {
            const response = await fetch(path);
            if (!response.ok) {
                throw await httpError(response, signal);
            }
            page = PAGE_BODIES.parse(path, await readJson(response, signal));
        } catch (error) {
            if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
                return 'skipped';
            }
            if (error instanceof SnapshotShapeError) {
                onError(error);
                return 'skipped';
            }
            return 'failed';
        }
        if (closed) {
            return 'failed';
        }
        if (JSON.stringify(page).length > BOUNDED_ITEM_MAX_CHARS) {
            oversized.set(key, page.revision);
            return 'skipped';
        }
        await pages.bodies.put(key, page);
        return 'kept';
    }

    let known = new Set(kept.list());
    const unfollow = [
        kept.subscribe(() => {
            const now = new Set(kept.list());
            for (const spaceId of now) {
                if (!known.has(spaceId)) {
                    queue(spaceId, true);
                }
            }
            known = now;
        }),
        cache.subscribe((change) => {
            for (const row of change.upserts) {
                if (row.scope === '' && row.collection === SPACES && kept.has(row.key)) {
                    // Listed again, or for the first time since Clear cache.
                    queue(row.key, true);
                } else if (!change.confirmed && row.collection === PAGES && kept.has(row.scope)) {
                    queue(row.scope, false);
                }
            }
        }),
    ];

    return {
        sync() {
            for (const spaceId of kept.list()) {
                queue(spaceId, true);
            }
        },
        async sizes(spaceIds) {
            const sizes = new Map<string, KeptSpaceSize>();
            for (const spaceId of spaceIds) {
                const prefix = bodyScopePrefix(spaceId);
                const bodies = await db.get<{ pages: number; bytes: number | null }>(
                    'SELECT count(*) AS pages, sum(bytes) AS bytes FROM scopes WHERE substr(scope, 1, ?) = ?',
                    [prefix.length, prefix],
                );
                const summaries = await db.get<{ bytes: number | null }>(
                    'SELECT sum(length(json)) AS bytes FROM rows WHERE collection = ? AND scope = ?',
                    [PAGES, spaceId],
                );
                sizes.set(spaceId, {
                    pages: Number(bodies?.pages ?? 0),
                    bytes: Number(bodies?.bytes ?? 0) + Number(summaries?.bytes ?? 0),
                });
            }
            return sizes;
        },
        idle: () => running ?? Promise.resolve(),
        async close() {
            closed = true;
            waiting.clear();
            for (const stop of unfollow.splice(0)) {
                stop();
            }
            await running;
        },
    };
}
