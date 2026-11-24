/**
 * The layer graph's root tags: what the boot step hands the graph (the two
 * stores, the config, the runner, the modules and their context).
 * `composition/root.ts` provides them, with the late-bound ports, first, and
 * every step of the graph (`composition/index.ts`) may yield them.
 *
 * These are legacy tags: each names a class, not a slice. They go as the
 * features they hold move behind their contracts.
 */
import { Context } from 'effect';

import type { ModuleContext, ServerModule } from '../modules/contract.js';
import type { ModuleEffectRunner } from '../modules/lifecycle.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import type { PlatformConfig } from './config.js';
import type { CoreStore } from './core-store.js';
import type { AppWorkspace } from './workspace-parts.js';

/** The settings store the boot step opened. */
export class LegacyStore extends Context.Service<LegacyStore, CoreStore>()('socio/composition/Store') {}

/** The workspace store the boot step opened, on the same connection. */
export class LegacyWorkspace extends Context.Service<LegacyWorkspace, AppWorkspace>()('socio/composition/Workspace') {}

/** The process's configuration, from which composition builds each feature's `XConfig`. */
export class LegacyConfig extends Context.Service<LegacyConfig, PlatformConfig>()('socio/composition/Config') {}

/** The runner the boot step made, on its own connection. */
export class LegacyRunner extends Context.Service<LegacyRunner, LocalAgentRunner>()('socio/composition/Runner') {}

/** A notice to every active admin or operator, from the app itself. */
export type PlatformNotice = { trigger: string; title: string; message: string; path: string };

/**
 * The modules, the context their hooks get and the runner of their Effect
 * hooks.
 */
export interface ModuleHostShape {
    use<R>(build: (modules: readonly ServerModule[], context: ModuleContext, run: ModuleEffectRunner) => R): R;
}

/** The checked modules and their context (`composition/root.ts`). */
export class ModuleHost extends Context.Service<ModuleHost, ModuleHostShape>()('socio/composition/ModuleHost') {}

/**
 * The modules' context (`ModuleContext`): its connection, data layer,
 * the app's services and the log, for the builders that take it (the
 * domains, the classification seam, Learning's triage).
 */
export class LegacyModuleContext extends Context.Service<LegacyModuleContext, ModuleContext>()(
    'socio/composition/ModuleContext',
) {}
