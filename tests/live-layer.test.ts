// `Counters` is the live layer over the workspace's change counters. Built, it
// installs the change triggers of the tables made since the store opened
// (`sync`, once), as the last step of `Platform`'s construction did; in the
// server's graph the tag holds the workspace's own counters.
import { Context, Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LegacyWorkspace } from '../src/server/composition/base.js';
import { liveLayers } from '../src/server/composition/live.js';
import { Counters, type CountersShape } from '../src/server/live/contract.js';
import { CountersLive } from '../src/server/live/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const readCounters = Effect.gen(function* () {
    return yield* Counters;
});

it('offers the counters it is given, synced once as it is built', async () => {
    const counters: CountersShape = { read: vi.fn(() => 'settings=1'), sync: vi.fn(() => 0) };
    const layer = CountersLive(counters);
    expect(counters.sync).not.toHaveBeenCalled();

    const offered = await Effect.runPromise(readCounters.pipe(Effect.provide(layer)));
    expect(offered).toBe(counters);
    expect(counters.sync).toHaveBeenCalledTimes(1);
    expect(offered.read(['settings'])).toBe('settings=1');
});

it('composition’s step offers the workspace’s own counters, synced once', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const sync = vi.spyOn(workspace.counters, 'sync');

    const offered = await Effect.runPromise(
        readCounters.pipe(Effect.provide(liveLayers.counters), Effect.provideService(LegacyWorkspace, workspace)),
    );
    expect(offered).toBe(workspace.counters);
    expect(sync).toHaveBeenCalledTimes(1);
});

it('in the server’s graph, the tag holds the workspace’s counters', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config: { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '' },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const counters = Context.get(await runtime.context(), Counters);
    expect(counters).toBe(workspace.counters);

    const before = counters.read(['settings']);
    await store.updateSettings({ name: 'Brain' });
    expect(counters.read(['settings'])).not.toBe(before);
});
