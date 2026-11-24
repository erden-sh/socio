// Web's tags are implemented by its layer (`web/layer.ts`) over `WebDatabase`
// and `WebConfig`. `WebReader`, `WebCapabilities` and `WebIdentities` reach
// the connection's one reader (`WebConfig.readerOn`, the composition's
// `webReadsFor`) at each call, so rate limits, the cache and host stops stay
// shared with the callers that don't read the tag yet, and the reader is still
// made by its first user. The server's graph builds `WebConfig` from the
// supplied startup config, never the environment again. The pages read the
// features' views from the app runtime (`pageViewsOf`).
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { brandingInForce } from '@socio/foundation/settings/branding';
import type { User } from '@socio/shared/types';

import { AuthViews } from '../src/server/auth/contract.js';
import { signInView } from '../src/server/auth/sign-in-view.js';
import { pageViewsOf } from '../src/server/composition/http/web.js';
import { webReadsFor } from '../src/server/composition/web.js';
import { IssuesViews } from '../src/server/issues/contract.js';
import { Releases } from '../src/server/updates/contract.js';
import { releaseData } from '../src/server/updates/releases.js';
import { WebCapabilities, WebConfig, WebIdentities, WebReader } from '../src/server/web/contract.js';
import { WebDatabase, WebLive } from '../src/server/web/layer.js';
import { userServices } from '../src/server/web/services.js';
import { webSettingsFromEnv } from '../src/server/web/web-reads.js';
import { WorkspaceViews } from '../src/server/workspace/contract.js';

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
    vi.unstubAllEnvs();
});

const settings = webSettingsFromEnv({ APP_ORIGIN: 'https://brain.example.com', WEB_HOST_RATE_PER_MINUTE: '7' });

it('offers the connection’s one reader, its capability and the identity setting', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const dot = workspace.dots()[0];
    const runtime = ManagedRuntime.make(
        WebLive.pipe(
            Layer.provide(Layer.succeed(WebDatabase, workspace.db)),
            Layer.provide(Layer.succeed(WebConfig, { web: settings, readerOn: (db) => webReadsFor(db, settings) })),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    const reader = Context.get(context, WebReader);
    // Building the layer made no reader: its first user does, with its settings.
    const own = webReadsFor(workspace.db, settings);
    expect(await reader.status(dot.id, false)).toEqual(await own.status(dot.id, false));
    expect((await reader.status(dot.id, false)).limits.perHostPerMinute).toBe(7);
    expect(await reader.identity(dot.id)).toBe('agent');

    await Context.get(context, WebIdentities).setIdentity(dot.id, 'browser', 'alice');
    // The same store: the reader, the connection's reader and the capability see it.
    expect(await reader.identity(dot.id)).toBe('browser');
    expect(await own.identity(dot.id)).toBe('browser');
    expect(await Context.get(context, WebCapabilities).capabilityFor(dot.id)).toMatchObject({
        id: 'web_reads',
        identity: 'browser',
        available: false,
        tools: [],
    });
    expect((await reader.status(dot.id, true)).audit?.[0]).toMatchObject({
        userId: 'alice',
        outcome: 'identity:browser',
    });
    expect(await reader.activity(dot.id, Date.now() + 1, 10)).toHaveLength(1);
});

it('builds WebConfig from the supplied config in the server’s graph, not the environment', async () => {
    vi.stubEnv('WEB_HOST_RATE_PER_MINUTE', '99');
    const db = testDatabase();
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config: { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '', web: settings },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [],
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    expect(await runtime.runPromise(WebConfig.use((config) => Effect.succeed(config.web)))).toBe(settings);
    const dot = workspace.dots()[0];
    const status = await runtime.runPromise(
        WebReader.use((reader) => Effect.promise(() => reader.status(dot.id, false))),
    );
    expect(status.limits.perHostPerMinute).toBe(7);
    // The graph's reader is the connection's: the platform's callers share it.
    expect(status).toEqual(await webReadsFor(db).status(dot.id, false));
});

it('gives the pages the views the app runtime built: each feature’s tag and the build’s releases', async () => {
    const db = testDatabase();
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config: { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '', web: settings },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        log: () => {},
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const context = await runtime.context();
    const views = pageViewsOf(context);
    expect(views.workspace).toBe(Context.get(context, WorkspaceViews));
    expect(views.issues).toBe(Context.get(context, IssuesViews));
    expect(views.auth).toBe(Context.get(context, AuthViews));
    expect(views.releases).toBe(Context.get(context, Releases));
    const user: User = { id: 'alice', name: 'Alice', role: 'admin' };
    workspace.recordUser(user);
    const services = userServices(
        { store, config: { mode: 'sample', baseUrl: '' }, platform, views, auth: testAuth() },
        async () => user,
    );
    expect(await services.workspace()).toEqual(await views.workspace.workspaceView(user));
    expect((await services.state()).version).toBe(releaseData().version);
    expect(await services.signIn()).toEqual(
        signInView(testAuth().provider, brandingInForce(store.settings().branding)),
    );
});
