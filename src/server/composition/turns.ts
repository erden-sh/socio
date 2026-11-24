/**
 * The turn engine's construction: what each finished turn sets off, in the
 * graph's order: the turn's log line, and its trace to the operator's
 * collector. The work is turns' (`turns/finished-turns.ts`, `turns/layer.ts`);
 * this file wires it, and builds `TurnSubjects` and `TurnsConfig` for it.
 */
import { Effect, Layer } from 'effect';

import type { AgentRunSource } from '@socio/shared/types';

import { TurnSubjects, TurnsConfig, type TurnsConfigShape } from '../turns/contract.js';
import { logFinishedTurns as logTurns } from '../turns/finished-turns.js';
import { FinishedTurnLogLive, TraceExporter, TraceExporterLive } from '../turns/layer.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import { runSourceOf } from './app/conversations.js';
import { LegacyConfig, LegacyStore, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import type { CoreStore } from './core-store.js';
import type { AppWorkspace } from './workspace-parts.js';

/** A run's source (`runSourceOf`). */
type RunSource = (threadId: string, recorded?: AgentRunSource | null) => Promise<AgentRunSource>;

/** Who and what a finished turn was about: the workspace's conversation and socio, the settings, the run's source. */
function turnSubjects(store: Pick<CoreStore, 'slices'>, workspace: AppWorkspace, runSource: RunSource) {
    return TurnSubjects.of({
        owner: (threadId) => workspace.thread(threadId)?.ownerId,
        socio: (threadId) => {
            const thread = workspace.thread(threadId);
            return thread && workspace.dot(thread.dotId);
        },
        settings: () => store.slices.settings.settings(),
        source: runSource,
    });
}

/** `TurnsConfig`, from what the entry read of the env (`otlpFromEnv`, `traceContentFromEnv`). */
const turnsConfig = (config: PlatformConfig): TurnsConfigShape => ({
    otlp: config.otlp,
    traceContent: config.traceContent,
});

/** Each finished turn's log line (the finished turns' step). */
export function logFinishedTurns(workspace: AppWorkspace, runner: LocalAgentRunner, runSource: RunSource) {
    logTurns(runner, {
        owner: (threadId) => workspace.thread(threadId)?.ownerId,
        source: runSource,
    });
}

/** The turn trace exporter, under the graph's `LegacyTraceExporter` tag: none unless an OTLP endpoint is set. */
export const LegacyTraceExporter = TraceExporter;

/** `TurnSubjects` over the boot step's stores and a run's source (`runSourceOf`). */
const TurnSubjectsLive = Layer.effect(
    TurnSubjects,
    Effect.gen(function* () {
        const workspace = yield* LegacyWorkspace;
        return turnSubjects(yield* LegacyStore, workspace, runSourceOf(workspace));
    }),
);

/** `TurnsConfig` over the config. */
const TurnsConfigLive = Layer.effect(
    TurnsConfig,
    Effect.gen(function* () {
        return turnsConfig(yield* LegacyConfig);
    }),
);

/**
 * The finished turns' steps of the graph (`composition/index.ts`), in
 * the graph's order: the log line, then the trace exporter. Both read
 * each run's source through `runSourceOf`; the runner is the root's
 * `Runner`.
 */
export const turnsLayers = {
    log: FinishedTurnLogLive.pipe(Layer.provide(TurnSubjectsLive)),
    traceExporter: TraceExporterLive.pipe(Layer.provide(TurnSubjectsLive), Layer.provide(TurnsConfigLive)),
};
