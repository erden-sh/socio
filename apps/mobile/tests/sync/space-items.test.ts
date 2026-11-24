import { afterEach, describe, expect, it } from 'vitest';

import { SPACE_PLACE_REFUSED } from '@socio/shared/spaces/space-items';

import type { AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { createPagesStore, type PagesStore } from '../../src/sync/page-store';
import {
    itemChanged,
    placeBody,
    placeDataset,
    PRIVATE_ITEMS,
    SPACE_ITEMS,
    SPACE_ITEMS_SNAPSHOT,
} from '../../src/sync/space-items';

import { syncSetup } from './helpers';

// Datasets in Spaces (CB-469), against a real cache.db: a Space's items and the
// Private group pulled with their ETags (a 304 changes nothing), kept whole on
// each 200 so a change lands whatever its version's hash (#663: equality, not
// order), an unknown kind kept, read back offline by a new store, dropped with
// the Space, and a placement's PATCH and its refusals in the server's words.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const json = (body: unknown, status = 200, etag?: string) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...(etag === undefined ? {} : { etag }) },
    });

const page = { kind: 'page', id: 'p1', parentId: null, title: 'Project X', position: '000000000000001.p1', version: 3 };
const dataset = {
    kind: 'dataset',
    id: 'ds1',
    parentId: 'p1',
    title: 'Tasks',
    position: '000000000000002.ds1',
    version: 10,
    owner: 'person',
    tables: [{ name: 'tasks', title: 'Tasks', rows: 12, analytical: false }],
};

async function setup() {
    const s = await syncSetup();
    open.push(s);
    const asked: Array<{ path: string; init?: AuthedRequestInit }> = [];
    let items: unknown[] = [page, dataset];
    let mine: unknown[] = [];
    let tag = 'W/"a"';
    const stores: PagesStore[] = [];
    const makeStore = () => {
        const store = createPagesStore({
            scopeId: `test-${stores.length}`,
            db: s.db,
            fetch: async (input, init) => {
                if (/^\/api\/spaces\/[^/]+\/items$/.test(input) || input === '/api/data/private-items') {
                    asked.push({ path: input, ...(init === undefined ? {} : { init }) });
                    const sent = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
                    if (sent === tag) {
                        return new Response(null, { status: 304, headers: { etag: tag } });
                    }
                    return input.startsWith('/api/spaces/')
                        ? json({ schema: 1, spaceId: 'everyday', items }, 200, tag)
                        : json({ schema: 1, scope: 'private', items: mine }, 200, tag);
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
    return Object.assign(s, {
        makeStore,
        asked,
        set: (next: { items?: unknown[]; mine?: unknown[]; tag?: string }) => {
            items = next.items ?? items;
            mine = next.mine ?? mine;
            tag = next.tag ?? tag;
        },
    });
}

const ids = (store: PagesStore, spaceId: string) => [...store.items.space(spaceId).collection.keys()].sort();

describe('a Space’s items (CB-469)', () => {
    it('pulls pages and datasets by id, sends the ETag back, and a 304 changes nothing', async () => {
        const s = await setup();
        const store = s.makeStore();
        const space = store.items.space('everyday');
        expect((await space.pull()).outcome).toBe('fresh');
        expect(ids(store, 'everyday')).toEqual(['ds1', 'p1']);
        expect(s.asked[0]?.path).toBe('/api/spaces/everyday/items');
        await space.pull();
        expect(s.asked[1]?.init?.headers).toEqual({ 'if-none-match': 'W/"a"' });
        expect(store.items.dataset('ds1', 'everyday')).toMatchObject({ title: 'Tasks', parentId: 'p1' });
        expect(store.items.dataset('p1', 'everyday')).toBeNull();
    });

    it('takes a rename whose new version is lower: versions are hashes, compared for equality only (#663)', async () => {
        const s = await setup();
        const store = s.makeStore();
        await store.items.space('everyday').pull();
        s.set({ items: [page, { ...dataset, title: 'Open tasks', parentId: null, version: 3 }], tag: 'W/"b"' });
        await store.items.space('everyday').pull();
        const renamed = store.items.dataset('ds1', 'everyday');
        expect(renamed).toMatchObject({ title: 'Open tasks', parentId: null, version: 3 });
        expect(itemChanged({ version: 10 }, renamed!)).toBe(true);
        expect(itemChanged(renamed, { version: 3 })).toBe(false);
        expect(itemChanged(null, { version: 3 })).toBe(true);
    });

    it('keeps an item of a kind it doesn’t know, and refuses a body that isn’t the list', async () => {
        const s = await setup();
        const store = s.makeStore();
        s.set({
            items: [page, { kind: 'dashboard', id: 'db1', parentId: null, title: 'KPIs', position: 'z', version: 1 }],
        });
        await store.items.space('everyday').pull();
        expect(ids(store, 'everyday')).toEqual(['db1', 'p1']);
        s.set({ items: [{ id: 'x' }], tag: 'W/"c"' });
        const pull = await store.items.space('everyday').pull();
        expect(pull.outcome).toBe('failed');
        expect(ids(store, 'everyday')).toEqual(['db1', 'p1']);
    });

    it('shows the last list offline in a new store, and drops it with the Space', async () => {
        const s = await setup();
        const first = s.makeStore();
        await first.items.space('everyday').pull();
        await s.cache.flush();
        const second = s.makeStore();
        await second.items.space('everyday').loaded;
        expect(ids(second, 'everyday')).toEqual(['ds1', 'p1']);
        await second.items.dropSpace('everyday');
        await s.cache.flush();
        const rows = await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ? AND scope = ?', [
            SPACE_ITEMS,
            'everyday',
        ]);
        expect(rows).toEqual([]);
        expect(SPACE_ITEMS_SNAPSHOT.scopedPath?.('a b')).toBe('/api/spaces/a%20b/items');
    });

    it('pulls the Private group from its own route', async () => {
        const s = await setup();
        const store = s.makeStore();
        s.set({ mine: [{ ...dataset, id: 'ds2', parentId: null, socio: { id: 's1', name: 'Scout' } }] });
        await store.items.private().pull();
        expect([...store.items.private().collection.keys()]).toEqual(['ds2']);
        expect(store.items.dataset('ds2', null)).toMatchObject({ socio: { name: 'Scout' } });
        expect(s.asked.map((a) => a.path)).toEqual(['/api/data/private-items']);
        expect(s.cache.rows(PRIVATE_ITEMS).has('ds2')).toBe(true);
    });
});

describe('placing a dataset (CB-469, editors only)', () => {
    it('sends the Space and the parent, and only the Space’s null to take it out', () => {
        expect(placeBody({ spaceId: 'sp', parentId: 'p1' })).toEqual({ sharedSpaceId: 'sp', spaceParentId: 'p1' });
        expect(placeBody({ spaceId: 'sp', parentId: null })).toEqual({ sharedSpaceId: 'sp', spaceParentId: null });
        expect(placeBody({ spaceId: null, parentId: 'p1' })).toEqual({ sharedSpaceId: null });
    });

    it('PATCHes the dataset and words each refusal', async () => {
        const sent: Array<{ input: string; init?: AuthedRequestInit }> = [];
        let answer: () => Response | Promise<Response> = () => json({ id: 'ds1' });
        const fetch = async (input: string, init?: AuthedRequestInit) => {
            sent.push({ input, ...(init === undefined ? {} : { init }) });
            return answer();
        };
        const place = { spaceId: 'sp', parentId: 'p1' };
        expect(await placeDataset({ fetch, datasetId: 'ds 1', place })).toEqual({ outcome: 'placed' });
        expect(sent[0]).toEqual({
            input: '/api/data/datasets/ds%201',
            init: { method: 'PATCH', json: { sharedSpaceId: 'sp', spaceParentId: 'p1' } },
        });
        answer = () => json({ error: SPACE_PLACE_REFUSED }, 403);
        expect(await placeDataset({ fetch, datasetId: 'ds1', place })).toEqual({
            outcome: 'refused',
            status: 403,
            message: SPACE_PLACE_REFUSED,
        });
        answer = () => json({ error: 'That page isn’t in this Space.' }, 404);
        expect(await placeDataset({ fetch, datasetId: 'ds1', place })).toMatchObject({
            status: 404,
            message: 'That page isn’t in this Space.',
        });
        answer = () => {
            throw new NetworkError('offline');
        };
        expect(await placeDataset({ fetch, datasetId: 'ds1', place })).toMatchObject({
            outcome: 'refused',
            status: null,
        });
    });
});
