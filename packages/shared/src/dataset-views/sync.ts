/**
 * What an offline cache does with a `changes` answer and an index
 * (CB-451). The steps that need the network (reading pages,
 * indexes and lookups) are the client's; these are the decisions, so
 * the web and Socio Mobile make them the same way.
 */
import type { IndexEntry, RowChanges } from './contract.js';
import { VIEW_READ_LIMITS } from './contract.js';
import { stampsEqual } from './schema.js';

/** About what one index entry costs on the wire: a key and a stamp. */
export const INDEX_ENTRY_BYTES = 40;

/**
 * What a `changes` answer asks of the cache:
 *
 * - `apply`: remove the deleted keys, replace the changed rows, re-apply
 *   the view's filter and sort to them (`matchesFilter`, `compareRows`),
 *   and mark a span that lost rows short; then follow `next`.
 * - `reconcile`: another generation, or `since` below the floor. Reconcile
 *   each cached span by its index (`planReconcile`), unless refetching it
 *   costs less (`reconcileOrRefetch`).
 * - `resync`: the table has no stamps. Read the view again; offline, show
 *   the old copy labeled with its time.
 */
export function changesAction(changes: Pick<RowChanges, 'reconcile' | 'resync'>): 'apply' | 'reconcile' | 'resync' {
    if (changes.resync) {
        return 'resync';
    }
    return changes.reconcile ? 'reconcile' : 'apply';
}

/**
 * Whether to reconcile a cached span by its index or read its pages
 * again: a refetch only when nothing is cached, or when the cache holds
 * fewer bytes per row than an index entry costs.
 */
export function reconcileOrRefetch(span: { rows: number; bytes: number }): 'reconcile' | 'refetch' {
    if (span.rows <= 0) {
        return 'refetch';
    }
    return span.bytes / span.rows < INDEX_ENTRY_BYTES ? 'refetch' : 'reconcile';
}

/** What to do with a cached span, given its index. */
export interface ReconcilePlan {
    /** The span's keys in the index's order: the order to rebuild it in. */
    order: string[];
    /** Cached rows whose stamp is the index's: kept without a fetch (equal stamps mean identical rows). */
    keep: string[];
    /** Keys to fetch by `POST …/rows/lookup`: a stamp that differs, or a row not cached. */
    fetch: string[];
    /** Cached keys the index no longer lists: gone, or no longer in the span. */
    drop: string[];
}

/** Steps 2 to 4 of a reconcile, from the cached rows' stamps and the span's index. */
export function planReconcile(
    cached: ReadonlyArray<{ key: string; stamp: string | null }>,
    index: readonly IndexEntry[],
): ReconcilePlan {
    const held = new Map(cached.map((row) => [row.key, row.stamp]));
    const listed = new Set<string>();
    const keep: string[] = [];
    const fetch: string[] = [];
    for (const entry of index) {
        if (listed.has(entry.key)) {
            continue; // A multi-value row listed once per group.
        }
        listed.add(entry.key);
        (held.has(entry.key) && stampsEqual(held.get(entry.key), entry.stamp) ? keep : fetch).push(entry.key);
    }
    return {
        order: index.map((entry) => entry.key),
        keep,
        fetch,
        drop: [...held.keys()].filter((key) => !listed.has(key)),
    };
}

/** Keys in lookup-sized batches (`VIEW_READ_LIMITS.lookupKeys` each). */
export function lookupBatches(keys: readonly string[]): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < keys.length; i += VIEW_READ_LIMITS.lookupKeys) {
        out.push(keys.slice(i, i + VIEW_READ_LIMITS.lookupKeys));
    }
    return out;
}
