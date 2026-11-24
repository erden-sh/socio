// The mini app registry is built by its layer from the tags it reads (the
// workspace's slices, spaces' `Access`, the computers' records and
// screenshots, the approvals, the data space, socio access, the workspace
// settings, `AppsConfig`, `AppsBoot`) and offered as `Apps`. The server's
// graph builds it there, with `AppsConfig` from the supplied startup config,
// and `Platform` holds the same object.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';

import { ActorsConfig, AppActors } from '../src/server/actors/contract.js';
import { Approvals } from '../src/server/approvals/contract.js';
import { Apps, AppsConfig, type AppsConfigShape } from '../src/server/apps/contract.js';
import { AppsBoot, AppsLive } from '../src/server/apps/layer.js';
import { appsConfig, LegacyApps } from '../src/server/composition/apps.js';
import { screenshotResult } from '../src/server/computers/computer-tools.js';
import { ComputerRecords, Screenshots } from '../src/server/computers/contract.js';
import { Data } from '../src/server/dataspace/contract.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import { Access } from '../src/server/spaces/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

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
    vi.unstubAllEnvs();
});

function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    return store;
}

const ORIGIN = 'https://app.example.invalid';

/** The apps layer over a workspace, with fake approvals, data space and socio access. */
function appsRuntime(ws: WorkspaceStore, config: AppsConfigShape) {
    const calls: string[] = [];
    const deps = Layer.mergeAll(
        WorkspaceLive(ws),
        Layer.succeed(Access, ws.spaceAccess),
        Layer.succeed(ComputerRecords, ws.computers),
        Layer.succeed(Screenshots, Screenshots.of({ result: screenshotResult })),
        Layer.succeed(Approvals, {
            register: (handler: { capability: string }) => calls.push(`approval ${handler.capability}`),
        } as never),
        Layer.succeed(Data, {
            useAppGrants: () => calls.push('data grants'),
            useAppDelegation: () => calls.push('data delegation'),
        } as never),
        Layer.succeed(AppActors, {
            audiences: { register: (key: string) => calls.push(`audience ${key}`) },
        } as never),
        Layer.succeed(ActorsConfig, { secret: 'instance-secret' }),
        Layer.succeed(WorkspaceSettings, { settings: () => ({ appLogs: { days: 3 } }) } as never),
        Layer.succeed(AppsConfig, config),
        Layer.succeed(AppsBoot, {
            db: ws.db,
            computers: () => {
                throw new Error('No computers here.');
            },
        }),
    );
    const runtime = ManagedRuntime.make(AppsLive.pipe(Layer.provide(deps)));
    cleanup.push(() => runtime.dispose());
    return { runtime, calls };
}

it('builds the registry from its tags: off without settings, registering nothing', async () => {
    const ws = workspace();
    const { runtime, calls } = appsRuntime(ws, {});
    const apps = Context.get(await runtime.context(), Apps);
    expect(apps.enabled).toBe(false);
    expect(apps.all()).toEqual([]);
    // The data space's side of socio access is always registered; the
    // approval and the `app` audience only where apps are served.
    expect(calls).toEqual(['data grants', 'data delegation']);
});

it('builds the registry from its tags: on with settings, with the approval and the app audience', async () => {
    const ws = workspace();
    const settings = appsSettingsFromEnv({}, ORIGIN)!;
    const { runtime, calls } = appsRuntime(ws, { apps: settings });
    const apps = Context.get(await runtime.context(), Apps);
    expect(apps.enabled).toBe(true);
    expect(apps.url({ id: 'abc' })).toBe(`https://${settings.labelPrefix}abc.${settings.host}`);
    expect(calls).toEqual([
        'approval app.register',
        'approval app.promote',
        'approval app.update',
        'data grants',
        'audience app',
        'data delegation',
    ]);
});

it("reads the workspace through the slices: the launcher names each app's socio and the Space it is shared with", async () => {
    const ws = workspace();
    for (const id of ['alice', 'bob', 'carol']) {
        ws.recordUser({ id, name: id, role: 'member' });
    }
    const dot = ws.dots()[0]!;
    const open = ws.createSpace('Team', 'Everyone reads it.');
    const closed = await ws.createSpaceFor('alice', {
        name: 'Deals',
        description: 'Alice and Bob only.',
        private: true,
        people: [{ userId: 'bob', role: 'member' }],
    });
    const now = Date.now();
    const insert = ws.db.prepare(
        "INSERT INTO apps(id,slug,name,description,dotId,ownerUserId,port,datasets,public,status,config,createdAt,updatedAt,liveVersion,sharedSpaceId) VALUES (?,?,?,'',?,'alice',3001,'[]',0,'promoted','{}',?,?,1,?)",
    );
    insert.run('mine', 'mine', 'Mine', dot.id, now, now, null);
    insert.run('team', 'team', 'Team board', dot.id, now + 1, now + 1, open.id);
    insert.run('deals', 'deals', 'Deals board', dot.id, now + 2, now + 2, closed.id);
    insert.run('orphan', 'orphan', 'Orphan', 'no-such-socio', now + 3, now + 3, open.id);
    const { runtime } = appsRuntime(ws, { apps: appsSettingsFromEnv({}, ORIGIN)! });
    const apps = Context.get(await runtime.context(), Apps);
    const launcher = (userId: string) =>
        apps.promotions
            .launcherFor(userId)
            .map(({ id, dotName, sharedSpaceName, owner }) => ({ id, dotName, sharedSpaceName, owner }));

    // The owner sees all four; the socio's name comes from `Socios`.
    expect(launcher('alice')).toEqual([
        { id: 'mine', dotName: dot.name, sharedSpaceName: null, owner: true },
        { id: 'team', dotName: dot.name, sharedSpaceName: 'Team', owner: true },
        { id: 'deals', dotName: dot.name, sharedSpaceName: 'Deals', owner: true },
        { id: 'orphan', dotName: 'A deleted socio', sharedSpaceName: 'Team', owner: true },
    ]);
    // A member of the private Space sees what is shared with both Spaces.
    expect(launcher('bob')).toEqual([
        { id: 'team', dotName: dot.name, sharedSpaceName: 'Team', owner: false },
        { id: 'deals', dotName: dot.name, sharedSpaceName: 'Deals', owner: false },
        { id: 'orphan', dotName: 'A deleted socio', sharedSpaceName: 'Team', owner: false },
    ]);
    // Someone outside it sees only the open Space's apps (`Access.canRead`).
    expect(launcher('carol')).toEqual([
        { id: 'team', dotName: dot.name, sharedSpaceName: 'Team', owner: false },
        { id: 'orphan', dotName: 'A deleted socio', sharedSpaceName: 'Team', owner: false },
    ]);
});

it("the server's graph builds the apps from their layer: Platform, Apps and LegacyApps share the registry", async () => {
    // The supplied config wins over the environment (moving environment parsing here is a later change).
    vi.stubEnv('APPS_HOST', 'off');
    const ws = workspace();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        appOrigin: ORIGIN,
        apps: appsSettingsFromEnv({}, ORIGIN),
        appLogs: { days: 5 },
        sessionSecret: 'supplied-session-secret-0123456789',
    };
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        modules: [],
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const read = await runtime.runPromise(
        Effect.gen(function* () {
            return {
                apps: yield* Apps,
                legacy: yield* LegacyApps,
                config: yield* AppsConfig,
            };
        }),
    );
    expect(read.apps).toBe(platform.apps);
    expect(read.legacy).toBe(platform.apps);
    expect(read.config).toEqual(appsConfig(config as never));
    expect(read.config.apps?.host).toBe('apps.app.example.invalid');
    expect(read.config.sessionSecret).toBe('supplied-session-secret-0123456789');
    expect(platform.apps.enabled).toBe(true);
    expect(platform.apps.screenshots.result).toBe(screenshotResult);
});
