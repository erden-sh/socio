import type { Collection } from '@tanstack/db';

import type { Page, PageSummary } from '@socio/shared/pages/page-library';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import { keptPage, keptSpace, LAST_SCREEN_KEY, pageScreen } from '../shell/last-screen';

import { type BoundedItem, type BoundedStore, createBoundedStore } from './bounded-kind';
import { mirrorCollection } from './collections';
import { createDatasetViews, type DatasetViews } from './dataset-views';
import { HttpError, httpError } from './errors';
import { type Outbox, UNSENT_GONE } from './outbox';
import {
    PAGE_BODIES,
    PAGE_BODIES_KIND,
    pageBodyKey,
    pageLanes,
    pageLocationPath,
    pageOfLane,
    PAGES,
    PAGES_POLL_MS,
    PAGES_SNAPSHOT,
    parsePageBodyKey,
    spaceBodyPrefix,
} from './pages';
import type { SyncScheduler } from './scheduler';
import { SPACES, WORKSPACE_SNAPSHOT } from './shell';
import type { PullResult, SnapshotCache } from './snapshot-cache';
import { createSnapshotSource, type SyncSource } from './snapshot-source';
import { createSpaceItems, type SpaceItemsStore } from './space-items';
import { createSpaceSections, parseSpaceSectionKey, SPACE_SECTIONS_KIND, type SpaceSections } from './space-sections';
import type { ViewState } from './view-state';

// A workspace's pages, the scope's `pages`:
// - Each Space's summaries (pages.ts's `pages` kind) are a TanStack DB
//   collection, `<scope id>/pages/<spaceId>`, read from cache.db as the Space is
//   first asked (`space()`), then pulled with its ETag: as a screen shows the
//   Space (`view()`, through the scheduler's `inView` job for that scope), every
//   15 s while it shows, on a return to the foreground while it shows, and
//   before a page of it opens online (`open()`).
// - Page bodies (pages.ts's `page-body`, a bounded kind) are read on open only
//   when the phone has none or an older revision than the summary's (`fresh`),
//   and again when the list's poll brings a newer revision for one held in
//   memory. A Space's poll that drops a page asks again for a body the phone
//   holds: a 404 reads `/api/pages/:id/location`, and a page that moved is
//   re-keyed to its new Space (the last screen `Page/<spaceId>/<pageId>` with
//   it, and `onMoved` tells the screen); a page that is gone (a 410, or a 404
//   with no location) is dropped and its writes go to Unsent with "You no
//   longer have access" (the Unsent list's `refuseLanes`).
// - Disk keeps the 200 most recently used bodies, about 20 M characters, never
//   one over 4 MB, never one a screen shows, one with queued writes (its page's
//   lanes) nor one of a kept Space (`keptSpaces`).
// - A Space that leaves `/api/workspace` drops its summaries and bodies in one
//   cache.db transaction, and its pages' queued writes go to Unsent; one a kill
//   left on disk is dropped as the store opens.
// - `preload(spaceId, pageId)` reads both from disk alone: a row press, a link,
//   and a cold start onto a kept page (last-screen.ts's `preloadKeptPage`), so
//   the first frame draws it; with no body kept, the screen has the title and
//   excerpt ("Open it once you're online").
// No React Native: tests/sync runs it under Node.

/** One Space's pages: its summaries and their sync. */
export interface SpacePages {
    readonly spaceId: string;
    /** The Space's summaries by page id, in no order: a screen sorts. */
    readonly collection: Collection<PageSummary, string>;
    /** Resolves once cache.db's copy is in memory (no network). */
    readonly loaded: Promise<void>;
    /** A screen shows the Space: pulled if its last answer is older than 5 s, polled while it shows. Returns the leave. */
    view(): () => void;
    /** Asks the server for the Space's pages now, with its ETag. */
    pull(): Promise<PagesPull>;
}

/** What a pull of a Space's pages did. */
export type PagesPull =
    | { readonly outcome: 'fresh'; readonly result: PullResult }
    | { readonly outcome: 'failed'; readonly error: unknown };

/** What opening a page did: the list's pull, and whether the body was asked for. */
export interface PageOpen {
    readonly list: PagesPull['outcome'];
    /** The body was asked for (missing, older than the summary, or not in the list). */
    readonly read: boolean;
}

/** A page that moved to another Space, keeping its id (CB-142). */
export interface PageMove {
    readonly pageId: string;
    readonly from: string;
    readonly to: string;
}

export interface PagesStore {
    /** Space `spaceId`'s pages, made as first asked. */
    space(spaceId: string): SpacePages;
    /** A page's summary as the phone holds it, or null. */
    summary(spaceId: string, pageId: string): PageSummary | null;
    /** The bodies (a bounded kind, keyed by `pageBodyKey`). */
    readonly bodies: BoundedStore<Page>;
    /** The pages' dataset views' last results, keyed by page like the bodies. */
    readonly views: DatasetViews;
    /** Each Space's radar and memory, read as their tab opens, dropped with the Space. */
    readonly sections: SpaceSections;
    /** Each Space's items (pages and datasets, CB-469) and the Private group, dropped with the Space. */
    readonly items: SpaceItemsStore;
    /** A page's body; hold it with `use()` in the same turn. */
    body(spaceId: string, pageId: string): BoundedItem<Page>;
    /** Reads a page's Space and body from disk alone, kept until its first `use()`. */
    preload(spaceId: string, pageId: string): Promise<BoundedItem<Page>>;
    /** Opening a page online: the Space's list first (a 304 with no change), then the body if its revision moved. */
    open(spaceId: string, pageId: string): Promise<PageOpen>;
    /** Calls `listener` with each page found moved. Returns the unsubscribe. */
    onMoved(listener: (move: PageMove) => void): () => void;
    /** This phone's own move landed: the last screen and `onMoved`'s listeners follow the page. */
    noteMoved(move: PageMove): void;
    /** Drops a Space the person lost: its summaries and bodies, and its pages' queued writes to Unsent. */
    dropSpace(spaceId: string): Promise<void>;
    /** Resolves once every disk step asked so far has been tried. */
    flush(): Promise<void>;
    /** Ends every Space's collection and the bodies, and stops following the shell. */
    close(): Promise<void>;
}

export interface PagesStoreOptions {
    /** The scope's id: the collections' ids carry it. */
    readonly scopeId: string;
    /** The workspace's cache.db. */
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly cache: SnapshotCache;
    /** The scheduler once it exists: each Space shown gets its job. */
    readonly scheduler: () => Pick<SyncScheduler, 'add' | 'view'> | null;
    /** The view state, for the last screen a move re-keys. */
    readonly viewState: Pick<ViewState, 'get' | 'set'>;
    /** The outbox once it opens: its lanes pin bodies, and a gone page's writes go to Unsent. */
    readonly outbox: () => Pick<Outbox, 'rows' | 'unsent' | 'refuseLanes' | 'status'> | null;
    /** The Spaces kept offline: their bodies stay on disk. None by default. */
    readonly keptSpaces?: () => Iterable<string>;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** What `/api/pages/:id/location` said: where the page is, that it is nowhere the person reads, or nothing. */
type Location = { readonly spaceId: string } | 'gone' | 'unknown';

/** Opens the scope's pages on its cache.db. */
export function createPagesStore(options: PagesStoreOptions): PagesStore {
    const { scopeId, db, fetch, signal, cache, scheduler, viewState, outbox } = options;
    const { keptSpaces = () => [], onError = () => {}, now } = options;
    let closed = false;
    const spaces = new Map<string, SpaceEntry>();
    /** Spaces being dropped: their summaries' removes ask for no body. */
    const dropping = new Set<string>();
    const moves = new Set<(move: PageMove) => void>();
    /** The body keys the phone holds (memory or disk), by page id: the outbox's lanes name pages, not keys. */
    const known = new Map<string, Set<string>>();
    const know = (key: string) => {
        const parts = parsePageBodyKey(key);
        if (parts !== null) {
            const keys = known.get(parts.pageId) ?? new Set<string>();
            keys.add(key);
            known.set(parts.pageId, keys);
        }
    };
    const forget = (key: string) => {
        const parts = parsePageBodyKey(key);
        const keys = parts === null ? undefined : known.get(parts.pageId);
        keys?.delete(key);
        if (parts !== null && keys?.size === 0) {
            known.delete(parts.pageId);
        }
    };

    /** The lanes that hold writes for pages: the outbox's queued and refused rows. */
    const writingPages = () => {
        const pages = new Set<string>();
        const box = outbox();
        for (const { lane } of box === null ? [] : [...box.rows(), ...box.unsent()]) {
            const page = pageOfLane(lane);
            if (page !== null) {
                pages.add(page);
            }
        }
        return pages;
    };

    const refuse = (pageIds: Iterable<string>) => {
        const box = outbox();
        const lanes = [...pageIds].flatMap(pageLanes);
        if (box !== null && lanes.length > 0 && !box.status().readOnly) {
            box.refuseLanes(lanes, UNSENT_GONE).catch(onError);
        }
    };

    const bodies = createBoundedStore<Page>({
        definition: PAGE_BODIES,
        db,
        fetch,
        signal,
        now,
        onError,
        // Read on open only when missing or older than the summary's revision.
        fresh: (key, page) => {
            const parts = parsePageBodyKey(key);
            const summary = parts === null ? null : summaryOf(parts.spaceId, parts.pageId);
            return summary !== null && summary.revision <= page.revision;
        },
        pinned: () => {
            const keys = new Set<string>();
            for (const pageId of writingPages()) {
                for (const key of known.get(pageId) ?? []) {
                    keys.add(key);
                }
            }
            const kept = new Set([...keptSpaces()].map(spaceBodyPrefix));
            if (kept.size > 0) {
                for (const held of known.values()) {
                    for (const key of held) {
                        if (kept.has(key.slice(0, key.indexOf('/') + 1))) {
                            keys.add(key);
                        }
                    }
                }
            }
            return keys;
        },
        onValue: (key) => know(key),
        onGone: (key, status) => {
            forget(key);
            const parts = parsePageBodyKey(key);
            if (parts !== null) {
                void gone(parts.spaceId, parts.pageId, status);
            }
        },
    });

    const views = createDatasetViews({ db, fetch, signal, now, onError });
    const sections = createSpaceSections({ db, fetch, signal, now, onError });
    const items = createSpaceItems({ scopeId, cache, fetch, signal, scheduler, onError });

    /** A body answered 404 or 410: moved (re-keyed), or gone (its writes to Unsent). */
    async function gone(spaceId: string, pageId: string, status: number) {
        const where = status === 404 ? await locate(pageId) : 'gone';
        if (closed || where === 'unknown') {
            return;
        }
        if (where !== 'gone' && where.spaceId !== spaceId) {
            moved({ pageId, from: spaceId, to: where.spaceId });
            return;
        }
        refuse([pageId]);
    }

    async function locate(pageId: string): Promise<Location> {
        const path = pageLocationPath(pageId);
        try {
            const response = await fetch(path);
            if (!response.ok) {
                throw await httpError(response, signal);
            }
            const body = (await readJson(response, signal)) as { spaceId?: unknown } | null;
            return typeof body?.spaceId === 'string' && body.spaceId !== '' ? { spaceId: body.spaceId } : 'unknown';
        } catch (error) {
            // A 404 says no Space the person reads holds it; no answer says nothing.
            return error instanceof HttpError && error.status === 404 ? 'gone' : 'unknown';
        }
    }

    function moved(move: PageMove) {
        const { pageId, from, to } = move;
        if (viewState.get(LAST_SCREEN_KEY) === pageScreen(from, pageId)) {
            viewState.set(LAST_SCREEN_KEY, pageScreen(to, pageId));
        }
        // The old copy was in memory (a screen had it, or it was just opened): read it where it is now.
        if (bodies.peek(pageBodyKey(from, pageId)) !== undefined) {
            void bodies.item(pageBodyKey(to, pageId)).refresh();
        }
        for (const listener of [...moves]) {
            try {
                listener(move);
            } catch (error) {
                onError(error);
            }
        }
    }

    function summaryOf(spaceId: string, pageId: string): PageSummary | null {
        const row = cache.rows(PAGES, spaceId).get(pageId);
        return row === undefined ? null : (JSON.parse(row.json) as PageSummary);
    }

    class SpaceEntry implements SpacePages {
        readonly collection: Collection<PageSummary, string>;
        readonly loaded: Promise<void>;
        readonly source: SyncSource;
        private removeJob: (() => void) | null = null;
        disposed = false;

        constructor(readonly spaceId: string) {
            this.source = createSnapshotSource({ definition: PAGES_SNAPSHOT, cache, fetch, signal });
            this.loaded = cache.load([PAGES_SNAPSHOT], spaceId).catch(onError);
            this.collection = mirrorCollection<PageSummary>({
                id: `${scopeId}/pages/${spaceId}`,
                name: PAGES,
                scope: spaceId,
                cache,
                toItem: (key, value) =>
                    (value as { id?: unknown } | null)?.id === key
                        ? (value as PageSummary)
                        : ({ ...(value as object), id: key } as PageSummary),
                getKey: (page) => page.id,
                closed: () => closed || this.disposed,
            });
        }

        /** Its scheduler job, added once the scheduler exists. */
        private job() {
            const jobs = scheduler();
            if (this.removeJob === null && jobs !== null && !this.disposed) {
                this.removeJob = jobs.add({
                    source: this.source,
                    scope: this.spaceId,
                    collections: [PAGES],
                    visiblePoll: PAGES_POLL_MS,
                    inView: true,
                    deferred: true,
                });
            }
            return jobs;
        }

        view() {
            const jobs = this.job();
            return jobs === null || this.disposed ? () => {} : jobs.view([PAGES], this.spaceId);
        }

        async pull(): Promise<PagesPull> {
            this.job();
            try {
                await this.loaded;
                const result = await this.source.pull(this.spaceId, this.source.cursor(this.spaceId));
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

    function space(spaceId: string): SpaceEntry {
        if (closed) {
            throw new Error('The pages store is closed.');
        }
        let entry = spaces.get(spaceId);
        if (entry === undefined) {
            entry = new SpaceEntry(spaceId);
            spaces.set(spaceId, entry);
        }
        return entry;
    }

    async function dropSpace(spaceId: string) {
        if (closed) {
            return;
        }
        const prefix = spaceBodyPrefix(spaceId);
        const pageIds = new Set(cache.rows(PAGES, spaceId).keys());
        for (const [pageId, keys] of known) {
            for (const key of [...keys]) {
                if (key.startsWith(prefix)) {
                    pageIds.add(pageId);
                    forget(key);
                }
            }
        }
        const entry = spaces.get(spaceId);
        spaces.delete(spaceId);
        dropping.add(spaceId);
        // Lost access wins over the outbox.
        refuse(pageIds);
        // A page of it, or its library, kept as the last screen: the next start opens on the Spaces.
        const last = viewState.get(LAST_SCREEN_KEY);
        if (keptPage(last)?.spaceId === spaceId || keptSpace(last) === spaceId) {
            viewState.set(LAST_SCREEN_KEY, 'Spaces');
        }
        await entry?.dispose().catch(onError);
        await items.dropSpace(spaceId);
        // Summaries, bodies, dataset views' results, its radar and memory in one transaction.
        try {
            await bodies.dropPrefix(prefix, (bodyStatements) =>
                views.dropPrefix(prefix, (viewStatements) =>
                    sections.dropPrefix(prefix, (sectionStatements) =>
                        cache.dropScope(PAGES_SNAPSHOT, spaceId, async (tx) => {
                            await bodyStatements(tx);
                            await viewStatements(tx);
                            await sectionStatements(tx);
                        }),
                    ),
                ),
            );
        } finally {
            dropping.delete(spaceId);
        }
    }

    /** Every Space the phone holds pages or bodies of. */
    async function heldSpaces(): Promise<Set<string>> {
        const held = new Set<string>();
        const rows = await db.all<{ scope: string }>('SELECT DISTINCT scope FROM rows WHERE collection = ?', [PAGES]);
        for (const { scope } of rows) {
            held.add(scope);
        }
        const scopes = await db.all<{ scope: string }>('SELECT scope FROM scopes WHERE scope LIKE ?', [
            `${PAGE_BODIES_KIND}:${PAGE_BODIES.format}:%`,
        ]);
        const prefix = `${PAGE_BODIES_KIND}:${PAGE_BODIES.format}:`.length;
        for (const { scope } of scopes) {
            const key = scope.slice(prefix);
            know(key);
            const parts = parsePageBodyKey(key);
            if (parts !== null) {
                held.add(parts.spaceId);
            }
        }
        // A Space's radar or memory kept with no page of it held.
        const sectionScopes = await db.all<{ scope: string }>('SELECT scope FROM scopes WHERE scope LIKE ?', [
            `${SPACE_SECTIONS_KIND}:%`,
        ]);
        for (const { scope } of sectionScopes) {
            const parts = parseSpaceSectionKey(scope.slice(scope.indexOf(':', SPACE_SECTIONS_KIND.length + 1) + 1));
            if (parts !== null) {
                held.add(parts.spaceId);
            }
        }
        return held;
    }

    // As it opens: the bodies on disk, by page; and the Spaces a kill left after they went.
    const opening = heldSpaces()
        .then(async (held) => {
            if (closed || cache.meta(WORKSPACE_SNAPSHOT) === null) {
                return;
            }
            const listed = cache.rows(SPACES);
            for (const spaceId of held) {
                if (!listed.has(spaceId)) {
                    await dropSpace(spaceId);
                }
            }
        })
        .catch(onError);

    const unfollow = cache.subscribe((change) => {
        for (const row of change.removes) {
            if (row.collection === SPACES && row.scope === '') {
                dropSpace(row.key).catch(onError);
            }
        }
        if (change.confirmed) {
            return;
        }
        for (const row of change.upserts) {
            if (row.collection !== PAGES || row.scope === '') {
                continue;
            }
            // A held body the poll says is older: read it again (a body on disk alone waits for its open).
            const shown = bodies.peek(pageBodyKey(row.scope, row.key))?.state.value;
            if (shown != null && typeof row.version === 'number' && row.version > shown.revision) {
                void bodies.refreshKnown(pageBodyKey(row.scope, row.key));
            }
        }
        for (const row of change.removes) {
            if (row.collection === PAGES && row.scope !== '' && !dropping.has(row.scope)) {
                // Moved or deleted: a body the phone holds says which (404, then the location; 410).
                void bodies.refreshKnown(pageBodyKey(row.scope, row.key));
            }
        }
    });

    return {
        space,
        summary: summaryOf,
        bodies,
        views,
        sections,
        items,
        body: (spaceId, pageId) => bodies.item(pageBodyKey(spaceId, pageId)),
        async preload(spaceId, pageId) {
            const [item] = await Promise.all([bodies.preload(pageBodyKey(spaceId, pageId)), space(spaceId).loaded]);
            return item;
        },
        async open(spaceId, pageId) {
            const list = await space(spaceId).pull();
            if (list.outcome === 'failed' || closed) {
                return { list: list.outcome, read: false };
            }
            const item = bodies.item(pageBodyKey(spaceId, pageId));
            await item.loaded;
            const { value, refreshing } = item.state;
            const summary = summaryOf(spaceId, pageId);
            const stale = value === null || summary === null || summary.revision > value.revision;
            if (!stale || refreshing) {
                return { list: list.outcome, read: refreshing };
            }
            await item.refresh();
            return { list: list.outcome, read: true };
        },
        onMoved(listener) {
            moves.add(listener);
            return () => void moves.delete(listener);
        },
        noteMoved(move) {
            if (!closed) {
                moved(move);
            }
        },
        dropSpace,
        async flush() {
            await opening;
            await Promise.all([bodies.flush(), views.flush(), sections.flush()]);
        },
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            unfollow();
            moves.clear();
            const entries = [...spaces.values()];
            spaces.clear();
            await Promise.allSettled(entries.map((entry) => entry.dispose()));
            await opening;
            await Promise.all([bodies.close(), views.close(), sections.close(), items.close()]);
        },
    };
}
