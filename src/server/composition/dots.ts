// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
/**
 * The socios' construction: `dots/layer.ts` builds the extensions every
 * DotAgent gets and the agents over them; this file adds what only the root has
 * (`DotTurnHooks`), builds `DotsConfig` from the config, and builds the
 * CopilotKit runtime the web's turns run on (`buildRuntimeHandler`).
 */
import { CopilotRuntime, createCopilotHonoHandler, type CopilotHonoApp } from '@copilotkit/runtime/v2';
import { Context, Effect, Layer } from 'effect';

import { ianaTimeZone, TIME_ZONE_HEADER } from '@socio/shared/time-zone';

import { Approvals, type ApprovalsShape } from '../approvals/contract.js';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import { capabilitiesTool } from '../capabilities/tool.js';
import {
    DotAgents,
    DotsConfig,
    DotTurnHooks,
    TurnExtensions,
    type DotExtensions,
    type DotsConfigShape,
    type DotTurnHooksShape,
    type DotTurnServices,
} from '../dots/contract.js';
import { DotAgentCore } from '../dots/dot-agent.js';
import { makeDotAgents, TurnExtensionsLive } from '../dots/layer.js';
import { Flags, type FlagsShape } from '../flags/contract.js';
import type { InferenceService } from '../inference/service.js';
import type { ModuleContext, ServerModule } from '../modules/contract.js';
import { moduleNews, modulePageContext, moduleTurnNote, type ModuleEffectRunner } from '../modules/lifecycle.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';
import type { WebReaderShape } from '../web/contract.js';

import { AppDotTurnServices, appDotTurnsLayers } from './app/dot-turns.js';
import { LegacyConfig, LegacyRunner, LegacyStore, LegacyWorkspace, ModuleHost } from './base.js';
import { LegacyCapabilities } from './capabilities.js';
import type { PlatformConfig } from './config.js';
import { dotTurnStoreOf, type CoreStore } from './core-store.js';
import { LegacyInference } from './inference.js';
import { webReadsFor } from './web.js';
import type { AppWorkspace } from './workspace-parts.js';

/**
 * What only the root has for every turn (`DotTurnHooks`): the capabilities
 * tool before the modules' tools, the tools of flags that are off for the
 * person (the flags, read at each turn), and the modules' prompt
 * hooks, each awaited in registry order.
 */
export function dotTurnHooks(deps: {
    modules: readonly ServerModule[];
    context: ModuleContext;
    /** Runs a hook's Effect with the app's runtime. */
    run: ModuleEffectRunner;
    capabilities: CapabilityRegistry;
    approvals: ApprovalsShape;
    /** The flags, read at each turn. */
    flags: () => Pick<FlagsShape, 'toolsOff'>;
}): DotTurnHooksShape {
    const { modules, context, capabilities, approvals } = deps;
    return {
        tools: (turn) => {
            const tools = modules.flatMap((module) => module.dotTools?.(context, turn) ?? []);
            return [capabilitiesTool(capabilities, approvals, turn, () => [...turn.toolNames()]), ...tools];
        },
        toolsOff: (turn) => deps.flags().toolsOff(turn.userId),
        pageContext: (turn) => modulePageContext(modules, context, turn, deps.run),
        news: (turn) => moduleNews(modules, context, turn, deps.run),
        turnNote: (turn) => moduleTurnNote(modules, context, turn, deps.run),
    };
}

/**
 * The web reads' audit lines for the admins' view of the socios
 * (`dots/dot-admin.ts`): the connection's one reader, reached when read.
 */
export const dotAdminWeb = (platform: {
    readonly workspace: Pick<AppWorkspace, 'db'>;
    readonly config: Pick<PlatformConfig, 'web'>;
}): Pick<WebReaderShape, 'activity'> => ({
    activity: (dotId, before, limit) =>
        webReadsFor(platform.workspace.db, platform.config.web).activity(dotId, before, limit),
});

/** `DotsConfig`, from the configuration the process was started with (never the env itself). */
export const dotsConfig = (config: PlatformConfig): DotsConfigShape => ({
    context: config.context,
    operations: config.operations,
});

/** Who sent a runtime request (`AppTurns.handle`), and when it came (CB-185). */
export type RequestSender = (request: Request) => { userId: string; receivedAt: number } | undefined;

/**
 * Conversations run on the CopilotKit runtime in SSE mode with a local,
 * durable runner. No conversation data leaves this server.
 */
export function buildRuntimeHandler(deps: {
    store: CoreStore;
    workspace: AppWorkspace;
    config: PlatformConfig;
    runner: LocalAgentRunner;
    inference: InferenceService;
    dotExtensions: DotExtensions;
    /** What a Dot's turns call of other features (`AppDotTurnServices`). */
    services: DotTurnServices;
    sender: RequestSender;
}): CopilotHonoApp {
    const { store, workspace, config } = deps;
    const runtime = new CopilotRuntime({
        runner: deps.runner,
        // The signed-in person's Dots only (`handle` records who asks), so
        // `/info` names nobody else's own Dot.
        agents: async ({ request }: { request: Request }) => {
            const sender = deps.sender(request);
            return Object.fromEntries(
                (sender ? workspace.dotsFor(sender.userId) : workspace.dots()).map((dot) => [
                    dot.id,
                    new DotAgentCore(
                        deps.services,
                        dotTurnStoreOf(store),
                        workspace,
                        config,
                        dot.id,
                        false,
                        undefined,
                        {
                            inference: deps.inference,
                            extensions: deps.dotExtensions,
                            // The browser's time zone, for a person whose profile has
                            // none it can use (CB-159).
                            browserTimeZone: ianaTimeZone(request.headers.get(TIME_ZONE_HEADER)),
                            // The person who sent it starts the turn (CB-185).
                            ...(sender
                                ? {
                                      signals: {
                                          receivedAt: sender.receivedAt,
                                          trigger: { kind: 'person', id: sender.userId },
                                      },
                                  }
                                : {}),
                        },
                    ),
                ]),
            );
        },
    });
    return createCopilotHonoHandler({
        runtime,
        basePath: '/api/copilotkit',
        cors: { origin: [] },
    });
}

/** The extensions every DotAgent gets, under the graph's `LegacyDotExtensions` tag. */
export class LegacyDotExtensions extends Context.Service<LegacyDotExtensions, DotExtensions>()(
    'socio/composition/dots/DotExtensions',
) {}

/** The CopilotKit runtime's handler, under the graph's `LegacyRuntimeHandler` tag. */
export class LegacyRuntimeHandler extends Context.Service<LegacyRuntimeHandler, CopilotHonoApp>()(
    'socio/composition/dots/RuntimeHandler',
) {}

/**
 * Who sent each runtime request, recorded by `AppTurns.handle`: the
 * runtime's agent list reads it (`buildRuntimeHandler`).
 */
export class RequestSenders extends Context.Service<RequestSenders, RequestSender>()(
    'socio/composition/dots/RequestSenders',
) {}

/** `DotsConfig`, from the process's config. */
const DotsConfigLive = Layer.effect(
    DotsConfig,
    Effect.gen(function* () {
        return dotsConfig(yield* LegacyConfig);
    }),
);

/** `DotTurnHooks`, over the modules, the capabilities, the approvals and the flags (`Flags`). */
const DotTurnHooksLive = Layer.effect(
    DotTurnHooks,
    Effect.gen(function* () {
        const flags = yield* Flags;
        const capabilities = yield* LegacyCapabilities;
        const approvals = yield* Approvals;
        return (yield* ModuleHost).use((modules, context, run) =>
            dotTurnHooks({ modules, context, run, capabilities, approvals, flags: () => flags }),
        );
    }),
);

/**
 * The socios' steps of the graph, in the graph's order: `dots/layer.ts`'s
 * extensions (also offered as `LegacyDotExtensions`, which the turns and
 * the computers read) and `DotAgents` over them, with `DotsConfig` and
 * `AppDotTurnServices` (`composition/app/dot-turns.ts`); then,
 * last but one, the runtime's handler. The turns read the graph's flags
 * (`Flags`).
 */
export const dotsLayers = {
    extensions: Layer.effectContext(
        Effect.gen(function* () {
            const store = yield* LegacyStore;
            const workspace = yield* LegacyWorkspace;
            const config = yield* LegacyConfig;
            const agents = yield* makeDotAgents(yield* AppDotTurnServices, dotTurnStoreOf(store), workspace, config);
            const extensions = yield* TurnExtensions;
            return Context.make(LegacyDotExtensions, extensions).pipe(
                Context.add(TurnExtensions, extensions),
                Context.add(DotAgents, agents),
            );
        }),
    ).pipe(
        Layer.provide(TurnExtensionsLive),
        Layer.provide(DotTurnHooksLive),
        Layer.provideMerge(DotsConfigLive),
        Layer.provideMerge(appDotTurnsLayers.step),
    ),
    handler: Layer.effect(
        LegacyRuntimeHandler,
        Effect.gen(function* () {
            return buildRuntimeHandler({
                store: yield* LegacyStore,
                workspace: yield* LegacyWorkspace,
                config: yield* LegacyConfig,
                runner: yield* LegacyRunner,
                inference: yield* LegacyInference,
                dotExtensions: yield* LegacyDotExtensions,
                services: yield* AppDotTurnServices,
                sender: yield* RequestSenders,
            });
        }),
    ),
};
