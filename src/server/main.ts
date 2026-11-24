/**
 * The composition root: the
 * one place that wires the layers, and the process's one `ManagedRuntime`.
 * An entry file: it may import every feature's `layer.ts`.
 *
 * The order, after the boot step (open, migrate, `openCoreStore`, `new WorkspaceStore`):
 * the store's four slices (`People`, `Spaces`, `Socios`, `Audit`),
 * `PeopleSync` over them, the Board over it and page moves beside it,
 * then the app's graph over both (the root's tags, `composition/root.ts`,
 * then each feature's steps, `composition/index.ts`), issues' bridges over
 * the graph's services, auth's tags over the provider the boot step
 * built (`composition/auth.ts`), then the issues leader work and the
 * Board's Effect API. `startAppRuntime` builds
 * it all once, before routes are mounted, so a broken layer stops the
 * boot.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Layer, ManagedRuntime } from 'effect';

import type { AuthSetup } from './auth/contract.js';
import { authLayers } from './composition/auth.js';
import type { PlatformConfig } from './composition/config.js';
import type { CoreStore } from './composition/core-store.js';
import { appGraph } from './composition/index.js';
import { issuesLayers } from './composition/issues.js';
import type { ModuleHookServices } from './composition/module-services.js';
import { rootLayer } from './composition/root.js';
import type { AppWorkspace } from './composition/workspace-parts.js';
import { BoardLive, IssueBoardLive, IssuesBackgroundLive } from './issues/layer.js';
import { issuesLeadership, type IssuesRuntime } from './issues/leadership.js';
import type { ModuleServicesAccess } from './modules/contract.js';
import type { ServerModule } from './modules/contract.js';
import { moduleServices } from './modules/lifecycle.js';
import { PageMovesLive } from './pages/layer.js';
import type { LocalAgentRunner } from './turns/local-runner.js';
import { PeopleSyncLive, WorkspaceLive } from './workspace/layer.js';

/** What the boot step hands the root: a migrated connection and the stores on it. */
export interface AppBoot {
    db: DatabaseSync;
    store: CoreStore;
    workspace: AppWorkspace;
    config: PlatformConfig;
    runner: LocalAgentRunner;
    /**
     * The auth provider the boot step built and started (`authFromEnv`,
     * `startAuth`, before the stores open): the very object `createApp`
     * and the pages get, so `Auth` holds it, not a second one.
     */
    auth: AuthSetup;
    /** The server modules; the server's list (`serverModules`) when left out. */
    modules?: readonly ServerModule[];
    /** Operational lines only (`ModuleContext.log`). */
    log?: (line: string) => void;
}

/**
 * The layer graph, wired with `provideMerge` so each layer sees the ones
 * built before it; each layer value is made once here, so it is built once.
 * `runtime` reaches the runtime that runs this graph, for the issues
 * module's leader work; `services` the services it builds, for the
 * modules' hooks (`moduleServices`).
 */
export function makeAppLayer(boot: AppBoot, runtime: () => IssuesRuntime, services: ModuleServicesAccess) {
    const log = boot.log ?? ((line: string) => console.log(line));
    const Workspace = WorkspaceLive(boot.workspace);
    const Core = Layer.mergeAll(
        BoardLive(boot.db),
        PageMovesLive(boot.db, boot.workspace.pages),
        // Who may run code (CB-376), from the provider: the gateways' step reads it.
        authLayers.codeAccess(boot.auth),
    ).pipe(Layer.provideMerge(PeopleSyncLive), Layer.provideMerge(Workspace));
    const Graph = appGraph(
        rootLayer({
            store: boot.store,
            workspace: boot.workspace,
            config: boot.config,
            runner: boot.runner,
            modules: boot.modules,
            issuesLeadership: issuesLeadership(runtime),
            services,
        }),
    ).pipe(Layer.provideMerge(Core));
    const Bridges = issuesLayers.bridges.pipe(Layer.provideMerge(Graph));
    // Auth's tags (`Auth`, `RequestUsers`, `AccessPolicyReader`, `AuthViews`,
    // `AuthConfig`) over the boot step's setup and connection. Building them
    // starts nothing and takes no listener, so they change no order.
    const Auth = Layer.mergeAll(authLayers.config, authLayers.services(boot.auth, boot.db)).pipe(
        Layer.provideMerge(Bridges),
    );
    return Layer.mergeAll(IssuesBackgroundLive(log), IssueBoardLive).pipe(Layer.provideMerge(Auth));
}

export type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/**
 * What the HTTP edge and the boot steps take (`composition/http/`,
 * `composition/lifecycle/`): the runtime and the services it built.
 */
export interface AppEdge {
    readonly services: Context.Context<AppServices>;
    readonly runtime: AppRuntime;
}

/**
 * The services the modules' hooks reach (`ModuleContext.services`, their
 * Effects' `R`): the app's, as `ModuleHookServices`
 * lists them. Not `AppServices` itself, which is inferred from a graph
 * whose types hold the modules' own, so it would name itself. That each is
 * one the runtime builds is checked where `startAppRuntime` hands them over.
 */
declare module './modules/contract.js' {
    interface ModuleRuntimeServices {
        app: ModuleHookServices;
    }
}

/**
 * Makes the runtime (lazy: nothing is built yet), then builds every layer
 * once; a failure stops the boot here. Returns the runtime, the services it
 * built, and the two as the edge (`AppEdge`). The modules' hooks read the
 * services built here, once they all are (`moduleServices`).
 */
export async function startAppRuntime(boot: AppBoot) {
    let built: Context.Context<AppServices> | undefined;
    const runtime: AppRuntime = ManagedRuntime.make(
        makeAppLayer(
            boot,
            () => runtime,
            moduleServices(
                () => runtime,
                () => built,
            ),
        ),
    );
    built = await runtime.context();
    const edge: AppEdge = { runtime, services: built };
    return { runtime, services: built, edge };
}
