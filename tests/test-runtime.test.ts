// `makeTestRuntime` builds the server's graph and runtime for tests over the
// database it is given, binds apps to it, takes fakes over its services, and
// leaves nothing open when disposed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { OtlpExporter } from '@socio/foundation/observability/otel-export';
import type { User } from '@socio/shared/types';

import { LegacyStore } from '../src/server/composition/base.js';
import { boundAppRuntime } from '../src/server/composition/http/handle.js';
import { Flags, type FlagsShape } from '../src/server/flags/contract.js';

import { staticAuth } from './fixtures/static-auth.js';
import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime, TestPlatform } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

it('builds the server’s platform over one connection, with the config and runner it is given', async () => {
    const runner = new LocalAgentRunner(testDatabase());
    const t = await makeTestRuntime({ config: { baseUrl: 'https://model.invalid/v1', model: 'm' }, runner });
    cleanup.push(t.dispose);
    expect(t.platform).toBeInstanceOf(TestPlatform);
    expect(Context.get(await t.runtime.context(), LegacyStore)).toBe(t.platform.store);
    expect(t.platform.store).toBe(t.store);
    expect(t.platform.workspace).toBe(t.workspace);
    expect(t.workspace.db).toBe(t.db);
    expect(t.platform.config).toMatchObject({ baseUrl: 'https://model.invalid/v1', model: 'm', voiceName: 'marin' });
    expect(t.platform.runner).toBe(runner);
    expect('app' in t).toBe(false);
});

it('binds the app to the runtime, so routes run through handle()', async () => {
    const t = await makeTestRuntime({ app: { auth: staticAuth(bob) } });
    cleanup.push(t.dispose);
    expect(boundAppRuntime(t.app)).toBe(t.runtime);
    const dot = t.workspace.dots()[0]!;
    // The web routes are Effects (appHandle): without a runtime they answer 500.
    const response = await t.app.request(`/api/dots/${dot.id}/web`);
    expect(response.status).toBe(200);
});

it('offers the fakes it is given in place of the graph’s services', async () => {
    const fake = { forUser: () => ({}) } as unknown as FlagsShape;
    const t = await makeTestRuntime({ layers: Layer.succeed(Flags, fake) });
    cleanup.push(t.dispose);
    const context = await t.runtime.context();
    expect(Context.get(context, Flags)).toBe(fake);
    expect(t.platform.flags).not.toBe(fake);
});

/** How many of each kind of timer and handle the process holds. */
const open = () => {
    const counts: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) {
        counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
};
const isOpen = (runner: LocalAgentRunner) => (runner as unknown as { db: { isOpen: boolean } }).db.isOpen;

it('closes its connections and leaves no timers or handles behind', async () => {
    // A first runtime starts what lives for the process (the shared replay worker).
    await (await makeTestRuntime({ app: { auth: staticAuth(bob) } })).dispose();
    const before = open();
    const t = await makeTestRuntime({ app: { auth: staticAuth(bob) } });
    const runner = t.platform.runner;
    await t.dispose();
    await t.dispose();
    expect(t.db.isOpen).toBe(false);
    expect(isOpen(runner)).toBe(false);
    for (const [kind, count] of Object.entries(open())) {
        expect([kind, count]).toEqual([kind, Math.min(count, before[kind] ?? 0)]);
    }
});

it('closes the stores and connections even when a fake’s finalizer fails', async () => {
    const fake = { forUser: () => ({}) } as unknown as FlagsShape;
    const failing = Layer.effect(
        Flags,
        Effect.as(
            Effect.addFinalizer(() => Effect.die(new Error('finalizer failed'))),
            fake,
        ),
    );
    const t = await makeTestRuntime({ layers: failing });
    const runner = t.platform.runner;
    await expect(t.dispose()).rejects.toThrow('finalizer failed');
    expect(t.db.isOpen).toBe(false);
    expect(isOpen(runner)).toBe(false);
    // Disposing again finds everything closed and repeats nothing.
    await expect(t.dispose()).rejects.toThrow('finalizer failed');
});

it('leaves nothing open when the app fails to build', async () => {
    await (await makeTestRuntime()).dispose();
    const before = open();
    const runner = new LocalAgentRunner(testDatabase());
    const auth = staticAuth(bob);
    auth.provider.routes = () => {
        throw new Error('routes failed');
    };
    await expect(makeTestRuntime({ runner, app: { auth } })).rejects.toThrow('routes failed');
    expect(isOpen(runner)).toBe(false);
    for (const [kind, count] of Object.entries(open())) {
        expect([kind, count]).toEqual([kind, Math.min(count, before[kind] ?? 0)]);
    }
});

it('stops the server’s platform and leaves nothing open when a fake fails to build', async () => {
    await (await makeTestRuntime()).dispose();
    const before = open();
    const stop = vi.spyOn(TestPlatform.prototype, 'stop');
    const runner = new LocalAgentRunner(testDatabase());
    const failing = Layer.effect(Flags, Effect.die(new Error('fake failed')));
    await expect(makeTestRuntime({ runner, layers: failing })).rejects.toThrow('fake failed');
    // The graph under the fake was built, so its platform was stopped.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isOpen(runner)).toBe(false);
    for (const [kind, count] of Object.entries(open())) {
        expect([kind, count]).toEqual([kind, Math.min(count, before[kind] ?? 0)]);
    }
});

/** A fake `Flags` whose finalizer records that it ran, and fails when `fail` is set. */
function finalized(fail: boolean) {
    const ran = { finalizer: false };
    const layer = Layer.effect(
        Flags,
        Effect.as(
            Effect.addFinalizer(() =>
                Effect.suspend(() => {
                    ran.finalizer = true;
                    return fail ? Effect.die(new Error('finalizer failed')) : Effect.void;
                }),
            ),
            { forUser: () => ({}) } as unknown as FlagsShape,
        ),
    );
    return { ran, layer };
}

it('runs every cleanup step when several fail, and rethrows the first failure', async () => {
    const { ran, layer } = finalized(true);
    const t = await makeTestRuntime({ layers: layer });
    const runner = t.platform.runner;
    vi.spyOn(t.platform, 'stop').mockRejectedValue(new Error('stop failed'));
    await expect(t.dispose()).rejects.toThrow('stop failed');
    expect(ran.finalizer).toBe(true);
    expect(isOpen(runner)).toBe(false);
    expect(t.db.isOpen).toBe(false);
});

it('runs the steps after one that throws in the middle', async () => {
    const { ran, layer } = finalized(false);
    const t = await makeTestRuntime({ layers: layer });
    vi.spyOn(t.store, 'close').mockImplementation(() => {
        throw new Error('store close failed');
    });
    await expect(t.dispose()).rejects.toThrow('store close failed');
    expect(ran.finalizer).toBe(true);
    expect(t.db.isOpen).toBe(false);
});

it('shuts the trace exporter down when the graph fails while it is built', async () => {
    const shutdown = vi.spyOn(OtlpExporter.prototype, 'shutdown');
    const stop = vi.spyOn(TestPlatform.prototype, 'stop');
    const runner = new LocalAgentRunner(testDatabase());
    // The runner refuses only the trace listener (`sendTurnTraces`), which
    // is registered after the exporter and its timer are made.
    const onRunFinished = runner.onRunFinished.bind(runner);
    vi.spyOn(runner, 'onRunFinished').mockImplementation((listener) => {
        if (new Error().stack?.includes('sendTurnTraces')) {
            throw new Error('listener refused');
        }
        return onRunFinished(listener);
    });
    await expect(
        makeTestRuntime({
            runner,
            // Never sent to: nothing is exported before the build fails.
            config: { otlp: { url: 'http://127.0.0.1:9/v1/traces', headers: {}, serviceName: 'test' } },
        }),
    ).rejects.toThrow('listener refused');
    // The platform was never built, so only the layer's finalizer stopped the exporter.
    expect(stop).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(isOpen(runner)).toBe(false);
});

/** A scratch directory, removed when the test ends. */
function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-test-runtime-'));
    cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

it('restarts over a file database: the data stays, and each runtime closes its own connection', async () => {
    const path = join(scratch(), 'app.sqlite');
    const first = await makeTestRuntime({ database: path });
    cleanup.push(first.dispose);
    first.workspace.recordUser(bob);
    const space = first.workspace.spaces()[0]!;
    const page = await first.workspace.pages.create(space.id, { title: 'Kept across restarts', content: 'x' });
    expect(first.store).toBe(first.platform.store);
    expect(first.store.connection).toBe(first.db);
    await first.dispose();
    expect(first.db.isOpen).toBe(false);

    const second = await makeTestRuntime({ database: path });
    cleanup.push(second.dispose);
    expect(second.db === first.db).toBe(false);
    expect(second.workspace.users().map((user) => user.id)).toContain('bob');
    expect(second.workspace.pages.get(space.id, page.id).title).toBe('Kept across restarts');
    await second.dispose();
    expect(second.db.isOpen).toBe(false);
    // Something else that opens the file by its path (Better Auth, the backup CLI) sees the same data.
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
        expect(reader.prepare('SELECT id FROM users WHERE id = ?').get('bob')).toEqual({ id: 'bob' });
    } finally {
        reader.close();
    }
});

it('leaves a connection the caller owns open after dispose, so a restart reuses it', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const first = await makeTestRuntime({ database: db });
    expect(first.db).toBe(db);
    expect(first.store.connection).toBe(db);
    expect(first.workspace.db).toBe(db);
    first.workspace.recordUser(bob);
    await first.dispose();
    expect(db.isOpen).toBe(true);
    const second = await makeTestRuntime({ database: db });
    cleanup.push(second.dispose);
    expect(second.workspace.users().map((user) => user.id)).toContain('bob');
    await second.dispose();
    expect(db.isOpen).toBe(true);
});

it('gives the store and the workspace a connection each: closing the store leaves the workspace writing', async () => {
    const dir = scratch();
    const t = await makeTestRuntime({
        database: { store: join(dir, 'store.sqlite'), workspace: join(dir, 'workspace.sqlite') },
    });
    cleanup.push(t.dispose);
    expect(t.store.connection).not.toBe(t.workspace.db);
    expect(t.db).toBe(t.workspace.db);
    t.store.close();
    expect(t.store.connection.isOpen).toBe(false);
    t.workspace.recordUser(bob);
    expect(t.workspace.users().map((user) => user.id)).toContain('bob');
    await t.dispose();
    // A path is the store's own: its close closed it, and dispose closes the workspace's.
    expect(t.db.isOpen).toBe(false);
});

it('leaves separate connections the caller owns open', async () => {
    const storeDb = testDatabase();
    const workspaceDb = testDatabase();
    cleanup.push(
        () => storeDb.close(),
        () => workspaceDb.close(),
    );
    const t = await makeTestRuntime({ database: { store: storeDb, workspace: workspaceDb } });
    expect(t.store.connection).toBe(storeDb);
    expect(t.db).toBe(workspaceDb);
    await t.dispose();
    expect(storeDb.isOpen).toBe(true);
    expect(workspaceDb.isOpen).toBe(true);
});

it('closes what it opened when the database fails part way', async () => {
    const dir = scratch();
    const close = vi.spyOn(Store.prototype, 'close');
    const runner = new LocalAgentRunner(testDatabase());
    // A file where the workspace's folder should be.
    writeFileSync(join(dir, 'file'), '');
    await expect(
        makeTestRuntime({
            runner,
            database: { store: join(dir, 'store.sqlite'), workspace: join(dir, 'file', 'workspace.sqlite') },
        }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect((close.mock.contexts[0] as Store).connection.isOpen).toBe(false);
    expect(isOpen(runner)).toBe(false);
});

it('closes a connection it opened when a store fails to build over it', async () => {
    const dir = scratch();
    // An SQLite file without the app's tables: the workspace opens it, then fails.
    const empty = join(dir, 'workspace.sqlite');
    new DatabaseSync(empty).close();
    const touched = new Set<DatabaseSync>();
    for (const method of ['prepare', 'exec'] as const) {
        const original = DatabaseSync.prototype[method] as (...args: unknown[]) => unknown;
        vi.spyOn(DatabaseSync.prototype, method).mockImplementation(function (this: DatabaseSync, ...args: unknown[]) {
            touched.add(this);
            return original.apply(this, args);
        } as never);
    }
    const runner = new LocalAgentRunner(testDatabase());
    touched.clear();
    await expect(
        makeTestRuntime({ runner, database: { store: join(dir, 'store.sqlite'), workspace: empty } }),
    ).rejects.toThrow();
    // The store's connection and the workspace's, which it opened before failing.
    expect(touched.size).toBeGreaterThanOrEqual(2);
    for (const db of touched) {
        expect(db.isOpen).toBe(false);
    }
    expect(isOpen(runner)).toBe(false);
});

it.each([
    ['one connection', (path: string) => path],
    ['a connection each', (path: string) => ({ store: path, workspace: path })],
] as const)('closes the connection when its pragmas fail on a file that isn’t a database (%s)', async (_, database) => {
    const path = join(scratch(), 'not-a-database.sqlite');
    // SQLite opens it, then the first pragma reads it and fails.
    writeFileSync(path, 'not a database, just text that is long enough to fill a header '.repeat(4));
    // The connections whose pragma failed: the file's.
    const failed = new Set<DatabaseSync>();
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        try {
            return exec.call(this, sql);
        } catch (error) {
            failed.add(this);
            throw error;
        }
    });
    const runner = new LocalAgentRunner(testDatabase());
    await expect(makeTestRuntime({ runner, database: database(path) })).rejects.toThrow(/not a database/);
    expect(failed.size).toBe(1);
    expect([...failed][0]!.isOpen).toBe(false);
    expect(isOpen(runner)).toBe(false);
});

it('makes more apps over the runtime, with its auth, and a research runner made over the store', async () => {
    const auth = staticAuth(bob);
    const t = await makeTestRuntime({ auth });
    cleanup.push(t.dispose);
    const made: Store[] = [];
    const runner = (store: Store) => {
        made.push(store);
        return new Runner(store, { mode: 'live', baseUrl: '' });
    };
    const one = t.makeApp({ runner });
    const two = t.makeApp();
    expect(made).toEqual([t.store]);
    for (const app of [one, two]) {
        expect(boundAppRuntime(app)).toBe(t.runtime);
        // Bob, by the runtime's auth.
        const response = await app.request(`/api/dots/${t.workspace.dots()[0]!.id}/web`);
        expect(response.status).toBe(200);
    }
    // The same factory for `options.app`.
    const withApp = await makeTestRuntime({ app: { auth, runner } });
    cleanup.push(withApp.dispose);
    expect(made).toEqual([t.store, withApp.store]);
});

it('runs beforeApp once the runtime is built and before the app mounts its routes', async () => {
    const order: string[] = [];
    const auth = staticAuth(bob);
    const routes = auth.provider.routes.bind(auth.provider);
    auth.provider.routes = (app) => {
        order.push('routes');
        return routes(app);
    };
    const t = await makeTestRuntime({
        app: { auth },
        beforeApp: async (runtime) => {
            expect(Context.get(await runtime.runtime.context(), LegacyStore)).toBe(runtime.platform.store);
            order.push('beforeApp');
        },
    });
    cleanup.push(t.dispose);
    expect(order).toEqual(['beforeApp', 'routes']);
});

it('leaves nothing open when beforeApp fails', async () => {
    await (await makeTestRuntime()).dispose();
    const before = open();
    const stop = vi.spyOn(TestPlatform.prototype, 'stop');
    const runner = new LocalAgentRunner(testDatabase());
    let db: DatabaseSync | undefined;
    await expect(
        makeTestRuntime({
            runner,
            beforeApp: (t) => {
                db = t.db;
                throw new Error('hook failed');
            },
        }),
    ).rejects.toThrow('hook failed');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(db?.isOpen).toBe(false);
    expect(isOpen(runner)).toBe(false);
    for (const [kind, count] of Object.entries(open())) {
        expect([kind, count]).toEqual([kind, Math.min(count, before[kind] ?? 0)]);
    }
});
