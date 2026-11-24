import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheKeyMissingError, openUserDb, type Store, workspaceKeyName, workspaceLayout } from '../../src/data';
import { clearWorkspaceCache } from '../../src/sync/clear-cache';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { STATE_KEY } from '../../src/sync/shell';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer } from './helpers';
import { signedIn, wire } from './wire';

// Settings' Clear cache for the open workspace over a real store
// and a fake server: the scope closes, cache.db goes, the scope opens
// again with no synced row, and the outbox's pending rows, in user.db, are
// there again before any request.

let device: Phone;
const scopes: WorkspaceScope[] = [];
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-clear-cache-')));
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
    const net = wire(new Map([[ORIGIN, server]]));
    const id = await signedIn(store, ORIGIN, server, clock);
    const open = async () => {
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState: fakeAppState('active'),
            network: fakeNetwork(WIFI),
            onError: () => {},
            random: () => 0.5,
        });
        scopes.push(scope);
        return scope;
    };
    return { store, net, id, open };
}

/** Queues one write in workspace `id`'s outbox, as the app's sends do. */
async function queueWrite(store: Store, id: string) {
    const key = (await store.keys.read(workspaceKeyName(id, 'user')))!;
    const user = await openUserDb(store.driver, workspaceLayout(store.root, id).directory, key);
    await user.db.run(
        'INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['o1', 'chat:c1', 'message', '{"text":"waiting"}', 1, 'k1', 'queued', 10],
    );
    await user.db.close();
}

describe('Clear cache for the open workspace', () => {
    it('closes the scope, empties the cache, and opens it again with the pending overlays back', async () => {
        const s = await setup();
        await queueWrite(s.store, s.id);
        let scope = await s.open();
        // The Board kept: the issues kind loads before the first frame.
        scope.viewState.set('lastScreen', 'Board');
        scope.start();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        await scope.scheduler.idle();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        await scope.scheduler.idle();
        await scope.cache.flush();
        expect(scope.collections.conversations.toArray.length).toBeGreaterThan(0);
        expect(scope.collections.issues.size).toBe(2);
        expect(scope.collections.pending.toArray.map((row) => row.id)).toEqual(['o1']);

        const order: string[] = [];
        await clearWorkspaceCache(
            {
                store: s.store,
                hold: async (id) => {
                    order.push(`hold ${id === s.id}`);
                    await scope.dispose();
                },
                release: async () => {
                    order.push('release');
                    scope = await s.open();
                },
            },
            s.id,
        );
        expect(order).toEqual(['hold true', 'release']);

        // Nothing synced is left, nothing was asked yet, and the queued write shows again.
        s.net.calls.length = 0;
        expect(scope.collections.conversations.toArray).toEqual([]);
        expect(scope.collections.shell.get(STATE_KEY)).toBeUndefined();
        expect(scope.collections.issues.size).toBe(0);
        expect(scope.collections.pending.toArray.map((row) => row.id)).toEqual(['o1']);
        expect(s.net.calls).toEqual([]);

        // The next pull fills it again, and the write is still there.
        scope.start();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        await scope.scheduler.idle();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        await scope.scheduler.idle();
        expect(scope.collections.conversations.toArray.length).toBeGreaterThan(0);
        expect(scope.collections.issues.size).toBe(2);
        expect(scope.collections.pending.toArray.map((row) => row.id)).toEqual(['o1']);
    });

    it('lets the scope open again when the clear fails', async () => {
        const s = await setup();
        await s.store.keys.delete([workspaceKeyName(s.id, 'cache')]);
        const release = vi.fn(async () => {});
        await expect(
            clearWorkspaceCache({ store: s.store, hold: async () => {}, release }, s.id),
        ).rejects.toBeInstanceOf(CacheKeyMissingError);
        expect(release).toHaveBeenCalledOnce();
    });
});
