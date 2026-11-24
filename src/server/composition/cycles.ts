/**
 * The work cycles' construction: `cycles/layer.ts` builds the service and
 * offers it as `Cycles` and `CycleUpkeep`; this file builds `CycleSources`
 * (from `Conversations`, `Socios`, the settings' `WorkspaceSettings` and
 * `Limits`, and `Runner`), hands the runner its gate, and adds the tag the
 * other steps read it from. It is the first step of the graph, before any run.
 *
 * `cycles/` reads no `PlatformConfig` field, so it has no `CyclesConfig`:
 * the limits come from settings, whose layer is built here from the
 * config the way the settings' own step builds it.
 */
import { Context, Effect, Layer } from 'effect';

import { CycleSources, type CycleSourcesShape } from '../cycles/contract.js';
import { cyclesContext, makeCycles } from '../cycles/layer.js';
import type { WorkCycles } from '../cycles/service.js';
import { Limits, WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, Socios } from '../workspace/contract.js';

import { LegacyRunner, LegacyWorkspace } from './base.js';

/** Work cycles, under the graph's `LegacyCycles` tag (the class). */
export class LegacyCycles extends Context.Service<LegacyCycles, WorkCycles>()('socio/composition/cycles/WorkCycles') {}

/**
 * `CycleSources` over the tags: a conversation and a socio from the
 * workspace's slices, the limits in force from the settings, and the
 * runner's live runs.
 */
const CycleSourcesLive = Layer.effect(
    CycleSources,
    Effect.gen(function* () {
        const conversations = yield* Conversations;
        const socios = yield* Socios;
        const settings = yield* WorkspaceSettings;
        const limits = yield* Limits;
        const runner = yield* Runner;
        return CycleSources.of({
            conversation: (id) => conversations.thread(id),
            socio: (id) => socios.dot(id),
            limits: () => limits.cycleLimits(settings.settings()),
            alive: (runId) => runner.turnAlive(runId),
        } satisfies CycleSourcesShape);
    }),
);

/**
 * The work cycles' step of the graph: `cycles/layer.ts`'s service on the
 * workspace connection, offered as `Cycles`, `CycleUpkeep` and
 * `LegacyCycles`, and set as the runner's gate.
 */
export const cyclesLayers = {
    cycles: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const cycles = yield* makeCycles(db);
            (yield* LegacyRunner).setCycleGate(cycles);
            return cyclesContext(cycles).pipe(Context.add(LegacyCycles, cycles));
        }),
    ).pipe(Layer.provide(CycleSourcesLive)),
};
