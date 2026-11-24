/**
 * The socios' layer: the extensions every DotAgent gets, offered as
 * `TurnExtensions`, and the agents built over them, offered as `DotAgents`. The
 * extensions read other features through their tags (`Runner`, `Data` and
 * `DataConfig`, `Apps`, `Media`, `Orchestrator`) and what only the composition
 * root has through `DotTurnHooks`. Only the composition (`composition/dots.ts`)
 * and tests import this file.
 */
import { Effect, Layer } from 'effect';

import type { AppsShape } from '../apps/contract.js';
import { Apps } from '../apps/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';
import { Data, DataConfig } from '../dataspace/contract.js';
import { Inference } from '../inference/contract.js';
import type { MediaShape } from '../media/contract.js';
import { Media } from '../media/contract.js';
import type { OrchestratorShape } from '../rooms/contract.js';
import { Orchestrator } from '../rooms/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import { Runner } from '../turns/contract.js';

import { DotAgents, DotTurnHooks, TurnExtensions, type DotExtensions, type DotTurnHooksShape } from './contract.js';
import { DotAgentFactoryCore } from './dot-agent.js';

/** What the extensions are made of: each a slice of its feature's contract. */
export interface DotExtensionSources {
    readonly hooks: DotTurnHooksShape;
    readonly runner: Pick<RunnerShape, 'refRecorder'>;
    readonly data: Pick<DataSpaceShape, 'computerEnv' | 'tokens'>;
    /** The data API's URL the computers reach (`DataConfig.data.apiUrl`). */
    readonly dataApiUrl: string | undefined;
    readonly apps: Pick<AppsShape, 'computerStopped' | 'secretsFor'>;
    readonly media: Pick<MediaShape, 'resolveForModel' | 'toolImageSource'>;
    readonly orchestrator: Pick<OrchestratorShape, 'readsMidTurn'>;
}

/** Module tools and computer hooks, given to every DotAgent (web, Telegram, scheduled). */
export function dotExtensions(sources: DotExtensionSources): DotExtensions {
    const { hooks, runner, data, dataApiUrl, apps, media, orchestrator } = sources;
    return {
        // What grounded each turn (CB-194), in the Runs module's table.
        runRefs: (runId, threadId) => runner.refRecorder(runId, threadId),
        tools: (turn) => hooks.tools(turn),
        // Tools of flags that are off for the person (CB-169), for every
        // turn's tools: the core ones too.
        toolsOff: (turn) => hooks.toolsOff(turn),
        // Each module's hook is awaited in registry order (CB-110), so the
        // prompt gets the same text in the same order as when they were sync.
        pageContext: (turn) => hooks.pageContext(turn),
        news: (turn) => hooks.news(turn),
        turnNote: (turn) => hooks.turnNote(turn),
        computer: {
            execEnv: (dotId, userId, runMs) => data.computerEnv(dotId, userId, dataApiUrl, runMs),
            stopped: (dotId) => {
                data.tokens.revokeDot(dotId, ['computer', 'job']);
                apps.computerStopped(dotId);
            },
            // Mini apps' tokens and other live commands' (CB-224).
            secrets: (dotId) => [...apps.secretsFor(dotId), ...data.tokens.commandTokens(dotId)],
        },
        messages: (turn, messages) => media.resolveForModel(turn, messages),
        readsMidTurn: (threadId, dotId, text) => orchestrator.readsMidTurn(threadId, dotId, text),
        toolImages: (threadId, userId) => media.toolImageSource(threadId, userId),
    };
}

/** `dotExtensions` over the tags. */
export const makeTurnExtensions = Effect.gen(function* () {
    return dotExtensions({
        hooks: yield* DotTurnHooks,
        runner: yield* Runner,
        data: yield* Data,
        dataApiUrl: (yield* DataConfig).data?.apiUrl,
        apps: yield* Apps,
        media: yield* Media,
        orchestrator: yield* Orchestrator,
    });
});

/** `TurnExtensions`, built once. */
export const TurnExtensionsLive = Layer.effect(TurnExtensions, makeTurnExtensions);

/** The services, stores and config `DotAgentCore` takes, as its factory names them. */
type AgentParts = ConstructorParameters<typeof DotAgentFactoryCore>;

/**
 * The agents over the workspace's inference registry and the extensions.
 * The services (what a turn calls of other features) are built by the
 * composition root over the same store, workspace and config
 * (`composition/app/dot-turns.ts`'s `dotTurnServices`).
 */
export const makeDotAgents = (
    services: AgentParts[0],
    store: AgentParts[1],
    workspace: AgentParts[2],
    config: AgentParts[3],
) =>
    Effect.gen(function* () {
        return new DotAgentFactoryCore(services, store, workspace, config, {
            inference: yield* Inference,
            extensions: yield* TurnExtensions,
        });
    });

/** `DotAgents`; needs `Inference` and `TurnExtensions`. */
export const DotAgentsLive = (
    services: AgentParts[0],
    store: AgentParts[1],
    workspace: AgentParts[2],
    config: AgentParts[3],
) => Layer.effect(DotAgents, makeDotAgents(services, store, workspace, config));
