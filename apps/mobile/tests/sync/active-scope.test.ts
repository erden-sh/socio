import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCacheDb, type Store, workspaceKeyName, workspaceLayout } from '../../src/data';
import type { FetchFunction } from '../../src/net/fetch-function';
import { type ActiveScope, createActiveScope } from '../../src/sync/active-scope';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { CONVERSATIONS, SHELL_SNAPSHOTS, SPACES, STATE_KEY } from '../../src/sync/shell';
import { endFakeTime, type FakeTime, fakeTime } from '../helpers/fake-time';
import { kill, launch, phone, type Phone } from '../helpers/store';
import { clocks, T0 } from '../net/helpers';

import { type FakeAppState, fakeAppState, type FakeNetwork, fakeNetwork, WIFI } from './fakes';
import { conversation, type FakeWorkspaceServer, fakeWorkspaceServer, rowsOnDisk } from './helpers';
import { signedIn, type Wire, wire } from './wire';

// Switching between workspaces: three fake servers with different
// data, through the active scope, the scopes it opens, their sources and
// collections, and the store on node:sqlite. After each switch only that
// workspace's rows, meta, ETags and jar can be reached, no handle of the old
// scope is open, and a late answer to the old workspace's pull writes nothing.

const WORKSPACES = [
    { key: 'a', origin: 'https://a.example.test', name: 'Alpha', marker: 'Marker Alpha' },
    { key: 'b', origin: 'https://b.example.test', name: 'Bravo', marker: 'Marker Bravo' },
    { key: 'c', origin: 'https://c.example.test', name: 'Charlie', marker: 'Marker Charlie' },
] as const;
type Key = (typeof WORKSPACES)[number]['key'];

let device: Phone;
/** This test's fake time: a body that ran past its timeout can't move the next test's clock (helpers/fake-time.ts). */
let time: FakeTime;
const stores: Store[] = [];
const actives: ActiveScope[] = [];

beforeEach(({ signal }) => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-switch-')));
    time = fakeTime(signal, {
        now: T0,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
});
afterEach(async () => {
    for (const active of actives.splice(0)) {
        await active.show(null);
    }
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    endFakeTime();
    rmSync(device.root, { recursive: true, force: true });
});

interface Setup {
    /** The phone and the fake time of the test that made it, never a later test's. */
    readonly device: Phone;
    readonly time: FakeTime;
    readonly store: Store;
    readonly servers: Record<Key, FakeWorkspaceServer>;
    readonly ids: Record<Key, string>;
    readonly net: Wire;
    readonly appState: FakeAppState;
    readonly network: FakeNetwork;
    readonly opened: WorkspaceScope[];
    readonly errors: unknown[];
    readonly active: ActiveScope;
}

/** The phone with three workspaces signed in, each server holding its own marker chat, space and name. */
async function setup(
    previous?: Pick<Setup, 'servers' | 'ids' | 'device' | 'time'>,
    fetch?: FetchFunction,
): Promise<Setup> {
    const mine = { device: previous?.device ?? device, time: previous?.time ?? time };
    // A relaunch from a body that ran past its timeout stops here.
    await mine.time.turns(0);
    const { store } = await launch(mine.device);
    stores.push(store);
    const servers = previous?.servers ?? ({} as Record<Key, FakeWorkspaceServer>);
    const ids = previous?.ids ?? ({} as Record<Key, string>);
    if (previous === undefined) {
        for (const { key, origin, name, marker } of WORKSPACES) {
            const clock = clocks();
            const server = fakeWorkspaceServer(clock);
            server.change('state', (data) => {
                data.settings = { name, paused: false };
            });
            server.change('workspace', (data) => {
                data.conversations = [conversation(`${key}1`, marker, 1)];
                data.archived = [];
                data.spaces = [{ id: `${key}-space`, name: `${name} space`, description: '', createdAt: 1 }];
            });
            servers[key] = server;
            ids[key] = await signedIn(store, origin, server, clock);
        }
    }
    const net = wire(new Map(WORKSPACES.map(({ key, origin }) => [origin, servers[key]])));
    const appState = fakeAppState('active');
    const network = fakeNetwork(WIFI);
    const opened: WorkspaceScope[] = [];
    const errors: unknown[] = [];
    const active = createActiveScope({
        open: async (workspaceId) => {
            const scope = await openWorkspaceScope({
                store,
                workspaceId,
                fetch: fetch ?? net.fetch,
                userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
                variant: 'production',
                appState,
                network,
                onError: (error) => errors.push(error),
                random: () => 0.5,
            });
            opened.push(scope);
            return scope;
        },
        onError: (error) => errors.push(error),
    });
    actives.push(active);
    return { ...mine, store, servers, ids, net, appState, network, opened, errors, active };
}

/** The open scope, which the test expects there to be. */
function openScope(active: ActiveScope): WorkspaceScope {
    const state = active.get();
    if (state.kind !== 'open') {
        throw new Error(`No scope open: ${state.kind}`);
    }
    return state.scope;
}

/** Shows `key`'s workspace and syncs it once, as the app does after its first frame. */
async function switchTo(s: Setup, key: Key): Promise<WorkspaceScope> {
    await s.active.show(s.ids[key]);
    const scope = openScope(s.active);
    scope.start();
    await s.time.advance(COALESCE_MS);
    await scope.scheduler.idle();
    return scope;
}

/** Every chat title and space name a screen could reach through the scope: its collections and its cache. */
function reachable(scope: WorkspaceScope): string[] {
    const fromCollections = [
        ...scope.collections.conversations.toArray.map((chat) => chat.title),
        ...scope.collections.spaces.toArray.map((space) => space.name),
    ];
    const fromCache = [CONVERSATIONS, SPACES].flatMap((collection) =>
        [...scope.cache.rows(collection).values()].map((row) => {
            const value = JSON.parse(row.json) as { title?: string; name?: string };
            return value.title ?? value.name ?? '';
        }),
    );
    return [...new Set([...fromCollections, ...fromCache])].sort();
}

const own = (key: Key) => {
    const workspace = WORKSPACES.find((w) => w.key === key);
    return [workspace?.marker ?? '', `${workspace?.name ?? ''} space`].sort();
};

/** The files open in each workspace's directory, by key. */
const filesOpen = (s: Setup) =>
    Object.fromEntries(
        WORKSPACES.map(({ key }) => [
            key,
            s.store.driver
                .openFiles()
                .filter((file) => file.directory === workspaceLayout(s.store.root, s.ids[key]).directory)
                .map((file) => file.name)
                .sort(),
        ]),
    );

/** The ETags and meta the open scope holds for each shell source. */
const sourceState = (scope: WorkspaceScope) =>
    SHELL_SNAPSHOTS.map((definition) => ({
        cursor: scope.cache.cursor(definition),
        meta: scope.cache.meta(definition),
    }));

describe('switching through three workspaces', () => {
    it('reaches only that workspace’s rows, meta, ETags and jar after each switch, and leaves no handle of the old scope', async () => {
        const s = await setup();
        const seen = new Map<Key, ReturnType<typeof sourceState>>();
        let previous: WorkspaceScope | null = null;
        let perScope: { appState: number; network: number } | null = null;
        for (const key of ['a', 'b', 'c', 'a', 'c', 'b'] as const) {
            const scope = await switchTo(s, key);
            const { origin, name } = WORKSPACES.find((w) => w.key === key) ?? WORKSPACES[0];

            // Rows: the marker and space of this workspace, and none of the others'.
            expect(reachable(scope), key).toEqual(own(key));
            expect(scope.collections.shell.get(STATE_KEY)?.value).toMatchObject({ settings: { name } });
            expect(scope.workspace.id).toBe(s.ids[key]);

            // Meta and ETags: this server's, which no other workspace's scope ever held.
            const state = sourceState(scope);
            for (const { cursor, meta } of state) {
                expect(cursor, key).not.toBeNull();
                expect(meta, key).not.toBeNull();
            }
            for (const [other, held] of seen) {
                if (other !== key) {
                    const cursors = held.map((entry) => entry.cursor);
                    expect(
                        state.filter((entry) => cursors.includes(entry.cursor)),
                        `${key} vs ${other}`,
                    ).toEqual([]);
                }
            }
            seen.set(key, state);

            // The jar: this origin's only.
            expect(scope.jar.origin).toBe(origin);
            expect(scope.jar.cookieHeader(new URL(`${origin}/api/state`))).not.toBeNull();
            for (const otherWorkspace of WORKSPACES.filter((w) => w.key !== key)) {
                expect(scope.jar.cookieHeader(new URL(`${otherWorkspace.origin}/api/state`))).toBeNull();
            }

            // Its requests went to its own origin only.
            const sinceSwitch = s.net.calls.slice(-2);
            expect(sinceSwitch.map((call) => new URL(call.url).origin)).toEqual([origin, origin]);

            // The old scope: disposed, its collections cleaned up for good, its signal aborted, no file open.
            if (previous !== null) {
                expect(previous.disposed).toBe(true);
                expect(previous.signal.aborted).toBe(true);
                expect(previous.collections.conversations.status).toBe('cleaned-up');
                expect(previous.collections.conversations.size).toBe(0);
                expect(previous.cache.rows(CONVERSATIONS).size).toBe(0);
            }
            expect(filesOpen(s)).toEqual(
                Object.fromEntries(WORKSPACES.map((w) => [w.key, w.key === key ? ['cache.db', 'user.db'] : []])),
            );
            // One scope's listeners, not one per scope opened so far.
            perScope ??= { appState: s.appState.listeners, network: s.network.listeners };
            expect({ appState: s.appState.listeners, network: s.network.listeners }).toEqual(perScope);
            previous = scope;
        }
        expect(s.opened).toHaveLength(6);
        expect(s.opened.filter((scope) => !scope.disposed)).toHaveLength(1);
        expect(s.errors).toEqual([]);

        // No workspace (adding one, or the last signed out): nothing stays open or running.
        await s.active.show(null);
        expect(s.active.get()).toEqual({ kind: 'none' });
        expect(s.opened.every((scope) => scope.disposed)).toBe(true);
        expect(Object.values(filesOpen(s)).flat()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(s.appState.listeners).toBe(0);
        expect(s.network.listeners).toBe(0);
    });

    it('never writes a late answer to the old workspace’s pull, to it or to the new one', async () => {
        const s = await setup();
        const a = await switchTo(s, 'a');
        s.servers.a.change('workspace', (data) => {
            data.conversations.push(conversation('a-late', 'Late Alpha', 9));
        });
        // Both of a's pulls go out on a network that misses the abort: their answers come after the switch.
        s.net.hold(true);
        s.net.missAbort(true);
        a.scheduler.poke();
        await s.time.advance(COALESCE_MS);
        expect(s.net.held).toBe(2);
        s.net.hold(false);
        s.net.missAbort(false);
        const applied = [vi.spyOn(a.cache, 'applySnapshot'), vi.spyOn(a.cache, 'applyNotModified')];

        const b = await switchTo(s, 'b');
        expect(a.disposed).toBe(true);
        s.net.release();
        s.net.release();
        await s.time.turns();
        await s.time.advance(COALESCE_MS * 20);
        await b.scheduler.idle();

        expect(applied.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
        expect(reachable(b)).toEqual(own('b'));
        expect(a.collections.conversations.size).toBe(0);
        // On disk: a's cache.db has its rows from before, not the late one; b's has only its own.
        const onDisk = async (key: Key) => {
            const directory = workspaceLayout(s.store.root, s.ids[key]).directory;
            const keyName = workspaceKeyName(s.ids[key], 'cache');
            const cache = await openCacheDb(s.store.driver, directory, (await s.store.keys.read(keyName)) ?? '');
            const rows = Object.values(await rowsOnDisk(cache.db, CONVERSATIONS)) as { title?: string }[];
            await cache.db.close();
            return rows.map((row) => row.title).sort();
        };
        expect(await onDisk('a')).toEqual(['Marker Alpha']);
        expect(await onDisk('b')).toEqual(['Marker Bravo']);
        expect(s.errors).toEqual([]);
    });

    it('shows only the last workspace asked for when switches come faster than scopes open', async () => {
        const s = await setup();
        const settled = [s.active.show(s.ids.a), s.active.show(s.ids.b), s.active.show(s.ids.c)];
        await Promise.all(settled);
        const scope = openScope(s.active);
        expect(scope.workspace.id).toBe(s.ids.c);
        // Not started, so it holds what cache.db had (a stand-in row), and nothing of a or b.
        const others = [...own('a'), ...own('b')];
        expect(reachable(scope).filter((title) => others.includes(title))).toEqual([]);
        expect(s.opened.filter((opened) => !opened.disposed)).toEqual([scope]);
        expect(filesOpen(s)).toEqual({ a: [], b: [], c: ['cache.db', 'user.db'] });
        // Nothing was asked of a server by a scope that never showed.
        expect(s.net.calls).toEqual([]);
    });

    it('leaves a workspace that didn’t open retryable, and switching and adding still work', async () => {
        const s = await setup();
        // a's cache key is gone from the keychain (lost, or restored onto another phone).
        const keyName = [...s.device.keychain.keys()].find((name) => name.includes(workspaceKeyName(s.ids.a, 'cache')));
        expect(keyName).toBeDefined();
        const key = s.device.keychain.get(keyName ?? '') ?? '';
        s.device.keychain.delete(keyName ?? '');

        await s.active.show(s.ids.a);
        expect(s.active.get()).toMatchObject({ kind: 'failed', workspaceId: s.ids.a });
        expect(s.errors).toHaveLength(1);
        // Asking for it again tries again, rather than staying stuck.
        await s.active.show(s.ids.a);
        await s.active.retry();
        expect(s.active.get()).toMatchObject({ kind: 'failed', workspaceId: s.ids.a });
        expect(s.errors).toHaveLength(3);

        // The switcher still opens another workspace.
        const b = await switchTo(s, 'b');
        expect(reachable(b)).toEqual(own('b'));
        // Adding a workspace shows none, and Cancel brings a back, which fails again with no scope open.
        await s.active.show(null);
        expect(s.active.get()).toEqual({ kind: 'none' });
        expect(b.disposed).toBe(true);
        await s.active.show(s.ids.a);
        expect(s.active.get()).toMatchObject({ kind: 'failed', workspaceId: s.ids.a });
        expect(filesOpen(s)).toEqual({ a: [], b: [], c: [] });

        // Once its key is back (a transient failure), Try again opens it.
        s.device.keychain.set(keyName ?? '', key);
        await s.active.retry();
        expect(openScope(s.active).workspace.id).toBe(s.ids.a);
        expect(filesOpen(s)).toEqual({ a: ['cache.db', 'user.db'], b: [], c: [] });
    });

    it('opens the last workspace at a cold relaunch with every server away, from its own cache only', async () => {
        const s = await setup();
        await switchTo(s, 'a');
        await switchTo(s, 'c');
        await s.store.registry.setActive(s.ids.c);
        await s.active.show(null);
        await kill(s.store);
        await s.store.registry.close();

        // A relaunch with no network: every request fails.
        const offline: FetchFunction = () => Promise.reject(new Error('fetch failed: offline'));
        const again = await setup(s, offline);
        const active = await again.store.registry.active();
        expect(active).toBe(s.ids.c);
        await again.active.show(active);
        const scope = openScope(again.active);
        expect(reachable(scope)).toEqual(own('c'));
        expect(scope.collections.shell.get(STATE_KEY)?.value).toMatchObject({ settings: { name: 'Charlie' } });
        // The others are on the phone, closed, and nothing of theirs shows.
        expect(filesOpen(again)).toEqual({ a: [], b: [], c: ['cache.db', 'user.db'] });
    });
});
