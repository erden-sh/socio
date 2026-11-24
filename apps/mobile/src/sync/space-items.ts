import type { Collection } from '@tanstack/db';

import { SPACE_PLACE_REFUSED, type SpaceItem } from '@socio/shared/spaces/space-items';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { mirrorCollection } from './collections';
import { HttpError, httpError, SnapshotShapeError } from './errors';
import type { SyncScheduler } from './scheduler';
import type { PullResult, SnapshotCache, SnapshotDefinition } from './snapshot-cache';
import { keyed, list, object } from './snapshot-shape';
import { createSnapshotSource, type SyncSource } from './snapshot-source';

// Datasets in Spaces (CB-469; CB-451), behind the workspace's
// `datasets-in-spaces` flag, as the web's sidebar reads them:
// - `space-items`, a scoped snapshot kind: `GET /api/spaces/:id/items`, the
//   Space's pages and datasets with their `kind`, one cache scope per Space,
//   pulled as its screen shows and every 15 s while it does (the pages' rhythm).
// - `private-items`, a whole kind: `GET /api/data/private-items`, the person's
//   own datasets no Space holds (the "Private" group at the top of the Spaces).
// Both answer 304 on their ETag. Each item carries a `version` (#663: a page's
// revision, a dataset's `spaceItemVersion`, a hash of every field it lists), to
// be compared for equality only: it has no order. So the cache's merge, which
// takes only a newer version (merge.ts), never reads it: the rows are kept
// unversioned, each 200 diffed against them, and only an item whose fields
// changed is rewritten. Per-item work (a dataset's table views) is keyed on
// `version` (`itemChanged`). An item of a kind this version doesn't know is
// kept as it came: the screens show it by title, "Not supported in this version".
// - `placeDataset` places or moves one (`PATCH /api/data/datasets/:id` with
//   `sharedSpaceId` and `spaceParentId`); only a Space's editors may, and the
//   server checks: its 403 says why (`SPACE_PLACE_REFUSED`).
// No React Native: tests/sync runs it under Node.

export const SPACE_ITEMS = 'space-items';
export const PRIVATE_ITEMS = 'private-items';
/** The web's flag: dataset items in Spaces and the Private group (packages/shared/src/flags.ts). */
export const DATASETS_IN_SPACES = 'datasets-in-spaces';
/** How often a Space in view asks for its items again: the pages' interval. */
export const SPACE_ITEMS_POLL_MS = 15_000;
/** How often the Spaces list asks for the Private group again while it shows. */
export const PRIVATE_ITEMS_POLL_MS = 30_000;

const SPACE_ITEMS_PATH = '/api/spaces/:id/items';
export const PRIVATE_ITEMS_PATH = '/api/data/private-items';

/** An item as kept: any `kind`, since a later server may add one (a dashboard). */
export type HeldItem = SpaceItem | (Omit<SpaceItem, 'kind'> & { readonly kind: string });

function items(path: string, body: unknown) {
    const fields = object(path, body, 'the body');
    const values = list(path, fields.items, 'items');
    for (const value of values) {
        const item = object(path, value, 'an item');
        if (typeof item.kind !== 'string' || typeof item.title !== 'string') {
            throw new SnapshotShapeError(path, 'an item without its kind or title.');
        }
        if (item.parentId !== null && typeof item.parentId !== 'string') {
            throw new SnapshotShapeError(path, 'an item whose parent is neither a page nor the root.');
        }
        if (typeof item.position !== 'string') {
            throw new SnapshotShapeError(path, 'an item without its position.');
        }
    }
    // Unversioned on purpose (the module comment): `version` is a hash, not an order.
    return [keyed(path, values, 'items', { key: 'id' })];
}

/** `GET /api/spaces/:id/items`: one Space's items by id, under the list's ETag. */
export const SPACE_ITEMS_SNAPSHOT: SnapshotDefinition = {
    id: SPACE_ITEMS,
    path: SPACE_ITEMS_PATH,
    scopedPath: (spaceId) => `/api/spaces/${encodeURIComponent(spaceId)}/items`,
    format: 1,
    feeds: [{ collection: SPACE_ITEMS }],
    split: (body) => items(SPACE_ITEMS_PATH, body),
};

/** `GET /api/data/private-items`: the person's datasets in no Space, under their own ETag. */
export const PRIVATE_ITEMS_SNAPSHOT: SnapshotDefinition = {
    id: PRIVATE_ITEMS,
    path: PRIVATE_ITEMS_PATH,
    format: 1,
    feeds: [{ collection: PRIVATE_ITEMS }],
    split: (body) => items(PRIVATE_ITEMS_PATH, body),
};

/** What a pull of a list of items did. */
export type ItemsPull =
    | { readonly outcome: 'fresh'; readonly result: PullResult }
    | { readonly outcome: 'failed'; readonly error: unknown };

/** One list of items (a Space's, or the Private group): its rows and their sync. */
export interface ItemsList {
    /** The items by id, in no order: a screen orders them (`spaceItemTree`). */
    readonly collection: Collection<HeldItem, string>;
    /** Resolves once cache.db's copy is in memory (no network). */
    readonly loaded: Promise<void>;
    /** A screen shows it: pulled if its last answer is older than 5 s, polled while it shows. Returns the leave. */
    view(): () => void;
    /** Asks the server now, with its ETag. */
    pull(): Promise<ItemsPull>;
}

export interface SpaceItemsStore {
    /** Space `spaceId`'s items, made as first asked. */
    space(spaceId: string): ItemsList;
    /** The person's Private group. */
    private(): ItemsList;
    /** A dataset item the phone holds, in Space `spaceId` or (null) the Private group; null when it holds none. */
    dataset(datasetId: string, spaceId: string | null): HeldItem | null;
    /** Drops a Space the person lost: its items leave memory and disk. */
    dropSpace(spaceId: string): Promise<void>;
    close(): Promise<void>;
}

export interface SpaceItemsOptions {
    readonly scopeId: string;
    readonly cache: SnapshotCache;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly scheduler: () => Pick<SyncScheduler, 'add' | 'view'> | null;
    readonly onError?: (error: unknown) => void;
}

/** Whether an item changed since `held` (#663): its version compared for equality, never for order. */
export const itemChanged = (held: Pick<HeldItem, 'version'> | null | undefined, next: Pick<HeldItem, 'version'>) =>
    held === null || held === undefined || held.version !== next.version;

const toItem = (key: string, value: unknown): HeldItem =>
    (value as { id?: unknown } | null)?.id === key
        ? (value as HeldItem)
        : ({ ...(value as object), id: key } as HeldItem);

/** Opens the Spaces' items and the Private group on the scope's cache. */
export function createSpaceItems(options: SpaceItemsOptions): SpaceItemsStore {
    const { scopeId, cache, fetch, signal, scheduler, onError = () => {} } = options;
    let closed = false;

    class Entry implements ItemsList {
        readonly collection: Collection<HeldItem, string>;
        readonly loaded: Promise<void>;
        readonly source: SyncSource;
        private removeJob: (() => void) | null = null;
        disposed = false;

        constructor(
            readonly definition: SnapshotDefinition,
            readonly name: string,
            readonly scope: string,
            readonly pollMs: number,
        ) {
            this.source = createSnapshotSource({ definition, cache, fetch, signal });
            this.loaded = (scope === '' ? cache.load([definition]) : cache.load([definition], scope)).catch(onError);
            this.collection = mirrorCollection<HeldItem>({
                id: `${scopeId}/${name}${scope === '' ? '' : `/${scope}`}`,
                name,
                scope,
                cache,
                toItem,
                getKey: (item) => item.id,
                closed: () => closed || this.disposed,
            });
        }

        private job() {
            const jobs = scheduler();
            if (this.removeJob === null && jobs !== null && !this.disposed) {
                this.removeJob = jobs.add({
                    source: this.source,
                    ...(this.scope === '' ? {} : { scope: this.scope }),
                    collections: [this.name],
                    visiblePoll: this.pollMs,
                    inView: true,
                    deferred: true,
                });
            }
            return jobs;
        }

        view() {
            const jobs = this.job();
            return jobs === null || this.disposed
                ? () => {}
                : this.scope === ''
                  ? jobs.view([this.name])
                  : jobs.view([this.name], this.scope);
        }

        async pull(): Promise<ItemsPull> {
            this.job();
            try {
                await this.loaded;
                const result = await this.source.pull(this.scope, this.source.cursor(this.scope));
                return { outcome: 'fresh', result };
            } catch (error) {
                return { outcome: 'failed', error };
            }
        }

        dispose() {
            this.disposed = true;
            this.removeJob?.();
            this.removeJob = null;
            return this.collection.cleanup({ dependents: true });
        }
    }

    const spaces = new Map<string, Entry>();
    let privateEntry: Entry | null = null;
    const open = () => {
        if (closed) {
            throw new Error('The Space items are closed.');
        }
    };

    return {
        space(spaceId) {
            open();
            let entry = spaces.get(spaceId);
            if (entry === undefined) {
                entry = new Entry(SPACE_ITEMS_SNAPSHOT, SPACE_ITEMS, spaceId, SPACE_ITEMS_POLL_MS);
                spaces.set(spaceId, entry);
            }
            return entry;
        },
        private() {
            open();
            privateEntry ??= new Entry(PRIVATE_ITEMS_SNAPSHOT, PRIVATE_ITEMS, '', PRIVATE_ITEMS_POLL_MS);
            return privateEntry;
        },
        dataset(datasetId, spaceId) {
            const row =
                spaceId === null
                    ? cache.rows(PRIVATE_ITEMS).get(datasetId)
                    : cache.rows(SPACE_ITEMS, spaceId).get(datasetId);
            if (row === undefined) {
                return null;
            }
            const item = toItem(row.key, JSON.parse(row.json) as unknown);
            return item.kind === 'dataset' ? item : null;
        },
        async dropSpace(spaceId) {
            const entry = spaces.get(spaceId);
            spaces.delete(spaceId);
            await entry?.dispose().catch(onError);
            await cache.dropScope(SPACE_ITEMS_SNAPSHOT, spaceId).catch(onError);
        },
        async close() {
            closed = true;
            const entries = [...spaces.values(), ...(privateEntry === null ? [] : [privateEntry])];
            spaces.clear();
            privateEntry = null;
            await Promise.all(entries.map((entry) => entry.dispose().catch(onError)));
        },
    };
}

// ----- Placing a dataset (who may place) -----

/** Where a dataset goes: a Space (its root, or under one of its pages), or out of every Space (null). */
export interface DatasetPlace {
    readonly spaceId: string | null;
    readonly parentId: string | null;
}

/** The PATCH body that puts a dataset at `place`: out of a Space takes its place with it. */
export function placeBody(place: DatasetPlace): { sharedSpaceId: string | null; spaceParentId?: string | null } {
    return place.spaceId === null
        ? { sharedSpaceId: null }
        : { sharedSpaceId: place.spaceId, spaceParentId: place.parentId };
}

export const datasetPath = (datasetId: string) => `/api/data/datasets/${encodeURIComponent(datasetId)}`;

/** What a placement did: placed, or refused with the words to say. */
export type PlaceResult =
    | { readonly outcome: 'placed' }
    | { readonly outcome: 'refused'; readonly status: number | null; readonly message: string };

/** The words for a refused placement: the server's 403 explains itself; a 404 says what it means here. */
export function placeRefusal(error: unknown): { status: number | null; message: string } {
    if (error instanceof HttpError) {
        if (error.status === 403) {
            return { status: 403, message: error.message.trim() === '' ? SPACE_PLACE_REFUSED : error.message };
        }
        if (error.status === 404) {
            return {
                status: 404,
                message: error.message.trim() === '' ? 'That dataset or page isn’t there any more.' : error.message,
            };
        }
        return { status: error.status, message: error.message };
    }
    return { status: null, message: 'Couldn’t reach the server. Try again when you’re online.' };
}

/**
 * Places or moves dataset `datasetId` (online only: a placement changes who can read it, so it
 * never waits in the outbox). Refusals come back with the server's words.
 */
export async function placeDataset(input: {
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly datasetId: string;
    readonly place: DatasetPlace;
}): Promise<PlaceResult> {
    try {
        const response = await input.fetch(datasetPath(input.datasetId), {
            method: 'PATCH',
            json: placeBody(input.place),
        });
        if (!response.ok) {
            throw await httpError(response, input.signal);
        }
        await readJson(response, input.signal);
        return { outcome: 'placed' };
    } catch (error) {
        return { outcome: 'refused', ...placeRefusal(error) };
    }
}
