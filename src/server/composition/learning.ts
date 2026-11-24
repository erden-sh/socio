/**
 * Learning's construction: the graph's steps over Learning's layers
 * (`learning/layer.ts`).
 *
 * What no tag holds yet at Learning's step is passed in or provided to it
 * here: the classification seam, built at the graph's end, looked up on
 * the triage's first use, as before; and the reactions store, whose
 * context bridge also comes at the graph's end, made here on the same
 * connection (one store per connection: the same object).
 *
 * No config tag: Learning reads no `PlatformConfig` field (its model is
 * the default shared backend's).
 */
import { Effect, Layer } from 'effect';

import { classifyService } from '../classify/service.js';
import { Reactions } from '../context/contract.js';
import { messageReactions } from '../context/reactions.js';
import { EvidenceHookLive, LearningJob, LearningLive } from '../learning/layer.js';

import { LegacyModuleContext, LegacyWorkspace } from './base.js';

/** Learning's analysis, under the graph's `LegacyLearning` tag (the class): the layer's own tag. */
export { LearningJob as LegacyLearning };

/**
 * Learning's steps of the graph, in the graph's order: the analysis
 * (`LearningJob`, offered as `Learning`, with its `Evidence`, `Skills`,
 * `SkillDelivery` over them and `LearningViews`), then, after
 * auto-triage, the evidence each finished run records.
 */
export const learningLayers = {
    learning: Layer.unwrap(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const context = yield* LegacyModuleContext;
            return LearningLive(db, { seam: () => classifyService(context) }).pipe(
                Layer.provide(Layer.sync(Reactions, () => messageReactions(db))),
            );
        }),
    ),
    evidence: Layer.unwrap(
        Effect.gen(function* () {
            return EvidenceHookLive((yield* LegacyWorkspace).db);
        }),
    ),
};
