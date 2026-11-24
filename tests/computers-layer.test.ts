// The computers' service is built by its layer from the tags it reads
// (`Socios`, `ComputerRecords`, `ComputersConfig`, `WorkspaceSettings`,
// `ComputersBoot`) and offered as `Computers`; `ComputerWork` and
// `Screenshots` are today's functions. The server's graph builds it there,
// with `ComputersConfig` from the supplied startup config, and `Platform`
// holds the same object.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LegacyComputers } from '../src/server/composition/computers.js';
import {
    abortComputerActions,
    BROWSER_STUCK,
    ComputerService,
    computerActionsInFlight,
} from '../src/server/computers/computer-service.js';
import { screenshotResult } from '../src/server/computers/computer-tools.js';
import {
    ComputerRecords,
    Computers,
    ComputersConfig,
    ComputerWork,
    Screenshots,
    type ComputersConfigShape,
} from '../src/server/computers/contract.js';
import { ComputersBoot, ComputersLive, ComputerWorkLive, ScreenshotsLive } from '../src/server/computers/layer.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    return store;
}

const CONFIG: ComputersConfigShape = {
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
};

/** The computers layer over a workspace, with fake settings and hooks. */
function computersRuntime(ws: WorkspaceStore, settings: { paused: boolean }, hooks = {}) {
    const runtime = ManagedRuntime.make(
        Layer.mergeAll(ComputersLive, ComputerWorkLive, ScreenshotsLive).pipe(
            Layer.provide(
                Layer.mergeAll(
                    WorkspaceLive(ws),
                    Layer.succeed(ComputerRecords, ws.computers),
                    Layer.succeed(ComputersConfig, CONFIG),
                    Layer.succeed(WorkspaceSettings, {
                        settings: () => settings,
                    } as unknown as WorkspaceSettingsShape),
                    Layer.succeed(ComputersBoot, { hooks }),
                ),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    return runtime;
}

const pathOf = (url: string) => new URL(url).pathname;

it('builds one service from the tags it reads, and offers ComputerWork and Screenshots as today', async () => {
    const ws = workspace();
    const id = ws.dots()[0].id;
    const stopped = vi.fn();
    const settings = { paused: true };
    const context = await computersRuntime(ws, settings, { stopped }).context();
    const computers = Context.get(context, Computers);
    expect(computers).toBeInstanceOf(ComputerService);
    expect(computers.configured).toBe(true);
    expect(computers.deployment).toBeNull();
    expect(Context.get(context, ComputerWork)).toEqual({
        inFlight: computerActionsInFlight,
        abort: abortComputerActions,
    });
    expect(Context.get(context, Screenshots)).toEqual({ result: screenshotResult });

    // Permissions come from the workspace's records, and the pause from
    // `WorkspaceSettings`, read at the moment of use.
    await ws.computers.patch(id, { enabled: true, browser: true, files: true, shell: true });
    await expect(computers.action(id, 'snapshot', {}, 'agent')).rejects.toThrow('Agents are paused.');
    await expect(computers.action('missing-socio', 'snapshot', {}, 'agent')).rejects.toThrow('Socio not found.');

    // The boot's hooks: a stop ends the computer session.
    settings.paused = false;
    vi.stubGlobal('fetch', async () => Response.json({ stopped: true }));
    const fresh = Context.get(await computersRuntime(ws, settings, { stopped }).context(), Computers);
    await fresh.stop(id);
    expect(stopped).toHaveBeenCalledWith(id);
});

it('shares stuck browsers and restarts with a Dot turn’s own service on the same workspace', async () => {
    const ws = workspace();
    const id = ws.dots()[0].id;
    await ws.computers.patch(id, { enabled: true, browser: true, files: true, shell: true });
    const calls: string[] = [];
    const transport: typeof fetch = async (input, init) => {
        const url = String(input);
        calls.push(pathOf(url));
        if (url.endsWith('/computers')) {
            return Response.json({
                computers: ws.dots().map((dot) => ({
                    botId: dot.id,
                    container: `company-brain-computer-${dot.id}`,
                    status: 'running',
                })),
            });
        }
        if (url.endsWith('/health')) {
            return Response.json({ browser: false, browserState: 'stuck', isolationVersion: 1 });
        }
        if (url.endsWith('/stop')) {
            return Response.json({ stopped: true });
        }
        if (url.endsWith('/control')) {
            return Response.json({
                holder: 'bot',
                requested: false,
                transitioning: false,
                resumeSnapshotRequired: false,
            });
        }
        // A browser call that never answers: the turn's limit ends it.
        return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
    };
    // The platform's service, from the layer, reaches the same supervisor.
    vi.stubGlobal('fetch', transport);
    const platform = Context.get(await computersRuntime(ws, { paused: false }).context(), Computers);
    // A Dot turn's own service is given the `WorkspaceStore` itself.
    const turn = new ComputerService(ws, CONFIG, () => false, transport, 1000, {}, 50);

    await expect(turn.action(id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(calls.filter((path) => path === '/snapshot')).toHaveLength(1);
    // The platform's service knows the browser is stuck: it doesn't dispatch.
    await expect(platform.action(id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(calls.filter((path) => path === '/snapshot')).toHaveLength(1);
    // A stop through the platform's service clears it for the turn's.
    await platform.stop(id);
    await expect(turn.action(id, 'snapshot', {}, 'agent')).rejects.toThrow(BROWSER_STUCK);
    expect(calls.filter((path) => path === '/snapshot')).toHaveLength(2);
});

it("the server's graph builds the computers from their layer: Platform, Computers and LegacyComputers share the service", async () => {
    // The supplied config wins over the environment (moving environment parsing here is a later change).
    vi.stubEnv('COMPUTER_SUPERVISOR_URL', 'http://env.invalid');
    const ws = workspace();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
            ...CONFIG,
            computerNamespace: 'fixture-namespace',
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [],
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const read = await runtime.runPromise(
        Effect.gen(function* () {
            return {
                computers: yield* Computers,
                legacy: yield* LegacyComputers,
                config: yield* ComputersConfig,
                records: yield* ComputerRecords,
                work: yield* ComputerWork,
                screenshots: yield* Screenshots,
            };
        }),
    );
    expect(read.computers).toBe(platform.computers);
    expect(read.legacy).toBe(platform.computers);
    expect(read.records).toBe(ws.computers);
    expect(read.config).toEqual({ ...CONFIG, computerNamespace: 'fixture-namespace' });
    expect(read.work.inFlight).toBe(computerActionsInFlight);
    expect(read.screenshots.result).toBe(screenshotResult);
    expect(platform.computers.configured).toBe(true);
    // Not paused (the store's settings), so an agent's action gets past the pause.
    await expect(platform.computers.action(ws.dots()[0].id, 'snapshot', {}, 'agent')).rejects.toThrow(
        'Computer permission is disabled.',
    );
});
