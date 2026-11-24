/**
 * The layer graph's root: what the boot step hands the graph, as the tags every
 * step of `composition/index.ts` may yield. The two stores, the config, the
 * runner, the checked modules and the context their hooks get, a fresh set of
 * late-bound ports, who sent each runtime request (`AppTurns`'s map) and the
 * issues module's leader work. It builds nothing and takes no listener, so it
 * changes no order.
 */
import { Context, Effect, Layer } from 'effect';

import { Leadership, type IssuesLeadership } from '../issues/contract.js';
import type { ModuleContext, ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { serverModules } from '../modules/index.js';
import { checkModules } from '../modules/mount.js';
import { Runner } from '../turns/contract.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import { requestUsers } from './app/turns.js';
import { LegacyConfig, LegacyModuleContext, LegacyRunner, LegacyStore, LegacyWorkspace, ModuleHost } from './base.js';
import type { PlatformConfig } from './config.js';
import type { CoreStore } from './core-store.js';
import { RequestSenders } from './dots.js';
import { platformPorts, Ports } from './ports.js';
import type { AppWorkspace } from './workspace-parts.js';

/** What the root hands the graph: the boot step's stores, config, runner and modules. */
export interface RootBoot {
    store: CoreStore;
    workspace: AppWorkspace;
    config: PlatformConfig;
    runner: LocalAgentRunner;
    /** The server's list (`serverModules`) when left out. */
    modules?: readonly ServerModule[];
    /** The issues module's leader work, run through the root's runtime. */
    issuesLeadership: IssuesLeadership;
    /** The app's services for the modules' hooks, which runs their Effects too (`moduleServices`). */
    services: ModuleServicesAccess;
}

/**
 * The modules' context: every hook gets the workspace's connection and
 * data layer, and the app's services, which hold everything else it reads.
 */
function moduleContext(workspace: AppWorkspace, services: ModuleServicesAccess): ModuleContext {
    return {
        db: workspace.db,
        data: workspace.data,
        services,
        log: (line) => console.log(line),
    };
}

/** The root's tags, made once per build: the modules checked, the ports fresh. */
export function rootLayer(boot: RootBoot) {
    return Layer.effectContext(
        Effect.sync(() => {
            const modules = checkModules(boot.modules ?? serverModules);
            const context = moduleContext(boot.workspace, boot.services);
            const run = boot.services.run;
            return Context.make(Ports, platformPorts()).pipe(
                Context.add(LegacyStore, boot.store),
                Context.add(LegacyWorkspace, boot.workspace),
                Context.add(LegacyConfig, boot.config),
                Context.add(LegacyRunner, boot.runner),
                Context.add(Runner, boot.runner),
                Context.add(ModuleHost, { use: (build) => build(modules, context, run) }),
                Context.add(LegacyModuleContext, context),
                Context.add(RequestSenders, (request) => requestUsers.get(request)),
                Context.add(Leadership, boot.issuesLeadership),
            );
        }),
    );
}
