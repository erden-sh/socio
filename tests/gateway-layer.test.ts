// The gateways' layer builds their sources from the other features' tags,
// registers the model's then the Git gateway's audience over them, and offers
// `Gateway` over the same gateways; `GatewayConfig` comes from the supplied
// config, not the environment; and in the server's graph, the gateways a
// platform's callers reach (`gitGateway`, `modelGateway`, `mayRunCode`) are
// `Gateway`'s.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { Actors, type ActorsShape } from '../src/server/actors/contract.js';
import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { Apps, type AppsShape } from '../src/server/apps/contract.js';
import { CodeAccess } from '../src/server/auth/contract.js';
import { GatewayExchanges, type GatewayExchangesShape } from '../src/server/coding/contract.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { gatewayConfig } from '../src/server/composition/gateway.js';
import { Data, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import { Flags, type FlagsShape } from '../src/server/flags/contract.js';
import { gatewaySourcesOf } from '../src/server/gateway/adopted.js';
import { mayRunCode } from '../src/server/gateway/code-users.js';
import { Gateway, GatewayConfig } from '../src/server/gateway/contract.js';
import { gitGateway } from '../src/server/gateway/git.js';
import { GatewayLive, GatewaySourcesTag } from '../src/server/gateway/layer.js';
import { modelGateway } from '../src/server/gateway/model.js';
import type { GatewayWorkspace } from '../src/server/gateway/sources.js';
import { gitHubClients } from '../src/server/github/api.js';
import { GitHubClients } from '../src/server/github/contract.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { Releases } from '../src/server/updates/contract.js';
import { releases } from '../src/server/updates/layer.js';

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

it('builds GatewayConfig from the supplied config only, read on every use', () => {
    vi.stubEnv('CODE_USERS', 'mallory');
    vi.stubEnv('APP_ORIGIN', 'https://env.example.invalid');
    cleanup.push(() => vi.unstubAllEnvs());
    const config = {
        codeUsers: ['alice'],
        sessionSecret: 'a-secret',
        appOrigin: 'https://app.example.invalid',
        apps: { host: 'apps.example.invalid' },
        githubAccess: { timeoutMs: 1_000 },
    } satisfies Parameters<typeof gatewayConfig>[0];
    expect(gatewayConfig(config)).toEqual({
        codeUsers: ['alice'],
        sessionSecret: 'a-secret',
        appOrigin: 'https://app.example.invalid',
        appsHost: 'apps.example.invalid',
        githubAccess: { timeoutMs: 1_000 },
    });
    // Read from the supplied config on every use, as `platform.config` was.
    const live = gatewayConfig(config);
    (config as { codeUsers?: readonly string[] }).codeUsers = ['carol'];
    expect(live.codeUsers).toEqual(['carol']);
    expect(gatewayConfig({} as PlatformConfig)).toEqual({
        codeUsers: [],
        sessionSecret: undefined,
        appOrigin: undefined,
        appsHost: undefined,
        githubAccess: undefined,
    });
});

it('registers the model then the Git audience over sources from the tags, and serves Gateway over them', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const registered: string[] = [];
    const actors = {
        audiences: { register: (audience: string) => void registered.push(audience) },
        audit: {},
    } as unknown as ActorsShape;
    const approvals = { register: vi.fn(), request: vi.fn() } as unknown as ApprovalsShape;
    // Who has `code:run` (CB-376), as the provider answers on every check.
    let permitted: string[] = ['alice'];
    const workspace = {
        db,
        users: () => [],
        hasUser: () => true,
        dot: () => undefined,
        canUseDot: () => false,
        thread: () => undefined,
        telegram: { threadInfo: async () => undefined },
    } as unknown as GatewayWorkspace;
    const layer = GatewayLive({
        workspace,
        runtime: { attach: () => ({}) as never },
        github: { inForce: async () => ({}) },
    }).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(Actors, actors),
                Layer.succeed(Approvals, approvals),
                Layer.succeed(Apps, {} as AppsShape),
                Layer.succeed(Data, {} as DataSpaceShape),
                Layer.succeed(Flags, { enabled: () => false } as unknown as FlagsShape),
                Layer.succeed(Inference, {} as InferenceShape),
                Layer.succeed(GitHubClients, gitHubClients),
                Layer.succeed(CodeAccess, { mayRunCode: async (id: string) => permitted.includes(id) }),
                Layer.succeed(GatewayExchanges, {} as GatewayExchangesShape),
                Layer.succeed(Releases, releases),
                Layer.succeed(GatewayConfig, gatewayConfig({ codeUsers: ['alice', 'carol'] })),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(registered).toEqual(['gateway:model', 'gateway:git']);
    // The Git gateway's extraction cards, registered as it was built.
    expect(vi.mocked(approvals.register).mock.calls.map(([kind]) => kind.capability)).toEqual([
        'repo_extract',
        'repo_extract_standing',
    ]);
    const sources = Context.get(context, GatewaySourcesTag);
    expect(sources.actors).toBe(actors);
    expect(sources.workspace).toBe(workspace);
    const gateway = Context.get(context, Gateway);
    // The `code:run` permission, read on every use; CODE_USERS (alice, carol) plays no part.
    const may = (ids: string[]) => Promise.all(ids.map((id) => gateway.mayRunCode(id)));
    expect(await may(['alice', 'bob', 'carol'])).toEqual([true, false, false]);
    permitted = ['bob'];
    expect(await may(['alice', 'bob'])).toEqual([false, true]);
    expect(await gateway.git.mayUseCode('bob')).toBe(true);
});

it('in the server’s graph, a platform’s gateways are Gateway’s', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const config = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'gateway-layer-secret-0123456789ab',
        codeUsers: ['alice'],
        appOrigin: 'https://app.example.invalid',
    };
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth({ codeRunners: ['alice'] }),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const context = await runtime.context();
    const gateway = Context.get(context, Gateway);
    expect(gateway.git).toBe(gitGateway(platform));
    expect(gateway.model).toBe(modelGateway(platform));
    expect(Context.get(context, GatewayConfig)).toEqual(gatewayConfig(config as PlatformConfig));
    const sources = gatewaySourcesOf(platform);
    expect(sources.actors).toBe(platform.actors);
    expect(sources.flags).toBe(platform.flags);
    expect(sources.workspace).toBe(workspace);
    expect(
        await Promise.all([mayRunCode(platform, 'alice'), gateway.mayRunCode('alice'), gateway.mayRunCode('bob')]),
    ).toEqual([true, true, false]);
});
