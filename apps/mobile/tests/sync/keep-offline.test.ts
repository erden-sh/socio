import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearCache, openUserDb, type Store, UPDATE_TO_SEND, USER_MIGRATIONS } from '../../src/data';
import { NetworkError } from '../../src/net/errors';
import { KEPT_SPACES_PREF, KeptSpacesError, openKeptSpaces } from '../../src/sync/kept-spaces';
import { openOutbox } from '../../src/sync/outbox';
import { pageBodyKey } from '../../src/sync/pages';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, OFFLINE, WIFI } from './fakes';
import { fakeWorkspaceServer, page } from './helpers';
import { USER_KEY } from './outbox-fakes';
import { signedIn, wire } from './wire';

// Keeping a Space offline over a real store and the fake server:
// user.db's migration 3 (`prefs`) and the older build that then reads the file
// and holds its outbox; the kept Spaces in user.db; a kept Space's bodies read
// one at a time, again after a revision bump, back after Clear cache, and
// every page read in airplane mode.

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});
const temp = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
};

describe('user.db migration 3', () => {
    it('adds `prefs` to a migration-2 file and keeps its rows; an older build reads the file and holds its outbox', async () => {
        const directory = temp('socio-prefs-migrate-');
        const driver = createNodeSqliteDriver({ keys: new Map() });
        const old = await openUserDb(driver, directory, USER_KEY, USER_MIGRATIONS.slice(0, 2));
        expect(old.state).toEqual({ writable: true, version: 2 });
        await old.db.run(
            'INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ['o1', 'chat:c1', 'message', '{"text":"waiting"}', 1, 'k1', 'queued', 10],
        );
        await old.db.close();

        const current = await openUserDb(driver, directory, USER_KEY);
        expect(current.state).toEqual({ writable: true, version: 3 });
        expect(await current.db.all('SELECT id, state FROM outbox')).toEqual([{ id: 'o1', state: 'queued' }]);
        const kept = await openKeptSpaces({ db: current.db, state: current.state });
        await kept.set('everyday', true);
        await kept.close();
        await current.db.close();

        // A build at migration 2 opens it read-only: it shows the row and never sends it.
        const older = await openUserDb(driver, directory, USER_KEY, USER_MIGRATIONS.slice(0, 2));
        expect(older.state).toEqual({ writable: false, reason: 'newer', version: 3, message: UPDATE_TO_SEND });
        const sent: string[] = [];
        const outbox = await openOutbox({
            db: older.db,
            state: older.state,
            kinds: [
                {
                    kind: 'message',
                    payloadVersion: 1,
                    repeatable: true,
                    send: async () => {
                        sent.push('sent');
                        return { action: 'done' };
                    },
                },
            ],
            fetch: (() => Promise.reject(new Error('no network'))) as never,
        });
        outbox.start();
        await outbox.idle();
        expect(outbox.status().readOnly).toBe(true);
        expect(outbox.rows().map((row) => [row.id, row.state])).toEqual([['o1', 'queued']]);
        expect(sent).toEqual([]);
        await outbox.dispose();
        await older.db.close();
    });
});

describe('the kept Spaces', () => {
    it('are kept in user.db in the order kept, and a read-only file shows them and takes no change', async () => {
        const directory = temp('socio-prefs-');
        const driver = createNodeSqliteDriver({ keys: new Map() });
        const file = await openUserDb(driver, directory, USER_KEY);
        const kept = await openKeptSpaces({ db: file.db, state: file.state });
        expect(kept.list()).toEqual([]);
        const changes = vi.fn();
        kept.subscribe(changes);
        void kept.set('b', true);
        void kept.set('a', true);
        expect(kept.list()).toEqual(['b', 'a']);
        await kept.set('b', false);
        await kept.set('a', true);
        expect(changes).toHaveBeenCalledTimes(3);
        await kept.close();
        expect(await file.db.all('SELECT key, value FROM prefs')).toEqual([{ key: KEPT_SPACES_PREF, value: '["a"]' }]);

        const again = await openKeptSpaces({ db: file.db, state: file.state });
        expect(again.has('a')).toBe(true);
        await again.close();
        const readOnly = await openKeptSpaces({
            db: file.db,
            state: { writable: false, reason: 'newer', version: 4, message: UPDATE_TO_SEND },
        });
        expect([readOnly.list(), readOnly.writable]).toEqual([['a'], false]);
        await expect(readOnly.set('b', true)).rejects.toThrow(KeptSpacesError);
        expect(readOnly.list()).toEqual(['a']);
        await file.db.close();
    });
});

describe('a kept Space in the scope', () => {
    let device: Phone;
    const scopes: WorkspaceScope[] = [];
    const stores: Store[] = [];

    beforeEach(() => {
        device = phone(mkdtempSync(join(tmpdir(), 'socio-keep-')));
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

    async function setup() {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        server.changePages('everyday', (data) => {
            data.pages.everyday!.push(page('everyday', 'p3', 'Holidays', 2));
        });
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        const airplane = { on: false };
        let inFlight = 0;
        let mostInFlight = 0;
        const bodyReads: string[] = [];
        const fetch = async (url: string, init: FetchRequestInit) => {
            if (airplane.on) {
                throw new NetworkError(url);
            }
            const body = /\/api\/spaces\/[^/]+\/pages\/([^/]+)$/.exec(new URL(url).pathname);
            if (body === null) {
                return net.fetch(url, init);
            }
            bodyReads.push(body[1]!);
            inFlight += 1;
            mostInFlight = Math.max(mostInFlight, inFlight);
            try {
                await Promise.resolve();
                return await net.fetch(url, init);
            } finally {
                inFlight -= 1;
            }
        };
        const errors: unknown[] = [];
        const network = fakeNetwork(WIFI);
        const open = async () => {
            const scope = await openWorkspaceScope({
                store,
                workspaceId: id,
                fetch,
                userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
                variant: 'production',
                appState: fakeAppState('active'),
                network,
                onError: (error) => errors.push(error),
                random: () => 0.5,
            });
            scopes.push(scope);
            scope.start();
            await vi.advanceTimersByTimeAsync(COALESCE_MS);
            return scope;
        };
        const close = async (scope: WorkspaceScope) => {
            scopes.splice(scopes.indexOf(scope), 1);
            await scope.dispose();
        };
        const settle = async (scope: WorkspaceScope) => {
            await vi.advanceTimersByTimeAsync(COALESCE_MS);
            await scope.keepOffline.idle();
            await scope.pages.flush();
        };
        return {
            store,
            id,
            server,
            net,
            airplane,
            network,
            bodyReads,
            errors,
            open,
            close,
            settle,
            mostInFlight: () => mostInFlight,
        };
    }

    it('reads every body of a kept Space one at a time, again after a revision bump, and sizes it', async () => {
        const s = await setup();
        const scope = await s.open();
        expect(s.bodyReads).toEqual([]);

        await scope.keptSpaces.set('everyday', true);
        await s.settle(scope);
        expect([...s.bodyReads].sort()).toEqual(['p1', 'p2', 'p3']);
        expect(s.mostInFlight()).toBe(1);
        for (const pageId of ['p1', 'p2', 'p3']) {
            expect(await scope.pages.bodies.stored(pageBodyKey('everyday', pageId))).toBe(true);
        }
        const size = (await scope.keepOffline.sizes(['everyday'])).get('everyday')!;
        expect(size.pages).toBe(3);
        expect(size.bytes).toBeGreaterThan(0);

        // A poll that brings p2's new revision reads p2 alone.
        s.server.changePages('everyday', (data) => {
            const p2 = data.pages.everyday!.find((item) => item.id === 'p2')!;
            Object.assign(p2, { revision: 4, content: 'Changed', updatedAt: 4 });
        });
        s.bodyReads.length = 0;
        await scope.pages.space('everyday').pull();
        await s.settle(scope);
        expect(s.bodyReads).toEqual(['p2']);

        // The network back pulls the list (a 304) and reads nothing more.
        s.network.set(OFFLINE);
        s.network.set(WIFI);
        await s.settle(scope);
        expect(s.bodyReads).toEqual(['p2']);
        expect(s.errors).toEqual([]);
    });

    it('keeps the choice through Clear cache, reads the bodies again, and reads every page in airplane mode', async () => {
        const s = await setup();
        const first = await s.open();
        await first.keptSpaces.set('everyday', true);
        await s.settle(first);
        await s.close(first);

        const cleared = await clearCache(s.store, s.id);
        await cleared.db.close();
        s.bodyReads.length = 0;
        const reopened = await s.open();
        expect(reopened.keptSpaces.list()).toEqual(['everyday']);
        await s.settle(reopened);
        expect([...s.bodyReads].sort()).toEqual(['p1', 'p2', 'p3']);
        await s.close(reopened);

        // Airplane mode: a cold scope reads every page of the kept Space from disk alone.
        s.airplane.on = true;
        const offline = await s.open();
        for (const [pageId, title] of [
            ['p1', 'Welcome'],
            ['p2', 'Handbook'],
            ['p3', 'Holidays'],
        ]) {
            const body = await offline.pages.preload('everyday', pageId!);
            expect(body.state.value?.title).toBe(title);
        }
        expect(offline.cache.rows('pages', 'everyday').size).toBe(3);
        expect(s.errors.filter((error) => !(error instanceof NetworkError))).toEqual([]);
    });

    it('reads nothing for a Space no longer kept', async () => {
        const s = await setup();
        const scope = await s.open();
        void scope.keptSpaces.set('everyday', true);
        await scope.keptSpaces.set('everyday', false);
        await s.settle(scope);
        expect(s.bodyReads).toEqual([]);
    });
});
