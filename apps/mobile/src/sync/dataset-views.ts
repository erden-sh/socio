import { VIEW_NO_ACCESS_CODE, type ViewQueryResult, type ViewSpec } from '@socio/shared/dataset-view';

import type { SqlConnection, SqlStatements } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { type BoundedItem, createBoundedStore } from './bounded-kind';
import { httpError, HttpError } from './errors';
import { pageBodyKey } from './pages';

// A page's dataset views' last results, the pages store's `views`. A
// `dataset-view` fence is a query each viewer runs through their own access
// (`POST /api/data/views/query`), so its
// data is never in the page: the phone keeps the last result it was given, to
// show offline with its time.
// - Keyed by the page (its Space and id, as its body is) and a hash of the
//   fence's spec (the dataset, the query and its parameters: the web's key),
//   one bounded kind (bounded-kind.ts) whose every key is local, so nothing
//   reads the network by itself: `load` asks, once per open, and `put`s the
//   answer. There is no refresh timer, whatever the spec's `refresh` says.
// - A denied answer (`VIEW_NO_ACCESS_CODE`) deletes the copy; a result over
//   4 MB never reaches disk (the bounded kind's item limit).
// - A Space the person lost drops its pages' results with its bodies
//   (`dropPrefix` with the page store's transaction).
// No React Native: tests/sync runs it under Node.

export const DATASET_VIEWS_KIND = 'dataset-view';
/** Results kept on disk at most. */
export const DATASET_VIEWS_KEPT = 200;
/** About how many characters of results are kept on disk at most (a result is at most 256 KB: the server's cap). */
export const DATASET_VIEWS_CHARS = 10_000_000;

export const VIEW_QUERY_PATH = '/api/data/views/query';

/** A dataset view's last result, as kept. */
export type DatasetViewResult = ViewQueryResult;

/** What asking for a view's result did. */
export type DatasetViewLoad =
    | { readonly outcome: 'fresh' }
    | { readonly outcome: 'denied'; readonly message: string }
    | { readonly outcome: 'failed'; readonly error: unknown };

/** cyrb53: a 53-bit hash, as 14 hex digits (fixed width, so one key is never another's prefix). */
function hash53(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return value.toString(16).padStart(14, '0');
}

/** The spec's part that decides its data: the dataset, the query and its parameters (the web's key). */
export const viewSpecHash = (spec: Pick<ViewSpec, 'datasetId' | 'query' | 'params'>) =>
    hash53(JSON.stringify([spec.datasetId, spec.query, spec.params ?? []]));

/** A view's key: its page's body key, then the spec's hash. */
export const datasetViewKey = (
    spaceId: string,
    pageId: string,
    spec: Pick<ViewSpec, 'datasetId' | 'query' | 'params'>,
) => `${pageBodyKey(spaceId, pageId)}/${viewSpecHash(spec)}`;

function checkResult(body: unknown): DatasetViewResult | null {
    const result = body as Partial<ViewQueryResult> | null;
    return result !== null &&
        typeof result === 'object' &&
        Array.isArray(result.columns) &&
        Array.isArray(result.rows) &&
        typeof result.at === 'number'
        ? (result as DatasetViewResult)
        : null;
}

export interface DatasetViews {
    /** A view's last result, from disk; hold it with `use()` in the same turn. Never reads the network. */
    item(spaceId: string, pageId: string, spec: ViewSpec): BoundedItem<DatasetViewResult>;
    /** The same, by its `datasetViewKey`, so a screen can follow a key rather than a spec object. */
    itemAt(key: string): BoundedItem<DatasetViewResult>;
    /** Runs the view's query now: the answer is kept, a denial deletes the copy. */
    load(spaceId: string, pageId: string, spec: ViewSpec): Promise<DatasetViewLoad>;
    /** Drops every result whose key starts with `prefix` (a Space's), in `within`'s transaction when given. */
    dropPrefix(
        prefix: string,
        within?: (statements: (tx: SqlStatements) => Promise<void>) => Promise<void>,
    ): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface DatasetViewsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

export function createDatasetViews(options: DatasetViewsOptions): DatasetViews {
    const { fetch, signal } = options;
    const store = createBoundedStore<DatasetViewResult>({
        definition: {
            name: DATASET_VIEWS_KIND,
            format: 1,
            bounds: { items: DATASET_VIEWS_KEPT, chars: DATASET_VIEWS_CHARS },
            path: () => VIEW_QUERY_PATH,
            parse: (path, body) => {
                const result = checkResult(body);
                if (result === null) {
                    throw new TypeError(`${path} answered with no view result.`);
                }
                return result;
            },
            version: (result) => result.at,
        },
        db: options.db,
        fetch,
        signal,
        // Every key is local: the bounded kind never reads one; `load` asks and puts.
        isLocal: () => true,
        onError: options.onError,
        now: options.now,
    });

    return {
        item: (spaceId, pageId, spec) => store.item(datasetViewKey(spaceId, pageId, spec)),
        itemAt: (key) => store.item(key),
        async load(spaceId, pageId, spec) {
            const key = datasetViewKey(spaceId, pageId, spec);
            try {
                const response = await fetch(VIEW_QUERY_PATH, {
                    method: 'POST',
                    json: {
                        spaceId,
                        pageId,
                        datasetId: spec.datasetId,
                        query: spec.query,
                        ...(spec.params?.length ? { params: spec.params } : {}),
                    },
                });
                if (!response.ok) {
                    throw await httpError(response, signal);
                }
                const result = checkResult(await readJson(response, signal));
                if (result === null) {
                    return {
                        outcome: 'failed',
                        error: new TypeError(`${VIEW_QUERY_PATH} answered with no view result.`),
                    };
                }
                await store.put(key, result);
                return { outcome: 'fresh' };
            } catch (error) {
                if (error instanceof HttpError && error.code === VIEW_NO_ACCESS_CODE) {
                    // The key is fixed-width, so it is no other key's prefix.
                    await store.dropPrefix(key);
                    return { outcome: 'denied', message: error.message };
                }
                return { outcome: 'failed', error };
            }
        },
        dropPrefix: (prefix, within) => store.dropPrefix(prefix, within),
        flush: () => store.flush(),
        close: () => store.close(),
    };
}

/** Asks for a view's result: the same view again gets the first answer. */
export type ViewAsk = (spaceId: string, pageId: string, spec: ViewSpec) => Promise<DatasetViewLoad>;

/**
 * One screen's asks (a dataset view block holds one while mounted): each view
 * is asked once, by its key, so a re-render, a new spec object or an item the
 * store replaced never asks again. A denial drops the kept copy, which makes
 * the next `item()` a new one; keyed on the item, the screen would ask over and
 * over. A remount (the page opened again) asks again.
 */
export function createViewAsk(views: Pick<DatasetViews, 'load'>): ViewAsk {
    const asked = new Map<string, Promise<DatasetViewLoad>>();
    return (spaceId, pageId, spec) => {
        const key = datasetViewKey(spaceId, pageId, spec);
        let answer = asked.get(key);
        if (answer === undefined) {
            answer = views.load(spaceId, pageId, spec);
            asked.set(key, answer);
        }
        return answer;
    };
}
