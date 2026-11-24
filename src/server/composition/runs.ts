/**
 * Runs' construction: `runs/layer.ts`'s tags, with what runs declares there
 * provided here (`RunsHost`: a run's source, `runSourceOf`). Runs reads no
 * `PlatformConfig` field, so there is no `RunsConfig` to build; it starts and
 * stops nothing, so it has no lifecycle step.
 */
import { Effect, Layer } from 'effect';

import { IssueRunTraces } from '../issues/contract.js';
import { RunsViews } from '../runs/contract.js';
import { RunsHost, RunsLive } from '../runs/layer.js';

import { runSourceOf } from './app/conversations.js';
import { LegacyWorkspace } from './base.js';

/** A run's source, found over the workspace's links at the moment of use (`runSourceOf`). */
const RunsHostLive = Layer.effect(
    RunsHost,
    LegacyWorkspace.useSync((workspace) => RunsHost.of({ runSource: runSourceOf(workspace) })),
);

/**
 * A run's trace for the issue routes (`IssueRunTraces`, the port issues
 * declares below runs): `RunsViews` itself.
 */
export const IssueRunTracesLive = Layer.effect(
    IssueRunTraces,
    Effect.gen(function* () {
        return yield* RunsViews;
    }),
);

/**
 * The runs' step of the graph: `RunRefs` and `RunsViews`, and issues'
 * `IssueRunTraces` over them. None builds a service nor takes a listener,
 * so the step stays with the bridges and changes no order.
 */
export const runsLayers = {
    bridges: IssueRunTracesLive.pipe(Layer.provideMerge(RunsLive.pipe(Layer.provide(RunsHostLive)))),
};
