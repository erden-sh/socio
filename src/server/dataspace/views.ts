import { DataError } from '@socio/foundation/dataspace/data-error';
import type { ViewQueryBody, ViewQueryResult } from '@socio/shared/dataset-view';

import type { DataSpace } from './space.js';

export interface ViewOptions {
    /** How long a result is reused for the same dataset version and query. */
    cacheTtlMs?: number;
    /** Queries a minute per viewer that actually run (cache hits are free). */
    perMinute?: number;
    maxEntries?: number;
    maxBytes?: number;
}

interface Entry {
    at: number;
    bytes: number;
    result: Omit<ViewQueryResult, 'cached' | 'at' | 'dataset'>;
}

/**
 * Embedded dataset views: the query a page block shows, run for the person
 * looking at the page, through their own access. A viewer sees a view's
 * data only when they own the dataset or its owner shared it with the
 * page's Space; anyone else gets `VIEW_NO_ACCESS`. The query is the data
 * space's read-only `data.query` for that viewer (SELECT only, row, byte
 * and time caps). Results are kept briefly, per dataset version, so a page
 * many people have open (or one refreshing on a timer) runs it once.
 */
export class DatasetViews {
    private cache = new Map<string, Entry>();
    private running = new Map<string, Promise<Entry>>();
    private rate = new Map<string, number[]>();
    private bytes = 0;
    private ttl: number;
    private perMinute: number;
    private maxEntries: number;
    private maxBytes: number;
    private readsSpace: (viewer: string, spaceId: string) => boolean;
    constructor(
        private data: DataSpace,
        private pages: { get(spaceId: string, id: string): unknown },
        options: ViewOptions & {
            /**
             * Whether the viewer may read the page's Space (CB-181): one they
             * may not is a missing page, as one that isn't there.
             */
            readsSpace?: (viewer: string, spaceId: string) => boolean;
        } = {},
    ) {
        this.readsSpace = options.readsSpace ?? (() => true);
        this.ttl = options.cacheTtlMs ?? 15_000;
        this.perMinute = options.perMinute ?? 60;
        this.maxEntries = options.maxEntries ?? 200;
        this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    }

    async query(viewer: string, body: ViewQueryBody): Promise<ViewQueryResult> {
        // The page must exist in a Space the viewer may read: the Space
        // decides who may see.
        try {
            if (!this.readsSpace(viewer, body.spaceId)) {
                throw new Error('hidden');
            }
            this.pages.get(body.spaceId, body.pageId);
        } catch {
            throw new DataError('Page not found.', 404);
        }
        const dataset = this.data.viewable(viewer, body.datasetId, body.spaceId);
        const params = body.params ?? [];
        const key = JSON.stringify([dataset.id, dataset.updatedAt, body.query, params]);
        const now = Date.now();
        const hit = this.cache.get(key);
        const view = (entry: Entry, cached: boolean): ViewQueryResult => ({
            ...entry.result,
            dataset: {
                id: dataset.id,
                name: dataset.name,
                owned: dataset.owned,
                sharedHere: dataset.sharedHere,
            },
            cached,
            at: entry.at,
        });
        if (hit && !body.fresh && now - hit.at < this.ttl) {
            return view(hit, true);
        }
        const pending = this.running.get(key);
        if (pending) {
            return view(await pending, true);
        }
        this.limit(viewer, now);
        const run = this.data
            .query({ kind: 'user', userId: viewer }, dataset.id, body.query, params)
            .then(({ dataset: _name, ...result }): Entry => {
                const entry: Entry = {
                    at: Date.now(),
                    bytes: JSON.stringify(result.rows).length,
                    result: { ...result, maxRows: this.data.limits.queryMaxRows },
                };
                this.store(key, entry);
                return entry;
            })
            .finally(() => this.running.delete(key));
        this.running.set(key, run);
        return view(await run, false);
    }

    private limit(viewer: string, now: number) {
        const recent = (this.rate.get(viewer) ?? []).filter((at) => at > now - 60_000);
        if (recent.length >= this.perMinute) {
            this.rate.set(viewer, recent);
            throw new DataError(
                `Too many view queries: at most ${this.perMinute} a minute. Wait a minute, or refresh less often.`,
                429,
            );
        }
        recent.push(now);
        this.rate.set(viewer, recent);
    }

    private store(key: string, entry: Entry) {
        const old = this.cache.get(key);
        if (old) {
            this.bytes -= old.bytes;
            this.cache.delete(key);
        }
        if (entry.bytes > this.maxBytes) {
            return;
        }
        this.cache.set(key, entry);
        this.bytes += entry.bytes;
        const cutoff = Date.now() - this.ttl;
        for (const [k, e] of this.cache) {
            if (this.cache.size <= this.maxEntries && this.bytes <= this.maxBytes && e.at >= cutoff) {
                break;
            }
            // Oldest first (insertion order): expired, or over the caps.
            this.cache.delete(k);
            this.bytes -= e.bytes;
        }
    }
}
