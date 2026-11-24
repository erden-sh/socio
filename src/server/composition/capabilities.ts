/**
 * The capabilities' construction: capabilities' step of the graph, which builds
 * the registry through the capabilities layer (`capabilities/layer.ts`).
 */
import { Context, Effect, Layer } from 'effect';

import {
    Capabilities,
    CapabilitiesConfig,
    CapabilityIdentity,
    CapabilityRequests,
    type CapabilitiesConfigShape,
    type CapabilityDefinition,
} from '../capabilities/contract.js';
import { makeCapabilities } from '../capabilities/layer.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { Board } from '../issues/contract.js';
import type { ModuleBuildServices, ModuleContext, ServerModule } from '../modules/contract.js';
import { WebCapabilities } from '../web/contract.js';

import { LegacyConfig, ModuleHost } from './base.js';
import type { PlatformConfig } from './config.js';

/**
 * Each module's capabilities, its hook called when the ones before it are
 * registered, with the services built before the capabilities (`built`)
 * for what it wires at once.
 */
function* moduleCapabilities(
    modules: readonly ServerModule[],
    context: ModuleContext,
    built: ModuleBuildServices,
): Generator<CapabilityDefinition> {
    for (const module of modules) {
        yield* module.capabilities?.(context, built) ?? [];
    }
}

/** The services built so far, by tag: a context of the graph, or the members a platform built on its own made. */
export const builtServices = (context: Context.Context<never>): ModuleBuildServices => ({
    get: (tag) => Context.getUnsafe(context, tag),
});

/** `CapabilitiesConfig` from the supplied startup configuration (moving env parsing here is a later change). */
const capabilitiesConfig = (config: PlatformConfig): CapabilitiesConfigShape => ({
    computerSupervisorUrl: config.computerSupervisorUrl,
    computerSupervisorToken: config.computerSupervisorToken,
    computerToken: config.computerToken,
    webSearchProvider: config.webSearchProvider,
});

/** The capabilities registry, under the graph's `LegacyCapabilities` tag (the class). */
export class LegacyCapabilities extends Context.Service<LegacyCapabilities, CapabilityRegistry>()(
    'socio/composition/capabilities/CapabilityRegistry',
) {}

/**
 * Capabilities' step of the graph: the layer's registry, the core ones
 * then each module's, offered as `Capabilities` and as
 * `LegacyCapabilities` for the steps that still take the class, with
 * `CapabilitiesConfig` from the supplied startup configuration.
 * What its layer yields of other features (`WorkspaceSettings`,
 * `ComputerRecords`, `Access`, `Conversations`) is built before it: the
 * leaf bridges at the chain's front, the rest by the root and Spaces'
 * step. Its sections' ports are provided here from web's `WebCapabilities`
 * (`CapabilityIdentity`) and the `Board`'s requests (`CapabilityRequests`).
 */
export const capabilitiesLayers = {
    capabilities: Layer.effectContext(
        Effect.gen(function* () {
            const config = capabilitiesConfig(yield* LegacyConfig);
            const host = yield* ModuleHost;
            // Everything the graph built before this step, which the modules'
            // hooks wire at once (socio access's approvals, the plugins').
            const built = builtServices(yield* Effect.context<never>());
            const identity = yield* WebCapabilities;
            const board = yield* Board;
            const registry = yield* makeCapabilities(() =>
                host.use((modules, context) => moduleCapabilities(modules, context, built)),
            ).pipe(
                Effect.provideService(CapabilitiesConfig, config),
                Effect.provideService(CapabilityIdentity, identity),
                Effect.provideService(CapabilityRequests, board.requests),
            );
            return Context.make(LegacyCapabilities, registry).pipe(
                Context.add(Capabilities, registry),
                Context.add(CapabilitiesConfig, config),
            );
        }),
    ),
};
