import { afterEach, describe, expect, it, vi } from 'vitest';

import { VIEW_NO_ACCESS, VIEW_NO_ACCESS_CODE, type ViewSpec } from '@socio/shared/dataset-view';

import type { AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { BOUNDED_ITEM_MAX_CHARS } from '../../src/sync/bounded-kind';
import {
    createViewAsk,
    DATASET_VIEWS_KIND,
    datasetViewKey,
    VIEW_QUERY_PATH,
    viewSpecHash,
} from '../../src/sync/dataset-views';
import { createPagesStore, type PagesStore } from '../../src/sync/page-store';
import { ORIGIN } from '../net/helpers';

import { syncSetup } from './helpers';

// A page's dataset views' last results, against a real cache.db: keyed by the page and a hash of the spec,
// asked only by `load` (no timer, nothing read by itself), kept for offline,
// deleted on a denied answer, never over 4 MB on disk, and dropped with a
// Space the person lost, in the same transaction as its bodies.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const SPEC: ViewSpec = { datasetId: 'sales', query: 'SELECT month, total FROM sales', display: 'bar' };

const result = (rows: unknown[][], at = 1_700_000_000_000, extra = '') => ({
    columns: ['month', 'total'],
    rows,
    truncated: false,
    ms: 3,
    maxRows: 1000,
    dataset: { id: 'sales', name: `Sales${extra}`, owned: true, sharedHere: true },
    cached: false,
    at,
});

async function setup() {
    const s = await syncSetup();
    open.push(s);
    const queries: { path: string; init?: AuthedRequestInit }[] = [];
    let answer: () => Response = () =>
        new Response(JSON.stringify(result([['Jan', 3]])), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    const stores: PagesStore[] = [];
    const makeStore = () => {
        const store = createPagesStore({
            scopeId: `test-${stores.length}`,
            db: s.db,
            fetch: async (input, init) => {
                if (input === VIEW_QUERY_PATH) {
                    queries.push({ path: input, init });
                    return answer();
                }
                return s.authed(input, init);
            },
            signal: s.scope.signal,
            cache: s.cache,
            scheduler: () => null,
            viewState: { get: () => null, set: () => {} },
            outbox: () => null,
        });
        stores.push(store);
        return store;
    };
    const close = s.close.bind(s);
    s.close = async (options) => {
        for (const store of stores) {
            await store.close();
        }
        await close(options);
    };
    await s.workspace.pull('', null);
    const onDisk = async () =>
        (await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ?', [DATASET_VIEWS_KIND])).map(
            (row) => row.key,
        );
    return Object.assign(s, {
        makeStore,
        queries,
        onDisk,
        answer: (next: () => Response) => {
            answer = next;
        },
    });
}

describe('dataset views’ results', () => {
    it('keys a view by its page and its spec’s data, as the web does', () => {
        expect(viewSpecHash(SPEC)).toMatch(/^[0-9a-f]{14}$/);
        // Display, axes, title and refresh don't change the data.
        expect(viewSpecHash({ ...SPEC, params: [] })).toBe(viewSpecHash(SPEC));
        expect(viewSpecHash({ ...SPEC, query: 'SELECT 1' })).not.toBe(viewSpecHash(SPEC));
        expect(viewSpecHash({ ...SPEC, params: [1] })).not.toBe(viewSpecHash(SPEC));
        expect(datasetViewKey('everyday', 'p1', SPEC)).toBe(`everyday/p1/${viewSpecHash(SPEC)}`);
    });

    it('asks only when loaded, keeps the answer on disk, and reads it back offline in a new store', async () => {
        const s = await setup();
        const pages = s.makeStore();
        const item = pages.views.item('everyday', 'p1', SPEC);
        const release = item.use();
        await item.loaded;
        // Holding it reads nothing.
        expect(s.queries).toEqual([]);
        expect(item.state.value).toBeNull();

        expect(await pages.views.load('everyday', 'p1', SPEC)).toEqual({ outcome: 'fresh' });
        expect(s.queries).toHaveLength(1);
        expect(s.queries[0]?.init).toMatchObject({
            method: 'POST',
            json: { spaceId: 'everyday', pageId: 'p1', datasetId: 'sales', query: SPEC.query },
        });
        expect(item.state.value?.rows).toEqual([['Jan', 3]]);
        release();
        await pages.flush();
        expect(await s.onDisk()).toEqual([datasetViewKey('everyday', 'p1', SPEC)]);

        // Offline, another store (a cold start) has the last result and says it failed to load.
        s.answer(() => {
            throw new NetworkError(`${ORIGIN}${VIEW_QUERY_PATH}`);
        });
        const later = s.makeStore();
        const kept = later.views.item('everyday', 'p1', SPEC);
        kept.use();
        await kept.loaded;
        expect(kept.state.value?.at).toBe(1_700_000_000_000);
        expect((await later.views.load('everyday', 'p1', SPEC)).outcome).toBe('failed');
        expect(kept.state.value?.rows).toEqual([['Jan', 3]]);
    });

    it('deletes the kept result when the person is denied, and words it with the server’s message', async () => {
        const s = await setup();
        const pages = s.makeStore();
        await pages.views.load('everyday', 'p1', SPEC);
        await pages.flush();
        expect(await s.onDisk()).toHaveLength(1);

        s.answer(
            () =>
                new Response(JSON.stringify({ error: VIEW_NO_ACCESS, code: VIEW_NO_ACCESS_CODE }), {
                    status: 403,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        expect(await pages.views.load('everyday', 'p1', SPEC)).toEqual({ outcome: 'denied', message: VIEW_NO_ACCESS });
        await pages.flush();
        expect(await s.onDisk()).toEqual([]);
        expect(pages.views.item('everyday', 'p1', SPEC).state.value).toBeNull();
    });

    it('asks a denied view once per open, though the denial replaces its item', async () => {
        const s = await setup();
        const pages = s.makeStore();
        s.answer(
            () =>
                new Response(JSON.stringify({ error: VIEW_NO_ACCESS, code: VIEW_NO_ACCESS_CODE }), {
                    status: 403,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const key = datasetViewKey('everyday', 'p1', SPEC);
        const first = pages.views.itemAt(key);
        const ask = createViewAsk(pages.views);
        // What DatasetViewBlock's renders and effect runs do, a few times over,
        // each with a new spec object as a re-parsed body would give.
        const answers = [];
        for (let run = 0; run < 4; run++) {
            answers.push(await ask('everyday', 'p1', { ...SPEC }));
            await pages.flush();
        }
        // The denial dropped the item: an effect keyed on it would run again.
        expect(pages.views.itemAt(key)).not.toBe(first);
        expect(s.queries).toHaveLength(1);
        expect(answers.every((answer) => answer.outcome === 'denied' && answer.message === VIEW_NO_ACCESS)).toBe(true);
        // A page opened again (a new mount) asks again, once.
        const again = createViewAsk(pages.views);
        await again('everyday', 'p1', SPEC);
        await again('everyday', 'p1', SPEC);
        expect(s.queries).toHaveLength(2);
    });

    it('never keeps a result over 4 MB on disk, and drops its older copy', async () => {
        const s = await setup();
        const pages = s.makeStore();
        await pages.views.load('everyday', 'p1', SPEC);
        await pages.flush();
        expect(await s.onDisk()).toHaveLength(1);
        const big = 'x'.repeat(BOUNDED_ITEM_MAX_CHARS);
        s.answer(
            () =>
                new Response(JSON.stringify(result([['Jan', big]])), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        expect((await pages.views.load('everyday', 'p1', SPEC)).outcome).toBe('fresh');
        await pages.flush();
        expect(await s.onDisk()).toEqual([]);
    });

    it('drops a lost Space’s results with its summaries and bodies', async () => {
        const s = await setup();
        const pages = s.makeStore();
        await pages.open('everyday', 'p1');
        await pages.views.load('everyday', 'p1', SPEC);
        await s.cache.flush();
        await pages.flush();
        expect(await s.onDisk()).toHaveLength(1);

        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        await s.workspace.pull('', s.workspace.cursor());
        await vi.waitFor(async () => expect(await s.onDisk()).toEqual([]));
        expect(
            await s.db.all('SELECT key FROM rows WHERE collection IN (?, ?)', ['page-body', DATASET_VIEWS_KIND]),
        ).toEqual([]);
    });
});
