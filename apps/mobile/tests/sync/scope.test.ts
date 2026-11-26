import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveQueryCollection } from '@tanstack/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCacheDb, type Store, USER_MIGRATIONS, wipe, workspaceKeyName, workspaceLayout } from '../../src/data';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { runRows } from '../../src/shell/runs';
import { ISSUES, ISSUES_SNAPSHOT } from '../../src/sync/issues';
import { RUNS_KIND } from '../../src/sync/kinds';
import { PRESENCE_POLL_MS } from '../../src/sync/presence';
import { CONNECTED, COALESCE_MS, SHELL_POLL_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope, WorkspaceScopeError } from '../../src/sync/scope';
import { CONVERSATIONS, STATE_KEY, WORKSPACE_SNAPSHOT } from '../../src/sync/shell';
import type { PullResult } from '../../src/sync/snapshot-cache';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, OFFLINE, WIFI } from './fakes';
import { conversation, fakeWorkspaceServer, issue, rowsOnDisk, run } from './helpers';
import { signedIn, wire } from './wire';

// The per-workspace scope over a
// real store (node:sqlite, a temporary directory) and fake workspace servers,
// on fake timers with fake AppState and NetInfo: its collections are filled
// before any request; dispose aborts pulls in flight, writes what's pending,
// closes its files and leaves no timer or listener; two scopes never share a
// row; and the server versions and gate, contact and the back-off are wired in.

const B_ORIGIN = 'https://b.example.test';

let device: Phone;
const scopes: WorkspaceScope[] = [];
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-scope-')));
    // setImmediate stays real: node:sqlite's driver needs no timer, but nothing here should wait on a fake one.
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

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** A few turns of the real event loop, with the fake clock standing still. */
async function turns(count = 10) {
    for (let turn = 0; turn < count; turn += 1) {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }
}

async function setup({ app = 'active' } = {}) {
    const { store, driver } = await launch(device);
    stores.push(store);
    const clock = clocks();
    const server = fakeWorkspaceServer(clock);
    const net = wire(new Map([[ORIGIN, server]]));
    const id = await signedIn(store, ORIGIN, server, clock);
    const appState = fakeAppState(app);
    const network = fakeNetwork(WIFI);
    const errors: unknown[] = [];
    const open = async (overrides: Partial<Parameters<typeof openWorkspaceScope>[0]> = {}) => {
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState,
            network,
            onError: (error) => errors.push(error),
            random: () => 0.5,
            ...overrides,
        });
        scopes.push(scope);
        return scope;
    };
    return { store, driver, clock, server, net, id, appState, network, errors, open };
}

/** The connections open to files in workspace `id`'s directory. */
const filesOpen = (store: Store, id: string) =>
    store.driver.openFiles().filter((file) => file.directory === workspaceLayout(store.root, id).directory);

const ids = (rows: Iterable<{ id: string }>) => [...rows].map((row) => row.id).sort();

describe('opening a workspace scope', () => {
    it('fills its collections from cache.db before any request, and pulls in full once started', async () => {
        const s = await setup();
        const first = await s.open();
        first.start();
        await advance(COALESCE_MS);
        await first.scheduler.idle();
        expect(ids(first.collections.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        await first.dispose();
        s.net.calls.length = 0;

        // Opened again (a relaunch): the rows are there for the first frame, and nothing was asked.
        const scope = await s.open();
        expect(s.net.calls).toEqual([]);
        expect(scope.collections.conversations.status).toBe('ready');
        expect(ids(scope.collections.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        expect(scope.collections.shell.get(STATE_KEY)?.value).toMatchObject({ settings: { name: 'Acme' } });
        expect(scope.collections.conversations.id).toBe(`${scope.id}/conversations`);
        expect(scope.id).not.toBe(first.id);
        expect(scope.id.startsWith(`${s.id}.`)).toBe(true);
        expect(scope.userDb).toEqual({ writable: true, version: USER_MIGRATIONS.length });
        // Nothing runs until start.
        await advance(SHELL_POLL_MS);
        expect(s.net.calls).toEqual([]);
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // A start is a return to the foreground: no If-None-Match. The issues and
        // approvals kinds go after the shell.
        expect(s.net.calls.map(({ url, ifNoneMatch }) => ({ url, ifNoneMatch }))).toEqual([
            { url: `${ORIGIN}/api/state`, ifNoneMatch: undefined },
            { url: `${ORIGIN}/api/workspace`, ifNoneMatch: undefined },
            { url: `${ORIGIN}/api/issues`, ifNoneMatch: undefined },
            { url: `${ORIGIN}/api/approvals`, ifNoneMatch: undefined },
        ]);
    });

    it('refuses a workspace that isn’t ready or lacks a key, and closes what it opened when a step fails', async () => {
        const s = await setup();
        await expect(s.open({ workspaceId: 'f'.repeat(64) })).rejects.toBeInstanceOf(WorkspaceScopeError);
        // A jar stored for another origin: its cookies must never go to this one.
        const other = await openCookieJar({ origin: B_ORIGIN, store: memoryJarStore() });
        await s.store.keys.write(workspaceKeyName(s.id, 'jar'), other.serialize());
        await expect(s.open()).rejects.toThrow();
        expect(filesOpen(s.store, s.id)).toEqual([]);
        await s.store.keys.delete([workspaceKeyName(s.id, 'user')]);
        await expect(s.open()).rejects.toBeInstanceOf(WorkspaceScopeError);
        expect(filesOpen(s.store, s.id)).toEqual([]);
    });
});

describe('disposing a workspace scope', () => {
    it('aborts the pulls in flight, writes what is pending, closes its files and leaves no timer or listener', async () => {
        const s = await setup();
        const scope = await s.open();
        expect(
            filesOpen(s.store, s.id)
                .map((file) => file.name)
                .sort(),
        ).toEqual(['cache.db', 'user.db']);
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // Pulled rows wait 500 ms for the write queue; a pull is in flight.
        s.server.change('workspace', (data) => {
            data.conversations.push(conversation('c4', 'Fresh', 4));
        });
        scope.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        expect(scope.collections.conversations.get('c4')?.title).toBe('Fresh');
        // The server changes again, and both pulls go out on a network that will miss the abort:
        // their answers come after dispose.
        s.server.change('workspace', (data) => {
            data.conversations.push(conversation('c8', 'Late', 8));
        });
        s.net.hold(true);
        s.net.missAbort(true);
        scope.scheduler.poke();
        await advance(COALESCE_MS);
        expect(s.net.held).toBe(2);
        const asked = s.net.calls.length;
        const inFlight = s.net.calls.slice(-2);
        const live = scope.collections.conversations;
        expect(s.appState.listeners).toBeGreaterThan(0);
        expect(s.network.listeners).toBeGreaterThan(0);

        await scope.dispose();

        expect(scope.disposed).toBe(true);
        expect(scope.signal.aborted).toBe(true);
        expect(inFlight.map((call) => call.signal?.aborted)).toEqual([true, true]);
        expect(vi.getTimerCount()).toBe(0);
        expect(s.appState.listeners).toBe(0);
        expect(s.network.listeners).toBe(0);
        expect(filesOpen(s.store, s.id)).toEqual([]);
        expect(live.status).toBe('cleaned-up');
        expect(s.errors).toEqual([]);
        // The answers that come after (c8 among them) change nothing, and start nothing: none reaches the cache.
        const applied = [vi.spyOn(scope.cache, 'applySnapshot'), vi.spyOn(scope.cache, 'applyNotModified')];
        const answered = s.net.answered;
        s.net.release();
        s.net.release();
        expect(s.net.answered).toBe(answered + 2);
        await turns();
        await advance(SHELL_POLL_MS * 2);
        expect(applied.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
        expect(vi.getTimerCount()).toBe(0);
        expect(live.status).toBe('cleaned-up');
        expect(live.size).toBe(0);
        expect(s.errors).toEqual([]);
        // Only the away post went after, sent as dispose began and stopped with the rest.
        expect(s.net.calls).toHaveLength(asked + 1);
        expect(new URL(s.net.calls.at(-1)!.url).pathname).toBe('/api/notifications/away');
        expect(s.net.calls.at(-1)!.signal?.aborted).toBe(true);
        // cache.db has the rows pending at dispose, and nothing of the late answers.
        const cache = await openCacheDb(
            s.store.driver,
            workspaceLayout(s.store.root, s.id).directory,
            (await s.store.keys.read(workspaceKeyName(s.id, 'cache'))) ?? '',
        );
        expect(Object.keys(await rowsOnDisk(cache.db, CONVERSATIONS)).sort()).toEqual(['c0', 'c1', 'c2', 'c4']);
        await cache.db.close();
        expect(() => scope.start()).toThrow(WorkspaceScopeError);
        // A second dispose is the first one; then the wipe can run (src/data/wipe.ts).
        await scope.dispose();
        await wipe(s.store, s.id, 'sign-out');
        expect(await s.store.registry.get(s.id)).toBeNull();
    });
});

describe('a disposed workspace scope', () => {
    it('never shows its rows again, even to a live query made on its collections after a wipe', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        const old = scope.collections;
        expect(old.conversations.size).toBe(3);
        await scope.dispose();
        await wipe(s.store, s.id, 'sign-out');
        expect(await s.store.registry.get(s.id)).toBeNull();

        // A screen still under the old provider mounts a live query after the sign-out, as useLiveQuery does.
        const live = createLiveQueryCollection({ query: (q) => q.from({ chat: old.conversations }), startSync: true });
        const subscription = live.subscribeChanges(() => {}, { includeInitialState: true });
        const shell = createLiveQueryCollection({ query: (q) => q.from({ row: old.shell }), startSync: true });
        const shellSubscription = shell.subscribeChanges(() => {}, { includeInitialState: true });
        await turns();
        expect(live.size).toBe(0);
        expect(old.conversations.size).toBe(0);
        expect(shell.size).toBe(0);
        expect(old.shell.size).toBe(0);
        expect(scope.cache.rows(CONVERSATIONS).size).toBe(0);
        subscription.unsubscribe();
        shellSubscription.unsubscribe();
        await live.cleanup();
        await shell.cleanup();
    });
});

describe('a workspace scope’s view state', () => {
    it('reads cache.db’s kv as it opens, writes each change, and keeps every write made before dispose', async () => {
        const s = await setup();
        const first = await s.open();
        expect(first.viewState.get('lastScreen')).toBeNull();
        first.viewState.set('lastScreen', 'Spaces');
        first.viewState.set('lastScreen', 'Chats');
        expect(first.viewState.get('lastScreen')).toBe('Chats');
        await first.dispose();
        // Closed: a late set changes nothing.
        first.viewState.set('lastScreen', 'Home');
        const key = await s.store.keys.read(workspaceKeyName(s.id, 'cache'));
        const disk = await openCacheDb(s.store.driver, workspaceLayout(s.store.root, s.id).directory, key!);
        expect(await disk.db.all('SELECT key, value FROM kv')).toEqual([{ key: 'lastScreen', value: 'Chats' }]);
        await disk.db.close();

        const again = await s.open();
        expect(again.viewState.get('lastScreen')).toBe('Chats');
        expect(s.errors).toEqual([]);
    });
});

describe('the first frame’s module kinds', () => {
    /** A scope that synced once, with its last screen `screen`, closed: cache.db holds the issues. */
    async function synced(screen: string) {
        const s = await setup();
        const first = await s.open();
        first.start();
        await advance(COALESCE_MS);
        await first.scheduler.idle();
        await advance(COALESCE_MS);
        await first.scheduler.idle();
        expect(first.collections.issues.toArray.map((row) => row.number).sort()).toEqual([1, 2]);
        first.viewState.set('lastScreen', screen);
        await first.dispose();
        s.net.calls.length = 0;
        return s;
    }

    it('reads the issues before the first frame when the Board is kept', async () => {
        const s = await synced('Board');
        const scope = await s.open();
        expect(scope.cache.loaded(ISSUES_SNAPSHOT)).toBe(true);
        expect(scope.collections.issues.toArray.map((row) => row.title).sort()).toEqual([
            'Login fails',
            'Search is slow',
        ]);
        expect(scope.collections.issueUsers.get('users')?.value).toEqual({ 'u-ada': 'Ada' });
        expect(s.net.calls).toEqual([]);
    });

    it('reads them just after it otherwise, before any request answers', async () => {
        const s = await synced('Home');
        for (const screen of ['Home', 'Chats', 'Chat/c1']) {
            const keeping = await s.open();
            keeping.viewState.set('lastScreen', screen);
            await keeping.dispose();
            const scope = await s.open();
            expect(scope.cache.loaded(ISSUES_SNAPSHOT), screen).toBe(false);
            expect(scope.collections.issues.size, screen).toBe(0);
            // The shell's rows are there all the same.
            expect(ids(scope.collections.conversations.toArray), screen).toEqual(['c0', 'c1', 'c2']);
            s.net.hold(true);
            scope.start();
            await turns();
            expect(scope.cache.loaded(ISSUES_SNAPSHOT), screen).toBe(true);
            expect(scope.collections.issues.size, screen).toBe(2);
            s.net.hold(false);
            while (s.net.held > 0) {
                s.net.release();
            }
            await scope.dispose();
        }
    });

    it('polls the issues while the Board is in view, and keeps them through a 403', async () => {
        const s = await synced('Board');
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        const issuesAsked = () => s.net.calls.filter((call) => call.url.endsWith('/api/issues')).length;
        expect(issuesAsked()).toBe(1);
        const leave = scope.scheduler.view([ISSUES]);
        s.server.change('issues', (data) => {
            data.issues.unshift(issue(3, 'Filed elsewhere', 30));
        });
        await advance(15_000);
        await scope.scheduler.idle();
        expect(issuesAsked()).toBe(2);
        expect(scope.collections.issues.size).toBe(3);

        s.server.refuseIssues(403);
        await advance(15_000);
        await scope.scheduler.idle();
        expect(issuesAsked()).toBe(3);
        expect(scope.collections.issues.size).toBe(3);
        expect(s.errors).toHaveLength(1);

        leave();
        s.server.refuseIssues(null);
        await advance(120_000);
        await scope.scheduler.idle();
        expect(issuesAsked()).toBe(3);
    });
});

describe('the small kinds', () => {
    it('asks none of them on a start; Runs in view pulls the runs and polls them every 10 s until it leaves', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        const paths = () => s.net.calls.map((call) => new URL(call.url).pathname);
        expect([...new Set(paths())].sort()).toEqual(['/api/approvals', '/api/issues', '/api/state', '/api/workspace']);

        const runsAsked = () => paths().filter((path) => path === '/api/runs').length;
        const leave = scope.scheduler.view(RUNS_KIND.collections);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        expect(runsAsked()).toBe(1);
        expect(scope.collections.runs.toArray.map((row) => row.runId).sort()).toEqual(['r1', 'r2']);
        s.server.change('runs', (data) => {
            data.runs.unshift(run('r3', 'running', 30));
        });
        await advance(10_000);
        await scope.scheduler.idle();
        expect(runsAsked()).toBe(2);
        expect(scope.collections.runs.size).toBe(3);

        leave();
        await advance(120_000);
        await scope.scheduler.idle();
        expect(runsAsked()).toBe(2);
        expect(s.errors).toEqual([]);
    });
});

describe('runs and their traces', () => {
    it('asks for no trace while Runs shows; a tap reads one, keeps the person’s own on disk and never someone else’s', async () => {
        const s = await setup();
        s.server.change('runs', (data) => {
            data.runs.push({ ...run('r9', 'done', 5), ownerId: 'u-ben', ownerName: 'Ben' });
        });
        const scope = await s.open();
        scope.start();
        const leave = scope.scheduler.view(RUNS_KIND.collections);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await advance(10_000);
        await scope.scheduler.idle();
        const traces = () => s.net.calls.filter((call) => new URL(call.url).pathname.endsWith('/trace'));
        const runs = scope.collections.runs.toArray;
        expect(runRows(runs, '', true, T0).map((row) => row.id)).toEqual(['r2', 'r1', 'r9']);
        // A row press reads disk only.
        await scope.runTraces.preload('r1');
        await scope.runTraces.preload('r9');
        expect(traces()).toEqual([]);

        for (const runId of ['r1', 'r9']) {
            const item = scope.runTraces.item(runId);
            const release = item.use();
            await item.refresh();
            expect(item.state.value?.runId).toBe(runId);
            release();
        }
        expect(traces().map((call) => new URL(call.url).pathname)).toEqual(
            expect.arrayContaining(['/api/runs/r1/trace', '/api/runs/r9/trace']),
        );
        await scope.runTraces.flush();
        expect(await scope.runTraces.stored('r1')).toBe(true);
        expect(await scope.runTraces.stored('r9')).toBe(false);
        leave();
        expect(s.errors).toEqual([]);
    });
});

describe('two workspace scopes', () => {
    it('never share a row, and one closing leaves the other syncing', async () => {
        const s = await setup();
        const clockB = clocks();
        const serverB = fakeWorkspaceServer(clockB);
        serverB.change('workspace', (data) => {
            data.conversations = [conversation('b1', 'B: kickoff', 1)];
            data.archived = [];
            data.spaces = [{ id: 'b-only', name: 'B only', description: '', createdAt: 1 }];
        });
        const net = wire(
            new Map([
                [ORIGIN, s.server],
                [B_ORIGIN, serverB],
            ]),
        );
        const idB = await signedIn(s.store, B_ORIGIN, serverB, clockB);
        const a = await s.open({ fetch: net.fetch });
        const b = await s.open({ fetch: net.fetch, workspaceId: idB });
        a.start();
        b.start();
        await advance(COALESCE_MS);
        await Promise.all([a.scheduler.idle(), b.scheduler.idle()]);
        expect(ids(a.collections.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        expect(ids(b.collections.conversations.toArray)).toEqual(['b1']);
        expect(ids(a.collections.spaces.toArray)).toEqual(['everyday']);
        expect(ids(b.collections.spaces.toArray)).toEqual(['b-only']);
        expect(a.collections.conversations.id).not.toBe(b.collections.conversations.id);
        // Each asked only its own origin: the shell's two, then the issues and the approvals.
        expect(net.calls.filter((call) => call.url.startsWith(B_ORIGIN))).toHaveLength(4);
        expect(net.calls.filter((call) => call.url.startsWith(ORIGIN))).toHaveLength(4);

        await a.dispose();
        expect(filesOpen(s.store, s.id)).toEqual([]);
        expect(filesOpen(s.store, idB)).toHaveLength(2);
        serverB.change('workspace', (data) => {
            data.conversations.push(conversation('b2', 'B: later', 2));
        });
        await advance(SHELL_POLL_MS);
        await b.scheduler.idle();
        expect(ids(b.collections.conversations.toArray)).toEqual(['b1', 'b2']);
        // A pulled the shell, issues and approvals, and its closing sent only its away post.
        expect(
            net.calls.filter((call) => call.url.startsWith(ORIGIN)).map((call) => new URL(call.url).pathname),
        ).toEqual(['/api/state', '/api/workspace', '/api/issues', '/api/approvals', '/api/notifications/away']);
    });
});

describe('what the scope wires together', () => {
    it('pulls the workspace source again when the server version moves, and keeps the versions and gate in the registry', async () => {
        const s = await setup();
        const scope = await s.open();
        const paths = () => s.net.calls.map((call) => [new URL(call.url).pathname, call.ifNoneMatch !== undefined]);
        // Both first pulls in flight at once, as on a real network.
        s.net.hold(true);
        scope.start();
        await advance(COALESCE_MS);
        expect(s.net.held).toBe(2);
        s.net.hold(false);
        s.net.release();
        s.net.release();
        await scope.scheduler.idle();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        expect(scope.versions.highest()).toBe('0.54.0');
        // The workspace's pull began before 0.54.0 was taken, so it ran once more, with its ETag.
        expect(paths()).toEqual([
            ['/api/state', false],
            ['/api/workspace', false],
            ['/api/workspace', true],
        ]);
        expect(scope.cache.stale(WORKSPACE_SNAPSHOT)).toBe(false);

        // A deploy, seen by the state's next answer: the workspace is pulled once, with its ETag.
        await advance(5000);
        s.server.deploy('0.55.0');
        s.net.calls.length = 0;
        scope.scheduler.poke(['state']);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        expect(scope.versions.highest()).toBe('0.55.0');
        // The issues and approvals kinds, stamped with the old version too, go once more after the
        // shell (the approvals with no If-None-Match: the path sends no ETag, `hashBody`).
        expect(paths()).toEqual([
            ['/api/state', true],
            ['/api/workspace', true],
            ['/api/issues', true],
            ['/api/approvals', false],
        ]);
        expect(scope.cache.stale(WORKSPACE_SNAPSHOT)).toBe(false);
        // Two answers in a row agree: the gate opened, and the registry has it.
        expect(scope.versions.gate()).toBe('open');
        await scope.versions.flush();
        expect(await s.store.registry.serverVersions(s.id)).toMatchObject({
            serverVersion: '0.55.0',
            lastVersion: '0.55.0',
            versionGate: 'open',
        });
    });

    it('says Reconnecting… while the server is away, keeps showing its rows, and stops once it answers', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        const handle = s.server.handle;
        let down = true;
        s.server.handle = (url, init) =>
            down ? new Response('<html>Bad gateway</html>', { status: 502 }) : handle(url, init);
        // /api/state polls first, every 5 s.
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        expect(scope.scheduler.status()).toEqual({ reconnecting: true, attempts: 1, retryAt: Date.now() + 1000 });
        expect(ids(scope.collections.conversations.toArray)).toEqual(['c0', 'c1', 'c2']);
        await advance(1000);
        await scope.scheduler.idle();
        expect(scope.scheduler.status().attempts).toBe(2);
        down = false;
        await advance(2000);
        await scope.scheduler.idle();
        expect(scope.scheduler.status()).toBe(CONNECTED);
        expect(s.errors).toEqual([]);
    });

    it('writes the cache, the versions and the last contact at once when the app goes to the background', async () => {
        const s = await setup();
        const scope = await s.open();
        const readDisk = async () => {
            const directory = workspaceLayout(s.store.root, s.id).directory;
            const key = (await s.store.keys.read(workspaceKeyName(s.id, 'cache'))) ?? '';
            const cache = await openCacheDb(s.store.driver, directory, key);
            try {
                return Object.keys(await rowsOnDisk(cache.db, CONVERSATIONS)).sort();
            } finally {
                await cache.db.close();
            }
        };
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // The first contact is written at once (contact.ts); later ones at most once a minute.
        expect((await s.store.registry.get(s.id))?.lastContact).toBe(T0);
        s.clock.server += 30_000;
        scope.scheduler.poke();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        expect(scope.contact.last()).toBe(T0 + 30_000);
        expect((await s.store.registry.get(s.id))?.lastContact).toBe(T0);
        // Still within the write queue's 500 ms: only addWorkspace's stand-in row is on disk.
        expect(await readDisk()).toEqual(['c1']);
        // No timer moves from here on, so only the trigger can write.
        s.appState.set('background');
        await turns();
        expect(await readDisk()).toEqual(['c0', 'c1', 'c2']);
        expect((await s.store.registry.get(s.id))?.lastContact).toBe(T0 + 30_000);
        expect((await s.store.registry.serverVersions(s.id))?.serverVersion).toBe('0.54.0');
        // Going offline writes at once too.
        s.server.change('workspace', (data) => {
            data.conversations.push(conversation('c7', 'Late', 7));
        });
        s.appState.set('active');
        scope.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        s.network.set(OFFLINE);
        await turns();
        expect(await readDisk()).toEqual(['c0', 'c1', 'c2', 'c7']);
    });

    it('starts the uploads that waited, then wakes the outbox, when the network comes back', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        const order: string[] = [];
        vi.spyOn(scope.attachments, 'pump').mockImplementation(() => order.push('pump'));
        vi.spyOn(scope.uploads, 'pump').mockImplementation(() => order.push('uploads'));
        vi.spyOn(scope.outbox, 'poke').mockImplementation(() => order.push('poke'));
        vi.spyOn(scope.outbox, 'wake').mockImplementation(() => order.push('wake'));
        s.network.set(OFFLINE);
        await turns();
        expect(order).toEqual([]);
        s.network.set(WIFI);
        await turns();
        // The wake ends a back-off from the offline minutes; a plain poke would leave it.
        // Both uploaders go again (a page cover's upload holds its write), then the wake.
        expect(order).toEqual(['pump', 'uploads', 'wake']);
        await scope.dispose();
    });

    it('runs a pull in flight once more when one of this device’s writes is confirmed', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await advance(0);
        await scope.scheduler.idle();
        s.net.calls.length = 0;
        const outcomes: string[] = [];
        for (const method of ['applySnapshot', 'applyNotModified'] as const) {
            const apply = scope.cache[method] as (...args: unknown[]) => PullResult;
            vi.spyOn(scope.cache, method).mockImplementation((...args: unknown[]) => {
                const result = apply(...args);
                outcomes.push(result.outcome);
                return result;
            });
        }
        s.net.hold(true);
        scope.scheduler.poke(['workspace']);
        await advance(COALESCE_MS);
        expect(s.net.held).toBe(1);
        await scope.cache.confirm({
            collection: CONVERSATIONS,
            scope: '',
            key: 'c9',
            value: conversation('c9', 'Written here', 9),
        });
        expect(scope.collections.conversations.get('c9')?.title).toBe('Written here');
        // The server has the write, so the pull in flight answers a 200, which can't vouch for it: it began before.
        s.server.change('workspace', (data) => {
            data.conversations.push(conversation('c9', 'Written here', 9));
        });
        s.net.hold(false);
        s.net.release();
        await scope.scheduler.idle();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // The 200 was no supersession, so only the confirmation ran the pull again: once, with the 200's new
        // ETag, and the server, asked after the write, vouches for it.
        expect(outcomes).toEqual(['unchanged', 'not-modified']);
        const [held, rerun] = s.net.calls;
        expect(s.net.calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/workspace', '/api/workspace']);
        expect(held?.ifNoneMatch).toMatch(/^W\//);
        expect(rerun?.ifNoneMatch).toMatch(/^W\//);
        expect(rerun?.ifNoneMatch).not.toBe(held?.ifNoneMatch);
        expect(scope.collections.conversations.get('c9')?.title).toBe('Written here');
    });
});

describe('the app’s version against the server (CB-553)', () => {
    const APP = 'Socio/0.2.7 (Android; Android 16)';

    /** The fake server behind a compat endpoint at `minimum`, refusing the app below it with a 426. */
    function compatServer(s: Awaited<ReturnType<typeof setup>>, compat: { minimum: string | null }) {
        const fetch: typeof s.net.fetch = async (url, init) => {
            const path = new URL(url).pathname;
            if (compat.minimum === null) {
                return s.net.fetch(url, init);
            }
            if (path === '/api/client/compat') {
                const numbers = { minimum: compat.minimum, recommended: compat.minimum };
                return new Response(JSON.stringify({ platforms: { ios: numbers, android: numbers } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path.startsWith('/api/') && !path.startsWith('/api/auth') && compat.minimum > '0.2.7') {
                return new Response(
                    JSON.stringify({ code: 'client_update_required', minimum: compat.minimum, platform: 'android' }),
                    { status: 426, headers: { 'Content-Type': 'application/json' } },
                );
            }
            return s.net.fetch(url, init);
        };
        return fetch;
    }

    it('closes the gate on a 426, holds the outbox, keeps the cache, and opens on the foreground once lowered', async () => {
        const s = await setup();
        const compat = { minimum: '0.2.7' as string | null };
        const scope = await s.open({ userAgent: APP, fetch: compatServer(s, compat) });
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await turns();
        expect(scope.compat.state()).toMatchObject({ required: false, minimum: '0.2.7' });
        const rows = ids(scope.collections.conversations.toArray);
        expect(rows.length).toBeGreaterThan(0);

        // The server raises its minimum: the next pull is refused, and the gate closes.
        compat.minimum = '0.2.8';
        scope.scheduler.poke(['state']);
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await turns();
        expect(scope.compat.state()).toMatchObject({ required: true, minimum: '0.2.8', version: '0.2.7' });
        expect(scope.outbox.status().heldForUpdate).toBe(true);
        // Nothing of the copy goes.
        expect(ids(scope.collections.conversations.toArray)).toEqual(rows);

        // Lowered again: the next return to the foreground reads it and opens.
        compat.minimum = '0.2.7';
        s.appState.set('background');
        await advance(15_000);
        s.appState.set('active');
        await turns();
        await advance(COALESCE_MS);
        await turns();
        expect(scope.compat.state().required).toBe(false);
        expect(scope.outbox.status().heldForUpdate).toBe(false);
    });

    it('opens a scope whose kept numbers say too old with the gate closed and the outbox held, before any answer', async () => {
        const s = await setup();
        const compat = { minimum: '0.2.8' as string | null };
        const first = await s.open({ userAgent: APP, fetch: compatServer(s, compat) });
        first.start();
        await advance(COALESCE_MS);
        await turns();
        expect(first.compat.state().required).toBe(true);
        await first.dispose();
        s.net.calls.length = 0;

        const scope = await s.open({ userAgent: APP, fetch: compatServer(s, compat) });
        expect(scope.compat.state().required).toBe(true);
        expect(scope.outbox.status().heldForUpdate).toBe(true);
        expect(s.net.calls).toEqual([]);
    });

    it('never gates a server without the endpoint (older than CB-553)', async () => {
        const s = await setup();
        const scope = await s.open({ userAgent: APP, fetch: compatServer(s, { minimum: null }) });
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await turns();
        expect(scope.compat.known()).toEqual({ kind: 'none' });
        expect(scope.compat.state().required).toBe(false);
    });
});
