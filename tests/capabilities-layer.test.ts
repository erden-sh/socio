// The capabilities registry is built by its layer from the tags it reads
// (`WorkspaceSettings`, `Access`, `Conversations`, `ComputerRecords`, its
// sections' ports `CapabilityIdentity` and `CapabilityRequests`,
// `CapabilitiesConfig`), the core ones then each module's; the server's graph
// builds it there, with `CapabilitiesConfig` from the supplied startup config,
// and `Platform` holds the same object.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import {
    Capabilities,
    CapabilitiesConfig,
    CapabilityIdentity,
    CapabilityRequests,
    type CapabilityDefinition,
} from '../src/server/capabilities/contract.js';
import { CapabilitiesLive } from '../src/server/capabilities/layer.js';
import { LegacyCapabilities } from '../src/server/composition/capabilities.js';
import { ComputerRecords } from '../src/server/computers/contract.js';
import type { ServerModule } from '../src/server/modules/contract.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import { Access } from '../src/server/spaces/contract.js';
import { Conversations } from '../src/server/workspace/contract.js';

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

const turn = {
    dot: { id: 'd1', name: 'Dot', spaceId: 's1', researchAllowed: true, memoryAllowed: true },
    threadId: 't1',
    userId: 'u1',
} as unknown as DotTurn;

/** One tool of each core capability, so only its status decides whether it is on. */
const TOOLS = ['read_space_page', 'computer_navigate', 'search_web', 'propose_memory'];

const extra: CapabilityDefinition = { id: 'extra', label: 'Extra', description: 'A module capability.' };

/** Every tag the layer reads, as stubs that record what they are asked. */
function stubs({ memoryAllowed = false, webSearchProvider = 'disabled' as 'disabled' | 'parallel' } = {}) {
    const asked: string[] = [];
    const layer = Layer.mergeAll(
        Layer.succeed(WorkspaceSettings, {
            settings: () => ({ researchAllowed: true, memoryAllowed }),
        } as never),
        Layer.succeed(Access, {
            readable: (reader: unknown) => {
                asked.push(`readable ${JSON.stringify(reader)}`);
                return [{ id: 's1', name: 'Home' }];
            },
        } as never),
        Layer.succeed(Conversations, {
            socioReader: (threadId: string, dotId?: string) => {
                asked.push(`socioReader ${threadId} ${dotId}`);
                return { dotId, people: ['u1'] };
            },
        } as never),
        Layer.succeed(ComputerRecords, {
            permissions: async (id: string) => {
                asked.push(`permissions ${id}`);
                return { enabled: true };
            },
        } as never),
        Layer.succeed(CapabilityIdentity, { capabilityFor: async (dotId) => ({ web: dotId }) }),
        Layer.succeed(CapabilityRequests, {
            pendingRequestsFor: async () => ['pending'],
            resolvedRequestsFor: async () => ['resolved'],
        }),
        Layer.succeed(CapabilitiesConfig, {
            computerSupervisorUrl: 'http://supervisor.invalid',
            computerSupervisorToken: 'x',
            computerToken: 'y',
            webSearchProvider,
        }),
    );
    return { asked, layer };
}

it('builds the registry from the tags it reads: the core capabilities, then the modules', async () => {
    const { asked, layer } = stubs();
    const hook = vi.fn(() => [extra]);
    const runtime = ManagedRuntime.make(CapabilitiesLive(hook).pipe(Layer.provide(layer)));
    cleanup.push(() => runtime.dispose());
    const capabilities = Context.get(await runtime.context(), Capabilities);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(capabilities.list().map(({ id }) => id)).toEqual(['pages', 'computer', 'web.research', 'memory', 'extra']);

    const answer = await capabilities.describe(turn, () => 'manual', TOOLS);
    const byId = Object.fromEntries((answer.capabilities as Array<{ id: string }>).map((item) => [item.id, item]));
    expect(byId.pages).toMatchObject({ enabled: true, details: { defaultSpace: 'Home', spaces: ['Home'] } });
    expect(byId.computer).toMatchObject({ enabled: true, details: { permissions: { enabled: true } } });
    // Search is off in `CapabilitiesConfig`, memory in the workspace's settings.
    expect(byId['web.research']).toMatchObject({ enabled: false, tools: ['search_web'] });
    expect(byId.memory).toMatchObject({ enabled: false, tools: ['propose_memory'] });
    expect(answer.identity).toEqual({ web: 'd1' });
    expect(answer.requests).toMatchObject({ pending: ['pending'], resolved: ['resolved'] });
    expect(asked).toEqual(['socioReader t1 d1', 'readable {"dotId":"d1","people":["u1"]}', 'permissions d1']);
});

it('turns web research and memory on from CapabilitiesConfig and the workspace settings', async () => {
    const { layer } = stubs({ memoryAllowed: true, webSearchProvider: 'parallel' });
    const runtime = ManagedRuntime.make(CapabilitiesLive(() => []).pipe(Layer.provide(layer)));
    cleanup.push(() => runtime.dispose());
    const capabilities = Context.get(await runtime.context(), Capabilities);
    const answer = await capabilities.describe(turn, () => 'manual', TOOLS);
    const byId = Object.fromEntries((answer.capabilities as Array<{ id: string }>).map((item) => [item.id, item]));
    expect(byId['web.research']).toMatchObject({ enabled: true, tools: ['search_web'] });
    expect(byId.memory).toMatchObject({ enabled: true, tools: ['propose_memory'] });
});

it("the server's graph builds capabilities from its layer: Platform, Capabilities and LegacyCapabilities share it", async () => {
    // The supplied config wins over the environment (moving environment parsing here is a later change).
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'parallel');
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const module = { id: 'extra', capabilities: () => [extra] } satisfies ServerModule;
    const { runtime, platform } = await startWithTestPlatform({
        db: workspace.db,
        store,
        workspace,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
            computerSupervisorUrl: 'http://supervisor.invalid',
            webSearchProvider: 'disabled',
        },
        runner: new LocalAgentRunner(testDatabase()),
        modules: [module],
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const { capabilities, legacy, config } = await runtime.runPromise(
        Effect.gen(function* () {
            return {
                capabilities: yield* Capabilities,
                legacy: yield* LegacyCapabilities,
                config: yield* CapabilitiesConfig,
            };
        }),
    );
    expect(capabilities).toBe(platform.capabilities);
    expect(legacy).toBe(platform.capabilities);
    expect(config).toEqual({
        computerSupervisorUrl: 'http://supervisor.invalid',
        computerSupervisorToken: undefined,
        computerToken: undefined,
        webSearchProvider: 'disabled',
    });
    expect(capabilities.list().map(({ id }) => id)).toEqual(['pages', 'computer', 'web.research', 'memory', 'extra']);
});
