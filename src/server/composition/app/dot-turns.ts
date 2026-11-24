// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
/**
 * What a Dot's turns call of other features (`DotTurnServices`,
 * dots/contract.ts), built once in the graph over the store, workspace and
 * config and offered as `AppDotTurnServices`. Every Dot's agent is
 * `dots/dot-agent.ts`'s `DotAgentCore` over them: the runtime's agent list,
 * `AppTurns.turnOutcome`, and `DotAgents` (the steering and Telegram turns).
 * Each service is today's function over the same store, workspace and config,
 * read at the moment of use, so one set serves every agent as a set per agent
 * did.
 */
import { Context, Effect, Layer } from 'effect';

import { ComputerService } from '../../computers/computer-service.js';
import { compactNow, fitContext } from '../../context/fit.js';
import { contextNotes } from '../../context/notes.js';
import { steeringQueue } from '../../context/steering.js';
import { timeMarkers } from '../../context/time-markers.js';
import type { DotTurnConfig, DotTurnServices } from '../../dots/contract.js';
import { settingsInference } from '../../inference/openai-compatible.js';
import { learnedSkillsFor } from '../../learning/delivery.js';
import { timeZones, turnMemory } from '../../memory/recall.js';
import { gatherSources, searchProviderFor } from '../../search/index.js';
import { limitDefaults, turnTimeLimitMs } from '../../settings/limits.js';
import { compactWith } from '../../skills/compact.js';
import { chatSkills } from '../../skills/registry.js';
import { skillSessions, skillsRepository } from '../../skills/repository.js';
import { agentLoop } from '../../turns/agent-loop.js';
import { RetryBudget, busyModel, retriedRequests } from '../../turns/model-busy.js';
import { timedRounds } from '../../turns/round-timer.js';
import { learnedSkillTools, tanstackTools } from '../../turns/tanstack-tools.js';
import { TurnTracer } from '../../turns/turn-trace.js';
import { LegacyConfig, LegacyStore, LegacyWorkspace } from '../base.js';
import type { CoreStore } from '../core-store.js';
import type { AppWorkspace } from '../workspace-parts.js';

/**
 * The configuration a DotAgent reads: the fields it reads itself
 * (`DotTurnConfig`) and those of each config its services hand whole to
 * another feature's helper. The process's `PlatformConfig` has each with
 * these types, so the composition root passes it as it is.
 */
export type DotAgentConfig = DotTurnConfig &
    Parameters<typeof settingsInference>[0] &
    Parameters<typeof limitDefaults>[0] &
    Parameters<typeof turnTimeLimitMs>[1] &
    Parameters<typeof searchProviderFor>[0] &
    ConstructorParameters<typeof ComputerService>[1] & {
        /**
         * The data space's settings, of which the helpers above read only
         * `limits`; `object` so a config with its other fields (and no
         * `limits`) still fits, as `LimitSources` does at the top level.
         */
        readonly data?: object;
    };

/** What a Dot's turns call of other features, over the store, workspace and config. */
export function dotTurnServices(store: CoreStore, workspace: AppWorkspace, config: DotAgentConfig): DotTurnServices {
    return {
        limitDefaults: () => limitDefaults(config),
        turnTimeLimitMs: (settings) => turnTimeLimitMs(settings, config),
        settingsInference: () => settingsInference(config),
        searchProvider: () => searchProviderFor(config),
        gatherSources,
        computer: (paused, hooks) => new ComputerService(workspace, config, paused, undefined, undefined, hooks),
        fitContext,
        notes: () => contextNotes(workspace.db),
        markers: () => timeMarkers(workspace.db),
        steering: () => steeringQueue(workspace.db),
        learnedSkillsFor: (deliveryEnabled, containerId) =>
            learnedSkillsFor(workspace.skills, deliveryEnabled, containerId),
        memory: turnMemory(store, workspace),
        timeZones: timeZones(store),
        compact: compactWith({ compactNow }).compact,
        chatSkills: () => {
            const sessions = skillSessions(workspace.db);
            return { skills: chatSkills(skillsRepository(workspace.db), sessions), sessions };
        },
        turns: {
            agentLoop,
            tracer: (emit, ledger) => new TurnTracer(emit, undefined, ledger),
            retries: (deadline, limitMs, policy) => {
                const budget = new RetryBudget(deadline, limitMs, policy);
                return (adapter, trace) => retriedRequests(adapter, { budget, policy, trace });
            },
            busyModel,
            timedRounds,
            tanstackTools,
            learnedSkillTools,
        },
    };
}

/** `DotTurnServices`, the graph's one set (`composition/app/dot-turns.ts`). */
export class AppDotTurnServices extends Context.Service<AppDotTurnServices, DotTurnServices>()(
    'socio/composition/app/DotTurnServices',
) {}

/**
 * The step, as `composition/dots.ts` places it, ahead of the socios' agents:
 * `DotTurnServices` over the store, workspace and config. Builds nothing
 * else and registers no listener.
 */
export const appDotTurnsLayers = {
    step: Layer.effect(
        AppDotTurnServices,
        Effect.gen(function* () {
            return dotTurnServices(yield* LegacyStore, yield* LegacyWorkspace, yield* LegacyConfig);
        }),
    ),
};
