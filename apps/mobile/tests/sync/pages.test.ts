import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';

import type { Store } from '../../src/data';
import { NetworkError } from '../../src/net/errors';
import {
    keptPage,
    keptSpace,
    LAST_SCREEN_KEY,
    pageScreen,
    preloadKeptPage,
    preloadKeptSpace,
    spaceScreen,
} from '../../src/shell/last-screen';
import { type OutboxKind, type SendOutcome, UNSENT_GONE } from '../../src/sync/outbox';
import { createPagesStore, type PageMove, type PagesStore } from '../../src/sync/page-store';
import {
    PAGE_BODIES_KEPT,
    PAGE_BODIES_KIND,
    pageBodyKey,
    pageLanes,
    pageOfLane,
    PAGES,
    PAGES_SNAPSHOT,
    parsePageBodyKey,
} from '../../src/sync/pages';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { SHELL_SNAPSHOTS } from '../../src/sync/shell';
import { openSnapshotCache } from '../../src/sync/snapshot-cache';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer, page, syncSetup } from './helpers';
import { turns } from './outbox-fakes';
import { signedIn, wire } from './wire';

// A workspace's pages, against the fake
// server and a real cache.db: each Space's summaries with their ETag (304s), a
// body read on open only when missing or older than its summary, a move that
// re-keys the body and the last screen, a gone page's writes to Unsent, a removed
// Space dropped whole, the disk bounds, and cold starts onto a page, with and
// without its body.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

/** A view state in memory. */
function memoryViewState(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get: (key: string) => values.get(key) ?? null,
        set: (key: string, value: string) => values.set(key, value),
    };
}

interface StoreOptions {
    lanes?: string[];
    kept?: string[];
    offline?: { on: boolean };
    viewState?: ReturnType<typeof memoryViewState>;
}

async function setup(options: { directory?: string } = {}) {
    const s = await syncSetup(options);
    open.push(s);
    const refused: string[][] = [];
    const errors: unknown[] = [];
    const stores: PagesStore[] = [];
    const makeStore = (cache = s.cache, { lanes = [], kept = [], offline, viewState }: StoreOptions = {}) => {
        const store = createPagesStore({
            scopeId: `test-${stores.length}`,
            db: s.db,
            fetch: (input, init) =>
                offline?.on ? Promise.reject(new NetworkError(`${ORIGIN}${input}`)) : s.authed(input, init),
            signal: s.scope.signal,
            cache,
            scheduler: () => null,
            viewState: viewState ?? memoryViewState(),
            outbox: () => ({
                rows: () => lanes.map((lane, index) => ({ lane, id: `r${index}` }) as never),
                unsent: () => [],
                refuseLanes: async (gone) => {
                    refused.push([...gone]);
                    return [];
                },
                status: () => ({ readOnly: false }) as never,
            }),
            keptSpaces: () => kept,
            onError: (error) => errors.push(error),
            now: s.clock.device,
        });
        stores.push(store);
        return store;
    };
    const close = s.close.bind(s);
    s.close = async (closeOptions) => {
        for (const store of stores) {
            await store.close();
        }
        await close(closeOptions);
    };
    const requests = (pattern: RegExp) => s.server.requests.filter((request) => pattern.test(request.path));
    const bodyRequests = () => requests(/^\/api\/spaces\/[^/]+\/pages\/[^/]+$/);
    const listRequests = () => requests(/^\/api\/spaces\/[^/]+\/pages$/);
    await s.workspace.pull('', null);
    return Object.assign(s, { makeStore, refused, errors, bodyRequests, listRequests });
}

const pagesOnDisk = async (s: Setup, spaceId: string) =>
    (
        await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ? AND scope = ? ORDER BY key', [
            PAGES,
            spaceId,
        ])
    ).map((row) => row.key);
const bodiesOnDisk = async (s: Setup) =>
    (await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ? ORDER BY key', [PAGE_BODIES_KIND])).map(
        (row) => row.key,
    );

describe('a Space’s summaries', () => {
    it('pulls the Space’s pages with its ETag: a 200, then a 304 that changes nothing', async () => {
        const s = await setup();
        const pages = s.makeStore();
        const space = pages.space('everyday');
        expect((await space.pull()).outcome).toBe('fresh');
        expect(space.collection.toArray.map((summary) => summary.title).sort()).toEqual(['Handbook', 'Welcome']);
        expect(space.collection.get('p2')).toMatchObject({ revision: 3, excerpt: expect.any(String) });
        expect(space.collection.get('p2')).not.toHaveProperty('content');

        const again = await space.pull();
        expect(again.outcome === 'fresh' && again.result.outcome).toBe('not-modified');
        const [first, second] = s.listRequests();
        expect(first).toMatchObject({ path: '/api/spaces/everyday/pages', status: 200, ifNoneMatch: undefined });
        expect(second).toMatchObject({ status: 304, ifNoneMatch: expect.stringMatching(/^W\//) });
        await s.cache.flush();
        expect(await pagesOnDisk(s, 'everyday')).toEqual(['p1', 'p2']);
    });

    it('keeps each Space apart, and says why a pull failed', async () => {
        const s = await setup();
        const pages = s.makeStore();
        await pages.space('everyday').pull();
        const elsewhere = await pages.space('nowhere').pull();
        expect(elsewhere.outcome).toBe('failed');
        expect(pages.space('nowhere').collection.size).toBe(0);
        expect(pages.space('everyday').collection.size).toBe(2);
    });
});

describe('page bodies', () => {
    it('reads a body on open only when missing or older than its summary, after the list', async () => {
        const s = await setup();
        const pages = s.makeStore();
        expect(await pages.open('everyday', 'p2')).toEqual({ list: 'fresh', read: true });
        expect(pages.body('everyday', 'p2').state.value).toMatchObject({ id: 'p2', revision: 3 });
        expect(s.listRequests().map((request) => request.status)).toEqual([200]);
        expect(s.bodyRequests()).toHaveLength(1);

        // Unchanged: a 304, and no body read.
        expect(await pages.open('everyday', 'p2')).toEqual({ list: 'fresh', read: false });
        expect(s.listRequests().map((request) => request.status)).toEqual([200, 304]);
        expect(s.bodyRequests()).toHaveLength(1);

        // A screen holding a current copy reads nothing either.
        const release = pages.body('everyday', 'p2').use();
        await turns();
        expect(s.bodyRequests()).toHaveLength(1);
        release();

        // A revision bump fetches exactly that one body.
        s.server.changePages('everyday', (data) => {
            data.pages.everyday = [
                page('everyday', 'p1', 'Welcome', 1),
                page('everyday', 'p2', 'Handbook', 4, 'Edited elsewhere'),
            ];
        });
        await pages.open('everyday', 'p2');
        await vi.waitFor(() => expect(pages.body('everyday', 'p2').state.value?.revision).toBe(4));
        expect(s.bodyRequests().map((request) => request.path)).toEqual([
            '/api/spaces/everyday/pages/p2',
            '/api/spaces/everyday/pages/p2',
        ]);
        await pages.flush();
        expect(await bodiesOnDisk(s)).toEqual([pageBodyKey('everyday', 'p2')]);
        expect(s.errors).toEqual([]);
    });

    it('re-keys a moved page’s body and the last screen to its new Space', async () => {
        const s = await setup();
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: pageScreen('everyday', 'p1') });
        const pages = s.makeStore(s.cache, { viewState });
        await pages.open('everyday', 'p1');
        const moved: PageMove[] = [];
        pages.onMoved((move) => moved.push(move));

        s.server.change('workspace', (data) => {
            data.spaces.push({ id: 'ops', name: 'Ops', description: '', createdAt: 2 });
        });
        await s.workspace.pull('', s.workspace.cursor());
        s.server.changePages(
            'everyday',
            (data) => {
                const [first, ...rest] = data.pages.everyday!;
                data.pages.everyday = rest;
                data.pages.ops = [{ ...first!, spaceId: 'ops', revision: 2 }];
            },
            ['ops'],
        );
        // The Space's poll drops it: its held body asks, the 404 reads the location.
        await pages.space('everyday').pull();
        await vi.waitFor(() => expect(moved).toEqual([{ pageId: 'p1', from: 'everyday', to: 'ops' }]));
        expect(keptPage(viewState.get(LAST_SCREEN_KEY))).toEqual({ spaceId: 'ops', pageId: 'p1' });
        await vi.waitFor(() => expect(pages.body('ops', 'p1').state.value).toMatchObject({ spaceId: 'ops' }));
        await pages.flush();
        expect(await bodiesOnDisk(s)).toEqual([pageBodyKey('ops', 'p1')]);
        expect(s.server.requests.some((request) => request.path === '/api/pages/p1/location')).toBe(true);
        expect(s.refused).toEqual([]);
    });

    it('drops a deleted page (410) and sends its writes to Unsent', async () => {
        const s = await setup();
        const pages = s.makeStore(s.cache, { lanes: ['page:p1', 'chat:c1'] });
        await pages.open('everyday', 'p1');
        s.server.changePages('everyday', (data) => {
            data.pages.everyday = data.pages.everyday!.filter((item) => item.id !== 'p1');
            data.deletedPages.push('p1');
        });
        await pages.space('everyday').pull();
        await vi.waitFor(() => expect(s.refused).toEqual([pageLanes('p1')]));
        expect(pages.body('everyday', 'p1').state.value).toBeNull();
        await pages.flush();
        expect(await bodiesOnDisk(s)).toEqual([]);
        // A 410 is no move: no location asked.
        expect(s.server.requests.some((request) => request.path.endsWith('/location'))).toBe(false);
    });

    it('names the page each lane is for, and parses its keys', () => {
        expect(pageLanes('p1').map(pageOfLane)).toEqual(['p1', 'p1']);
        expect(pageOfLane('page-conflict:p1')).toBe('p1');
        expect(pageOfLane('chat:p1')).toBeNull();
        expect(parsePageBodyKey(pageBodyKey('a/b', 'c d'))).toEqual({ spaceId: 'a/b', pageId: 'c d' });
        expect(parsePageBodyKey('nothing')).toBeNull();
    });
});

describe('a Space that leaves /api/workspace', () => {
    it('drops its summaries and bodies from memory and disk, and its pages’ writes go to Unsent', async () => {
        const s = await setup();
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: pageScreen('everyday', 'p2') });
        const pages = s.makeStore(s.cache, { lanes: ['page:p2'], viewState });
        await pages.open('everyday', 'p2');
        await pages.open('everyday', 'p1');
        const space = pages.space('everyday');
        await s.cache.flush();
        await pages.flush();
        expect(await bodiesOnDisk(s)).toHaveLength(2);
        const before = s.bodyRequests().length;

        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        await s.workspace.pull('', s.workspace.cursor());
        await vi.waitFor(async () => expect(await bodiesOnDisk(s)).toEqual([]));
        expect(await pagesOnDisk(s, 'everyday')).toEqual([]);
        expect(
            await s.db.get('SELECT 1 AS found FROM meta WHERE collection = ? AND scope = ?', [PAGES, 'everyday']),
        ).toBe(null);
        expect(space.collection.size).toBe(0);
        expect(pages.body('everyday', 'p2').state.value).toBeNull();
        expect(s.refused.flat().sort()).toEqual([...pageLanes('p1'), ...pageLanes('p2')].sort());
        expect(viewState.get(LAST_SCREEN_KEY)).toBe('Spaces');
        // No body was asked for the dropped pages.
        expect(s.bodyRequests()).toHaveLength(before);
        expect(s.errors).toEqual([]);
    });

    it('resets a kept library of the dropped Space to the Spaces', async () => {
        const s = await setup();
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: spaceScreen('everyday') });
        const pages = s.makeStore(s.cache, { viewState });
        await pages.space('everyday').pull();
        await s.cache.flush();

        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        await s.workspace.pull('', s.workspace.cursor());
        await vi.waitFor(() => expect(viewState.get(LAST_SCREEN_KEY)).toBe('Spaces'));
        expect(keptSpace(viewState.get(LAST_SCREEN_KEY))).toBeNull();
        expect(s.errors).toEqual([]);
    });

    it('drops, as it opens, a Space a kill left on disk after it went', async () => {
        const s = await setup();
        const pages = s.makeStore();
        await pages.open('everyday', 'p1');
        await s.cache.flush();
        await pages.flush();
        await pages.close();
        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        // The shell's answer lands, but no store hears it (a kill before the drop).
        await s.workspace.pull('', s.workspace.cursor());
        await s.cache.flush();
        expect(await bodiesOnDisk(s)).toHaveLength(1);

        const next = s.makeStore();
        await next.flush();
        await vi.waitFor(async () => expect(await bodiesOnDisk(s)).toEqual([]));
        expect(await pagesOnDisk(s, 'everyday')).toEqual([]);
    });
});

describe('the disk bounds', () => {
    const body = (spaceId: string, id: string, content = 'x'): Page => ({
        ...page(spaceId, id, id, 1, content),
    });

    it('keeps the 200 most recent bodies, never one with queued writes nor a kept Space’s, nor one over 4 MB', async () => {
        const s = await setup();
        const pages = s.makeStore(s.cache, { lanes: ['page:pinned'], kept: ['kept'] });
        await pages.bodies.put(pageBodyKey('everyday', 'pinned'), body('everyday', 'pinned'));
        await pages.bodies.put(pageBodyKey('kept', 'k1'), body('kept', 'k1'));
        // Each put is one disk step after the last: queued at once, in order.
        const puts: Promise<void>[] = [];
        for (let index = 0; index < PAGE_BODIES_KEPT + 5; index += 1) {
            puts.push(pages.bodies.put(pageBodyKey('everyday', `n${index}`), body('everyday', `n${index}`)));
        }
        await Promise.all(puts);
        await pages.flush();
        const kept = await bodiesOnDisk(s);
        expect(kept).toHaveLength(PAGE_BODIES_KEPT);
        expect(kept).toContain(pageBodyKey('everyday', 'pinned'));
        expect(kept).toContain(pageBodyKey('kept', 'k1'));
        expect(kept).not.toContain(pageBodyKey('everyday', 'n0'));
        expect(kept).toContain(pageBodyKey('everyday', `n${PAGE_BODIES_KEPT + 4}`));

        await pages.bodies.put(pageBodyKey('everyday', 'huge'), body('everyday', 'huge', 'x'.repeat(4 * 1024 * 1024)));
        await pages.flush();
        expect(await bodiesOnDisk(s)).not.toContain(pageBodyKey('everyday', 'huge'));
    }, 60_000);
});

describe('a cold start onto a page', () => {
    it('reads the Space’s summaries and the page’s body from disk before any request', async () => {
        const s = await setup();
        const first = s.makeStore();
        await first.open('everyday', 'p2');
        await s.cache.flush();
        await first.flush();
        await first.close();

        const cache = await openSnapshotCache({ db: s.db, definitions: SHELL_SNAPSHOTS, now: s.clock.device });
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: pageScreen('everyday', 'p2') });
        const pages = s.makeStore(cache, { viewState });
        const sent = s.server.requests.length;
        await preloadKeptPage({ viewState, pages });
        expect(pages.body('everyday', 'p2').state.value).toMatchObject({ title: 'Handbook', revision: 3 });
        expect(pages.space('everyday').collection.size).toBe(2);
        expect(s.server.requests).toHaveLength(sent);
        await pages.close();
        await cache.close();
    });

    it('a cold start onto a Space’s library reads its pages from disk alone', async () => {
        const s = await setup();
        const first = s.makeStore();
        await first.space('everyday').pull();
        await s.cache.flush();
        await first.close();

        const cache = await openSnapshotCache({ db: s.db, definitions: SHELL_SNAPSHOTS, now: s.clock.device });
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: spaceScreen('everyday') });
        const pages = s.makeStore(cache, { viewState });
        const sent = s.server.requests.length;
        await preloadKeptSpace({ viewState, pages });
        expect(pages.space('everyday').collection.size).toBe(2);
        expect(s.server.requests).toHaveLength(sent);
        // Another last screen reads nothing.
        await preloadKeptSpace({ viewState: memoryViewState({ [LAST_SCREEN_KEY]: 'Spaces' }), pages });
        expect([keptSpace('Space/a/b'), keptSpace('Space/'), keptSpace('Spaces'), keptSpace('Space/ops')]).toEqual([
            null,
            null,
            null,
            'ops',
        ]);
        await pages.close();
        await cache.close();
    });

    it('offline, with no body kept, has the title and excerpt, and the open says the list failed', async () => {
        const s = await setup();
        const first = s.makeStore();
        await first.space('everyday').pull();
        await s.cache.flush();
        await first.close();

        const cache = await openSnapshotCache({ db: s.db, definitions: SHELL_SNAPSHOTS, now: s.clock.device });
        const viewState = memoryViewState({ [LAST_SCREEN_KEY]: pageScreen('everyday', 'p1') });
        const offline = { on: true };
        const pages = s.makeStore(cache, { viewState, offline });
        await preloadKeptPage({ viewState, pages });
        const item = pages.body('everyday', 'p1');
        expect(item.state).toMatchObject({ value: null, loaded: true });
        expect(pages.summary('everyday', 'p1')).toMatchObject({ title: 'Welcome', excerpt: expect.any(String) });
        expect(await pages.open('everyday', 'p1')).toEqual({ list: 'failed', read: false });
        await pages.close();
        await cache.close();
    });
});

describe('the scoped kind in the cache', () => {
    it('loads a scope as it is first pulled, and a pull begun before a drop is superseded', async () => {
        const s = await setup();
        expect(s.cache.loaded(PAGES_SNAPSHOT, 'everyday')).toBe(false);
        await s.cache.load([PAGES_SNAPSHOT], 'everyday');
        const startedAt = s.cache.beginPull();
        await s.cache.dropScope(PAGES_SNAPSHOT, 'everyday');
        const answer = s.cache.applySnapshot(PAGES_SNAPSHOT, 'everyday', startedAt, [[]], 'W/"x.y"');
        expect(answer.outcome).toBe('superseded');
        await expect(s.cache.dropScope(SHELL_SNAPSHOTS[0]!, '')).rejects.toBeInstanceOf(TypeError);
    });
});

describe('the scope’s pages', () => {
    let device: Phone;
    const scopes: WorkspaceScope[] = [];
    const stores: Store[] = [];

    beforeEach(() => {
        device = phone(mkdtempSync(join(tmpdir(), 'socio-pages-')));
        vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(async () => {
        for (const scope of scopes.splice(0)) {
            await scope.dispose();
        }
        for (const store of stores.splice(0)) {
            await store.registry.close().catch(() => {});
        }
        vi.useRealTimers();
        rmSync(device.root, { recursive: true, force: true });
    });

    /** A page save kind that waits on the person, so its row stays queued. */
    const HELD: OutboxKind<{ pageId: string }> = {
        kind: 'page-save',
        payloadVersion: 1,
        repeatable: false,
        send: async (): Promise<SendOutcome> => ({ action: 'hold', reason: 'ask' }),
    };

    it('polls a Space while it shows, and a lost Space’s queued write goes to unsent', async () => {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        const errors: unknown[] = [];
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState: fakeAppState('active'),
            network: fakeNetwork(WIFI),
            outboxKinds: [HELD] as OutboxKind<unknown>[],
            onError: (error) => errors.push(error),
            random: () => 0.5,
        });
        scopes.push(scope);
        scope.start();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        const listPulls = () => server.requests.filter((request) => request.path === '/api/spaces/everyday/pages');
        expect(listPulls()).toEqual([]);

        // In view: pulled, then every 15 s while it shows.
        const leave = scope.pages.space('everyday').view();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        expect(listPulls()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(15_000 + COALESCE_MS);
        expect(listPulls()).toHaveLength(2);
        leave();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(listPulls()).toHaveLength(2);

        await scope.outbox.enqueue({
            id: 'w-1',
            lane: 'page:p1',
            kind: 'page-save',
            payload: JSON.stringify({ pageId: 'p1' }),
            payloadVersion: 1,
            idempotencyKey: 'key-w-1',
        });
        await turns();
        await scope.outbox.idle();

        server.change('workspace', (data) => {
            data.spaces = [];
        });
        scope.scheduler.poke(['workspace']);
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        await vi.waitFor(() =>
            expect(scope.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['w-1', UNSENT_GONE]]),
        );
        expect(scope.cache.rows(PAGES, 'everyday').size).toBe(0);
        expect(errors).toEqual([]);
    });
});
