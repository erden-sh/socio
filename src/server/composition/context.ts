/**
 * The context's construction: `context/layer.ts` builds its stores, the replies
 * reactions are for, and the steering turns from other features' tags; this
 * file gives the steering turns what no tag holds yet (the drain and setup,
 * from their ports; the modules' log), adds the tag the other steps read them
 * from, and builds `ContextConfig` from the configuration.
 */
import { Context, Effect, Layer } from 'effect';

import { ContextConfig, SharedChats, WaitingTurns, type ContextConfigShape } from '../context/contract.js';
import { ContextStoresLive, DotRepliesLive, makeSteeringTurns, type SteeringLate } from '../context/layer.js';
import { SteeringTurns } from '../context/steering-turns.js';
import { DotAgents } from '../dots/contract.js';
import { TurnMemory } from '../memory/contract.js';
import type { ModuleContext } from '../modules/contract.js';
import { EventReplayLive } from '../replay/layer.js';

import { LegacyConfig, LegacyModuleContext, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { type PlatformPorts, Ports } from './ports.js';
import type { AppWorkspace } from './workspace-parts.js';

/** What the context reads of the configuration: `CONTEXT_SUMMARY_MODEL` and `CONTEXT_SELECTION`, as parsed at startup. */
export const contextConfig = (config: Pick<PlatformConfig, 'context'>): ContextConfigShape => ({
    context: config.context,
});

/**
 * The drain and setup, read through their ports at the moment of use (the
 * setup status is built after the steering turns), the modules' context's
 * log, and the conversations' Telegram facts from the workspace's links.
 * The Dots' agents are given beside them.
 */
const lateOf = (
    ports: Pick<PlatformPorts, 'draining' | 'setup'>,
    context: Pick<ModuleContext, 'log'>,
    links: Pick<AppWorkspace['telegram'], 'threadInfo'>,
): Omit<SteeringLate, 'agents'> => ({
    draining: () => ports.draining.get(),
    setup: () => ports.setup.get().setup(),
    log: (line) => context.log(line),
    links: { threadInfo: (threadId) => links.threadInfo(threadId) },
});

/** The steering turns, under the graph's `LegacySteering` tag (the class). */
export class LegacySteering extends Context.Service<LegacySteering, SteeringTurns>()(
    'socio/composition/context/SteeringTurns',
) {}

/** The context's stores on the workspace connection. */
const ContextStoresFromWorkspace = Layer.unwrap(
    Effect.gen(function* () {
        return ContextStoresLive((yield* LegacyWorkspace).db);
    }),
);

/** `ContextConfig`, from the startup configuration (`LegacyConfig`), never from the environment. */
const ContextConfigLive = Layer.effect(
    ContextConfig,
    Effect.gen(function* () {
        return contextConfig(yield* LegacyConfig);
    }),
);

/**
 * Whether a chat is shared, for the module's tools (`SharedChats`): memory's
 * `TurnMemory` itself, which has the method. Builds nothing; memory's step
 * offers it, where `TurnMemory` is built (`composition/memory.ts`).
 */
export const SharedChatsLive = Layer.effect(
    SharedChats,
    Effect.gen(function* () {
        return yield* TurnMemory;
    }),
);

/**
 * The context's steps of the graph: the steering turns, built from the
 * tags (`context/layer.ts`), fill their port at the step they always had;
 * at the end, the stores, the replies and `ContextConfig`, and the steering
 * turns as `WaitingTurns`.
 */
export const contextLayers = {
    steering: Layer.effectContext(
        Effect.gen(function* () {
            const ports = yield* Ports;
            const turns = yield* makeSteeringTurns({
                ...lateOf(ports, yield* LegacyModuleContext, (yield* LegacyWorkspace).telegram),
                agents: yield* DotAgents,
            });
            return Context.make(LegacySteering, ports.steering.fill(turns));
        }),
    ).pipe(Layer.provide(ContextStoresFromWorkspace)),
    bridges: Layer.effectContext(
        Effect.gen(function* () {
            return Context.make(WaitingTurns, yield* LegacySteering);
        }),
    ).pipe(
        Layer.provideMerge(DotRepliesLive.pipe(Layer.provide(EventReplayLive))),
        Layer.provideMerge(ContextStoresFromWorkspace),
        Layer.provideMerge(ContextConfigLive),
    ),
};
